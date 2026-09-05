/**
 * Fiefdom CLI — the Claude Code adapter.
 *
 * Claude Code has no extension API to hold long-lived state, so the adapter is
 * a plain command-line tool driven by three things:
 *
 *   - generated subagents      one `.claude/agents/fief-<id>.md` per fief
 *   - a PreToolUse hook        enforces write boundaries using `agent_type`
 *   - a SessionStart hook      tells the orchestrator how to route
 *
 * All of it is derived from the same `.fiefdom/fiefs.json` the Pi extension
 * reads, so one repo works with either agent.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
	type FiefConfig,
	type FiefdomConfig,
	findFiefForPath,
	getFief,
	loadConfig,
	memoryPathOf,
	normalizeRepoPath,
	pathMatchesFief,
	personaPathOf,
	serializeConfig,
	toRepoRelative,
} from "../../core/config.ts";
import { FiefMemory, VALID_CATEGORIES } from "../../core/memory.ts";
import {
	FIEFDOM_DIR,
	findRepoRoot,
	getMainWorktreePath,
	resolvePaths,
} from "../../core/paths.ts";
import { resolveBin } from "../../core/bin.ts";
import { ensureGitignore, gitIgnoredNames } from "../../core/gitignore.ts";
import { analyzeRepository, generateConfigFromAnalysis } from "../../core/analyze.ts";
import { computeCoverage, groupByTopLevel } from "../../core/coverage.ts";
import { computeCoChange } from "../../core/cochange.ts";
import { extractWriteTargets } from "../../core/bashwrites.ts";
import {
	agentName,
	agentFile,
	commandFiles,
	fiefIdFromAgent,
	hookEntries,
	memorySnapshot,
	orchestratorContext,
} from "./templates.ts";

// ---------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------

interface Args {
	_: string[];
	flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
	const out: Args = { _: [], flags: {} };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg.startsWith("--")) {
			const [name, inline] = arg.slice(2).split(/=(.*)/s);
			if (inline !== undefined) {
				out.flags[name] = inline;
			} else if (argv[i + 1] && !argv[i + 1].startsWith("--")) {
				out.flags[name] = argv[++i];
			} else {
				out.flags[name] = true;
			}
		} else {
			out._.push(arg);
		}
	}
	return out;
}

function flagString(args: Args, name: string): string | undefined {
	const value = args.flags[name];
	return typeof value === "string" ? value : undefined;
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

function projectRoot(args?: Args): string {
	const explicit = args && flagString(args, "repo");
	if (explicit) return path.resolve(explicit);
	if (process.env.CLAUDE_PROJECT_DIR) return path.resolve(process.env.CLAUDE_PROJECT_DIR);
	return findRepoRoot(process.cwd());
}

function requireConfig(root: string): FiefdomConfig {
	const config = loadConfig(root);
	if (!config) {
		console.error(
			`Fiefdom is not configured for ${root}.\nRun \`fiefdom init\` (or /fiefdom-setup in Claude Code) to divide this repo.`
		);
		process.exit(1);
	}
	return config;
}

function readPersona(config: FiefdomConfig, fief: FiefConfig): string {
	try {
		return fs.readFileSync(personaPathOf(config, fief), "utf-8");
	} catch {
		return `You are the ${fief.id} specialist for this repository.`;
	}
}

function memoryFor(config: FiefdomConfig, fief: FiefConfig): FiefMemory {
	return new FiefMemory(memoryPathOf(config, fief));
}

// ---------------------------------------------------------------------------
// init / sync
// ---------------------------------------------------------------------------

async function cmdInit(args: Args): Promise<void> {
	const root = projectRoot(args);
	const paths = resolvePaths(root);
	const existing = loadConfig(root);

	if (existing && !args.flags.force) {
		console.log(
			`Fiefdom is already configured (${paths.stateDirName}/fiefs.json, ${existing.fiefs.length} fiefs).\nRegenerating Claude Code files; pass --force to re-analyze from scratch.`
		);
		await cmdSync(args);
		return;
	}

	console.log("Analyzing repository structure...");
	const analysis = await analyzeRepository(root);

	if (analysis.proposedFiefs.length === 0) {
		console.error(
			`Could not detect fief boundaries automatically (${analysis.confidence} confidence).\n` +
				`${analysis.reasoning}\n\n` +
				`Write ${paths.stateDirName}/fiefs.json by hand and run \`fiefdom sync\`.`
		);
		process.exit(1);
	}

	const { fiefs, personas } = generateConfigFromAnalysis(analysis, paths.stateDirName);

	fs.mkdirSync(paths.fiefsDir, { recursive: true });
	fs.writeFileSync(
		paths.configPath,
		serializeConfig({
			fiefs,
			useWorktrees: args.flags.worktrees === true,
			enforcement: (flagString(args, "enforcement") as any) ?? "strict",
			sharedPaths: [],
		}),
		"utf-8"
	);

	for (const fief of fiefs) {
		const personaPath = path.join(root, fief.persona);
		fs.mkdirSync(path.dirname(personaPath), { recursive: true });
		fs.mkdirSync(path.join(root, fief.memory), { recursive: true });
		if (!fs.existsSync(personaPath)) {
			fs.writeFileSync(
				personaPath,
				`# ${fief.id} fief\n\n${personas.get(fief.id) ?? ""}\n`,
				"utf-8"
			);
		}
	}

	console.log(
		`Wrote ${paths.stateDirName}/fiefs.json (${analysis.confidence} confidence):\n` +
			fiefs.map((f) => `  ${f.id}: ${f.paths.join(", ")}`).join("\n")
	);
	console.log(`\n${analysis.reasoning}\n`);

	await cmdSync(args);
}

async function cmdSync(args: Args): Promise<void> {
	const root = projectRoot(args);
	const config = requireConfig(root);
	const bin = resolveBin(config.paths.stateDir);

	const agentsDir = path.join(root, ".claude", "agents");
	const commandsDir = path.join(root, ".claude", "commands");
	fs.mkdirSync(agentsDir, { recursive: true });
	fs.mkdirSync(commandsDir, { recursive: true });

	// Agent definitions (one per fief), plus removal of ones we no longer own.
	const wanted = new Set(config.fiefs.map((f) => `${agentName(f.id)}.md`));
	for (const entry of fs.readdirSync(agentsDir)) {
		if (entry.startsWith("fief-") && entry.endsWith(".md") && !wanted.has(entry)) {
			fs.rmSync(path.join(agentsDir, entry));
			console.log(`  removed stale agent ${entry}`);
		}
	}

	for (const fief of config.fiefs) {
		const memory = memoryFor(config, fief);
		fs.writeFileSync(
			path.join(agentsDir, `${agentName(fief.id)}.md`),
			agentFile(
				fief,
				config,
				readPersona(config, fief),
				memorySnapshot(memory, bin, fief.id),
				bin
			),
			"utf-8"
		);
	}

	for (const [name, content] of commandFiles(bin, config.paths.stateDirName)) {
		fs.writeFileSync(path.join(commandsDir, name), content, "utf-8");
	}

	// Hooks can use the project-dir placeholder, so settings survive the repo
	// being moved or cloned to a different path.
	writeHooks(
		root,
		bin.startsWith(root + path.sep)
			? "${CLAUDE_PROJECT_DIR}" + bin.slice(root.length)
			: bin
	);
	ensureGitignore(root, config.paths.stateDirName);

	console.log(
		`Synced ${config.fiefs.length} fief agents into .claude/:\n` +
			config.fiefs.map((f) => `  ${agentName(f.id)} -> ${f.paths.join(", ")}`).join("\n") +
			`\n\nRestart the session (or /reload) to pick up new agents and hooks.`
	);
}

/**
 * Merge fiefdom's hooks into `.claude/settings.local.json`, replacing any
 * previous fiefdom entries and leaving everything else untouched.
 */
