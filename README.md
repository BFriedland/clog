<p align="center">
  <img src="clog.png" alt="Clogs are a type of footwear that has a thick, rigid sole typically made of wood.">
</p>

# clog

Turn your AI coding agent conversations into a searchable knowledge base.

clog discovers Claude Code and Codex CLI conversations on your machine, lets you curate them locally, publishes them for agent access via MCP, and keeps the curated/raw boundary explicit.

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
```

## Commands

All IDs accept short prefixes of at least 4 characters, like git. They also accept source-qualified forms, like `a1b2@claude-code` or `f9e8@codex-cli`.

### Discovery & Curation

| Command | What it does |
|---------|-------------|
| `clog status` | Scan sources and show discovered, staged, and modified published conversations (`--source`) |
| `clog list [filters]` | List conversations — staged + published by default (`--all`, `--state`, `--project`, `--author`, `--tag`, `--grep`, `--columns`) |
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

### Configuration

| Command | What it does |
|---------|-------------|
| `clog init` | Initialize `~/.clog` and create a default config |
| `clog config` | Show config |
| `clog config get [key]` | Read a config value |
| `clog config set <key> <value>` | Update a config value |

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

If `clog-mcp` is not available through `npx` in your environment, point the MCP
command at your local build instead, for example:

```bash
claude mcp add clog -- node /path/to/clog/dist/mcp/server.js
```

Available tools:

- `clog_list_published` — list published conversations with filters
- `clog_list_staged` — list staged conversations for curation
- `clog_get` — load a staged or published conversation's messages
- `clog_update` — edit title, summary, or tags on a staged or published conversation
- `clog_browse` — list tags, projects, or authors across published conversations

Only published conversations are exposed through `clog_list_published` and `clog_browse`. `clog_list_staged`, `clog_get`, and `clog_update` also operate on staged conversations to support agent-assisted curation.

## Config File

Config lives at `~/.clog/config.json`.

Common setup:

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

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `CLOG_HOME` | Override the data directory (default: `~/.clog`) |
| `CLOG_DEBUG` | Bypass CLI error wrapping and surface raw stack traces |

## Development

```bash
npm test               # Run tests
npm run test:watch     # Watch mode
npm run lint           # Lint src/ and tests/
npm run build          # Build clog and fix bin permissions
npm run dev -- status  # Run without building
```
