<p align="center">
  <img src="clog.png" alt="Clogs are a type of footwear that has a thick, rigid sole typically made of wood.">
</p>

# clog

Turn your AI coding agent conversations into a searchable, shareable knowledge base.

With clog, you can build a library from your Claude Code and Codex CLI conversations and make it available to your team and your agents. Use titles, summaries, and tags to curate it, then explore it through MCP tools, semantic search, or git-based sharing.

`npm run setup` builds clog, installs the `clog` command globally from your local checkout, and runs `clog init`.

## Install

```bash
npm install
npm run setup
```

## Quick Start

```bash
# See what conversations clog found on your machine
clog status

# Add source keys when multiple backends are in play
clog status --source

# Publish a project straight to your local library
clog publish myapp

# Or publish one conversation by short ID
clog publish a1b2c3

# Browse and inspect
clog list
clog show a1b2c3

# Share with your team (requires a private git repo)
clog sync push
```

## Commands

Many clog commands work with either a project name or a conversation ID. Conversations can also be referenced by a short ID prefix of at least 4 characters, like git.

### Discovery & Curation

| Command | What it does |
|---------|-------------|
| `clog status` | Scan sources and show discovered, staged, and modified published conversations (`--source`) |
| `clog list [filters]` | List conversations — staged + published by default (`--all`, `--state`, `--project`, `--author`, `--tag`, `--origin`, `--grep`, `--columns`) |
| `clog add [selector...]` | Stage conversations from a project or by ID (`--all`) |
| `clog reset <selector...>` | Move staged conversations back to discovered |
| `clog edit <id>` | Edit metadata (`--title`, `--summary`, `--author`) |
| `clog tag <id> <tags...>` | Add tags |
| `clog untag <id> <tags...>` | Remove tags |
| `clog exclude <rule...>` | Ignore projects or conversations via `~/.clog/clogignore` |
| `clog unexclude <rule...>` | Remove exact rules from `~/.clog/clogignore` |
| `clog remove <rule...>` | Remove currently matching conversations from clog's local DB |
| `clog rename-author <old> <new>` | Rename an author across local conversations |

### Publishing & Inspection

| Command | What it does |
|---------|-------------|
| `clog publish [selector...]` | Publish staged conversations, or publish a project directly |
| `clog unpublish <selector...>` | Move published conversations back to staged |
| `clog diff [id...]` | Show new messages since last publish (`--staged`, `--head N`, `--tail N`, `--first N`, `--last N`) |
| `clog show <id>` | Display conversation metadata and parsed messages (`--path`, `--head N`, `--tail N`, `--first N`, `--last N`) |
| `clog path <id>` | Print the content path for a conversation |
| `clog drain [selector...]` | Export conversations by project, ID, or filters (`--to`, `--to-dir`, `--raw`, `--format`) |
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
| `clog init` | Re-run setup, confirm the default author, and offer vector search and MCP setup (`clog setup` is an alias) |
| `clog mcp setup [claude\|codex\|both]` | Register clog's MCP server with Claude Code, Codex CLI, or both |
| `clog config [get\|set]` | View or edit configuration |

## MCP Server

Once you've added some conversations, you can give your coding agents direct access to them via MCP.

The easiest path is:

```bash
clog mcp setup both
```

With Claude Code:

```bash
claude mcp add clog -- npx -y clog-mcp
```

With Codex CLI:

```bash
codex mcp add clog -- npx -y clog-mcp
```

If a `clog` MCP server is already registered for one of those clients, `clog mcp setup` replaces it automatically.

This gives agents the following tools:

| Tool | What it does |
|------|-------------|
| `clog_list_published` | List published conversations (filterable by origin, project, etc.) |
| `clog_list_staged` | List staged conversations for agent-assisted curation |
| `clog_get` | Load a conversation's messages |
| `clog_update` | Edit title, summary, or tags |
| `clog_browse` | List tags, projects, or authors |
| `clog_search` | Semantic search (requires `clog search --init`) |

## Semantic Search

Search is optional — it takes a one-time setup and two extra packages.

```bash
npm install vectra @huggingface/transformers
clog search --init
```

Then just search:

```bash
clog search "JWT refresh token race condition"
clog search "database migration" --project myapp --limit 5
```

Once configured, conversations are auto-indexed whenever you `clog publish`. Editing a conversation's title or summary re-indexes it. Use `clog index --rebuild` to re-index everything from scratch.

## Team Sharing

Share your published conversations with teammates using any private git remote (GitHub, GitLab, bare repo, etc.). Git handles auth, transport, and access control.

```bash
# Point clog at a shared private repo
clog remote add git@github.com:myorg/clog-team.git

# Pull your team's conversations
clog sync pull

# Push yours
clog sync push
```

**How it works:** clog manages a git checkout under `~/.clog/remote/`. Each author writes to their own directory to avoid conflicts. `sync push` exports and pushes your published conversations; `sync pull` imports your teammates'.

**Good to know:**

- `clog list` shows your conversations by default. `--all` includes teammates'; `--author bob` filters to one person.
- Remote conversations are read-only — you can view but not edit them.
- Unpublishing a synced conversation retracts it from the remote on next push.
- Use `clog exclude` to ignore projects or conversations, and `clog remove` if you also want to delete current local DB rows.
- `clog refresh` reconciles from the git checkout without fetching — handy if you ran `git pull` manually in `~/.clog/remote/`.

## Config File

Config lives at `~/.clog/config.json`:

```bash
# Set your author name (defaults to your OS username)
clog config set author alice

# Configure where clog looks for conversations
clog config set sources.claude-code.paths '["~/.claude/projects/"]'
clog config set sources.codex-cli.paths '["~/.codex/sessions/"]'

# Only discover conversations from work projects
clog config set sources.claude-code.includePaths '["~/work/"]'
clog config set sources.claude-code.excludePaths '["~/personal/"]'
```

Use `~/.clog/clogignore` to keep projects or conversations out of clog:

```text
# Ignore a project by name
myapp

# Ignore one conversation by filename
12345678-1234-1234-1234-123456789abc.jsonl

# Ignore by path
~/personal/
```

The `search` and `remote` config blocks are managed by `clog search --init` and `clog remote add`.

## Complementary Tools

**Claude Code `/insights`** — Run `/insights` inside Claude Code to get a report analyzing your Claude Code sessions — project areas, interaction patterns, friction points. Useful for spotting which conversations are worth adding to clog.

**[cass](https://github.com/Dicklesworthstone/coding_agent_session_search)** — A local search engine for AI coding agent sessions. Indexes conversations from 19+ agents (Claude Code, Codex, Cursor, Aider, Gemini, and others) with full-text and semantic search.

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
npm run setup          # Build, link, and initialize clog
npm run dev -- status  # Run without building
```