function writeHooks(root: string, bin: string): void {
	const settingsPath = path.join(root, ".claude", "settings.local.json");

	let settings: any = {};
	if (fs.existsSync(settingsPath)) {
		try {
			settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
		} catch (err) {
			console.error(
				`Refusing to touch ${settingsPath}: it is not valid JSON (${err}). Fix it and re-run sync.`
			);
			process.exit(1);
		}
	}

	settings.hooks ??= {};
	const ours = hookEntries(bin);

	for (const [event, entries] of Object.entries(ours)) {
		const existing: any[] = Array.isArray(settings.hooks[event])
			? settings.hooks[event]
			: [];
		const foreign = existing.filter((entry) => !isFiefdomHook(entry));
		settings.hooks[event] = [...foreign, ...entries];
	}

	fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
	fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}

function isFiefdomHook(entry: any): boolean {
	const hooks = entry?.hooks;
	if (!Array.isArray(hooks)) return false;
	return hooks.some((hook: any) => {
		const text = `${hook?.command ?? ""} ${(hook?.args ?? []).join(" ")}`;
		return text.includes("fiefdom");
	});
}

// ---------------------------------------------------------------------------
// status / review / analyze / owner
// ---------------------------------------------------------------------------

function topLevelDirs(root: string): string[] {
	const skip = new Set([".git", "node_modules", ".claude", ".pi", FIEFDOM_DIR]);
	const dirs = fs
		.readdirSync(root, { withFileTypes: true })
		.filter((e) => e.isDirectory() && !skip.has(e.name) && !e.name.startsWith("."))
		.map((e) => e.name);

	// Build output the repo already ignores is not a gap in coverage.
	const ignored = gitIgnoredNames(root, dirs);
	return dirs.filter((dir) => !ignored.has(dir));
}

