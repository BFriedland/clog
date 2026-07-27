<p align="center">
  <img src="clog.png" alt="Clogs are a type of footwear that has a thick, rigid sole typically made of wood.">
</p>

# clog &middot; [![npm version](https://img.shields.io/npm/v/@getclog/clog)](https://www.npmjs.com/package/@getclog/clog) [![node version](https://img.shields.io/node/v/@getclog/clog)](https://nodejs.org) [![license](https://img.shields.io/npm/l/@getclog/clog)](LICENSE)

Conversation log exploration right in your terminal. Turn your AI coding agent conversations into a searchable, shareable knowledge base.

With clog, you can build a library from your Claude Code and Codex CLI conversations and make it available to your team and your agents. Use titles, summaries, and tags to curate it, then explore it through MCP tools, semantic search, and either archive- or git-based sharing.

## Requirements

Node.js 22 or newer is required to run clog.

## Install

```bash
npm install -g @getclog/clog
clog init
```

To install from a local checkout instead, see [Development](#development).

## Quick Start

```bash
# See conversations needing attention, grouped by project or listed individually
clog status
clog status -c

# Save all conversations for a project, to use with the clog MCP server
clog save myproject

# Browse and inspect
clog list
clog show a1b2c3 | less -R

# Create an archive of conversations and projects for sharing with your team
clog drain myproject -o my-project-export.zip

# Import a teammate's archive as read-only conversations
clog fill my-project-export.zip

# Work with a local coding agent of your choice to explore your knowledge base
clog talk
```

## Commands

Many clog commands work with either a project name or a conversation ID. Conversations can also be referenced by a short ID prefix of at least 4 characters, like git.

### Discovery & Curation

Unsaved conversations are fresh, read-only views of transcripts from enabled
Claude Code and Codex CLI sources; clog does not store them in its database.
Saving a conversation records the user's intent to add it to clog's durable
saved collection, where metadata edits, search indexing, export, and sync can
operate on it.

When a coding agent session is split across several resumable sessions, clog
groups them and shows the conversation once by default; `clog list
--all-branches` expands the group.

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

`clog show <id> --json` prints one structured conversation object for scripts,
while `clog show <id> --md` prints a document-ready transcript. The
`clog show <id> --raw` command emits the exact bytes from the same resolved
content path reported by `--path`; redirect any format with `>` to save it. The
three render-format flags are mutually exclusive. Message windows apply to the
terminal, JSON, and Markdown views, but cannot be combined with `--raw` or
`--path`.

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
| `list_conversations` | List saved conversations by default, collapsing branches unless `allBranches` is true |
| `get_conversation` | Load one requested saved conversation's coherent current transcript and branch-navigation metadata |
| `update_conversation` | Edit title, summary, structured extraction, or tags on saved local conversations |
| `browse_metadata` | List tags, projects, or authors |
| `search_conversations` | Semantic search (requires `clog search --init`) |
| `summarization_guide` | Read before summarizing — explains why summaries help, the extraction shape, and the quality bar |
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

Once configured, conversations are auto-indexed whenever you `clog save`, and save output reports whether indexing ran, was unavailable, or was not configured. Editing a conversation's title or summary re-indexes it. Use `clog index` to resume missing or stale indexing, and `clog index --rebuild` to re-index everything from scratch.

When coding-agent conversations branch from copied history, default semantic search and literal grep cover current branch endpoints rather than superseded generations. Semantic search returns one highest-scoring match from each branch graph. Copied history remains searchable through descendant branches; text unique to an abandoned generation remains available through direct retrieval or `clog list --grep "text" --all-branches`. Run `clog config set search.indexAllBranches true` to make superseded generations semantically searchable too, and pass `--all-branches` to `clog search` when each matching source conversation should appear separately.

If you skip vector search setup, `search_conversations` is unavailable, but agents can still use the `grep` filter on the `list_conversations` MCP tool for dependency-free keyword search across conversation titles, summaries, and message content. Set `allBranches: true` when that literal search should include superseded generations.

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

Running `clog drain` without a selector or selection filter asks for
confirmation before exporting saved local conversations. Scripts can use
`clog drain --yes` to export those saved local conversations without prompting.
`clog drain --include-imported` explicitly exports every saved local and
imported conversation without prompting. `--include-imported` cannot be
combined with a conversation selector, project selector, or selection filter,
and neither `--yes` nor `--include-imported` replaces an existing destination
without `--force`.

Import that export as read-only conversations:

```bash
clog fill ./my-project-export.zip
```

Restore the export as local saved clog conversations when you want to edit their title, summary, author, and tags:

```bash
clog fill ./my-project-export.zip --own
```

`clog drain myproject --format pair -o ./clog-export/` writes the same metadata
and JSONL files as an unpacked directory. Both drain formats export saved
conversations only; broad selections skip unsaved matches, and `clog drain
--include-imported` explicitly exports saved conversations across local and
imported origins.
Archive publication is atomic, so an existing file replaced with `--force`
remains unchanged until the complete new archive is ready.

Fill groups repeated skips that have the same reason, and drain shows only the
first detailed export failure by default. Re-run either command with
`--show-all-errors` to identify every affected conversation.

Archive input and output are limited to a 1 GiB zip file, 60,000 archive
records, and 2 GiB of selected pair data. Archive import validates and
extracts only `.jsonl` and `.meta.json` entries. The initial zip reader does
not verify CRC-32 or every inconsistent zip size declaration, so clog guarantees
compatibility with archives produced by the same clog version rather than broad
compatibility with every zip tool.

Both import forms write only to clog's stored conversation copies; they do not modify Claude Code or Codex CLI source conversations or make imports resumable there.

Because they contain complete conversation transcripts and are not encrypted,
archives generated by clog should only be shared through an access-controlled
channel.

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

## Development

Use Node.js 22 or newer for local development. The `.nvmrc` file selects the Node.js 22 release line for version managers that support it.

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
