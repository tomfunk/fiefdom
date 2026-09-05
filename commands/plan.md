---
description: Plan a change across fiefs before any of them writes code
argument-hint: what you want to build
allowed-tools: Bash(fiefdom status:*), Bash(fiefdom owner:*), Bash(fiefdom memory show:*), Bash(fiefdom log:*), Read, Grep, Glob, Agent
---

Plan this change across the fiefs: $ARGUMENTS

Do not let anyone write code yet. The point is to settle the contracts first,
so each fief can then work alone instead of discovering the interface halfway
through.

1. Work out which fiefs the change touches. `fiefdom status` lists them and
   `fiefdom owner <path>` resolves any specific file.
2. Ask each affected fief what it would need, marking the request clearly as a
   planning query: they should answer with what they would change, what they
   need from others (exact signatures, routes, payload shapes) and what they
   are unsure about — and change nothing.
3. Consult the barons now rather than later. They hold what earlier sessions
   learned about their concern, and a gap named before the work is far cheaper
   than one found after it.
4. Reconcile the answers yourself. Where two fiefs disagree about an interface,
   decide it — that is the orchestrator's job, and leaving it open guarantees
   rework. Record cross-fief agreements with
   `fiefdom log --from <fief> --to <fief> --message "..."`.
5. Present the plan: the agreed contracts, then one task per fief in dependency
   order, each naming the interface it can rely on. Ask before executing.

If the plan turns out to need one fief to wait on another for most of its work,
say so — that usually means the change is really one piece of work sitting
across a boundary, which is worth knowing before you split it in two.
