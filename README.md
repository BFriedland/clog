<p align="center">
  <img src="clog.png" alt="The clog logo: a woodcut-style drawing of a wooden clog." title="Clogs are a type of footwear that has a thick, rigid sole typically made of wood.">
</p>

# clog &middot; [![npm version](https://img.shields.io/npm/v/@getclog/clog)](https://www.npmjs.com/package/@getclog/clog) [![node version](https://img.shields.io/node/v/@getclog/clog)](https://nodejs.org) [![license](https://img.shields.io/npm/l/@getclog/clog)](LICENSE)

Conversation log exploration right in your terminal. Turn your AI coding agent conversations into a searchable, shareable knowledge base.

You choose which conversations are worth keeping, and clog will turn them into a library your team and your agents can use. An agent that reads a past conversation picks up context that took hours of back-and-forth to build the first time.

Some favorite uses so far, all done by asking an agent to use clog's MCP tools:

- **Handing context from one agent to another** — give an implementing or reviewing agent the highest-signal parts of the speccing agent's conversation by asking them to read it directly.
- **Beating compaction** — compaction silently drops nuance the agent never knows it lost; a saved transcript keeps everything, and an agent can reread exactly the part it needs with the tool call noise already stripped out.
- **Researching bugs** — search past debugging sessions for the time you hit something like this before.
- **Finding prompts that worked** — have an agent search semantically for the phrasing that got results, even when your own memory of it is vague.
- **Noticing your patterns** — which interaction styles keep working for you, and which antipatterns to stop repeating.

A look at the CLI side:

```text
$ clog status
Saved conversations whose source files changed:
  (use "clog save <id>" to refresh the saved copy from its source file)
    payments-api  2 conversations  2026-07-24

Unsaved conversations:
  (use "clog save <id>" or "clog save <project>" to save)
    payments-api  3 unsaved  2026-07-24
    web-app       1 unsaved  2026-07-23

$ clog search "refresh token race condition"
1. 83f1c2ea [72%] Fix the JWT refresh race condition on concurrent requests
   payments-api
   Human: Two tabs can refresh the same session at once and one ends up holding a revoked
   token. Assistant: The rotation step isn't atomic. Let me look at how the refresh endpoint
2. d41c09aa [54%] Debug intermittent 502s from the payments gateway
   payments-api
   Title: Debug intermittent 502s from the payments gateway Summary: Traced the 502s to
   connection reuse after idle timeout; added keepalive tuning and a retry budget
```

## Install

Requires Node.js 22 or newer.

```bash
npm install -g @getclog/clog
clog init
```

