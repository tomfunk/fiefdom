/**
 * Fiefdom - Multi-agent workspace orchestration
 *
 * Splits a repository into "fiefs" (frontend, backend, etc.), spawns one
 * persistent RPC agent per fief, and keeps a non-writing orchestrator in
 * the main session for intake and routing.
 *
 * Configuration: .pi/fiefs.json
 * Personas: .pi/fiefs/<name>/AGENT.md
 * Memory: .pi/fiefs/<name>/memory/
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
	type FiefConfig,
	type FiefdomConfig,
	findFiefdomConfigPath,
	loadFiefdomConfig,
	pathMatchesFief,
} from "./config.ts";
import { FiefAgent, type FiefAgentStatus } from "./fief-agent.ts";
import { ensureWorktrees, cleanupWorktrees } from "./worktrees.ts";
import { FiefMemory } from "./memory.ts";
import { analyzeRepository, generateConfigFromAnalysis } from "./analyze.ts";

// ============================================================================
// Extension State
// ============================================================================

interface FiefdomState {
	config: FiefdomConfig | null;
	agents: Map<string, FiefAgent>;
	memory: Map<string, FiefMemory>;
	worktreesDir: string | null;
	requestLog: string[];
	initialized: boolean;
}

const state: FiefdomState = {
	config: null,
	agents: new Map(),
	memory: new Map(),
	worktreesDir: null,
	requestLog: [],
	initialized: false,
};

// ============================================================================
// Main Extension
// ============================================================================

export default function fiefdom(pi: ExtensionAPI) {
	// --------------------------------------------------------------------------
	// Session Lifecycle
	// --------------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		// Find config - checks local .pi/fiefs.json first, then main worktree if applicable
		const configPath = findFiefdomConfigPath(ctx.cwd);

		// Check if this is a git repo (required for fiefdom)
		// Note: worktrees have a .git file (not directory) pointing to the main repo
		const gitPath = path.join(ctx.cwd, ".git");
		const isGitRepo = fs.existsSync(gitPath);

		// Load configuration
		const config = configPath ? loadFiefdomConfig(configPath) : null;
		if (!config) {
			// No fiefs.json - notify user about setup option
			if (isGitRepo && ctx.hasUI) {
				ctx.ui.setStatus(
					"fiefdom",
					"Fiefdom: Not configured. Use /fiefdom-setup to divide this repo."
				);
			}
			state.initialized = false;
			return;
		}

		state.config = config;
		state.agents.clear();
		state.memory.clear();
		state.requestLog = [];

		// Set up worktrees for isolation (optional, off by default)
		if (config.useWorktrees) {
			try {
				state.worktreesDir = await ensureWorktrees(ctx.cwd, config.fiefs);
				ctx.ui.notify(`Fiefdom: Created worktrees for ${config.fiefs.length} fiefs`, "info");
			} catch (err) {
				ctx.ui.notify(`Fiefdom: Worktree setup failed: ${err}`, "error");
				state.worktreesDir = null;
			}
		}

		// Initialize memory for each fief
		// Resolve paths relative to config root (supports worktrees inheriting from main repo)
		const configRoot = config._configRoot ?? ctx.cwd;
		for (const fief of config.fiefs) {
			const memoryDir = path.join(configRoot, fief.memory);
			state.memory.set(fief.id, new FiefMemory(memoryDir));
		}

		// Spawn persistent fief agents
		for (const fief of config.fiefs) {
			try {
				const agent = await spawnFiefAgent(ctx, fief);
				state.agents.set(fief.id, agent);
				ctx.ui.notify(`Fiefdom: Spawned agent for ${fief.id}`, "info");
			} catch (err) {
				ctx.ui.notify(`Fiefdom: Failed to spawn ${fief.id}: ${err}`, "error");
			}
		}

		// Remove write tools from orchestrator
		const activeTools = pi.getActiveTools();
		const readOnlyTools = activeTools.filter(
			(t) => !["write", "edit"].includes(t)
		);
		pi.setActiveTools(readOnlyTools);

		state.initialized = true;
		ctx.ui.setStatus("fiefdom", `Fiefdom: ${state.agents.size} agents active`);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!state.initialized) return;

		// Shutdown all fief agents
		for (const [id, agent] of state.agents) {
			try {
				await agent.shutdown();
			} catch (err) {
				console.error(`Fiefdom: Error shutting down ${id}:`, err);
			}
		}
		state.agents.clear();

		// Cleanup worktrees (only if we created them)
		if (state.worktreesDir && state.config?.useWorktrees) {
			try {
				await cleanupWorktrees(ctx.cwd, state.worktreesDir);
			} catch (err) {
				console.error("Fiefdom: Error cleaning up worktrees:", err);
			}
		}

		state.initialized = false;
		ctx.ui.setStatus("fiefdom", undefined);
	});

	// --------------------------------------------------------------------------
	// Tool Call Enforcement (backup layer)
	// --------------------------------------------------------------------------

	pi.on("tool_call", async (event, ctx) => {
		if (!state.initialized || !state.config) return;

		// Block write/edit from orchestrator (should already be removed, but safety check)
		if (event.toolName === "write" || event.toolName === "edit") {
			const targetPath = (event.input as any).path;
			if (targetPath) {
				return {
					block: true,
					reason: `Orchestrator cannot write files. Route this task to the appropriate fief agent.`,
				};
			}
		}
	});

	// --------------------------------------------------------------------------
	// Custom Tools
	// --------------------------------------------------------------------------

	// List available fiefs
	pi.registerTool({
		name: "list_fiefs",
		label: "List Fiefs",
		description:
			"List all configured fiefs and their current status (running, idle, context usage)",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (!state.initialized || !state.config) {
				return {
					content: [
						{
							type: "text",
							text: "Fiefdom not active. No .pi/fiefs.json found.",
						},
					],
					details: {},
				};
			}

			const fiefs = state.config.fiefs.map((fief) => {
				const agent = state.agents.get(fief.id);
				const status = agent?.getStatus() ?? { state: "not_started" };
				const memory = state.memory.get(fief.id);

				return {
					id: fief.id,
					paths: fief.paths,
					status: status.state,
					messageCount: status.messageCount ?? 0,
					memoryEntries: memory?.getEntryCount() ?? 0,
				};
			});

			const configSource = state.config._loadedFrom
				? `Config: ${state.config._loadedFrom}`
				: "";

			const text = (configSource ? configSource + "\n\n" : "") + fiefs
				.map(
					(f) =>
						`**${f.id}**: ${f.status} (${f.messageCount} messages, ${f.memoryEntries} memory entries)\n  Paths: ${f.paths.join(", ")}`
				)
				.join("\n\n");

			return {
				content: [{ type: "text", text }],
				details: { fiefs },
			};
		},
	});

	// Route a task to a fief
	pi.registerTool({
		name: "route_ticket",
		label: "Route Ticket",
		description:
			"Route a task to one or more fief agents. The orchestrator analyzes the request and delegates to the appropriate specialist(s).",
		parameters: Type.Object({
			fief_id: Type.String({
				description: "ID of the fief to route to (e.g., 'frontend', 'backend')",
			}),
			task: Type.String({
				description:
					"The task to delegate, including all necessary context and requirements",
			}),
			wait_for_completion: Type.Optional(
				Type.Boolean({
					description: "Wait for the fief to complete the task (default: true)",
				})
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const { fief_id, task, wait_for_completion = true } = params;

			if (!state.initialized) {
				return {
					content: [{ type: "text", text: "Fiefdom not active." }],
					details: {},
					isError: true,
				};
			}

			const agent = state.agents.get(fief_id);
			if (!agent) {
				const available = Array.from(state.agents.keys()).join(", ");
				return {
					content: [
						{
							type: "text",
							text: `Unknown fief: ${fief_id}. Available: ${available}`,
						},
					],
					details: {},
					isError: true,
				};
			}

			// Log the request
			state.requestLog.push(
				`[${new Date().toISOString()}] orchestrator -> ${fief_id}: ${task.slice(0, 100)}...`
			);

			try {
				const result = await agent.sendTask(task, {
					signal,
					waitForCompletion: wait_for_completion,
					onUpdate: (status) => {
						onUpdate?.({
							content: [
								{
									type: "text",
									text: `[${fief_id}] ${status.state}: ${status.lastOutput ?? "working..."}`,
								},
							],
							details: { status },
						});
					},
				});

				return {
					content: [
						{
							type: "text",
							text: `[${fief_id}] ${result.success ? "Completed" : "Failed"}:\n\n${result.output}`,
						},
					],
					details: { fief_id, result },
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `Error routing to ${fief_id}: ${err}`,
						},
					],
					details: {},
					isError: true,
				};
			}
		},
	});

	// Query a fief for planning (what would you contribute?)
	pi.registerTool({
		name: "query_fief",
		label: "Query Fief",
		description:
			"Ask a fief agent what it would need to contribute to a feature or task, without executing anything. Use this for planning and coordination.",
		parameters: Type.Object({
			fief_id: Type.String({
				description: "ID of the fief to query",
			}),
			question: Type.String({
				description:
					"The planning question, e.g., 'What would you need to implement for a user profile feature?'",
			}),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const { fief_id, question } = params;

			if (!state.initialized) {
				return {
					content: [{ type: "text", text: "Fiefdom not active." }],
					details: {},
					isError: true,
				};
			}

			const agent = state.agents.get(fief_id);
			if (!agent) {
				return {
					content: [{ type: "text", text: `Unknown fief: ${fief_id}` }],
					details: {},
					isError: true,
				};
			}

			const planningPrompt = `[PLANNING QUERY - DO NOT EXECUTE]\n\nThe orchestrator is gathering information for planning purposes.\n\nQuestion: ${question}\n\nPlease analyze what your fief would need to contribute. Consider:\n- What files/components you would modify\n- What interfaces or contracts you would need from other fiefs\n- Any dependencies or ordering constraints\n- Estimated complexity\n\nDo NOT make any changes - just describe what would be needed.`;

			try {
				const result = await agent.sendTask(planningPrompt, {
					signal,
					waitForCompletion: true,
				});

				return {
					content: [
						{
							type: "text",
							text: `[${fief_id} planning response]\n\n${result.output}`,
						},
					],
					details: { fief_id, result },
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: `Error querying ${fief_id}: ${err}` }],
					details: {},
					isError: true,
				};
			}
		},
	});

	// Request from one fief to another
	pi.registerTool({
		name: "request_from_fief",
		label: "Request From Fief",
		description:
			"Send a request from one fief to another for cross-fief coordination. Used when fiefs need to agree on interfaces or share information.",
		parameters: Type.Object({
			from_fief: Type.String({ description: "Fief making the request" }),
			to_fief: Type.String({ description: "Fief receiving the request" }),
			request: Type.String({
				description:
					"The request, e.g., 'Please expose a getUserById endpoint that returns {id, name, email}'",
			}),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const { from_fief, to_fief, request } = params;

			if (!state.initialized) {
				return {
					content: [{ type: "text", text: "Fiefdom not active." }],
					details: {},
					isError: true,
				};
			}

			const targetAgent = state.agents.get(to_fief);
			if (!targetAgent) {
				return {
					content: [{ type: "text", text: `Unknown fief: ${to_fief}` }],
					details: {},
					isError: true,
				};
			}

			// Log cross-fief request
			const logEntry = `[${new Date().toISOString()}] ${from_fief} -> ${to_fief}: ${request.slice(0, 200)}...`;
			state.requestLog.push(logEntry);

			// Persist to audit log
			const auditPath = path.join(
				ctx.cwd,
				CONFIG_DIR_NAME,
				"fiefs",
				"cross-fief-requests.log"
			);
			try {
				fs.appendFileSync(auditPath, logEntry + "\n");
			} catch {
				// Ignore if can't write audit log
			}

			const crossFiefPrompt = `[CROSS-FIEF REQUEST from ${from_fief}]\n\n${request}\n\nPlease respond to this request from the ${from_fief} fief. If you need to make changes, proceed. If you need clarification or have concerns, explain them.`;

			try {
				const result = await targetAgent.sendTask(crossFiefPrompt, {
					signal,
					waitForCompletion: true,
				});

				return {
					content: [
						{
							type: "text",
							text: `[${to_fief} response to ${from_fief}]\n\n${result.output}`,
						},
					],
					details: { from_fief, to_fief, result },
				};
			} catch (err) {
				return {
					content: [
						{ type: "text", text: `Error in cross-fief request: ${err}` },
					],
					details: {},
					isError: true,
				};
			}
		},
	});

	// Get fief memory/learnings
	pi.registerTool({
		name: "get_fief_memory",
		label: "Get Fief Memory",
		description:
			"Retrieve the accumulated learnings and notes from a fief's persistent memory. Useful for understanding what the fief has learned over time.",
		parameters: Type.Object({
			fief_id: Type.String({ description: "ID of the fief" }),
			category: Type.Optional(
				Type.String({
					description:
						"Filter by category (decisions, conventions, issues, notes)",
				})
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { fief_id, category } = params;

			if (!state.initialized) {
				return {
					content: [{ type: "text", text: "Fiefdom not active." }],
					details: {},
					isError: true,
				};
			}

			const memory = state.memory.get(fief_id);
			if (!memory) {
				return {
					content: [{ type: "text", text: `Unknown fief: ${fief_id}` }],
					details: {},
					isError: true,
				};
			}

			const entries = memory.getEntries(category);
			const text = entries.length
				? entries
						.map(
							(e) =>
								`**[${e.category}]** ${e.timestamp}\n${e.content}`
						)
						.join("\n\n---\n\n")
				: `No memory entries${category ? ` in category '${category}'` : ""}.`;

			return {
				content: [{ type: "text", text }],
				details: { fief_id, entries },
			};
		},
	});

	// Get request audit log
	pi.registerTool({
		name: "get_request_log",
		label: "Get Request Log",
		description:
			"View the audit log of all cross-fief requests and orchestrator routing decisions.",
		parameters: Type.Object({
			limit: Type.Optional(
				Type.Number({ description: "Maximum entries to return (default: 50)" })
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const limit = params.limit ?? 50;
			const entries = state.requestLog.slice(-limit);

			return {
				content: [
					{
						type: "text",
						text: entries.length
							? entries.join("\n")
							: "No requests logged yet.",
					},
				],
				details: { count: entries.length, total: state.requestLog.length },
			};
		},
	});

	// --------------------------------------------------------------------------
	// Commands
	// --------------------------------------------------------------------------

	pi.registerCommand("fiefdom", {
		description: "Show fiefdom status and available commands",
		handler: async (_args, ctx) => {
			if (!state.initialized) {
				ctx.ui.notify(
					"Fiefdom not active.\n\nUse /fiefdom-setup to configure fiefs for this repository.",
					"info"
				);
				return;
			}

			const status = Array.from(state.agents.entries())
				.map(([id, agent]) => {
					const s = agent.getStatus();
					const mem = state.memory.get(id);
					return `${id}: ${s.state} (${s.messageCount ?? 0} msgs, ${mem?.getEntryCount() ?? 0} memories)`;
				})
				.join("\n");

			ctx.ui.notify(
				`Fiefdom Status:\n\n${status}\n\nCommands: /fiefdom-review\nTools: list_fiefs, route_ticket, query_fief, request_from_fief, get_fief_memory`,
				"info"
			);
		},
	});

	// --------------------------------------------------------------------------
	// Setup Command - First-time configuration
	// --------------------------------------------------------------------------

	pi.registerCommand("fiefdom-setup", {
		description: "Analyze repository and set up fief divisions",
		handler: async (_args, ctx) => {
			if (state.initialized) {
				const confirm = await ctx.ui.confirm(
					"Fiefdom already configured",
					"Do you want to reconfigure? This will not delete existing memory."
				);
				if (!confirm) return;
			}

			// Check for git repo
			if (!fs.existsSync(path.join(ctx.cwd, ".git"))) {
				ctx.ui.notify(
					"Fiefdom requires a git repository for worktree isolation.",
					"error"
				);
				return;
			}

			ctx.ui.notify("Analyzing repository structure...", "info");

			// Analyze the repository
			const analysis = await analyzeRepository(ctx.cwd);

			if (analysis.proposedFiefs.length === 0) {
				ctx.ui.notify(
					"Could not automatically detect fief boundaries.\n\n" +
						"Please create .pi/fiefs.json manually. See /fiefdom docs.",
					"warning"
				);
				return;
			}

			// Present proposal to user
			const proposalText = [
				`## Repository Analysis (${analysis.confidence} confidence)`,
				"",
				analysis.reasoning,
				"",
				"## Proposed Fiefs",
				"",
				...analysis.proposedFiefs.map(
					(f) => `### ${f.id}\n- Paths: ${f.paths.join(", ")}\n- ${f.description}\n- ${f.fileCount} files`
				),
			].join("\n");

			// Let user review/edit in editor
			const edited = await ctx.ui.editor(
				"Review proposed fief divisions (edit to customize)",
				proposalText
			);

			if (edited === undefined) {
				ctx.ui.notify("Setup cancelled.", "info");
				return;
			}

			// Confirm
			const confirm = await ctx.ui.confirm(
				"Apply configuration?",
				`This will create .pi/fiefs.json and persona files for ${analysis.proposedFiefs.length} fiefs.`
			);

			if (!confirm) {
				ctx.ui.notify("Setup cancelled.", "info");
				return;
			}

			// Generate and write config
			const { config, personas } = generateConfigFromAnalysis(analysis);

			// Create directories and files
			const configDir = path.join(ctx.cwd, CONFIG_DIR_NAME);
			const fiefsDir = path.join(configDir, "fiefs");

			await fs.promises.mkdir(fiefsDir, { recursive: true });

			// Write config
			await fs.promises.writeFile(
				path.join(configDir, "fiefs.json"),
				config,
				"utf-8"
			);

			// Write personas and create memory dirs
			for (const [fiefId, personaContent] of personas) {
				const fiefDir = path.join(fiefsDir, fiefId);
				await fs.promises.mkdir(path.join(fiefDir, "memory"), { recursive: true });

				await fs.promises.writeFile(
					path.join(fiefDir, "AGENT.md"),
					`# ${fiefId} Fief Agent\n\n${personaContent}`,
					"utf-8"
				);
			}

			// Add memory dirs and worktrees to .gitignore
			await ensureGitignore(ctx.cwd);

			ctx.ui.notify(
				`Fiefdom configured with ${analysis.proposedFiefs.length} fiefs.\n\n` +
					"Restart your session or use /reload to activate.",
				"info"
			);
		},
	});

	// --------------------------------------------------------------------------
	// Review Command - Reorganize fief boundaries
	// --------------------------------------------------------------------------

	pi.registerCommand("fiefdom-review", {
		description: "Review and potentially reorganize fief boundaries",
		handler: async (_args, ctx) => {
			if (!state.initialized || !state.config) {
				ctx.ui.notify(
					"Fiefdom not configured. Use /fiefdom-setup first.",
					"error"
				);
				return;
			}

			// Gather current state
			const fiefStats = await Promise.all(
				state.config.fiefs.map(async (fief) => {
					const memory = state.memory.get(fief.id);
					const agent = state.agents.get(fief.id);
					const status = agent?.getStatus();

					return {
						id: fief.id,
						paths: fief.paths,
						messageCount: status?.messageCount ?? 0,
						memoryCount: memory?.getEntryCount() ?? 0,
						memories: memory?.getEntries().slice(-3) ?? [],
					};
				})
			);

			// Re-analyze to find potential issues
			const analysis = await analyzeRepository(ctx.cwd);

			// Build review report
			const reviewLines = [
				"# Fiefdom Review",
				"",
				"## Current Fiefs",
				"",
			];

			for (const stats of fiefStats) {
				reviewLines.push(`### ${stats.id}`);
				reviewLines.push(`- Paths: ${stats.paths.join(", ")}`);
				reviewLines.push(`- Activity: ${stats.messageCount} messages`);
				reviewLines.push(`- Learnings: ${stats.memoryCount} memories`);

				if (stats.memories.length > 0) {
					reviewLines.push("- Recent learnings:");
					for (const mem of stats.memories) {
						reviewLines.push(`  - [${mem.category}] ${mem.content.slice(0, 100)}...`);
					}
				}
				reviewLines.push("");
			}

			// Highlight potential issues
			if (analysis.orphanPaths.length > 0) {
				reviewLines.push("## ⚠️ Unassigned Paths");
				reviewLines.push("");
				reviewLines.push("These directories are not covered by any fief:");
				for (const orphan of analysis.orphanPaths) {
					reviewLines.push(`- ${orphan}/`);
				}
				reviewLines.push("");
			}

			// Check for new directories
			const currentFiefPaths = new Set(
				state.config.fiefs.flatMap((f) =>
					f.paths.map((p) => p.replace("/**", ""))
				)
			);

			const newDirs = analysis.proposedFiefs.filter(
				(pf) => !currentFiefPaths.has(pf.paths[0].replace("/**", ""))
			);

			if (newDirs.length > 0) {
				reviewLines.push("## 💡 Potential New Fiefs");
				reviewLines.push("");
				reviewLines.push("These directories might warrant their own fief:");
				for (const dir of newDirs) {
					reviewLines.push(`- ${dir.id}: ${dir.description} (${dir.fileCount} files)`);
				}
				reviewLines.push("");
			}

			reviewLines.push("## Actions");
			reviewLines.push("");
			reviewLines.push("To modify fief boundaries:");
			reviewLines.push("1. Edit .pi/fiefs.json directly");
			reviewLines.push("2. Create/update persona files in .pi/fiefs/<id>/AGENT.md");
			reviewLines.push("3. Use /reload to apply changes");
			reviewLines.push("");
			reviewLines.push("Or use /fiefdom-setup to regenerate from scratch (keeps memories).");

			// Show in editor for review
			await ctx.ui.editor("Fiefdom Review", reviewLines.join("\n"));
		},
	});
}

// ============================================================================
// Helper: Ensure .gitignore entries
// ============================================================================

async function ensureGitignore(repoRoot: string): Promise<void> {
	const gitignorePath = path.join(repoRoot, ".gitignore");
	const entriesToAdd = [
		"# Fiefdom (local-only, not shared)",
		".pi/fiefs.json",
		".pi/fiefs/",
		".pi/worktrees/",
		".pi/cross-fief-requests.log",
	];

	let content = "";
	try {
		content = await fs.promises.readFile(gitignorePath, "utf-8");
	} catch {
		// No .gitignore yet
	}

	const linesToAdd: string[] = [];
	for (const entry of entriesToAdd) {
		if (!content.includes(entry.replace("# Fiefdom", "").trim())) {
			linesToAdd.push(entry);
		}
	}

	if (linesToAdd.length > 0) {
		const addition = "\n" + linesToAdd.join("\n") + "\n";
		await fs.promises.appendFile(gitignorePath, addition);
	}
}

// ============================================================================
// Helper: Spawn Fief Agent
// ============================================================================

async function spawnFiefAgent(
	ctx: ExtensionContext,
	fief: FiefConfig
): Promise<FiefAgent> {
	// Determine working directory (worktree if available, otherwise main repo)
	let cwd = ctx.cwd;
	if (state.worktreesDir) {
		const worktreePath = path.join(state.worktreesDir, fief.id);
		if (fs.existsSync(worktreePath)) {
			cwd = worktreePath;
		}
	}

	// Load persona (system prompt)
	// Resolve relative to config root (supports worktrees inheriting from main repo)
	const configRoot = state.config?._configRoot ?? ctx.cwd;
	const personaPath = path.join(configRoot, fief.persona);
	let persona = "";
	try {
		persona = fs.readFileSync(personaPath, "utf-8");
	} catch {
		// Use default persona
		persona = `You are the ${fief.id} specialist agent. You have write access only to: ${fief.paths.join(", ")}`;
	}

	// Load memory context
	const memory = state.memory.get(fief.id);
	const memoryContext = memory?.getContextSummary() ?? "";

	// Create and start the agent
	const agent = new FiefAgent(fief.id, {
		cwd,
		allowedPaths: fief.paths,
		persona,
		memoryContext,
		memory,
	});

	await agent.start();
	return agent;
}
