# Fiefdom

Multi-agent workspace orchestration for **Claude Code** and **Pi**.

Fiefdom splits a repository into **fiefs** — areas of land. Each is held by a
**vassal** that may write only there, and your main session is the **liege**:
it grants work and receives results, but never works the land itself.

One repo, either harness. Config, personas and accumulated memory live in
`.fiefdom/` and are shared, so a fief you taught something under Pi knows it
under Claude Code too.

```
                        ┌───────────────────────┐
                        │        LIEGE          │
                        │  (your main session)  │
                        │  grants work, holds   │
                        │  no pen               │
                        └───┬───────────────┬───┘
                            │               │
              ┌─────────────▼──┐   ┌────────▼───────┐
              │ vassal-frontend│   │ vassal-backend │   ← hold one fief each
              │ frontend/**    │   │ backend/**     │
              │ shared-ui/**   │   │ services/**    │
              └───────┬────────┘   └────────────────┘
                      │
              ┌───────▼──────┐         ┌──────────────────┐
              │ serf-frontend│         │  baron-testing   │
              │ same land,   │         │  tests/helpers/**│  ← land scattered
              │ one task     │         │  vitest.config   │    through the fiefs
              └──────────────┘         └──────────────────┘
```

| | |
|---|---|
| **fief** | an area of the codebase — the land itself |
| **liege** | your main session: grants work, receives results, writes nothing |
| **vassal** | holds one fief and works it; keeps memory across sessions |
| **baron** | a holder whose land lies scattered through the fiefs |
| **serf** | a helper a holder puts on one narrow task, bound to the same land |

In Claude Code these are subagents (`.claude/agents/vassal-*.md`) with a
`PreToolUse` hook enforcing the boundaries. In Pi they are persistent RPC
worker processes enforcing the same rule in-process.

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
| `.claude/agents/vassal-<id>.md`, `baron-<id>.md`, `serf-<id>.md` | one subagent each, with its persona, land and memory instructions |
| `.claude/commands/fiefdom*.md` | `/fiefdom`, `/fiefdom-plan`, `/fiefdom-setup`, `/fiefdom-review` |
| `.claude/settings.local.json` | `PreToolUse` guard, `PostToolUse` detector, `SessionStart` briefing |
| `.gitignore` entries | all of the above stays local |

Restart Claude Code. The liege gets a briefing at session start and grants work
by spawning `vassal-<id>` subagents (continuing them with `SendMessage` so they
keep their context). Its own `Write`/`Edit` calls are denied with a message
naming the holder of that land.

Prefer to be asked before anything is written? Run `/fiefdom-setup` instead of
`fiefdom init` — same result, but it walks you through the proposal first.

## Quick start — Pi

```
pi
/fiefdom-setup
```

