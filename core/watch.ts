/**
 * Detecting writes instead of predicting them.
 *
 * The PreToolUse guard reads a command and decides. That works for the idioms
 * agents actually use, and fails for anything it cannot parse: `python -c`, a
 * path built from a variable, a codegen script that writes wherever it likes.
 *
 * This closes that gap from the other side. Snapshot the working tree before
 * the command, compare after, and report what actually changed — no parsing,
 * no guessing about intent.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface Snapshot {
	/** When the snapshot was taken; anything written later has a newer mtime */
	time: number;
	/** repo-relative path -> "<size>:<mtime>", or "missing" */
	entries: Record<string, string>;
}

const MISSING = "missing";

/**
 * The state on disk of everything git considers dirty.
 *
 * Deliberately records size and mtime and *not* the git status code. Staging
 * and committing change a file's status while leaving its content untouched,
 * and reporting those as writes is worse than useless: it accuses an agent of
 * a boundary crossing for `git add`, and any advice to undo it endangers real
 * work.
 */
export function snapshot(repoRoot: string): Snapshot | null {
	let porcelain: string;
	try {
		porcelain = execFileSync("git", ["status", "--porcelain", "-z", "--untracked-files=all"], {
			cwd: repoRoot,
			encoding: "utf-8",
			maxBuffer: 64 * 1024 * 1024,
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return null;
	}

	const time = Date.now();
	const entries: Record<string, string> = {};

	// Porcelain -z records are "XY <path>\0", with renames adding a second path.
	const records = porcelain.split("\0").filter(Boolean);
	for (let i = 0; i < records.length; i++) {
		const record = records[i];
		const code = record.slice(0, 2);
		const file = record.slice(3);
		if (!file) continue;

		// A rename record is followed by its source path; skip it.
		if (code[0] === "R" || code[1] === "R") i++;

		entries[file] = stampOf(repoRoot, file);
	}

	return { time, entries };
}

function stampOf(repoRoot: string, file: string): string {
	try {
		const stat = fs.statSync(path.join(repoRoot, file));
		return `${stat.size}:${stat.mtimeMs}`;
	} catch {
		return MISSING;
	}
}

/**
 * Files whose *content* changed while the command ran.
 *
 * A file counts as written when it was there before and is gone now, or when
 * its mtime is at or after the moment the first snapshot was taken. Everything
 * else — restaging, committing, a file merely entering or leaving git's dirty
 * set — leaves the bytes on disk alone and is not reported.
 */
export function changedPaths(
	before: Snapshot,
	after: Snapshot,
	repoRoot: string
): string[] {
	const changed: string[] = [];
	const candidates = new Set([
		...Object.keys(before.entries),
		...Object.keys(after.entries),
	]);

	for (const file of candidates) {
		const wasThere = before.entries[file] && before.entries[file] !== MISSING;
		const now = after.entries[file] ?? stampOf(repoRoot, file);

		if (now === MISSING) {
			if (wasThere) changed.push(file); // deleted during the command
			continue;
		}

		const mtime = Number(now.split(":")[1]);
		if (Number.isFinite(mtime) && mtime >= before.time) changed.push(file);
	}

	return changed.sort();
}

// ---------------------------------------------------------------------------
// Snapshot storage
//
// Kept in the OS temp dir rather than the repo: it is per-tool-call scratch,
// and must never look like a file the repo owns.
// ---------------------------------------------------------------------------

function snapshotDir(sessionId: string): string {
	const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "session";
	return path.join(os.tmpdir(), "fiefdom-watch", safe);
}

function snapshotPath(sessionId: string, toolUseId: string): string {
	const safe = toolUseId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 96) || "tool";
	return path.join(snapshotDir(sessionId), `${safe}.json`);
}

export function saveSnapshot(
	sessionId: string,
	toolUseId: string,
	snap: Snapshot
): void {
	try {
		const file = snapshotPath(sessionId, toolUseId);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify(snap), "utf-8");
		pruneOldSnapshots(snapshotDir(sessionId));
	} catch {
		// Losing a snapshot only costs us one detection; never fail the tool call.
	}
}

export function loadSnapshot(sessionId: string, toolUseId: string): Snapshot | null {
	try {
		const file = snapshotPath(sessionId, toolUseId);
		const snap = JSON.parse(fs.readFileSync(file, "utf-8")) as Snapshot;
		fs.rmSync(file, { force: true });
		return snap;
	} catch {
		return null;
	}
}

/** Drop snapshots older than an hour, so a long session cannot accumulate them. */
function pruneOldSnapshots(dir: string): void {
	const cutoff = Date.now() - 60 * 60 * 1000;
	try {
		for (const entry of fs.readdirSync(dir)) {
			const file = path.join(dir, entry);
			if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
		}
	} catch {
		// Nothing to prune.
	}
}
