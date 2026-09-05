---
description: Review fief boundaries, activity and accumulated learnings
allowed-tools: Bash(fiefdom review:*), Bash(fiefdom status:*), Bash(fiefdom memory show:*), Read
---

Run `fiefdom review` and turn it into a short report:

- **Current fiefs** — paths, learning counts, and the most recent learnings
- **Ownership gaps** — paths no fief owns, plus anything in `sharedPaths`.
  Treat these as a signal about the repository rather than a config oversight:
  a file nobody can own usually serves several concerns at once. Say for each
  whether the honest fix is moving/splitting the code, giving it to an existing
  fief, or creating one — and only suggest `sharedPaths` when the decision
  genuinely has to wait.
- **Possible new fiefs** — where the repo has grown past its divisions
- **Drift** — fiefs whose recorded learnings suggest they keep reaching outside
  their own paths

Then propose concrete edits to `.fiefdom/fiefs.json`. Do not apply them
without the user's go-ahead; when they agree, edit the config and run
`fiefdom sync`.
