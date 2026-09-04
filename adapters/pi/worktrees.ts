/**
 * Git worktree management for fief isolation
 *
 * Creates a worktree per fief to provide filesystem-level isolation. Combined
 * with the write guard, this is defence in depth: a fief agent that ignores
 * its instructions still cannot touch another fief's checkout.
 *
 * Worktrees live under the config root (`.fiefdom/worktrees/<id>`), so they are
 * shared with the Claude Code adapter's `isolation: worktree` agents.
 */

import { execFile as execFileCallback } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { FiefdomConfig } from "../../core/config.ts";

const execFile = promisify(execFileCallback);

async function git(args: string[], cwd: string): Promise<string> {
	const { stdout } = await execFile("git", args, { cwd });
	return stdout.trim();
}

async function isGitRepo(cwd: string): Promise<boolean> {
	try {
		await git(["rev-parse", "--git-dir"], cwd);
		return true;
	} catch {
		return false;
	}
}

async function getCurrentBranch(cwd: string): Promise<string> {
	try {
		return (await git(["branch", "--show-current"], cwd)) || "HEAD";
	} catch {
		return "HEAD";
	}
}

/** True when the working tree has uncommitted changes. */
async function isDirty(cwd: string): Promise<boolean> {
	try {
		return (await git(["status", "--porcelain"], cwd)).length > 0;
	} catch {
		return true; // Assume dirty rather than risk discarding work.
	}
}

/**
 * Create a worktree per fief. Returns the directory holding them.
 */
export async function ensureWorktrees(config: FiefdomConfig): Promise<string> {
	const repoRoot = config.paths.configRoot;

	if (!(await isGitRepo(repoRoot))) {
		throw new Error("Not a git repository - worktree isolation requires git");
	}

	const worktreesDir = config.paths.worktreesDir;
	await fs.promises.mkdir(worktreesDir, { recursive: true });

	const branch = await getCurrentBranch(repoRoot);

	for (const fief of config.fiefs) {
		const worktreePath = path.join(worktreesDir, fief.id);

		if (fs.existsSync(worktreePath)) {
			try {
				await git(["rev-parse", "--git-dir"], worktreePath);
				try {
					await git(["checkout", branch], worktreePath);
				} catch {
					// Branch might not exist in the worktree, that's ok
				}
				continue;
			} catch {
				// Not a valid worktree. Only clear it out if nothing would be lost.
				if (await isDirty(worktreePath)) {
					throw new Error(
						`${worktreePath} is not a valid worktree but has local changes. Move or remove it by hand.`
					);
				}
				await fs.promises.rm(worktreePath, { recursive: true, force: true });
			}
		}

		// Detached checkout so fiefs never fight over the same branch ref.
		try {
			await git(["worktree", "add", "--detach", worktreePath, branch], repoRoot);
		} catch {
			try {
				await git(["worktree", "add", "--detach", worktreePath, "HEAD"], repoRoot);
			} catch (err) {
				throw new Error(`Failed to create worktree for ${fief.id}: ${err}`);
			}
		}
	}

	return worktreesDir;
}

/**
 * Remove fiefdom's worktrees. Anything with uncommitted work is left in place —
 * a session ending is not a reason to throw away a fief's changes.
 */
export async function cleanupWorktrees(config: FiefdomConfig): Promise<void> {
	const repoRoot = config.paths.configRoot;
	const worktreesDir = config.paths.worktreesDir;

	if (!(await isGitRepo(repoRoot))) return;

	let listing = "";
	try {
		listing = await git(["worktree", "list", "--porcelain"], repoRoot);
	} catch {
		return;
	}

	for (const line of listing.split("\n")) {
		if (!line.startsWith("worktree ")) continue;

		const worktreePath = line.slice("worktree ".length).trim();
		if (!worktreePath.startsWith(worktreesDir)) continue;

		if (await isDirty(worktreePath)) {
			console.error(
				`Fiefdom: keeping ${worktreePath} — it has uncommitted changes. Remove it with \`git worktree remove\` once you have dealt with them.`
			);
			continue;
		}

		try {
			await git(["worktree", "remove", "--force", worktreePath], repoRoot);
		} catch {
			await fs.promises.rm(worktreePath, { recursive: true, force: true });
		}
	}

	try {
		await git(["worktree", "prune"], repoRoot);
	} catch {
		// Ignore prune errors
	}
}

/**
 * Bring each worktree up to date with the main checkout's HEAD.
 *
 * Refuses to touch a worktree with uncommitted changes: this used to be a
 * `git reset --hard origin/<branch>`, which would silently destroy whatever a
 * fief had not committed yet.
 */
export async function syncWorktrees(config: FiefdomConfig): Promise<void> {
	const repoRoot = config.paths.configRoot;
	const worktreesDir = config.paths.worktreesDir;

	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(worktreesDir, { withFileTypes: true });
	} catch {
		return;
	}

	const head = await git(["rev-parse", "HEAD"], repoRoot);

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const worktreePath = path.join(worktreesDir, entry.name);

		if (await isDirty(worktreePath)) {
			console.error(`Fiefdom: skipping sync of ${worktreePath} (uncommitted changes)`);
			continue;
		}

		try {
			await git(["checkout", "--detach", head], worktreePath);
		} catch {
			console.error(`Fiefdom: failed to sync worktree ${worktreePath}`);
		}
	}
}
