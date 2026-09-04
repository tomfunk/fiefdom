/**
 * Fief Agent - Manages a persistent RPC subprocess for a single fief
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";

export interface FiefAgentOptions {
	cwd: string;
	persona: string;
	/**
	 * Boundary and memory instructions shared with the Claude Code adapter
	 * (core/persona.ts), so a fief behaves the same in either harness.
	 */
	instructions: string;
	memoryContext: string;
}

export interface FiefAgentStatus {
	state: "starting" | "idle" | "working" | "error" | "shutdown";
	messageCount?: number;
	lastOutput?: string;
	errorMessage?: string;
}

export interface TaskResult {
	success: boolean;
	output: string;
	usage?: {
		input: number;
		output: number;
		cost: number;
	};
}

interface SendTaskOptions {
	signal?: AbortSignal;
	waitForCompletion?: boolean;
	onUpdate?: (status: FiefAgentStatus) => void;
}

interface RpcCommand {
	id?: string;
	type: string;
	[key: string]: unknown;
}

interface RpcResponse {
	id?: string;
	type: "response";
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
}

interface RpcEvent {
	type: string;
	[key: string]: unknown;
}

/**
 * Manages a persistent pi RPC subprocess for a fief
 */
export class FiefAgent {
	readonly id: string;
	private options: FiefAgentOptions;
	private process: ChildProcess | null = null;
	private status: FiefAgentStatus = { state: "starting" };
	private messageCount = 0;
	private pendingResponses: Map<
		string,
		{
			resolve: (response: RpcResponse) => void;
			reject: (error: Error) => void;
		}
	> = new Map();
	private requestCounter = 0;
	private buffer = "";
	private eventListeners: Array<(event: RpcEvent) => void> = [];
	private settleWaiters: Set<(error?: Error) => void> = new Set();

	constructor(id: string, options: FiefAgentOptions) {
		this.id = id;
		this.options = options;
	}

	/**
	 * Start the RPC subprocess
	 */
	async start(): Promise<void> {
		const systemPromptPath = await this.writeSystemPrompt();

		const args = [
			"--mode",
			"rpc",
			"--no-session",
			"--append-system-prompt",
			systemPromptPath,
		];

		// Find pi executable
		const { command, spawnArgs } = this.getPiInvocation(args);

		this.process = spawn(command, spawnArgs, {
			cwd: this.options.cwd,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			// Marks this pi as a fief worker so its own fiefdom extension bails out
			// instead of spawning another layer of agents (see index.ts recursion guard).
			env: { ...process.env, PI_FIEFDOM_CHILD: "1", PI_FIEFDOM_FIEF: this.id },
		});

		// Handle stdout (JSONL responses and events)
		this.attachJsonlReader(this.process.stdout!, (line) => {
			this.handleLine(line);
		});

		// Handle stderr
		this.process.stderr?.on("data", (data) => {
			console.error(`[${this.id}] stderr:`, data.toString());
		});

		// Handle process exit
		this.process.on("close", (code) => {
			this.status = {
				state: "shutdown",
				errorMessage: code !== 0 ? `Exited with code ${code}` : undefined,
			};
			const exitError = new Error(`Process exited with code ${code}`);
			this.rejectAllPending(exitError);
			this.rejectAllWaiters(exitError);
		});

		this.process.on("error", (err) => {
			this.status = { state: "error", errorMessage: err.message };
			this.rejectAllPending(err);
			this.rejectAllWaiters(err);
		});

		// Wait for process to be ready (get initial state). Bounded: a child that never
		// completes the RPC handshake must fail fast, not hang session_start forever.
		try {
			await this.send({ type: "get_state" }, undefined, 30000);
			this.status = { state: "idle", messageCount: 0 };
		} catch (err) {
			this.status = { state: "error", errorMessage: String(err) };
			this.process?.kill("SIGKILL");
			this.process = null;
			throw err;
		}
	}

