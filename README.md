# Fiefdom

Multi-agent workspace orchestration for **Claude Code** and **Pi**.

Fiefdom splits a repository into "fiefs" (frontend, backend, …), gives each one
a specialist agent that may only write inside its own territory, and keeps the
main session as a non-writing orchestrator that plans and routes.

One repo, either harness. Config, personas and accumulated memory live in
`.fiefdom/` and are shared, so a fief you taught something under Pi knows it
under Claude Code too.

```
                    ┌─────────────────────────────┐
                    │        Orchestrator         │
                    │  (your main session)        │
                    │  • no Write/Edit            │
                    │  • plans, routes, reconciles│
                    └───────┬─────────────┬───────┘
                            │             │
                 ┌──────────▼───┐   ┌─────▼────────┐
                 │ frontend fief│   │ backend fief │
                 │ frontend/**  │   │ backend/**   │
                 │ shared-ui/** │   │ services/**  │
                 └──────────────┘   └──────────────┘

  Claude Code: fiefs are subagents (.claude/agents/fief-*.md), boundaries
               enforced by a PreToolUse hook.
  Pi:          fiefs are persistent RPC worker processes, boundaries enforced
               in-process by each worker.
```

## Install

Fiefdom runs from a checkout — there is no build step, and both harnesses point
at the same one.

```bash
git clone https://github.com/tomfunk/fiefdom ~/projects/fiefdom
cd ~/projects/fiefdom
npm install                 # minimatch, the only runtime dependency
```

Requires Node 22.18+ (which runs TypeScript directly) or Bun.

**Keep the checkout where it is.** Generated hooks and personas reference it by
absolute path, so moving or deleting it breaks every repo you have set up. If
you do move it, re-run `fiefdom sync` in those repos.

### Claude Code

Nothing to install globally: `fiefdom init` writes everything a repo needs into
that repo. Optionally put the CLI on your PATH so you can type `fiefdom`
instead of the full node invocation:

```bash
npm link                    # provides `fiefdom`
```

Without it, generated files call a shim at `<repo>/.fiefdom/bin/fiefdom`, which
works the same way.

### Pi

Pi loads extensions from `~/.pi/agent/extensions/`, so symlink the checkout in
(the directory usually does not exist yet):

```bash
mkdir -p ~/.pi/agent/extensions
ln -s ~/projects/fiefdom ~/.pi/agent/extensions/fiefdom
```

`package.json` points Pi at `adapters/pi/index.ts`; nothing else is needed.

### Check it worked

```bash
cd ~/some/git/repo
fiefdom analyze             # proposes a division, writes nothing
```

For Pi, start a session in a git repo with no fiefs configured — the status
line should read `Fiefdom: Not configured. Use /fiefdom-setup to divide this
repo.` If it says nothing at all, the symlink is not being picked up.

## Quick start — Claude Code

From the repository you want to divide:

```bash
fiefdom init
```

That analyzes the repo, writes `.fiefdom/fiefs.json` plus a persona per fief,
and generates the Claude Code side:

| Generated | Purpose |
|---|---|
| `.claude/agents/fief-<id>.md` | one subagent per fief, with its persona, territory and memory instructions |
| `.claude/commands/fiefdom*.md` | `/fiefdom`, `/fiefdom-setup`, `/fiefdom-review` |
| `.claude/settings.local.json` | `PreToolUse` guard + `SessionStart` briefing hooks |
| `.gitignore` entries | all of the above stays local |

Restart Claude Code. The orchestrator gets a briefing at session start, and
routes work by spawning `fief-<id>` subagents (continuing them with
`SendMessage` so they keep their context). Its own `Write`/`Edit` calls are
denied with a message naming the fief that owns the file.

Prefer to be asked before anything is written? Run `/fiefdom-setup` instead of
`fiefdom init` — same result, but it walks you through the proposal first.

## Quick start — Pi

```
pi
/fiefdom-setup
```

Pi spawns one persistent worker per fief and removes `write`/`edit` from the
orchestrator. The tools `list_fiefs`, `route_ticket`, `query_fief`,
`request_from_fief`, `get_fief_memory` and `get_request_log` drive it.

Already configured a repo with either harness? The other one picks it up as-is
(run `fiefdom sync` after changing the config, so the generated Claude Code
files match).

## Layout

Everything is local-only and gitignored:

```
.fiefdom/
├── fiefs.json                    # config — the single source of truth
├── fiefs/
│   └── frontend/
│       ├── AGENT.md              # persona: the fief's system prompt
│       └── memory/
│           ├── decisions.jsonl
│           ├── conventions.jsonl
│           ├── issues.jsonl
│           └── notes.jsonl
├── bin/fiefdom                   # shim onto your fiefdom checkout
├── worktrees/                    # only when useWorktrees is on
└── cross-fief-requests.log
```

Repos set up by fiefdom 0.1 keep working from `.pi/`; `fiefdom migrate` moves
them to `.fiefdom/`.

## Configuration

```json
{
  "fiefs": [
    {
      "id": "frontend",
      "paths": ["frontend/**", "shared-ui/**"],
      "persona": ".fiefdom/fiefs/frontend/AGENT.md",
      "memory": ".fiefdom/fiefs/frontend/memory/",
      "description": "React app and shared components"
    }
  ],
  "useWorktrees": false,
  "enforcement": "strict",
  "sharedPaths": ["package-lock.json"]
}
```

| Field | Meaning |
|---|---|
| `paths` | globs the fief may write |
| `persona` | system prompt; edit this, not the generated agent file |
| `description` | used as the subagent's `description` (how Claude decides to delegate) |
| `useWorktrees` | give each fief its own git worktree (`isolation: worktree` in Claude Code) |
| `enforcement` | `strict` (default): only fiefs write, only inside their paths · `orchestrator`: only the orchestrator is blocked · `off` |
| `sharedPaths` | globs any fief may write — lockfiles, shared types |

