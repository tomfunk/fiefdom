# Fiefdom

Multi-agent workspace orchestration for Pi. Splits a repository into "fiefs" (frontend, backend, etc.), spawns one persistent agent per fief, and keeps a non-writing orchestrator in the main session for intake and routing.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Orchestrator                            │
│  • No Write/Edit tools (read-only)                          │
│  • Routes tasks to fiefs                                    │
│  • Coordinates cross-fief work                              │
│  • Aggregates fief learnings                                │
└───────────────┬─────────────────────┬───────────────────────┘
                │                     │
       ┌────────▼────────┐   ┌────────▼────────┐
       │  Frontend Fief  │   │  Backend Fief   │
       │  (RPC Process)  │   │  (RPC Process)  │
       │                 │   │                 │
       │ Paths:          │   │ Paths:          │
       │ - frontend/**   │   │ - backend/**    │
       │ - shared-ui/**  │   │ - services/**   │
       │                 │   │                 │
       │ Worktree:       │   │ Worktree:       │
       │ .pi/worktrees/  │   │ .pi/worktrees/  │
       │   frontend/     │   │   backend/      │
       └─────────────────┘   └─────────────────┘
```

## Setup

### 1. Install Dependencies

```bash
cd ~/.pi/agent/extensions/fiefdom
npm install
```

### 2. Run Setup

When you open a git repository without fiefdom configured, you'll see:

```
Fiefdom: Not configured. Use /fiefdom-setup to divide this repo.
```

Run `/fiefdom-setup` and Fiefdom will:
1. Analyze your repository structure
2. Detect common patterns (frontend/, backend/, packages/, etc.)
3. Propose fief divisions with confidence level
4. Let you review and edit the proposal
5. Generate configuration and persona files
6. Add all fiefdom files to `.gitignore` (everything stays local)

### Manual Configuration

Alternatively, create `.pi/fiefs.json` manually:

```json
{
  "fiefs": [
    {
      "id": "frontend",
      "paths": ["frontend/**", "shared-ui/**"],
      "persona": ".pi/fiefs/frontend/AGENT.md",
      "memory": ".pi/fiefs/frontend/memory/"
    },
    {
      "id": "backend",
      "paths": ["backend/**", "services/**", "api/**"],
      "persona": ".pi/fiefs/backend/AGENT.md",
      "memory": ".pi/fiefs/backend/memory/"
    }
  ]
}
```

### 3. Create Personas

Each fief needs a persona file (system prompt). Create `.pi/fiefs/<id>/AGENT.md`:

```markdown
# Frontend Specialist

You are the frontend expert for this project. You understand:
- React/Vue/Angular (as appropriate)
- State management patterns
- Component architecture
- CSS/styling conventions

## Conventions

- Use functional components
- State goes in hooks
- Follow existing naming patterns
```

### 4. Start a Session

```bash
pi
```

When Fiefdom detects `.pi/fiefs.json`, it will:
1. Create git worktrees for each fief
2. Spawn persistent RPC agents
3. Remove Write/Edit tools from the orchestrator
4. Display status in the footer

## Usage

### Orchestrator Workflow

The typical workflow is:

1. **User describes feature**: "I want to add user profiles"

2. **Orchestrator queries fiefs**:
   ```
   Use query_fief to ask frontend: "What would you need to implement for user profiles?"
   Use query_fief to ask backend: "What would you need to implement for user profiles?"
   ```

3. **Orchestrator coordinates**:
   ```
   Based on the responses, the frontend needs a ProfileCard component and 
   backend needs a /users/:id endpoint. Use request_from_fief to have them 
   agree on the API contract.
   ```

4. **Orchestrator routes tasks**:
   ```
   Use route_ticket to frontend: "Implement ProfileCard component that..."
   Use route_ticket to backend: "Implement GET /users/:id endpoint that..."
   ```

### Available Tools

| Tool | Description |
|------|-------------|
| `list_fiefs` | Show all fiefs and their status |
| `route_ticket` | Send a task to a fief agent |
| `query_fief` | Ask a fief what it would contribute (planning) |
| `request_from_fief` | Cross-fief coordination request |
| `get_fief_memory` | View a fief's accumulated learnings |
| `get_request_log` | View audit log of all requests |

### Fief Memory

Fief agents **automatically extract learnings** after completing tasks. No explicit markers needed.

After each task, the agent reflects and saves:
- **Decisions**: Architectural choices and their reasoning
- **Conventions**: Patterns and coding standards discovered
- **Issues**: Gotchas, bugs, and things to watch for
- **Notes**: Other useful insights

Memory is:
- **Selective**: Only genuinely useful insights are saved
- **Lean**: Capped at 50 entries per category, truncated to 500 chars
- **Local**: Everything gitignored - config, personas, memory, worktrees
- **Persistent**: Survives across sessions

The orchestrator can view fief memories to understand what each specialist has learned.

## Enforcement

Write restrictions are enforced at two layers:

### 1. Tool-Call Interception
The extension intercepts `write` and `edit` tool calls and blocks them for the orchestrator.

### 2. Filesystem Isolation
Each fief runs in its own git worktree (`.pi/worktrees/<fief>/`), providing filesystem-level isolation.

## Configuration Reference

### fiefs.json

```json
{
  "fiefs": [
    {
      "id": "string",           // Unique identifier
      "paths": ["glob/**"],     // Files this fief can write
      "persona": "path.md",     // System prompt (optional)
      "memory": "path/"         // Memory directory (optional)
    }
  ]
}
```

### Persona Files

Markdown files with instructions for the fief agent. Can include:
- Role description
- Technical context
- Conventions
- Constraints

## Commands

| Command | Description |
|---------|-------------|
| `/fiefdom` | Show status and available tools |
| `/fiefdom-setup` | Analyze repo and configure fiefs (first-time or reconfigure) |
| `/fiefdom-review` | Review current divisions, find issues, see suggestions |

## Files

All fiefdom files are gitignored (local-only, per-machine):

```
.pi/
├── fiefs.json                    # Configuration
├── fiefs/
│   ├── frontend/
│   │   ├── AGENT.md              # Persona
│   │   └── memory/
│   │       ├── decisions.jsonl   # Persistent memory
│   │       ├── conventions.jsonl
│   │       ├── issues.jsonl
│   │       └── notes.jsonl
│   └── backend/
│       ├── AGENT.md
│       └── memory/
├── worktrees/                    # Git worktrees (auto-created)
│   ├── frontend/
│   └── backend/
└── cross-fief-requests.log       # Audit trail
```

## Reviewing & Reorganizing

Use `/fiefdom-review` to:
- See current fief stats (messages, memories)
- View recent learnings from each fief
- Identify unassigned directories
- Get suggestions for new fiefs

To reorganize:
1. Edit `.pi/fiefs.json` directly
2. Update/create persona files
3. Use `/reload` to apply changes

Or run `/fiefdom-setup` again (memories are preserved).

## Limitations

- Requires git repository (for worktree isolation)
- Spawns one process per fief (resource usage)
- Cross-fief file edits require coordination
- Memory reflection adds ~1 extra API call per task

## Troubleshooting

### "Not a git repository"
Fiefdom requires git for worktree isolation. Initialize git or use a git repo.

### Fief agent not starting
Check the persona file exists and is valid markdown.

### Memory not persisting
Ensure `.pi/fiefs/<id>/memory/` directory is writable.
