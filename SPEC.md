# clog — Specification Document

## Team Conversation Knowledge Base for AI Coding Agents

---

## 0. About This Specification

This document is the authoritative description of clog's design and behavior. It is a generative specification — anyone (human or AI) should be able to implement a fully functional clog from this document alone, without access to any existing implementation.

### 0.1 What Belongs Here

Every user-facing behavior, architectural decision, data format, and convention that an implementer would need to produce a working system. Specifically:

- **Behavioral contracts:** What each command does, including edge cases and error handling conventions. If the system handles a scenario (e.g., a missing file, an ambiguous input), the spec should describe that handling.
- **Matching and filtering semantics:** How inputs are compared, matched, and resolved. Ambiguity here produces implementations that behave differently.
- **Data model and schema:** Tables, fields, types, constraints, and migration strategy.
- **Project structure:** File tree, module boundaries, and the purpose of each file.
- **Test inventory:** Which test files exist and what they cover. An implementer should know the expected test surface.
- **Design rationale:** Why a choice was made, when the reasoning isn't obvious from the choice itself. This prevents future implementers from "fixing" intentional decisions.

### 0.2 What Doesn't Belong Here

- Implementation details that are obvious from the behavioral contract (e.g., "use a for loop")
- Inline code beyond short illustrative snippets
- Aspirational features not yet implemented — these go in the roadmap (§12) or future-work sections

### 0.3 Maintaining the Spec

This specification is maintained independently of any codebase. It describes the intended system — not any particular implementation of it. Anyone may use it to produce their own clog. When a spec and an implementation diverge, either may be the one that needs updating — the spec may need to incorporate a design evolution, or the implementation may need to be corrected against the spec.

Updates to the spec should be deliberate and self-contained. When writing or revising:

- **Describe the intended behavior, not a delta.** Write as if the feature always existed. Don't use language like "now does X" or "was changed to Y."
- **Preserve density.** Match the existing prose style — concise, declarative, no filler.
- **Phase-specific content goes in its phase section.** Search behavior belongs in §10, team sharing behavior in §11.

---

## 1. Overview

### 1.1 Problem

Developers using AI coding agents (Claude Code, Codex CLI, etc.) generate hundreds of conversations containing valuable institutional knowledge: architectural decisions, debugging approaches, domain-specific patterns, and problem-solving strategies. This knowledge is:

- Trapped on individual machines in opaque local storage
- Unsearchable across the team
- Lost when machines are wiped or developers leave
- Invisible to other agents that could benefit from prior context

### 1.2 Solution

clog is a local-first CLI tool and MCP server that lets developers discover, curate, and share their AI coding agent conversations as a searchable team knowledge base.

### 1.3 Name

**clog** — Claude + Log. Lowercase `c` for the repo name and CLI command. Prose can use either case.

### 1.4 Assumptions

- **Team size:** <10 developers currently. The architecture (local SQLite, no auth) is appropriate for this scale.
- **Sensitivity:** Conversations are treated with the same security posture as source code. No special secrets-redaction pipeline, but developers have personal conversations on the same machines that must not leak into the knowledge base. Path filtering in config and the staging workflow address this.
- **Platform:** macOS (Apple Silicon), Windows 10/11, and Ubuntu Linux are all required. The tool must install with nothing more than `npm install` — no native compilation, no platform-specific build steps.

### 1.5 Design Principles

1. **Files as source of truth, database as index.** Conversation content lives in JSONL on disk; SQLite stores only metadata. (§2.1)
2. **Source locations are read-only.** clog never writes to, modifies, or deletes files in source locations like `~/.claude/`. (§4.1)
3. **Curation tool, not an observability tool.** clog helps developers share knowledge — not measure activity. No analytics, no dashboards, no per-author metrics. This boundary is intentional.
4. **Author-only publishing.** A developer publishes their own conversations. No mechanism exists for publishing, unpublishing, or retracting on behalf of another author.
5. **Git-like when the metaphor fits, not pretending to be Git.** Command vocabulary borrows from Git where natural, but clog's state model is its own. (§5)
6. **Optional features are inert until configured.** Search and sync ship in the codebase but do nothing until the user opts in. No setup cost for features you don't use.
7. **Missing things repair silently; corrupted things error clearly.** A deleted directory is recreated. Invalid JSON gets a descriptive error. (§7.3)
8. **No native dependencies.** Everything installs with `npm install` — no C++ toolchain, no platform-specific build steps. (§2.2)

---

## 2. Architecture

### 2.1 High-Level Components

```
┌─────────────────────────────────────────────────────┐
│  Developer's Machine                                │
│                                                     │
│  ┌──────────┐    ┌──────────┐    ┌───────────────┐  │
│  │ Source   │───▶│ clog     │───▶│ Metadata DB   │  │
│  │ Adapters │    │ CLI      │    │ (SQLite)      │  │
│  └──────────┘    └────┬─────┘    └───────────────┘  │
│                       │                             │
│                  ┌────▼─────┐    ┌───────────────┐  │
│                  │ MCP      │    │ Raw Files     │  │
│                  │ Server   │    │ (~/.clog/raw/)│  │
│                  └──────────┘    └───────────────┘  │
│                       │                             │
│                       │          ┌───────────────┐  │
│                       │          │ Vector DB     │  │
│                       │          │ (Phase 2)     │  │
│                       │          └───────────────┘  │
│                       │                             │
└─────────────────────────────────────────────────────┘
```

Phase 3 (§11) adds a git-based sync layer for team sharing. Phase 2 (§10) adds the vector DB for semantic search. Both are optional — Phase 1 is a complete system on its own.

**Design principle: files as source of truth, database as index.** Conversation content lives in raw JSONL files on disk. The SQLite database stores only metadata and state — enough to power listing, filtering, and the curation workflow. Full conversation content is read from files on demand. This keeps the database lightweight for `sql.js`'s in-memory loading model and avoids storing large tool outputs in the DB.

### 2.2 Tech Stack

**TypeScript on Node.js** for the entire project.

**Rationale:**

- The MCP TypeScript SDK (`@modelcontextprotocol/sdk`) is the most mature and best-documented MCP implementation. This is the strongest reason — the MCP server is a core deliverable, not a nice-to-have.
- LLM coding agents produce high-quality TypeScript reliably.
- The CLI, MCP server, and future web UI can share types and logic.

**Cross-platform requirement:** Must work on macOS (Apple Silicon), Windows 10/11, and Ubuntu Linux with nothing more than `npm install`. No native compilation, no C++ toolchain, no platform-specific build steps.

**SQLite via `sql.js`** (not `better-sqlite3`). `sql.js` compiles SQLite to WebAssembly and runs as pure JavaScript — it installs cleanly on every platform without node-gyp or a C++ toolchain. The tradeoff is that it loads the database into memory and is slower than native SQLite, but the database stores only metadata (no conversation content), so it will stay well under 10MB even at thousands of conversations. This makes sql.js a natural fit.

If `sql.js` performance ever becomes a problem (unlikely), the DB layer is isolated enough to swap in `better-sqlite3` later.

**`sql.js` persistence caveat:** Because `sql.js` operates entirely in memory, changes must be explicitly flushed to disk by writing the database buffer to the file. If the process crashes between an in-memory mutation and a flush, that mutation is lost. The flush strategy is **transaction-scoped**: each CLI command wraps its DB work in a logical transaction and flushes once at the end (e.g., scanning that inserts 100 rows flushes once, not 100 times). The MCP server flushes after each tool call completes. This is safe, correct, and avoids unnecessary disk writes.

**Concurrent access:** The MCP server and CLI can run simultaneously (e.g., a developer runs `clog add` while the MCP server is handling a query). Since `sql.js` loads the entire database into memory, concurrent writers risk last-write-wins data loss — one process's flush could overwrite the other's changes.

**Mitigation: file-based locking.** All database access is wrapped in a lockfile (`~/.clog/clog.db.lock`) using `proper-lockfile` (or a similar zero-native-dep package). The lock is acquired before loading the database into memory and released after flushing to disk. This serializes all DB access across processes:

1. Acquire lock on `~/.clog/clog.db.lock` (blocking, with a reasonable timeout — e.g., 5 seconds)
2. Load database from disk into `sql.js` memory
3. Perform mutations (the callback can be sync or async — `withDb` awaits the result before proceeding)
4. Flush (write buffer to `clog.db`)
5. Release lock

This means each CLI command or MCP tool call holds the lock for the duration of its DB work — typically milliseconds. The lock is advisory (not OS-enforced), but both the CLI and MCP server respect it, which is sufficient. If a process crashes while holding the lock, `proper-lockfile` detects stale locks via the lockfile's PID and cleans up automatically.

**Performance note:** This load-mutate-flush-release cycle means the database is re-read from disk on every operation rather than kept in memory. For the MCP server (which handles sequential tool calls), this adds a few milliseconds per call — negligible given the DB is under 10MB. If this becomes measurable, the MCP server could hold the lock longer (across multiple tool calls in a session), but this optimization is not needed initially.

**Key dependencies:**

| Package | Purpose |
|---------|---------|
| `@modelcontextprotocol/sdk` | MCP server implementation |
| `sql.js` | SQLite via WASM — cross-platform, zero native deps |
| `commander` | CLI framework |
| `glob` | File discovery |
| `chalk` | CLI output formatting |
| `proper-lockfile` | Cross-process file locking for DB access |
| `zod` | Schema validation |

**Platform-specific notes:**

- **macOS (M3):** Works out of the box with Node 18+.
- **Windows:** Use PowerShell or Git Bash. Paths use `path.join()` / `path.resolve()` everywhere — never hardcode `/` separators.
- **Linux (Ubuntu):** Works out of the box with Node 18+.
- **Path handling:** All file paths in the codebase must use Node's `path` module. The adapter's directory-name decoding (e.g., `-Users-alice-myproject`) must account for Windows paths (e.g., `-C-Users-alice-myproject`). Claude Code's storage layout on Windows should be verified during implementation; the exact rules for detecting a drive letter prefix vs. a regular path segment in encoded directory names need investigation.

### 2.3 Project Structure

```
clog/
├── src/
│   ├── cli/                 # CLI command handlers
│   │   ├── scan.ts          # Implicit source scanning
│   │   ├── add.ts           # Add conversations to staging
│   │   ├── reset.ts         # Reset conversations back to discovered
│   │   ├── edit.ts          # Edit conversation metadata
│   │   ├── publish.ts       # Publish to knowledge base
│   │   ├── unpublish.ts     # Unpublish conversations
│   │   ├── diff.ts          # Show new messages since last publish
│   │   ├── status.ts        # Show current state
│   │   ├── show.ts          # Display conversation content
│   │   ├── path.ts          # Print raw file path
│   │   ├── log.ts           # Show publish history
│   │   ├── list.ts          # List conversations with filters
│   │   ├── exclude.ts       # Exclude conversations from discovery
│   │   ├── unexclude.ts     # Reverse an exclusion
│   │   ├── tag.ts           # Add tags
│   │   ├── untag.ts         # Remove tags
│   │   ├── config.ts        # View/edit configuration
│   │   ├── excluded.ts      # Excluded file read/write
│   │   ├── clogignore.ts    # Pattern-based discovery filtering
│   │   ├── colors.ts        # State-based color helpers
│   │   ├── rename-author.ts # Bulk author rename across conversations
│   │   └── scan-command.ts  # Diagnostic: list all source conversations with state
│   ├── adapters/            # Source-specific conversation parsers
│   │   ├── adapter.ts       # Base adapter interface
│   │   └── claude-code.ts   # Claude Code (~/.claude/)
│   ├── mcp/                 # MCP server
│   │   ├── server.ts        # MCP server setup + stdio transport
│   │   └── handlers.ts      # Tool handler implementations (extracted for testability)
│   ├── db/                  # Database layer
│   │   ├── schema.ts        # Table definitions + migrations
│   │   └── index.ts         # Query functions
│   ├── config/              # Config loading, path resolution, init
│   │   ├── index.ts         # Path helpers (getClogHome, etc.)
│   │   ├── schema.ts        # Zod schema, load/save
│   │   └── init.ts          # First-run init + health checks
│   ├── models/              # Shared types
│   │   └── conversation.ts
│   └── index.ts             # CLI entry point
├── package.json
├── tsconfig.json
├── tsconfig.eslint.json     # Extends tsconfig.json, includes tests for linting
├── eslint.config.js         # Minimal lint rules (unused vars, floating promises)
└── CLAUDE.md                # Instructions for coding agents working on this project
```

Phase 2 (§10) adds: `src/search/`, plus CLI files (`search.ts`, `search-init.ts`, `index-cmd.ts`)
Phase 3 (§11.15) adds: `src/sync/`, plus CLI files (`remote.ts`, `sync.ts`, `refresh.ts`)

---

## 3. Data Model

### 3.1 Conversation Metadata

The database stores metadata about conversations. Full content (messages, tool use, tool results) lives in raw JSONL files on disk and is parsed on demand when needed (e.g., `clog show`, MCP `clog_get`).

