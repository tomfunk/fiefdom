/**
 * Fiefdom configuration loading and path matching.
 *
 * Harness-agnostic: the same `fiefs.json` drives both the Pi extension and the
 * Claude Code adapter.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { minimatch } from "minimatch";
import {
	type FiefdomPaths,
	defaultMemoryPath,
	defaultPersonaPath,
	resolvePaths,
} from "./paths.ts";

/**
 * A fief is land — an area of the codebase. Who holds it is a separate thing.
 *
 * - `vassal` holds one fief and works it, answering to the liege.
 * - `baron` holds land scattered across the fiefs rather than one block: the
 *   test files, say, which live inside everyone's territory. Historically a
 *   baron was a tenant-in-chief whose manors lay across many shires.
 *
 * Both are vassals of the liege; baron only says the holdings are dispersed.
 * A baron with no paths at all still works — it simply advises, since the
 * guard refuses a write to land nobody holds.
 */
export type Role = "vassal" | "baron";

export interface FiefConfig {
	id: string;
	role: Role;
	paths: string[];
	/** Persona file, relative to the repo root */
	persona: string;
	/** Memory directory, relative to the repo root */
	memory: string;
	/** Optional one-line summary, used in generated agent descriptions */
	description?: string;
}

/**
 * How hard write boundaries are enforced.
 *
 * - `strict`      only fief agents may write, and only inside their own paths
 * - `orchestrator` the orchestrator is read-only; fief writes are unchecked
 * - `off`         nothing is enforced (personas still describe the boundaries)
 */
export type Enforcement = "strict" | "orchestrator" | "off";

export interface FiefdomConfig {
	fiefs: FiefConfig[];
	enforcement: Enforcement;
	/** Globs any fief agent may write (lockfiles, shared types, ...) */
	sharedPaths: string[];
	/** Where this config was loaded from */
	paths: FiefdomPaths;
}

const VALID_ENFORCEMENT: Enforcement[] = ["strict", "orchestrator", "off"];

/**
 * Load configuration for a repository. Returns null when fiefdom is not
 * configured (no config file) or the config is unusable.
 */
export function loadConfig(repoRoot: string): FiefdomConfig | null {
	const paths = resolvePaths(repoRoot);
	return loadConfigFrom(paths);
}

export function loadConfigFrom(paths: FiefdomPaths): FiefdomConfig | null {
	let raw: any;
	try {
		raw = JSON.parse(fs.readFileSync(paths.configPath, "utf-8"));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		console.error("Fiefdom: Error loading config:", err);
		return null;
	}

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
		const landless = fief.role === "wita" || fief.role === "counsel";
		if (!landless && (!fief.paths || !Array.isArray(fief.paths))) {
			console.error(`Fiefdom: Invalid fief '${fief.id}' - missing 'paths' array`);
			continue;
		}
		// Earlier names for the landless adviser, kept loading.
		const legacyBaron = fief.role === "wita" || fief.role === "counsel";
		const role: Role = fief.role === "baron" || legacyBaron ? "baron" : "vassal";

		fiefs.push({
			id: fief.id,
			role,
			paths: legacyBaron ? [] : (fief.paths ?? []),
			persona: fief.persona ?? defaultPersonaPath(paths.stateDirName, fief.id),
			memory: fief.memory ?? defaultMemoryPath(paths.stateDirName, fief.id),
			description: typeof fief.description === "string" ? fief.description : undefined,
		});
	}

	if (fiefs.length === 0) {
		console.error("Fiefdom: No valid fiefs configured");
		return null;
	}

	const enforcement: Enforcement = VALID_ENFORCEMENT.includes(raw.enforcement)
		? raw.enforcement
		: "strict";

	return {
		fiefs,
		enforcement,
		sharedPaths: Array.isArray(raw.sharedPaths) ? raw.sharedPaths : [],
		paths,
	};
}

/** Serialize a config back to the on-disk shape (without derived fields). */
export function serializeConfig(config: {
	fiefs: FiefConfig[];
	enforcement?: Enforcement;
	sharedPaths?: string[];
}): string {
	return (
		JSON.stringify(
			{
				fiefs: config.fiefs.map((f) => ({
					id: f.id,
					...(f.role === "baron" ? { role: f.role } : {}),
					paths: f.paths,
					persona: f.persona,
					memory: f.memory,
					...(f.description ? { description: f.description } : {}),
				})),
				enforcement: config.enforcement ?? "strict",
				sharedPaths: config.sharedPaths ?? [],
			},
			null,
			2
		) + "\n"
	);
}

/** Absolute path to a fief's persona file. */
export function personaPathOf(config: FiefdomConfig, fief: FiefConfig): string {
	return path.join(config.paths.configRoot, fief.persona);
}

/** Absolute path to a fief's memory directory. */
export function memoryPathOf(config: FiefdomConfig, fief: FiefConfig): string {
	return path.join(config.paths.configRoot, fief.memory);
}

/** Fiefs held as one block, by a vassal. */
export function territories(config: FiefdomConfig): FiefConfig[] {
	return config.fiefs.filter((f) => f.role !== "baron");
}

/** Baronies: holdings scattered across the fiefs. */
export function baronies(config: FiefdomConfig): FiefConfig[] {
	return config.fiefs.filter((f) => f.role === "baron");
}

export function getFief(config: FiefdomConfig, id: string): FiefConfig | undefined {
	return config.fiefs.find((f) => f.id === id);
}

/**
 * Check if a path matches any of a set of glob patterns.
 * Paths are compared repo-relative with POSIX separators.
 */
export function pathMatchesFief(targetPath: string, fiefPaths: string[]): boolean {
	const normalizedTarget = normalizeRepoPath(targetPath);

	for (const pattern of fiefPaths) {
		const normalizedPattern = normalizeRepoPath(pattern);

		if (minimatch(normalizedTarget, normalizedPattern, { dot: true })) {
			return true;
		}

		// A bare directory also counts as inside the fief: "frontend" and
		// "frontend/a/b.ts" both belong to "frontend/**".
		const basePattern = normalizedPattern.replace(/\/\*\*$/, "");
		if (
			normalizedTarget === basePattern ||
			normalizedTarget.startsWith(basePattern + "/")
		) {
			return true;
		}
	}

	return false;
}

/** Find which fief owns a given path. */
export function findFiefForPath(
	targetPath: string,
	config: FiefdomConfig
): FiefConfig | null {
	for (const fief of config.fiefs) {
		if (pathMatchesFief(targetPath, fief.paths)) return fief;
	}
	return null;
}

/** True when no fief claims the path. */
export function isUnassignedPath(targetPath: string, config: FiefdomConfig): boolean {
	return findFiefForPath(targetPath, config) === null;
}

/**
 * Normalize a path for glob matching: repo-relative, POSIX separators, no
 * leading "./" or "/".
 */
export function normalizeRepoPath(target: string): string {
	return target
		.split(path.sep)
		.join("/")
		.replace(/^\.\//, "")
		.replace(/^\/+/, "");
}

/**
 * Make an absolute or relative path repo-relative. Returns null when the path
 * escapes the repository (fiefdom does not police files outside the repo).
 */
export function toRepoRelative(target: string, repoRoot: string, cwd?: string): string | null {
	const absolute = path.isAbsolute(target)
		? target
		: path.resolve(cwd ?? repoRoot, target);
	const relative = path.relative(repoRoot, absolute);
	if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
	return normalizeRepoPath(relative);
}
