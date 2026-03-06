<p align="center">
  <img src="clog.png" alt="Clogs are a type of footwear that has a thick, rigid sole typically made of wood.">
</p>

# clog

Turn your AI coding agent conversations into a searchable, shareable knowledge base.

clog discovers Claude Code conversations on your machine, lets you curate them (stage, tag, edit), publishes them so other agents can query the knowledge base via MCP, and syncs them with your team via git.

## Install

```bash
npm install
npm run build
```

## Quick Start

```bash
# See what conversations clog found on your machine
clog status

# Stage the interesting ones
clog add a1b2c3
clog add --all

# Curate
clog edit a1b2c3 --title "Debug JWT refresh race condition"
clog tag a1b2c3 auth debugging

# Publish to the knowledge base
clog publish -m "Auth debugging sessions"

# Browse and view your published conversations
clog list
clog show a1b2c3

# Share with your team
clog sync push
```

## Commands

All IDs accept short prefixes (minimum 4 characters), like git.

### Discovery & Curation

| Command | What it does |
|---------|-------------|
| `clog status` | Scan sources and show counts by state |
| `clog list [filters]` | List conversations — staged + published by default (`--all`, `--state`, `--project`, `--tag`, `--author`, `--origin`, `--grep`, `--columns`) |
| `clog add <id...>` | Stage conversations (`--all`, `--project <name>`) |
| `clog reset <id...>` | Unstage back to discovered |
| `clog edit <id>` | Edit metadata (`--title`, `--summary`) |
| `clog tag <id> <tags...>` | Add tags |
| `clog untag <id> <tags...>` | Remove tags |
| `clog exclude <id...>` | Permanently hide from discovery |
| `clog unexclude <id...>` | Reverse an exclusion |

### Publishing

| Command | What it does |
|---------|-------------|
| `clog publish [id...]` | Publish staged conversations (`-m <message>`) |
| `clog unpublish <id...>` | Move back to staged |
| `clog diff [id...]` | Show new messages since last publish (`--staged`, `--head N`, `--tail N`) |
| `clog show <id>` | Display full conversation (`--head N`, `--tail N`) |
| `clog path <id>` | Print raw file path (for piping) |
| `clog log` | Show publish history |

### Team Sharing

| Command | What it does |
|---------|-------------|
| `clog remote add\|show\|remove` | Configure a git remote for team sharing |
| `clog sync push` | Export published conversations to the team repo |
| `clog sync pull` | Import conversations from the team repo |
| `clog refresh` | Refresh local DB from the git checkout (no fetch) |
| `clog rename-author <old> <new>` | Rename author across local conversations |

### Search

| Command | What it does |
|---------|-------------|
| `clog search --init` | Set up semantic search (choose embedding provider and vector store) |
| `clog search <query>` | Semantic search across published conversations (`--project`, `--author`, `--tag`, `--limit`) |
| `clog index` | Index published conversations for search (`--rebuild` to re-index all) |

### Configuration

| Command | What it does |
|---------|-------------|
| `clog config [get\|set]` | View or edit configuration |

## MCP Server

The MCP server exposes clog to coding agents as typed, schema-validated tools with structured JSON responses.

Expose your published conversations to coding agents:

```bash
claude mcp add clog -- npx clog-mcp
```

The MCP server provides these tools:

- **`clog_list_published`** — Browse published conversations with filters (`origin` filter for local vs team)
- **`clog_list_staged`** — Browse staged conversations for curation
- **`clog_get`** — Read a conversation's messages
- **`clog_update`** — Edit title, summary, or tags
- **`clog_browse`** — List available tags, projects, and authors
- **`clog_search`** — Semantic search across published conversations (`origin` filter, requires `clog search --init`)

Only published conversations are visible via `clog_list_published`, `clog_browse`, and `clog_search`. Staged conversations are accessible via `clog_list_staged`, `clog_get`, and `clog_update` to support agent-assisted curation.

## Search

clog supports semantic search across published conversations using local embeddings and a vector store. Semantic search is optional — it requires a one-time setup and two extra packages.

```bash
# Install search dependencies
npm install vectra @huggingface/transformers

# Interactive setup — choose embedding provider and vector store
clog search --init

# Index published conversations
clog index

# Search
clog search "JWT refresh token race condition"
clog search "database migration" --project myapp --limit 5
```

Published conversations are automatically indexed during `clog publish`. Editing a conversation's title or summary marks it for re-indexing on the next `clog index` run. Use `clog index --rebuild` to re-index everything from scratch.

## Team Sharing

Share your published conversations with teammates using any git remote (GitHub, GitLab, bare repo, etc.). Git handles auth, transport, and access control — no custom server needed.

```bash
# Point clog at a shared private repo
clog remote add git@github.com:myorg/clog-team.git

# Pull your team's conversations
clog sync pull

# Push yours
clog sync push
```

**How it works:** clog manages a git checkout behind the scenes. `clog sync push` exports your published conversations to the repo and pushes. `clog sync pull` pulls and imports teammates' conversations into your local DB. Each author's conversations are kept in separate directories to avoid conflicts.

**What to know:**

- `clog list` shows your conversations by default. Use `--all` to include the team's, or `--author bob` to filter.
- Remote conversations are **read-only** — you can't edit, tag, or unpublish someone else's conversations.
- Unpublishing a conversation locally retracts it from the remote on next push.
- `clog exclude` works on remote conversations to hide ones you don't want to see.
- `clog refresh` refreshes your local DB from the git checkout without fetching — useful if you ran `git pull` manually in `~/.clog/remote/`.

## Configuration

Config lives at `~/.clog/config.json`. Key settings:

```bash
# Set your author name
clog config set author alice

# Filter which projects are discovered
clog config set sources.claude-code.includePaths '["~/work/"]'
clog config set sources.claude-code.excludePaths '["~/personal/"]'
```

You can also create `~/.clog/clogignore` for pattern-based filtering:

```
# Skip personal projects
project:~/personal/*

# Skip old conversations
before:2025-01-01
```

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `CLOG_HOME` | Override data directory (default: `~/.clog/`) |
| `CLOG_SOURCES` | Override source paths (colon-separated) |
| `CLOG_DEBUG` | Show full stack traces on errors |

## Development

```bash
npm test              # Run tests
npm run test:watch    # Watch mode
npm run lint          # Lint src/ and tests/
npm run dev -- status # Run without building
```
