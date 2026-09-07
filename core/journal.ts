/**
 * A holder's working journal: what it has done so far on this task.
 *
 * An agent that dies mid-task — rate limited, cancelled, crashed — leaves its
 * edits on disk and takes everything else with it. The files are still there;
 * what is lost is the account of them. Nobody knows what was finished, what was
 * half-done, or what the plan was.
 *
 * Memory is the wrong place for this: memory is durable knowledge, written at
 * the end, and an interrupted agent never reaches the end. The journal is the
 * opposite — cheap, written as you go, and cleared when the task completes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { type FiefConfig, type FiefdomConfig, memoryPathOf } from "./config.ts";

export interface JournalEntry {
	at: string;
	note: string;
	/** The agent that wrote it, when known — a holder or one of its serfs */
	by?: string;
}

/** Journal lives beside the fief's memory, and is equally local. */
function journalPath(config: FiefdomConfig, fief: FiefConfig): string {
	return path.join(path.dirname(memoryPathOf(config, fief)), "journal.jsonl");
}

export function appendJournal(
	config: FiefdomConfig,
	fief: FiefConfig,
	note: string,
	by?: string
): void {
	const entry: JournalEntry = { at: new Date().toISOString(), note, by };
	const file = journalPath(config, fief);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf-8");
}

export function readJournal(config: FiefdomConfig, fief: FiefConfig): JournalEntry[] {
	try {
		return fs
			.readFileSync(journalPath(config, fief), "utf-8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as JournalEntry);
	} catch {
		return [];
	}
}

/** Called when a task finishes cleanly; the trail has served its purpose. */
export function clearJournal(config: FiefdomConfig, fief: FiefConfig): void {
	try {
		fs.rmSync(journalPath(config, fief), { force: true });
	} catch {
		// Nothing to clear.
	}
}