```typescript
interface ConversationMeta {
  // Identity
  id: string;                    // Same as sourceId — the UUID from the source system
  sourceId: string;              // Original ID (e.g., UUID from filename). Same as id for now.
  source: "claude-code" | "codex-cli" | string;

  // Metadata
  title: string;                 // Auto-generated or user-provided
  summary: string;               // Auto-generated summary (can be edited)
  author: string;                // Developer who had the conversation
  project: string | null;        // Project directory name, if detectable
  tags: string[];                // User-applied tags
  slug: string | null;           // Human-readable name (e.g., "breezy-coalescing-pony")

  // Timestamps
  createdAt: string;             // ISO 8601 (from source)
  discoveredAt: string;          // When clog first saw it
  modifiedAt: string;            // Last metadata edit

  // State
  state: "discovered" | "staged" | "published";
  publishedAt: string | null;
  publishVersion: number;        // Increments on re-publish after edits

  // File references
  sourcePath: string;            // Original file path in source location (e.g., ~/.claude/...)
  filePath: string | null;       // Path to raw JSONL copy in ~/.clog/raw/ (null until add)
  sourceMtime: string | null;    // ISO 8601 mtime of source file at last scan

}
```

Phase 2 (§10) adds: `indexedAt`
Phase 3 (§11.4) adds: `origin`

### 3.2 Message Format (On-Demand Parsing)

When full conversation content is needed, the raw JSONL file is parsed into this format:

```typescript
interface Message {
  role: "user" | "assistant" | "tool_use" | "tool_result";
  content: string;
  timestamp: string | null;
  // Tool use metadata preserved for display
  toolName?: string;
  toolInput?: unknown;
}
```

**Normalization from raw JSONL to Messages:** The Claude Code JSONL format (Section 4.2) uses nested content blocks within assistant messages — a single assistant response may contain `text`, `thinking`, and `tool_use` blocks. The adapter flattens these into the `Message` format as follows:

- Raw user line with `content: string` → `Message` with `role: "user"`
- Raw assistant `text` content block → `Message` with `role: "assistant"`, `content` = the text
- Raw assistant `tool_use` content block → `Message` with `role: "tool_use"`, `toolName` / `toolInput` populated
- Raw user line with `tool_result` content block → `Message` with `role: "tool_result"`, `content` = status summary (e.g. `"Read: ok"`, `"Bash: error"`), `toolName` from the matching tool_use. The actual tool output is stripped — it's bulk content (file dumps, command output) that would bloat MCP payloads. The `is_error` field from the JSONL determines the status.
- Raw assistant `thinking` content blocks → **stripped during normalization** (internal model reasoning, not useful for the knowledge base)

### 3.3 Short ID Prefixes

Full conversation IDs are UUIDs from the source system (e.g., `c7044ea5-c019-44d6-a77a-500036740f9a`). The CLI displays and accepts short prefixes, similar to Git:

- **Display:** All commands that show IDs use the first 7 characters by default (e.g., `c7044ea`).
- **Input:** Any command that accepts an ID resolves short prefixes by querying the database with a `LIKE 'prefix%'` match. If the prefix is ambiguous (matches multiple conversations), the command errors with a message showing the conflicting matches and asking for more characters.
- **Minimum prefix length:** 4 characters. Shorter prefixes are rejected.

### 3.4 SQLite Schema

```sql
-- Schema version tracking
CREATE TABLE schema_version (
  version INTEGER NOT NULL
);

-- Core conversations table (metadata only — content lives on disk)
CREATE TABLE conversations (
  id              TEXT PRIMARY KEY,
  source_id       TEXT NOT NULL,
  source          TEXT NOT NULL,
  title           TEXT NOT NULL,
  summary         TEXT DEFAULT '',
  author          TEXT NOT NULL,
  project         TEXT,
  tags_json       TEXT DEFAULT '[]',   -- JSON array of strings
  slug            TEXT,                -- Human-readable conversation name
  created_at      TEXT NOT NULL,
  discovered_at   TEXT NOT NULL,
  modified_at     TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'discovered'
                  CHECK(state IN ('discovered','staged','published')),
  published_at    TEXT,
  publish_version INTEGER DEFAULT 0,
  source_path     TEXT NOT NULL,       -- Original file path in source location
  file_path       TEXT,               -- Path to raw JSONL copy in ~/.clog/raw/ (null until add)
  source_mtime    TEXT,               -- ISO 8601 mtime of source file at last scan
  UNIQUE(source, source_id)
);

-- Publish history (lightweight log)
CREATE TABLE publish_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  version         INTEGER NOT NULL,
  published_at    TEXT NOT NULL,
  author          TEXT NOT NULL,
  message         TEXT DEFAULT '',     -- Optional commit-style message
  diff_json       TEXT                 -- Optional: what changed from prior version
);
```

#### 3.4.1 Schema Versioning and Migration

The `schema_version` table tracks the current schema version as a single integer. On startup, the DB layer compares this against the expected version and runs migrations for any versions in between.

Migrations are version-gated: each migration checks `currentVersion < N` and applies the necessary ALTER TABLE or other DDL statements. If a migration's change already exists (e.g., a column was added in a fresh install that includes it in the CREATE TABLE), the migration handles this gracefully (e.g., catching "column already exists" errors).

Fresh installs create all tables with the latest schema and set the version to the current value. Existing databases are migrated incrementally.

| Version | Changes |
|---------|---------|
| 1 | Initial schema (Phase 1) |

Phase 2 (§10) adds: `indexed_at` column
Phase 3 (§11.4) adds: `origin` column (migration version 2)

**What's NOT in the database:** Full message content, tool outputs, raw conversation text. These live in the JSONL files — at `file_path` (the `~/.clog/raw/` copy) for staged/published conversations, or at `source_path` (the original source location) for discovered conversations. This keeps the database small (a few KB per conversation) so that `sql.js` can load it into memory instantly, even at thousands of conversations.

### 3.5 Storage Location

```
~/.clog/
├── clog.db                  # SQLite database — metadata only (~5MB at scale)
├── config.json              # User configuration
├── excluded                 # Auto-managed list of source:sourceId pairs (plumbing)
├── clogignore               # User-edited pattern rules for discovery filtering
└── raw/                     # Source JSONL files (copied on add)
    ├── claude-code/
    │   ├── abc123.jsonl
    │   └── def456.jsonl
    └── codex-cli/           # Future
```

On Windows, the default location is `%USERPROFILE%\.clog\` (resolved via `os.homedir()`). The `CLOG_HOME` environment variable overrides this on all platforms.

**Raw file copies and disk usage:** `clog add` copies the source JSONL file into `~/.clog/raw/`. Before that, clog reads from the source location directly (read-only). This avoids doubling disk usage for conversations the developer never intends to curate.

Phase 3 (§11.3) adds: `remote/` directory for the git checkout

---

## 4. Source Adapters

### 4.1 Adapter Interface

```typescript
interface SourceAdapter {
  /** Unique name for this source */
  name: string;

  /** Discover all conversations on this machine, extracting metadata only */
  discover(): AsyncIterable<DiscoveredConversation>;

  /** Parse a raw JSONL file into structured messages (on demand) */
  parseMessages(filePath: string): Promise<Message[]>;

  /** Return the paths this adapter watches for new conversations */
  watchPaths(): string[];
}

interface DiscoveredConversation {
  sourceId: string;
  sourcePath: string;          // Original file path in source location
  metadata: {
    title: string;             // First human message, truncated to 100 chars
    summary: string;           // From summary line, or empty
    project: string | null;    // Decoded from directory name
    slug: string | null;       // Human-readable name
    createdAt: string;         // Earliest timestamp in file
  };
}
```

**Source locations are read-only.** Adapters must never write to, modify, or delete files in source locations (e.g., `~/.claude/`). clog only reads from sources during discovery and full parsing. All clog-managed state lives in `~/.clog/`.

**Two-phase parsing design:**

1. **Discovery (lightweight):** Scans JSONL files, extracts only metadata (title, summary, project, dates, slug). Does NOT parse all messages or load full content into memory. This keeps discovery fast even with large files — it can stop reading after finding the first human message and the summary line.
2. **On-demand (full parse):** When `clog show` or MCP `clog_get` needs the full conversation, `parseMessages()` reads and parses the entire JSONL file. This is where deduplication by `message.id`, timestamp ordering, and message normalization happen.

### 4.2 Claude Code Adapter (MVP)

Claude Code stores conversations in `~/.claude/projects/` as JSONL files. The directory structure encodes the project path:

```
~/.claude/projects/
├── -Users-alice-myproject/
│   ├── abc123.jsonl                        # One conversation per file
│   ├── abc123/
│   │   └── subagents/
│   │       ├── agent-aprompt_suggestion-*.jsonl  # Prompt suggestion subagents (skip)
│   │       └── agent-a<id>.jsonl                 # Task subagents (include)
│   └── def456.jsonl
└── -Users-alice-other-repo/
    └── ghi789.jsonl
```

The filename (without `.jsonl`) is a UUID that serves as the `sessionId` / `sourceId`. Each `.jsonl` file contains one JSON object per line.

**Subagent conversations:** Each main conversation may have a `<sessionId>/subagents/` directory containing JSONL files for subagent (Task tool) conversations. These come in two types:
- **`agent-aprompt_suggestion-*.jsonl`** — Internal UI prompt suggestions. These have `isSidechain: true` on every line and contain no meaningful conversation content. **Skip these entirely.**
- **`agent-a<hex-id>.jsonl`** — Task subagent conversations (e.g., Explore, Bash agents). These contain real work product. **Include these** as part of the parent conversation's content, or as linked conversations (implementation can decide). They also have `isSidechain: true`.

#### 4.2.1 JSONL Line Schema

Each line is a JSON object with a `type` field. The following types exist:

| `type` | Purpose | Relevant to clog? |
|--------|---------|-------------------|
| `user` | Human message or tool result | **Yes** — primary content |
| `assistant` | Model response (text, tool_use, thinking) | **Yes** — primary content |
| `system` | Metadata entries (turn duration, etc.) | **No** — skip. Has `subtype` field (e.g., `"turn_duration"`) |
| `progress` | Real-time progress updates (hook events, agent spawning) | **No** — skip |
| `file-history-snapshot` | File backup tracking for undo | **No** — skip |
| `summary` | Claude Code's own conversation summary | **Yes** — use as default summary if present |
| `queue-operation` | Background task queue events | **No** — skip |

#### 4.2.2 Common Fields on Every Line

```typescript
interface JSONLLine {
  type: "user" | "assistant" | "system" | "progress" | "file-history-snapshot" | "summary" | "queue-operation";
  uuid?: string;                // Unique ID for this line
  parentUuid?: string | null;   // Links to parent message (forms a tree, not a flat list)
  sessionId?: string;           // Conversation UUID (matches filename)
  timestamp?: string;           // ISO 8601
  isSidechain?: boolean;        // true for subagent entries
  cwd?: string;                 // Working directory at time of message
  version?: string;             // Claude Code version (e.g., "2.1.49")
  slug?: string;                // Human-readable conversation name (e.g., "breezy-coalescing-pony")
  userType?: string;            // Always "external" in observed data
  gitBranch?: string;           // Active git branch
}
```

#### 4.2.3 User Messages (`type: "user"`)

Two variants:

**Human-typed message:**
```typescript
{
  type: "user",
  message: {
    role: "user",
    content: string            // Plain text typed by the human
  },
  uuid: string,
  timestamp: string,
  sessionId: string,
  // Optional fields present on human-initiated messages:
  todos?: unknown[],           // Task list state (ignore)
  permissionMode?: string      // Permission mode (ignore)
}
```

**Tool result (auto-generated after assistant tool_use):**
```typescript
{
  type: "user",
  message: {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: string,    // References the tool_use block's id
        content: string         // Tool output (file contents, command output, etc.)
      }
    ]
  },
  toolUseResult?: {             // Structured result metadata
    type: string,               // e.g., "text"
    file?: { filePath: string, content: string }
  },
  sourceToolAssistantUUID?: string  // Links back to the assistant message that made the tool call
}
```

**Distinguishing the two:** If `message.content` is a string → human message. If `message.content` is an array containing `tool_result` blocks → tool result.

#### 4.2.4 Assistant Messages (`type: "assistant"`)

```typescript
{
  type: "assistant",
  message: {
    model: string,              // e.g., "claude-opus-4-6"
    id: string,                 // API message ID (e.g., "msg_01X...")
    type: "message",
    role: "assistant",
    content: ContentBlock[],    // Array of content blocks (see below)
    stop_reason: string | null, // "end_turn", "tool_use", null (streaming)
    usage: { ... }              // Token usage (ignore for clog)
  },
  requestId?: string,
  slug?: string
}
```

**Content block types within `message.content`:**

```typescript
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown>; caller?: { type: string } }
```

**Important:** Multiple assistant lines may share the same `message.id` — Claude Code writes a new JSONL line as each content block streams in from the API. A single model response (one API call) may produce 3–5 JSONL lines: one for initial text, one for thinking, one per tool_use block. **Deduplicate by `message.id`**: collect all content blocks from lines sharing the same `message.id` into a single logical message.

#### 4.2.5 Summary Lines (`type: "summary"`)

```typescript
{
  type: "summary",
  summary: string,              // Human-readable conversation summary
  leafUuid: string              // UUID of the last message when summary was generated
}
```

Not all conversations have a summary line — only longer ones that Claude Code auto-summarizes. When present, use this as the conversation's default `summary` field. A conversation file may contain at most one summary line (found at the end of the file or near the end).

#### 4.2.6 Adapter Discovery Behavior

During discovery (lightweight metadata extraction), the adapter will:

1. Glob `~/.claude/projects/*/*.jsonl` for main conversations (direct children of project dirs)
2. Optionally glob `~/.claude/projects/*/*/subagents/agent-a[!p]*.jsonl` for task subagents (excluding `prompt_suggestion` files)
3. Decode the directory name to recover the project path (e.g., `-Users-alice-myproject` → `/Users/alice/myproject`)
4. Scan each JSONL file for metadata only:
   a. Find the first `type: "user"` line where `message.content` is a string → use as title (truncated to 100 chars)
   b. Find the `type: "summary"` line if present → use as summary
   c. Extract the first `timestamp` found → use as `createdAt`
   d. Extract the `slug` field from any line that has it
   e. Stop scanning early once all metadata is found — no need to parse the full file
5. Use the filename (without `.jsonl`) as both the `sourceId` and the conversation `id` — this is a UUID (e.g., `"c7044ea5-c019-44d6-a77a-500036740f9a"`)

#### 4.2.7 Adapter Full Parse Behavior

When full conversation content is needed (`parseMessages()`), the adapter will:

1. Read the entire JSONL file
2. Filter to `type: "user"` and `type: "assistant"` lines
3. Skip `system`, `progress`, `file-history-snapshot`, `queue-operation` lines
4. For assistant messages, deduplicate by `message.id` — merge content blocks from lines sharing the same API message ID
5. Strip `thinking` content blocks
6. Order messages by `timestamp`
7. Normalize into the `Message[]` format (Section 3.2)

**Edge cases the adapter must handle:**
- Files containing only `file-history-snapshot` lines (no actual messages) — skip, treat as empty
- Files where `sessionId` is absent on some lines — use the filename UUID as canonical
- `message.content` can be either a `string` (user text) or an `array` (content blocks) — handle both
- Very large conversations (500+ JSONL lines, many of which are `progress` noise) — filter early
- The `parentUuid` field forms a tree (for branching conversations / sidechains) — for MVP, flatten to chronological order by `timestamp` and ignore branching

### 4.3 Codex CLI Adapter (Future)

Stub the adapter interface now. Implementation deferred until after the Claude Code adapter is working. Codex CLI stores conversations in a different location and format that will need investigation.

---

## 5. CLI Commands

The CLI is the primary interface for developers. The command vocabulary is deliberately Git-like where the metaphor fits, but avoids pretending to be Git.

### 5.1 Command Reference

```
clog init                  Initialize clog (runs automatically on first use)
clog status                Show staged/discovered conversations + scan filter counts
clog list [filters]        List conversations (default: staged + published)
clog add <id...>           Stage conversation(s) (copies source file to ~/.clog/raw/)
clog add --all             Add all discovered conversations
clog add --project X       Add all discovered conversations for a project
clog reset <id...>         Move conversation(s) back to discovered
clog exclude <id...>       Delete conversation(s) and permanently block re-discovery
clog unexclude <id...>     Remove conversation(s) from the excluded list
clog edit <id> [flags]     Edit conversation metadata (--title, --summary, --author)
clog tag <id> <tags...>    Add tags to a conversation
clog untag <id> <tags...>  Remove tags from a conversation
clog publish [id...]       Publish conversations to the knowledge base
clog unpublish <id...>     Move published conversation(s) back to staged
clog log                   Show publish history
clog diff [id...]           Show new messages since last publish
clog diff --staged [id...]  Show full content of staged conversations
clog show <id>             Display a conversation's content and metadata
clog show <id> --path      Print the file path (raw copy if staged/published, source if discovered)
clog show <id> --head N    Show only the first N messages (--first is an alias)
clog show <id> --tail N    Show only the last N messages (--last is an alias)
clog path <id>             Print the file path (shorthand for show --path)
clog config [get|set]      View or edit configuration
clog rename-author <old> <new>  Rename author across local conversations

