/**
 * Persistent memory for fief agents
 *
 * Each fief maintains its own memory directory with:
 * - decisions.jsonl - Architectural/design decisions
 * - conventions.jsonl - Code conventions and patterns
 * - issues.jsonl - Known issues and gotchas
 * - notes.jsonl - General learnings
 *
 * Memory is local-only (not committed to git) and automatically
 * extracted from agent work via reflection prompts.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface MemoryEntry {
	category: string;
	content: string;
	timestamp: string;
	source: "agent" | "human";
	metadata?: Record<string, unknown>;
}

/**
 * `practice` is about how the work goes rather than what the code is: which
 * parts of this land split cleanly across serfs, what always ripples into
 * another fief, how long a kind of change actually takes. A holder that
 * remembers this grants better next time.
 */
export const VALID_CATEGORIES = [
	"decisions",
	"conventions",
	"practice",
	"issues",
	"notes",
];
const MAX_ENTRIES_PER_CATEGORY = 50; // Keep it lean
const MAX_CONTENT_LENGTH = 500; // Truncate long entries

export const NO_LEARNINGS = "(No prior learnings)";

/**
 * Manages persistent memory for a single fief
 */
export class FiefMemory {
	private memoryDir: string;
	private entries: Map<string, MemoryEntry[]> = new Map();
	private loaded = false;

	constructor(memoryDir: string) {
		this.memoryDir = memoryDir;
	}

	/**
	 * Ensure memory directory exists and load existing entries
	 */
	private ensureLoaded(): void {
		if (this.loaded) return;

		// Create directory if needed
		if (!fs.existsSync(this.memoryDir)) {
			fs.mkdirSync(this.memoryDir, { recursive: true });
		}

		// Load existing entries
		for (const category of VALID_CATEGORIES) {
			this.entries.set(category, []);
			const filePath = path.join(this.memoryDir, `${category}.jsonl`);

			if (fs.existsSync(filePath)) {
				try {
					const content = fs.readFileSync(filePath, "utf-8");
					const lines = content.split("\n").filter((l) => l.trim());

					for (const line of lines) {
						try {
							const entry = JSON.parse(line) as MemoryEntry;
							this.entries.get(category)!.push(entry);
						} catch {
							// Skip invalid lines
						}
					}
				} catch {
					// Ignore read errors
				}
			}
		}

		this.loaded = true;
	}

	/**
	 * Add a new memory entry
	 */
	addEntry(entry: MemoryEntry): void {
		this.ensureLoaded();

		// Normalize category
		const category = entry.category.toLowerCase();
		const normalizedCategory = VALID_CATEGORIES.includes(category)
			? category
			: "notes";

		// Get or create category list
		let categoryEntries = this.entries.get(normalizedCategory);
		if (!categoryEntries) {
			categoryEntries = [];
			this.entries.set(normalizedCategory, categoryEntries);
		}

		// Check for duplicate content (within last 10 entries)
		const recent = categoryEntries.slice(-10);
		const isDuplicate = recent.some(
			(e) =>
				e.content.toLowerCase().trim() ===
				entry.content.toLowerCase().trim()
		);

		if (isDuplicate) {
			return; // Skip duplicate
		}

		// Truncate long content
		const truncatedContent = entry.content.length > MAX_CONTENT_LENGTH
			? entry.content.slice(0, MAX_CONTENT_LENGTH) + "..."
			: entry.content;

		// Add entry
		categoryEntries.push({
			...entry,
			content: truncatedContent,
			category: normalizedCategory,
		});

		// Trim to max entries
		if (categoryEntries.length > MAX_ENTRIES_PER_CATEGORY) {
			categoryEntries.shift();
		}

		// Persist
		this.saveCategory(normalizedCategory);
	}

	/**
	 * Add a batch of learnings keyed by category, e.g.
	 * `{ conventions: ["..."], issues: ["..."] }`. Returns how many were kept
	 * after dedupe/validation.
	 */
	addLearnings(
		learnings: Record<string, unknown>,
		source: MemoryEntry["source"] = "agent"
	): number {
		const before = this.getEntryCount();
		const timestamp = new Date().toISOString();

		for (const [category, items] of Object.entries(learnings)) {
			const list = Array.isArray(items) ? items : [items];
			for (const content of list) {
				if (typeof content !== "string" || !content.trim()) continue;
				this.addEntry({
					category,
					content: content.trim(),
					timestamp,
					source,
				});
			}
		}

		return this.getEntryCount() - before;
	}

