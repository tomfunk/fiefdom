/**
 * Shared on-disk layout for fiefdom.
 *
 * Both harnesses (Pi extension, Claude Code adapter) read and write the same
 * files so a single repository can be opened with either agent and see the
 * same fiefs, personas and accumulated memory.
 *
 *   .fiefdom/
 *     fiefs.json                  config
 *     fiefs/<id>/AGENT.md         persona (shared system prompt)
 *     fiefs/<id>/memory/*.jsonl   persistent memory
 *     cross-fief-requests.log     audit trail
 *
 * Two kinds of inheritance are handled here:
 *
 *   - Repos configured by an older version keep working: if `.pi/fiefs.json`
 *     exists and `.fiefdom/fiefs.json` does not, the legacy layout is used.
 *   - A session started inside a git worktree inherits the main checkout's
 *     config, so fief workers see the same fiefs as the orchestrator.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export const FIEFDOM_DIR = ".fiefdom";
export const LEGACY_DIR = ".pi";

export interface FiefdomPaths {
	/** Where the session is running. Globs are matched relative to this. */
	repoRoot: string;
	/**
	 * Directory holding the state dir. Same as `repoRoot` normally; the main
	 * checkout when a worktree inherits its config. Persona and memory paths
	 * resolve against this.
	 */
	configRoot: string;
	/** Directory holding all fiefdom state, absolute */
	stateDir: string;
	/** Directory name relative to the config root (".fiefdom" or ".pi") */
	stateDirName: string;
	configPath: string;
	fiefsDir: string;
	auditLog: string;
	/** True when this repo is still on the legacy `.pi/` layout */
	legacy: boolean;
	/** True when the config came from a parent checkout, not this worktree */
	inherited: boolean;
}

function build(
	repoRoot: string,
	configRoot: string,
	dirName: string,
	legacy: boolean
): FiefdomPaths {
	const stateDir = path.join(configRoot, dirName);
	return {
		repoRoot,
		configRoot,
		stateDir,
		stateDirName: dirName,
		configPath: path.join(stateDir, "fiefs.json"),
		fiefsDir: path.join(stateDir, "fiefs"),
		auditLog: path.join(stateDir, "cross-fief-requests.log"),
		legacy,
		inherited: path.resolve(repoRoot) !== path.resolve(configRoot),
	};
}

/**
 * Detect whether `cwd` sits in a linked git worktree and return the main
 * checkout. Returns null in the main checkout, or outside git.
 */
export function getMainWorktreePath(cwd: string): string | null {
	try {
		const gitCommonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
			cwd,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();

		// A relative ".git" means we are in the main checkout.
		if (gitCommonDir === ".git") return null;

		const mainRepo = path.resolve(path.dirname(gitCommonDir));
		return mainRepo === path.resolve(cwd) ? null : mainRepo;
	} catch {
		return null;
	}
}

/**
 * Resolve the layout for a repo, in preference order:
 *   1. `.fiefdom/fiefs.json` here
 *   2. `.pi/fiefs.json` here (legacy)
 *   3. either of those in the main checkout, when here is a worktree
 * Falls back to the modern layout so callers can still build paths for a repo
 * that is not configured yet.
 */
export function resolvePaths(repoRoot: string): FiefdomPaths {
	const local = firstExisting(repoRoot, repoRoot);
	if (local) return local;

	const mainRepo = getMainWorktreePath(repoRoot);
	if (mainRepo) {
		const inherited = firstExisting(repoRoot, mainRepo);
		if (inherited) return inherited;
	}

	return build(repoRoot, repoRoot, FIEFDOM_DIR, false);
}

function firstExisting(repoRoot: string, configRoot: string): FiefdomPaths | null {
	for (const [dirName, legacy] of [
		[FIEFDOM_DIR, false],
		[LEGACY_DIR, true],
	] as const) {
		const candidate = build(repoRoot, configRoot, dirName, legacy);
		if (fs.existsSync(candidate.configPath)) return candidate;
	}
	return null;
}

/**
 * Walk up from `start` looking for a repo root (a directory containing `.git`;
 * in a linked worktree `.git` is a file, which still counts). Falls back to
 * `start` when nothing is found, so the CLI still works outside git.
 */
export function findRepoRoot(start: string): string {
	let dir = path.resolve(start);
	while (true) {
		if (fs.existsSync(path.join(dir, ".git"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return path.resolve(start);
		dir = parent;
	}
}

/** Default persona path for a fief, relative to the config root. */
export function defaultPersonaPath(stateDirName: string, fiefId: string): string {
	return path.posix.join(stateDirName, "fiefs", fiefId, "AGENT.md");
}

/** Default memory directory for a fief, relative to the config root. */
export function defaultMemoryPath(stateDirName: string, fiefId: string): string {
	return path.posix.join(stateDirName, "fiefs", fiefId, "memory/");
}