/**
 * Does anyone own something in this directory? A directory counts as claimed
 * when a fief owns it outright, when it is shared, or when any glob reaches
 * inside it — `tests/` is claimed by `tests/gui/**` even though no fief owns
 * the whole tree.
 */
function isClaimed(dir: string, config: FiefdomConfig): boolean {
	if (findFiefForPath(dir, config)) return true;
	if (pathMatchesFief(dir, config.sharedPaths)) return true;

	const prefix = normalizeRepoPath(dir) + "/";
	const allGlobs = [...config.fiefs.flatMap((f) => f.paths), ...config.sharedPaths];
	return allGlobs.some((glob) => normalizeRepoPath(glob).startsWith(prefix));
}

/** Top-level directories nothing claims, in whole or in part. */
function unassignedDirs(root: string, config: FiefdomConfig): string[] {
	return topLevelDirs(root).filter((dir) => !isClaimed(dir, config));
}

function cmdStatus(args: Args): void {
	const root = projectRoot(args);
	const config = requireConfig(root);

	const coverage = computeCoverage(config);
	const rows = config.fiefs.map((fief) => {
		const memory = memoryFor(config, fief);
		return {
			id: fief.id,
			agent: agentName(fief.id),
			paths: fief.paths,
			memories: memory.getEntryCount(),
			files: coverage.owned.get(fief.id) ?? 0,
			persona: fs.existsSync(personaPathOf(config, fief)),
		};
	});

	const unassigned = unassignedDirs(root, config);

	if (args.flags.json) {
		console.log(
			JSON.stringify(
				{
					repo: root,
					stateDir: config.paths.stateDirName,
					enforcement: config.enforcement,
					useWorktrees: config.useWorktrees,
					sharedPaths: config.sharedPaths,
					fiefs: rows,
					unassigned,
					coverage: {
						total: coverage.total,
						unowned: coverage.unowned,
						contested: coverage.contested,
						shared: coverage.shared,
					},
				},
				null,
				2
			)
		);
		return;
	}

	console.log(`Fiefdom: ${rows.length} fiefs in ${root}`);
	console.log(
		`Config: ${config.paths.stateDirName}/fiefs.json | enforcement: ${config.enforcement} | worktrees: ${config.useWorktrees ? "on" : "off"}`
	);
	console.log("");
	for (const row of rows) {
		console.log(`  ${row.id}  (agent: ${row.agent})`);
		console.log(`    paths:    ${row.paths.join(", ")}`);
		console.log(
			`    files:    ${row.files}` +
				`    learnings: ${row.memories}${row.persona ? "" : "    [persona file missing]"}`
		);
	}
	if (!coverage.available) {
		if (unassigned.length) {
			console.log(`\n  unowned directories: ${unassigned.join(", ")}`);
		}
		return;
	}

	const claimed = coverage.total - coverage.unowned.length - coverage.shared.length;
	console.log(
		`\n  coverage: ${claimed}/${coverage.total} tracked files owned` +
			(coverage.shared.length ? `, ${coverage.shared.length} shared` : "") +
			(coverage.contested.length ? `, ${coverage.contested.length} contested` : "")
	);

	if (coverage.contested.length) {
		console.log("\n  claimed by more than one fief:");
		for (const { path: file, fiefs } of coverage.contested.slice(0, 8)) {
			console.log(`    ${file} — ${fiefs.join(", ")}`);
		}
		if (coverage.contested.length > 8) {
			console.log(`    ... and ${coverage.contested.length - 8} more`);
		}
		console.log("  (first match wins, so the boundary here is ambiguous)");
	}

	if (coverage.shared.length) {
		console.log(`\n  shared, no single owner: ${config.sharedPaths.join(", ")}`);
		console.log("  (an escape hatch — anything here is a boundary you haven't decided yet)");
	}

	if (coverage.unowned.length) {
		console.log("\n  unowned:");
		for (const { group, count } of groupByTopLevel(coverage.unowned).slice(0, 10)) {
			console.log(`    ${group} (${count})`);
		}
		console.log(
			"  (nobody can write these. Before widening a fief, ask whether the code\n" +
				"   itself is in the wrong place — an unownable path usually means the\n" +
				"   repository's boundaries are blurry there, not that fiefdom is wrong.)"
		);
	}
}