	/**
	 * Send a task to the fief agent and optionally wait for completion
	 */
	async sendTask(
		task: string,
		options: SendTaskOptions = {}
	): Promise<TaskResult> {
		const { signal, waitForCompletion = true, onUpdate } = options;

		if (!this.process || this.status.state === "shutdown") {
			throw new Error(`Fief agent ${this.id} is not running`);
		}

		this.status = { state: "working", messageCount: this.messageCount };
		onUpdate?.(this.status);

		// Set up event listener for streaming updates
		let output = "";
		const eventHandler = (event: RpcEvent) => {
			if (event.type === "message_update") {
				const delta = (event as any).assistantMessageEvent;
				if (delta?.type === "text_delta" && delta.delta) {
					output += delta.delta;
					this.status = {
						state: "working",
						messageCount: this.messageCount,
						lastOutput: output.slice(-200),
					};
					onUpdate?.(this.status);
				}
			} else if (event.type === "tool_execution_start") {
				this.status = {
					state: "working",
					messageCount: this.messageCount,
					lastOutput: `Running ${(event as any).toolName}...`,
				};
				onUpdate?.(this.status);
			}
		};

		this.eventListeners.push(eventHandler);

		try {
			// Send the prompt
			const promptResponse = await this.send(
				{ type: "prompt", message: task },
				signal
			);

			if (!promptResponse.success) {
				throw new Error(promptResponse.error || "Failed to send prompt");
			}

			if (!waitForCompletion) {
				return { success: true, output: "(task started)" };
			}

			// Wait for agent_settled event
			await this.waitForSettled(signal);

			// Get final output
			const lastText = await this.send({ type: "get_last_assistant_text" });
			const finalOutput =
				(lastText.data as any)?.text || output || "(no output)";

			this.messageCount++;
			this.status = { state: "idle", messageCount: this.messageCount };

			// Memory is written by the agent itself through the fiefdom CLI (see
			// core/persona.ts). The reflection round-trip that used to run here
			// added two messages to this worker's conversation after every task,
			// so its context — and this process's memory — grew without bound.
			return { success: true, output: finalOutput };
		} catch (err) {
			this.status = {
				state: "error",
				messageCount: this.messageCount,
				errorMessage: String(err),
			};
			return { success: false, output: String(err) };
		} finally {
			const idx = this.eventListeners.indexOf(eventHandler);
			if (idx >= 0) this.eventListeners.splice(idx, 1);
		}
	}

	/**
	 * Get current agent status
	 */
	getStatus(): FiefAgentStatus {
		return { ...this.status };
	}

	/**
	 * Shutdown the agent process
	 */
	async shutdown(): Promise<void> {
		if (!this.process) return;

		this.status = { state: "shutdown" };

		// Try graceful abort first
		try {
			await this.send({ type: "abort" }, undefined, 1000);
		} catch {
			// Ignore
		}

		const child = this.process;

		// Already gone: there is no "close" left to wait for. Awaiting one here
		// used to hang forever, which stalled the sequential shutdown loop and
		// orphaned every fief process after this one.
		if (child.exitCode !== null || child.signalCode !== null) {
			this.process = null;
			return;
		}

		child.kill("SIGTERM");

		const forceKill = setTimeout(() => {
			if (!child.killed) child.kill("SIGKILL");
		}, 5000);

		// Bounded either way: a child that ignores both signals must not keep
		// the session from exiting.
		await new Promise<void>((resolve) => {
			const done = () => {
				clearTimeout(forceKill);
				clearTimeout(giveUp);
				resolve();
			};
			const giveUp = setTimeout(done, 10000);
			child.once("close", done);
			child.once("error", done);
		});

		this.process = null;
	}

	/**
	 * Best-effort synchronous kill, for process-exit handlers where there is no
	 * time to await anything. (A child whose parent dies without running this
	 * still sees its stdin close, which ends the RPC loop.)
	 */
	killNow(): void {
		const child = this.process;
		if (!child) return;
		this.process = null;
		this.status = { state: "shutdown" };
		try {
			child.kill("SIGKILL");
		} catch {
			// Already gone.
		}
	}

	// --------------------------------------------------------------------------
	// Private Methods
	// --------------------------------------------------------------------------

	private async writeSystemPrompt(): Promise<string> {
		const tmpDir = await fs.promises.mkdtemp(
			path.join(os.tmpdir(), `fiefdom-${this.id}-`)
		);
		const promptPath = path.join(tmpDir, "system-prompt.md");

		const content = `# ${this.id} Fief Agent

${this.options.persona}

${this.options.instructions}

## Current Memory/Context

${this.options.memoryContext || "(No prior memory)"}
`;

		await fs.promises.writeFile(promptPath, content, "utf-8");
		return promptPath;
	}

	private getPiInvocation(args: string[]): {
		command: string;
		spawnArgs: string[];
	} {
		const currentScript = process.argv[1];
		const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");

		if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
			return {
				command: process.execPath,
				spawnArgs: [currentScript, ...args],
			};
		}