Pi spawns one persistent worker per fief and removes `write`/`edit` from the
liege. The tools `list_fiefs`, `route_ticket`, `query_fief`,
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
  "enforcement": "strict",
  "sharedPaths": ["package-lock.json"]
}
```

| Field | Meaning |
|---|---|
| `role` | `vassal` (default) or `baron` — see below |
| `paths` | globs the holder may write |
| `persona` | system prompt; edit this, not the generated agent file |
| `description` | used as the subagent's `description` (how Claude decides to delegate) |
| `enforcement` | `strict` (default): only holders write, only on their own land · `orchestrator`: only the liege is blocked · `off` |
| `sharedPaths` | globs any fief may write — lockfiles, shared types |

After editing, run `fiefdom sync` and restart the session.

### Baronies

Some concerns do not sit in one block of land. Test infrastructure lives inside
every fief; so might a design system, or a set of generated clients. A **baron**
holds exactly that: scattered holdings, held separately because whoever thinks
about the concern as a whole should hold the parts that shape it.

```json
{
  "id": "testing",
  "role": "baron",
  "paths": ["tests/helpers/**", "vitest.config.ts", "playwright.config.ts"],
  "description": "The shared test infrastructure, and the question of whether this repo is testable."
}
```

Historically a baron was a tenant-in-chief whose manors lay across many shires —
which is the shape here exactly. A baron is still a vassal of the liege; the
word only says the holdings are dispersed, and it implies no command over the
vassals whose land it sits inside.

How much a barony should hold is a real decision. Give the testing baron every
test file and no vassal can write its own tests — which makes untested work
impossible to sneak through, at the cost of routing most changes through two
holders. Give it only the harness and fixtures, and each vassal tests its own
land while the baron shapes how. Start narrow: widening a barony later is easy,
prising files back out of one is not.

A baron with no `paths` at all is legal and simply advises — every write it
attempts is refused, since it holds no land.

### Serfs, and ephemeral sub-fiefs

A holder facing a task that genuinely splits can spawn `serf-<id>`: a helper
bound to the same land, given one narrow job. `serf-core` is a role rather than
a headcount — none, one, or several at once. Serfs keep no memory (what is
worth remembering is the holder's to record) and cannot spawn serfs of their
own, so the tree is never more than two deep.

Running several at once wants something narrower than "all of core", because
two serfs editing one file will lose a change. So a holder can **subinfeudate**:
carve part of its own land into a grant and put a serf on that alone.

```bash
fiefdom grant --fief core --paths "core/sync.ts,core/plaid.ts" --task "retry on 429"
# Granted grant-5b232527: core/sync.ts, core/plaid.ts
#
# Put this line in the serf's prompt, before anything else:
#   Claim your grant first: `.fiefdom/bin/fiefdom claim grant-5b232527`
```

The serf claims it, and from then on holds those files alone — everything else
is refused it, including land its own holder may write. In that mode the holder
is a *mesne lord*: it holds from the liege, grants below, and coordinates
rather than typing.

The binding uses only what a hook is documented to receive. A grant is issued
by the holder, the serf's first act is to claim it, and the `PreToolUse` hook —
which sees the serf's `agent_id` and the text of the claim in the same payload —
records the pairing. Session ids are shared between hook and CLI through a
marker the hooks write, since an agent's shell is not told which session it is
in.

Every failure mode falls back to the wider rule rather than to none: a grant
that is never claimed, or cannot be read, leaves the serf with the ordinary
fief boundary. A grant can only narrow — it is checked against the holder's own
paths when issued, so nobody can grant land they do not hold.

The guard needs no new rules for any of this. It resolves land from the agent's
name, so `serf-core` gets core's boundary (or its grant, when it has one), and
anything it does not recognise — `general-purpose`, `Explore` — holds no land
and cannot write at all.

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

## Planning across fiefs

`/fiefdom-plan <what you want to build>` does the fan-out before anyone writes
code: work out which fiefs are affected, ask each what it would need and what
it needs *from* others, consult the barons while the design is still cheap to
change, then reconcile the contracts and hand each fief a task that already
names the interface it can rely on.

The planning queries are a convention, not an enforced mode — a fief asked to
plan could still write inside its own territory. What the boundary guarantees
is that it cannot pre-empt anyone else's.

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

Three layers, and it is worth being precise about what each one catches.

**1. File tools — decided exactly.** `Write`, `Edit`, `MultiEdit` and
`NotebookEdit` name their target in the hook payload, so the `PreToolUse` guard
checks it against the actor's paths and denies outright. In Claude Code the
actor comes from the payload's `agent_type`: no fief identity means the
liege (or an unrelated subagent), and it does not write at all. In Pi
each worker applies the same rule in-process.

**2. Shell commands — read, then decided.** An agent working through Bash edits
with `sed -i` and heredocs rather than `Write`, so the guard extracts the paths
a command clearly writes — redirections, `tee`, in-place `sed`/`perl`, `cp`/`mv`
destinations, `rm`, `touch`, `dd of=`, `patch` — following a leading `cd` so
relative paths resolve where the shell would put them. It judges only what it
can read unambiguously; a false denial breaks a build, which is worse than a
missed write.

**3. Anything else — detected afterwards.** Plenty of writes are invisible to
any parser: `python -c "open(...)"`, a path built from a variable, a glob, a
codegen script. So fiefdom snapshots the working tree before a shell command
and compares after (`git status` costs ~10ms), then tells the agent what
actually landed outside its territory:

```
Fiefdom: that command wrote outside the frontend fief:
  backend/generated.py (belongs to backend)
```

It compares content, not git status: staging and committing move a file
between states without touching a byte of it, and reporting those as writes
would accuse an agent of a boundary crossing for running `git add`. A file
counts as written only when it is gone, or when its mtime moved during the
command.

It reports rather than reverts, and says so explicitly — the change may have
been made on someone's behalf, and a blanket revert on a notice like this
destroys work. It arrives in the agent's own turn, while judging it is cheap.

Together: nothing gets through unnoticed, and the common cases never happen at
all. What this is *not* is a sandbox. It is built for an agent that respects
the division and occasionally forgets, not one working around it. Every write
is in git either way, so a crossed boundary is visible and revertible.

Escape hatches: `FIEFDOM_DISABLE=1`, `"enforcement": "off"`, or a session in
`bypassPermissions` mode.

## Running from a worktree

Fiefdom does not create checkouts of its own. Fiefs work where your session
works, and a session started inside a linked worktree finds the config in the
main checkout, so the same fiefs, personas and memory apply:

```bash
git worktree add ../myrepo-feature -b feature
cd ../myrepo-feature && claude        # same fiefs, no setup
```

Paths are matched against whichever checkout contains them, so a fief working
in a worktree is judged by the same globs as one in the main directory.

## CLI

```
fiefdom init [--enforcement strict|orchestrator|off] [--force]
fiefdom sync                     Regenerate .claude/ files from the config
fiefdom status [--json]          Fiefs, file coverage, learnings, ownership gaps
fiefdom review                   Boundary review with suggestions
fiefdom analyze [--json]         Propose a division without writing anything
fiefdom owner <path>             Which fief owns a path (or shared/unassigned)
fiefdom migrate                  Move a legacy .pi/ layout to .fiefdom/

fiefdom memory show [--fief <id>] [--category <c>] [--full]
fiefdom memory add --fief <id> --json '{"decisions":["..."]}'
fiefdom memory clear --fief <id>

fiefdom grant --fief <id> --paths "a.ts,b.ts" [--task "..."]
fiefdom claim <grant-id>

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

**"Not a git repository"** — fiefdom needs git to resolve ownership and to
detect writes; `git init` first.

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

- One process per fief in Pi; one subagent per holder in Claude Code, plus any
  serfs it puts to work. All cost real resources — divide a repo into the fiefs
  it needs, not the maximum.
- Changes crossing fiefs need the liege to coordinate them, by design.
- Writes the guard cannot read are caught after the fact, not prevented (see
  Enforcement).
- Claude Code subagents live for the session; what persists across sessions is
  the fief's memory, not its conversation.