After editing, run `fiefdom sync` and restart the session.

### Ownership is the point

Paths no fief owns are writable by nobody, and that is deliberate. A file that
cannot be owned is usually telling you something about the repository rather
than about your config: it serves several concerns at once, or sits on a
boundary nobody has decided. Prefer moving or splitting the code over widening
a fief, and treat `sharedPaths` as a note that a decision is still outstanding.

`fiefdom status` measures this exactly, over the files git tracks:

```
  coverage: 257/257 tracked files owned
```

It also reports **contested** files — claimed by two fiefs, where first match
silently wins — and groups anything unowned so you can see the shape of the
gap. Aim for full coverage with an empty `sharedPaths`; the files that resist
are the interesting ones.

## Memory

Fiefs accumulate learnings across sessions, in four categories: `decisions`,
`conventions`, `issues`, `notes`. Entries are deduped, truncated to 500
characters and capped at 50 per category.

The agent writes them itself, at the end of a task:

```bash
fiefdom memory add --fief frontend --json '{"conventions":["State lives in hooks, never in context"]}'
```

and reads them at the start of one:

```bash
fiefdom memory show --fief frontend
```

Both harnesses use the same files, so this is one shared body of knowledge per
fief. (Fiefdom 0.1 extracted memory with an extra reflection prompt after every
task; that added two messages to the worker's conversation each time and grew
its context without bound.)

## Enforcement

Two layers, and it is worth being precise about what each catches:

1. **Write guard.** In Claude Code, a `PreToolUse` hook on
   `Write|Edit|MultiEdit|NotebookEdit` reads the payload's `agent_type`: no
   fief identity means the orchestrator (or an unrelated subagent) and the
   write is denied; a `fief-<id>` agent is checked against that fief's globs.
   In Pi, each worker enforces the same rule in-process, and the orchestrator
   has its write tools removed.
2. **Worktrees** (optional). With `useWorktrees`, each fief works in its own
   checkout, so a fief cannot see, let alone corrupt, another's working tree.
   The guard understands both fiefdom's worktrees and the ones Claude Code
   creates for `isolation: worktree`.

The guard reads `Bash` as well as the file tools, because an agent working
through the shell edits with `sed -i` and heredocs rather than `Write`. It
extracts the paths a command clearly writes — redirections, `tee`, in-place
`sed`/`perl`, `cp`/`mv` destinations, `rm`, `touch`, `dd of=`, `patch` — and
applies the same ownership rule, following a leading `cd` so relative paths
mean what they say.

It only judges what it can read unambiguously. A path built from a variable, a
glob, or a write buried inside `python -c` is allowed through: a missed write
is a boundary the agent is trusted to respect anyway, while a false denial
blocks a build or a test run. `useWorktrees` is the answer if you want
containment that does not depend on reading commands.

Escape hatches: `FIEFDOM_DISABLE=1`, `"enforcement": "off"`, or a session in
`bypassPermissions` mode.

## CLI

```
fiefdom init [--worktrees] [--enforcement strict|orchestrator|off] [--force]
fiefdom sync                     Regenerate .claude/ files from the config
fiefdom status [--json]          Fiefs, file coverage, learnings, ownership gaps
fiefdom review                   Boundary review with suggestions
fiefdom analyze [--json]         Propose a division without writing anything
fiefdom owner <path>             Which fief owns a path (or shared/unassigned)
fiefdom migrate                  Move a legacy .pi/ layout to .fiefdom/

fiefdom memory show [--fief <id>] [--category <c>] [--full]
fiefdom memory add --fief <id> --json '{"decisions":["..."]}'
fiefdom memory clear --fief <id>

fiefdom log --from <fief> --to <fief> --message "..."
fiefdom log show [--limit 50]
```

## Repository layout

```
core/          harness-agnostic: config, paths, memory, analysis, persona text
adapters/pi/   Pi extension: RPC workers, worktrees
adapters/claude/  Claude Code adapter: CLI, generators, hooks
bin/fiefdom.ts entry point
```

Adding a third harness means writing one adapter; `core/` should not need to
know about it.

## Troubleshooting

**"Not a git repository"** — worktree isolation needs git; `git init` first.

**A fief agent won't start (Pi)** — check the persona file exists and is valid
markdown. Startup is bounded at 30s, after which the worker is killed rather
than left hanging.

**Claude Code isn't blocking writes** — hooks load at session start; restart
after `fiefdom sync`. Check `.claude/settings.local.json` contains the two
fiefdom hooks and that `.fiefdom/bin/fiefdom` is executable.

**Memory isn't persisting** — make sure `.fiefdom/fiefs/<id>/memory/` is
writable, and that the agent is calling `fiefdom memory add` (it is instructed
to, but a short task may legitimately have nothing worth saving).

**Pi eats all your RAM** — each fief is a full `pi` process (~115 MB idle,
more as its conversation grows), so N fiefs cost N processes. Keep the number
of fiefs to what the repo actually needs. Version 0.2 fixes the leaks that made
this much worse: workers no longer recurse into spawning their own fiefs,
shutdown no longer hangs on an already-dead child (which orphaned every
remaining worker), and settle-waiters are released when a child dies.

## Limitations

- One process per fief in Pi; one subagent per fief in Claude Code. Both cost
  real resources — divide a repo into the fiefs it needs, not the maximum.
- Cross-fief changes need coordination through the orchestrator by design.
- Shell writes bypass the guard (see Enforcement).
- Claude Code subagents live for the session; what persists across sessions is
  the fief's memory, not its conversation.
