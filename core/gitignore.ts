/**
 * Fiefdom state is per-machine: config, personas, memory, worktrees and the
 * generated Claude Code files all stay local.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Ask git which of these directory names the repo already ignores. Build
 * output (`release/`, `out/`, `test-results/`) otherwise shows up as a
 * candidate fief with thousands of "files" in it.
 */
export function gitIgnoredNames(repoRoot: string, names: string[]): Set<string> {
	if (names.length === 0) return new Set();
	try {
		const stdout = execFileSync("git", ["check-ignore", "--stdin"], {
			cwd: repoRoot,
			input: names.map((n) => `${n}/`).join("\n"),
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "ignore"],
		});
		return new Set(
			stdout
				.split("\n")
				.map((line) => line.trim().replace(/\/$/, ""))
				.filter(Boolean)
		);
	} catch {
		// Exit code 1 simply means "nothing matched"; anything else means no git.
		return new Set();
	}
}

export function gitignoreEntries(stateDirName: string): string[] {
	return [
		`${stateDirName}/fiefs.json`,
		`${stateDirName}/fiefs/`,
		`${stateDirName}/worktrees/`,
		`${stateDirName}/bin/`,
		`${stateDirName}/cross-fief-requests.log`,
		".claude/agents/fief-*.md",
		".claude/agents/vassal-*.md",
		".claude/agents/baron-*.md",
		".claude/agents/serf-*.md",
		".claude/agents/wita-*.md",
		".claude/commands/fiefdom*.md",
	];
}

/**
 * A path that the pattern would match, for asking git whether the repo already
 * ignores it. `.claude/agents/fief-*.md` is covered by a plain `.claude/` rule,
 * and adding a redundant line to someone's .gitignore is just noise.
 */
function samplePath(pattern: string): string {
	return pattern.replace(/\/$/, "/probe").replace(/\*/g, "x");
}

function alreadyIgnored(repoRoot: string, patterns: string[]): Set<string> {
	if (patterns.length === 0) return new Set();
	try {
		const stdout = execFileSync("git", ["check-ignore", "--stdin"], {
			cwd: repoRoot,
			input: patterns.map(samplePath).join("\n"),
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "ignore"],
		});
		const ignoredSamples = new Set(stdout.split("\n").map((l) => l.trim()).filter(Boolean));
		return new Set(patterns.filter((p) => ignoredSamples.has(samplePath(p))));
	} catch {
		// Exit 1 means nothing matched; a real failure means no git. Either way,
		// fall back to adding the entries.
		return new Set();
	}
}

/** Append any missing fiefdom entries to the repo's .gitignore. */
export function ensureGitignore(repoRoot: string, stateDirName: string): void {
	const gitignorePath = path.join(repoRoot, ".gitignore");

	let content = "";
	try {
		content = fs.readFileSync(gitignorePath, "utf-8");
	} catch {
		// No .gitignore yet.
	}

	const existing = new Set(content.split("\n").map((line) => line.trim()));
	const covered = alreadyIgnored(repoRoot, gitignoreEntries(stateDirName));
	const missing = gitignoreEntries(stateDirName).filter(
		(line) => !existing.has(line) && !covered.has(line)
	);
	if (missing.length === 0) return;

	const prefix = content && !content.endsWith("\n") ? "\n" : "";
	fs.appendFileSync(
		gitignorePath,
		`${prefix}\n# Fiefdom (local-only, per-machine)\n${missing.join("\n")}\n`,
		"utf-8"
	);
}
