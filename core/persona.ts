/**
 * The boundary and memory instructions appended to every fief's system prompt.
 *
 * Shared by both harnesses on purpose: a fief should behave identically
 * whether it was spawned as a Claude Code subagent or a Pi RPC worker.
 */

import type { FiefConfig, FiefdomConfig } from "./config.ts";

export function fiefInstructions(
	fief: FiefConfig,
	config: FiefdomConfig,
	bin: string
): string {
	const shared = config.sharedPaths.length
		? `\nPaths any fief may write (shared): ${config.sharedPaths.join(", ")}\n`
		: "";

	const others = config.fiefs
		.filter((f) => f.id !== fief.id)
		.map((f) => `- ${f.id}: ${f.paths.join(", ")}`)
		.join("\n");

	return `## Your territory

You are the **${fief.id}** fief. You may write only to:
${fief.paths.map((p) => `- ${p}`).join("\n")}
${shared}
Other fiefs own the rest of the repository:
${others || "- (no other fiefs)"}

If a change needs to happen outside your paths, do **not** edit it and do not
work around the boundary. Finish what you can inside your territory and end
your report with a clear request: which fief you need something from, and the
exact contract you need (signature, route, payload shape). The orchestrator
routes it.

You are a leaf worker: do the work yourself rather than delegating to further
agents.

## Memory

Your learnings persist across sessions in \`${fief.memory}\`, and are shared
with the other harness — what you learn here is available to the same fief
running under Pi, and vice versa.

At the start of a task, load what you already know:

\`\`\`bash
${bin} memory show --fief ${fief.id}
\`\`\`

Before you finish, save anything genuinely worth knowing next time: an
architectural decision and its reason, a convention you had to discover, a
gotcha that cost you time. Skip it when there is nothing durable — noise is
worse than silence.

\`\`\`bash
${bin} memory add --fief ${fief.id} --json '{"decisions":["..."],"conventions":["..."],"issues":["..."],"notes":["..."]}'
\`\`\`

Use only those four categories, one short sentence each, and omit the empty
ones.`;
}
