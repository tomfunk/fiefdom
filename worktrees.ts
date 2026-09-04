/**
 * Git worktree management for fief isolation
 *
 * Creates a worktree per fief to provide filesystem-level isolation.
 * This is the second layer of defense - even if tool-call interception
 * fails, the fief agent physically cannot write outside its worktree.
 */

import { exec as execCallback } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { FiefConfig } from "./config.ts";

const exec = promisify(execCallback);

const WORKTREES_DIR = ".pi/worktrees";

/**
 * Check if we're in a git repository
 */
async function isGitRepo(cwd: string): Promise<boolean> {
	try {
		await exec("git rev-parse --git-dir", { cwd });
		return true;
	} catch {
		return false;
	}
}

/**
 * Get the current branch name
 */
async function getCurrentBranch(cwd: string): Promise<string> {
	const { stdout } = await exec("git branch --show-current", { cwd });
	return stdout.trim() || "HEAD";
}

/**
 * Create worktrees for each fief
 *
 * Each worktree is a full checkout of the repo, but the fief agent
 * runs with cwd set to its worktree. Combined with tool restrictions,
 * this provides defense in depth.
 */
export async function ensureWorktrees(
	repoRoot: string,
	fiefs: FiefConfig[]
): Promise<string> {
	// Check if git repo
	const isRepo = await isGitRepo(repoRoot);
	if (!isRepo) {
		throw new Error("Not a git repository - worktree isolation requires git");
	}

	const worktreesDir = path.join(repoRoot, WORKTREES_DIR);

	// Create worktrees directory
	await fs.promises.mkdir(worktreesDir, { recursive: true });

	const branch = await getCurrentBranch(repoRoot);

	for (const fief of fiefs) {
		const worktreePath = path.join(worktreesDir, fief.id);

		// Check if worktree already exists
		if (fs.existsSync(worktreePath)) {
			// Verify it's a valid worktree
			try {
				await exec(`git -C "${worktreePath}" rev-parse --git-dir`);
				// Update to current branch
				try {
					await exec(`git -C "${worktreePath}" checkout ${branch}`, {
						cwd: repoRoot,
					});
				} catch {
					// Branch might not exist in worktree, that's ok
				}
				continue;
			} catch {
				// Invalid worktree, remove and recreate
				await fs.promises.rm(worktreePath, { recursive: true, force: true });
			}
		}

		// Create new worktree
		// We use a detached checkout first to avoid branch conflicts
		try {
			await exec(
				`git worktree add --detach "${worktreePath}" ${branch}`,
				{ cwd: repoRoot }
			);
		} catch (err) {
			// Try with HEAD if branch fails
			try {
				await exec(`git worktree add --detach "${worktreePath}" HEAD`, {
					cwd: repoRoot,
				});
			} catch (err2) {
				throw new Error(
					`Failed to create worktree for ${fief.id}: ${err2}`
				);
			}
		}
	}

	return worktreesDir;
}

/**
 * Remove all fiefdom worktrees
 */
export async function cleanupWorktrees(
	repoRoot: string,
	worktreesDir: string
): Promise<void> {
	const isRepo = await isGitRepo(repoRoot);
	if (!isRepo) return;

	// List existing worktrees
	try {
		const { stdout } = await exec("git worktree list --porcelain", {
			cwd: repoRoot,
		});

		// Parse worktree list and remove ones in our directory
		const lines = stdout.split("\n");
		for (const line of lines) {
			if (line.startsWith("worktree ")) {
				const worktreePath = line.slice("worktree ".length);
				if (worktreePath.startsWith(worktreesDir)) {
					try {
						await exec(`git worktree remove --force "${worktreePath}"`, {
							cwd: repoRoot,
						});
					} catch {
						// Force remove directory if git command fails
						await fs.promises.rm(worktreePath, {
							recursive: true,
							force: true,
						});
					}
				}
			}
		}
	} catch {
		// Fallback: just remove the directory
		await fs.promises.rm(worktreesDir, { recursive: true, force: true });
	}

	// Prune stale worktree references
	try {
		await exec("git worktree prune", { cwd: repoRoot });
	} catch {
		// Ignore prune errors
	}
}

/**
 * Sync changes from main repo to all worktrees
 */
export async function syncWorktrees(
	repoRoot: string,
	worktreesDir: string
): Promise<void> {
	const entries = await fs.promises.readdir(worktreesDir, {
		withFileTypes: true,
	});

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;

		const worktreePath = path.join(worktreesDir, entry.name);

		try {
			// Fetch and reset to match main repo
			const branch = await getCurrentBranch(repoRoot);
			await exec(`git fetch origin ${branch}`, { cwd: worktreePath });
			await exec(`git reset --hard origin/${branch}`, { cwd: worktreePath });
		} catch {
			// Sync failure is not critical
			console.error(`Failed to sync worktree: ${worktreePath}`);
		}
	}
}
