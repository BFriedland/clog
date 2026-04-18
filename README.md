<p align="center">
  <img src="clog.png" alt="Clogs are a type of footwear that has a thick, rigid sole typically made of wood.">
</p>

# clog

Turn your AI coding agent conversations into a searchable, shareable knowledge base.

clog discovers Claude Code and Codex CLI conversations on your machine, lets you curate them locally, publishes them for agent access via MCP, and optionally adds semantic search and git-based team sharing on top.

clog projects a canonical transcript rather than replaying every raw source record verbatim. It excludes confirmed hidden model scaffolding, but preserves user-visible transcript content even when the source encodes it with wrapper tags.

## Install

```bash
npm install
npm run build
```

## Quick Start

```bash
# See what conversations clog found on your machine
clog status

# Add source keys when multiple backends are in play
clog status --source

# Stage the interesting ones
clog add a1b2c3
clog add --all

# Curate conversations' metadata
clog edit a1b2c3 --title "Debug JWT refresh race condition"
clog tag a1b2c3 auth debugging

# Publish to the curated local library
clog publish

# Browse and inspect
clog list
clog show a1b2c3

# Share with your team (requires a private git repo)
clog sync push
```

## Commands

All IDs accept short prefixes of at least 4 characters, like git. They also accept source-qualified forms, like `a1b2@claude-code` or `f9e8@codex-cli`.

### Discovery & Curation

| Command | What it does |
|---------|-------------|
| `clog status` | Scan sources and show discovered, staged, and modified published conversations (`--source`) |
| `clog list [filters]` | List conversations — staged + published by default (`--all`, `--state`, `--project`, `--author`, `--tag`, `--origin`, `--grep`, `--columns`) |
| `clog add <id...>` | Stage or refresh conversations (`--all`, `--project <name>`) |
| `clog reset <id...>` | Move staged conversations back to discovered |
| `clog edit <id>` | Edit metadata (`--title`, `--summary`, `--author`) |
| `clog tag <id> <tags...>` | Add tags |
| `clog untag <id> <tags...>` | Remove tags |
| `clog exclude <id...>` | Delete tracked conversations from clog's DB and block rediscovery |
| `clog unexclude <id...>` | Reverse an exclusion |
| `clog rename-author <old> <new>` | Rename an author across local conversations |

### Publishing & Inspection

| Command | What it does |
|---------|-------------|
| `clog publish [id...]` | Publish all staged conversations, or explicitly publish specific local conversations |
| `clog unpublish <id...>` | Move published conversations back to staged |
| `clog diff [id...]` | Show new messages since last publish (`--staged`, `--head N`, `--tail N`, `--first N`, `--last N`) |
| `clog show <id>` | Display conversation metadata and parsed messages (`--path`, `--head N`, `--tail N`, `--first N`, `--last N`) |
| `clog path <id>` | Print the content path for a conversation |
| `clog plunge` | Audit local clog state for obvious corruption (`--json`, `--verbose`) |

### Semantic Search

| Command | What it does |
|---------|-------------|
| `clog search --init` | Interactive setup — choose embedding provider and vector store |
| `clog search <query>` | Semantic search across published conversations (`--project`, `--author`, `--tag`, `--limit`) |
| `clog index` | Index published conversations for search (`--rebuild` to re-index all) |

### Team Sharing

| Command | What it does |
|---------|-------------|
| `clog remote add\|show\|remove` | Configure a git remote for team sharing |
| `clog sync push` | Export published conversations to the team repo |
| `clog sync pull` | Import conversations from the team repo |
| `clog refresh` | Reconcile local DB from the git checkout (no fetch) |

### Configuration

| Command | What it does |
|---------|-------------|
| `clog init` | Initialize `~/.clog` and create a default config |
| `clog config [get\|set]` | View or edit configuration |

## MCP Server

The MCP server exposes clog to coding agents as typed tools with structured responses.

With Codex CLI:

```bash
codex mcp add clog -- node /path/to/clog/dist/mcp/server.js
```

With Claude:

```bash
claude mcp add clog -- npx clog-mcp
```

If `clog-mcp` is not available through `npx` in your environment, point the MCP command at your local build instead:

```bash
claude mcp add clog -- node /path/to/clog/dist/mcp/server.js
```

Available tools:

- `clog_list_published` — list published conversations with filters (`origin` filter for local vs team)
- `clog_list_staged` — list staged conversations for curation
- `clog_get` — load a staged or published conversation's messages
- `clog_update` — edit title, summary, or tags on a staged or published conversation
- `clog_browse` — list tags, projects, or authors across published conversations
- `clog_search` — semantic search across published conversations (`origin` filter, requires `clog search --init`)

Only published conversations are exposed through `clog_list_published`, `clog_browse`, and `clog_search`. `clog_list_staged`, `clog_get`, and `clog_update` also operate on staged conversations to support agent-assisted curation.

## Semantic Search

Semantic search is optional. It requires a one-time setup and two extra packages:

```bash
# Install search dependencies
npm install vectra @huggingface/transformers

# Interactive setup — choose embedding provider and vector store
clog search --init

# Search
clog search "JWT refresh token race condition"
clog search "database migration" --project myapp --limit 5
```

Published conversations are auto-indexed on `clog publish` when search is configured. Editing a published conversation's title or summary re-indexes it. Use `clog index --rebuild` to re-index everything from scratch.

## Team Sharing

Share your published conversations with teammates using any private git remote (GitHub, GitLab, bare repo, etc.). Git handles auth, transport, and access control — no custom server needed.

```bash
# Point clog at a shared private repo
clog remote add git@github.com:myorg/clog-team.git

# Pull your team's conversations
clog sync pull

# Push yours
clog sync push
```

**How it works:** clog manages a git checkout under `~/.clog/remote/`. `clog sync push` exports your published conversations and pushes. `clog sync pull` imports teammates' conversations into your local DB. Each author writes to their own directory to avoid conflicts.

**What to know:**

- `clog list` shows your local + same-author remote conversations by default. `--all` includes teammates'; `--author bob` filters.
- Remote conversations are **read-only** — edit, tag, untag, unpublish, reset, and publish refuse them, locally and over MCP.
- Unpublishing a locally-synced conversation retracts it from the remote on next push.
- `clog exclude` works on remote conversations to hide ones you don't want to see.
- `clog refresh` reconciles the local DB from the git checkout without fetching — useful if you ran `git pull` manually in `~/.clog/remote/`.

## Config File

Config lives at `~/.clog/config.json`. Common setup:

```bash
# Set your author name, which would otherwise default to your OS username upon first use
clog config set author alice

# Configure local discovery paths
clog config set sources.claude-code.paths '["~/.claude/projects/"]'
clog config set sources.codex-cli.paths '["~/.codex/sessions/"]'

# Keep personal projects out of discovery
clog config set sources.claude-code.includePaths '["~/work/"]'
clog config set sources.claude-code.excludePaths '["~/personal/"]'
```

You can also create `~/.clog/clogignore` for pattern-based filtering:

```text
# Skip personal projects
project:~/personal/*

# Skip old conversations
before:2025-01-01
```

The `search` and `remote` config blocks are managed by `clog search --init` and `clog remote add` respectively.

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `CLOG_HOME` | Override the data directory (default: `~/.clog`) |
| `CLOG_DEBUG` | Bypass CLI error wrapping and surface raw stack traces |

## Development

```bash
npm test               # Run tests
npm run test:watch     # Watch mode
npm run test:coverage  # Run tests with coverage report
npm run lint           # Lint src/ and tests/
npm run build          # Build clog and fix bin permissions
npm run dev -- status  # Run without building
```
