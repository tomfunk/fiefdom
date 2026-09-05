/**
 * Subinfeudation: a holder granting part of its own land to a serf.
 *
 * A grant is an ephemeral sub-fief. The holder carves out the files a serf
 * should work on, the serf claims the grant, and from then on that serf is
 * bound to those paths rather than to the whole fief.
 *
 * The binding problem is that grants are made per task while agent definitions
 * are static files. It is solved with the two things a hook is documented to
 * receive: the serf's `agent_id`, and the text of the command it runs. The
 * serf's first act is `fiefdom claim <id>`; the PreToolUse hook sees both at
 * once and records the pairing.
 *
 * A grant can only ever narrow. It is validated against the holder's own paths
 * when issued, and an unclaimed or unreadable grant leaves the serf with the
 * ordinary fief boundary — so every failure mode falls back to the wider,
 * already-safe rule rather than to no rule at all.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface Grant {
	id: string;
	/** The fief the granting holder holds */
	fief: string;
	/** Paths the serf may write — always a subset of the fief's */
	paths: string[];
	/** What the serf was asked to do, for the audit trail */
	task?: string;
	issued: string;
}

/**
 * The session id a grant is filed under.
 *
 * Hooks are handed it in their payload; the CLI, invoked from an agent's
 * shell, is not — so the hooks record it per repository and the CLI reads it
 * back. Without this the holder would file grants under one key and the guard
 * would look for them under another, and every grant would quietly fail to
 * narrow anything.
 */
function sessionMarkerPath(repoRoot: string): string {
	return path.join(
		os.tmpdir(),
		"fiefdom-session",
		`${sanitize(path.resolve(repoRoot).replace(/[/\\]/g, "_"))}.txt`
	);
}

export function rememberSession(repoRoot: string, sessionId: string): void {
	try {
		const file = sessionMarkerPath(repoRoot);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, sessionId, "utf-8");
	} catch {
		// Grants will fall back to the fief boundary.
	}
}

export function currentSession(repoRoot: string): string {
	if (process.env.CLAUDE_SESSION_ID) return process.env.CLAUDE_SESSION_ID;
	try {
		const recorded = fs.readFileSync(sessionMarkerPath(repoRoot), "utf-8").trim();
		if (recorded) return recorded;
	} catch {
		// Never recorded — a session that started before fiefdom was installed.
	}
	return "session";
}

function grantsDir(sessionId: string): string {
	const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "session";
	return path.join(os.tmpdir(), "fiefdom-grants", safe);
}

function grantPath(sessionId: string, grantId: string): string {
	return path.join(grantsDir(sessionId), `${sanitize(grantId)}.json`);
}

/** Where a claimed grant is recorded against the serf that claimed it. */
function bindingPath(sessionId: string, agentId: string): string {
	return path.join(grantsDir(sessionId), "bound", `${sanitize(agentId)}.json`);
}

function sanitize(value: string): string {
	return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 96) || "unknown";
}

export function issueGrant(
	sessionId: string,
	fief: string,
	paths: string[],
	task?: string
): Grant {
	const grant: Grant = {
		id: `grant-${crypto.randomBytes(4).toString("hex")}`,
		fief,
		paths,
		task,
		issued: new Date().toISOString(),
	};

	const file = grantPath(sessionId, grant.id);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(grant, null, 2), "utf-8");
	prune(grantsDir(sessionId));
	return grant;
}

export function readGrant(sessionId: string, grantId: string): Grant | null {
	try {
		return JSON.parse(fs.readFileSync(grantPath(sessionId, grantId), "utf-8")) as Grant;
	} catch {
		return null;
	}
}

/**
 * Record that a serf claimed a grant. Called from the hook, which is the only
 * place that knows both the agent's id and what it is running.
 */
export function bindGrant(sessionId: string, agentId: string, grant: Grant): void {
	try {
		const file = bindingPath(sessionId, agentId);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify(grant), "utf-8");
	} catch {
		// A lost binding costs narrowing, not safety.
	}
}

export function boundGrant(sessionId: string, agentId: string): Grant | null {
	try {
		return JSON.parse(fs.readFileSync(bindingPath(sessionId, agentId), "utf-8")) as Grant;
	} catch {
		return null;
	}
}

/** `fiefdom claim <id>` anywhere in a command, however the CLI is invoked. */
export function claimedGrantId(command: string): string | null {
	const match = command.match(/\bclaim\s+(grant-[0-9a-f]{8})\b/);
	return match ? match[1] : null;
}

/** Drop grants older than an hour so a long session cannot accumulate them. */
function prune(dir: string): void {
	const cutoff = Date.now() - 60 * 60 * 1000;
	for (const sub of [dir, path.join(dir, "bound")]) {
		try {
			for (const entry of fs.readdirSync(sub)) {
				const file = path.join(sub, entry);
				const stat = fs.statSync(file);
				if (stat.isFile() && stat.mtimeMs < cutoff) fs.rmSync(file, { force: true });
			}
		} catch {
			// Nothing to prune.
		}
	}
}