# Phase 2 — Semantic Search (see §10 for details)
clog search --init         Set up semantic search
clog search <query>        Semantic search across published conversations
clog index [--rebuild]     Index published conversations for search

# Phase 3 — Team Sharing (see §11 for details)
clog remote add <url>      Configure a git remote for team sharing
clog remote show           Show remote configuration and sync status
clog remote remove         Remove remote and purge conversations from the configured remote
clog sync push             Push published conversations to the remote
clog sync pull             Pull conversations from the remote
clog refresh               Reconcile DB from git checkout without fetching
```

All commands that accept `<id>` also accept short prefixes (minimum 4 characters). See Section 3.3 for details.

### 5.2 Workflow

A typical session looks like:

```bash
# 1. See what's new (scanning happens automatically)
$ clog status
Conversations to be published:
  (use "clog reset <id>" to unstage)
    added:         a1b2c3d  2026-02-18  api-service      Debug auth token refresh logic

Changes not staged for publishing:
  (use "clog publish <id>" to update the published version)
    modified:      b2c3d4e  2026-02-15  api-service      Set up CI pipeline

Conversations not staged for publishing:
  (use "clog add <id>" to stage for publishing)
    discovered:    d4e5f6a  2026-02-18  api-service      Add rate limiting middleware
    discovered:    g7h8i9b  2026-02-17  frontend         Fix SSR hydration mismatch

(23 excluded, 8 filtered by config, 4 ignored by clogignore)

# 2. Review discovered conversations
$ clog list --state discovered
ID       DATE        STATE       PROJECT          TITLE
d4e5f6a  2026-02-18  discovered  api-service      Add rate limiting middleware
g7h8i9b  2026-02-17  discovered  frontend         Fix SSR hydration mismatch
...

# 3. Add interesting ones
$ clog add a1b2c3 d4e5f6
Added 2 conversations

# 4. Tag them
$ clog tag a1b2c3 auth debugging
$ clog tag d4e5f6 rate-limiting middleware

# 5. Fix a title
$ clog edit a1b2c3 --title "Debug JWT refresh race condition"

# 6. Publish
$ clog publish
Publishing 2 conversations...
Published a1b2c3 (v1): "Debug JWT refresh race condition"
Published d4e5f6 (v1): "Add rate limiting middleware"

# 7. Get the raw file path for a conversation
$ clog path a1b2c3
/Users/alice/.clog/raw/claude-code/a1b2c3.jsonl

# 8. View full conversation content
$ clog show a1b2c3
```

### 5.3 The `list` Command

`clog list` with no flags shows **staged + published** conversations — the curated set. This matches the mental model that `list` shows what you're working with, while `status` shows what needs attention.

**Flags:**

| Flag | Short | Description |
|------|-------|-------------|
| `--state <state>` | `-s` | Filter by state (`discovered`, `staged`, `published`) |
| `--all` | | Show all conversations including discovered and excluded |
| `--project <name>` | `-p` | Filter by project |
| `--author <name>` | `-a` | Filter by author |
| `--tag <tag>` | `-t` | Filter by tag |
| `--grep <text>` | `-g` | Filter by text match on title/summary |
| `--origin <origin>` | | Filter by origin (`local`, `remote`) — see §11.10 |
| `--columns <cols>` | `-c` | Columns to show (comma-separated: `id,date,state,project,author,title`, or `all`) |

```bash
# Filter by state
$ clog list --state discovered

# Show everything, including discovered and excluded (excluded shown dimmed)
$ clog list --all

# Filter by project, author, tag, or text search
$ clog list -p api-service
$ clog list -a alice
$ clog list -t debugging
$ clog list -g "auth"

# Combine filters
$ clog list -s published -p api-service -g "token"

# Control which columns appear
$ clog list --columns all
$ clog list -c id,date,title
```

Columns are dynamically sized to the terminal width. The `author` column is auto-shown when multiple distinct authors are present, even without `--columns`.

`--project` matches against the **last path component** (basename) of the conversation's project directory, using case-insensitive exact matching. Users pass `api-service`, not `/Users/alice/work/api-service`. LIKE wildcards (`%`, `_`) in the project name are escaped to prevent injection in DB queries.

`--grep` performs a simple case-insensitive substring match against the `title` and `summary` fields. A conversation matches if either field contains the search text. This is deliberately simple — it's not regex, not full-text search, not semantic. It's the equivalent of piping through `grep -i` and is intended to remain useful alongside semantic search (Section 10), since it's fast, predictable, and doesn't require any additional dependencies.

### 5.4 The `edit` Command

`clog edit` modifies conversation metadata in the database. It uses CLI flags — there is no interactive mode or editor integration.

```bash
# Set title
$ clog edit a1b2c3 --title "Debug JWT refresh race condition"

# Set summary
$ clog edit a1b2c3 --summary "Walked through a race condition in token refresh..."

# Set author
$ clog edit a1b2c3 --author alice

# Combine flags
$ clog edit a1b2c3 --title "..." --summary "..."

# No flags → print help
$ clog edit a1b2c3
Usage: clog edit <id> [options]
  --title <text>    Set the conversation title
  --summary <text>  Set the conversation summary
  --author <name>   Set the conversation author
```

The `--author` flag changes the author on an individual conversation. This is distinct from `clog config set author` (which changes the default for future operations) and `clog rename-author` (which renames an author across all local conversations).

Tags are managed separately via `clog tag` / `clog untag`. Staging is managed via `clog add` / `clog reset`.

If every supplied value already matches the current metadata, `clog edit` is a no-op: it does not update `modified_at` and reports that nothing changed.

**Message-level editing is not supported.** If a user needs to redact sensitive data from conversation content, they should edit the raw JSONL file directly:

```bash
$ clog path a1b2c3
/Users/alice/.clog/raw/claude-code/a1b2c3.jsonl

# User opens and edits the file with their preferred editor
```

### 5.4.1 The `tag` and `untag` Commands

`clog tag` and `clog untag` manage the `tags` array on a conversation's metadata row. They operate on any local conversation already tracked in the database; remote conversations are read-only and are rejected (see §11.6).

```bash
# Add tags
$ clog tag a1b2c3 auth debugging

# Remove tags
$ clog untag a1b2c3 debugging
```

**Normalization:** Input tags are trimmed, lowercased, and deduplicated before applying the operation. Empty tags are ignored.

**`clog tag`:** Adds tags that are not already present. Existing tags are preserved.

If every requested tag is already present, `clog tag` is a no-op: it does not update `modified_at` and reports that no new tags were added.

**`clog untag`:** Removes tags that are present. Tags that are not currently on the conversation are ignored.

If none of the requested tags are present, `clog untag` is a no-op: it does not update `modified_at` and reports that no matching tags were found.

### 5.5 Implicit Scanning

There is no explicit `discover` command. Scanning for new and updated conversations happens automatically when relevant commands run (`status`, `list`, `add`). This mirrors how `git status` automatically reads the working tree — developers see the current state without an extra step.

**Scanning behavior:**

Scanning is idempotent. Each scan will:

- Find new conversations not yet in the database → insert as `discovered`
- Skip conversations whose source file hasn't changed (matched by `source + sourceId`, checked via `source_mtime`)
- **Detect updated source files** for conversations in any state. When a source file's mtime has changed since last scan:
  - For `discovered` conversations: re-extract metadata (title, summary may change as the conversation grows)
  - For `staged`/`published` conversations: **preserve** user-edited metadata (title, summary, tags). Update `modified_at`. Re-copy the raw file in `~/.clog/raw/` if one exists.
- **Detect moved source files.** When a known conversation's `sourcePath` no longer matches the path returned by the adapter (e.g., the project directory was renamed), update `sourcePath` in the DB. For `discovered` conversations, also update `project`. For `staged`/`published`, preserve user-edited metadata.
- **Prune stale entries.** After discovery completes, remove `discovered`-state DB entries whose source files are no longer found by the adapter. Only entries whose `sourcePath` falls under a scanned source directory are pruned — entries from unscanned paths are left alone. Staged and published conversations are never pruned (they have their own copies in `~/.clog/raw/`). The scan reports a `pruned` count alongside other filter counts.

**Graceful handling of missing sources in `clog add`.** If a source file has been deleted between scan and add, `clog add` prints a warning, deletes the stale DB entry, and skips the conversation rather than crashing.

**No file copying during scan.** Raw JSONL files are not copied to `~/.clog/raw/` until `clog add`. Before that, clog reads metadata from the source location directly (read-only). This avoids doubling disk usage for conversations the developer never intends to curate.

**Performance:** Scan results are cached in the database. Subsequent scans skip unchanged files (matched by `source + sourceId`, checked via `source_mtime`), keeping scanning fast even with hundreds of conversations. The adapter's early-stop strategy (read first user message + summary line, skip the rest) keeps initial scans fast too. If scanning latency becomes an issue at thousands of conversations, this is an optimization target — but the mtime-based caching should handle typical scale well.

**Filtering personal conversations:** Developers use personal laptops and will have conversations unrelated to the company. Scanning respects three layers of filtering:

- `config.json` `includePaths` / `excludePaths` for persistent directory-level filtering
- `~/.clog/clogignore` for pattern-based rules (see Section 5.10)
- `~/.clog/excluded` for individually excluded conversations (see Section 5.10)

The config file supports `sources.claude-code.includePaths` and `sources.claude-code.excludePaths`. If `includePaths` is set, only conversations from those project directories are discovered. If `excludePaths` is set, those directories are skipped. Both can be used together. This is the primary mechanism for keeping personal conversations out of the knowledge base.

### 5.6 The `publish` Command

Publishing is a local operation in Phase 1. It:

1. Changes the conversation's state to `published` (from either `discovered` or `staged`)
2. Increments `publish_version` if re-publishing after edits
3. Writes a row to `publish_log` with optional message

```bash
# Publish all staged
$ clog publish