async function cmdReview(args: Args): Promise<void> {
	const root = projectRoot(args);
	const config = requireConfig(root);
	const analysis = await analyzeRepository(root);

	const lines: string[] = ["# Fiefdom review", "", "## Current fiefs", ""];

	for (const fief of config.fiefs) {
		const memory = memoryFor(config, fief);
		const recent = memory.getEntries().slice(-3);
		lines.push(`### ${fief.id}`);
		lines.push(`- paths: ${fief.paths.join(", ")}`);
		lines.push(`- learnings: ${memory.getEntryCount()}`);
		for (const entry of recent) {
			lines.push(`  - [${entry.category}] ${entry.content.slice(0, 120)}`);
		}
		lines.push("");
	}

	const unowned = [
		...new Set([
			...analysis.orphanPaths.filter((p) => !isClaimed(p, config)),
			...unassignedDirs(root, config),
		]),
	];

	if (unowned.length || config.sharedPaths.length) {
		lines.push("## Ownership gaps", "");
		lines.push(
			"A path no fief can own is a fact about the repository, not about fiefdom:",
			"it usually means the code there serves several concerns at once, or sits",
			"at a boundary nobody has decided. Prefer moving or splitting the code over",
			"widening a fief, and treat sharedPaths as a note that a decision is still",
			"outstanding.",
			""
		);

		if (unowned.length) {
			lines.push("Unowned:");
			for (const orphan of unowned) lines.push(`- ${orphan}/`);
			lines.push("");
		}

		if (config.sharedPaths.length) {
			lines.push("Shared (no single owner):");
			for (const shared of config.sharedPaths) lines.push(`- ${shared}`);
			lines.push("");
		}
	}

	const known = new Set(
		config.fiefs.flatMap((f) => f.paths.map((p) => p.replace(/\/\*\*$/, "")))
	);
	const candidates = analysis.proposedFiefs.filter(
		(pf) => !known.has(pf.paths[0].replace(/\/\*\*$/, ""))
	);

	if (candidates.length) {
		lines.push("## Possible new fiefs", "");
		for (const candidate of candidates) {
			lines.push(`- ${candidate.id}: ${candidate.description} (${candidate.fileCount} files)`);
		}
		lines.push("");
	}

	const cochange = computeCoChange(config);
	if (cochange.available && cochange.commits > 0) {
		const together = Math.round((cochange.multiFief / cochange.commits) * 100);
		lines.push("## Boundary friction", "");
		lines.push(
			`Of ${cochange.commits} commits in the last year, ${cochange.singleFief} stayed`,
			`inside one fief and ${cochange.multiFief} (${together}%) spanned several. Every`,
			"commit in that second group is a change that now needs routing, so the pairs",
			"below are where this division will cost you the most:",
			""
		);
		for (const { fiefs, commits } of cochange.pairs.slice(0, 5)) {
			lines.push(`- ${fiefs[0]} + ${fiefs[1]}: ${commits} commits`);
		}
		lines.push("");
		lines.push(
			"A pair near the top is worth a second look: either the two sides are more",
			"coupled than the split admits, or the boundary belongs somewhere else.",
			""
		);
	}

	lines.push("## Applying changes", "");
	lines.push(`1. Edit ${config.paths.stateDirName}/fiefs.json`);
	lines.push(`2. Update personas at ${config.paths.stateDirName}/fiefs/<id>/AGENT.md`);
	lines.push("3. Run `fiefdom sync`, then restart the session");

	console.log(lines.join("\n"));
}

