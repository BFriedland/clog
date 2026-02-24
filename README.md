<p align="center">
  <img src="clog.png" alt="Clogs are a type of footwear that has a thick, rigid sole typically made of wood.">
</p>

# clog

Turn your AI coding agent conversations into a searchable knowledge base.

clog discovers Claude Code conversations on your machine, lets you curate them (stage, tag, edit), and publishes them so other agents can query the knowledge base via MCP.

## Install

```bash
npm install
npm run build
```

## Quick Start

```bash
# Browse your curated conversations (staged + published)
clog list
clog list --all                          # everything, including excluded
clog list --state discovered --grep "auth"
clog list --columns all                  # show every column (id,date,state,project,author,title)

# Stage the interesting ones
clog add a1b2c3
clog add --all

# Curate
clog edit a1b2c3 --title "Debug JWT refresh race condition"
clog tag a1b2c3 auth debugging

# Publish to the knowledge base
clog publish -m "Auth debugging sessions"

# View a conversation
clog show a1b2c3

# Check publish history
clog log
```

## Commands

| Command | What it does |
|---------|-------------|
| `clog status` | Scan sources and show counts by state |
| `clog list [filters]` | List conversations — staged + published by default (`--all`, `--state`, `--project`, `--tag`, `--grep`, `--columns`) |
| `clog add <id...>` | Stage conversations (`--all`, `--project <name>`) |
| `clog reset <id...>` | Unstage back to discovered |
| `clog edit <id>` | Edit metadata (`--title`, `--summary`) |
| `clog tag <id> <tags...>` | Add tags |
| `clog untag <id> <tags...>` | Remove tags |
| `clog publish [id...]` | Publish staged conversations (`-m <message>`) |
| `clog unpublish <id...>` | Move back to staged |
| `clog diff [id...]` | Show new messages since last publish (`--staged`, `--head N`, `--tail N`) |
| `clog show <id>` | Display full conversation (`--head N`, `--tail N`) |
| `clog path <id>` | Print raw file path (for piping) |
| `clog log` | Show publish history |
| `clog exclude <id...>` | Permanently hide from discovery |
| `clog unexclude <id...>` | Reverse an exclusion |
| `clog config [get\|set]` | View or edit configuration |

All IDs accept short prefixes (minimum 4 characters), like git.

## MCP Server

Expose your published conversations to coding agents:

```bash
claude mcp add clog -- npx clog-mcp
```

The MCP server provides these tools:

- **`clog_list_published`** — Browse published conversations with filters
- **`clog_list_staged`** — Browse staged conversations for curation
- **`clog_get`** — Read a conversation's messages
- **`clog_update`** — Edit title, summary, or tags
- **`clog_browse`** — List available tags, projects, and authors

Only published conversations are visible via `clog_list_published` and `clog_browse`. Staged conversations are accessible via `clog_list_staged`, `clog_get`, and `clog_update` to support agent-assisted curation.

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
