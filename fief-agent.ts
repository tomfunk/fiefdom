/**
 * Fief Agent - Manages a persistent RPC subprocess for a single fief
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { FiefMemory } from "./memory.ts";

export interface FiefAgentOptions {
	cwd: string;
	allowedPaths: string[];
	persona: string;
	memoryContext: string;
	memory?: FiefMemory;
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
			env: { ...process.env, PI_FIEFDOM_CHILD: "1" },
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
			this.rejectAllPending(new Error(`Process exited with code ${code}`));
		});

		this.process.on("error", (err) => {
			this.status = { state: "error", errorMessage: err.message };
			this.rejectAllPending(err);
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

			// Extract learnings from the work (runs in background, doesn't block)
			this.reflectAndRemember(task, finalOutput).catch(() => {});

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

		// Kill the process
		this.process.kill("SIGTERM");

		// Force kill after timeout
		const timeout = setTimeout(() => {
			if (this.process && !this.process.killed) {
				this.process.kill("SIGKILL");
			}
		}, 5000);

		await new Promise<void>((resolve) => {
			if (!this.process) {
				resolve();
				return;
			}
			this.process.on("close", () => {
				clearTimeout(timeout);
				resolve();
			});
		});

		this.process = null;
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

## Important Constraints

You are a specialized agent with LIMITED scope:

1. **PATH RESTRICTIONS**: You may ONLY write to files matching these patterns:
   ${this.options.allowedPaths.map((p) => `- ${p}`).join("\n   ")}

2. **Cross-Fief Coordination**: If you need something outside your scope:
   - Do NOT attempt to edit files outside your paths
   - Clearly state what you need from other fiefs
   - The orchestrator will coordinate with the appropriate fief

3. **Memory**: Document important decisions, conventions, and learnings.
   Use markers like "[MEMORY:decision]" or "[MEMORY:convention]" to flag
   things worth remembering across sessions.

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
			// Set up abort handling
			if (signal) {
				signal.addEventListener("abort", () => {
					this.pendingResponses.delete(id);
					reject(new Error("Aborted"));
				});
			}

			// Set up timeout
			let timeoutHandle: NodeJS.Timeout | undefined;
			if (timeoutMs) {
				timeoutHandle = setTimeout(() => {
					this.pendingResponses.delete(id);
					reject(new Error("Timeout"));
				}, timeoutMs);
			}

			this.pendingResponses.set(id, {
				resolve: (response) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					resolve(response);
				},
				reject: (err) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					reject(err);
				},
			});

			this.process!.stdin!.write(JSON.stringify(commandWithId) + "\n");
		});
	}

	private async waitForSettled(signal?: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			const handler = (event: RpcEvent) => {
				if (event.type === "agent_settled") {
					const idx = this.eventListeners.indexOf(handler);
					if (idx >= 0) this.eventListeners.splice(idx, 1);
					resolve();
				}
			};

			if (signal) {
				signal.addEventListener("abort", () => {
					const idx = this.eventListeners.indexOf(handler);
					if (idx >= 0) this.eventListeners.splice(idx, 1);
					reject(new Error("Aborted"));
				});
			}

			this.eventListeners.push(handler);
		});
	}

	private rejectAllPending(error: Error): void {
		for (const pending of this.pendingResponses.values()) {
			pending.reject(error);
		}
		this.pendingResponses.clear();
	}

	/**
	 * After completing a task, reflect on what's worth remembering
	 * This runs as a quick follow-up that extracts learnings
	 */
	private async reflectAndRemember(task: string, output: string): Promise<void> {
		if (!this.options.memory) return;
		if (!this.process || this.status.state === "shutdown") return;

		// Don't reflect on very short outputs or planning queries
		if (output.length < 100) return;
		if (task.includes("[PLANNING QUERY")) return;
		if (task.includes("[REFLECTION")) return;

		const reflectionPrompt = `[REFLECTION - Internal, do not execute any tools]

Look back at the work you just completed. Extract any learnings worth remembering for future sessions. Be very selective - only note things that would be genuinely useful to know later.

Respond ONLY with a JSON object (no markdown, no explanation):
{
  "decisions": ["decision made and why (if any)"],
  "conventions": ["pattern or convention discovered (if any)"],
  "issues": ["gotcha or problem to watch for (if any)"],
  "notes": ["other useful insight (if any)"]
}

Omit empty arrays. If nothing worth remembering, respond with: {}`;

		try {
			// Send reflection prompt with short timeout
			const response = await this.send(
				{ type: "prompt", message: reflectionPrompt },
				undefined,
				30000 // 30s timeout
			);

			if (!response.success) return;

			// Wait for response
			await this.waitForSettled();

			// Get the reflection output
			const lastText = await this.send({ type: "get_last_assistant_text" });
			const reflectionOutput = (lastText.data as any)?.text || "";

			// Parse and save learnings
			this.parseAndSaveLearnings(reflectionOutput);
		} catch {
			// Reflection is best-effort, don't fail on errors
		}
	}

	/**
	 * Parse reflection output and save to memory
	 */
	private parseAndSaveLearnings(output: string): void {
		if (!this.options.memory) return;

		// Try to extract JSON from the output
		let learnings: Record<string, string[]>;
		try {
			// Handle potential markdown code blocks
			let jsonStr = output.trim();
			const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
			if (jsonMatch) {
				jsonStr = jsonMatch[1].trim();
			}

			// Find JSON object
			const objMatch = jsonStr.match(/\{[\s\S]*\}/);
			if (!objMatch) return;

			learnings = JSON.parse(objMatch[0]);
		} catch {
			// Also check for explicit markers as fallback
			this.extractMarkedMemory(output);
			return;
		}

		// Save each learning
		const timestamp = new Date().toISOString();
		for (const [category, items] of Object.entries(learnings)) {
			if (!Array.isArray(items)) continue;

			for (const content of items) {
				if (typeof content !== "string" || !content.trim()) continue;

				this.options.memory.addEntry({
					category,
					content: content.trim(),
					timestamp,
					source: "agent",
				});
			}
		}

		// Prune periodically
		if (Math.random() < 0.1) {
			this.options.memory.prune();
		}
	}

	/**
	 * Extract explicitly marked memory (fallback)
	 */
	private extractMarkedMemory(output: string): void {
		if (!this.options.memory) return;

		const memoryPattern = /\[MEMORY:(\w+)\]\s*([^\[]+)/gi;
		let match;

		while ((match = memoryPattern.exec(output)) !== null) {
			const category = match[1].toLowerCase();
			const content = match[2].trim();

			if (content) {
				this.options.memory.addEntry({
					category,
					content,
					timestamp: new Date().toISOString(),
					source: "agent",
				});
			}
		}
	}
}
