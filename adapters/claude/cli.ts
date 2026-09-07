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

import { execFileSync } from "node:child_process";
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
	baronies,
	territories,
	toRepoRelative,
} from "../../core/config.ts";
import { FiefMemory, VALID_CATEGORIES } from "../../core/memory.ts";
import {
	FIEFDOM_DIR,
	findRepoRoot,
	getMainWorktreePath,
	resolvePaths,
} from "../../core/paths.ts";
import { PACKAGE_ROOT as PACKAGE_ROOT_DIR, resolveBin } from "../../core/bin.ts";
import { ensureGitignore, gitIgnoredNames } from "../../core/gitignore.ts";
import { analyzeRepository, generateConfigFromAnalysis } from "../../core/analyze.ts";
import { computeCoverage, groupByTopLevel } from "../../core/coverage.ts";
import { computeCoChange } from "../../core/cochange.ts";
import { extractWriteTargets } from "../../core/bashwrites.ts";
import { changedPaths, loadSnapshot, saveSnapshot, snapshot } from "../../core/watch.ts";
import {
	appendJournal,
	clearJournal,
	readJournal,
} from "../../core/journal.ts";
import {
	type Grant,
	bindGrant,
	boundGrant,
	claimedGrantId,
	currentSession,
	issueGrant,
	readGrant,
	rememberSession,
} from "../../core/grants.ts";
import {
	agentName,
	agentFile,
	commandFiles,
	fiefIdFromAgent,
	hookEntries,
	memorySnapshot,
	orchestratorContext,
	serfFile,
	serfName,
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

	// When fiefdom is installed as a plugin it already supplies the hooks and
	// the slash commands, and puts itself on the Bash tool's PATH — so the
	// generated files can say `fiefdom` and no shim is needed.
	const asPlugin = Boolean(process.env.CLAUDE_PLUGIN_ROOT) || args.flags.plugin === true;
	const bin = asPlugin ? "fiefdom" : resolveBin(config.paths.stateDir);

	const agentsDir = path.join(root, ".claude", "agents");
	const commandsDir = path.join(root, ".claude", "commands");
	fs.mkdirSync(agentsDir, { recursive: true });
	fs.mkdirSync(commandsDir, { recursive: true });

	// Agent definitions (one per fief), plus removal of ones we no longer own.
	const wanted = new Set([
		...config.fiefs.map((f) => `${agentName(f)}.md`),
		...config.fiefs.filter((f) => f.paths.length).map((f) => `${serfName(f)}.md`),
	]);
	for (const entry of fs.readdirSync(agentsDir)) {
		const ours = ["fief-", "wita-", "vassal-", "baron-", "serf-"].some((p) =>
			entry.startsWith(p)
		);
		if (ours && entry.endsWith(".md") && !wanted.has(entry)) {
			fs.rmSync(path.join(agentsDir, entry));
			console.log(`  removed stale agent ${entry}`);
		}
	}

	for (const fief of config.fiefs) {
		const memory = memoryFor(config, fief);
		fs.writeFileSync(
			path.join(agentsDir, `${agentName(fief)}.md`),
			agentFile(
				fief,
				config,
				readPersona(config, fief),
				memorySnapshot(memory, bin, fief.id),
				bin
			),
			"utf-8"
		);

		// A holder with no land has nothing to put a serf on.
		if (fief.paths.length) {
			fs.writeFileSync(
				path.join(agentsDir, `${serfName(fief)}.md`),
				serfFile(fief, config, readPersona(config, fief)),
				"utf-8"
			);
		}
	}

	// Only the agents are repo-specific; writing the rest again would mean two
	// copies of the same thing to keep in step.
	if (!asPlugin) {
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
	}

	ensureGitignore(root, config.paths.stateDirName);

	console.log(
		`Synced ${config.fiefs.length} holders into .claude/:\n` +
			config.fiefs
				.map((f) =>
					f.paths.length
						? `  ${agentName(f)} -> ${f.paths.join(", ")}` +
							`\n    ${serfName(f)} -> same land, for narrow tasks`
						: `  ${agentName(f)} -> no land (advises)`
				)
				.join("\n") +
			(asPlugin
				? `\n\nHooks and commands come from the fiefdom plugin; only the agents are ` +
					`written per repo.\nRestart the session (or /reload) to pick up new agents.`
				: `\n\nRestart the session (or /reload) to pick up new agents and hooks.`)
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
	const rows = territories(config).map((fief) => {
		const memory = memoryFor(config, fief);
		return {
			id: fief.id,
			agent: agentName(fief),
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

	console.log(
		`Fiefdom: ${rows.length} fiefs${baronies(config).length ? ` and ${baronies(config).length} baronies` : ""} in ${root}`
	);
	console.log(
		`Config: ${config.paths.stateDirName}/fiefs.json | enforcement: ${config.enforcement}`
	);
	console.log("");
	for (const row of rows) {
		console.log(`  ${row.id}  (vassal: ${row.agent})`);
		console.log(`    holds:    ${row.paths.join(", ")}`);
		console.log(
			`    files:    ${row.files}` +
				`    learnings: ${row.memories}${row.persona ? "" : "    [persona file missing]"}`
		);
	}
	const scattered = baronies(config);
	if (scattered.length) {
		console.log("\n  baronies — land scattered through the fiefs above:");
		for (const baron of scattered) {
			const memory = memoryFor(config, baron);
			console.log(`    ${baron.id}  (baron: ${agentName(baron)})`);
			console.log(
				`      holds:    ${baron.paths.join(", ") || "no land (advises only)"}`
			);
			console.log(
				`      files:    ${coverage.owned.get(baron.id) ?? 0}    learnings: ${memory.getEntryCount()}`
			);
		}
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
// checkpoint / resume
// ---------------------------------------------------------------------------

function cmdCheckpoint(args: Args): void {
	const root = projectRoot(args);
	const config = requireConfig(root);
	const fiefId = flagString(args, "fief");
	const fief = fiefId ? getFief(config, fiefId) : undefined;

	if (!fief) {
		console.error(
			`usage: fiefdom checkpoint --fief <${config.fiefs.map((f) => f.id).join("|")}> "what you just finished"\n` +
				`       fiefdom checkpoint --fief <id> --done`
		);
		process.exit(1);
	}

	if (args.flags.done) {
		clearJournal(config, fief);
		console.log(`Journal cleared for ${fief.id}; the task is done.`);
		return;
	}

	const note = args._.slice(1).join(" ").trim() || flagString(args, "note");
	if (!note) {
		console.error('Say what you finished: fiefdom checkpoint --fief <id> "..."');
		process.exit(1);
	}

	appendJournal(config, fief, note, flagString(args, "by"));
	console.log(`Noted for ${fief.id}: ${note}`);
}

/**
 * What the last attempt on this land left behind.
 *
 * Because fiefs are path-disjoint, uncommitted changes can be attributed to a
 * holder exactly — no guessing which agent touched what.
 */
function cmdResume(args: Args): void {
	const root = projectRoot(args);
	const config = requireConfig(root);
	const fiefId = flagString(args, "fief");
	const fief = fiefId ? getFief(config, fiefId) : undefined;

	if (!fief) {
		console.error(`usage: fiefdom resume --fief <${config.fiefs.map((f) => f.id).join("|")}>`);
		process.exit(1);
	}

	const entries = readJournal(config, fief);
	console.log(`# Picking up ${fief.id}`);
	console.log("");

	if (entries.length) {
		console.log("What the last attempt recorded:");
		for (const entry of entries) {
			const when = entry.at.slice(11, 16);
			console.log(`  ${when}  ${entry.note}${entry.by ? `  (${entry.by})` : ""}`);
		}
	} else {
		console.log("Nothing was checkpointed — either the task is fresh, or the");
		console.log("last attempt died before recording anything.");
	}

	const dirty = uncommittedOnLand(config, fief);
	console.log("");
	if (dirty.length) {
		console.log(`Uncommitted changes on ${fief.id} land — the work already done:`);
		for (const { code, file } of dirty.slice(0, 40)) {
			console.log(`  ${code}  ${file}`);
		}
		if (dirty.length > 40) console.log(`  ... and ${dirty.length - 40} more`);
		console.log("");
		console.log("Read those files before writing anything: some of this may already");
		console.log("be finished, and redoing it is how half-applied changes happen.");
	} else {
		console.log(`No uncommitted changes on ${fief.id} land.`);
	}
}

/** Working-tree changes that fall inside a fief's paths. */
function uncommittedOnLand(
	config: FiefdomConfig,
	fief: FiefConfig
): Array<{ code: string; file: string }> {
	let porcelain = "";
	try {
		porcelain = execFileSync(
			"git",
			["status", "--porcelain", "-z", "--untracked-files=all"],
			{ cwd: config.paths.repoRoot, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 }
		);
	} catch {
		return [];
	}

	const out: Array<{ code: string; file: string }> = [];
	const records = porcelain.split("\0").filter(Boolean);
	for (let i = 0; i < records.length; i++) {
		const code = records[i].slice(0, 2);
		const file = records[i].slice(3);
		if (code[0] === "R" || code[1] === "R") i++;
		if (!file) continue;
		if (pathMatchesFief(file, fief.paths)) out.push({ code: code.trim() || "??", file });
	}
	return out;
}

// ---------------------------------------------------------------------------
// status line
// ---------------------------------------------------------------------------

/**
 * A one-line summary for the terminal's status line, so it is obvious at a
 * glance whether the fiefs are being enforced in this repo.
 *
 * Claude Code replaces the whole line with whatever this prints, so it carries
 * the directory too rather than only the crown.
 */
function cmdStatusline(): void {
	let payload: any = {};
	try {
		payload = JSON.parse(readStdin() || "{}");
	} catch {
		// Fall back to the working directory below.
	}

	const cwd =
		payload?.workspace?.current_dir ?? payload?.cwd ?? process.cwd();
	const home = process.env.HOME ?? "";
	const shownDir = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;

	const config = loadConfig(findRepoRoot(cwd));
	if (!config) {
		console.log(shownDir);
		return;
	}

	const held = territories(config).length;
	const scattered = baronies(config).length;

	const parts = [`${held} ${held === 1 ? "fief" : "fiefs"}`];
	if (scattered) parts.push(`${scattered} ${scattered === 1 ? "barony" : "baronies"}`);
	if (config.enforcement !== "strict") parts.push(config.enforcement);

	console.log(`${shownDir}  ♔ ${parts.join(" · ")}`);
}

// ---------------------------------------------------------------------------
// plugin packaging
// ---------------------------------------------------------------------------

/**
 * Regenerate the committed plugin artefacts — `hooks/hooks.json` and
 * `commands/` — from the same generators that write a standalone repo's files.
 *
 * They are committed rather than generated at install time because a plugin is
 * a static directory, but they must not drift from the standalone path, so
 * there is one source of truth and this command re-emits it.
 */
function cmdBuildPlugin(args: Args): void {
	const root = flagString(args, "root") ?? PACKAGE_ROOT_DIR;

	// Inside a plugin the CLI is on PATH, so the generated files can simply
	// say `fiefdom` instead of an absolute path into somebody's checkout.
	const bin = "fiefdom";

	const hooksDir = path.join(root, "hooks");
	const commandsDir = path.join(root, "commands");
	fs.mkdirSync(hooksDir, { recursive: true });
	fs.mkdirSync(commandsDir, { recursive: true });

	const pluginBin = "${CLAUDE_PLUGIN_ROOT}/bin/fiefdom";
	fs.writeFileSync(
		path.join(hooksDir, "hooks.json"),
		JSON.stringify({ hooks: hookEntries(pluginBin) }, null, 2) + "\n",
		"utf-8"
	);

	// Plugin commands are namespaced (/fiefdom:plan), so the redundant prefix
	// comes off the filenames — and the bare one becomes /fiefdom:status.
	for (const [name, content] of commandFiles(bin, FIEFDOM_DIR)) {
		const bare = name === "fiefdom.md" ? "status.md" : name.replace(/^fiefdom-/, "");
		fs.writeFileSync(path.join(commandsDir, bare), content, "utf-8");
	}

	console.log(`Rebuilt plugin artefacts in ${root}:`);
	console.log("  hooks/hooks.json");
	for (const entry of fs.readdirSync(commandsDir).sort()) {
		console.log(`  commands/${entry}`);
	}
}

// ---------------------------------------------------------------------------
// grants (subinfeudation)
// ---------------------------------------------------------------------------

function cmdGrant(args: Args): void {
	const root = projectRoot(args);
	const config = requireConfig(root);

	const fiefId = flagString(args, "fief");
	const rawPaths = flagString(args, "paths");
	const session = flagString(args, "session") ?? currentSession(config.paths.repoRoot);
	const fief = fiefId ? getFief(config, fiefId) : undefined;

	if (!fief || !rawPaths) {
		console.error(
			'usage: fiefdom grant --fief <id> --paths "core/db.ts,core/sync.ts" [--task "..."]'
		);
		process.exit(1);
	}

	const paths = rawPaths
		.split(",")
		.map((p) => p.trim())
		.filter(Boolean);

	// A grant may only narrow: every path must already be the holder's.
	const outside = paths.filter(
		(p) => !pathMatchesFief(p, fief.paths) && !pathMatchesFief(p, config.sharedPaths)
	);
	if (outside.length) {
		console.error(
			`You cannot grant land you do not hold: ${outside.join(", ")}\n` +
				`The ${fief.id} fief is ${fief.paths.join(", ")}.`
		);
		process.exit(1);
	}

	const grant = issueGrant(session, fief.id, paths, flagString(args, "task"));

	console.log(`Granted ${grant.id}: ${paths.join(", ")}`);
	console.log("");
	console.log("Put this line in the serf's prompt, before anything else:");
	console.log(`  Claim your grant first: \`${resolveBin(config.paths.stateDir)} claim ${grant.id}\``);
}

function cmdClaim(args: Args): void {
	const root = projectRoot(args);
	const config = requireConfig(root);
	const session = flagString(args, "session") ?? currentSession(config.paths.repoRoot);
	const grantId = args._[1];

	const grant = grantId ? readGrant(session, grantId) : null;
	if (!grant) {
		console.error(
			`No such grant: ${grantId ?? "(none given)"}. Ask your holder to issue one, or work within the whole fief.`
		);
		process.exit(1);
	}

	// The binding itself is made by the hook, which is the only place that
	// knows which agent is running this command.
	console.log(`Claimed ${grant.id} — your land for this task:`);
	for (const p of grant.paths) console.log(`  ${p}`);
	if (grant.task) console.log(`\nGranted for: ${grant.task}`);
	console.log(`\nAnything outside those paths is refused, even inside the ${grant.fief} fief.`);
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
	tool_use_id?: string;
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
	if (direct !== null) return direct;

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

	// Hooks know the session id; the CLI an agent runs does not. Record it so
	// grants issued from a shell land under the key the guard reads.
	if (payload.session_id) rememberSession(config.paths.repoRoot, payload.session_id);

	// A serf claiming its grant: this is the one moment both the agent's id and
	// the grant it was given are visible together, so the pairing is made here.
	if (payload.tool_name === "Bash" && payload.agent_id && payload.session_id) {
		const command = payload.tool_input?.command;
		const grantId = typeof command === "string" ? claimedGrantId(command) : null;
		if (grantId) {
			const grant = readGrant(payload.session_id, grantId);
			const claimant = fiefIdFromAgent(payload.agent_type);
			// Only the fief the grant came from may claim it.
			if (grant && claimant === grant.fief) {
				bindGrant(payload.session_id, payload.agent_id, grant);
			}
		}
	}

	// Commands can write in ways no parser will catch, so record the state of
	// the working tree first; the PostToolUse hook compares against it.
	if (payload.tool_name === "Bash" && payload.tool_use_id && payload.session_id) {
		const before = snapshot(config.paths.repoRoot);
		if (before) saveSnapshot(payload.session_id, payload.tool_use_id, before);
	}

	const targets = writeTargetsOf(payload, config);
	// Nothing in this repository is being written.
	if (targets.length === 0) passThrough();

	const fiefId = fiefIdFromAgent(payload.agent_type);
	const viaShell = payload.tool_name === "Bash";

	// No fief identity: the orchestrator itself, or some other subagent.
	if (!fiefId) {
		const roster = config.fiefs
			.map((f) => `  ${agentName(f)} -> ${f.paths.join(", ")}`)
			.join("\n");
		const { relative, reason } = targets[0];
		const owner = findFiefForPath(relative, config);

		const actor = payload.agent_type
			? `Fiefdom: "${payload.agent_type}" holds no land here, and only holders write in this repo.\n`
			: `Fiefdom: the liege does not work the land.\n`;

		deny(
			actor +
				(viaShell ? `That command writes ${relative} (${reason}).\n` : "") +
				(owner
					? `${relative} is ${owner.id}'s land — grant the work with the Agent tool (subagent_type: "${agentName(owner)}"), or SendMessage if that holder is already running.\n`
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

	if (fief.paths.length === 0) {
		deny(
			`Fiefdom: ${fief.id} holds no land, so it advises rather than writes.\n` +
				`Report the finding instead: name the file, the gap and the fief that owns it, ` +
				`and the orchestrator will route the change.`
		);
	}

	if (config.enforcement === "orchestrator") passThrough();

	// A serf that claimed a grant holds only what it was granted.
	const grant =
		payload.agent_id && payload.session_id
			? boundGrant(payload.session_id, payload.agent_id)
			: null;
	const held = grant && grant.fief === fief.id ? grant.paths : fief.paths;

	const trespass = targets.find(
		({ relative }) =>
			!pathMatchesFief(relative, held) &&
			!(config.sharedPaths.length && pathMatchesFief(relative, config.sharedPaths))
	);
	if (!trespass) passThrough();

	const { relative, reason } = trespass;
	const owner = findFiefForPath(relative, config);

	if (grant && grant.fief === fief.id) {
		deny(
			`Fiefdom: ${relative} is outside your grant (${grant.paths.join(", ")}).\n` +
				(viaShell ? `That command writes it (${reason}).\n` : "") +
				`It may still be ${fief.id} land, but this task was carved narrower than the fief. ` +
				`Report what else needs changing and let the holder decide — it is coordinating ` +
				`the whole piece of work and you are seeing one part of it.`
		);
	}

	deny(
		`Fiefdom: ${relative} is outside the ${fief.id} fief (${fief.paths.join(", ")}).\n` +
			(viaShell ? `That command writes it (${reason}); the shell is not a way around the boundary.\n` : "") +
			(owner
				? `It belongs to the ${owner.id} fief. Do not edit it. Finish your own part, then state exactly what you need from ${owner.id} — the orchestrator will route it.`
				: `No fief owns it. Do not edit it. Report what you need and let the orchestrator decide where it belongs.`)
	);
}

/**
 * After a command runs, compare the working tree against the snapshot taken
 * before it and report writes that landed outside the actor's territory.
 *
 * The tool has already run, so this cannot block. It does not revert either:
 * the change may be wanted, and throwing away work to enforce a boundary is a
 * worse failure than crossing one. It tells the agent, in its own turn, while
 * undoing is still cheap.
 */
function hookPostToolUse(): never {
	const payload = readHookPayload();
	if (process.env.FIEFDOM_DISABLE) passThrough();
	if (!payload.session_id || !payload.tool_use_id) passThrough();

	const before = loadSnapshot(payload.session_id, payload.tool_use_id);
	if (!before) passThrough();

	const root = process.env.CLAUDE_PROJECT_DIR
		? path.resolve(process.env.CLAUDE_PROJECT_DIR)
		: findRepoRoot(payload.cwd ?? process.cwd());

	const config = loadConfig(root);
	if (!config || config.enforcement === "off") passThrough();

	const after = snapshot(config.paths.repoRoot);
	if (!after) passThrough();

	const changed = changedPaths(before, after, config.paths.repoRoot);
	if (changed.length === 0) passThrough();

	const fiefId = fiefIdFromAgent(payload.agent_type);
	const fief = fiefId ? getFief(config, fiefId) : undefined;

	// With no fief identity nothing in the repo was theirs to touch; a fief is
	// judged against its own paths.
	const allowed = (file: string) =>
		fief
			? pathMatchesFief(file, fief.paths) ||
				(config.sharedPaths.length && pathMatchesFief(file, config.sharedPaths))
			: false;

	if (fief && config.enforcement === "orchestrator") passThrough();

	const trespass = changed.filter((file) => !allowed(file) && !isFiefdomState(file, config));
	if (trespass.length === 0) passThrough();

	const who = fief ? `the ${fief.id} fief` : "any fief (the liege holds none)";
	const owners = trespass
		.slice(0, 10)
		.map((file) => {
			const owner = findFiefForPath(file, config);
			return `  ${file}${owner ? ` (belongs to ${owner.id})` : " (unowned)"}`;
		})
		.join("\n");

	process.stdout.write(
		JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PostToolUse",
				additionalContext:
					`Fiefdom: this command changed files outside ${who}:\n${owners}` +
					(trespass.length > 10 ? `\n  ... and ${trespass.length - 10} more` : "") +
					`\n\nThis is a notice, not an instruction to undo anything. The write has ` +
					`already happened, and it may well be correct — a command run on someone ` +
					`else's behalf looks exactly like a boundary crossing from here.\n\n` +
					`Judge it yourself: if you changed those files by mistake, restore just ` +
					`those paths and say so. If the change was wanted, keep it and note which ` +
					`fief's territory it touched, so the division can be revisited. Never run a ` +
					`blanket revert on this notice — it will destroy work that was meant to be there.`,
			},
		})
	);
	process.exit(0);
}

/** Fiefdom's own state is not part of anyone's territory. */
function isFiefdomState(file: string, config: FiefdomConfig): boolean {
	return (
		file.startsWith(`${config.paths.stateDirName}/`) || file.startsWith(".claude/")
	);
}

function hookSessionStart(): never {
	const payload = readHookPayload();
	const root = process.env.CLAUDE_PROJECT_DIR
		? path.resolve(process.env.CLAUDE_PROJECT_DIR)
		: findRepoRoot(payload.cwd ?? process.cwd());

	const config = loadConfig(root);
	if (!config) process.exit(0);

	if (payload.session_id) rememberSession(config.paths.repoRoot, payload.session_id);

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

/**
 * Move a repo from the standalone install to the plugin: take out what the
 * plugin now supplies, and leave only what is genuinely per-repo.
 */
async function cmdMigrateToPlugin(args: Args): Promise<void> {
	const root = projectRoot(args);
	const config = requireConfig(root);
	const removed: string[] = [];

	// The generated slash commands.
	const commandsDir = path.join(root, ".claude", "commands");
	try {
		for (const entry of fs.readdirSync(commandsDir)) {
			if (/^fiefdom.*\.md$/.test(entry)) {
				fs.rmSync(path.join(commandsDir, entry));
				removed.push(`.claude/commands/${entry}`);
			}
		}
		if (fs.readdirSync(commandsDir).length === 0) fs.rmdirSync(commandsDir);
	} catch {
		// No commands directory: nothing to take out.
	}

	// Our hook entries, leaving anyone else's alone.
	const settingsPath = path.join(root, ".claude", "settings.local.json");
	if (fs.existsSync(settingsPath)) {
		try {
			const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
			let touched = false;

			for (const [event, entries] of Object.entries(settings.hooks ?? {})) {
				if (!Array.isArray(entries)) continue;
				const kept = entries.filter((entry) => !isFiefdomHook(entry));
				if (kept.length === entries.length) continue;

				touched = true;
				removed.push(`${event} hook`);
				if (kept.length) settings.hooks[event] = kept;
				else delete settings.hooks[event];
			}

			if (settings.hooks && Object.keys(settings.hooks).length === 0) {
				delete settings.hooks;
			}
			if (touched) {
				fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
			}
		} catch (err) {
			console.error(`Left ${settingsPath} alone: ${err}`);
		}
	}

	// The shim exists only to give a standalone install a short path.
	const shimDir = path.join(config.paths.stateDir, "bin");
	if (fs.existsSync(shimDir)) {
		fs.rmSync(shimDir, { recursive: true, force: true });
		removed.push(`${config.paths.stateDirName}/bin/`);
	}

	console.log(
		removed.length
			? `Removed what the plugin now supplies:\n${removed.map((r) => `  ${r}`).join("\n")}`
			: "Nothing to remove — this repo was not on the standalone install."
	);
	console.log("");

	await cmdSync({ ...args, flags: { ...args.flags, plugin: true } });

	console.log("");
	console.log(
		"Load the plugin for this to take effect:\n" +
			"  claude --plugin-dir <your fiefdom checkout>\n" +
			"Without it, this repo now has no fiefdom hooks and no boundaries are enforced."
	);
}

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

  fiefdom init [--enforcement strict|orchestrator|off] [--force]
      Analyze the repo, write ${FIEFDOM_DIR}/fiefs.json and personas, then sync.

  fiefdom sync [--plugin]
      Regenerate the per-repo agents from the config. Run after editing
      fiefs.json or a persona. Also writes the hooks and slash commands
      unless fiefdom is installed as a plugin, which already supplies them.

  fiefdom status [--json]      Fiefs, ownership, learning counts, gaps
  fiefdom review               Boundary review with suggestions
  fiefdom analyze [--json]     Propose a division without writing anything
  fiefdom owner <path>         Which fief owns a path
  fiefdom migrate              Move a legacy .pi/ layout to ${FIEFDOM_DIR}/
  fiefdom migrate --plugin     Move off the standalone install: drop the hooks,
                               commands and shim the plugin now supplies

  fiefdom memory show [--fief <id>] [--category <c>] [--full]
  fiefdom memory add --fief <id> --json '{"decisions":["..."]}'
  fiefdom memory clear --fief <id>

  fiefdom grant --fief <id> --paths "a.ts,b.ts" [--task "..."]
      Carve an ephemeral sub-fief out of your own land for a serf.
  fiefdom claim <grant-id>
      Bind yourself to a grant (a serf's first act).

  fiefdom log --from <fief> --to <fief> --message "..."
  fiefdom log show [--limit 50]

  fiefdom checkpoint --fief <id> "what you just finished"
  fiefdom checkpoint --fief <id> --done
  fiefdom resume --fief <id>   What the last attempt left behind, when an
                               agent was interrupted mid-task

  fiefdom statusline           A crown in the status line when fiefs are
                               enforced here (see the README to wire it up)

  fiefdom hook pre-tool-use | post-tool-use | session-start   (invoked by
                                                Claude Code)

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
		case "grant":
			return cmdGrant(args);
		case "claim":
			return cmdClaim(args);
		case "build-plugin":
			return cmdBuildPlugin(args);
		case "statusline":
			return cmdStatusline();
		case "checkpoint":
			return cmdCheckpoint(args);
		case "resume":
			return cmdResume(args);
		case "migrate":
			return args.flags.plugin === true ? cmdMigrateToPlugin(args) : cmdMigrate(args);
		case "hook": {
			const event = args._[1];
			if (event === "pre-tool-use") hookPreToolUse();
			if (event === "post-tool-use") hookPostToolUse();
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