# Publish specific conversations (works from any state — discovered or staged)
$ clog publish a1b2c3 d4e5f6

# Publish with a message
$ clog publish -m "Auth debugging sessions from this sprint"
```

When called with no arguments, `clog publish` publishes all staged conversations. When called with explicit IDs, it publishes those conversations regardless of current state — staging is a workflow aid, not a gate. If a conversation hasn't been staged yet (no raw file copy), publish implicitly copies the source file to `~/.clog/raw/` before publishing.

**Why `publish` and not `commit`?** This is intentional. Git `commit` creates a permanent, immutable snapshot with a hash. `clog publish` is a state change — conversations can be edited and re-published. Calling it `commit` would set wrong expectations about immutability, revert semantics, and diff history. `publish` communicates what actually happens: "this conversation is now visible to agents and (eventually) teammates."

### 5.7 The `unpublish` Command

`clog unpublish` moves published conversations back to the `staged` state. The raw file in `~/.clog/raw/` is preserved — the conversation is still tracked, just no longer visible to agents via the MCP server.

```bash
# Unpublish specific conversations
$ clog unpublish a1b2c3 d4e5f6
Unpublished 2 conversations (moved to staged)
```

This is a local state change. Phase 3 (§11.7) extends this: unpublishing a previously-synced conversation propagates as a retraction on the next `sync push`.

### 5.8 The `diff` Command

`clog diff` shows what changed since last publish, mirroring `git diff`:

```bash
# Show new messages in all modified published conversations
$ clog diff

# Show new messages in a specific conversation
$ clog diff a1b2c3

# Show full content of all staged conversations (what publish would publish)
$ clog diff --staged

# Show full content of a specific staged conversation
$ clog diff --staged a1b2c3