	/**
	 * Get entries, optionally filtered by category
	 */
	getEntries(category?: string): MemoryEntry[] {
		this.ensureLoaded();

		if (category) {
			const normalizedCategory = category.toLowerCase();
			return [...(this.entries.get(normalizedCategory) || [])];
		}

		// Return all entries, sorted by timestamp
		const all: MemoryEntry[] = [];
		for (const entries of this.entries.values()) {
			all.push(...entries);
		}
		return all.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
	}

	/**
	 * Get total entry count
	 */
	getEntryCount(): number {
		this.ensureLoaded();
		let count = 0;
		for (const entries of this.entries.values()) {
			count += entries.length;
		}
		return count;
	}

	/**
	 * Get a summary of memory for context injection
	 * Prioritizes recent and high-value entries
	 */
	getContextSummary(): string {
		this.ensureLoaded();

		const sections: string[] = [];

		// Priority order: decisions > conventions > issues > notes
		const priorityOrder = ["decisions", "conventions", "practice", "issues", "notes"];
		let totalIncluded = 0;
		const maxTotal = 15; // Keep context lean

		for (const category of priorityOrder) {
			if (totalIncluded >= maxTotal) break;

			const entries = this.entries.get(category) || [];
			if (entries.length === 0) continue;

			// Get recent entries, but limit total
			const available = maxTotal - totalIncluded;
			const toTake = Math.min(entries.length, available, 5);
			const recent = entries.slice(-toTake);

			const summaryEntries = recent
				.map((e) => `- ${e.content}`)
				.join("\n");

			sections.push(
				`### ${category.charAt(0).toUpperCase() + category.slice(1)}\n${summaryEntries}`
			);
			totalIncluded += toTake;
		}

		return sections.length > 0 ? sections.join("\n\n") : NO_LEARNINGS;
	}

	/**
	 * Prune old entries to keep memory lean
	 * Called periodically to prevent bloat
	 */
	prune(): void {
		this.ensureLoaded();

		for (const category of VALID_CATEGORIES) {
			const entries = this.entries.get(category);
			if (!entries) continue;

			// Keep only the most recent entries
			if (entries.length > MAX_ENTRIES_PER_CATEGORY) {
				const pruned = entries.slice(-MAX_ENTRIES_PER_CATEGORY);
				this.entries.set(category, pruned);
				this.saveCategory(category);
			}
		}
	}

	/**
	 * Clear all memory for this fief
	 */
	clear(): void {
		this.loaded = false;
		this.entries.clear();

		if (fs.existsSync(this.memoryDir)) {
			for (const category of VALID_CATEGORIES) {
				const filePath = path.join(this.memoryDir, `${category}.jsonl`);
				try {
					fs.unlinkSync(filePath);
				} catch {
					// Ignore
				}
			}
		}
	}

	/**
	 * Save a category to disk
	 */
	private saveCategory(category: string): void {
		const entries = this.entries.get(category);
		if (!entries) return;

		const filePath = path.join(this.memoryDir, `${category}.jsonl`);
		const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";

		try {
			fs.writeFileSync(filePath, content, "utf-8");
		} catch (err) {
			console.error(`Failed to save memory for ${category}:`, err);
		}
	}
}

/**
 * Aggregate memory from multiple fiefs for orchestrator context
 */
export function aggregateFiefMemories(
	memories: Map<string, FiefMemory>
): string {
	const sections: string[] = [];

	for (const [fiefId, memory] of memories) {
		const summary = memory.getContextSummary();
		if (summary !== NO_LEARNINGS) {
			sections.push(`## ${fiefId} Fief Memory\n\n${summary}`);
		}
	}

	return sections.length > 0
		? sections.join("\n\n---\n\n")
		: "No fief memories recorded yet.";
}