		const execName = path.basename(process.execPath).toLowerCase();
		const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);

		if (!isGenericRuntime) {
			return { command: process.execPath, spawnArgs: args };
		}

		return { command: "pi", spawnArgs: args };
	}

	private attachJsonlReader(
		stream: NodeJS.ReadableStream,
		onLine: (line: string) => void
	): void {
		const decoder = new StringDecoder("utf8");

		stream.on("data", (chunk) => {
			this.buffer +=
				typeof chunk === "string" ? chunk : decoder.write(chunk);

			while (true) {
				const newlineIndex = this.buffer.indexOf("\n");
				if (newlineIndex === -1) break;

				let line = this.buffer.slice(0, newlineIndex);
				this.buffer = this.buffer.slice(newlineIndex + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				onLine(line);
			}
		});
	}

	private handleLine(line: string): void {
		if (!line.trim()) return;

		let parsed: RpcResponse | RpcEvent;
		try {
			parsed = JSON.parse(line);
		} catch {
			console.error(`[${this.id}] Invalid JSON:`, line);
			return;
		}

		// Handle responses
		if (parsed.type === "response" && (parsed as RpcResponse).id) {
			const pending = this.pendingResponses.get((parsed as RpcResponse).id!);
			if (pending) {
				this.pendingResponses.delete((parsed as RpcResponse).id!);
				pending.resolve(parsed as RpcResponse);
			}
			return;
		}

		// Handle events
		for (const listener of this.eventListeners) {
			try {
				listener(parsed as RpcEvent);
			} catch (err) {
				console.error(`[${this.id}] Event listener error:`, err);
			}
		}
	}

	private async send(
		command: RpcCommand,
		signal?: AbortSignal,
		timeoutMs?: number
	): Promise<RpcResponse> {
		if (!this.process?.stdin) {
			throw new Error("Process not running");
		}

		const id = `req-${++this.requestCounter}`;
		const commandWithId = { ...command, id };

		return new Promise((resolve, reject) => {
			const onAbort = () => {
				this.pendingResponses.delete(id);
				reject(new Error("Aborted"));
			};

			// Set up abort handling
			if (signal) {
				if (signal.aborted) {
					onAbort();
					return;
				}
				signal.addEventListener("abort", onAbort, { once: true });
			}

			// Set up timeout
			let timeoutHandle: NodeJS.Timeout | undefined;
			if (timeoutMs) {
				timeoutHandle = setTimeout(() => {
					this.pendingResponses.delete(id);
					reject(new Error("Timeout"));
				}, timeoutMs);
			}

			// Each settle path also drops the abort listener; long-lived agents
			// otherwise accumulate one per request on the caller's signal.
			this.pendingResponses.set(id, {
				resolve: (response) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					signal?.removeEventListener("abort", onAbort);
					resolve(response);
				},
				reject: (err) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					signal?.removeEventListener("abort", onAbort);
					reject(err);
				},
			});

			this.process!.stdin!.write(JSON.stringify(commandWithId) + "\n");
		});
	}

	private async waitForSettled(signal?: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			const settle = (err?: Error) => {
				const idx = this.eventListeners.indexOf(handler);
				if (idx >= 0) this.eventListeners.splice(idx, 1);
				this.settleWaiters.delete(settle);
				signal?.removeEventListener("abort", onAbort);
				if (err) reject(err);
				else resolve();
			};

			const handler = (event: RpcEvent) => {
				if (event.type === "agent_settled") settle();
			};

			const onAbort = () => settle(new Error("Aborted"));

			if (signal) {
				if (signal.aborted) {
					onAbort();
					return;
				}
				signal.addEventListener("abort", onAbort, { once: true });
			}

			// Registered so a dying child rejects this wait. Previously the close
			// handler only rejected pending RPC calls, leaving settle waiters (and
			// their listeners) pending for the life of the session.
			this.settleWaiters.add(settle);
			this.eventListeners.push(handler);
		});
	}

	private rejectAllWaiters(error: Error): void {
		for (const settle of [...this.settleWaiters]) settle(error);
		this.settleWaiters.clear();
	}

	private rejectAllPending(error: Error): void {
		for (const pending of this.pendingResponses.values()) {
			pending.reject(error);
		}
		this.pendingResponses.clear();
	}
}
