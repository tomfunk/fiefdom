/**
 * Ownership coverage over the files git actually tracks.
 *
 * Directory-level guessing is not enough to answer the question that matters:
 * does every file in this repository have exactly one owner? Files with none
 * and files with several are both worth surfacing — they are usually telling
 * you something about how the repository is organised.
 */

import { execFileSync } from "node:child_process";
import { type FiefConfig, type FiefdomConfig, pathMatchesFief } from "./config.ts";

export interface Coverage {
	/** Total tracked files considered */
	total: number;
	/** How many files each fief owns, by fief id */
	owned: Map<string, number>;
	/** Files no fief claims */
	unowned: string[];
	/** Files claimed by more than one fief, with the claimants */
	contested: Array<{ path: string; fiefs: string[] }>;
	/** Files only covered by sharedPaths */
	shared: string[];
	/** False when git could not list files (coverage is then unknown) */
	available: boolean;
}

function trackedFiles(repoRoot: string): string[] | null {
	try {
		const stdout = execFileSync("git", ["ls-files", "-z"], {
			cwd: repoRoot,
			encoding: "utf-8",
			maxBuffer: 64 * 1024 * 1024,
			stdio: ["ignore", "pipe", "ignore"],
		});
		return stdout.split("\0").filter(Boolean);
	} catch {
		return null;
	}
}

export function computeCoverage(config: FiefdomConfig): Coverage {
	const files = trackedFiles(config.paths.repoRoot);

	const coverage: Coverage = {
		total: 0,
		// Every holder counts, baronies included — their land is scattered, not absent.
		owned: new Map(config.fiefs.map((f) => [f.id, 0])),
		unowned: [],
		contested: [],
		shared: [],
		available: files !== null,
	};

	if (!files) return coverage;

	coverage.total = files.length;

	for (const file of files) {
		const claimants: FiefConfig[] = config.fiefs.filter((fief) =>
			pathMatchesFief(file, fief.paths)
		);

		if (claimants.length === 1) {
			const id = claimants[0].id;
			coverage.owned.set(id, (coverage.owned.get(id) ?? 0) + 1);
			continue;
		}

		if (claimants.length > 1) {
			for (const fief of claimants) {
				coverage.owned.set(fief.id, (coverage.owned.get(fief.id) ?? 0) + 1);
			}
			coverage.contested.push({ path: file, fiefs: claimants.map((f) => f.id) });
			continue;
		}

		if (config.sharedPaths.length && pathMatchesFief(file, config.sharedPaths)) {
			coverage.shared.push(file);
			continue;
		}

		coverage.unowned.push(file);
	}

	return coverage;
}

/**
 * Group paths by their top-level directory, so a report can say
 * "docs/ (22 files)" instead of listing every one.
 */
export function groupByTopLevel(paths: string[]): Array<{ group: string; count: number }> {
	const groups = new Map<string, number>();

	for (const p of paths) {
		const slash = p.indexOf("/");
		const group = slash === -1 ? p : p.slice(0, slash) + "/";
		groups.set(group, (groups.get(group) ?? 0) + 1);
	}

	return [...groups]
		.map(([group, count]) => ({ group, count }))
		.sort((a, b) => b.count - a.count || a.group.localeCompare(b.group));
}
