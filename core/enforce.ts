/**
 * The write-boundary decision, shared by both harnesses.
 *
 * Claude Code reaches it from the `PreToolUse` hook (which knows the acting
 * subagent from the payload); Pi reaches it from the in-process `tool_call`
 * handler (a fief worker is its own process and knows its own identity). Either
 * way the question is the same — may *this holder* write *these paths*? — so the
 * answer lives here once, rather than drifting between two copies.
 *
 * The caller resolves who the holder is and what it is trying to write; this
 * only judges. Whoever is not a holder at all (the liege, an unknown subagent)
 * is handled by the caller, since that story differs per harness.
 */

import {
	type FiefConfig,
	type FiefdomConfig,
	findFiefForPath,
	pathMatchesFief,
} from "./config.ts";

/** One thing a tool call would write, as a repo-relative path. */
export interface WriteTarget {
	relative: string;
	/** How it is written — the tool name, or the shell fragment that does it. */
	reason: string;
}

export type WriteDecision = { allow: true } | { allow: false; reason: string };

export interface DecideOptions {
	/**
	 * A narrower grant this holder is working under (a Claude Code serf). When
	 * it belongs to this fief, the grant's paths replace the fief's own — the
	 * task was carved smaller than the whole holding.
	 */
	grant?: { fief: string; paths: string[] } | null;
	/** The write goes through the shell, so say so in any denial. */
	viaShell?: boolean;
}

/**
 * Decide whether `fief` may make the given writes. The fief must already be
 * known to hold land in this config; a holder that owns no path advises rather
 * than writes, which is itself a denial.
 */
export function decideFiefWrite(
	config: FiefdomConfig,
	fief: FiefConfig,
	targets: WriteTarget[],
	opts: DecideOptions = {}
): WriteDecision {
	const { grant = null, viaShell = false } = opts;

	if (fief.paths.length === 0) {
		return {
			allow: false,
			reason:
				`Fiefdom: ${fief.id} holds no land, so it advises rather than writes.\n` +
				`Report the finding instead: name the file, the gap and the fief that owns it, ` +
				`and the orchestrator will route the change.`,
		};
	}

	// Orchestrator mode polices only the liege; holders write unchecked.
	if (config.enforcement === "orchestrator") return { allow: true };

	const held = grant && grant.fief === fief.id ? grant.paths : fief.paths;

	const trespass = targets.find(
		({ relative }) =>
			!pathMatchesFief(relative, held) &&
			!(config.sharedPaths.length && pathMatchesFief(relative, config.sharedPaths))
	);
	if (!trespass) return { allow: true };

	const { relative, reason } = trespass;
	const owner = findFiefForPath(relative, config);

	if (grant && grant.fief === fief.id) {
		return {
			allow: false,
			reason:
				`Fiefdom: ${relative} is outside your grant (${grant.paths.join(", ")}).\n` +
				(viaShell ? `That command writes it (${reason}).\n` : "") +
				`It may still be ${fief.id} land, but this task was carved narrower than the fief. ` +
				`Report what else needs changing and let the holder decide — it is coordinating ` +
				`the whole piece of work and you are seeing one part of it.`,
		};
	}

	return {
		allow: false,
		reason:
			`Fiefdom: ${relative} is outside the ${fief.id} fief (${fief.paths.join(", ")}).\n` +
			(viaShell ? `That command writes it (${reason}); the shell is not a way around the boundary.\n` : "") +
			(owner
				? `It belongs to the ${owner.id} fief. Do not edit it. Finish your own part, then state exactly what you need from ${owner.id} — the orchestrator will route it.`
				: `No fief owns it. Do not edit it. Report what you need and let the orchestrator decide where it belongs.`),
	};
}

// ponytail: self-check for the shared boundary decision. Run with
//   node --experimental-strip-types core/enforce.ts
if (import.meta.main) {
	const assert = (await import("node:assert")).strict;
	const front: FiefConfig = { id: "front", role: "vassal", paths: ["frontend/**"], persona: "", memory: "" };
	const back: FiefConfig = { id: "back", role: "vassal", paths: ["backend/**"], persona: "", memory: "" };
	const advisor: FiefConfig = { id: "wise", role: "baron", paths: [], persona: "", memory: "" };
	const cfg = (enforcement: FiefdomConfig["enforcement"], sharedPaths: string[] = []): FiefdomConfig => ({
		fiefs: [front, back, advisor],
		enforcement,
		sharedPaths,
		paths: {} as FiefdomConfig["paths"],
	});
	const t = (relative: string): WriteTarget => ({ relative, reason: "write" });

	assert.equal(decideFiefWrite(cfg("strict"), front, [t("frontend/App.tsx")]).allow, true, "own land allowed");
	assert.equal(decideFiefWrite(cfg("strict"), front, [t("backend/db.ts")]).allow, false, "trespass blocked");
	assert.equal(decideFiefWrite(cfg("strict", ["package.json"]), front, [t("package.json")]).allow, true, "shared path allowed");
	assert.equal(decideFiefWrite(cfg("orchestrator"), front, [t("backend/db.ts")]).allow, true, "orchestrator mode lets holders roam");
	assert.equal(decideFiefWrite(cfg("strict"), advisor, [t("frontend/App.tsx")]).allow, false, "landless holder only advises");
	assert.equal(
		decideFiefWrite(cfg("strict"), front, [t("frontend/deep/x.ts")], { grant: { fief: "front", paths: ["frontend/shallow/**"] } }).allow,
		false,
		"grant narrows below the fief"
	);
	console.log("enforce.ts self-check passed");
}