async function cmdAnalyze(args: Args): Promise<void> {
	const root = projectRoot(args);
	const analysis = await analyzeRepository(root);

	if (args.flags.json) {
		console.log(JSON.stringify(analysis, null, 2));
		return;
	}

	console.log(`Repository analysis (${analysis.confidence} confidence)\n`);
	console.log(analysis.reasoning);
	console.log("\nProposed fiefs:");
	for (const fief of analysis.proposedFiefs) {
		console.log(`  ${fief.id}: ${fief.paths.join(", ")} (${fief.fileCount} files)`);
		console.log(`    ${fief.description}`);
	}
	if (analysis.orphanPaths.length) {
		console.log(`\nUnassigned: ${analysis.orphanPaths.join(", ")}`);
	}
}

function cmdOwner(args: Args): void {
	const root = projectRoot(args);
	const config = requireConfig(root);
	const target = args._[1];

	if (!target) {
		console.error("usage: fiefdom owner <path>");
		process.exit(1);
	}

	const relative = toRepoRelative(target, root, process.cwd());
	if (relative === null) {
		console.log("outside-repo");
		return;
	}

	const fief = findFiefForPath(relative, config);
	if (fief) {
		console.log(fief.id);
	} else {
		// Shared paths have no single owner but are still writable.
		console.log(pathMatchesFief(relative, config.sharedPaths) ? "shared" : "unassigned");
	}
}

// ---------------------------------------------------------------------------
// memory
// ---------------------------------------------------------------------------

function cmdMemory(args: Args): void {
	const root = projectRoot(args);
	const config = requireConfig(root);
	const sub = args._[1] ?? "show";

	if (sub === "show") {
		const fiefs = flagString(args, "fief")
			? config.fiefs.filter((f) => f.id === flagString(args, "fief"))
			: config.fiefs;

		if (fiefs.length === 0) {
			console.error(`Unknown fief: ${flagString(args, "fief")}`);
			process.exit(1);
		}

		for (const fief of fiefs) {
			const memory = memoryFor(config, fief);
			console.log(`# ${fief.id} memory (${memory.getEntryCount()} entries)\n`);
			if (args.flags.full) {
				const entries = memory.getEntries(flagString(args, "category"));
				for (const entry of entries) {
					console.log(`- [${entry.category}] ${entry.content}`);
				}
			} else {
				console.log(memory.getContextSummary());
			}
			console.log("");
		}
		return;
	}

	if (sub === "add") {
		const fiefId = flagString(args, "fief");
		if (!fiefId || !getFief(config, fiefId)) {
			console.error(
				`usage: fiefdom memory add --fief <${config.fiefs.map((f) => f.id).join("|")}> --json '{"decisions":["..."]}'`
			);
			process.exit(1);
		}

		const memory = memoryFor(config, getFief(config, fiefId)!);
		let learnings: Record<string, unknown>;

		const jsonFlag = flagString(args, "json");
		const category = flagString(args, "category");
		const content = flagString(args, "content");

		if (jsonFlag) {
			learnings = parseLearnings(jsonFlag);
		} else if (category && content) {
			learnings = { [category]: [content] };
		} else {
			const stdin = readStdin();
			if (!stdin.trim()) {
				console.error(
					"Nothing to record. Pass --json '{...}', or --category <c> --content <text>, or pipe JSON on stdin."
				);
				process.exit(1);
			}
			learnings = parseLearnings(stdin);
		}

		const added = memory.addLearnings(learnings, "agent");
		memory.prune();

		const unknown = Object.keys(learnings).filter((c) => !VALID_CATEGORIES.includes(c));
		console.log(
			`Recorded ${added} learning(s) for ${fiefId}.` +
				(unknown.length ? ` Filed under 'notes': ${unknown.join(", ")}.` : "")
		);
		return;
	}

	if (sub === "clear") {
		const fiefId = flagString(args, "fief");
		const fief = fiefId ? getFief(config, fiefId) : undefined;
		if (!fief) {
			console.error("usage: fiefdom memory clear --fief <id>");
			process.exit(1);
		}
		memoryFor(config, fief).clear();
		console.log(`Cleared memory for ${fief.id}.`);
		return;
	}

	console.error(`Unknown memory subcommand: ${sub} (show|add|clear)`);
	process.exit(1);
}

function parseLearnings(raw: string): Record<string, unknown> {
	const trimmed = raw.trim();
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
	const candidate = (fenced ? fenced[1] : trimmed).match(/\{[\s\S]*\}/);

	if (!candidate) {
		console.error("Could not find a JSON object in the input.");
		process.exit(1);
	}

	try {
		const parsed = JSON.parse(candidate[0]);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("expected an object keyed by category");
		}
		return parsed;
	} catch (err) {
		console.error(`Invalid learnings JSON: ${err}`);
		process.exit(1);
	}
}

