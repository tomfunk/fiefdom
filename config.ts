/**
 * Fiefdom configuration loading and path matching
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { minimatch } from "minimatch";

export interface FiefConfig {
	id: string;
	paths: string[];
	persona: string;
	memory: string;
}

export interface FiefdomConfig {
	fiefs: FiefConfig[];
	useWorktrees?: boolean;  // Default: false
	_loadedFrom?: string;    // Path where config was loaded from (for diagnostics)
	_configRoot?: string;    // Root directory for resolving relative paths (persona, memory)
}

/**
 * Detect if we're in a git worktree and return the main repo path.
 * Returns null if not in a worktree or not a git repo.
 */
export function getMainWorktreePath(cwd: string): string | null {
	try {
		// git rev-parse --git-common-dir returns the shared .git directory
		// For worktrees, this is the main repo's .git dir
		// For the main repo itself, it returns .git (relative)
		const gitCommonDir = execSync("git rev-parse --git-common-dir", {
			cwd,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();

		// If it's just ".git", we're in the main repo
		if (gitCommonDir === ".git") {
			return null;
		}

		// gitCommonDir is an absolute path to the main repo's .git directory
		// The main repo is its parent
		const mainRepoPath = path.dirname(gitCommonDir);

		// Verify it's different from cwd
		const resolvedCwd = path.resolve(cwd);
		const resolvedMain = path.resolve(mainRepoPath);

		if (resolvedCwd === resolvedMain) {
			return null;
		}

		return resolvedMain;
	} catch {
		// Not a git repo or git not available
		return null;
	}
}

/**
 * Find the fiefs.json config path, checking worktree parent if needed.
 * Returns the path to use, or null if not found.
 */
export function findFiefdomConfigPath(cwd: string): string | null {
	const localPath = path.join(cwd, ".pi", "fiefs.json");

	// First check local .pi/fiefs.json
	if (fs.existsSync(localPath)) {
		return localPath;
	}

	// If we're in a worktree, check the main repo
	const mainRepoPath = getMainWorktreePath(cwd);
	if (mainRepoPath) {
		const mainConfigPath = path.join(mainRepoPath, ".pi", "fiefs.json");
		if (fs.existsSync(mainConfigPath)) {
			return mainConfigPath;
		}
	}

	return null;
}

/**
 * Load fiefdom configuration from .pi/fiefs.json
 */
export function loadFiefdomConfig(configPath: string): FiefdomConfig | null {
	try {
		const content = fs.readFileSync(configPath, "utf-8");
		const raw = JSON.parse(content);

		if (!raw.fiefs || !Array.isArray(raw.fiefs)) {
			console.error("Fiefdom: Invalid config - missing 'fiefs' array");
			return null;
		}

		const fiefs: FiefConfig[] = [];

		for (const fief of raw.fiefs) {
			if (!fief.id || typeof fief.id !== "string") {
				console.error("Fiefdom: Invalid fief config - missing 'id'");
				continue;
			}

			if (!fief.paths || !Array.isArray(fief.paths)) {
				console.error(`Fiefdom: Invalid fief '${fief.id}' - missing 'paths' array`);
				continue;
			}

			fiefs.push({
				id: fief.id,
				paths: fief.paths,
				persona: fief.persona ?? `.pi/fiefs/${fief.id}/AGENT.md`,
				memory: fief.memory ?? `.pi/fiefs/${fief.id}/memory/`,
			});
		}

		if (fiefs.length === 0) {
			console.error("Fiefdom: No valid fiefs configured");
			return null;
		}

		return {
			fiefs,
			_loadedFrom: configPath,
			_configRoot: path.dirname(path.dirname(configPath)), // Parent of .pi directory
		};
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			// No config file - fiefdom inactive
			return null;
		}
		console.error("Fiefdom: Error loading config:", err);
		return null;
	}
}

/**
 * Check if a path matches any of a fief's allowed patterns
 */
export function pathMatchesFief(targetPath: string, fiefPaths: string[]): boolean {
	// Normalize path (remove leading ./ and ensure no leading /)
	const normalizedTarget = targetPath.replace(/^\.\//, "").replace(/^\//, "");

	for (const pattern of fiefPaths) {
		const normalizedPattern = pattern.replace(/^\.\//, "").replace(/^\//, "");

		if (minimatch(normalizedTarget, normalizedPattern, { dot: true })) {
			return true;
		}

		// Also check if the target is a parent directory of the pattern
		// e.g., "frontend" should match "frontend/**"
		const basePattern = normalizedPattern.replace(/\/\*\*$/, "");
		if (normalizedTarget === basePattern || normalizedTarget.startsWith(basePattern + "/")) {
			return true;
		}
	}

	return false;
}

/**
 * Find which fief owns a given path
 */
export function findFiefForPath(
	targetPath: string,
	config: FiefdomConfig
): FiefConfig | null {
	for (const fief of config.fiefs) {
		if (pathMatchesFief(targetPath, fief.paths)) {
			return fief;
		}
	}
	return null;
}

/**
 * Check if a path is unassigned (not covered by any fief)
 */
export function isUnassignedPath(
	targetPath: string,
	config: FiefdomConfig
): boolean {
	return findFiefForPath(targetPath, config) === null;
}
