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
	/** repo-relative path -> "<git status code>:<size>:<mtime ns>" */
	entries: Record<string, string>;
}

/**
 * State of everything git considers dirty: modified, added, untracked.
 *
 * Status alone is not enough — a file already modified before the command and
 * modified again during it keeps the same status — so each entry also carries
 * size and mtime.
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

		let stamp = "missing";
		try {
			const stat = fs.statSync(path.join(repoRoot, file));
			stamp = `${stat.size}:${stat.mtimeMs}`;
		} catch {
			// Deleted between status and stat.
		}
		entries[file] = `${code}:${stamp}`;
	}

	return { entries };
}

/** Paths that appeared or changed between two snapshots. */
export function changedPaths(before: Snapshot, after: Snapshot): string[] {
	const changed: string[] = [];

	for (const [file, state] of Object.entries(after.entries)) {
		if (before.entries[file] !== state) changed.push(file);
	}

	// A file that was dirty and is now clean changed too (reverted, committed,
	// deleted) — worth reporting when it belongs to someone else.
	for (const file of Object.keys(before.entries)) {
		if (!(file in after.entries)) changed.push(file);
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