function readStdin(): string {
	try {
		return fs.readFileSync(0, "utf-8");
	} catch {
		return "";
	}
}

// ---------------------------------------------------------------------------
// cross-fief audit log
// ---------------------------------------------------------------------------

function cmdLog(args: Args): void {
	const root = projectRoot(args);
	const config = requireConfig(root);

	if (args._[1] === "show") {
		const limit = Number(flagString(args, "limit") ?? 50);
		let content = "";
		try {
			content = fs.readFileSync(config.paths.auditLog, "utf-8");
		} catch {
			console.log("No cross-fief requests logged yet.");
			return;
		}
		const lines = content.split("\n").filter(Boolean);
		console.log(lines.slice(-limit).join("\n"));
		return;
	}

	const from = flagString(args, "from");
	const to = flagString(args, "to");
	const message = flagString(args, "message");

	if (!from || !to || !message) {
		console.error('usage: fiefdom log --from <fief> --to <fief> --message "..."');
		process.exit(1);
	}

	const entry = `[${new Date().toISOString()}] ${from} -> ${to}: ${message.replace(/\s+/g, " ").slice(0, 500)}`;
	fs.mkdirSync(path.dirname(config.paths.auditLog), { recursive: true });
	fs.appendFileSync(config.paths.auditLog, entry + "\n", "utf-8");
	console.log(entry);
}

// ---------------------------------------------------------------------------
// hooks
// ---------------------------------------------------------------------------

interface HookPayload {
	hook_event_name?: string;
	session_id?: string;
	cwd?: string;
	permission_mode?: string;
	tool_name?: string;
	tool_input?: Record<string, unknown>;
	agent_id?: string;
	agent_type?: string;
}

function deny(reason: string): never {
	process.stdout.write(
		JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: reason,
			},
		})
	);
	process.exit(0);
}

/** Allow by staying silent, so the user's own permission rules still apply. */
function passThrough(): never {
	process.exit(0);
}

function targetPathOf(toolInput: Record<string, unknown> | undefined): string | null {
	if (!toolInput) return null;
	for (const key of ["file_path", "notebook_path", "path", "filePath"]) {
		const value = toolInput[key];
		if (typeof value === "string" && value) return value;
	}
	return null;
}

/**
 * Resolve a tool's target path to a path that can be matched against fief
 * globs.
 *
 * Worktrees make this less obvious than it looks: an isolated agent edits
 * `<somewhere>/frontend/src/App.tsx`, and "somewhere" may be fiefdom's own
 * `.fiefdom/worktrees/<id>` or a checkout Claude Code created wherever it
 * likes. Either way the interesting part is the path *within* that checkout,
 * so paths are measured from whichever worktree of this repo contains them.
 *
 * Returns null when the file belongs to no checkout of this repository, which
 * the caller treats as "not fiefdom's business".
 */
function repoRelativeForActor(
	target: string,
	config: FiefdomConfig,
	cwd: string | undefined
): string | null {
	const repoRoot = config.paths.repoRoot;
	const absolute = path.isAbsolute(target)
		? target
		: path.resolve(cwd ?? repoRoot, target);

	const direct = toRepoRelative(absolute, repoRoot);
	if (direct !== null) {
		// A fiefdom worktree lives inside the main checkout; strip the
		// ".fiefdom/worktrees/<id>/" prefix so globs still line up.
		const prefix = normalizeRepoPath(path.relative(repoRoot, config.paths.worktreesDir));
		if (direct.startsWith(prefix + "/")) {
			const withoutPrefix = direct.slice(prefix.length + 1);
			const slash = withoutPrefix.indexOf("/");
			return slash === -1 ? null : withoutPrefix.slice(slash + 1);
		}
		return direct;
	}

	// Outside the main checkout: accept it only if it sits in another worktree
	// of this same repository (Claude Code's `isolation: worktree` puts them
	// wherever it wants).
	const outsideRoot = findRepoRoot(path.dirname(absolute));
	if (getMainWorktreePath(outsideRoot) !== repoRoot) return null;
	return toRepoRelative(absolute, outsideRoot);
}

