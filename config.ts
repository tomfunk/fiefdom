/**
 * Fiefdom configuration loading and path matching
 */

import * as fs from "node:fs";
import { minimatch } from "minimatch";

export interface FiefConfig {
	id: string;
	paths: string[];
	persona: string;
	memory: string;
}

export interface FiefdomConfig {
	fiefs: FiefConfig[];
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

		return { fiefs };
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