# Limit output to first or last N messages
$ clog diff --head 5          # first 5 new messages
$ clog diff --tail 3          # last 3 new messages
$ clog diff --first 5         # alias for --head
$ clog diff --last 3          # alias for --tail
```

**Default mode (no `--staged`):** Filters messages by `timestamp > publishedAt` to show only what was added since the last publish. Each conversation gets a header:

```
--- a1b2c3d "Debug JWT refresh race condition" (3 new messages since v1)
```

With no arguments and no modified conversations, `clog diff` produces no output (like `git diff` on a clean tree).

**`--head`/`--first` and `--tail`/`--last`:** Limit the number of messages shown per conversation. `--head N` shows the first N messages, `--tail N` shows the last N. `--first` and `--last` are aliases. Cannot be combined. The header indicates when output is truncated (e.g., "showing 5 of 23 new messages").

**`--staged` mode:** Shows the full conversation content for staged conversations — a preview of what `clog publish` would publish. With no arguments, shows all staged conversations.

### 5.9 CLI Coloring

CLI output uses coloring to communicate state at a glance:

- **Green** — staged (added) conversations, ready to publish
- **Red** — discovered conversations not yet staged, and published conversations modified since last publish
- **Dim** — excluded conversations (visible in `clog list --all`)
- Default (no color) — published conversations

This applies to `clog status`, `clog list`, and any other command that displays conversation state.

### 5.10 The `exclude` Command and `clogignore`

There are two mechanisms for keeping conversations out of the knowledge base, serving different purposes.

**`clog exclude <id>` — explicit removal of specific conversations:**

1. Deletes the conversation from the database
2. Appends `source:sourceId` to `~/.clog/excluded`
3. Future scans check this file and skip matching entries

The `excluded` file is plumbing — machine-managed, one entry per line:

```
claude-code:abc123
claude-code:def456
```

Developers shouldn't need to edit it by hand, but it's plain text if they do.

`clog exclude` deletes the raw file from `~/.clog/raw/` if one exists. When a user explicitly excludes a conversation, they expect it gone from clog — leaving orphaned copies would be surprising and potentially problematic for conversations with sensitive content.

**`clog unexclude <id>` — reverse an exclusion:**

Accepts a conversation ID (or short prefix). Looks up the corresponding `source:sourceId` entry in `~/.clog/excluded` and removes it. The conversation will be picked up again on the next scan — if the source file still exists in `~/.claude`, it will reappear as discovered. The user would then need to `clog add` it again to copy the raw file. If the source file is also gone, the conversation simply won't come back. That's the expected behavior.

`clog unexclude` does not accept `--all`. Reversing exclusions should be deliberate and specific.

**`~/.clog/clogignore` — pattern-based rules for discovery filtering:**

A human-editable file checked during scanning. Conversations matching any rule are skipped and never inserted into the database.

```
# Ignore conversations from personal project directories
project:~/personal/*
project:~/side-projects/*

# Ignore conversations older than a date
before:2025-06-01
```

**Supported patterns (MVP):**

| Pattern | Matches on | Example |
|---------|-----------|---------|
| `project:<glob>` | Project directory path (after decoding from source) | `project:~/personal/*` |
| `before:<date>` | Conversation creation date (ISO 8601) | `before:2025-01-01` |
| `after:<date>` | Conversation creation date | `after:2026-12-31` |

Lines starting with `#` are comments. Blank lines are ignored. Globs use standard `*` matching on normalized, `~`-expanded paths.

**Not included in MVP:** `title:` pattern matching. Title-based filtering sounds useful but is fragile — it matches against the first human message before it's been parsed, truncated, or cleaned, and silent mismatches would be hard to debug. Defer until there's a demonstrated need.

**Evaluation order during scanning:**

1. Scan source location, compute `source:sourceId` for each file
2. Check `excluded` file — if listed, skip (counted as "excluded")
3. Check `config.json` `includePaths` / `excludePaths` — if filtered out, skip (counted as "filtered")
4. Check `clogignore` patterns — if any rule matches, skip (counted as "ignored")
5. Check database — if already tracked, skip or update (check mtime for changes)
6. Parse the file for metadata, insert into DB as `discovered`

**Scan output must report filtering.** Developers need to trust that their personal conversations aren't leaking in. `clog status` shows a filter summary line at the bottom when any conversations were filtered:

```
(23 excluded, 8 filtered by config, 4 ignored by clogignore)
```

The line is dimmed and only appears if at least one count is non-zero.

`excluded` and `clogignore` are strictly local — they are never synced to a remote (see §11).

### 5.11 Error Handling

All CLI commands use a consistent error handling wrapper:

- **Normal mode:** Errors are caught and printed to stderr as `error: <message>`. The exit code is set to 1 via `process.exitCode` (graceful cleanup, no abrupt termination). Stack traces are hidden.
- **Debug mode (`CLOG_DEBUG=1`):** The wrapper is bypassed, so errors propagate with full stack traces for troubleshooting.

This follows the same principle as health checks (Section 7.3): **corrupted things produce clear errors**, not raw stack traces.

**Error conventions:**

- Commands that encounter an error condition throw rather than returning silently. This ensures the process exit code is non-zero for scripting and CI use.
- Error messages include actionable suggestions where possible (e.g., "No staged conversations. Use `clog add <id>` to stage conversations first.").

### 5.12 The `rename-author` Command

`clog rename-author <old-name> <new-name>` renames an author across all local conversations. This is the bulk migration tool for correcting or changing author names — distinct from `clog config set author` (which only affects future operations) and `clog edit --author` (which changes a single conversation).

Requires confirmation:

```
This will rename author "bob" to "robert" on 50 local conversations.
Continue? [y/N]
```

This command only modifies the local DB (`UPDATE conversations SET author = 'new' WHERE author = 'old' AND origin IS NULL`). It does not modify config.

Note: `clog config set author` only changes the config value. It does NOT rename conversations in the DB. It affects only future operations (new discoveries, new publications). `rename-author` is the explicit migration tool.

Phase 3 (§11.6) extends the confirmation prompt with additional sync context.

---

## 6. MCP Server

### 6.1 Purpose

The MCP server allows coding agents (Claude Code, Codex, etc.) to query the conversation knowledge base during their work. An agent debugging an auth issue can browse for prior conversations about auth and benefit from past context.

### 6.2 Tools

Phase 1 provides browsing, retrieval, and curation. Semantic search is added in Phase 2 (§10).

```typescript
// List published conversations with optional filters
tool: "clog_list_published"
input: {
  tags?: string[];         // Filter by tags (OR — conversations with at least one matching tag)
  project?: string;        // Filter by project name
  author?: string;         // Filter by author
  grep?: string;           // Case-insensitive substring match on title/summary
  limit?: number;          // Default 20, max 100
  offset?: number;         // For pagination
}
returns: {
  conversations: Array<{
    id: string;
    title: string;
    summary: string;
    tags: string[];
    author: string;
    project: string | null;
    createdAt: string;
  }>;
  totalCount: number;
}

// List staged conversations (same schema as clog_list_published)
tool: "clog_list_staged"
// Same input/output as clog_list_published, scoped to staged conversations.
// Useful for agents helping curate — find conversations that need summaries or tags.

// Get conversation content (parses raw JSONL on demand, truncated by default)
// Only works on staged or published conversations — returns an error for discovered.
tool: "clog_get"
input: {
  id: string;              // UUID or 4+ char prefix
  maxMessages?: number;    // Default 20, max 200
}
returns: {
  id: string;
  title: string;
  summary: string;
  tags: string[];
  author: string;
  project: string | null;
  state: string;
  createdAt: string;
  messages: Message[];       // Last N messages (tail-truncated when over maxMessages)
  totalMessages: number;     // Total message count in the full conversation
  truncated: boolean;        // True if messages were cut off
  truncationNote?: string;   // Present when truncated, tells agent how to get more
}

// **Truncation:** When a conversation exceeds maxMessages, the **last** N messages
// are returned (tail truncation). The tail is almost always more valuable — it
// contains final decisions, working solutions, and conclusions. The truncation
// note tells the agent how many messages exist and how to request more.
//
// The default of 20 messages is a rough heuristic. Message count is a poor proxy
// for token size — a 20-message conversation where a human pasted a large codebase
// could be far larger than a 200-message conversation of short exchanges. Solving
// this properly would require token counting or byte-size budgets, which adds
// complexity. For now, 20 is a conservative default that keeps most retrievals
// small. The truncation note in the response makes it easy for
// agents to request more when needed.

// Edit metadata on a staged or published conversation
tool: "clog_update"
input: {
  id: string;              // UUID or 4+ char prefix
  title?: string;          // New title
  summary?: string;        // New summary
  addTags?: string[];      // Tags to add (lowercased, trimmed, deduped)
  removeTags?: string[];   // Tags to remove
}
returns: {
  conversation: {
    id: string;
    title: string;
    summary: string;
    tags: string[];
    author: string;
    project: string | null;
    state: string;
    createdAt: string;
    modifiedAt: string;
  };
}

If the requested update would not change the conversation's title, summary, or tags, `clog_update` is a no-op: it leaves `modifiedAt` unchanged and returns the existing conversation metadata.

// List available tags, projects, authors (for discovery)
tool: "clog_browse"
input: {
  by: "tags" | "projects" | "authors";
}
returns: {
  items: Array<{
    name: string;
    count: number;          // Number of published conversations
  }>;
}
```

### 6.3 Resources

The MCP server exposes conversations as MCP resources:

```
clog://conversations/{id}         Individual conversation
```

This allows agents to `@`-mention clog resources directly.

### 6.4 Running the Server

```bash
# Register with Claude Code
claude mcp add clog -- npx clog-mcp
```

The server uses stdio transport (spawned per-session by the client). It reads from the same SQLite database and raw files as the CLI. The `clog_list_published` and `clog_browse` tools only expose **published** conversations. `clog_list_staged` and `clog_get`/`clog_update` also work on staged conversations to support agent-assisted curation.

---

## 7. Configuration

### 7.1 Config File

`~/.clog/config.json`:

```json
{
  "author": "alice",
  "sources": {
    "claude-code": {
      "enabled": true,
      "paths": ["~/.claude/projects/"],
      "includePaths": ["~/work/"],
      "excludePaths": ["~/personal/", "~/side-projects/"]
    },
    "codex-cli": {
      "enabled": false,
      "paths": [],
      "includePaths": [],
      "excludePaths": []
    }
  },
  "defaultTags": [],
  "autoScan": false
}
```

Phase 2 (§10.2) adds: `search` block
Phase 3 (§11.5) adds: `remote` block

### 7.2 Config Fields

| Field | Type | Description |
|-------|------|-------------|
| `author` | string | Developer's name/handle, attached to published conversations |
| `sources` | object | Per-adapter configuration |
| `sources.*.enabled` | boolean | Whether this adapter is active (default `true`) |
| `sources.*.paths` | string[] | Base directories to scan for conversations (default: adapter-specific, e.g., `~/.claude/projects/`) |
| `sources.*.includePaths` | string[] | If non-empty, only discover conversations from projects under these directories |
| `sources.*.excludePaths` | string[] | Skip conversations from projects under these directories |
| `defaultTags` | string[] | Tags automatically applied to all new discoveries |
| `autoScan` | boolean | If true, the MCP server runs a source scan on startup |

**Path filtering rules:** `includePaths` and `excludePaths` match against the project directory that the conversation is associated with (decoded from the Claude Code directory name). If `includePaths` is set and non-empty, a conversation must match at least one include path. If `excludePaths` is set, any matching conversation is skipped regardless of include paths. Paths support `~` expansion and are compared as prefixes after normalization.

**`clog config set` value parsing:** Values are parsed as JSON first, falling back to a plain string if JSON parsing fails. This allows setting complex types naturally:

```bash
clog config set author alice                          # string
clog config set defaultTags '["team-a", "team-b"]'    # array
clog config set autoScan true                          # boolean
```

### 7.3 Initialization and Health Checks

**First run:**

When no `config.json` exists, the first invocation of any `clog` command detects this and runs interactive initialization:

```
$ clog status
Your name (used to tag published conversations) [alice]:
Initialized clog at /Users/alice/.clog
```

The prompt shows the OS username as the default (accepted by pressing Enter). In non-TTY contexts (e.g., the MCP server), the OS username is used automatically with no prompt.

`clog init` can also be run explicitly at any time. It is idempotent — it creates anything that's missing without overwriting anything that exists. If `config.json` already exists, it skips the name prompt.

**Health checks (every command):**

Separate from initialization, every command runs a `preAction` hook (`ensureClogHome`) that ensures required directories and files exist:

- `~/.clog/` directory exists → create if missing
- `config.json` exists → create with defaults if missing
- `raw/` and `raw/claude-code/` directories exist → create if missing

Health checks also validate existing state:

- `config.json` parses as valid JSON → error with helpful message if corrupted
- `~/.clog/` directory is accessible → error if not

The principle: **missing things are silently repaired; corrupted things produce clear errors.** A deleted `raw/` directory is recreated automatically. A `config.json` with invalid JSON gets an error message suggesting `clog init` to recreate it.

---

## 8. Phase 1 Non-Goals

To keep scope clear, these are explicitly **not** in Phase 1:

- Semantic search (added in Phase 2 — §10)
- Real-time sync between machines
- Web UI
- User authentication or access control
- Conversation threading or linking (e.g., "this conversation continues from...")
- Git-based team sharing (added in Phase 3 — §11)
- Automatic redaction of secrets (users edit raw files directly if needed)
- Support for non-CLI conversation sources (Claude.ai web, Cursor, etc.)
- Message-level editing (users edit raw JSONL files directly if needed)
- Interactive CLI prompts for routine operations — commands like `edit`, `tag`, `config` use flags, not step-through wizards. The exception is `clog init`, which uses a brief interactive prompt for first-time setup (asking the developer's name). The principle: don't make users step through an interactive flow when they just want to set one field.

---

## 9. Phase 1 Success Criteria

Phase 1 is successful if:

1. A developer can run `clog status` and see their Claude Code conversations listed
2. They can add, edit metadata, tag, and publish conversations via the CLI
3. `clog show` displays full conversation content parsed from raw JSONL files
4. `clog path` returns correct file paths to raw JSONL files
5. A Claude Code session with the MCP server configured can browse and retrieve published conversations
6. The entire tool runs locally with no network dependencies
7. The SQLite database stays small (metadata only) regardless of conversation size

---

## 10. Search (Phase 2)

Phase 2 adds semantic search over the conversation knowledge base. Phase 1 provides metadata-based filtering (`clog list` with `--project`, `--tag`, `--grep`); Phase 2 adds natural language queries (e.g., "how did we handle JWT refresh?" or "rate limiting approach") that return conversations ranked by semantic similarity.

### 10.1 Design Decisions

#### Search Is Optional

Search requires two heavy dependencies (a vector store and an embedding provider) that would violate clog's zero-native-dep install story if bundled. Keeping them as separate `npm install` additions preserves the core guarantee: `npm install clog` works everywhere with no build toolchain. The search module is always present in the codebase but inert until configured via `clog search --init`.

#### Local Embeddings as Default

The default embedding provider (`@huggingface/transformers` running `all-MiniLM-L6-v2` via WASM) runs entirely locally — no API key, no network, no cost. This is consistent with clog's local-first philosophy. API-based providers (OpenAI, Voyage, etc.) can be added as alternatives for teams that prefer higher-quality embeddings, but the default must work offline.

#### Pluggable Provider Architecture

The embedding provider and vector store are independent choices behind abstract interfaces (`EmbeddingProvider`, `VectorStore`). Adding a new provider means adding an entry to a static registry map — no changes to the indexer, search commands, or MCP tools. This keeps the search system open to extension without modifying core logic.

#### Vectra as Default Vector Store

Vectra is pure JavaScript, zero native deps, JSON-file-based. It uses brute-force similarity search, which is fine at the expected scale (<10 devs, a few thousand conversations). Higher-performance alternatives (LanceDB, sqlite-vec) can be added later as independent options.

#### Turn-Based Chunking

Conversations are chunked by turn (user message + assistant response) rather than by arbitrary token windows. Turns are the natural unit of conversation — a user question plus the assistant's response forms a coherent thought. Splitting mid-turn would fragment the semantic unit that makes search results useful.

#### Auto-Index on Publish

Indexing happens automatically during `clog publish`, not on MCP server startup. Publishing is the moment new content enters the knowledge base, so indexing there keeps search current without adding latency to agent sessions. If search deps are missing or indexing fails, publish still succeeds — indexing is best-effort.

### 10.2 Install and Configuration

Search dependencies are installed separately from core clog:

```bash
npm install vectra @huggingface/transformers
```

If the search dependencies aren't installed, `clog search` and `clog index` print a helpful message explaining how to enable search. All other commands work normally.

Search is configured in `config.json` via interactive setup (`clog search --init`):

```json
{
  "search": {
    "embedding": { "type": "transformers" },
    "vectorStore": { "type": "vectra" }
  }
}
```

### 10.3 What Gets Embedded

High-signal conversation content is embedded for search. Low-signal bulk (tool outputs) is not.

**Embedded:**

| Content | Source |
|---------|--------|
| Human messages | Full text of user-typed messages |
| Assistant prose | Text blocks from assistant responses |
| Tool metadata | Tool name + command summary (see below) |
| Title | Conversation title |
| Summary | Conversation summary |

**Tool metadata format** — a one-liner capturing what the tool did, without the full output:

```
Bash: git log --oneline -20
Read: src/auth/token.ts
Grep: pattern='ECONNREFUSED', glob='**/*.ts'
Glob: pattern='src/**/*.test.ts'
Write: src/config/defaults.ts
Edit: src/auth/middleware.ts
```

**NOT embedded:**

| Content | Reason |
|---------|--------|
| Tool result outputs | Bulk content (file dumps, command output) — low signal-to-noise for search |
| Thinking blocks | Internal model reasoning, stripped during parsing |
| Tool input details | Beyond the summary line, inputs are verbose JSON — the tool name + key parameter is sufficient |

### 10.4 Chunking Strategy

Conversations are naturally chunked by **turn** (user message + assistant response). Each chunk is embedded as a unit.

- **Short turns:** Embedded as-is. A typical turn is 100–500 tokens.
- **Long turns:** Split at ~800 token boundaries, with ~100 token overlap for context continuity.
- **Each chunk stores:** conversation ID, chunk index, message index range — enough to reconstruct which part of the conversation matched.

### 10.5 Embedding Providers

The embedding provider and vector store are **independent choices** — each is configured separately, and additional options can be added over time without affecting the other.

The embedding provider turns text into vectors:

```typescript
interface EmbeddingProvider {
  name: string;
  dimensions: number;
  embed(texts: string[]): Promise<number[][]>;  // Batch embedding
}
```

**Default: `@huggingface/transformers`** — runs `all-MiniLM-L6-v2` locally via WASM. No native deps, no API key needed, works offline. Downloads the model (~30MB) on first use. This is the recommended starting point.

Additional providers (e.g., OpenAI embeddings, Voyage, Cohere) can be added later as the need arises. Each is a separate implementation of `EmbeddingProvider`, selectable via config. API-based providers require an API key in `config.json` and network access.

### 10.6 Vector Stores

The vector store persists embeddings and performs similarity search:

```typescript
interface VectorStore {
  upsert(id: string, chunks: { text: string; embedding: number[]; metadata: Record<string, string> }[]): Promise<void>;
  search(embedding: number[], limit: number, filter?: Record<string, string>): Promise<{ id: string; score: number; text: string }[]>;
  delete(id: string): Promise<void>;
}
```

**Default: Vectra** — JSON-file-based vector search by Microsoft. Pure JavaScript, zero native deps, works everywhere Node runs. Uses brute-force similarity search, which is fine for the expected scale (<10 devs, a few thousand conversations). Stores data in `~/.clog/vectors/`.

Additional vector stores (e.g., LanceDB for better performance at scale, sqlite-vec if the project moves to better-sqlite3) can be added later as independent options. Each is a separate implementation of `VectorStore`, selectable via config.

### 10.7 DB Schema Changes

Add an `indexed_at` column to the conversations table:

```sql
ALTER TABLE conversations ADD COLUMN indexed_at TEXT;
```

The `indexed_at` column tracks vector DB state:

- **`null`** — conversation has not been embedded in the vector DB
- **Timestamp** — when the conversation was last embedded

**Staleness marker:** `indexed_at = null` is the authoritative signal that a published conversation is not currently searchable and needs indexing or re-indexing. Implementations may update non-search metadata (for example `author`, `project`, `slug`, or `modified_at`) without clearing `indexed_at` when the indexed search-visible content is unchanged. Changes to `sourcePath` or `filePath` conservatively clear `indexed_at` because they may indicate that the underlying conversation content moved or changed. For local scan workflows, a `sourceMtime` change also clears `indexed_at`; remote reconciliation uses `.meta.json` field comparison plus derived path changes instead of filesystem mtime.

**Embedding is optional per conversation.** A conversation can be published without being indexed. This decouples the curation workflow from search infrastructure — publishing works without a vector DB.

**Searchability invariant:** The vector store is a derived cache of the subset of conversations that are currently searchable. A conversation is searchable if and only if it exists in the local database, is in `published` state, and has a non-null `indexed_at` timestamp. A published conversation with `indexed_at = null` has either never been indexed or has been marked stale after a content change — its vectors may be absent or outdated, so it must not appear in search results until re-indexed. The vector store is not an append-only record of past publishes. Semantic search must not return conversations that have been deleted, excluded, reset to `discovered`, or moved out of `published` state.

**Index coherence rule:** Any operation that changes a conversation's search eligibility or indexed content must keep the vector store coherent with the database before the command returns. Implementations may satisfy this either by applying the vector-store mutation immediately or by making stale entries unreachable in the same logical operation, but search results must always reflect current DB state rather than historical indexing events.

If a deindex operation fails after the database has already been updated, the command still succeeds but prints a warning. Cleanup failures must be observable rather than silent. If search is not configured, deindexing is silently skipped because cleanup cannot be initialized. Vector-store files may still exist on disk from earlier indexing, but while search is unconfigured they are inert, and searchability continues to be governed by the database invariant.

### 10.8 CLI Commands

Phase 2 adds three commands:

**`clog search --init`** — Interactive setup. Uses `@inquirer/prompts` to let the user choose an embedding provider and vector store from the available options. Writes the selection to `config.json`. This is the only interactive prompt in Phase 2 (consistent with the Phase 1 principle of flags over wizards for routine operations).

**`clog search <query>`** — Semantic search across published conversations.

```bash
$ clog search "JWT refresh token race condition"
$ clog search "database migration" --project myapp --limit 5
```

Options:

| Flag | Description |
|------|-------------|
| `-p, --project <name>` | Filter by project |
| `-a, --author <name>` | Filter by author |
| `-t, --tag <tag>` | Filter by tag |
| `-l, --limit <n>` | Max results (default 10) |

If search is not configured or dependencies are missing, prints a helpful message directing the user to `clog search init`.

**`clog index`** — Index un-indexed published conversations (embeds them and inserts into the vector store).

```bash
$ clog index              # Index conversations where indexed_at is null
$ clog index --rebuild    # Re-index all published conversations from scratch
```

`--rebuild` sets `indexed_at = null` on all published conversations before indexing, forcing a full re-index.

### 10.8.1 Searchability Lifecycle

The search index follows the lifecycle of conversations in the database:

| Operation | DB effect | Search effect |
|-----------|-----------|---------------|
| `publish` | Conversation enters `published` state | Conversation becomes searchable; vectors are created or refreshed |
| `edit`, `tag`, `untag`, MCP `clog_update` on a published conversation | Conversation remains `published`, but search-visible metadata may change | If the operation actually changes title, summary, or tags, `indexed_at` is set to `null` so the conversation is treated as stale until re-indexed. Title and summary are part of the embedded metadata chunk; tags are not currently embedded, but tag edits still conservatively invalidate the index so search never mixes current DB metadata with stale vector-store state. No-op updates (e.g. setting a title to its current value, adding an already-present tag) skip the stale marking to avoid unnecessary re-indexing and `modified_at` bumps. |
| Remote reconciliation metadata update on a published conversation | Conversation remains `published`; DB metadata and derived paths may be refreshed from the checkout | If reconciliation changes title, summary, tags, `sourcePath`, or `filePath`, `indexed_at` is set to `null` so the imported conversation is treated as stale until re-indexed. Changes only to non-search metadata such as author, project, or slug do not clear `indexed_at`. |
| `unpublish` | Conversation leaves `published` state and `indexed_at` is set to `null` | Conversation ceases to be searchable; vectors are deleted |
| `reset` of a published conversation | Conversation leaves `published` state, `filePath` is cleared, and `indexed_at` is set to `null` | Conversation ceases to be searchable; vectors are deleted |
| `exclude` | Conversation is removed from the DB regardless of state | If the conversation had vectors, they are deleted. The deindex attempt is unconditional — deleting non-existent vectors for a non-published conversation is a harmless no-op. |
| `remote remove` | All conversations imported from the configured remote are removed from the DB | Those conversations cease to be searchable; their vectors are deleted |
| Remote reconciliation delete/retract | Conversation is removed from the DB or replaced by a non-searchable state | Conversation ceases to be searchable; vectors are deleted |

The authoritative definition of whether a conversation is eligible to appear in semantic search is its current row in the local database, not whether it was indexed at some point in the past.

### 10.9 MCP Tool

Phase 2 adds one tool to the MCP server:

```typescript
// Semantic search across published conversations
tool: "clog_search"
input: {
  query: string;           // Natural language search query
  tags?: string[];         // Filter by tags
  project?: string;        // Filter by project name
  author?: string;         // Filter by author
  origin?: "local" | "remote"; // Optional origin filter (see §11.12)
  limit?: number;          // Default 10, max 50
}
returns: {
  results: Array<{
    id: string;
    title: string;
    summary: string;
    tags: string[];
    author: string;
    project: string | null;
    createdAt: string;
    relevanceScore: number;
    snippet: string;       // Matched content excerpt
  }>;
  totalCount: number;
  indexCoverage: {
    indexed: number;     // How many published conversations are indexed
    published: number;   // Total published conversations
  };
  warning?: string;      // Present when search hit the scan cap and completeness is not guaranteed
}
```

`clog_search` only searches **published** conversations, consistent with `clog_list_published` and `clog_browse`. If search is not configured, the tool returns an error explaining how to set it up.

Before returning results, both the CLI and MCP search paths check each search hit against the current database state using the searchability invariant (published state with non-null `indexed_at`). If a vector-store entry refers to a conversation that is missing from the DB, no longer in `published` state, or has a stale index, that hit is filtered out and must not be surfaced to the user.

Search uses an expanding query window: it starts by fetching a small multiple of the requested limit from the vector store, then doubles the fetch count on each iteration until it either collects enough valid results or reaches the 5,000-entry scan cap. If search stops because it reached that 5,000-entry cap before finding enough valid results, it returns the best results found so far and includes a warning that results may be incomplete. If search stops for any other reason (enough results found, or vector store exhausted below the cap), it does not include that warning.

For the CLI command, this warning is printed as a visible warning line before the results (or before `No results found.` if filtering removes every scanned hit). For the MCP tool, the same condition is reported via the optional `warning` field in the response object.

### 10.10 Modifications to Phase 1 Features

Phase 2 requires changes to existing Phase 1 code:

**Publish** (`clog publish`): After publishing, auto-index the newly published conversations if search is configured and dependencies are available. This is best-effort — if search deps are missing or indexing fails, publish still succeeds silently. This keeps search up-to-date without requiring a manual `clog index` after every publish.

**Edit / tagging** (`clog edit`, `clog tag`, `clog untag`, and MCP `clog_update`): When a published indexed conversation is changed in a way that affects search-visible metadata, set `indexed_at = null`. This includes title and summary changes, plus tag changes as a conservative invalidation rule. No-op updates do not clear `indexed_at` and do not bump `modified_at`. The conversation will be re-indexed on the next `clog index` or `clog publish`.

**Unpublish / reset / exclude**: When a published conversation stops being searchable because it is unpublished, reset out of `published`, excluded, deleted during reconciliation, or otherwise removed from the database, delete its vectors from the vector store. Search must not surface conversations that are no longer searchable even if stale vectors still exist on disk.

**Config schema**: Add `search.embedding.type` and `search.vectorStore.type` fields to the config schema (Section 7).

### 10.11 Provider Architecture

The provider and dependency resolution pattern is designed for optional deps that may not be installed:

- **Provider registry** — a static map of provider name → required npm packages, config schema, and factory function. Adding a new provider means adding an entry to this map.
- **Runtime dependency checking** — before instantiating a provider, check that its required packages are importable. If not, surface a clear error.
- **Composition root** — reads `config.json`, resolves the configured providers, and returns concrete `EmbeddingProvider` + `VectorStore` instances. The indexer and search commands depend only on the interfaces, never importing Vectra or transformers directly.

### 10.12 Implementation Parameters

- **Chunk size:** ~800 tokens with ~100 token overlap, turn-based. Turns are the natural unit of conversation — a user question plus the assistant's response.
- **Auto-index timing:** On publish, not on MCP server startup. Publishing is the moment new content enters the knowledge base, so indexing there keeps search current. MCP startup indexing would add latency to agent sessions.
- **Default embedding model:** `all-MiniLM-L6-v2` — well-established, good quality-to-size ratio, widely supported by transformers.js.
- **Search ranking:** Cosine similarity via the vector store. Ranking quality is determined by the embedding model. The default is sufficient for the expected scale.
- **Minimum score threshold:** Results below 0.15 cosine similarity are filtered out. This removes noise from unrelated conversations without being so aggressive that it drops marginally relevant results.

### 10.13 Testing

**Chunker tests** (`chunker.test.ts`): Turn-based chunking logic, token limit splitting, overlap behavior, metadata attachment.

**Search tests** (`search.test.ts`): Integration tests for indexing and querying. These tests are conditional — they only run when the search dependencies (`vectra`, `@huggingface/transformers`) are available. Use a `checkPackages()` guard to skip gracefully when deps are missing.

---

## 11. Team Sharing (Phase 3)

Phase 3 adds team sharing via git. Developers publish conversations locally (Phase 1 workflow), then sync them to a shared git repository where teammates can pull and search them. The remote is a private git repo on any git host (GitHub, GitLab, Gitea, bare repo on a server). No custom server infrastructure.

### 11.1 Design Decisions

#### Git as Transport

A custom REST API was considered and rejected in favor of using git as the transport layer. Git provides auth, transport security, access control, audit log, conflict detection, versioning, hosting, offline support, and backups — all for free.

P2P sync is out of scope.

#### Git Is Additive

The existing local workflow (discover → stage → curate → publish) is unchanged. Git enters only at the sync boundary:

```
[existing local workflow] → publish → [export to git, commit, push]
[git pull, import into local DB] → [existing local workflow]
```

No part of the local workflow (state machine, publish log, clogignore, raw file storage) is replaced by git. The overlap between clog's concepts and git's concepts is superficial — they serve different purposes at different layers.

#### Shell Out to System Git

No `isomorphic-git`. System git is simpler, more reliable, and every target user has it. On first use of a sync command, check `git --version` and print a clear error if missing.

#### Single Branch, Directory-per-Author

Each developer writes only to their own directory. This prevents file-level conflicts without the complexity of per-developer branches.

Per-developer branches were rejected because:

- Pull would need to fetch and merge N branches to assemble the full knowledge base
- The team's knowledge base wouldn't be visible as a single tree
- Branch management becomes a thing (creation, divergence, orphaned branches)
- Directories already provide the same isolation property

#### No Init Ceremony for Sync

Unlike the search system (which requires optional heavy dependencies), sync requires only system git, which is universal. The sync module is always present in the codebase but inert until the user runs `clog remote add`. No install-optional treatment, no interactive setup. The code lives in `src/sync/` and is imported only by the sync/remote command handlers.

#### Git UX as Model

The sync layer mirrors git's UX conventions where possible. Commands use git-familiar naming (`add`/`remove`, `push`/`pull`). Auth is delegated to git entirely. When clog's needs diverge from git's model, prefer warning and stopping over inventing new behavior.

This principle applies specifically to the sync layer, not to the local curation workflow.

Concretely:

- `clog remote add` / `clog remote remove` — matches `git remote add` / `git remote remove`
- `clog sync push` / `clog sync pull` — matches `git push` / `git pull`
- Clone on first pull, not on `remote add` — `remote add` is a configuration operation, not data transport
- Auth failures surface git's error output verbatim, with a hint: "Git authentication failed. Check your SSH keys or credential helper configuration."
- Zero auth code in clog

The principle has a bound: clog matches git's *naming and sequencing*, not git's full surface area. No `clog sync fetch` vs `clog sync pull`, no `clog sync push --force`.

#### Tolerance of Pre-Existing Git State

clog should be tolerant of pre-existing git state in `~/.clog/remote/`. If a user has already cloned the repo before running any clog commands, `clog sync pull` should detect the existing checkout and just pull. If someone runs `git pull` manually in the checkout, clog should not break.

On first `clog sync pull`, if `~/.clog/remote/` already exists with a `.git/` directory, clog validates that the checkout's remote URL matches the one in config. If mismatch, warn and stop. If match, proceed with pull.

This supports power users who manipulate the git repo directly. Documentation should state: "clog manages `~/.clog/remote/` as a standard git checkout. You can run git commands in it directly — just run `clog sync pull` or `clog refresh` afterward to reconcile."

#### Remote Conversations Are Read-Only (v1)

Remote conversations cannot be edited, tagged, or unpublished locally. `clog edit`, `clog tag`, `clog untag`, `clog unpublish` refuse to operate on conversations with `origin IS NOT NULL`. This avoids the complexity of local overlays, sync-back, and conflicts with the author's edits. Revisit after Phase 3 stabilizes.

#### Exclude Works on Remote Conversations

`clog exclude` is extended to work on remote conversations. The excluded file (`~/.clog/excluded`) is the single source of truth for exclusions, regardless of whether the conversation is local or remote. During reconciliation, excluded IDs are skipped before import — the same way the scan pipeline skips them during local discovery.

The excluded file (not the DB or config) is the right home for this because:

- It already exists and works for local conversations
- It survives DB deletion (the DB is disposable; exclusions are user intent)
- It separates concerns — config is for settings, the excluded file is a blocklist
- It keeps config from growing with a list of IDs irrelevant to most operations

`clog unexclude` reverses the exclusion. For remote conversations, the next `clog sync pull` or `clog refresh` re-imports them.

#### No Automatic Retries

No operations automatically retry. If a `git push` is rejected (simultaneous push from a teammate), clog stops and informs the user. They can re-run `clog sync push` manually. This applies to all sync operations.

### 11.2 Repo Structure

Flat-by-author, two files per conversation:

```
clog-team/                        # the shared git repo
├── alice/
│   ├── abc123.meta.json          # serialized metadata
│   ├── abc123.jsonl              # conversation content
│   ├── def456.meta.json
│   └── def456.jsonl
└── bob/
    ├── 789fed.meta.json
    └── 789fed.jsonl