/**
 * Everything this tool call would write, as repo-relative paths.
 *
 * File tools state their target outright. Bash has to be read: an agent
 * working through the shell edits with `sed -i` and heredocs, and those writes
 * are as real as any Write call.
 */
function writeTargetsOf(
	payload: HookPayload,
	config: FiefdomConfig
): Array<{ relative: string; reason: string }> {
	const raw: Array<{ path: string; reason: string; cwd?: string }> = [];

	if (payload.tool_name === "Bash") {
		const command = payload.tool_input?.command;
		if (typeof command === "string") {
			raw.push(...extractWriteTargets(command));
		}
	} else {
		const target = targetPathOf(payload.tool_input);
		if (target) raw.push({ path: target, reason: payload.tool_name ?? "write" });
	}

	const resolved: Array<{ relative: string; reason: string }> = [];
	for (const { path: target, reason, cwd } of raw) {
		const base = cwd ? path.resolve(payload.cwd ?? config.paths.repoRoot, cwd) : payload.cwd;
		const relative = repoRelativeForActor(target, config, base);
		// Anything outside this repository is none of fiefdom's business.
		if (relative !== null) resolved.push({ relative, reason });
	}
	return resolved;
}

function hookPreToolUse(): never {
	const payload = readHookPayload();
	if (process.env.FIEFDOM_DISABLE) passThrough();
	if (payload.permission_mode === "bypassPermissions") passThrough();

	const root = process.env.CLAUDE_PROJECT_DIR
		? path.resolve(process.env.CLAUDE_PROJECT_DIR)
		: findRepoRoot(payload.cwd ?? process.cwd());

	const config = loadConfig(root);
	if (!config || config.enforcement === "off") passThrough();

	const targets = writeTargetsOf(payload, config);
	// Nothing in this repository is being written.
	if (targets.length === 0) passThrough();

	const fiefId = fiefIdFromAgent(payload.agent_type);
	const viaShell = payload.tool_name === "Bash";

	// No fief identity: the orchestrator itself, or some other subagent.
	if (!fiefId) {
		const roster = config.fiefs
			.map((f) => `  ${agentName(f.id)} -> ${f.paths.join(", ")}`)
			.join("\n");
		const { relative, reason } = targets[0];
		const owner = findFiefForPath(relative, config);

		const actor = payload.agent_type
			? `Fiefdom: "${payload.agent_type}" is not a fief, and only fief agents write in this repo.\n`
			: `Fiefdom: the orchestrator does not edit files.\n`;

		deny(
			actor +
				(viaShell ? `That command writes ${relative} (${reason}).\n` : "") +
				(owner
					? `${relative} belongs to the ${owner.id} fief — delegate with the Agent tool (subagent_type: "${agentName(owner.id)}"), or SendMessage if that fief is already running.\n`
					: `${relative} is not owned by any fief. Ask the user whether to widen a fief's paths or add it to sharedPaths in ${config.paths.stateDirName}/fiefs.json.\n`) +
				`Fiefs:\n${roster}`
		);
	}

	const fief = getFief(config, fiefId);
	if (!fief) {
		deny(
			`Fiefdom: agent "${payload.agent_type}" claims fief "${fiefId}", which is not in ${config.paths.stateDirName}/fiefs.json. Run \`fiefdom sync\` after editing the config.`
		);
	}

	if (config.enforcement === "orchestrator") passThrough();

	const trespass = targets.find(
		({ relative }) =>
			!pathMatchesFief(relative, fief.paths) &&
			!(config.sharedPaths.length && pathMatchesFief(relative, config.sharedPaths))
	);
	if (!trespass) passThrough();

	const { relative, reason } = trespass;
	const owner = findFiefForPath(relative, config);
	deny(
		`Fiefdom: ${relative} is outside the ${fief.id} fief (${fief.paths.join(", ")}).\n` +
			(viaShell ? `That command writes it (${reason}); the shell is not a way around the boundary.\n` : "") +
			(owner
				? `It belongs to the ${owner.id} fief. Do not edit it. Finish your own part, then state exactly what you need from ${owner.id} — the orchestrator will route it.`
				: `No fief owns it. Do not edit it. Report what you need and let the orchestrator decide where it belongs.`)
	);
}

function hookSessionStart(): never {
	const payload = readHookPayload();
	const root = process.env.CLAUDE_PROJECT_DIR
		? path.resolve(process.env.CLAUDE_PROJECT_DIR)
		: findRepoRoot(payload.cwd ?? process.cwd());

	const config = loadConfig(root);
	if (!config) process.exit(0);

	process.stdout.write(
		JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "SessionStart",
				additionalContext: orchestratorContext(config, resolveBin(config.paths.stateDir)),
			},
		})
	);
	process.exit(0);
}