To install from a local checkout instead, see [Development](#development).

## Quick Start

```bash
# See what's new, grouped by project (or per conversation with -c)
clog status
clog status -c

# Save a project's conversations into your library
clog save myproject

# Browse and inspect
clog list
clog show a1b2c3 | less -R

# Export an archive to share with your team
clog drain myproject -o my-project-export.zip

# Import a teammate's archive (read-only)
clog fill my-project-export.zip

# Open a local coding agent of your choice to explore your knowledge base
clog talk
```

## MCP Server

Once you've added some conversations, you can give your coding agents direct access to them via MCP.

The easiest path is:

```bash
clog mcp setup both
```

For Claude Code only:

```bash
clog mcp setup claude
```

For Codex CLI only:

```bash
clog mcp setup codex
```

`clog mcp setup` registers the currently installed local copy of clog with an absolute Node command. It does not use `npx` or install packages at MCP startup. If clog is moved, reinstalled, or rebuilt in a different location, run `clog mcp setup` again.

This gives agents the following tools:

| Tool | What it does |
|------|-------------|
| `list_conversations` | List saved conversations by default, with each conversation's branches grouped into one row unless `allBranches` is true |
| `get_conversation` | Load one saved conversation's messages, plus links to its other branches |
| `update_conversation` | Edit title, summary, structured extraction, or tags on saved local conversations |
| `browse_metadata` | List tags, projects, or authors |
| `search_conversations` | Semantic search (requires `clog search --init`) |
| `summarization_guide` | Guidance an agent reads before summarizing: why summaries help, the extraction shape, and the quality bar |
| `analysis_suggestions` | Opinionated library of analyses an agent can offer the user |

## Agent-Assisted Summarization

clog can store structured summaries for saved conversations so that later analyst agents can scan many conversations cheaply. Summaries are written by an MCP-capable agent, not by clog itself, and clog remains useful without them.

```bash
clog save             # saves conversations as usual; ends with a hint about saved conversations without summaries
clog talk             # opens your agent and primes it with the current clog state
clog summarize        # opens your agent with a summarization-focused intro
```

The agent reads the `summarization_guide` MCP tool, then works through unsummarized conversations and calls `update_conversation` with a prose `summary` plus a structured `extraction` (topics, outcome, tools used, notable moments). User-edited summaries (`clog edit --summary`) are marked `curated` and are not overwritten.

## Semantic Search

Search is optional. `clog search --init` installs vector search support into `~/.clog/search-runtime` when you enable it. The setup prompt shows the package and model download sizes before installing anything (~470 MB).

```bash
clog search --init
```

Then just search:

```bash
clog search "JWT refresh token race condition"
clog search "database migration" --project myproject --limit 5
clog search "authentication retry" --all-branches
```

Once configured, conversations are indexed automatically when you save or edit them. Use `clog index` to catch up on missing or stale indexing, and `clog index --rebuild` to re-index everything from scratch.

When a conversation is split across several branches, semantic search and `grep` return one result for it, not one per branch. Pass `--all-branches` to `clog search` or `allBranches: true` to the corresponding MCP search or list tool to see each branch separately.

If you skip vector search setup, `search_conversations` is unavailable, but agents can still use the `grep` filter on the `list_conversations` MCP tool for dependency-free keyword search across conversation titles, summaries, and message content.

## Team Sharing

Share your saved conversations with teammates using any private git remote (GitHub, GitLab, bare repo, etc.). Git handles auth, transport, and access control.

```bash
# Point clog at a shared private repo
clog remote add git@github.com:myorg/clog-team.git

# Pull your team's conversations
clog sync pull

# Push yours
clog sync push
```

**How it works:** clog manages a git checkout under `~/.clog/remote/`. Each
author writes to their own directory to avoid conflicts. `sync push` exports and
pushes your saved conversations; `sync pull` imports your teammates'.

**Good to know:**

- `clog list` shows your saved conversations by default, including imported
  conversations with your author name. `--all` includes other authors' imports;
  `--author bob` filters to one person.
- Imported conversations are read-only — you can view but not edit git-synced or
  default `clog fill` rows.
- Removing one of your saved local conversations retracts it from the remote on
  next push.
- Use `clog exclude` to ignore projects or conversations, and `clog remove` if
  you also want to delete current local DB rows.
- `clog refresh` reconciles from the git checkout without fetching — handy if
  you ran `git pull` manually in `~/.clog/remote/`.

Portable archives can also move conversations without git:

```bash
clog drain myproject                             # creates a file: ./clog-export.zip
clog drain myproject -o ./my-project-export.zip  # write to an explicit path
```

`clog drain myproject --format pair -o ./clog-export/` writes the same
conversations as an unpacked directory instead of a zip.

Import an export as read-only conversations, or add `--own` to restore your
own conversations as editable local copies:

```bash
clog fill ./my-project-export.zip
clog fill ./my-project-export.zip --own
```

Imports write only to clog's own storage — they never modify Claude Code or
Codex CLI files, and imported conversations don't appear in those tools.
Archives contain complete, unencrypted transcripts, so share them only
through access-controlled channels.

## Commands

Many clog commands work with either a project name or a conversation ID. Conversations can also be referenced by a short ID prefix of at least 4 characters, like git.

### Discovery & Curation

Until you save it, a conversation is just a read-only view of the source
tool's own files on disk; clog stores nothing about it. Saving copies the
transcript into clog's storage. From there you can edit its metadata, index
it for search, export it, and sync it to your team.

When a conversation is split across several branches (after an edited prompt
or a rewind), clog groups them and shows it once by default;
`clog list --all-branches` expands the group.

| Command | What it does |
|---------|-------------|
| `clog status` | Scan sources and show project summaries for unsaved conversations and saved conversations needing attention (`--conversations`, `--source`) |
| `clog list [filters]` | List conversations — saved and branch-collapsed by default (`--all-branches`, `--all`, `--state`, `--project`, `--author`, `--tag`, `--origin`, `--grep`, `--columns`) |
| `clog edit <id>` | Edit metadata (`--title`, `--summary`, `--author`) |
| `clog tag <id> <tags...>` | Add tags |
| `clog untag <id> <tags...>` | Remove tags |
| `clog exclude <rule...>` | Ignore projects or conversations via `~/.clog/clogignore` |
| `clog unexclude <rule...>` | Remove exact rules from `~/.clog/clogignore` |
| `clog remove <rule...>` | Remove matching conversations from clog's local DB and stored conversation copies (`--yes`, `--dry-run`) |
| `clog rename-author <old> <new>` | Rename an author across local conversations |

### Saving & Inspection

| Command | What it does |
|---------|-------------|
| `clog save [selector...]` | Save unsaved conversations by ID/project, or resave saved conversations with pending changes (`--all`) |
| `clog diff [id...]` | Show new messages since last save (`--head N`, `--tail N`, `--first N`, `--last N`) |
| `clog show <id>` | Display one conversation as a terminal view, JSON (`--json`), Markdown (`--md`), raw content bytes (`--raw`), or its content path (`--path`); parsed formats support `--head N`/`--first N` and `--tail N`/`--last N` |
| `clog path <id>` | Print the content path for a conversation |
| `clog drain [selector...]` | Export saved conversations to a zip archive by default, or to an unpacked pair directory with `--format pair` (`clog export` is an alias; `-o, --output`, `--include-imported`, `--yes`) |
| `clog fill <path>` | Import a clog zip archive or unpacked conversation-pair directory as read-only conversations (`clog import` is an alias) |
| `clog plunge` | Audit local clog state for obvious corruption (`--json`, `--verbose`) |

`clog show --json` prints a structured conversation object for scripts,
`--md` prints a document-ready transcript, and `--raw` prints the
conversation's file content byte-for-byte; redirect any of them with `>` to
save a copy.

### Agent Sessions

| Command | What it does |
|---------|-------------|
| `clog talk [claude\|codex]` | Open an MCP-capable agent in this terminal, primed with the current clog state |
| `clog summarize [claude\|codex]` | Open an agent and ask it to summarize unsummarized saved conversations |

### Semantic Search

| Command | What it does |
|---------|-------------|
| `clog search --init` | Interactive setup — choose embedding provider and vector store |
| `clog search <query>` | Semantic search across saved conversations (`--project`, `--author`, `--tag`, `--limit`) |
| `clog index` | Index saved conversations whose search index is missing or stale (`--rebuild` to re-index all) |

### Team Sharing

| Command | What it does |
|---------|-------------|
| `clog remote add\|show\|remove` | Configure a git remote for team sharing |
| `clog sync push` | Export saved conversations to the team repo |
| `clog sync pull` | Import conversations from the team repo |
| `clog refresh` | Reconcile local DB from the git checkout (no fetch) |

### Configuration

| Command | What it does |
|---------|-------------|
| `clog init` | Re-run setup, confirm the default author, and offer vector search and MCP setup (`clog setup` is an alias) |
| `clog mcp setup [claude\|codex\|both]` | Register clog's MCP server with Claude Code, Codex CLI, or both |
| `clog config [get\|set]` | View or edit configuration |

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

The settings you can edit:

| Setting | Default | What it does |
|---|---|---|
| `author` | your OS username | Name attached to conversations you save |
| `defaultTags` | `[]` | Tags applied to every conversation you save |
| `sources.<source>.enabled` | `true` | Whether clog discovers conversations from that source (`claude-code`, `codex-cli`) |
| `sources.<source>.paths` | `~/.claude/projects/` or `~/.codex/sessions/` | Directories to scan for that source |
| `sources.<source>.includePaths` | `[]` | If set, discover only conversations under these paths |
| `sources.<source>.excludePaths` | `[]` | Skip conversations under these paths |
| `search.indexAllBranches` | `false` | Index every branch for semantic search, not just the latest of each conversation |

Use `~/.clog/clogignore` to keep projects or conversations out of clog:

```text
# Ignore a project by name
myproject

# Ignore one conversation by filename
12345678-1234-1234-1234-123456789abc.jsonl

# Ignore by path
~/personal/
```

The `search` and `remote` config blocks are managed by `clog search --init` and `clog remote add`.

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `CLOG_HOME` | Override the data directory (default: `~/.clog`) |
| `CLOG_DEBUG` | Bypass CLI error wrapping and surface raw stack traces |

## Documentation

- [docs/DESIGN.md](docs/DESIGN.md) — why clog is shaped the way it is
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the code is organized and where new work goes
- [docs/FORMATS.md](docs/FORMATS.md) — the normative on-disk and interchange formats
- [docs/SOURCE_FORMATS.md](docs/SOURCE_FORMATS.md) — where Claude Code and Codex CLI keep conversations, and what's inside

## Development

The `.nvmrc` file selects the Node.js 22 release line for version managers that support it.

To install the `clog` command globally from a local checkout:

```bash
git clone https://github.com/BFriedland/clog.git
cd clog
npm install            # Install dependencies and build (via the prepare script)
npm run setup          # Link the clog command globally and run clog init
```

```bash
npm test               # Run tests
npm run test:watch     # Watch mode
npm run test:coverage  # Run tests with coverage report
npm run lint           # Lint src/ and tests/
npm run knip           # Find unused files, exports, types, and dependencies
npm run build          # Build clog and fix bin permissions
npm run dev -- status  # Run without building
```