```

The `.meta.json` contains the conversation's metadata. It uses only objective identifiers — no relative terms like "local" or "remote." Its presence in the repo *is* its origin. The `author` field identifies who curated it.

```json
{
  "id": "abc123-...",
  "title": "Fix authentication bug",
  "summary": "Debugged JWT token expiration...",
  "tags": ["auth", "debugging"],
  "author": "alice",
  "project": "myapp",
  "publishedAt": "2026-02-20T10:00:00Z",
  "modifiedAt": "2026-02-21T15:00:00Z",
  "source": "claude-code",
  "createdAt": "2026-02-19T09:15:00Z",
  "slug": "fix-auth-bug"
}
```

On pull, clog reads `.meta.json` files to populate the DB without parsing the full JSONL.

**meta.json field reference:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Conversation UUID (from source filename). Also used as `sourceId` in the DB |
| `title` | string | Curated or auto-generated title |
| `summary` | string | Curated or extracted summary |
| `tags` | string[] | Curated tags |
| `author` | string | Who curated this conversation |
| `project` | string or null | Project the conversation is associated with |
| `publishedAt` | string | ISO timestamp of publication |
| `modifiedAt` | string | ISO timestamp of last metadata edit |
| `source` | string | Source adapter (e.g., `"claude-code"`) |
| `createdAt` | string | Earliest message timestamp — when the conversation started |
| `slug` | string or null | Session slug from the source (if available) |

**Fields derived during import** (not in meta.json):

| DB field | Value for imported conversations |
|----------|----------------------------------|
| `sourceId` | Same as `id` |
| `discoveredAt` | Import timestamp (now) |
| `state` | `"published"` |
| `publishVersion` | `0` |
| `sourcePath` | Path in checkout (`~/.clog/remote/<author>/<id>.jsonl`) |
| `filePath` | Same as `sourcePath` |
| `sourceMtime` | File mtime from filesystem |
| `indexedAt` | `null` (not yet indexed) |
| `origin` | Remote URL from config |

### 11.3 File Layout

This extends the base storage layout (§3.5) with a `remote/` directory:

```
~/.clog/
├── clog.db              # SQLite — metadata for ALL conversations (local + remote)
├── config.json          # User configuration (includes sync metadata)
├── raw/                 # Locally-curated JSONL files (from `clog add`, unchanged)
│   └── claude-code/
│       └── abc123.jsonl
└── remote/              # Git clone of team repo
    ├── .git/
    ├── alice/
    │   ├── abc123.meta.json
    │   └── abc123.jsonl
    └── bob/
        └── ...