function readHookPayload(): HookPayload {
	const raw = readStdin();
	if (!raw.trim()) return {};
	try {
		return JSON.parse(raw) as HookPayload;
	} catch {
		// A malformed payload must never block the user's work.
		return {};
	}
}

// ---------------------------------------------------------------------------
// migrate
// ---------------------------------------------------------------------------

function cmdMigrate(args: Args): void {
	const root = projectRoot(args);
	const current = resolvePaths(root);

	if (!current.legacy) {
		console.log(`Already on the ${FIEFDOM_DIR}/ layout — nothing to migrate.`);
		return;
	}

	const target = path.join(root, FIEFDOM_DIR);
	fs.mkdirSync(target, { recursive: true });

	for (const entry of ["fiefs.json", "fiefs", "worktrees", "cross-fief-requests.log"]) {
		const from = path.join(current.stateDir, entry);
		const to = path.join(target, entry);
		if (fs.existsSync(from) && !fs.existsSync(to)) {
			fs.renameSync(from, to);
			console.log(`  moved .pi/${entry} -> ${FIEFDOM_DIR}/${entry}`);
		}
	}

	// Rewrite persona/memory paths that still point at .pi/.
	const config = loadConfig(root);
	if (config) {
		fs.writeFileSync(
			path.join(target, "fiefs.json"),
			serializeConfig({
				fiefs: config.fiefs.map((f) => ({
					...f,
					persona: f.persona.replace(/^\.pi\//, `${FIEFDOM_DIR}/`),
					memory: f.memory.replace(/^\.pi\//, `${FIEFDOM_DIR}/`),
				})),
				useWorktrees: config.useWorktrees,
				enforcement: config.enforcement,
				sharedPaths: config.sharedPaths,
			}),
			"utf-8"
		);
	}

	console.log(`Migrated to ${FIEFDOM_DIR}/. Run \`fiefdom sync\` to refresh Claude Code files.`);
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

const USAGE = `fiefdom — multi-agent workspace orchestration (Claude Code adapter)

  fiefdom init [--worktrees] [--enforcement strict|orchestrator|off] [--force]
      Analyze the repo, write ${FIEFDOM_DIR}/fiefs.json and personas, then sync.

  fiefdom sync
      Regenerate .claude/agents/fief-*.md, /fiefdom commands and hooks from
      the config. Run after editing fiefs.json or a persona.

  fiefdom status [--json]      Fiefs, ownership, learning counts, gaps
  fiefdom review               Boundary review with suggestions
  fiefdom analyze [--json]     Propose a division without writing anything
  fiefdom owner <path>         Which fief owns a path
  fiefdom migrate              Move a legacy .pi/ layout to ${FIEFDOM_DIR}/

  fiefdom memory show [--fief <id>] [--category <c>] [--full]
  fiefdom memory add --fief <id> --json '{"decisions":["..."]}'
  fiefdom memory clear --fief <id>

  fiefdom log --from <fief> --to <fief> --message "..."
  fiefdom log show [--limit 50]

  fiefdom hook pre-tool-use | session-start     (invoked by Claude Code)

Config lives in ${FIEFDOM_DIR}/fiefs.json and is shared with the Pi extension:
the same repo works with either agent.`;

export async function run(argv: string[]): Promise<void> {
	const args = parseArgs(argv);
	const command = args._[0];

	switch (command) {
		case "init":
			return cmdInit(args);
		case "sync":
			return cmdSync(args);
		case "status":
			return cmdStatus(args);
		case "review":
			return cmdReview(args);
		case "analyze":
			return cmdAnalyze(args);
		case "owner":
			return cmdOwner(args);
		case "memory":
			return cmdMemory(args);
		case "log":
			return cmdLog(args);
		case "migrate":
			return cmdMigrate(args);
		case "hook": {
			const event = args._[1];
			if (event === "pre-tool-use") hookPreToolUse();
			if (event === "session-start") hookSessionStart();
			// Unknown hook events must never block anything.
			process.exit(0);
		}
		case undefined:
		case "help":
		case "--help":
			console.log(USAGE);
			return;
		default:
			console.error(`Unknown command: ${command}\n\n${USAGE}`);
			process.exit(1);
	}
}
