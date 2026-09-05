---
description: Analyze this repo and configure (or reconfigure) fiefs
allowed-tools: Bash(fiefdom analyze:*), Bash(fiefdom init:*), Bash(fiefdom sync:*), Read, Write, Edit
---

Configure fiefdom for this repository.

1. Run `fiefdom analyze --json` to get the proposed division. It reports
   directories, detected frameworks, file counts and a confidence level.
2. Present the proposal to the user as a short list: fief id, paths, file
   count, why. Say plainly where the analyzer is guessing.
3. Ask the user to confirm or adjust before writing anything. Their edits win.
4. Write the agreed division to `.fiefdom/fiefs.json` (create the file
   if the analyzer's output needs changing; `fiefdom init` writes the
   analyzer's proposal verbatim and is the fast path when they accept it).
5. Write or refine each persona at `.fiefdom/fiefs/<id>/AGENT.md` — the
   persona is the fief's system prompt in both Claude Code and Pi, so make it
   about domain expertise and conventions, not about boundaries (fiefdom adds
   those).
6. Run `fiefdom sync` to regenerate the agent definitions and hooks.
7. Tell the user to restart the session (or `/reload`) so the new agents and
   the SessionStart context are picked up.

Existing memory is never deleted by setup — reconfiguring is safe.