```

`raw/` and `remote/` are separate directories with separate purposes:

- `raw/` holds files the local user explicitly added via `clog add`. Unchanged from Phase 1/2.
- `remote/` is the git working tree — a clone of the team repo.

Remote conversation content is read directly from the git checkout. No duplication into `raw/`. A `resolveContentPath(conversation)` function checks the origin and returns the right path:

- Local conversations: `~/.clog/raw/<source>/<id>.jsonl`
- Remote conversations: `~/.clog/remote/<author>/<id>.jsonl`

### 11.4 DB Schema Changes

Add an `origin` column to the conversations table (schema migration version 2 — see §3.4.1 for migration infrastructure):

```sql
ALTER TABLE conversations ADD COLUMN origin TEXT DEFAULT NULL;
```

- `NULL` = local (originated through the local curation workflow)
- Remote URL string (e.g., `git@github.com:myorg/clog-team.git`) = arrived via sync

Using `NULL` for local is idiomatic SQL ("no remote origin") and avoids a magic string. The remote URL is an objective identifier that naturally supports multiple remotes in the future without schema migration.

This column is local-only. It never appears in `.meta.json` files.

Purposes:

1. `clog list` can distinguish "my conversations" from "team conversations"
2. Remote conversations are read-only — edit/tag/untag/unpublish refuse them
3. `clog sync push` knows not to re-push conversations that came from the remote
4. MCP server can optionally filter by origin

### 11.5 Config Schema Changes

Add a `remote` block to `config.json`:

```json
{
  "remote": {
    "url": "git@github.com:myorg/clog-team.git",
    "allowPublicRemote": false,
    "visibilityConfirmed": false,
    "lastSyncHead": "a1b2c3d4e5f6..."
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `remote.url` | string or null | Git remote URL. `null` = no remote configured |
| `remote.allowPublicRemote` | boolean | Override public repo safety check. Only settable by manual config edit, not via CLI |
| `remote.visibilityConfirmed` | boolean | Persisted after first-push confirmation for non-GitHub remotes |
| `remote.lastSyncHead` | string or null | Git HEAD hash from last successful sync operation. Used for staleness detection |

Sync metadata lives in config (not DB) so that the DB remains disposable — users can delete `clog.db` and regenerate it from source files without losing sync configuration.

### 11.6 Commands

#### `clog remote add <url>`

Store the URL in `config.json`. Does **not** clone — `remote add` is a configuration operation, not data transport.

If a remote already exists, error: "Remote already configured. Use `clog remote remove` first."

**Public repo safety check** — before storing the config:

For GitHub remotes (detectable by hostname): parse the URL, call `gh api repos/{owner}/{repo} --jq .visibility` (if `gh` is available) or the GitHub REST API. If the repo is public, refuse:

```
Error: Repository myorg/clog-team is public.
Pushing conversations to a public repository would make them visible to anyone.
If this is intentional, add "allowPublicRemote": true to your clog config.
```

The `allowPublicRemote` flag must be manually edited into `config.json` — not settable via a CLI command. This makes public repos a deliberate, high-friction choice.

**GitHub HTTPS URL warning** — GitHub does not support password authentication over HTTPS. If the URL matches `https://github.com/...`, warn the user, suggest the equivalent SSH URL, and prompt to continue. Users with a personal access token or `gh auth login` configured can proceed; the warning ensures they're making an informed choice rather than hitting an opaque auth failure on first push.

For non-GitHub remotes: the safety check happens on first push (see §11.7).

#### `clog remote show`

Display: configured remote URL, last sync time, counts of local published and remote conversations.

#### `clog remote remove`

Remove the clone directory (`~/.clog/remote/`), purge all conversations with the matching origin from the local DB (and deindex them from the vector store), and clear remote config.

Confirmation prompt required:

```
This will remove the remote and delete 47 conversations pulled from it.
Conversations you discovered, staged, or published locally are not affected.
Continue? [y/N]
```

#### `clog sync pull`

On first run (no `~/.clog/remote/` checkout): clone the repo, then reconcile.

On subsequent runs: `git pull --rebase` in the checkout, then reconcile (full reconciliation, see §11.8).

If `~/.clog/remote/` exists but was cloned manually: validate the remote URL matches config, then proceed normally.

Reports import results: "Pulled N conversations from remote. M new, K updated, J removed."

If search is configured and conversations were imported, report unindexed count (see §11.11).

#### `clog sync push`

Export locally published conversations to the git checkout, commit, push. See §11.7 for full flow.

#### `clog refresh`

Standalone command — reconcile the local DB from the current state of the git checkout without fetching from the remote. This is the local-only half of `clog sync pull`.

Use case: the user ran `git pull` manually in `~/.clog/remote/`, or edited files in the checkout, and wants clog to catch up.

Runs the same reconciliation logic as pull (§11.8) without the `git pull` step.

If no remote is configured: `"No remote configured. Nothing to refresh."`

#### `clog rename-author` — Sync Context

`clog rename-author` is a Phase 1 command (see §5.12 for base behavior). When a remote is configured, the confirmation prompt includes additional context about the sync impact:

```
This will rename author "alice-work" to "alice" on 23 local conversations.
On next push, conversations will appear under "alice/" in the shared repo.
```

The following line is displayed in red:

```
The old "alice-work/" directory will remain until manually removed from the repo.
```

```
Continue? [y/N]
```

The command does not touch the git checkout or push. The remote rename happens naturally on the next `clog sync push` — new conversations appear in the new directory. The old directory persists in the repo until manually cleaned up.

### 11.7 Push Flow

**Preconditions** (check before doing any work):

- Remote is configured. If not: error and stop.
- `config.author` is non-empty. If not: `"Set your author name first: clog config set author <name>"`
- Checkout exists (`~/.clog/remote/`). If not: `"You haven't pulled from the remote yet. Run 'clog sync pull' first."`
- First push to a non-GitHub remote: require visibility confirmation (see below).

**Pull phase** (incorporate teammates' changes):

1. `git pull --rebase` in checkout. If rebase conflict: abort rebase, stop, inform user: `"Unexpected conflict during rebase. Inspect with: git -C ~/.clog/remote status"`
2. Reconcile DB from checkout — same logic as §11.8. This imports any new or updated conversations from teammates.

**Export phase** (write local state to checkout):

3. For each locally-originated published conversation (`origin IS NULL AND state = 'published'`) where `author = config.author`:
   - Write `<author>/<id>.meta.json` with metadata
   - Copy `raw/<source>/<id>.jsonl` to `<author>/<id>.jsonl`
4. For each file in `<author>/` directory in checkout that doesn't correspond to any published conversation for that author in the DB (regardless of origin): delete it. Track these as retractions for the output summary. This preserves conversations pushed from other machines (same author, different device) that were imported during the pull phase with `origin = remote URL`.

**Commit and push phase:**

5. `git add -A`
6. If no changes: `"Nothing to push — all published conversations are already synced."` Stop.
7. `git commit` with auto-generated message (see §11.14).
8. `git push`. If rejected: stop, inform user: `"Push was rejected — likely a simultaneous push from a teammate. Run 'clog sync push' again to retry."`
9. Update `config.remote.lastSyncHead` with new HEAD.

**Output:**

Report results to the user after a successful push:

≤10 total changes:

```
Pushed to git@github.com:myorg/clog-team.git

  + abc123 Fix authentication bug
  + def456 Refactor database layer
  ~ aaa111 Update session metadata
  - 789fed Debug memory leak

2 added, 1 updated, 1 retracted.
```

\>10 total changes:

```
Pushed to git@github.com:myorg/clog-team.git

47 added, 3 updated, 1 retracted.
```

Use "retracted" (not "deleted" or "removed") to distinguish from `clog remote remove`.

**First push — non-GitHub remote safety check:**

On the first push to a non-GitHub remote (where visibility couldn't be checked during `remote add`):

```
You are about to push N conversations to git@example.com:team/clog.git.
clog cannot verify whether this remote is private.
Continue? [y/N]
```

Confirmation is persisted in config (`remote.visibilityConfirmed: true`) so it doesn't ask again.

**Why `git pull --rebase`:** In the simultaneous-push scenario, the histories have diverged. `--rebase` replays the local commit on top of the remote cleanly, since developers write to different directories. This means users never see merge commits from normal clog usage. Clog should never create a merge commit.

### 11.8 Pull Flow: Full Reconciliation

After `git pull` (or in `clog refresh`, without the git pull), scan the entire checkout directory. Compare what's on disk to the subset of DB rows whose `origin` exactly matches the currently configured remote URL:

| Disk state | DB state | Action |
|------------|----------|--------|
| `.meta.json` exists | Not in DB | Insert (state = published, origin = remote URL) |
| `.meta.json` exists | In DB | Update if metadata changed (see below) |
| Not on disk | In DB with matching origin | Delete from DB |

Remote reconciliation is scoped to the configured remote only. Conversations imported from a different remote origin are left untouched, even if they also have `origin IS NOT NULL`.

**Change detection:** "Update if metadata changed" is determined by field-by-field comparison of the `.meta.json` contents against the corresponding DB columns. If any field differs, update the DB row. An alternative considered was comparing only `modifiedAt` timestamps, which is simpler but could miss changes if clocks are skewed or if files are edited without updating the timestamp.

Reconciliation also compares the derived checkout path for the conversation. If the same imported conversation now lives at a different checkout path (for example because the author directory changed), update `sourcePath` and `filePath` in place on the existing DB row rather than treating it as a delete plus re-import.

For search coherence, imported conversations follow the same stale-index rule as local edits: changes to search-visible metadata (`title`, `summary`, or `tags`) or content-indicating fields (`sourcePath`, `filePath`) clear `indexed_at`. Changes only to non-search metadata such as `author`, `project`, or `slug` do not.

**Orphaned files:** If a `.meta.json` exists without a corresponding `.jsonl`, or a `.jsonl` exists without a `.meta.json`, skip the conversation and print a warning. Do not import incomplete pairs.

**Corrupt metadata:** If a `.meta.json` fails to parse (invalid JSON or missing required fields), skip the conversation and print a warning. Same treatment as orphaned files.

**Excluded conversations:** Before importing, check the conversation ID against the excluded file (`~/.clog/excluded`). If excluded, skip. This reuses the same exclusion mechanism as the local scan pipeline — a single blocklist for both local discovery and remote reconciliation.

**Local takes precedence on duplicates:** During reconciliation, if a conversation with the same `source + source_id` already exists with `origin IS NULL` (user has their own local copy), skip the remote version entirely. The user's own curation takes precedence.

For remote-vs-remote duplicates (two remote authors published the same conversation), the first encountered copy is imported; subsequent copies are skipped due to the `UNIQUE(source, source_id)` constraint. Directory scan order (alphabetical by author) determines which copy wins.

Properties:

- Idempotent — running pull/refresh twice produces the same result
- Robust to interrupted pulls
- No sync state to track beyond the git checkout itself
- O(all remote conversations) per pull — fine at <10 devs scale

Update `config.remote.lastSyncHead` with new HEAD after reconciliation.

### 11.9 Staleness Detection

On `clog status` and `clog list`: if a remote is configured and `~/.clog/remote/` exists, compare current `git rev-parse HEAD` against `config.remote.lastSyncHead`.

If they differ:

```
Warning: remote checkout has changed outside of clog.
Run `clog refresh` to reconcile.
```

This is lightweight (~5ms for process spawn + reading a 40-byte ref), non-blocking, and informational. It does not auto-fix anything.

This handles the case where a user runs git commands in `~/.clog/remote/` directly, or where another process modifies the checkout.

Not shown on `clog show`, `clog search`, or other commands that retrieve specific content rather than surveying state.

### 11.10 List Output Changes

#### Default filter

`clog list` defaults to showing the current user's conversations:

```sql
WHERE author = <configured author> OR origin IS NULL
```

If `config.author` is empty or unset, fall back to `WHERE origin IS NULL` only.

This shows:
- All conversations the user curated (local and synced from other machines)
- The local discovery queue (discovered conversations that haven't been curated yet)

This supports the multi-machine solo user: someone using clog on laptop and desktop sees all their conversations regardless of which machine originated them.

#### Team conversation hint

When a remote is configured and remote conversations exist in the DB, append a footer:

```
47 team conversations available (use `clog list --all` to include)
```

#### Filtering flags

The `--origin` flag is listed in §5.3. Its semantics:

- `--all` — show all conversations (local + remote)
- `--author <name>` — filter by author
- `--origin local` — only local conversations (`origin IS NULL`)
- `--origin remote` — only remote conversations (`origin IS NOT NULL`)

These compose with existing filters (`--state`, `--project`, `--tag`, `--grep`).

### 11.11 Search Indexing After Pull

Both `clog publish` (existing) and the import step of `clog sync pull` should trigger indexing when the vector DB is configured.

For single-conversation publishes, auto-indexing is fine (existing behavior). For bulk imports after pull, auto-indexing hundreds of conversations could take minutes. Instead, report the count and let the user decide:

```
Pulled 583 conversations from remote.
Search index is out of date (583 conversations unindexed).
Run `clog index --rebuild` to update.
```

`clog status` reports pending index count: "N conversations not yet indexed."

The DB already tracks `indexed_at` per conversation, so tracking unindexed conversations is free.

### 11.12 MCP Server Changes

The MCP server already reads from the DB — if remote conversations are in the DB as published, they're served automatically.

Add an optional `origin` filter to `clog_list_published` and `clog_search` tools:

- `"local"` — only `origin IS NULL`
- `"remote"` — only `origin IS NOT NULL`
- Omitted — both

This lets an agent say "show me only my team's conversations" or "show me only my own."

### 11.13 Duplicate Conversations

If two developers independently curate and publish the same underlying conversation (same UUID), the repo contains both copies under their respective author directories, potentially with different metadata (titles, tags, summaries).

The DB constraint `UNIQUE(source, source_id)` enforces that a conversation exists at most once in the local database. This reflects the mental model that a conversation is a thing that exists once — the UUID from the JSONL filename is its global identity.

**On pull:** local takes precedence. If a conversation with the same `source + source_id` already exists with `origin IS NULL`, the remote version is skipped entirely. For remote-vs-remote duplicates (two remote authors published the same conversation), the first encountered copy is imported; subsequent copies are skipped due to the uniqueness constraint. Directory scan order (alphabetical by author) determines which copy wins. This is deterministic and simple.

**Implication:** When duplicates exist across authors, only one author's metadata (title, tags, summary) is visible locally. The content is identical regardless.

**Content-aware dedup and diff features** are future work, not Phase 3.

### 11.14 Commit Message Format

Auto-generated commit messages for `clog sync push`.

**Single-author, ≤10 conversations changed:**

```
clog: alice — 3 added, 1 updated

  + abc123 Fix authentication bug
  + def456 Refactor database layer
  + 789fed Debug memory leak
  ~ aaa111 Update session metadata
```

**Single-author, >10 conversations changed:**

```
clog: alice — 47 added, 3 updated, 1 removed
```

**Multi-author (manual/admin operations only — normal push always produces single-author commits):**

```
clog: 2 authors — 50 added, 4 updated, 1 removed

  alice: 47 added, 3 updated
  bob: 3 added, 1 updated, 1 removed
```

Multi-author commits never list individual conversations, only per-author summaries. There is no cap on the number of per-author lines.

**No changes:** If `git add -A` produces no changes, skip the commit entirely. Report: "Nothing to push — all published conversations are already synced."

The first line is always a readable summary for `git log --oneline`. The `+`/`~`/`-` prefixes echo diff conventions.

### 11.15 Code Changes

#### New code

- `src/sync/` — new module
  - `git.ts` — git command execution (clone, pull, push, rev-parse, status)
  - `push.ts` — push flow (export, commit, push)
  - `pull.ts` — pull flow (pull, reconcile, import)
  - `meta.ts` — `.meta.json` serialization/deserialization
  - `staleness.ts` — HEAD hash comparison
  - `resolve-content-path.ts` — branch on origin to return correct file path
- `src/cli/remote.ts` — `remote add/show/remove` command handler
- `src/cli/sync.ts` — `sync push/pull` command handler
- `src/cli/refresh.ts` — `refresh` command handler

#### DB schema changes

- Add `origin TEXT DEFAULT NULL` to conversations table (see §11.4, migration version 2 per §3.4.1)

#### Config schema changes

- Replace `remote: null` placeholder with structured Zod schema for `remote.url`, `remote.allowPublicRemote`, `remote.visibilityConfirmed`, `remote.lastSyncHead`

#### Existing code changes

- `src/cli/show.ts`, `src/cli/path.ts`, `src/cli/diff.ts` — use `resolveContentPath()` instead of `getFilePath()` for origin-aware path resolution
- `src/cli/list.ts` — default filter to `author = config.author OR origin IS NULL`; add `--all`, `--origin` flags; team conversation footer
- `src/cli/edit.ts`, `src/cli/tag.ts`, `src/cli/untag.ts`, `src/cli/unpublish.ts` — refuse remote conversations
- `src/cli/exclude.ts` — extend to work on remote conversations (delete from DB, add to excluded file)
- `src/sync/pull.ts` — check excluded file before importing during reconciliation
- `src/cli/status.ts` — report remote info, unindexed count, staleness warning
- `src/mcp/server.ts` — add optional `origin` filter to `clog_list_published` and `clog_search`
- `src/index.ts` — register new commands (remote, sync, refresh)
- `src/db/index.ts` — add `origin` to `insertConversation`, `rowToConversation`, `listConversations` filter

#### What doesn't change

- Discovery / scan pipeline (`src/cli/scan.ts`)
- Source adapters (`src/adapters/`)
- Local curation workflow (add, edit, tag, publish — other than read-only guards)
- Search indexer (`src/search/indexer.ts` — indexes published conversations regardless of origin)
- Chunker, embedding providers, vector stores

#### Tests

See §13.2 and §13.4 for the sync test inventory (`sync-meta.test.ts`, `sync-pull.test.ts`, `sync-push.test.ts`, `sync-integration.test.ts`).

---

## 12. Roadmap

**Phase 1 — Local MVP** (§§1-9): A working CLI and MCP server that a single developer can use to discover, curate, and browse their own Claude Code conversations.

**Phase 2 — Semantic Search** (§10): Natural language search over published conversations using local embeddings and a vector store.

**Phase 3 — Team Sharing** (§11): Share published conversations with teammates via a shared git repository.

### Phase 4: Extensions

| Step | Task |
|------|------|
| 4.1 | Codex CLI adapter |
| 4.2 | Auto-summarization (call an LLM to generate summaries) |
| 4.3 | Web UI for browsing the team knowledge base |
| 4.4 | Conversation analytics (what topics are your team asking about most?) |
| 4.5 | Import from exported Claude.ai conversations |
| 4.6 | Improve `clog show` (branch-aware rendering, collapsible tool output, better formatting for long conversations) |
| 4.7 | Cross-developer context handoff — MCP tool that lets an agent load a teammate's published conversation as reference context in a new session, enabling "pick up where they left off" workflows without writing to source locations |
| 4.8 | Content-aware deduplication of conversations shared by multiple authors |
| 4.9 | Conversation diff functionality |
| 4.10 | Local metadata overlays on remote conversations (local tags, notes) |
| 4.11 | `clog rename-author` automatic cleanup of old remote directory |
| 4.12 | Multi-remote support |
| 4.13 | Automatic retries on push rejection |

---

## 13. Testing

### 13.1 Principles

- **Deterministic and local-only.** No network calls, no time-dependent behavior, no randomness.
- **Never touch real data.** Tests must never read, write, or reference actual `~/.claude` files or any user home directory. All paths and data are programmatically generated fixtures in temp directories.
- **Sandboxed at runtime.** The application layer is configured to point at temp directories via `CLOG_HOME` and `CLOG_SOURCES` environment variables.
- **Source locations are never written to.** This is an application invariant (see Section 4.1), not just a test concern. The app must never write to, modify, or delete files in source locations like `~/.claude/`.

### 13.2 Framework and Structure

**Vitest** for the test runner. Fast, native ESM, built-in coverage.

```
tests/
├── adapter.test.ts          # Discovery parsing + full parsing
├── chunker.test.ts          # Turn-based chunking logic (Phase 2)
├── cli.test.ts              # CLI command unit tests (error handling, output, edge cases)
├── config.test.ts           # Config schema, load/save, defaults, init
├── db.test.ts               # CRUD, state transitions, publish log, project filtering
├── mcp.test.ts              # MCP tool handler tests (list, get, update, browse, search)
├── models.test.ts           # Zod schema validation for conversation and message types
├── scan.test.ts             # Scan pipeline, 3-layer filtering, stale entry pruning
├── search.test.ts           # Search integration, conditional on deps (Phase 2)
├── search-coherence.test.ts # Searchability invariants, deindexing, scan-cap behavior (Phase 2)
├── workflow.test.ts         # Multi-step workflows: add → publish, etc.
├── sync-meta.test.ts        # .meta.json serialization/deserialization (Phase 3)
├── sync-pull.test.ts        # Reconciliation logic: import, update, delete (Phase 3)
├── sync-push.test.ts        # Commit message generation, export logic (Phase 3)
├── sync-integration.test.ts # End-to-end sync with bare git repos (Phase 3)
├── e2e.test.ts              # End-to-end CLI tests via subprocess
└── helpers/
    ├── test-env.ts          # Sets CLOG_HOME + CLOG_SOURCES to temp dirs
    └── fixtures.ts          # Programmatic JSONL fixture generation
```

Tests use a flat structure rather than unit/integration subdirectories. Fixtures are generated programmatically via `createFixtureDir()` rather than checked-in static files — this keeps fixtures self-documenting and avoids maintaining separate JSONL files.

### 13.3 Test Environment Sandboxing

Every test file uses `createTestEnv()` which creates an isolated temp directory and sets `CLOG_HOME` to point at it. The returned `TestEnv` object provides the paths and a `cleanup()` method:

```typescript
let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await env.cleanup();
});
```

The application code respects `CLOG_HOME` and `CLOG_SOURCES` when set, falling back to `~/.clog` and the default adapter paths only when unset. This is the only contract between the test harness and the application.

### 13.4 Test Coverage

**Adapter tests** (`adapter.test.ts`):

- Discovery parsing: correct metadata extraction (title, summary, project, slug, dates) without reading the full file
- Full parsing: correct message normalization, deduplication by `message.id`, timestamp ordering
- Project name extraction from encoded directory names (Unix and Windows)
- Graceful handling of empty / no-message JSONL files

**CLI tests** (`cli.test.ts`):

- Unit tests for individual CLI command handlers
- Error handling: correct error messages, exit codes, actionable suggestions
- Edge cases: missing IDs, ambiguous prefixes, invalid arguments
- Output formatting and content verification

**DB tests** (`db.test.ts`):

- Schema creation succeeds and is idempotent
- CRUD operations for conversation metadata
- State transitions (discovered → staged → published, unpublish → staged)
- Publish log written correctly
- ID prefix resolution (min 4 chars, ambiguity detection)
- Browse distinct tags/projects/authors
- Project filtering by basename with case-insensitive matching

**MCP tests** (`mcp.test.ts`):

- Tool handler tests for `clog_list_published`, `clog_list_staged`, `clog_get`, `clog_update`, `clog_browse`, `clog_search`
- Input validation and error responses
- Filter behavior (tags, project, author, grep)

**Search coherence tests** (`search-coherence.test.ts`):

- Deindexing behavior: per-conversation delete failures warn and continue
- Search-not-configured vs dependency-failure warning behavior during deindex initialization
- Searchability invariant (`published` + non-null `indexed_at`)
- Expanding search window behavior and the 5,000-result scan-cap warning

**Models tests** (`models.test.ts`):

- Zod schema validation for `ConversationMeta` and `Message` types
- Required vs optional field handling
- Edge cases in schema parsing (missing fields, extra fields, type coercion)

**Config tests** (`config.test.ts`):

- Zod schema defaults and validation
- Config load/save round-trip
- Missing config file falls back to defaults
- Init flow (first-run setup, idempotent re-init)

**Scan tests** (`scan.test.ts`):

- 3-layer filter pipeline (excluded → config → clogignore)
- mtime-based skip for unchanged files
- New conversation discovery
- Stale entry pruning when source files disappear
- Source path updates when files move between directories

**Workflow tests** (`workflow.test.ts`):

- Multi-step flows: add → publish, edit → re-publish, exclude → unexclude
- State transitions through `withDb`

**Sync meta tests** (`sync-meta.test.ts`, Phase 3):

- `.meta.json` Zod schema validation
- Read/write round-trip for meta files
- Conversion from meta format to `ConversationMeta`

**Sync pull tests** (`sync-pull.test.ts`, Phase 3):

- Reconciliation: insert new, update changed, delete removed
- Excluded conversations skipped during import
- Local-takes-precedence on duplicates

**Sync push tests** (`sync-push.test.ts`, Phase 3):

- Commit message generation (single-author, multi-author, ≤10 and >10 changes)
- Export logic for published conversations

**Sync integration tests** (`sync-integration.test.ts`, Phase 3):

- End-to-end push/pull cycles against bare git repos
- Conditional on git availability

**E2E tests** (`e2e.test.ts`):

- Full CLI subprocess tests via `npx tsx src/index.ts`
- Complete workflow: status → add → edit → tag → publish → show → log
- Exclude/unexclude round-trip
- Config get/set

### 13.5 Fixture Generation

Fixtures are generated programmatically via `createFixtureDir()` in `tests/helpers/fixtures.ts`. This function creates a temp directory with synthetic JSONL files that exercise various conversation shapes (user messages, assistant messages with tool use, summaries, etc.). This approach is preferred over static fixture files because fixtures stay self-documenting and in sync with schema changes.

### 13.6 Linting

ESLint with `typescript-eslint` enforces two type-aware rules:

- **`@typescript-eslint/no-unused-vars`** — catches dead imports and variables. Uses `^_` ignore patterns for intentional underscores.
- **`@typescript-eslint/no-floating-promises`** — catches unhandled async calls (promises that are neither awaited nor returned).

Linting covers both `src/` and `tests/`. A separate `tsconfig.eslint.json` extends the base `tsconfig.json` to include test files (which are excluded from compilation).

Linting is not gated by `npm test` — it's a separate `npm run lint` step. This keeps the test cycle fast and avoids blocking on style issues.

### 13.7 npm Scripts

```json
{
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest",
    "dev": "tsx src/index.ts",
    "lint": "eslint src/ tests/"
  }
}
```
