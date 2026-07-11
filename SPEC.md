# clog — Specification Document

## Team Conversation Knowledge Base for AI Coding Agents

---

## 0. About This Specification

This document is written to be the authoritative description of clog's design and behavior. It is a generative specification - anyone (human or AI) should be able to implement a fully functional clog from this document alone, without access to any existing implementation. In practice, this file was built for use by LLM coding agents operating with human oversight.

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

This document sits at the top of clog's documentation hierarchy.

- `SPEC.md` is the authority on intended behavior and design contracts.
- Architecture/reference docs describe one implementation shape that satisfies the spec and should be updated when stable code boundaries change.
- Phase implementation plans are lower-level execution documents. They describe sequencing and build strategy for a specific phase and may later become historical artifacts without becoming incorrect.

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
- **Sensitivity:** Conversations are treated with the same security posture as source code. No special secrets-redaction pipeline, but developers have personal conversations on the same machines that must not leak into the knowledge base. Path filtering in config, `clogignore`, and explicit saving address this.
- **Platform:** macOS (Apple Silicon), Windows 10/11, and Ubuntu Linux are all required. The tool must install with nothing more than `npm install` — no native compilation, no platform-specific build steps.

### 1.5 Design Principles

1. **Files as source of truth, database as index.** Conversation content lives in JSONL on disk; SQLite stores only metadata. (§2.1)
2. **Source locations are read-only.** clog never writes to, modifies, or deletes files in source locations like `~/.claude/`. (§4.1)
3. **Curation tool, not an observability tool.** clog helps developers share knowledge — not measure activity. No analytics, no dashboards, no per-author metrics. This boundary is intentional.
4. **Author-only saving.** A developer saves their own conversations. No mechanism exists for saving, unsaving, or retracting on behalf of another author.
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

**Concurrent access:** The MCP server and CLI can run simultaneously (e.g., a developer runs `clog save` while the MCP server is handling a query). Since `sql.js` loads the entire database into memory, concurrent writers risk last-write-wins data loss — one process's flush could overwrite the other's changes.

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
- **Path handling:** All file paths in the codebase must use Node's `path` module. Claude Code project directory names use a lossy path encoding, not a reversible path serialization. The encoding rule is: replace every `/` and `\` with `-`, then replace every remaining character that is not ASCII alphanumeric (`[A-Za-z0-9]`) or `-` with `-`. Case is preserved, hyphens are not collapsed, and leading/trailing hyphens are kept. Examples: `/Users/alice/myproject` → `-Users-alice-myproject`; `C:\Users\alice\myproject` → `C--Users-alice-myproject`; `\\server\share\proj\` → `--server-share-proj-`. Because this encoding is lossy, implementations must ignore it for `projectPath` and `projectName` extraction and instead use real working-directory metadata from the conversation data when available.

### 2.3 Project Structure

```
clog/
├── src/
│   ├── cli/                 # CLI commands and support modules
│   │   ├── scan.ts          # Shared scan pipeline used by status/list/save
│   │   ├── edit.ts          # Edit conversation metadata
│   │   ├── save.ts          # Save to knowledge base
│   │   ├── diff.ts          # Show new messages since last save
│   │   ├── status.ts        # Show current state
│   │   ├── show.ts          # Display conversation content
│   │   ├── path.ts          # Print raw file path
│   │   ├── drain.ts         # Export conversations as JSON, markdown, raw source, or pair files
│   │   ├── fill.ts          # Import portable conversation file-pair exports
│   │   ├── talk.ts          # Launch an MCP-capable agent for conversation work
│   │   ├── list.ts          # List conversations with filters
│   │   ├── exclude.ts       # Append literal ignore rules to clogignore
│   │   ├── unexclude.ts     # Remove exact ignore rules from clogignore
│   │   ├── remove.ts        # Remove current DB rows that match ignore-rule syntax
│   │   ├── tag.ts           # Add tags
│   │   ├── untag.ts         # Remove tags
│   │   ├── config.ts        # View/edit configuration
│   │   ├── clogignore.ts    # Pattern-based discovery filtering
│   │   ├── selectors.ts     # Shared project-aware selector resolution
│   │   ├── project-targets.ts # Per-command project batching policies
│   │   ├── colors.ts        # State-based color helpers
│   │   └── rename-author.ts # Bulk author rename across conversations
│   ├── adapters/            # Source-specific conversation parsers
│   │   ├── adapter.ts       # Base adapter interface
│   │   ├── registry.ts      # Source-aware adapter construction and dispatch
│   │   ├── claude-code.ts   # Claude Code (~/.claude/)
│   │   └── codex-cli.ts     # Codex CLI (~/.codex/)
│   ├── mcp/                 # MCP server
│   │   ├── server.ts        # MCP server setup + stdio transport
│   │   ├── handlers.ts      # Tool handler implementations (extracted for testability)
│   │   └── guides/          # Bundled agent guidance returned by MCP tools
│   ├── db/                  # Database layer
│   │   ├── schema.ts        # Table definitions + migrations
│   │   └── index.ts         # Query functions
│   ├── interchange/         # Transport-neutral conversation file-pair IO and reconciliation planning
│   │   ├── pairs.ts         # Pair discovery, validation, metadata, and safe writing
│   │   ├── reconcile.ts     # Deterministic git reconciliation planner
│   │   └── fill.ts          # File-import collision planning
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
Phase 3 (§11.15) adds: `src/sync/`, plus CLI files (`remote.ts`, `sync.ts`, `refresh.ts`). Git reconciliation composes the shared interchange planner rather than owning pair scanning directly.

---

## 3. Data Model

### 3.1 Conversation Metadata

The database stores metadata about conversations. Full content (messages, tool use, tool results) lives in raw JSONL files on disk and is parsed on demand when needed (e.g., `clog show`, MCP `clog_get`).

```typescript
type SummaryKind = "none" | "imported" | "generated" | "curated";

interface SummaryExtraction {
  topics?: string[];
  outcome?:
    | "fixed"
    | "partial"
    | "abandoned"
    | "exploratory"
    | "blocked"
    | "noise"
    | "unclear";
  toolsUsed?: string[];
  notableMoments?: Array<{ why: string }>;
}

interface ConversationMeta {
  // Identity
  id: string;                    // Same as sourceId for built-in UUID-based sources
  sourceId: string;              // Original native ID from the source system
  source: "claude-code" | "codex-cli" | string;

  // Metadata
  title: string;                 // Auto-generated or user-provided
  summary: string;               // Prose summary; source-native, agent-generated, or user-curated
  summaryKind: SummaryKind;      // Who or what produced the prose summary
  summaryExtraction: SummaryExtraction | null; // Structured summary fields for agent analysis
  author: string;                // Developer who had the conversation
  projectName: string | null;    // Display/sync project name, usually basename(projectPath)
  projectPath: string | null;    // Local-only detected project directory path, if available
  tags: string[];                // User-applied tags
  slug: string | null;           // Human-readable name (e.g., "breezy-coalescing-pony")

  // Timestamps
  createdAt: string;             // ISO 8601 (from source)
  discoveredAt: string;          // When clog first saw it
  modifiedAt: string;            // Last metadata or content-change marker

  // State
  state: "unsaved" | "saved";
  savedAt: string | null;        // Last successful save time, null until first save
  savedMessageCount: number | null;  // Parser-sequence checkpoint, null until first save
  saveVersion: number;           // Increments on re-save after edits

  // File references
  sourcePath: string;            // Local source path, git checkout path, or managed import path
  filePath: string | null;       // Managed content path for saved rows; null until save/import
  sourceMtime: string | null;    // ISO 8601 mtime of source file at last scan
  indexedAt: string | null;      // Phase 2 search cache freshness marker

  // Provenance
  originKind: "local" | "git" | "file";
  originRef: string | null;      // Configured git remote URL for git rows; null for every other kind

}
```

Phase 2 (§10) adds: `indexedAt`
Phase 3 (§11.4) adds: `originKind` and `originRef`

For the built-in Phase 1 sources, `id = sourceId`. Claude Code and Codex CLI both emit UUID-shaped native IDs, and `id` remains the physical primary key in the local database. The `(source, sourceId)` pair is also unique and is the logical source identity. If discovery or pair import encounters an `id` collision where the existing row has a different `(source, sourceId)`, clog treats that conversation as a fatal unsupported-source-identity error and does not auto-merge, overwrite, or synthesize a new ID. If a future source does not provide UUID-shaped IDs with comparably low collision risk for clog's scale, that source must define a storage-key strategy before it can be added.

This is intentional. clog does not use a composite key for the built-in sources because a single physical `id` keeps identity handling, file naming, CLI resolution, MCP retrieval, and sync reconciliation simpler and less bug-prone for the current sources. At clog's expected scale and with the built-in sources' UUID-shaped IDs, a cross-source collision is not a realistic design constraint for Phase 1.

**Timestamp roles:** `createdAt` is source chronology; `discoveredAt` is when clog first saw or imported the conversation; `modifiedAt` is the dirty/status marker for user-visible metadata or content-marker changes; `savedAt` is the latest successful save time and the baseline for cheap modified-since-save checks; `savedMessageCount` is the transcript diff boundary, not a timestamp; `sourceMtime` is the local source scan cache marker; `indexedAt` is the search cache freshness marker.

**Summary metadata:** `summary` is the prose summary. `summaryKind` records who or what produced that prose:

| value | meaning |
|-------|---------|
| `none` | No useful prose summary is stored |
| `imported` | The prose summary came from trusted source-native metadata, such as a Claude Code summary line |
| `generated` | The prose summary was written by a summarizing agent through MCP |
| `curated` | The prose summary was written or claimed by the user, usually through `clog edit --summary` |

`summaryExtraction` is a nullable JSON-shaped object that stores structured fields used by later analyst agents. All extraction fields are optional. Agents omit fields they cannot determine confidently. `outcome` uses the fixed vocabulary in `SummaryExtraction`; agents use `unclear` when real work happened but the transcript does not reveal the resolution. `notableMoments` is reserved for genuinely notable observations and is often absent. The `noise` outcome is for sessions with no substantive agent work, such as accidental opens, harness configuration without a real prompt, or sessions interrupted before work began. Noise rows still keep a short factual prose summary; the outcome flag is the signal.

**Source-native metadata:** clog preserves source-provided metadata such as summaries and slugs when a source exposes them in a trusted native field. Source-native summaries set `summaryKind = "imported"`; conversations without a useful summary set `summaryKind = "none"`. Discovery never writes `summaryExtraction`. Phase 1 does not synthesize summary or slug values during discovery for sources that do not provide them.

**Summary freshness:** v1 does not track whether a generated summary/extraction still covers the current saved checkpoint. If a conversation is summarized, later extended, and saved again, the existing `summary`, `summaryKind`, and `summaryExtraction` remain in place until the user or an agent clears or refreshes them. `clog_get` remains the source of truth for transcript content. Future freshness tracking should derive from a content hash of the summarized window rather than an agent-reported message count.

**Project metadata:** clog stores project identity in two fields. `projectPath` is the detected local project directory path when available. It is local/contextual metadata, not a stable cross-machine project identity, and must not be written to pair metadata by default. `projectName` is the stored project label, usually the basename of `projectPath`. User-facing table columns and `--project <name>` label it "project." MCP tool inputs and responses expose the field as `project` so agents see one name for the concept. Pair metadata uses `projectName` for wire compatibility with the stored model. Path-based filters such as `includePaths`, `excludePaths`, and path-like `clogignore` rules match against the full normalized `projectPath`.

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

`Message[]` order is the canonical transcript order. Adapters must return messages in stable parser-derived order; downstream display, diff, MCP truncation, search chunking, and indexing must not re-sort messages by timestamp. `timestamp` is useful metadata only.

Adapter parsing must be deterministic. For a given raw file, source adapter, adapter version, and parsing-relevant configuration, `parseMessages()` must return the same ordered `Message[]` every time. Parsing must not depend on scan state, database state, filesystem mtime, warning emission, partial-read timing, current time, locale, or which caller requested the parse (`show`, `diff`, MCP retrieval, search indexing, or save).

**Normalization from raw JSONL to Messages:** Source adapters project their native event formats into this shared shape. The projection is intentionally not lossless: raw JSONL files remain the source of truth for full detail, while `Message[]` is optimized for display, diff, MCP retrieval, and search.

Claude Code JSONL (Section 4.2) is normalized as follows:

- Raw user line with `content: string` → `Message` with `role: "user"` after applying the narrow hidden-wrapper filtering rule in §4.2.7. Confirmed hidden model scaffolding may be dropped; user-visible local-command/status entries remain canonical even when encoded with wrapper tags.
- Raw assistant `text` content block → `Message` with `role: "assistant"`, `content` = the text
- Raw assistant `tool_use` content block → `Message` with `role: "tool_use"`, `toolName` / `toolInput` populated
- Raw user line with `tool_result` content block → `Message` with `role: "tool_result"`, `content` = status summary (e.g. `"Read: ok"`, `"Bash: error"`), `toolName` from the matching tool_use. The actual tool output is stripped — it's bulk content (file dumps, command output) that would bloat MCP payloads. The `is_error` field from the JSONL determines the status.
- Raw assistant `thinking` content blocks and confirmed hidden model-only wrapper records → **stripped during normalization** (internal or non-user-visible scaffolding, not useful for the knowledge base)

Codex CLI JSONL (Section 4.3) is normalized as follows:

- `response_item.message` with `role: "user"` → `Message` with `role: "user"`, `content` extracted from `input_text` blocks
- `response_item.message` with `role: "assistant"` → `Message` with `role: "assistant"`, `content` extracted from `output_text` blocks
- `response_item.function_call` → `Message` with `role: "tool_use"`, `toolName` and parsed `toolInput` when possible
- `response_item.function_call_output` → `Message` with `role: "tool_result"` containing a compact status summary. Like Claude Code tool results, Codex tool results strip bulk output but preserve success/failure status when structured status metadata is available.
- `event_msg.user_message` → fallback `Message` with `role: "user"` only when the nearby-dedup rule in §4.3.3 does not find a matching canonical user message
- `event_msg.exec_command_end` → fallback `tool_result` only when no `function_call_output` exists for the same `call_id`
- `response_item.message` with other roles, including `role: "developer"`, and `session_meta`, `turn_context`, `token_count`, `agent_message`, and `reasoning` records → **stripped during normalization**

### 3.3 Short ID Prefixes

Full conversation IDs are UUIDs from the source system (e.g., `c7044ea5-c019-44d6-a77a-500036740f9a`). The CLI displays and accepts short prefixes, similar to Git:

- **Display:** All commands that show IDs use the first 8 characters by default (e.g., `c7044ea5`).
- **Input:** Any command that accepts an ID resolves short prefixes by querying the database with a `LIKE 'prefix%'` match. If the prefix is ambiguous (matches multiple conversations), the command errors with a message showing copy-pasteable disambiguation candidates.
- **Source-qualified input:** Commands also accept `prefix@source`, for example `c7044ea5@codex-cli`. Parse by splitting on the last `@`. Empty prefixes, empty sources, unknown sources, and prefixes shorter than the minimum are invalid. Source-qualified input restricts resolution to the named source.
- **Minimum prefix length:** 4 characters. Shorter prefixes are rejected as ID resolutions. In selector-bearing commands a bare token under 4 characters can still resolve as a project name (see §5.1.1), but the cross-space ambiguity check still applies: if the same short token also matches any conversation ID prefix, the command errors with the cross-space ambiguity message rather than silently choosing the project.

Ambiguous unqualified prefixes should name the conflicting sources:

```
"123e4567" matches both claude-code and codex-cli; use "123e4567@claude-code" or "123e4567@codex-cli".
```

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
  summary_kind    TEXT NOT NULL DEFAULT 'none'
                  CHECK(summary_kind IN ('none','imported','generated','curated')),
  summary_extraction TEXT,
  author          TEXT NOT NULL,
  project_name    TEXT,
  project_path    TEXT,
  tags_json       TEXT DEFAULT '[]',   -- JSON array of strings
  slug            TEXT,                -- Human-readable conversation name
  created_at      TEXT NOT NULL,
  discovered_at   TEXT NOT NULL,
  modified_at     TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'unsaved'
                  CHECK(state IN ('unsaved','saved')),
  saved_at    TEXT,
  saved_message_count INTEGER,
  save_version INTEGER DEFAULT 0,
  source_path     TEXT NOT NULL,       -- Local source path, git checkout path, or managed import path
  file_path       TEXT,               -- Managed content path for saved rows; null until save/import
  source_mtime    TEXT,               -- ISO 8601 mtime of source file at last scan
  indexed_at      TEXT,
  origin_kind     TEXT NOT NULL DEFAULT 'local'
                  CHECK(origin_kind IN ('local','git','file')),
  origin_ref      TEXT,
  CHECK(
    (origin_kind = 'git' AND origin_ref IS NOT NULL)
    OR
    (origin_kind IN ('local','file') AND origin_ref IS NULL)
  ),
  UNIQUE(source, source_id)
);
```

#### 3.4.1 Schema Versioning and Migration

The `schema_version` table tracks the current schema version as a single integer. On startup, the DB layer compares this against the expected version and runs migrations for any versions in between.

Migrations are version-gated: each migration checks `currentVersion < N` and applies the necessary ALTER TABLE or other DDL statements. If a migration's change already exists (e.g., a column was added in a fresh install that includes it in the CREATE TABLE), the migration handles this gracefully (e.g., catching "column already exists" errors).

Fresh installs create all tables with the latest schema and set the version to the current value. Existing databases are migrated incrementally.

| Version | Changes |
|---------|---------|
| 1 | Initial schema (Phase 1) |
| 2 | Add `indexed_at` for Phase 2 semantic search |
| 3 | Add legacy `origin` for Phase 3 team sharing |
| 4 | Rename save checkpoint fields and the saved state value from the legacy publish terminology |
| 5 | Add `summary_kind` and `summary_extraction` for agent-assisted summarization |
| 6 | Constrain the version-6 conversation state to `discovered` and `saved` |
| 7 | Split legacy `origin` into `origin_kind` and `origin_ref` |
| 8 | Rename the conversation lifecycle state from `discovered` to `unsaved` |

Phase 2 (§10) adds: `indexed_at` column (migration version 2)
Phase 3 (§11.4) adds: `origin_kind` and `origin_ref` columns (migration version 7, after the legacy version-3 sync marker)
The save terminology migration (version 4) rebuilds the conversations table for sql.js compatibility, renames the legacy `published_at`, `published_message_count`, and `publish_version` columns to `saved_at`, `saved_message_count`, and `save_version`, and rewrites legacy `state = 'published'` rows to `state = 'saved'`.
The summarization migration (version 5) adds `summary_kind` with a default of `none` and a CHECK constraint over `none`, `imported`, `generated`, and `curated`; adds nullable `summary_extraction`; and back-fills `summary_kind = 'curated'` for existing rows whose `summary` is non-empty. This conservative back-fill prevents agent summarization from overwriting prose the user may already have edited.
The provenance migration (version 7) rebuilds the conversations table for sql.js compatibility, replaces legacy `origin` with `origin_kind` and `origin_ref`, back-fills rows whose legacy `origin` value is null as `origin_kind = 'local', origin_ref = NULL`, and back-fills rows whose legacy `origin` value is non-null as `origin_kind = 'git', origin_ref = <legacy origin URL>`.
The state terminology migration (version 8) rebuilds the conversations table for sql.js compatibility, changes the `state` column default and CHECK constraint to `unsaved`/`saved`, and rewrites legacy `state = 'discovered'` rows to `state = 'unsaved'`. Fresh installs create the version-8 schema directly.

**What's NOT in the database:** Full message content, tool outputs, raw conversation text. These live in JSONL files. For saved conversations, `file_path` points at the managed content file: local rows use `~/.clog/raw/`, git rows use `~/.clog/remote/`, and file-imported rows use `~/.clog/imports/`. For unsaved conversations, `source_path` points at the original source location. This keeps the database small (a few KB per conversation) so that `sql.js` can load it into memory instantly, even at thousands of conversations.

### 3.5 Storage Location

```
~/.clog/
├── clog.db                  # SQLite database — metadata only (~5MB at scale)
├── config.json              # User configuration
├── clogignore               # User-edited ignore rules for discovery/import filtering
├── raw/                     # Source JSONL files copied when conversations are saved locally
│   ├── claude-code/
│   │   ├── c7044ea5-c019-44d6-a77a-500036740f9a.jsonl
│   │   └── 123e4567-e89b-12d3-a456-426614174000.jsonl
│   └── codex-cli/
│       └── 550e8400-e29b-41d4-a716-446655440000.jsonl
└── imports/                 # Managed JSONL copies imported by clog fill
    └── claude-code/
        └── 99999999-9999-4999-9999-999999999999.jsonl
```

On Windows, the default location is `%USERPROFILE%\.clog\` (resolved via `os.homedir()`). The `CLOG_HOME` environment variable overrides this on all platforms.

**Raw file copies and disk usage:** `clog save` copies the source JSONL file into `~/.clog/raw/`. Before that, clog reads from the source location directly (read-only). This avoids doubling disk usage for conversations the developer never intends to curate. Source-specific raw directories such as `raw/claude-code/` and `raw/codex-cli/` are created lazily when first needed for a write, and are not automatically removed later if they become empty.

Phase 3 (§11.3) adds: `remote/` directory for the git checkout
`clog fill` adds the flat `imports/<source>/<id>.jsonl` managed store for read-only file imports. `--own` restores into the normal `raw/<source>/<id>.jsonl` path instead.

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
    title: string;             // Discovery title chosen by the source adapter (see source-specific rules below)
    summary: string;           // Source-native summary when available; otherwise adapter-defined default
    projectName: string | null; // Display project name, usually basename(projectPath)
    projectPath: string | null; // Detected project directory path, if available
    slug: string | null;       // Source-native human-readable name when available; otherwise adapter-defined default
    createdAt: string;         // Discovery timestamp chosen by the source adapter (see source-specific rules below)
  };
}
```

**Source locations are read-only.** Adapters must never write to, modify, or delete files in source locations (e.g., `~/.claude/` or `~/.codex/`). clog only reads from sources during discovery and full parsing. All clog-managed state lives in `~/.clog/`.

### 4.1.1 Built-in Sources and Dispatch

Phase 1 has two built-in sources:

| Source key | Default path | Purpose |
|------------|--------------|---------|
| `claude-code` | `~/.claude/projects` | Claude Code conversation JSONL files |
| `codex-cli` | `~/.codex/sessions` | Codex CLI session JSONL files |

For Codex CLI, `~/.codex/` is resolved via the user home directory on every platform (`$HOME/.codex/` on macOS/Linux, `%USERPROFILE%\.codex\` on Windows).

Source support and local discovery are separate concepts. Both sources are supported by the product; `sources.<name>.enabled` controls whether local discovery runs for that source on this machine.

Each adapter's `watchPaths()` returns the configured source paths for that source, or its built-in default paths when config does not override them.

All discovery and parsing must go through a source-aware adapter registry or equivalent composition point:

```typescript
getAdapter(source: string, config: Config): SourceAdapter
getEnabledAdapters(config: Config): SourceAdapter[]
```

`getEnabledAdapters` respects the per-source discovery toggle and is used only for local discovery. `getAdapter(source, config)` ignores `sources.<name>.enabled` for supported sources and returns the adapter needed to parse already-tracked local, saved, or remotely imported conversations. Read paths such as `show`, `diff`, `save`, MCP retrieval, indexing, and sync import/export choose the parser from `ConversationMeta.source`, never from a hardcoded default adapter. If `source` is unknown or unsupported, `getAdapter` fails with a clear unsupported-source error; it must not silently fall back to another adapter.

**Two-phase parsing design:**

1. **Discovery (lightweight):** Scans JSONL files, extracts only metadata (title, summary, project name/path, dates, slug), and reads at most the shared `SCAN_METADATA_MAX_LINES` head of each local source file. It does not parse all messages or load full content into memory. This keeps discovery fast even with large files: the adapter stops when its metadata completion condition is satisfied or when the line bound is reached.
2. **On-demand (full parse):** When `clog show`, `clog diff`, MCP `clog_get`, save, or indexing needs full content, `parseMessages()` reads and parses the entire JSONL file. This is where source-specific deduplication, correlation, and message normalization happen.

### 4.2 Claude Code Adapter

Claude Code stores conversations in `~/.claude/projects/` as JSONL files. The directory structure encodes the project path:

```
~/.claude/projects/
├── -Users-alice-myproject/
│   ├── c7044ea5-c019-44d6-a77a-500036740f9a.jsonl  # One conversation per file
│   ├── c7044ea5-c019-44d6-a77a-500036740f9a/
│   │   └── subagents/
│   │       ├── agent-aprompt_suggestion-*.jsonl  # Prompt suggestion subagents (skip)
│   │       └── agent-a<id>.jsonl                 # Task subagents (auxiliary sidechain logs; skip)
│   └── 123e4567-e89b-12d3-a456-426614174000.jsonl
└── -Users-alice-other-repo/
    └── 550e8400-e29b-41d4-a716-446655440000.jsonl
```

The filename (without `.jsonl`) is a UUID that serves as the `sessionId` / `sourceId`. Each `.jsonl` file contains one JSON object per line.

**Subagent conversations:** Each main conversation may have a `<sessionId>/subagents/` directory containing JSONL files for subagent (Task tool) conversations. These come in two types:
- **`agent-aprompt_suggestion-*.jsonl`** — Internal UI prompt suggestions. These have `isSidechain: true` on every line and contain no meaningful conversation content. **Skip these entirely.**
- **`agent-a<hex-id>.jsonl`** — Task subagent conversations (e.g., Explore, Bash agents). These are auxiliary sidechain logs for delegated work. In Phase 1, do not treat them as separate clog conversations and do not parse their transcript content into the parent conversation. They also have `isSidechain: true`.

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

Not all conversations have a summary line — only longer ones that Claude Code auto-summarizes. When a summary line appears within the scan-time discovery line bound, use this as the conversation's default `summary` field and set `summaryKind = "imported"` on newly unsaved conversations created by local discovery. A conversation file may contain at most one summary line, and that line may be found at the end of the file or near the end. Local source discovery does not read that far when the summary line is beyond `SCAN_METADATA_MAX_LINES`, so a late summary line is absent during scan-time metadata extraction.

#### 4.2.6 Adapter Discovery Behavior

During discovery (lightweight metadata extraction), the adapter reads only the bounded file head defined by `SCAN_METADATA_MAX_LINES` and will:

1. Glob `~/.claude/projects/*/*.jsonl` for main conversations (direct children of project dirs)
2. Ignore `~/.claude/projects/*/*/subagents/` files for discovery. They are auxiliary sidechain logs, not separate discoverable conversations.
3. Set `projectPath` from the first `cwd` field found in the main conversation JSONL. Claude records may contain multiple `cwd` values over the life of a conversation as the agent moves into subdirectories; for project identity, the first `cwd` is authoritative because it best represents where Claude Code was started. Later `cwd` values must not overwrite `projectPath` during discovery.
4. Scan each JSONL file's bounded head for metadata only:
   a. Find the first projected canonical user message represented by a `type: "user"` line where `message.content` is a string, after skipping any string that is wrapper-only under the hidden-wrapper rule in §4.2.7 → use as title (truncated to 100 chars without adding a display ellipsis)
   b. Find the `type: "summary"` line if present → use as summary
   c. Extract the first valid `cwd` found → use as `projectPath`
   d. Set `projectName` to the basename of `projectPath` when `projectPath` is available; otherwise leave `projectName = null`
   e. Extract the first `timestamp` found → use as `createdAt`
   f. Extract the `slug` field from any line that has it
   g. Stop scanning early once all Claude Code discovery metadata is found; otherwise stop when the discovery line bound is reached
5. Use the filename (without `.jsonl`) as both the `sourceId` and the conversation `id` — this is a UUID (e.g., `"c7044ea5-c019-44d6-a77a-500036740f9a"`)

For scan-time discovery, a Claude Code `summary`, `slug`, or `cwd` that appears only after `SCAN_METADATA_MAX_LINES` is treated as absent. A missing in-bound `cwd` leaves `projectPath` unknown, and the local discovery pipeline reports the conversation as undiscoverable rather than inserting it into the database.

In Phase 1, the parent Claude conversation is the only first-class clog conversation unit. Task subagent files do not get separate DB rows, separate save units, or separate remote artifacts. Parent discovery and parsing rely on the parent JSONL file only; any parent-visible evidence of delegated work must come from canonical parent-file transcript records that survive the adapter's filtering rules.

#### 4.2.7 Adapter Full Parse Behavior

When full conversation content is needed (`parseMessages()`), the adapter will:

1. Read the entire parent JSONL file only
2. Filter to `type: "user"` and `type: "assistant"` lines
3. Skip `system`, `progress`, `file-history-snapshot`, `queue-operation` lines
4. For assistant messages, deduplicate by `message.id` — merge content blocks from lines sharing the same API message ID
5. Strip `thinking` content blocks
6. For user-string records, apply a narrow hidden-wrapper filter before deciding whether to emit a canonical `Message`. In Phase 1, only confirmed hidden model scaffolding may be dropped; user-visible local-command or status entries must remain canonical even when encoded with XML-like wrapper tags.
7. Do not parse or inline transcript content from `subagents/` sidechain files. If delegated work is visible to the user, it must already be represented by canonical transcript records in the parent file itself rather than by sidechain logs.
8. Preserve parser-derived transcript order. When multiple raw assistant entries merge into one rendered message, the merged message appears at the position of its first raw occurrence.
9. Normalize into the `Message[]` format (Section 3.2)

For Claude canonical user-message projection, a user-string record is wrapper-only only when its trimmed text consists entirely of one or more known hidden wrapper blocks and contains no other user-visible content. This allowlist is intentionally narrow. Unknown XML-like tags are not treated as hidden automatically, and known user-visible local-command/status wrappers remain in the canonical transcript.

In Phase 1, the only confirmed hidden Claude wrapper block name is `local-command-caveat`.

**Edge cases the adapter must handle:**
- Files containing only `file-history-snapshot` lines (no actual messages) — skip, treat as empty
- Files where `sessionId` is absent on some lines — use the filename UUID as canonical
- `message.content` can be either a `string` (user text) or an `array` (content blocks) — handle both
- Very large conversations (500+ JSONL lines, many of which are `progress` noise) — filter early
- The `parentUuid` field forms a tree (for branching conversations / sidechains) — for MVP, flatten to parser-derived transcript order and ignore branching

### 4.3 Codex CLI Adapter

Codex CLI stores sessions in `~/.codex/sessions/` as event-log JSONL files:

```
~/.codex/sessions/
└── YYYY/
    └── MM/
        └── DD/
            └── rollout-<timestamp>-<sessionId>.jsonl
```

Only JSONL files under the Codex `sessions/` directory are in scope. The Codex home directory defaults to `~/.codex/`, resolved via the user home directory on every platform (`$HOME/.codex/` on macOS/Linux, `%USERPROFILE%\.codex\` on Windows). Configured Codex paths may point either at a Codex home directory, regardless of its name or location (for example `~/.codex`), or directly at a sessions directory (for example `~/.codex/sessions`). The adapter must normalize each configured path to a sessions directory, then scan `**/*.jsonl` within that directory. It must never append `sessions/` to a path that already names the sessions directory. `~/.codex/history.jsonl`, SQLite state files, logs, and shell snapshots are not canonical conversation records for clog and must not be scanned as conversations.

Codex path normalization is deterministic:

1. Expand `~` and normalize the configured path.
2. If the configured path's basename is `sessions`, treat that path as the sessions directory.
3. Otherwise, treat the configured path as a Codex home and use `<configured>/sessions` as the sessions directory.
4. If the derived sessions directory does not exist or is not readable, warn for that configured path and skip it.
5. Glob `<sessionsDir>/**/*.jsonl`.

The glob may find JSONL files that are not conversation records. Only files whose basename matches `rollout-*.jsonl` are candidate conversations. Non-rollout JSONL files under the sessions directory are skipped without malformed-file warnings; they may be debug-logged. Malformed-file warnings apply only to rollout candidate files.

#### 4.3.1 JSONL Line Schema

Each line is a JSON object with a top-level `type` field. Observed line types:

| `type` | Purpose | Relevant to clog? |
|--------|---------|-------------------|
| `session_meta` | Stable session metadata such as id, timestamp, cwd, CLI version, provider | **Yes** — discovery metadata |
| `turn_context` | Turn-scoped context such as cwd, current date, timezone, sandbox policy, model | **Fallback only** |
| `response_item` | Canonical transcript items, tool calls, and tool outputs | **Yes** |
| `event_msg` | Operational events, user-message duplicates, commentary, token counts, command-end metadata | **Selective** |

Important payload shapes:

- `session_meta.payload.id` is the canonical Codex session ID.
- `session_meta.payload.cwd` is the primary `projectPath`.
- `response_item.payload.type == "message"` contains message records. `payload.role` identifies the message role, and `payload.content` is an ordered array of content blocks. User transcript text appears in blocks shaped like `{ "type": "input_text", "text": string }`; assistant transcript text appears in blocks shaped like `{ "type": "output_text", "text": string }`. Records with `role: "developer"` contain instruction/context material and are not part of the rendered transcript.
- `response_item.payload.type == "function_call"` contains tool name in `payload.name`, arguments in `payload.arguments`, and the correlation key in `payload.call_id`.
- `response_item.payload.type == "function_call_output"` contains the correlation key in `payload.call_id` and rendered tool output text in `payload.output` when `payload.output` is a string.
- `response_item.payload.type == "reasoning"` contains internal model reasoning and is not part of the rendered transcript.
- `event_msg.payload.type == "user_message"` may duplicate the user prompt. The fallback prompt text is in `payload.message` when it is a string.
- `event_msg.payload.type == "agent_message"` is operational progress commentary and is not part of the rendered transcript.
- `event_msg.payload.type == "exec_command_end"` may contain command execution status keyed by `payload.call_id`. Observed status fields are `payload.exit_code`, `payload.status`, `payload.stdout`, `payload.stderr`, `payload.aggregated_output`, and `payload.formatted_output`.

#### 4.3.2 Adapter Discovery Behavior

During discovery, the adapter will:

1. Normalize configured Codex paths to sessions directories, then glob `<sessionsDir>/**/*.jsonl`
2. Treat one candidate `rollout-*.jsonl` file as one conversation; skip non-rollout JSONL files without warning
3. Use `session_meta.payload.id` as `sourceId` only when it is UUID-shaped
4. Derive a fallback `sourceId` from the filename only when the filename matches the Codex rollout pattern and ends with a UUID-shaped session ID: `rollout-<timestamp>-<sessionId>.jsonl`. Parse this by matching the UUID suffix before `.jsonl`, not by naively splitting on `-`.
5. If no valid embedded ID appears within the discovery line bound and the filename-derived ID is valid, use the filename-derived ID. If an embedded ID was present within the bound but malformed, emit a warning.
6. If both the embedded ID and filename-derived ID are valid within the discovery line bound but differ, use the embedded ID and emit a warning
7. If neither source provides a valid UUID-shaped ID, report the file as malformed and skip it
8. Use `session_meta.payload.cwd` as `projectPath`; otherwise, after the discovery line bound is reached without an in-bound `session_meta.payload.cwd`, fall back to the first valid `turn_context.payload.cwd` encountered within the bound; set `projectName` to the basename of `projectPath` when available
9. Use the earliest human prompt in source-file order as the title source, truncated to 100 characters without adding a display ellipsis. When that prompt is represented by both a canonical `response_item.message(role="user")` record and an `event_msg.user_message` duplicate, prefer the `event_msg.user_message` text from `payload.message` as the cleaner rendering of that same prompt. If the earliest human prompt has no usable `event_msg.user_message`, fall back to the canonical user message text after skipping wrapper-only messages. If no usable human prompt exists, use `"(untitled)"`
10. Use an empty string for `summary`
11. Use `null` for `slug`
12. Use `session_meta.payload.timestamp` as `createdAt`; otherwise, after the discovery line bound is reached without an in-bound `session_meta.payload.timestamp`, fall back to the first valid top-level timestamp encountered within the bound, then file mtime

Codex discovery scans until the Codex metadata completion condition is satisfied or `SCAN_METADATA_MAX_LINES` is reached. It must not assume `session_meta` is always the first line, even if that is the common observed shape. A filename-derived source ID, top-level timestamp, or `turn_context.payload.cwd` is a fallback candidate during the bounded scan; it becomes final only after the matching primary `session_meta.payload.*` value has been found within the bound, or after the discovery line bound is reached without finding that primary value.

For Codex title extraction during discovery, a canonical user prompt remains pending until the nearby duplicate window closes. A later `event_msg.user_message` replaces the canonical title candidate only when it has the same normalized text and either the same top-level timestamp or adjacency after ignored metadata and non-transcript records. The pending title window closes when discovery sees the first later relevant transcript record that does not share the canonical prompt's top-level timestamp. If no duplicate appears before the window closes or before the discovery line bound is reached, the canonical prompt becomes the final title candidate.

The empty Codex `summary`, `summaryKind = "none"`, and `null` Codex `slug` values are intentional in Phase 1. Unlike Claude Code, which may provide native `summary` lines and `slug` fields in its source format, the observed Codex source format does not expose an equivalent trusted native summary or slug field for discovery, and clog does not synthesize one.

Discovery filtering operates on the detected `projectPath`, not the `~/.codex/sessions/...` storage path.

If `projectPath` cannot be determined, discovery fails closed for that conversation: skip it and emit an aggregated `path_filter_without_project` warning. The current user-facing copy is `project path missing: these conversation files have no cwd metadata`. This applies even when no `includePaths`, `excludePaths`, or path-like `clogignore` rules are configured. clog treats unknown project paths as unsafe because project-path filtering is the primary privacy boundary for local discovery, and including projectless conversations would make later filter changes change what private data had already entered the DB.

For Codex title extraction, a canonical user message is wrapper-only when its trimmed extracted text consists entirely of one or more known context wrapper blocks and contains no other human prose. In Phase 1, the known wrapper block names are `environment_context` and `user_shell_command`. This allowlist is intentionally narrow because the exact set of Codex wrapper tags may evolve; unknown XML-like tags are not treated as wrapper-only automatically.

#### 4.3.3 Adapter Full Parse Behavior

When full conversation content is needed, the adapter will:

1. Read the entire JSONL file
2. Preserve top-level source-file order after projection into `Message[]`, except where the tool-correlation rules below suppress duplicate fallback records
3. Emit user prompts from canonical `response_item.message` records with `role == "user"` by extracting `input_text` blocks
4. Emit assistant prose from `response_item.message` records with `role == "assistant"` by extracting `output_text` blocks
5. Emit tool uses from `response_item.function_call`
6. Emit compact tool results from `response_item.function_call_output`, correlated by `call_id`, at the `function_call_output` record's source position
7. Emit fallback user prompts from `event_msg.user_message` at the event's source position only when the nearby-dedup rule below does not find a matching canonical user message
8. Use `event_msg.exec_command_end` as a fallback compact tool result only when no `function_call_output` exists anywhere in the file for the same `call_id`
9. Drop `response_item.message` records with other roles, including `role == "developer"`
10. Drop `session_meta`, `turn_context`, `token_count`, `agent_message`, and `reasoning` records

For Codex message text extraction, process `payload.content` in array order. For user messages, concatenate blocks where `type == "input_text"` and `text` is a string. For assistant messages, concatenate blocks where `type == "output_text"` and `text` is a string. Join multiple extracted text blocks with a blank line (`"\n\n"`). If no matching text blocks are present, emit no `Message` for that record. Unknown content block types are ignored for transcript projection.

For canonical Codex user-message projection, strip a leading hidden wrapper prelude before deciding whether to emit a `Message`. In Phase 1, this prelude consists of:

- an optional `# AGENTS.md instructions for ...` header followed by an `<INSTRUCTIONS>...</INSTRUCTIONS>` block
- zero or more leading known wrapper blocks such as `environment_context` and `user_shell_command`

After stripping that leading prelude, emit the remaining user text if any; if nothing remains, emit no canonical user `Message` for that record. This normalization is intentional: the raw JSONL remains the source of truth, but clog's projected transcript should not surface agent-only setup or environment wrapper text that Codex treats as hidden scaffolding rather than user-authored conversation content.

For fallback `event_msg.user_message` extraction, use `payload.message` when it is a string. If `payload.message` is missing, non-string, or empty after trimming, emit no fallback `Message` and do not use that event for title extraction.

Codex emitted `Message.timestamp` values come from the top-level timestamp of the JSONL record that emitted the message. `response_item.message`, `response_item.function_call`, `response_item.function_call_output`, fallback `event_msg.user_message`, and fallback `event_msg.exec_command_end` each use their own source record's top-level timestamp. If the emitting record has no valid timestamp, set `timestamp: null`. Correlated metadata does not change timestamp: a tool result that borrows a tool name from `function_call` or status from `exec_command_end` still uses the timestamp of the emitted result record.

`event_msg.user_message` is an event-bus copy of a human prompt and is a fallback transcript source only. Do not emit it when a nearby canonical `response_item.message(role="user")` has the same normalized text. Nearby means either the same top-level timestamp or adjacent after ignoring non-transcript records. For this comparison, normalize by converting CRLF to LF and trimming leading/trailing whitespace. Do not deduplicate canonical user messages against each other, and do not infer branch structure from duplicate prompt text. Future branch-aware parsing must use explicit branch or parent metadata, not duplicate text alone.

Title extraction is chronological: it uses the earliest human prompt in source-file order. When that prompt has both a canonical `response_item.message(role="user")` form and an `event_msg.user_message` duplicate, title extraction prefers the `event_msg.user_message` text because it is often the cleaner rendering without wrapper blocks. Transcript parsing still prefers canonical `response_item.message` records and uses `event_msg.user_message` only as a fallback so duplicate prompts are not rendered.

Phase 1 assumes Codex `response_item` records are canonical and are not deduplicated across distinct source lines. If duplicate canonical transcript items are observed in practice, add a source-native dedup rule based on stable native identifiers rather than text matching.

For the nearby-dedup rule, ignored events are exactly `session_meta`, `turn_context`, `event_msg.token_count`, dropped `response_item.reasoning` records, `response_item.message` records that are dropped from transcript projection, and other records that the Codex adapter drops entirely from transcript projection. `response_item.function_call`, `response_item.function_call_output`, and `event_msg.exec_command_end` are not ignored for adjacency.

#### 4.3.4 Tool Correlation

Codex tool calls are correlated by `call_id`:

- `function_call` registers the tool name and arguments and emits a `tool_use`
- `function_call_output` is the canonical result record and emits the preferred `tool_result` at the `function_call_output` record's source position
- `exec_command_end` records command status metadata and can provide a fallback result for the same `call_id`
- if both output forms exist for the same `call_id`, only the `function_call_output` result is emitted; the associated `exec_command_end` is not emitted separately, but its exit/status metadata may be used to make the emitted summary more accurate
- if multiple outputs exist for the same `call_id`, use the first valid `function_call_output` and ignore later duplicates deterministically
- if multiple `exec_command_end` records exist for the same `call_id`, use the last valid one in source-file order and ignore earlier duplicates deterministically
- if a tool result has no matching call, emit a compact `tool_result` with unknown tool metadata rather than dropping it silently

Because `function_call_output` summaries may borrow status from an `exec_command_end` that appears elsewhere in the file, implementations must either collect tool records by `call_id` before projection or perform an equivalent two-pass parse.

Tool-use content should be compact: `<toolName>: <summarized arguments>`. If arguments are valid JSON, preserve parsed `toolInput`; if not, preserve the raw argument string in the summary and leave `toolInput` unset.

Tool-result content should be compact and status-oriented. Field extraction rules:

- for `function_call_output`, use `payload.call_id` as the correlation key and `payload.output` as the rendered output text only when `payload.output` is a string
- for `exec_command_end`, use `payload.call_id` as the correlation key, `payload.exit_code` as the exit code when it is numeric, and `payload.status` as the status string when it is a non-empty string
- for `exec_command_end` fallback output presence, prefer `payload.formatted_output` when non-empty after trimming; otherwise use `payload.aggregated_output` when non-empty after trimming; otherwise treat fallback output as present when either `payload.stdout` or `payload.stderr` is a non-empty string after trimming
- for `exec_command` `function_call_output` records, determine whether command output is present from the portion of `payload.output` after the first literal `Output:\n` marker, if present. Trim surrounding whitespace from that suffix before testing emptiness. If the marker is absent, treat the rendered output as present when `payload.output` is a non-empty string after trimming
- for non-`exec_command` `function_call_output` records, treat output as present when `payload.output` is a non-empty string after trimming

Observed Codex `exec_command_end` payloads frequently contain large `aggregated_output` / `formatted_output` strings, often several KB and sometimes around 10 KB. clog uses those fields only to detect whether output is present; it does not inline raw fallback output into `Message.content`. This compact-summary rule is intentional and is backed by direct inspection of observed local Codex session logs during spec review.

Tool-result summary rules:

- if `function_call_output` exists and a matching `exec_command_end` has a non-zero exit code, render `<toolName>: exit <code>`
- if `function_call_output` exists and a matching `exec_command_end` has exit code `0` and the extracted output is present, render `<toolName>: output`
- if `function_call_output` exists and a matching `exec_command_end` has exit code `0` and the extracted output is absent, render `<toolName>: completed`
- if `function_call_output` exists and no usable `exec_command_end` status exists, render `<toolName>: output` when the extracted output is present and `<toolName>: completed` when it is absent
- if no `function_call_output` exists and an associated `exec_command_end` has a non-zero exit code, render `<toolName>: exit <code>`
- if no `function_call_output` exists and an associated `exec_command_end` has exit code `0` and fallback output is present, render `<toolName>: output`
- if no `function_call_output` exists and an associated `exec_command_end` has exit code `0` and fallback output is absent, render `<toolName>: completed`
- if no `function_call_output` exists and an associated `exec_command_end` has no exit code but has a status string, render `<toolName>: <status>`
- if no `function_call_output` exists and an associated `exec_command_end` has neither a usable exit code nor a usable status string, render `<toolName>: output` when fallback output is present and `<toolName>: completed` when fallback output is absent
- if the tool name is unknown, use `tool`
- for command execution fallback, use content like `exec_command: exit 0` or `exec_command: error`

Raw command output remains available in the source JSONL file and is not copied into `Message.content`.

---

## 5. CLI Commands

The CLI is the primary interface for developers. The command vocabulary is deliberately Git-like where the metaphor fits, but avoids pretending to be Git.

### 5.1 Command Reference

```
clog init                  Re-run setup (alias: `clog setup`; runs automatically on first use; explicit init can confirm author and offer search and MCP setup)
clog status [-c|--conversations] [--source] [--undiscoverable]  Show unsaved and changed saved project summaries + scan filter counts
clog list [filters]        List conversations (default: saved)
clog exclude <rule...>     Append literal ignore rules to ~/.clog/clogignore
clog unexclude <rule...>   Remove exact ignore rules from ~/.clog/clogignore
clog remove <rule...>      Remove saved conversations currently known to clog
clog edit <id> [flags]     Edit conversation metadata (--title, --summary, --author)
clog tag <id> <tags...>    Add tags to a conversation
clog untag <id> <tags...>  Remove tags from a conversation
clog save [selectors...]   Save conversations to the knowledge base
clog save --all            Save every local conversation with pending changes
clog diff [id...]           Show new messages since last save
clog show <id>             Display a conversation's content and metadata
clog show <id> --path      Print the file path (raw copy if saved, source if unsaved)
clog show <id> --head N    Show only the first N messages (--first is an alias)
clog show <id> --tail N    Show only the last N messages (--last is an alias)
clog path <id>             Print the file path (shorthand for show --path)
clog drain <selector>      Export conversation data to stdout (JSON by default)
clog drain [filters]       Export a filtered set to stdout
clog drain <selector> --to <path>  Export one conversation to a file
clog drain <selectors...> --to-dir <dir>  Export one file per conversation to a directory
clog drain <selectors...> --format pair --to-dir <dir>  Export saved conversations as portable conversation file pairs
clog fill <dir> [--own]    Import portable conversation file pairs
clog plunge [--json] [--verbose]  Audit local clog state for obvious corruption
clog config [get|set]      View or edit configuration
clog mcp setup [client]    Register clog's MCP server with Claude Code, Codex CLI, or both
clog talk [client]         Open an MCP-capable agent primed with current clog state
clog summarize [client]    Open an MCP-capable agent with a summarization-focused prompt
clog rename-author <old> <new>  Rename author across local conversations

# Phase 2 — Semantic Search (see §10 for details)
clog search --init         Set up semantic search
clog search <query>        Semantic search across saved conversations
clog index [--rebuild]     Index saved conversations whose search index is missing or stale

# Phase 3 — Team Sharing (see §11 for details)
clog remote add <url>      Configure a git remote for team sharing
clog remote show           Show remote configuration and sync status
clog remote remove         Remove remote and purge conversations from the configured remote
clog sync push             Push saved conversations to the remote
clog sync pull             Pull conversations from the remote
clog refresh               Reconcile DB from git checkout without fetching
```

All commands that accept `<id>` also accept short prefixes (minimum 4 characters). See Section 3.3 for details.

### 5.1.1 Shared Selector Model

`clog save` and selector-bearing `clog drain` share one project-aware selector model.

For these commands, each positional token may resolve as either:

- a conversation ID selector (`abcd1234`, `abcd1234@claude-code`)
- a project selector (`api-service`, `project:api-service`)

Resolution rules:

- bare tokens first check both spaces: conversation IDs and project names
- if a bare token matches both, the command fails with an ambiguity error and tells the user to disambiguate with either a fuller or source-qualified conversation ID, or `project:<name>`
- the 4-character ID-prefix minimum from §3.3 does not preempt this ambiguity check: a bare token shorter than 4 characters that matches both a project name and any conversation ID prefix still raises the cross-space ambiguity error rather than silently resolving to the project
- `project:<name>` is the explicit project-selector escape hatch
- final targets are deduplicated by canonical conversation ID

Project selectors are a batching mechanism, not a separate command meaning. `clog <command> <project>` must behave like applying `clog <command> <id>` to each command-eligible conversation in that project, using the same validation and state-transition rules as the per-conversation form. Command-specific eligibility still matters: for example, `clog save <project>` batches only the pending save work described in §5.4, not every clean saved conversation in the project.
Mixed selectors are allowed, such as `clog save myapp abcd1234`.

Singular commands such as `clog show`, `clog edit`, `clog tag`, `clog untag`, `clog path`, and `clog diff` remain conversation-only. On those commands, bare tokens are always conversation IDs and `project:<name>` is rejected explicitly.

### 5.2 Workflow

A typical session looks like:

```bash
# 1. See what's new (scanning happens automatically)
$ clog status
Saved conversations to resave:
  (use "clog save" to save these updates)
    api-service  1 modified  2026-02-18

Saved conversations whose source files changed:
  (use "clog save <id>" to refresh the saved copy from its source file)
    api-service  1 conversation  2026-02-15

Unsaved conversations:
  (use "clog save <id>" or "clog save <project>" to save)
    api-service  1 unsaved  2026-02-18
    frontend     1 unsaved  2026-02-17

(8 filtered by config, 4 ignored by clogignore)

# 2. Review unsaved conversations
$ clog list --state unsaved
ID        DATE        STATE       PROJECT          TITLE
d4e5f6a7  2026-02-18  unsaved     api-service      Add rate limiting middleware
g7h8i9b0  2026-02-17  unsaved     frontend         Fix SSR hydration mismatch
...

# 3. Save interesting ones
$ clog save a1b2c3 d4e5f6
Saved 2 conversation(s).

# 4. Tag them
$ clog tag a1b2c3 auth debugging
$ clog tag d4e5f6 rate-limiting middleware

# 5. Fix a title
$ clog edit a1b2c3 --title "Debug JWT refresh race condition"

# 6. Resave after metadata changes
$ clog save
Saved 2 conversation(s).

2 saved conversation(s) don't have structured summaries. Run `clog talk` to start an agent session.

# 7. Get the raw file path for a conversation
$ clog path a1b2c3
/Users/alice/.clog/raw/claude-code/a1b2c3.jsonl

# 8. View full conversation content
$ clog show a1b2c3
```

### 5.2 The `status` Command

`clog status` scans enabled local sources, refreshes discovery metadata, and shows the local projects that need attention:

- **Saved conversations to resave:** saved conversations whose saved raw copy, parsed message count, or saved metadata is ahead of the last saved checkpoint. `clog save` with no arguments saves everything in this group.
- **Saved conversations whose source files changed:** saved conversations whose source file differs from the clog-managed raw copy. `clog save <id>` refreshes the raw copy from its source file and saves it.
- **Unsaved conversations:** local source conversations not yet saved.

By default, each non-empty section shows one row per project. A project row includes the project name, compact conversation counts for the statuses present in that section, and the newest conversation date in that project bucket. Projects are sorted by newest displayed bucket date first, with project name as the tie-breaker.

When there is nothing pending saving, `clog status` prints the existing clean-state message instead of empty sections.

`clog status` accepts an optional `--conversations` flag, with `-c` as a shorthand. When present, status shows the conversation-level row layout with short ID, date, project, and title.

`clog status` accepts an optional `--source` flag. When present, status shows the conversation-level row layout and includes a `SOURCE` column immediately after the short `ID` column. The value is the canonical source key such as `claude-code` or `codex-cli`.

`clog status` accepts an optional `--undiscoverable` flag. When present, an additional section is appended listing conversations that were skipped because their project path metadata was unavailable. The section includes the explanatory line `project path missing: these conversation files have no cwd metadata`, then shows each source adapter and source file path. When `--undiscoverable` is absent and the undiscoverable count is non-zero, the filter summary line includes the count and a hint, e.g. `(2 undiscoverable; run "clog status --undiscoverable" for details)`. This is analogous to `git status --ignored`. `clog status` suppresses the per-file `path_filter_without_project` stderr warnings in favor of the summary count; other scan-driven commands continue to emit a single aggregated warning.

Example shape with `--conversations --source`:

```text
Unsaved conversations:
  (use "clog save <id>" or "clog save <project>" to save)
    unsaved:       d4e5f6a7  claude-code  2026-02-18  api-service Add rate limiting middleware
```

`clog status` uses its own compact row format rather than the generic `clog list` table. In the conversation-level layout, the `PROJECT` field is content-width: it is sized to the widest displayed project name in that status view, plus one trailing space of padding. It must not expand to consume additional terminal width beyond that content-based width. Any remaining horizontal space belongs to the rendered title text.

### 5.3 The `list` Command

`clog list` with no flags shows saved conversations. This is the knowledge-base view: conversations the user has explicitly saved locally, plus same-author imported saved conversations from git reconciliation or `clog fill` when `config.author` is set. If `config.author` is unset, the default view shows saved local conversations only. §11.10 defines the exact provenance filter.

**Flags:**

| Flag | Short | Description |
|------|-------|-------------|
| `--state <state>` | `-s` | Filter by state (`unsaved`, `saved`) |
| `--all` | | Show all known conversations, plus ignored local source conversations that are still discoverable |
| `--project <name>` | `-p` | Filter by project |
| `--author <name>` | `-a` | Filter by author |
| `--tag <tag>` | `-t` | Filter by tag |
| `--grep <text>` | `-g` | Filter by text match on title, summary, or message content |
| `--columns <cols>` | `-c` | Columns to show (comma-separated: `id,date,state,source,project,author,title`, or `all`) |
| `--origin <origin>` | | Filter by provenance view: `local` for `origin_kind = 'local'`, `remote` for imported rows (`origin_kind != 'local'`) |

```bash
# Filter by state
$ clog list --state unsaved

# Show everything, including unsaved rows and rediscovered ignored local sources
$ clog list --all

# Filter by project, author, tag, or text search
$ clog list -p api-service
$ clog list -a alice
$ clog list -t debugging
$ clog list -g "auth"

# Combine filters
$ clog list -s saved -p api-service -g "token"

# Control which columns appear
$ clog list --columns all
$ clog list -c id,date,title
```

Columns are dynamically sized to the terminal width. For every non-terminal column, width is computed from the current result set as `max(header width, widest rendered cell width) + 1`, producing dense output without large fixed-width gaps. The final visible column absorbs the remaining terminal width. When that final column is truncated, it must still allow at least `1` visible character plus `...` (minimum width `4`). The `author` column is auto-shown when multiple distinct authors are present, even without `--columns`. The `source` column is auto-shown when the selected result set contains conversations from multiple distinct sources. `--columns` still overrides the default column set.

`clog list --all` is partly discovery-backed. It lists DB-backed conversations in any state, and it may also scan enabled local source paths to show ignored conversations that are still present on disk. These ignored rows are ephemeral display rows: they are not stored in the database, they are shown dimmed with state `ignored`, and they disappear from `list --all` if the source file is deleted, moved outside enabled scan scope, or belongs to a disabled source. Remote conversations are never synthesized into these ephemeral rows.

Metadata filters on `clog list` are exact-match selectors, not fuzzy search. This keeps selection predictable and makes it clear that text discovery belongs to `--grep`, not to metadata filters. The `--help` output should describe `--project`, `--author`, and `--tag` as exact metadata filters so users do not expect substring matching.

`--project` matches against `projectName`, using case-insensitive exact matching. Users pass `api-service`, not `/Users/alice/work/api-service`. LIKE wildcards (`%`, `_`) in the project name are escaped to prevent injection in DB queries. There is no default user-facing path filter flag; local path filtering belongs in config and `clogignore`.

`--author` matches `author` by exact, case-sensitive string equality. It is not substring, fuzzy, or case-insensitive matching.

`--tag` matches tags by exact, case-insensitive equality after tag normalization. It is not substring or fuzzy matching.

`--grep` performs a simple case-insensitive substring match against the `title`, `summary`, and message `content` fields. A conversation matches if any of those contain the search text. This is deliberately simple — it's not regex, not full-text search, not semantic. It's the equivalent of piping through `grep -i` and is intended to remain useful alongside semantic search (Section 10), since it's fast, predictable, and doesn't require any additional dependencies. Message-content matching requires reading the curated raw file for each candidate conversation, which is acceptable at Phase 1 scale; if this becomes a bottleneck, Phase 2's search index is the right place to optimize it. Conversations whose raw content cannot be read fall back to metadata-only matching.

### 5.4 The `edit` Command

`clog edit` modifies metadata on saved local conversations. It uses CLI flags — there is no interactive mode or editor integration.

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

The `--author` flag changes the author on an individual conversation. This is distinct from `clog config set author` (which changes the default for future local discoveries) and `clog rename-author` (which renames an author across all local conversations).

Tags are managed separately via `clog tag` / `clog untag`.

If every supplied value already matches the current metadata and the operation does not change `summaryKind` or clear `summaryExtraction`, `clog edit` is a no-op: it does not update `modified_at` and reports that nothing changed.

If an edit changes title, summary, or author, `modified_at` is set to the edit time. If the changed field is search-visible, search invalidation follows §10.8.1.

Passing `--summary` is a user curation gesture. A non-blank `--summary` sets `summaryKind = "curated"` even if the text matches the existing summary. Clearing the summary with `--summary ""` sets `summary = ""`, `summaryKind = "none"`, and `summaryExtraction = null`, making the conversation eligible for agent summarization again.

**Message-level editing is not supported.** If a user needs to redact sensitive data from conversation content, they should save the conversation, then edit the raw JSONL file directly:

```bash
$ clog path a1b2c3
/Users/alice/.clog/raw/claude-code/a1b2c3.jsonl

# User opens and edits the file with their preferred editor
```

The raw JSONL copy is the curated content for saved conversations. For a saved conversation whose source has grown, explicit `clog save <id>` refreshes the raw copy from the source and saves the new checkpoint. No-argument `clog save` does not pull in source changes; it saves already-saved conversations whose raw copy or metadata is ready to resave.

### 5.4.1 The `tag` and `untag` Commands

`clog tag` and `clog untag` manage the `tags` array on a saved conversation's metadata row. They operate on saved local conversations; unsaved conversations are not part of the curated knowledge base yet, and imported conversations are read-only and are rejected (see §11.6).

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

When `clog tag` or `clog untag` actually changes the tag set, `modified_at` is set to the operation time. Tag changes update database metadata used by filters, but they do not trigger vector re-indexing and do not change `indexedAt` because tags are not part of the embedded search content (§10.8.1).

### 5.5 Implicit Scanning

There is no explicit `discover` command. Scanning for new and updated conversations happens automatically when relevant commands run (`status`, `list`, `save`). Developers see the current state without an extra step.

**Scanning behavior:**

Scanning iterates every enabled source adapter. Counts may remain source-agnostic in normal output, but diagnostic scan output must name the source for each conversation found or skipped by local discovery.

Local source discovery reads only the bounded metadata head of each enabled source file. The `source_mtime` column is row metadata used after adapter discovery to avoid unnecessary database rewrites and to support dirty/status behavior; it is not a cache key that skips adapter metadata reads.

Scanning is idempotent. Each scan will:

- Find new conversations not yet in the database → insert as `unsaved`
- When inserting a new local unsaved conversation, set `author = config.author`. Later scans must not rewrite `author`; use `clog edit --author` or `clog rename-author` for explicit changes.
- Avoid rewriting existing rows whose discovered `sourcePath` and post-discovery `source_mtime` match the stored row for the same `source + sourceId`
- If a local source candidate has the same `(source, sourceId)` as a `git` or `file` row, leave the imported row unchanged and do not insert a duplicate local row. The imported row remains authoritative for that identity until the user removes it.
- **Detect updated source files** for local conversations in any state. When the post-discovery `source_mtime` comparison shows that a source file's mtime has changed since the last scan:
  - For `unsaved` conversations: re-extract metadata (title and summary may change as the conversation grows). If the re-extracted summary is non-blank, set `summaryKind = "imported"`; otherwise set `summaryKind = "none"`. `summaryExtraction` remains `null`.
  - For `saved` conversations: preserve the stored metadata row and preserve the saved raw copy. Scan refresh may update only operational locator/cache fields such as `sourcePath`, `source_mtime`, and the dirty-marker fields explicitly called for by this spec; it must not rewrite stored metadata such as `title`, `summary`, `summaryKind`, `summaryExtraction`, `author`, `tags`, `slug`, `projectName`, or `projectPath`. Update `source_mtime` and `modified_at` to the scan time so status can report that newer source content is available, but do not copy source content into `~/.clog/raw/`. The user may run `clog save <id>` to refresh and save the newer source content.
- **Detect moved source files.** When a known local conversation's `sourcePath` no longer matches the path returned by the adapter (e.g., the project directory was renamed), update `sourcePath` in the DB. For `unsaved` conversations, also update `projectPath` and `projectName`. For `saved` conversations, keep `projectPath` and `projectName` unchanged; only the operational source-file locator moves.
- **Prune stale entries per source.** After discovery completes, remove `unsaved`-state DB entries whose source files are no longer found by that adapter. Only entries for the same source whose `sourcePath` falls under a scanned source directory are pruned — entries from unscanned paths or other sources are left alone. Saved conversations are never pruned because they have their own copies in `~/.clog/raw/`. The scan reports a `pruned` count alongside other filter counts.

**Malformed source files.** Scan-driven commands warn and skip malformed source files rather than prompting when a malformed JSONL record is encountered while the adapter is still extracting discovery metadata. This includes `clog status`, `clog list`, `clog save --all`, selector-bearing `clog save`, and any other command path that refreshes local unsaved conversations before acting. Warnings are aggregated per scan pass, printed to stderr, and include source, file path, reason, and recovery guidance when possible. Malformed transcript records after metadata discovery stops are handled by full content-reading commands such as `clog show` and `clog save` when those commands read the full source file. The command exit code remains 0 unless the requested operation itself fails.

Source discovery, pair validation, file import, and git reconciliation warnings use a structured internal shape:

```typescript
type ClogWarningCode =
  | "malformed_jsonl"
  | "missing_source_id"
  | "source_id_mismatch"
  | "path_filter_without_project"
  | "unsupported_source"
  | "missing_source_file"
  | PairWarningCode;

type PairWarningCode =
  | "pair_incomplete"
  | "pair_invalid_metadata"
  | "pair_id_mismatch"
  | "pair_invalid_content"
  | "pair_layout_mismatch"
  | "pair_duplicate_identity";

interface ClogWarning {
  code: ClogWarningCode;
  message: string;
  source?: string;
  path?: string;
  guidance?: string;
  paths?: string[]; // for warnings involving a remote file pair
  conversation?: {
    id: string;
    source: string;
  };
  pair?: {
    author?: string;
    source: string;
    id: string;
  };
}
```

CLI output may group warnings by `code` to avoid pages of repeated text. MCP surfaces the same warnings in a top-level `warnings` array on tools that perform scanning or git reconciliation; warnings are never injected into transcript text.

Source discovery keeps source-specific codes such as `malformed_jsonl`, `missing_source_id`, `source_id_mismatch`, `path_filter_without_project`, `unsupported_source`, and `missing_source_file`. Conversation file-pair validation and reconciliation use the `pair_*` codes above. A filename stem versus `meta.id` mismatch is `pair_id_mismatch` and the message names both values. A valid pair in the wrong git author or source directory is `pair_layout_mismatch`, not invalid metadata.

This structured warning contract applies to source discovery, conversation file-pair validation, file import, and git reconciliation diagnostics. Other warning families, such as search scan-cap warnings, Git credential warnings, or best-effort deindex cleanup warnings, may use their own simpler output contracts.

**Graceful handling of missing sources in scan-driven save flows.** `clog save --all` and selector-bearing `clog save` require a fresh scan because they operate on the current set of local unsaved conversations. If a requested selector no longer matches anything after that refresh, the command fails as "no conversation or project matches." If a source file disappears after scan but before the copy step, clog warns, deletes the stale unsaved row, and skips that conversation rather than crashing.

**No file copying during scan.** Raw JSONL files are not copied to `~/.clog/raw/` during scanning. Before a conversation is curated, clog reads metadata from the source location directly (read-only). Content is copied only by explicit save actions. This avoids doubling disk usage for conversations the developer never intends to curate.

**Performance:** Local discovery keeps scanning proportional to the number of enabled source files by reading only the bounded metadata head of each file. The database stores `source_mtime` after discovery so unchanged rows are not rewritten, but `source_mtime` does not skip adapter metadata reads. If scanning latency becomes an issue at thousands of conversations, the next optimization should preserve the bounded-read contract and avoid turning `clog status` or `clog list` into full transcript integrity checks.

**Filtering personal conversations:** Developers use personal laptops and will have conversations unrelated to the company. Scanning respects two explicit filter layers plus a fail-closed undiscoverable rule:

- `config.json` `includePaths` / `excludePaths` for persistent directory-level filtering
- `~/.clog/clogignore` for pattern-based rules (see Section 5.10)

The config file supports `sources.<name>.includePaths` and `sources.<name>.excludePaths` for each built-in source. If `includePaths` is set, only conversations whose `projectPath` values match those directories by the path-boundary rule in §7.1 are discovered. If `excludePaths` is set, matching `projectPath` values are skipped. Both can be used together. This is the primary mechanism for keeping personal conversations out of the knowledge base.

If a source cannot determine a conversation's `projectPath`, discovery fails closed for that conversation: skip it and emit an aggregated `path_filter_without_project` warning unless an earlier `clogignore` rule already suppressed it. The current user-facing copy is `project path missing: these conversation files have no cwd metadata`. This applies even when no `includePaths` or `excludePaths` are configured. clog treats unknown project paths as unsafe because project-path filtering is the primary privacy boundary for local discovery. The scan reports an `undiscoverable` count alongside the other filter counts. When the count is non-zero, `clog status` includes it in the dimmed filter summary line with a hint directing the user to `clog status --undiscoverable` for details.

### 5.6 The `save` Command

Saving is a local operation in Phase 1. It:

1. Changes or keeps the conversation's state as `saved`
2. Increments `save_version`
3. Ensures a raw curated file exists for the conversation
4. Parses the save candidate through the adapter selected by `source`
5. Sets `saved_at = now`
6. Sets `modified_at = now`
7. Sets `saved_message_count` to the number of parsed messages included in this saved version

```bash
# Resave saved conversations that already have pending saved-copy or metadata changes
$ clog save

# Save specific conversations or project-scoped batches
$ clog save a1b2c3 d4e5f6
$ clog save api-service
$ clog save project:api-service

# Save every local conversation with pending changes
$ clog save --all
```

When called with no arguments, `clog save` saves saved local conversations whose saved raw copy or metadata is already ahead of the last saved checkpoint. It does not implicitly save unsaved conversations, and it does not refresh saved conversations from changed source files. This prevents a bare command from pulling every local source conversation into the knowledge base by accident.

`clog save --all` explicitly saves every local conversation that `clog status` would flag as needing attention: unsaved conversations, saved conversations whose source file has new content, and saved conversations whose saved raw copy or metadata is ahead of the last saved checkpoint. It is the bulk equivalent of running `clog save <id>` for each row reported by `clog status`.

When called with explicit selectors, `clog save [selectors...]` can save unsaved or already saved local conversations.

Project selectors are only a batching mechanism here: `clog save myapp` must behave like applying explicit `clog save <id>` to each matching saveable local conversation in project `myapp`, using the same per-conversation save rules described below. For project selectors, "saveable" means conversations that `clog status` would report for that project: unsaved conversations, saved conversations whose source file differs from the clog-managed raw copy, and saved conversations whose raw copy or metadata is ahead of the last saved checkpoint. Clean saved conversations in the same project are not included in the project batch. A user may still explicitly pass a clean saved conversation ID to force a resave of that one row.

Per-conversation explicit save behavior:

- For an unsaved conversation, explicit save verifies the source file exists, copies it to `~/.clog/raw/<source>/<id>.jsonl`, sets `file_path`, parses that raw copy, and saves it.
- For a saved conversation whose source file is unchanged or unavailable, explicit save reads the existing raw copy at `file_path`.
- For a saved conversation whose source file exists and differs from the current raw copy, explicit save refreshes the raw copy from `sourcePath` before parsing and saving.

If a source file needed for an unsaved conversation is unavailable, that conversation fails clearly. If a saved conversation's source file is unavailable, explicit save falls back to the existing raw copy.

`saved_message_count` is `null` until the first successful save. Every save or resave replaces it with the current parsed message count.

Save preserves `summary`, `summaryKind`, and `summaryExtraction`; it does not summarize, clear, or refresh summary metadata. Summary freshness across later re-saves is intentionally not tracked in v1.

When save runs in an interactive terminal against more than one conversation, it renders single-line progress for the local save phase, updating in place as work completes:

```
58/58 conversations saved locally...
Saved 58 conversation(s).
```

The save-loop line ticks once per conversation as the raw copy and DB row are written. It terminates with a newline so the final count persists on screen. In non-TTY contexts (pipes, redirected output) only the final `Saved N conversation(s).` summary is written for the local save phase.

If at least one conversation was saved, `clog save` must then print an indexing outcome. Indexing is never silent:

- If search is not configured, print that search indexing is not configured and no indexing is necessary.
- If search is configured but dependencies or providers are unavailable, print that search indexing is unavailable and the saved conversations were left unindexed. The unindexed hint described below may then point to `clog index`.
- If search is configured and available, print an indexing-start line before embeddings are produced and a completion line such as `Indexed 58/58 conversation(s) for vector search.` after the attempt. In an interactive terminal with more than one conversation, an additional in-place progress line may tick once per conversation as embeddings are produced and upserted to the vector store.

After `clog save` completes, if any local saved conversations lack structured summaries, clog prints a bold hint:

```text
N saved conversation(s) don't have structured summaries. Run `clog talk` to start an agent session.
```

A conversation is counted as lacking a structured summary when `summaryKind != "curated"` and `summaryExtraction == null`. Source-native prose summaries (`summaryKind = "imported"`) and generated prose without extraction still count as lacking structured summaries. Curated conversations do not count, even if they lack extraction.

**Why `save` and not `commit`?** This is intentional. Git `commit` creates a permanent, immutable snapshot with a hash. `clog save` is a state change — conversations can be edited and re-saved. Calling it `commit` would set wrong expectations about immutability, revert semantics, and diff history. `save` communicates what actually happens: "this conversation is now visible to agents and (eventually) teammates."

### 5.7.1 The `show` and `path` Commands

`clog show <id>` displays conversation metadata followed by parsed messages. Saved conversations read from the clog-managed raw copy. Unsaved conversations can be shown from the source file when the source file is still available.

`clog show <id> --path` is path-output shorthand on the `show` command and is equivalent to `clog path <id>`.

The metadata header includes the canonical source key for every conversation:

```
ID:      a1b2c3d4
Source:  claude-code
Title:   Debug JWT refresh race condition
Project: api-service
State:   saved
```

Header metadata values are presentation-normalized. In particular, the `Title:` field is rendered as a single line with internal whitespace collapsed, even if the stored title contains embedded newlines or other multi-line whitespace. This normalization applies only to the metadata header; parsed transcript messages remain source-faithful.

When a conversation has a prose summary or structured extraction, `clog show` prints a compact summary block after the basic header and before messages:

```text
Summary: Debugged a JWT refresh race and updated the retry guard. (generated)
Topics:  auth, jwt
Outcome: fixed
Tools:   Edit, Bash
Notable: 1 moment
```

The `Summary:` line includes `summaryKind` in parentheses. Extraction lines are printed only for fields that are present and non-empty. `Notable:` shows only the number of notable moments, not their text. If both `summary` and `summaryExtraction` are empty, no summary block is printed.

When source is shown in CLI or MCP metadata, use the canonical raw source key such as `claude-code` or `codex-cli`, not a separate human-friendly display label.

`clog show` and `clog path` resolve content paths from the stored row. Unsaved local conversations read from `sourcePath`. Saved conversations read from `filePath`, which points at `~/.clog/raw/<source>/<id>.jsonl` for local saved rows, `~/.clog/remote/<author>/<source>/<id>.jsonl` for git-imported rows, and `~/.clog/imports/<source>/<id>.jsonl` for file-imported rows. `clog diff` is local-only; see §5.8.

### 5.7.2 The `plunge` Command

`clog plunge` is a whole-install, read-only diagnostic command for local clog state.

```bash
clog plunge
clog plunge --json
clog plunge --verbose
```

Its purpose is to answer a narrow question: "is this clog install obviously broken or inconsistent?" It does not repair anything automatically. It does not compact storage. It does not attempt to audit every subsystem clog may ever gain.

Unlike normal clog commands, `clog plunge` is not a bootstrap path. It inspects an existing clog install. It must not auto-create `~/.clog`, `config.json`, `clogignore`, or any other clog-managed files as part of preflight initialization. If the clog home does not exist yet, the command exits with a short explanatory note instead of initializing state.

`clog plunge` audits a bounded subset of clog-managed local state only:

- SQLite integrity and schema version
- basic DB row invariants that should never be violated
- curated raw-file presence and parseability for local saved rows
- save checkpoint sanity for local saved rows
- `clogignore`
- `config.json`

It intentionally does not audit search/vector coherence, remote checkout coherence, sync reconciliation state, storage compaction opportunities, orphan raw-file cleanup, or source-location health. Those are separate concerns.

For `plunge`, `local` means `origin_kind = 'local'`.

Findings use three severities:

- `fatal` — the command cannot rely on the audited foundation
- `corruption` — a clog invariant is violated
- `info` — informational only

The command currently checks:

1. SQLite `integrity_check`
2. schema version
3. recognized local `source` values
4. built-in-source `id == source_id`
5. valid row `state`
6. parseable `tags_json`
7. expected raw-file path/presence for local saved rows
8. successful raw-file parsing through the selected adapter
9. saved parser-sequence checkpoint drift (`saved_message_count`)
10. cleared save fields on unsaved rows
11. required save metadata on saved rows
12. parseable timestamps and `saved_at <= modified_at`
13. readable `clogignore`
14. supported `clogignore` rule syntax
15. `config.json` parse/schema validity
16. empty `config.author`
17. configured source/include/exclude paths that do not exist

Notes:

- If a row uses an unrecognized `source`, `plunge` reports that and does not emit additional adapter-dependent findings for that row.
- Checkpoint drift where the current parsed message count is below `saved_message_count` is informational, not corruption. This can happen when parser projection evolves without raw-file damage. The recovery path is to inspect the conversation and resave it so the stored checkpoint reflects the current parser output.

Human-readable output is grouped in stable subsystem order:

1. Database
2. Raw files
3. Save checkpoints
4. clogignore
5. Config

Conversation-scoped findings are rendered in a multi-line form:

```text
- [severity] shortid: Title:
    Message text.
    Recovery: ...
```

With `--verbose`, conversation-scoped findings also include:

```text
    Conversation ID: ...
    Source: ...
    Project: ...
    Author: ...
    Origin: ...
```

`--json` emits a single object with:

- `clogHome`
- `ranAt`
- `exitCode`
- `summary` with `fatal`, `corruption`, and `info` counts
- ordered `findings`

Each JSON finding includes:

- `check`
- `subsystem`
- `severity`
- `message`
- optional `recovery`
- optional `conversation` with full `id` and `source`
- optional `paths`

Exit codes:

- `0` — no `fatal` or `corruption` findings
- `1` — one or more `fatal` or `corruption` findings
- `2` — usage error, DB lock could not be acquired, or clog home is missing/inaccessible

Like other DB-touching paths, `clog plunge` acquires the DB lock for the duration of the run. It is diagnostically read-only, but DB locking still requires the temporary lockfile lifecycle under `CLOG_HOME`.

### 5.7.3 The `drain` Command

`clog drain` exports conversations out of clog as portable files or stdout
payloads. It is the inverse of curation: `clog save` brings conversations into
clog's curated knowledge base; `drain` lets them flow back out.

`clog drain` is read-only. It never modifies the database, raw files,
source files, or remote checkout contents.

This section defines the user-visible command contract. Lower-level export
format notes for `drain` live in
`docs/IMPLEMENTED/DRAIN_SPEC_NOTES.md`.

Supported command shapes:

```text
clog drain <selector>                   Single conversation or project-scoped export to stdout (JSON).
clog drain <selector> --format md       Single conversation to stdout (markdown).
clog drain <selector> --raw             Single conversation raw JSONL to stdout.
clog drain <selector> --to <path>       Single conversation to a file.
clog drain api-service --author alice   Project selector resolved within a filtered candidate set.
clog drain [filters]                    JSON array to stdout.
clog drain [filters] --refresh          Refresh local discovery, then export.
clog drain --to-dir <dir>               Default curated export to a directory.
clog drain <selectors...> --to-dir <dir> Multiple conversations to a directory.
clog drain --to-dir <dir> [filters]     Filtered conversations to a directory.
clog drain <selectors...> --format pair --to-dir <dir>  Saved conversations as portable conversation file pairs.
```

#### 5.7.3.1 Resolved Conversation Set

`clog drain` first resolves a conversation set from explicit selectors and filter
flags.

- By default, `clog drain` resolves against the current database state only.
- `--refresh` is an explicit opt-in to run the same local discovery refresh
  as `clog list` before resolving the conversation set. This refresh updates
  local unsaved conversations and emits the same aggregated scan warnings to
  stderr that other scan-driven commands use.
- If selectors and filters are both present, `clog drain` first builds the
  filtered candidate set, then resolves each explicit selector within that set.
- Filters are part of the user's selector. An invocation such as
  `clog drain abcd --author alice` is interpreted as "export Alice's
  `abcd` conversation," not "resolve `abcd` globally, then filter later."
- Likewise, `clog drain api-service --author alice` is interpreted as
  "export Alice's `api-service` conversations," not "resolve the project
  globally, then filter later."
- This means a globally ambiguous ID may resolve successfully if the
  filtered candidate set contains exactly one match.
- If multiple filtered candidates still match an ID, `clog drain` returns
  the normal ambiguity error with copy-pasteable candidates.
- If no filtered candidates match an ID, `clog drain` returns the normal
  no-match error for that ID.
- Project selectors participate in the same filtered candidate set as
  conversation IDs. They match project names using the shared selector model
  from §5.1.1 and expand to the filtered conversations in that project.
- After selector resolution and filter application, the resolved set is
  deduplicated by full conversation ID. Repeating the same ID, or mixing
  source-qualified and unqualified forms, or mixing a project selector with
  one of its member conversation IDs, does not produce duplicate exports.
- If neither selectors nor filters is present, the default scope matches
  `clog list`'s curated-by-default view: local curated conversations plus
  same-author imported conversations.
- If neither selectors nor filters is present and `config.author` is empty or
  unset, the default scope is local curated conversations only.
- Broader export requires explicit filters such as `--origin remote`,
  `--author`, or `--state`.
- Bare `clog drain` with no selectors, no filters, no `--to`, and no
  `--to-dir` is a usage error. To export to stdout, the user must provide
  at least one conversation selector or at least one filter flag.

This preserves the two intended command shapes:

- query-like export (`clog drain --state unsaved`,
  `clog drain --author alice`) operates on the current clog conversation library
- refreshed query-like export (`clog drain --state unsaved --refresh`)
  first updates local unsaved conversations, then exports from that updated
  state
- explicit export (`clog drain a1b2c3`, `clog drain api-service`) exports the
  conversations already known to clog without doing a discovery refresh first

#### 5.7.3.2 Modes

`clog drain` operates in one of three modes, determined by whether
`--to` or `--to-dir` is present.

**Stdout mode** (no `--to`, no `--to-dir`) writes the resolved export payload to stdout
with no progress output. Diagnostics go to stderr.

- `json` supports set export. A single explicit selector that resolves to one
  conversation, with no filters, writes
  one JSON object; otherwise stdout JSON is a JSON array in deterministic
  order.
- `md` requires exactly one matching conversation.
- `--raw` requires exactly one matching conversation.

Stdout mode is atomic. `clog drain` must not write partial export data to
stdout. If any conversation needed for the stdout payload fails, it writes
nothing to stdout, reports the error to stderr, and exits `1`.

**Single-file mode** (`--to <path>`): Writes exactly one exported
conversation to the supplied file path. It does not create parent
directories. Existing files are not overwritten unless `--force` is
passed. If the resolved set contains more than one conversation, `clog
drain` returns a usage error directing the user to `--to-dir`.

**Directory mode** (`--to-dir <dir>`): Writes one file per conversation into the
target directory. The directory is created if it does not exist, including
intermediate parents. Existing files are not overwritten unless `--force`
is passed.

Directory mode prints no per-conversation success output. When complete, it
prints a one-line summary to stderr:

```text
Drained 41 conversations to ./export/
Drained 38 conversations to ./export/ (3 failed)
```

Pair-format directory mode writes one conversation as two files, `<source>/<id>.jsonl`
and `<source>/<id>.meta.json`, using the shared interchange writer. Without
`--force`, either destination file already existing skips that conversation and
writes neither side. With `--force`, replacement is pair-atomic for overwrite
policy: clog writes the JSONL through the atomic writer first and installs
canonical metadata last, so a complete metadata file implies its content file is
present.

#### 5.7.3.3 Flags

| Flag | Short | Description |
|------|-------|-------------|
| `--to <path>` | `-o` | Write one exported conversation to this file path. Single-file mode only. |
| `--to-dir <dir>` | | Write one file per conversation to this directory. Directory mode only. |
| `--format <fmt>` | `-f` | Output format: `json` (default), `md`, or directory-only `pair`. |
| `--raw` | | Emit the exact underlying source file instead of parsed export data. Incompatible with `--format`. |
| `--force` | | File and directory output modes only. Overwrite an existing target file or directory entry. |
| `--refresh` | | Refresh local discovery before resolving the export set. This may update local unsaved conversations and emit aggregated scan warnings to stderr. |
| `--state <state>` | `-s` | Filter by state (`unsaved`, `saved`). |
| `--project <name>` | `-p` | Filter by project name (same semantics as `clog list --project`). |
| `--author <name>` | `-a` | Filter by author (same semantics as `clog list --author`). |
| `--tag <tag>` | `-t` | Filter by tag (same semantics as `clog list --tag`). |
| `--origin <origin>` | | Filter by origin: `local` or `remote` (same semantics as `clog list --origin`). |

`clog drain` supports a deliberate subset of `clog list` filters. In v1 it
supports metadata-backed export selection: `--state`, `--project`,
`--author`, `--tag`, and `--origin`.

Like `clog list`, these metadata filters are exact-match selectors rather
than fuzzy search. This keeps export selection predictable and avoids
overloading metadata filters with text-search behavior. The `--help` output
for `clog drain` should describe `--project`, `--author`, and `--tag` as
exact metadata filters so users do not expect substring matching.

Filter semantics:

- `--project` matches `projectName` by case-insensitive exact equality
- `--author` matches `author` by exact, case-sensitive string equality
- `--tag` matches normalized tags by exact, case-insensitive equality
- `--origin` matches `local` or `remote` exactly; `remote` means imported rows (`origin_kind != 'local'`)

`clog drain` does not support `clog list` display or discovery-expansion
flags such as `--columns` or `--all`, and it does not support content-search
selection via `--grep`.

#### 5.7.3.4 Selector Resolution

Conversation-ID resolution follows the same rules as other clog commands, as
defined in §3.3: short prefixes of at least 4 characters, source-qualified
forms (`a1b2c3@claude-code`), and ambiguity errors with copy-pasteable
candidates. Project-selector resolution follows the shared selector model in
§5.1.1.

When `clog drain` is invoked with explicit selectors and metadata filters, it
does not resolve selectors against the full conversation table and intersect
afterward. Instead, it:

1. builds the candidate set using the supplied `--state`, `--project`,
   `--author`, `--tag`, and `--origin` filters
2. resolves each explicit selector within that candidate set
3. deduplicates the resolved conversations by full ID

This preserves normal selector grammar while making filters participate in
disambiguation.

Consequences:

- an otherwise ambiguous conversation-ID prefix resolves successfully if the filtered
  candidate set contains exactly one match
- the same conversation-ID prefix still errors as ambiguous if multiple filtered candidates
  remain
- the same conversation-ID prefix errors as no-match if the filtered candidate set contains
  none
- source-qualified forms such as `prefix@source` continue to restrict
  matching to the named source, within the filtered candidate set
- project selectors such as `api-service` or `project:api-service` expand only
  within the filtered candidate set, so a filter like `--author alice` narrows
  the project batch before export

Directory mode accepts zero or more explicit selectors. Single-file mode requires
exactly one resolved conversation. Stdout mode may also be invoked with
selectors, filters, or both; the format-specific match-count rules from
§5.7.3.2 apply after resolution.

#### 5.7.3.5 Accessible Conversations

`clog drain` can export any conversation whose content path resolves
successfully:

- **Saved** — reads from `filePath`, whether that path is a local raw copy, a
  git checkout file, or an import-managed file
- **Unsaved** — reads from `sourcePath` if the source file still exists

Content-path resolution must reuse the same logic as `clog show` /
`clog path`.

#### 5.7.3.6 Ordering

Whenever `clog drain` exports more than one conversation, the resolved set
is ordered deterministically:

1. ascending by `createdAt`
2. then by `source`
3. then by full `id`

This order governs:

- JSON array output in stdout mode
- directory traversal order

#### 5.7.3.7 Exit Codes

| Code | Condition |
|------|-----------|
| `0` | All drainable requested conversations were successfully drained. In pair-format directory mode, unsaved rows skipped from broad selections do not make the command fail. |
| `1` | The command was valid but one or more conversations failed, the resolved set was empty, or a pair-format broad selection matched only unsaved rows. Partial success is allowed in directory mode. |
| `2` | Usage error (bad flags, ambiguous ID, unsupported match count for the selected stdout format, etc.). |

#### 5.7.3.8 Export Formats and Scope

`clog drain` supports these export formats:

- `json` — the canonical parsed export format, using clog-native metadata
  field names plus parsed `messages`
- `md` — a human-readable transcript export
- `--raw` — the exact underlying source file with no parsing or metadata envelope
- `pair` — a directory-only interchange export: one metadata file plus one
  source JSONL file per saved conversation

The JSON export is a portable export object, not a dump of clog's internal
database row. It includes user-facing metadata such as `id`, `source`,
`title`, `summary`, `summaryKind`, `extraction`, `author`, `projectName`,
`tags`, `slug`, `createdAt`, `savedAt`, `state`, and parsed `messages`.
`extraction` is the exported name for `summaryExtraction`. It intentionally omits
local-only/internal fields such as `sourceId`, `projectPath`,
`discoveredAt`, `modifiedAt`, `savedMessageCount`, `saveVersion`,
`sourcePath`, `filePath`, `sourceMtime`, `indexedAt`, `originKind`, and
`originRef`.

Markdown is a convenience rendering, not the canonical export contract.
Markdown stdout mode requires exactly one matching conversation. File mode
writes one markdown file. Directory mode writes one markdown file per
conversation. Markdown frontmatter includes `summaryKind` when it is not
`none`, and includes `extraction` as a JSON-stringified scalar when structured
extraction is present.

Raw export always reads from the same resolved content path that `clog path`
and `clog show` use. In stdout mode and file mode, `--raw` requires
exactly one matching conversation. In directory mode, `--raw` writes one
raw file per conversation.

Pair export is valid only with `--to-dir`. It exports saved rows of any
provenance kind when their resolved content path is readable. The JSONL file is
copied byte-for-byte from the same path used by `clog show` and `clog path`; it
is not parsed and reserialized. Pair metadata uses the shared interchange schema
from §11.2. It includes save-time metadata such as `summaryKind` and
`summaryExtraction`, and it omits local database fields such as `originKind`,
`originRef`, `projectPath`, `discoveredAt`, `indexedAt`, managed content paths,
and parser checkpoints. The output layout is:

```text
<target>/<source>/<id>.jsonl
<target>/<source>/<id>.meta.json
```

Pair export targets saved conversations only because pair metadata requires
save-time fields. Unsaved rows reached by a broad selection are skipped and
reported in the final summary. An explicitly named unsaved conversation ID is
a per-conversation failure because the user asked for that row by name. If a
broad selection matches only unsaved rows, `clog drain --format pair` errors
with a message that those conversations must be saved before pair export.

File mode writes to the exact path supplied by `--to`. Directory mode
writes one file per conversation and assigns filenames deterministically
from the full conversation ID and selected format. The exact filename and
low-level serialization rules for non-pair exports are documented in
`docs/IMPLEMENTED/DRAIN_SPEC_NOTES.md`.

#### 5.7.3.9 Scope Boundaries

`clog drain` intentionally does not:

- modify clog state
- mark conversations as exported
- support streaming or watch modes
- write aggregate multi-conversation files in directory mode
- reuse `clog show`'s presentation format as a separate export type
- support filtering by specific remote URL in v1
- support partial-message export flags such as `--head` / `--tail`

#### 5.7.3.10 Error Handling

Specific `clog drain` error conditions:

| Condition | Behavior |
|-----------|----------|
| No IDs, no filters, no `--to`, no `--to-dir` | Usage error: `clog drain requires a conversation ID, a filter, --to <path>, or --to-dir <dir>.` Exit `2`. |
| `--to` with `--to-dir` | Usage error. Exit `2`. |
| `--raw` with `--format` | Usage error. Exit `2`. |
| `--format pair` without `--to-dir` | Usage error directing the user to `--to-dir <dir>`. Exit `2`. |
| `--format pair` with `--to <path>` | Usage error directing the user to `--to-dir <dir>`. Exit `2`. |
| `--force` without `--to` or `--to-dir` | Usage error. Exit `2`. |
| `--refresh` present | Run the same local discovery refresh as `clog list` before resolving the export set; scan warnings are emitted to stderr. |
| Ambiguous ID prefix | Same ambiguity behavior as other clog commands. When filters are present, ambiguity is evaluated within the filtered candidate set. Exit `2`. |
| ID prefix has no match within the filtered candidate set | Same no-match behavior as other clog commands, evaluated within the filtered candidate set. Exit `1`. |
| Resolved set is empty | Error: no conversations match. Exit `1`. |
| Stdout `md` with multiple matches | Usage error: markdown stdout requires exactly one conversation. Exit `2`. |
| Stdout `raw` with multiple matches | Usage error: raw stdout requires exactly one conversation. Exit `2`. |
| `--to` with multiple matches | Usage error directing the user to `--to-dir <dir>`. Exit `2`. |
| Parent directory for `--to` does not exist | Error. Exit `1`. |
| Source/raw/import/remote content path missing | Error for that conversation. Stdout mode exits `1`; file mode exits `1`; directory mode continues and exits `1` if any failures occurred. |
| Parse failure in parsed formats | Error for that conversation. Same partial-success model. |
| Output file already exists (no `--force`) | File mode: error and exit `1`. Directory mode: skip that conversation, report error, continue, exit `1` if any conflicts occurred. |
| Pair export destination already has either side (no `--force`) | Skip that conversation, write neither side, report the conflict, continue, and exit `1` if any conflicts occurred. |
| Explicitly named unsaved ID with `--format pair` | Per-conversation failure because pair export requires saved metadata. Directory mode continues and exits `1`. |
| Broad pair export selection resolves only unsaved rows | Error naming the unsaved matches and telling the user to save them first. Exit `1`. |
| `--to-dir` directory cannot be created | Error. Exit `1`. |

In directory mode, failures are reported individually to stderr as they
occur, identifying the conversation and the reason. Export continues with
remaining conversations. After processing completes, `clog drain` prints a
one-line summary reporting the number written and, when non-zero, the
number failed. Pair-format directory export also reports the count of unsaved
rows skipped by a broad selection, for example `Drained 5 conversations to
./export/ (1 failed, 2 unsaved skipped)`.

### 5.7.4 The `fill` Command

`clog fill <dir>` imports portable conversation file pairs written by
`clog drain --format pair` or by git sync's shared pair writer. It is the
directory-import counterpart to `clog drain --format pair`.

```bash
clog fill ./export
clog fill ./export --own
clog fill ./export --dry-run
clog fill ./export --allow-partial
clog fill ./export --own --allow-partial
```

Default fill imports read-only rows with `origin_kind = 'file'` and
`origin_ref = NULL`. `clog fill --own` restores conversation file pairs authored
by `config.author` as editable local rows with `origin_kind = 'local'` and
`origin_ref = NULL`. Only `git` rows carry a non-null `origin_ref`.

Input scanning uses the shared pair scanner, so metadata-only and JSONL-only
stems are visible and reported as `pair_incomplete`. Pair validation is the
transport-neutral validation from §11.2. Duplicate detection runs on valid
pairs only, after pair validation and `clogignore` filtering: fill groups the
remaining candidates by `(source, id)` and rejects every pair in any group with
more than one member, emitting `pair_duplicate_identity` and choosing no
traversal-order winner. One valid pair plus one invalid pair for the same
identity is not a duplicate. Under `--own`, a duplicate group is rejected before
the author guard runs.

Fill's reject-all here deliberately differs from git reconciliation's first-wins
(§11.8): git's checkout is author-partitioned, so "first" is a meaningful, stable
order, while a fill input directory is layout-neutral, so any winner would be
filesystem-traversal luck.

**Design rationale.** The divergence tracks one real difference in the inputs,
not a stylistic inconsistency. Git reconciliation runs continuously against a
shared checkout the user often does not control, where the same conversation
saved by two teammates is an expected collision (§11.13); failing a whole pull
over one duplicate would be a denial of sync that no local action could clear, so
reconciliation must resolve it deterministically — and the author-partitioned
layout supplies a stable, content-derived order to do so. `clog fill` is instead
a one-shot import of a directory the user owns and chose, where a duplicate is
almost always a mistake (most often pointing fill at a full team checkout);
failing is cheap, recoverable, and informative, and because the tree carries no
authoritative order, any silent winner would discard one author's curation
invisibly. Do not harmonize the two: making fill first-wins reintroduces
arbitrary silent winner-picking, and making git reject-all turns one team
duplicate into a sync the user cannot complete. The same continuous-and-shared
versus one-shot-and-owned distinction is why git reconciliation can delete rows
(§11.8) while fill is additive-only and never deletes.

The import subset of `clogignore` applies to fill: UUID rules and ID prefixes
match pair IDs, and simple names match pair `projectName` case-insensitively.
Path-like and filename-only rules do not suppress pair import. Pairs skipped by
`clogignore` are not failures and are not candidates for the `--own` author
guard. When one or more candidates are skipped by `clogignore`, fill prints one
summary line naming the count.

Before any write, fill performs validation, ignore filtering, duplicate
detection, the `--own` author guard, and collision planning. Without
`--allow-partial`, any failure-class candidate aborts the command before writing
database rows or managed files. With `--allow-partial`, fill skips those
candidates, writes valid candidates, and exits `1`. Failure-class candidates
are malformed pairs, duplicate input identities, unsupported `file`/`git` to
`local` promotions, and collisions with existing `git` rows. The `--own` author
guard remains fail-closed even with `--allow-partial`: every remaining
candidate's metadata author must equal `config.author`, or fill reports all
offending pairs and writes nothing.

Fill resolves each candidate by `(source, id)`. Resolution is by provenance and
deterministic order, never by timestamp, and every outcome is chosen so fill
never trips the `UNIQUE(source, source_id)` constraint as an error. Fill uses the
same conversation file-pair layer and resolution policy as git reconciliation
(§11.8), implemented by a fill-specific planner:

| Existing row | Default `clog fill` | `clog fill --own` |
|--------------|---------------------|-------------------|
| none | Insert a read-only `file` row | Insert a writable `local` row after the author guard |
| local unsaved | Skip with guidance to save locally or restore with `--own` | Restore over the unsaved row as a saved local row |
| local saved | Skip because local curation takes precedence | Skip because existing local curation wins |
| file | Update if metadata or parsed content changed; otherwise unchanged | Failure-class skip because promotion is unsupported |
| git | Failure-class skip because a synced read-only copy owns the identity | Failure-class skip because promotion is unsupported |

When `--own` restores over an existing local unsaved row, the pair metadata
and content win. Fill preserves only the existing `discoveredAt`, writes the
managed raw copy to `raw/<source>/<id>.jsonl`, sets `sourcePath = filePath`,
sets `sourceMtime` from the managed copy, sets `projectPath = null`, and stores
the row as a clean saved local conversation. A later local source scan may
reattach a live source path. If a later save would replace filled or restored
content with a live local source version found by discovery, clog asks for confirmation
before overwriting the managed copy.

Default fill writes managed content to:

```text
~/.clog/imports/<source>/<id>.jsonl
```

`--own` writes the same canonical raw path that `clog save` uses:

```text
~/.clog/raw/<source>/<id>.jsonl
```

The managed copy is written with the shared atomic writer. For file-row inserts
and content updates, fill writes the JSONL copy before flushing the database row.
If the process exits between the file rename and the DB flush, the managed file
is valid but the row may still contain stale metadata; the next fill run detects
the difference and updates the row. Fill imports clean saved artifacts:
`savedAt` and `modifiedAt` come from pair metadata, and the managed copy write
time must not make the imported row appear modified.

New imported/restored rows use pair metadata plus these derived fields:

- `sourceId = id`
- `state = 'saved'`
- `saveVersion = 1`
- `savedMessageCount` from the parsed `Message[]` length
- `projectPath = null`
- `indexedAt = null`
- `filePath` and `sourcePath` set to the managed copy
- `sourceMtime` from the managed copy
- `discoveredAt` set to import time, except unsaved-row restore preserves the existing `discoveredAt`

File-row updates are triggered by a changed pair metadata field or a changed
parsed `savedMessageCount`. Metadata-only updates do not recopy content. A
changed `savedMessageCount` overwrites the managed copy and refreshes the
checkpoint. File-row updates clear `indexedAt` when title, summary, or parsed
transcript content changes; tag-only changes and path-only locator changes
preserve `indexedAt` when title, summary, and parsed content are unchanged.

`--dry-run` performs scanning, validation, ignore filtering, duplicate
detection, the `--own` author guard, collision planning, and summary rendering
without writing database rows, managed files, vectors, checkout files, source
files, or `clogignore`.

Fill prints a one-line summary to stderr:

```text
Processed 12 conversation pairs from ./export/ (9 new, 1 updated; 2 skipped)
```

It also prints targeted guidance:

- foreign-author default imports are hidden from the default list and can be
  seen with `clog list --all`
- when every importable default-mode candidate has `author = config.author`,
  `--own` restores editable local rows
- when search is configured and imported or updated rows are stale, `clog index`
  indexes them

`clog remove` deletes managed `imports/<source>/<id>.jsonl` copies for removed
file rows, deletes `raw/` copies for removed local rows, and leaves git checkout
content alone. The stronger only-copy warning applies to a saved local row when
`sourcePath` is missing, unreadable, or identifies the same managed copy as
`filePath`.

Exit codes:

| Code | Condition |
|------|-----------|
| `0` | All candidates were imported, updated, unchanged, ignored, or benignly skipped, with no failure-class candidates. |
| `1` | Pair validation failure, duplicate identity, author-guard failure, unreadable directory, no pair stems found, collision failure, or any skipped failure-class candidate under `--allow-partial`. |
| `2` | Usage error. |

### 5.8 The `diff` Command

`clog diff` shows what changed since last save, mirroring `git diff`:

```bash
# Show new messages in all modified saved conversations
$ clog diff

# Show new messages in a specific conversation
$ clog diff a1b2c3

# Limit output to first or last N messages
$ clog diff --head 5          # first 5 new messages
$ clog diff --tail 3          # last 3 new messages
$ clog diff --first 5         # alias for --head
$ clog diff --last 3          # alias for --tail
```

`clog diff` works only on local conversations (`origin_kind = 'local'`). Git-imported and file-imported conversations are read-only saved artifacts, so clog does not compute local new-since-save diffs for them. With no arguments, `clog diff` ignores non-local conversations. If a user explicitly runs `clog diff <imported-id>`, clog returns a clear error explaining that diff is only available for local conversations and suggests `clog show <id>` to inspect the imported content.

`clog diff` uses the saved parser-sequence checkpoint to show only what was added since the last save. `saved_message_count` is the number of parsed messages included in the last saved version. `clog diff` re-parses the current save candidate and shows `messages.slice(savedMessageCount)`. For a saved conversation whose source file exists and differs from the current raw copy, the save candidate is the source file, matching explicit `clog save <id>` behavior. Otherwise, the save candidate is the existing raw copy. Each conversation gets a header:

```
--- a1b2c3d4 "Debug JWT refresh race condition" (3 new messages since v1)
```

With no arguments and no modified conversations, `clog diff` produces no output (like `git diff` on a clean tree).

If `saved_message_count` is `null`, the saved baseline is treated as empty and the full parsed conversation is shown. If the current parsed message count is less than the stored checkpoint, clog reports a clear error for that conversation because the raw file was edited, truncated, or parsed differently than the version that was saved.

The checkpoint assumes source conversations are append-only and adapter parsing is deterministic. `saved_message_count` detects obvious boundary breakage when the current parsed message count is less than the stored checkpoint. It cannot detect every edit before the saved boundary when the current count remains greater than or equal to the checkpoint; in that case the count may no longer point to the same logical message. This is accepted behavior for direct raw-file editing; the recovery path is to review and re-save the conversation so the checkpoint reflects the edited file.

**Modified-since-save model:** A local saved conversation (`origin_kind = 'local'`) is considered modified when any of these are true:

- user-visible metadata changed after the last save
- a local source file mtime changed during scan
- a local raw copy exists and its file mtime is newer than `saved_at`
- the current parsed message count is greater than `saved_message_count`

Status and list coloring use this same model. `savedAt` remains display/history metadata; it is not the primary cutoff for new transcript content. `modified_at > saved_at` is sufficient to mark a saved conversation as modified, but it is not sufficient to compute transcript diff content.

`clog status` may use mtime and metadata timestamps as cheap dirty signals for local saved rows. A changed local source mtime means newer source content is available to save directly with `clog save <id>`. To determine whether a dirty saved conversation has new projected transcript messages, clog parses the same save candidate that explicit save would use: the current source file when it differs from the raw copy, otherwise the raw copy. It then compares the current parsed message count to `saved_message_count`. It does not need to parse every saved conversation on every status run.

Git reconciliation and `clog fill` updates are read-only imported-row changes. They can make an imported row's search index stale through `indexedAt` (§10.8.1), but they do not make the row eligible for `clog save`, `clog diff`, or the local modified-since-save status model.

`clog diff` is transcript-only. Metadata-only changes can make `clog status` show a saved conversation as modified while `clog diff` shows no messages for that conversation. If the source or raw file changed but the projected message count did not, status may still show the conversation as modified because the save candidate changed, while diff shows no new projected messages.

**`--head`/`--first` and `--tail`/`--last`:** Limit the number of messages shown per conversation. `--head N` shows the first N messages, `--tail N` shows the last N. `--first` and `--last` are aliases. Cannot be combined. The header indicates when output is truncated (e.g., "showing 5 of 23 new messages").

### 5.9 CLI Coloring

CLI output uses coloring to communicate state at a glance:

- **Green** — saved conversations ready to resave
- **Red** — unsaved conversations, and saved conversations whose source file differs from the saved raw copy
- **Dim** — ignored local source conversations rediscovered for `clog list --all`
- Default (no color) — saved conversations with nothing pending

This applies to `clog status`, `clog list`, and any other command that displays conversation state.

### 5.10 `clogignore`, `exclude`, `unexclude`, and `remove`

`~/.clog/clogignore` is the single user-facing ignore file. It is plain text, hand-editable, comment-friendly, and consulted by local discovery, `clog list --all`'s discovery-backed ignored rows, git pull reconciliation, and `clog fill`.

Example:

```text
# Ignore by project name
myapp

# Ignore by exact conversation ID
12345678-1234-1234-1234-123456789abc

# Ignore by filename
12345678-1234-1234-1234-123456789abc.jsonl

# Ignore by path
~/personal/
```

Lines whose first non-whitespace character is `#` are comments. Blank lines are ignored.

**Matcher contract:**

- path-like rules (strings that start with `~` or contain `/` or `\`) match normalized `projectPath` and `sourcePath`
- path-like rules with `*` use glob-style matching; path-like rules without `*` use the same path-boundary semantics as `includePaths` and `excludePaths`
- basename-like rules such as `foo.jsonl` match exact basename equality against `sourcePath`
- UUID-like rules match exact `sourceId`
- short hex rules of length 4 or more match `sourceId` by prefix
- simple names such as `myapp` match `projectName` case-insensitively, and also match exact path components or basenames case-insensitively; they do not do substring matching
- unsupported syntaxes such as `project:<name>`, `before:<date>`, and `after:<date>` are not valid `clogignore` rules

**Import subset:** git reconciliation and `clog fill` candidates do not have meaningful local project paths, so they use a narrower subset of the same file:

- UUID-like rules match exact pair IDs
- short hex rules match pair ID prefixes
- simple names match pair `projectName` case-insensitively
- path-like rules and filename-only rules do not suppress pair import

**Discovery order and fail-closed behavior:**

1. Discover the source file and extract minimal metadata (`sourceId`, `sourcePath`, `projectName`, `projectPath`, `createdAt`, and source-specific summary/title metadata)
2. Evaluate `clogignore`
3. If `projectPath` is still unavailable, skip the conversation as `undiscoverable`
4. Apply `config.json` `includePaths` / `excludePaths`
5. Insert or update the DB row

The `projectPath` fail-closed rule still applies even when no path filters are configured. clog treats unknown project paths as unsafe because path filtering is the primary privacy boundary for local discovery. The ordering above is intentional: an ID rule in `clogignore` may suppress a conversation before it would otherwise appear as `undiscoverable`.

**`clog exclude <rule...>`**

- Appends each user-supplied rule to `~/.clog/clogignore` exactly as typed
- Does not resolve bare tokens as conversations or projects before writing
- Rejects unsupported ignore-rule syntax such as `project:<name>`, `before:<date>`, and `after:<date>`; users should pass a simple name, filename, ID, or path instead
- Reports the `clogignore` path and the exact line or lines written
- After writing, reports how many current DB rows match the newly added rule union
- If one or more current DB rows match, points the user to `clog remove` with the same literal rule text the user typed

`clog exclude` does not delete DB rows or curated raw files by itself.

**`clog unexclude <rule...>`**

- Removes exact matching lines from `~/.clog/clogignore`
- Does not use selector semantics or prefix matching
- Removes all exact duplicate lines that match the supplied text
- Reports the `clogignore` path and the exact line or lines removed
- If no line matches, reports that clearly and leaves the file unchanged

**`clog remove <rule...>`**

- Uses the same literal rule syntax and matcher contract as `clogignore`
- Does not require the rule to already exist in `clogignore`
- Rejects unsupported ignore-rule syntax such as `project:<name>`, `before:<date>`, and `after:<date>` for the same reason as `exclude`
- Shows the number of matching conversations and a compact preview before deleting anything
- Warns that metadata, summaries, tags, search vectors, and managed copies under `raw/` or `imports/` will be removed
- States that source files under `~/.claude` and `~/.codex` are not modified
- Mentions `clog drain <id@source...> --to-dir <dir>` as the exact export path before removal
- Warns more strongly when matched saved local rows no longer have readable independent source files
- Requires interactive confirmation with a default of `N`, unless `--yes` is supplied
- Refuses in non-interactive contexts unless `--yes` or `--dry-run` is supplied
- Supports `--dry-run` to preview matches without deleting rows, raw files, or vectors
- After confirmation, `clog remove` rechecks every previewed saved row before deleting anything; if any previewed row changed or disappeared, the whole removal exits before deleting database rows, managed files, or search vectors
- Operates only on `saved`-state rows. Unsaved rows are transient artifacts of the latest scan and would simply reappear on the next scan, so they are skipped. Use `clog exclude` to keep unsaved rows from coming back.
- Deletes the union of matching saved DB rows across provenance kinds
- Deletes curated raw copies for removed local curated rows and managed import copies for removed file rows
- Leaves git checkout files alone
- Best-effort deletes search vectors for removed searchable rows
- Reports the number of removed conversations
- If no saved DB rows match, reports "No saved conversations in clog's database match those rules." and leaves the database unchanged, even when unsaved rows would have matched the same rules
- Leaves `clogignore` unchanged

**Scan output must report filtering.** `clog status` shows a dimmed filter summary line when any scan counts are non-zero:

```text
(8 filtered by config, 4 ignored by clogignore, 2 undiscoverable; run "clog status --undiscoverable" for details)
```

The line appears only if at least one count is non-zero. The undiscoverable hint portion only appears when the undiscoverable count is non-zero.

The filter counts are reason-based and disjoint. If a source file still exists under a watched root but is now ignored, filtered, or undiscoverable, clog removes any stale unsaved row without also incrementing `pruned`. `pruned` is reserved for unsaved rows whose source file no longer appears in the scanned source roots.

`clogignore` is strictly local. It is never synced to a remote, though the local file is still consulted during git pull reconciliation and file import. Git reconciliation and `clog fill` print one summary line when `clogignore` skips one or more candidate conversation file pairs.

### 5.11 Error Handling

All CLI commands use a consistent error handling wrapper:

- **Normal mode:** Errors are caught and printed to stderr as `error: <message>`. The exit code is set via `process.exitCode`. Most command errors exit `1`; usage errors may exit `2`. Stack traces are hidden.
- **Debug mode (`CLOG_DEBUG=1`):** The wrapper is bypassed, so errors propagate with full stack traces for troubleshooting.

This follows the same principle as health checks (Section 7.3): **corrupted things produce clear errors**, not raw stack traces.

**Error conventions:**

- Commands that encounter an error condition throw rather than returning silently. This ensures the process exit code is non-zero for scripting and CI use.
- Error messages include actionable suggestions where possible (e.g., "No conversations need saving. Use `clog save <id>` or `clog save <project>` to save unsaved conversations.").

### 5.12 The `rename-author` Command

`clog rename-author <old-name> <new-name>` renames an author across all local conversations. This is the bulk migration tool for correcting or changing author names — distinct from `clog config set author` (which only affects future local discoveries) and `clog edit --author` (which changes a single conversation).

Requires confirmation:

```
This will rename author "bob" to "robert" on 50 local conversations.
Continue? [y/N]
```

This command only modifies local rows (`origin_kind = 'local'`). It does not modify config or imported read-only rows.

Note: `clog config set author` only changes the config value. It does NOT rename conversations in the DB. It affects only future local discoveries. Saved conversations use the stored `author` on the conversation row; `clog save` does not restamp author from config. `rename-author` is the explicit migration tool.

Phase 3 (§11.6) extends the confirmation prompt with additional sync context.

### 5.13 Agent Session Commands

`clog talk [client]` and `clog summarize [client]` launch the user's configured MCP-capable agent CLI in the current terminal. They do not run an LLM provider directly, store provider credentials, count tokens, or automate summarization in a subprocess. The trusted agent harness (Claude Code or Codex CLI) does the interactive work.

`client` is `claude` or `codex`.

- If `client` is supplied, clog validates only that the name is one of the supported clients and then launches it.
- If `client` is omitted in an interactive terminal, clog prompts the user to choose one of the supported clients.
- If the command is run without an interactive stdin, clog errors clearly; these commands are intentionally interactive in v1.

The agent process is launched with inherited stdio so the user interacts directly with the agent.

Before launch, clog gathers a small state summary and includes it in the initial prompt:

- total local saved conversations
- count of local saved conversations needing structured summaries
- projects that contain local saved conversations needing structured summaries

`clog talk` frames the agent as a general clog assistant. The prompt asks the agent to ask the user whether they want to summarize unsummarized conversations, explore existing saved conversations, or do something else. It tells the agent not to read `clog_summarization_guide` until the user chooses summarization, so users who only want exploration do not spend context on summarization instructions.

`clog summarize` frames the agent as a summarization worker. The prompt tells the agent to read `clog_summarization_guide` first, then ask the user to confirm the summarization scope (for example all unsummarized conversations, a specific project, or a count) before reading transcripts or writing summaries.

---

## 6. MCP Server

### 6.1 Purpose

The MCP server allows coding agents (Claude Code, Codex, etc.) to query the conversation knowledge base during their work. An agent debugging an auth issue can browse for prior conversations about auth and benefit from past context.

### 6.2 Tools

Phase 1 provides browsing, retrieval, and curation. Semantic search is added in Phase 2 (§10).

MCP tools that accept a conversation ID use the same resolver grammar as CLI commands (§3.3): full UUID, 4+ character prefix, or source-qualified `prefix@source` / `uuid@source`. Source-qualified IDs restrict resolution to the named source; ambiguous unqualified prefixes return copy-pasteable `id@source` candidates.

```typescript
// List saved conversations with optional filters
tool: "clog_list_saved"
input: {
  tags?: string[];         // Filter by tags (OR — conversations with at least one matching tag)
  project?: string;        // Case-insensitive substring match on project
  author?: string;         // Case-insensitive substring match on author
  grep?: string;           // Case-insensitive substring match on title, summary, or message content
  origin?: "local" | "remote"; // local rows vs imported saved rows
  limit?: number;          // Default 20, max 100
  offset?: number;         // For pagination
  sortBy?: "createdAt" | "savedAt" | "modifiedAt" | "title" | "project" | "author";
  sortDirection?: "asc" | "desc"; // Default desc
}
returns: {
  conversations: Array<{
    id: string;
    source: string;
    title: string;
    summary: string;
    summaryKind: SummaryKind;
    extraction: SummaryExtraction | null;
    tags: string[];
    author: string;
    project: string | null;
    originKind: "local" | "git" | "file";
    originRef: string | null;
    createdAt: string;
    modifiedAt: string;
    savedAt: string | null;
    savedMessageCount: number | null;
  }>;
  totalCount: number;
  limit: number;           // Effective page size
  offset: number;          // Effective zero-based result offset
  sortBy: string;          // Effective sort field
  sortDirection: "asc" | "desc"; // Effective sort direction
  returnedCount: number;   // Number of conversations in this page
  hasMore: boolean;        // True when another page is available
  nextOffset?: number;     // Offset to request next with the same limit
  paginationNote?: string; // Present when hasMore is true; tells agents how to page
  warnings?: ClogWarning[];
}

// Get conversation content (parses raw JSONL on demand, truncated by default)
// Only works on saved conversations — returns an error for unsaved.
tool: "clog_get"
input: {
  id: string;              // UUID, 4+ char prefix, or source-qualified prefix@source
  maxMessages?: number;    // Compatibility alias for tail mode; max 200
  head?: number;           // First N messages; max 200
  tail?: number;           // Last N messages; max 200
  offset?: number;         // Zero-based message window offset
  limit?: number;          // Window size when offset is supplied; default 20, max 200
}
returns: {
  id: string;
  source: string;
  title: string;
  summary: string;
  summaryKind: SummaryKind;
  extraction: SummaryExtraction | null;
  tags: string[];
  author: string;
  project: string | null;
  originKind: "local" | "git" | "file";
  originRef: string | null;
  state: string;
  createdAt: string;
  messages: Message[];       // Requested message slice
  totalMessages: number;     // Total message count in the full conversation
  range: {
    mode: "tail" | "head" | "window";
    startIndex: number;       // Inclusive, zero-based
    endIndex: number;         // Exclusive, zero-based
    returnedMessages: number;
    pageSize: number;
    hasMoreBefore: boolean;
    hasMoreAfter: boolean;
    previousOffset?: number;
    nextOffset?: number;
  };
  truncated: boolean;        // True when messages exist outside the returned slice
  truncationNote?: string;   // Present when truncated, tells agent how to page
}

// **Message ranges:** With no range fields, `clog_get` returns the last 20
// messages. `maxMessages` is retained indefinitely as a compatibility alias for
// tail mode, and explicit callers may use `head`, `tail`, or `offset`/`limit`.
// Message indexes are zero-based positions in the canonical parsed `Message[]`
// order. `offset` is uncapped; offsets beyond the end return an empty window
// with `startIndex` and `endIndex` clamped to `totalMessages`.
//
// Exactly one range mode may be active. `maxMessages`, `head`, and `tail` are
// mutually exclusive. `offset` is mutually exclusive with those fields. `limit`
// may appear only with `offset`; `limit` without `offset` is invalid. Message
// counts (`maxMessages`, `head`, `tail`, and `limit`) must be positive integers
// and are capped at 200. Window mode uses `limit ?? 20`.
//
// `previousOffset` is present whenever `hasMoreBefore` is true and points to an
// offset that can be requested with `limit: pageSize` to page backward.
// `nextOffset` is present whenever `hasMoreAfter` is true and points to the
// next forward window. `truncated` means more messages exist before or after the
// returned slice, not that the requested count could not be satisfied.
//
// The default of 20 messages is a rough heuristic. Message count is a poor proxy
// for token size — a 20-message conversation where a human pasted a large codebase
// could be far larger than a 200-message conversation of short exchanges. Solving
// this properly would require token counting or byte-size budgets, which adds
// complexity. For now, 20 is a conservative default that keeps most retrievals
// small. The truncation note in the response makes it easy for
// agents to request more when needed.

// Edit metadata on a saved local conversation
tool: "clog_update"
input: {
  id: string;              // UUID, 4+ char prefix, or source-qualified prefix@source
  title?: string;          // New title
  summary?: string;        // New summary
  extraction?: SummaryExtraction | null; // Structured summary fields
  summaryKind?: "generated" | "curated"; // Override who produced the prose summary
  addTags?: string[];      // Tags to add (lowercased, trimmed, deduped)
  removeTags?: string[];   // Tags to remove
}
returns: {
  conversation: {
    id: string;
    source: string;
    title: string;
    summary: string;
    summaryKind: SummaryKind;
    extraction: SummaryExtraction | null;
    tags: string[];
    author: string;
    project: string | null;
    originKind: "local" | "git" | "file";
    originRef: string | null;
    state: string;
    createdAt: string;
    modifiedAt: string;
  };
}

If the requested update would not change the conversation's title, summary, summary kind, extraction, or tags, `clog_update` is a no-op: it leaves `modifiedAt` unchanged and returns the existing conversation metadata.

`clog_update` operates only on saved local rows (`originKind = "local"`). It
rejects both `git` and `file` rows as imported read-only conversations.

`clog_update` summary-kind rules are applied in order:

1. If the call clears both prose summary and extraction, `summaryKind` becomes `none` regardless of an explicit `summaryKind`.
2. Else if the caller passes `summaryKind`, that value wins. MCP accepts only `generated` and `curated`; agents use `curated` only for user-directed summary fixes.
3. Else if the prose summary text actually changes and ends non-blank, `summaryKind` becomes `generated`.
4. Else the existing `summaryKind` is preserved. Adding extraction to curated prose, clearing prose while leaving extraction, or touching only tags does not silently downgrade the prose kind.


// Read before summarizing clog conversations
tool: "clog_summarization_guide"
input: {}
returns: {
  version: number;
  guide: string;            // Markdown instructions for summary and extraction quality
}

// Opinionated analyses an exploration agent can offer the user
tool: "clog_analysis_suggestions"
input: {}
returns: {
  version: number;
  suggestions: Array<{
    id: string;
    name: string;
    description: string;
    audience: "solo" | "team" | "both";
    suggestedPrompt: string;
  }>;
}

// List available tags, projects, authors (for discovery)
tool: "clog_browse"
input: {
  by: "tags" | "projects" | "authors";
}
returns: {
  items: Array<{
    name: string;
    count: number;          // Number of saved conversations
  }>;
}
```

`clog_list_saved` always returns explicit pagination metadata. Agents should treat `hasMore: true` as an instruction to request the
next page with `offset: nextOffset` and the same `limit` when the task requires
the full result set. Sorting applies after all filters, and pagination applies
after sorting. The default sort is `createdAt` descending with `id` ascending as
the stable tiebreaker.

For MCP list tools, `project` and `author` are forgiving agent-facing filters:
the supplied value is trimmed and matched as a case-insensitive substring
against the stored project or author value. Rows with no project do not match a
`project` filter. MCP responses expose the project as `project`; they do not
expose the internal `projectName` model field. This intentionally differs from
the CLI's exact metadata selectors so agents do not miss relevant rows when the
user supplies a partial or differently-cased project or author name.

`clog_summarization_guide` returns a bundled markdown guide. The guide tells a summarizing agent why summaries are useful, the exact `clog_update` input shape for `summary` plus `extraction`, quality guidelines for prose summaries, how to triage long conversations with `clog_get` windowing, and when to pass `summaryKind: "curated"` instead of relying on the default generated behavior.

`clog_analysis_suggestions` returns a small, versioned, clog-authored library of exploration prompts. The v2 library includes suggestions for intro prompt quality, missed assumptions, iteration outliers, abandoned tasks by project, tool usage patterns, noise patterns, and team outliers. The tool returns starting prompts only; the agent performs analysis by calling the regular list/search/get tools.

The summarization workflow is agent-assisted. clog exposes storage and MCP tools, but it does not call an LLM itself. A typical flow is: `clog save` hints that some saved conversations do not have summaries, `clog talk` or `clog summarize` opens the user's agent, the agent reads `clog_summarization_guide`, the user confirms scope, and the agent calls `clog_get` plus `clog_update` for each selected saved local conversation.

### 6.3 Resources

The MCP server exposes conversations as MCP resources:

```
clog://conversations/{id}         Individual conversation
```

This allows agents to `@`-mention clog resources directly.

### 6.4 Running the Server

```bash
# Register both supported clients
clog mcp setup both

# Register only Claude Code
clog mcp setup claude

# Register only Codex CLI
clog mcp setup codex
```

`clog mcp setup` is the preferred setup path from the clog CLI. It registers the currently installed local copy of clog with an absolute Node command that imports that installation's `dist/mcp/server.js` file. It does not register an `npx` command or install packages when an MCP client starts the server. If clog is moved, reinstalled, or rebuilt in a different location, the user must run `clog mcp setup` again so Claude Code or Codex CLI points at the current server file. `clog mcp setup claude` registers Claude Code, `clog mcp setup codex` registers Codex CLI, and `clog mcp setup both` does both in sequence. If a server named `clog` already exists for a selected client, clog replaces it automatically.

The server uses stdio transport (spawned per-session by the client). It reads from the same SQLite database and raw files as the CLI. MCP tools expose **saved** conversations only. Unsaved conversations remain local CLI-visible source rows until the user explicitly saves them.

MCP handlers that parse messages dispatch by `ConversationMeta.source`. Responses include the canonical source key, not a separate display label. List-style responses include `source` on each conversation summary object. Get-style responses include `source` on the top-level conversation object. Parsed messages preserve adapter output order.

When an MCP tool performs a scan and encounters malformed source files, it returns the normal payload plus a top-level `warnings` array using the `ClogWarning` shape from §5.5. MCP never prompts and never hides scan incompleteness in prose-only output.

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
      "enabled": true,
      "paths": ["~/.codex/sessions/"],
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
| `author` | string | Developer's name/handle, stamped onto new local discoveries and preserved unless explicitly edited |
| `sources` | object | Per-adapter configuration |
| `sources.*.enabled` | boolean | Whether local discovery runs for this source (default `true` for built-in sources) |
| `sources.*.paths` | string[] | Base directories to scan for conversations (defaults: `~/.claude/projects/` for Claude Code, `~/.codex/sessions/` for Codex CLI). Codex paths may point to any Codex home directory or directly to its `sessions` directory; each path is normalized to a sessions directory and discovery scans `<sessionsDir>/**/*.jsonl` |
| `sources.*.includePaths` | string[] | If non-empty, only discover conversations whose `projectPath` values match these directories by the path-boundary rule below |
| `sources.*.excludePaths` | string[] | Skip conversations whose `projectPath` values match these directories by the path-boundary rule below |
| `defaultTags` | string[] | Tags automatically applied to all new discoveries |
| `autoScan` | boolean | If true, the MCP server runs a source scan on startup |

**Source path overrides:** Source locations are configured only through `sources.<name>.paths`. `CLOG_HOME` overrides clog's data directory; there is no environment-variable override for source paths.

**Default source enablement:** Built-in sources are enabled by default so `clog status` discovers Claude Code and Codex CLI conversations without extra setup. Discovery is local-only: it stores metadata in the local clog database and does not save, sync, or copy raw content. Users can disable local discovery for a source with `sources.<name>.enabled = false`, or narrow discovery with `includePaths` / `excludePaths`.

**Local discovery toggle:** `enabled: false` means clog does not scan local files for that source. The source remains supported for parsing saved or remotely imported conversations already present in clog state. A remote-only configuration may set all built-in sources to `enabled: false`; local scan commands then find no local conversations, while sync pull, remote browsing, and MCP access to imported conversations continue to work.

**Path filtering rules:** `includePaths` and `excludePaths` match against the stored `projectPath` associated with the conversation. Claude Code derives this from the first `cwd` found in the main conversation JSONL. Codex CLI derives it from `session_meta.payload.cwd`, falling back to the first valid `turn_context.payload.cwd` found in source-file order. If `includePaths` is set and non-empty, a conversation must match at least one include path. If `excludePaths` is set, any matching conversation is skipped regardless of include paths.

Paths support `~` expansion and are compared after normalization. A `projectPath` matches a configured path only when the normalized paths are equal, or when the normalized `projectPath` is a descendant of the configured path separated by the platform path separator. Implementations must not use raw string-prefix matching: `/Users/alice/work-personal` does not match `/Users/alice/work`, while `/Users/alice/work/api-service` does. This path-boundary rule also applies to non-glob path-like `clogignore` rules.

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
Your name (used as the default author for conversations clog finds):
Initialized clog at /Users/alice/.clog
```

The prompt shows the OS username as the default (accepted by pressing Enter). In non-TTY contexts (e.g., the MCP server), the OS username is used automatically with no prompt.

`clog init` can also be run explicitly at any time. It is idempotent — it creates anything that's missing without overwriting anything that exists. On an interactive explicit run, it asks for the default author name, using the current configured author as the default when `config.json` already exists and the OS username otherwise. If semantic search is not configured yet, it then offers to start vector search setup. If semantic search is configured but the optional vector-search runtime packages are missing or cannot be imported from the clog-owned runtime directory, `clog init` offers to repair vector search setup. The vector search setup flow shows the runtime package location, package-install size, and embedding-model download size before asking for confirmation; package installation, embedding-model download, and search configuration only happen after the user accepts that setup confirmation. If setup installs or repairs runtime packages, it prints the exact npm command when it runs that command. In non-TTY contexts, `clog init` keeps the existing configured author when present, or uses the OS username when bootstrapping a new config.

**Health checks (every command):**

Separate from initialization, every command runs a `preAction` hook (`ensureClogHome`) that ensures required directories and files exist:

- `~/.clog/` directory exists → create if missing
- `config.json` exists → create with defaults if missing
- `raw/` directory exists → create if missing

Source-specific raw directories under `raw/<source>/` are created on demand when a command first needs to write a raw copy. Health checks do not proactively create or remove them.

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
- Support for non-built-in conversation sources (Claude.ai web, Cursor, etc.)
- Message-level editing (users edit raw JSONL files directly if needed)
- Interactive CLI prompts for routine operations — commands like `edit`, `tag`, `config` use flags, not step-through wizards. The main exception is explicit interactive `clog init`, which acts as a short rerunnable setup flow: it confirms the default author, offers vector search setup when semantic search is unset, and offers vector search repair when semantic search is configured but the optional runtime packages are missing or unusable. The vector search setup flow has its own informed confirmation before package installation, embedding-model download, or search configuration. The principle: don't make users step through an interactive flow when they just want to set one field.

---

## 9. Phase 1 Success Criteria

Phase 1 is successful if:

1. A developer can run `clog status` and see their Claude Code and Codex CLI conversations listed
2. They can add, edit metadata, tag, and save conversations via the CLI
3. `clog show` displays full conversation content parsed from raw JSONL files
4. `clog path` returns correct file paths to raw JSONL files
5. A coding agent with the MCP server configured can browse and retrieve saved conversations
6. The entire tool runs locally with no network dependencies
7. The SQLite database stays small (metadata only) regardless of conversation size

### 9.1 Phase 1 Implementation Notes

Phase 1 implementation work includes:

- `src/adapters/registry.ts` — centralize source-aware adapter construction and dispatch
- `src/adapters/codex-cli.ts` — implement Codex discovery and parsing
- `src/cli/scan.ts` — iterate all enabled adapters and prune stale unsaved rows per source
- `src/cli/drain.ts` — export conversations as portable JSON, markdown, or raw source
- `src/cli/show.ts`, `src/cli/path.ts`, `src/cli/diff.ts` — use source-aware content path resolution and parsing
- `src/cli/save.ts` — copy raw files into `raw/<source>/`, set `saved_message_count`, and use source-aware parsing
- `src/db/index.ts` — add `projectName`, `projectPath`, and `savedMessageCount` to conversation insert/update/read paths, filters, and save-state queries

Phase 1 must not depend on Phase 2 search or Phase 3 remote sync internals. It may leave schema fields, extension points, or notes for later phases only when the Phase 1 behavior is complete without those later implementations.

---

## 10. Search (Phase 2)

Phase 2 adds semantic search over the conversation knowledge base. Phase 1 provides metadata-based filtering (`clog list` with `--project`, `--tag`, `--grep`); Phase 2 adds natural language queries (e.g., "how did we handle JWT refresh?" or "rate limiting approach") that return conversations ranked by semantic similarity.

### 10.1 Design Decisions

#### Search Is Optional

Search requires two heavy dependencies (a vector store and an embedding provider) that would violate clog's zero-native-dep install story if bundled. Installing those packages into a clog-owned runtime directory preserves the core guarantee: `npm install -g @getclog/clog` works everywhere with no build toolchain. The search module is always present in the codebase but inert until configured via `clog search --init`.

#### Local Embeddings as Default

The default embedding provider (`@huggingface/transformers` running `all-MiniLM-L6-v2` via WASM) runs entirely locally — no API key, no network, no cost. This is consistent with clog's local-first philosophy. API-based providers (OpenAI, Voyage, etc.) can be added as alternatives for teams that prefer higher-quality embeddings, but the default must work offline.

#### Pluggable Provider Architecture

The embedding provider and vector store are independent choices behind abstract interfaces (`EmbeddingProvider`, `VectorStore`). Adding a new provider means adding an entry to a static registry map — no changes to the indexer, search commands, or MCP tools. This keeps the search system open to extension without modifying core logic.

#### Vectra as Default Vector Store

Vectra is pure JavaScript, zero native deps, JSON-file-based. It uses brute-force similarity search, which is fine at the expected scale (<10 devs, a few thousand conversations). Higher-performance alternatives (LanceDB, sqlite-vec) can be added later as independent options.

#### Turn-Based Chunking

Conversations are chunked by turn (user message + assistant response) rather than by arbitrary token windows. Turns are the natural unit of conversation — a user question plus the assistant's response forms a coherent thought. Splitting mid-turn would fragment the semantic unit that makes search results useful.

#### Auto-Index on Save

When search is configured and dependencies are available, indexing runs automatically during `clog save`, not on MCP server startup. Saving is the moment new content enters the knowledge base, so indexing there keeps search current without adding latency to agent sessions. If search deps are missing or indexing fails, save still succeeds and leaves `indexed_at = null`; the conversation is saved but not searchable until `clog index` succeeds. Save output must always announce the indexing outcome after at least one conversation is saved, including the cases where search is not configured or indexing is unavailable.

#### Setup Owns Search Downloads

Any third-party package installation or embedding-model download required for semantic search happens only during `clog search --init`, after explicit user confirmation. `clog index`, `clog search <query>`, save auto-indexing, metadata-edit reindexing, and MCP search must not trigger surprise package installs or model downloads. If search is not set up, non-search commands remain fully inert with respect to Phase 2.

### 10.2 Install and Configuration

The semantic-search setup command installs optional search runtime packages separately from the core clog package. Users do not install `vectra` or `@huggingface/transformers` into their project or global Node.js environment as a setup step.

```bash
clog search --init
```

If the search runtime packages are missing, `clog search --init` shows the package-install size and model-download size before making changes. After explicit confirmation, clog prints and runs an install command equivalent to:

```bash
npm install --prefix ~/.clog/search-runtime vectra @huggingface/transformers
```

The semantic-search setup command saves the search configuration only after the package installation succeeds, the selected search runtime packages can be imported from `~/.clog/search-runtime`, and the configured embedding model initializes successfully. If package installation, runtime-package validation, or embedding-model initialization fails, search remains unconfigured; re-running `clog search --init` resumes setup from the current runtime state. `clog search` and `clog index` do not install packages themselves. All other commands work normally.

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

Tags are **not** embedded. They are metadata filters applied from the local database before or alongside semantic search, not part of vector similarity scoring. `summaryKind` and `summaryExtraction` are not embedded; only the prose `summary` contributes to vector text.

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
| Codex `agent_message` commentary | Operational progress updates, not canonical assistant replies |
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

**Default: `@huggingface/transformers`** — runs `all-MiniLM-L6-v2` locally via WASM. No native deps, no API key needed, works offline. The setup flow (`clog search --init`) initializes the provider so the model download (~30MB) happens there rather than later during `clog index` or `clog search`. This is the recommended starting point.

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

**Staleness marker:** a saved conversation is not currently searchable and needs indexing or re-indexing when `indexed_at = null`, when `saved_at` is missing, or when `indexed_at < saved_at`. Implementations may update non-search metadata (for example `author`, `projectName`, `projectPath`, `slug`, `summaryKind`, `summaryExtraction`, or `modified_at`) without clearing `indexed_at` when the indexed search-visible content is unchanged. If an operation advances `saved_at`, it must also refresh `indexed_at` during indexing or leave the row stale. Search-visible content changes are title changes, prose-summary changes, and parsed transcript changes. A local raw file mtime newer than `indexed_at` marks the index stale because the saved transcript may have changed. A locator-only update from git reconciliation or `clog fill` preserves `indexed_at` when title, summary, and parsed transcript content are unchanged. Remote reconciliation uses `.meta.json` field comparison plus derived path changes instead of filesystem mtime.

**Embedding is optional per conversation.** A conversation can be saved without being indexed. This decouples the curation workflow from search infrastructure — saving works without a vector DB.

**Searchability invariant:** The vector store is a derived cache of the subset of conversations that are currently searchable. A conversation is searchable if and only if it exists in the local database, is in `saved` state, has a non-null `saved_at`, has a non-null `indexed_at`, and `indexed_at >= saved_at`. A saved conversation whose index timestamp is missing or older than its latest save has either never been indexed or has been marked stale after a content change; its vectors may be absent or outdated, so it must not appear in search results until re-indexed. The vector store is not an append-only record of past saves. Semantic search must not return conversations that have been deleted, removed from `saved` state, have a stale index, or otherwise dropped from the local database.

**Index coherence rule:** Any operation that changes a conversation's search eligibility or indexed content must keep the vector store coherent with the database before the command returns. Implementations may satisfy this either by applying the vector-store mutation immediately or by making stale entries unreachable in the same logical operation, but search results must always reflect current DB state rather than historical indexing events.

If a deindex operation fails after the database has already been updated, the command still succeeds but prints a warning. Cleanup failures must be observable rather than silent. If search is not configured, deindexing is silently skipped because cleanup cannot be initialized. Vector-store files may still exist on disk from earlier indexing, but while search is unconfigured they are inert, and searchability continues to be governed by the database invariant.

### 10.8 CLI Commands

Phase 2 adds three commands:

**`clog search --init`** — Interactive setup. Uses `@inquirer/prompts` to let the user choose an embedding provider and vector store from the available options, explains the runtime footprint, installs the required search packages after explicit confirmation, validates that those packages can be imported from `~/.clog/search-runtime`, initializes the configured embedding provider so any required model download happens during setup rather than later during `clog index` or `clog search`, and then writes the selection to `config.json`. When setup installs or repairs runtime packages, it prints the exact npm command and package-install output in the same terminal session. After setup succeeds, clog offers to index saved conversations whose vector-search metadata is missing or stale. Users can reach this flow directly with `clog search --init`; a fresh interactive `clog init` also offers this flow when semantic search is unset or when the configured semantic-search runtime packages are missing or unusable, and the search setup confirmation remains the point where users approve package installation, embedding-model download, and search configuration.

**`clog search <query>`** — Semantic search across saved conversations.

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

If search is not configured or dependencies are missing, prints a helpful message directing the user to `clog search --init`.

**`clog index`** — Index un-indexed or stale saved conversations (embeds them and inserts into the vector store).

```bash
$ clog index              # Index saved conversations whose index is missing or older than saved_at
$ clog index --rebuild    # Re-index all saved conversations from scratch
```

`--rebuild` sets `indexed_at = null` on all saved conversations before indexing, forcing a full re-index.

### 10.8.1 Searchability Lifecycle

The search index follows the lifecycle of conversations in the database:

| Operation | DB effect | Search effect |
|-----------|-----------|---------------|
| `save` | Conversation enters `saved` state; `saved_at`, `modified_at`, and `saved_message_count` are refreshed | If search is configured and indexing succeeds, vectors are created or refreshed and `indexed_at` is set to a timestamp at or after `saved_at`. If search is unconfigured or indexing fails, save still succeeds and `indexed_at` remains `null`, so the conversation is saved but not searchable until indexed. Save output must report which of these outcomes occurred. |
| `edit`, MCP `clog_update` title/summary change on a saved conversation | Conversation remains `saved`, but embedded search-visible metadata changes | If the operation actually changes title or summary and search is set up, clog immediately attempts to re-index that conversation before returning. If re-indexing succeeds, the conversation remains searchable with refreshed vectors. If re-indexing fails, `indexed_at` is set to `null` so the conversation is treated as stale until `clog index` succeeds. If search is not set up, the metadata update succeeds and Phase 2 remains inert. No-op updates skip re-indexing and do not bump `modified_at`. |
| `tag`, `untag`, MCP `clog_update` tag, `summaryKind`, or `summaryExtraction` change on a saved conversation | Conversation remains `saved`; DB metadata filters or agent-analysis metadata change | No vector re-index occurs because tags and structured extraction are not part of the embedded search content. Tag-based filtering and MCP metadata reads reflect the new DB state immediately. `indexed_at` is unchanged. No-op updates do not bump `modified_at`. |
| Local scan detects source mtime change on a saved conversation | Conversation remains `saved`; curated metadata and raw content are preserved; `modified_at` and `source_mtime` are refreshed so status can report that newer source content is available | No immediate search effect. The saved/searchable content has not changed until explicit `clog save <id>` refreshes and resaves it. |
| A command detects a raw copy mtime newer than `saved_at` or `indexed_at` | Conversation remains `saved`; curated raw content may have changed | `indexed_at` is set to `null` because projected transcript content may have changed. |
| Git reconciliation update on an in-scope git conversation | Conversation remains `saved`; DB metadata, parser checkpoint, and derived checkout path may be refreshed from the checkout | If reconciliation changes title, summary, or parsed transcript content, `indexed_at` is set to `null` so the imported conversation is treated as stale until re-indexed. Tag-only changes and path-only locator changes preserve `indexed_at` when title, summary, and parsed content are unchanged. |
| File import update from `clog fill` | Conversation remains `saved`; DB metadata, parser checkpoint, and managed import path may be refreshed from the input pair | If fill changes title, summary, or parsed transcript content, `indexed_at` is set to `null`. Tag-only changes and path-only locator changes preserve `indexed_at` when title, summary, and parsed content are unchanged. |
| `exclude` | Local ignore intent is updated in `~/.clog/clogignore`; the current DB row is left in place | No immediate search effect. The conversation remains searchable until it becomes ignored at discovery/import time or is explicitly removed from the DB. |
| `remove` | Only `saved` conversations matched by the rules are removed from the DB; matching `unsaved` rows are left in place | If the removed conversation had vectors, they are deleted. The deindex attempt is best-effort: a saved row that was never indexed (or whose vectors were already gone) deletes cleanly as a no-op. |
| `remote remove` | All git conversations imported from the configured remote are removed from the DB | Those conversations cease to be searchable; their vectors are deleted |
| Git reconciliation delete/retract | An in-scope git conversation is removed from the DB | Conversation ceases to be searchable; vectors are deleted |

The authoritative definition of whether a conversation is eligible to appear in semantic search is its current row in the local database, not whether it was indexed at some point in the past.

### 10.9 MCP Tool

Phase 2 adds one tool to the MCP server:

```typescript
// Semantic search across saved conversations
tool: "clog_search"
input: {
  query: string;           // Natural language search query
  tags?: string[];         // Filter by tags
  project?: string;        // Case-insensitive substring match on project
  author?: string;         // Case-insensitive substring match on author
  origin?: "local" | "remote"; // local rows vs imported saved rows
  limit?: number;          // Default 10, max 50
}
returns: {
  results: Array<{
    id: string;
    source: string;
    title: string;
    summary: string;
    summaryKind: SummaryKind;
    extraction: SummaryExtraction | null;
    tags: string[];
    author: string;
    project: string | null;
    originKind: "local" | "git" | "file";
    originRef: string | null;
    createdAt: string;
    relevanceScore: number;
    snippet: string;       // Matched content excerpt
  }>;
  totalCount: number;
  indexCoverage: {
    indexed: number;     // How many saved conversations are indexed
    saved: number;   // Total saved conversations
  };
  warning?: string;      // Present when search hit the scan cap and completeness is not guaranteed
}
```

`clog_search` only searches **saved** conversations, consistent with `clog_list_saved` and `clog_browse`. If search is not configured, the tool returns an error explaining how to set it up.

`clog_search` uses the same MCP metadata filter semantics as `clog_list_saved`:
`project` and `author` are trimmed case-insensitive substring filters, tags are
normalized exact OR filters, and `origin` maps `local` to `origin_kind = 'local'`
and `remote` to `origin_kind != 'local'`.

Before returning results, both the CLI and MCP search paths check each search hit against the current database state using the searchability invariant (saved state with a fresh `indexed_at` at or after `saved_at`). If a vector-store entry refers to a conversation that is missing from the DB, no longer in `saved` state, or has a stale index, that hit is filtered out and must not be surfaced to the user.

Search uses an expanding query window: it starts by fetching a small multiple of the requested limit from the vector store, then doubles the fetch count on each iteration until it either collects enough valid results or reaches the 5,000-entry scan cap. If search stops because it reached that 5,000-entry cap before finding enough valid results, it returns the best results found so far and includes a warning that results may be incomplete. If search stops for any other reason (enough results found, or vector store exhausted below the cap), it does not include that warning.

For the CLI command, this warning is printed as a visible warning line before the results (or before `No results found.` if filtering removes every scanned hit). For the MCP tool, the same condition is reported via the optional `warning` field in the response object.

### 10.10 Modifications to Phase 1 Features

Phase 2 requires changes to existing Phase 1 code:

**Save** (`clog save`): After saving, auto-index the newly saved conversations if search is configured and dependencies are available. This is best-effort — if search deps are missing or indexing fails, save still succeeds and leaves `indexed_at = null`. The conversation is saved but not searchable until `clog index` or a later save indexes it successfully. The command must print an indexing outcome whenever at least one conversation was saved, so users can distinguish successful indexing, unavailable indexing, and intentionally unconfigured search.

**Edit** (`clog edit` and MCP `clog_update` title/summary changes): When a saved conversation is changed in a way that affects embedded search-visible metadata, immediately attempt to re-index it if search is set up. This includes title and prose summary changes. Changes only to `summaryKind` or `summaryExtraction` do not re-index because the structured extraction is not embedded in the vector index. If re-indexing succeeds, `indexed_at` is refreshed. If re-indexing fails, `indexed_at` is set to `null`. No-op updates do not re-index, do not clear `indexed_at`, and do not bump `modified_at`.

**Tagging** (`clog tag`, `clog untag`, and MCP `clog_update` tag changes): Tags are DB-side metadata filters, not embedded vector content. Tag changes do not trigger re-indexing and do not change `indexed_at`. Tag-based filtering reflects the new DB state immediately.

**Removal / deletion**: When a saved conversation stops being searchable because it is removed from the database, deleted during reconciliation, or otherwise no longer searchable, delete its vectors from the vector store. Search must not surface conversations that are no longer searchable even if stale vectors still exist on disk.

**Config schema**: Add `search.embedding.type` and `search.vectorStore.type` fields to the config schema (Section 7).

### 10.11 Provider Architecture

The provider and dependency resolution pattern is designed for optional deps that may not be installed:

- **Provider registry** — a static map of provider name → required npm packages, config schema, and factory function. Adding a new provider means adding an entry to this map.
- **Runtime dependency checking** — before instantiating a provider, check that its required packages are importable. If not, surface a clear error.
- **Composition root** — reads `config.json`, resolves the configured providers, and returns concrete `EmbeddingProvider` + `VectorStore` instances. The indexer and search commands depend only on the interfaces, never importing Vectra or transformers directly.

### 10.12 Implementation Parameters

- **Chunk size:** ~800 tokens with ~100 token overlap, turn-based. Turns are the natural unit of conversation — a user question plus the assistant's response.
- **Auto-index timing:** On save, not on MCP server startup. Saving is the moment new content enters the knowledge base, so indexing there keeps search current. MCP startup indexing would add latency to agent sessions.
- **Default embedding model:** `all-MiniLM-L6-v2` — well-established, good quality-to-size ratio, widely supported by transformers.js.
- **Search ranking:** Cosine similarity via the vector store. Ranking quality is determined by the embedding model. The default is sufficient for the expected scale.
- **Minimum score threshold:** Results below 0.15 cosine similarity are filtered out. This removes noise from unrelated conversations without being so aggressive that it drops marginally relevant results.

### 10.13 Testing

**Chunker tests** (`chunker.test.ts`): Turn-based chunking logic, token limit splitting, overlap behavior, metadata attachment.

**Search tests** (`search.test.ts`): Integration tests for indexing and querying. These tests are conditional — they only run when the search dependencies (`vectra`, `@huggingface/transformers`) are available. Use a `checkPackages()` guard to skip gracefully when deps are missing.

---

## 11. Team Sharing (Phase 3)

Phase 3 adds team sharing via git. Developers save conversations locally (Phase 1 workflow), then sync them to a shared git repository where teammates can pull and search them. The remote is a private git repo on any git host (GitHub, GitLab, Gitea, bare repo on a server). No custom server infrastructure.

### 11.1 Design Decisions

#### Git as Transport

A custom REST API was considered and rejected in favor of using git as the transport layer. Git provides auth, transport security, access control, audit log, conflict detection, versioning, hosting, offline support, and backups — all for free.

P2P sync is out of scope.

#### Git Is Additive

The existing local workflow (discover → save → curate) is unchanged. Git enters only at the sync boundary:

```
[existing local workflow] → save → [export to git, commit, push]
[git pull, import into local DB] → [existing local workflow]
```

No part of the local workflow (state machine, clogignore, raw file storage) is replaced by git. The overlap between clog's concepts and git's concepts is superficial — they serve different purposes at different layers.

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

#### Imported Conversations Are Read-Only (v1)

Imported conversations cannot be edited or tagged locally. `clog edit`, `clog tag`, `clog untag`, `clog save`, and `clog diff` refuse rows with `origin_kind != 'local'`, including both git-synced rows and file-imported rows, even when `author == config.author`. This avoids the complexity of local overlays, sync-back, and conflicts with the author's edits. Revisit after Phase 3 stabilizes.

A future version may add an explicit workflow to materialize one or more remote conversations into a local source directory so the user can continue them locally. That continuation flow is out of scope for Phase 3 / v1 sync.

#### Ignore Rules Apply to Remote Conversations

Remote conversations use the same local ignore-intent model as local discovery, but through `clogignore` rather than a separate blocklist. If the user wants to stop seeing a remote conversation locally:

1. add an ignore rule with `clog exclude <rule>`
2. remove the current imported DB row with `clog remove <rule>` if desired

During subsequent reconciliation, git conversation file pairs whose IDs or project names match the local `clogignore` import subset are skipped before import or update and still protect any existing in-scope git row from deletion. `clog unexclude` removes the ignore rule again; the next `clog sync pull` or `clog refresh` may then re-import matching git conversations.

#### Commits Use the User's Existing Git Identity

clog never writes `user.name` or `user.email` into `~/.clog/remote/.git/config`. Commits made by `clog sync push` are authored by whatever git resolves for that working tree, which under normal use is the user's global git identity (`git config --global user.name` / `user.email`).

This is deliberate. clog's users are developers who already have git configured. Their organizational git identity is the right committer for a shared knowledge-base repo: it preserves SSO attribution, commit signing, and audit-trail correlation that an org may already rely on. Synthesizing a placeholder identity like `<author>@clog.local` would actively destroy that correlation for the life of the repo's history, and would conflate clog's *curation* identity (`config.author`, which can be a display name or a renamed value like `alice-work`) with git's *transport* identity.

If git has no identity configured, `clog sync push` surfaces git's native error and adds a hint pointing at `git config --global`. clog does not auto-configure the checkout to work around the missing identity.

On first clone or pull, clog performs an advisory check (`git -C ~/.clog/remote config user.email`). If the resolved value is empty, it prints the same hint up front rather than waiting for the first push to fail. This is a warning, not a write — clog never modifies git's identity configuration.

#### No Automatic Retries

No operations automatically retry. If a `git push` is rejected (simultaneous push from a teammate), clog stops and informs the user. They can re-run `clog sync push` manually. This applies to all sync operations.

### 11.2 Repo Structure

Source-separated by author, two files per conversation:

```
clog-team/                        # the shared git repo
├── alice/
│   ├── claude-code/
│   │   ├── c7044ea5-c019-44d6-a77a-500036740f9a.meta.json  # serialized metadata
│   │   └── c7044ea5-c019-44d6-a77a-500036740f9a.jsonl      # conversation content
│   └── codex-cli/
│       ├── 550e8400-e29b-41d4-a716-446655440000.meta.json
│       └── 550e8400-e29b-41d4-a716-446655440000.jsonl
└── bob/
    └── claude-code/
        ├── 123e4567-e89b-12d3-a456-426614174000.meta.json
        └── 123e4567-e89b-12d3-a456-426614174000.jsonl
```

The `.meta.json` contains the conversation's metadata. It uses only objective identifiers — no relative terms like "local" or "remote." Its presence in the repo establishes its git provenance. The `author` field identifies who curated it.

The portable conversation file pair is transport-neutral: `<id>.jsonl` plus
`<id>.meta.json`. Pair discovery walks the input directory and every
subdirectory. It looks only at files ending in `.meta.json` or `.jsonl`. Two
files are a candidate pair when they are in the same relative directory and have
the same filename before the suffix. A one-file candidate is still returned so
validation can report `pair_incomplete`. Results are ordered by the normalized
relative path text using raw character order, so output does not depend on
filesystem or locale ordering.

Pair validity requires both files to be present, metadata to be valid JSON with
required fields and ISO timestamps, `meta.source` to be a supported source key,
both filename stems to equal `meta.id`, and the JSONL to parse through the
adapter selected by `meta.source`. Pair validation does not perform
source-native embedded-ID cross-validation; source adapters still apply their
own discovery-time native-ID checks, such as Codex `session_meta.payload.id`
validation.

Pair writing uses the shared safe writer: `.jsonl` is written first, then
`.meta.json`, each through an atomic temp-file-and-rename write. A complete
metadata file therefore implies its content file is present.

The git remote path tuple is `(author, source, id)`. The source directory and filename are part of the remote storage contract:

- `<author>` is the author directory for the person who saved the conversation
- `<source>` must be a supported source key such as `claude-code` or `codex-cli`
- `<id>` is the source-native conversation ID and must match `meta.id`
- `meta.source` must match the `<source>` directory
- the `.jsonl` and `.meta.json` paths for a conversation must share the same `(author, source, id)` tuple

Git layout invariants are git-specific. In the sync repo, `meta.source` must
match the `<source>` directory and `meta.author` must match the `<author>`
directory; layout violations are `pair_layout_mismatch`. `clog fill` and
`clog drain --format pair` are layout-neutral and do not require author
directories.

Import identity is `(source, id)`, not `id` alone.

```json
{
  "id": "abc123-...",
  "title": "Fix authentication bug",
  "summary": "Debugged JWT token expiration...",
  "summaryKind": "generated",
  "summaryExtraction": {
    "topics": ["auth", "jwt"],
    "outcome": "fixed",
    "toolsUsed": ["Edit", "Bash"],
    "notableMoments": [{ "why": "user caught a wrong initial assumption" }]
  },
  "tags": ["auth", "debugging"],
  "author": "alice",
  "projectName": "myapp",
  "savedAt": "2026-02-20T10:00:00Z",
  "modifiedAt": "2026-02-21T15:00:00Z",
  "source": "claude-code",
  "createdAt": "2026-02-19T09:15:00Z",
  "slug": "fix-auth-bug"
}
```

On git pull and file fill, clog reads `.meta.json` files for metadata and parses each paired JSONL once for validation. Import uses the metadata for DB fields, and the JSONL must parse successfully through the source adapter so clog can treat the imported conversation as a readable saved artifact. Imported conversations derive their local `savedMessageCount` from the parsed `Message[]` length at import/update time; this checkpoint is not stored in pair metadata. Git reconciliation derives the row fields below; `clog fill` uses the same pair metadata and validation but derives row fields according to §5.7.4.

**meta.json field reference:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Conversation UUID from the source. Also used as `sourceId` in the DB for built-in sources |
| `title` | string | Curated or auto-generated title |
| `summary` | string | Curated or extracted summary |
| `summaryKind` | `"none"`, `"imported"`, `"generated"`, or `"curated"` | Who or what produced the prose summary. Optional for backward compatibility; missing values are interpreted as `curated` when `summary` is non-empty, otherwise `none` |
| `summaryExtraction` | object or null | Structured summary fields (`topics`, `outcome`, `toolsUsed`, `notableMoments`). Optional for backward compatibility; missing values are interpreted as null |
| `tags` | string[] | Curated tags |
| `author` | string | Who curated this conversation |
| `projectName` | string or null | User-facing project name the conversation is associated with. Pair metadata does not include local project paths |
| `savedAt` | string | ISO timestamp of the time the conversation was saved to clog |
| `modifiedAt` | string | ISO timestamp of the last metadata edit or content-change marker |
| `source` | string | Source adapter (e.g., `"claude-code"`) |
| `createdAt` | string | Earliest message timestamp — when the conversation started |
| `slug` | string or null | Session slug from the source (if available) |

Pair metadata is valid only when:

- the metadata file is valid JSON
- all required fields are present with the expected types
- the paired JSONL parses successfully through the adapter selected by `source`
- `savedAt`, `modifiedAt`, and `createdAt` are ISO timestamp strings
- `source` is a supported source key
- `id` matches the filename stem in both the `.meta.json` and `.jsonl` path

Git reconciliation adds layout validation: `source` must match the source
directory in the path, and `author` must match the author directory. A valid
metadata document in the wrong directory is a `pair_layout_mismatch`, not
invalid metadata.

Older pair metadata files without `summaryKind` or `summaryExtraction` remain valid. Import treats a non-empty legacy `summary` as `summaryKind = "curated"` and treats a blank legacy `summary` as `summaryKind = "none"`; `summaryExtraction` defaults to `null`.

**Fields derived when git reconciliation inserts a row** (not in meta.json):

| DB field | Value for newly inserted git conversations |
|----------|------------------------------------------|
| `sourceId` | Same as `id` |
| `discoveredAt` | Import timestamp (now) |
| `state` | `"saved"` |
| `saveVersion` | `1` |
| `savedMessageCount` | Parsed `Message[]` length at import/update time |
| `projectPath` | `null` |
| `sourcePath` | Path in checkout (`~/.clog/remote/<author>/<source>/<id>.jsonl`) |
| `filePath` | Same as `sourcePath` |
| `sourceMtime` | File mtime from filesystem |
| `indexedAt` | `null` (not yet indexed) |
| `originKind` | `"git"` |
| `originRef` | Configured git remote URL |

For existing git rows, reconciliation updates fields according to §11.8. `indexedAt` is cleared only when title, summary, or parsed transcript content changes; tag-only updates and path-only locator updates preserve it (§10.8.1).

### 11.3 File Layout

This extends the base storage layout (§3.5) with a `remote/` directory:

```
~/.clog/
├── clog.db              # SQLite — metadata for ALL conversations
├── config.json          # User configuration (includes sync metadata)
├── raw/                 # Locally saved JSONL files
│   ├── claude-code/
│   │   └── c7044ea5-c019-44d6-a77a-500036740f9a.jsonl
│   └── codex-cli/
│       └── 550e8400-e29b-41d4-a716-446655440000.jsonl
├── imports/             # Managed JSONL files imported by clog fill
│   └── claude-code/
│       └── 99999999-9999-4999-9999-999999999999.jsonl
└── remote/              # Git clone of team repo
    ├── .git/
    ├── alice/
    │   ├── claude-code/
    │   │   ├── c7044ea5-c019-44d6-a77a-500036740f9a.meta.json
    │   │   └── c7044ea5-c019-44d6-a77a-500036740f9a.jsonl
    │   └── codex-cli/
    │       ├── 550e8400-e29b-41d4-a716-446655440000.meta.json
    │       └── 550e8400-e29b-41d4-a716-446655440000.jsonl
    └── bob/
        └── ...
```

`raw/`, `imports/`, and `remote/` are separate directories with separate purposes:

- `raw/` holds files the local user explicitly saved.
- `imports/` holds managed file-import copies created by default `clog fill`.
- `remote/` is the git working tree — a clone of the team repo.

Remote conversation content is read directly from the git checkout. No duplication into `raw/`. Filled read-only conversation content is read directly from `imports/`. A `resolveContentPath(conversation)` function returns the right path from the row state and stored `filePath`:

- Local `unsaved` conversations: `sourcePath`
- Saved conversations: `filePath`

For saved rows, `filePath` points at `raw/<source>/<id>.jsonl` for local saves,
`remote/<author>/<source>/<id>.jsonl` for git imports, and
`imports/<source>/<id>.jsonl` for file imports. Content-path resolution needs no
special `file`-kind branch because file-imported rows follow the same saved-row
rule.

### 11.4 DB Schema Changes

Conversation provenance is stored in two local-only columns:

```sql
origin_kind TEXT NOT NULL DEFAULT 'local'
            CHECK(origin_kind IN ('local','git','file')),
origin_ref TEXT,
CHECK(
  (origin_kind = 'git' AND origin_ref IS NOT NULL)
  OR
  (origin_kind IN ('local','file') AND origin_ref IS NULL)
)
```

`origin_kind` is the sole provenance class signal:

| `origin_kind` | `origin_ref` | Meaning |
|---------------|--------------|---------|
| `local` | `NULL` | The row originated through local discovery, `clog save`, or `clog fill --own` restore |
| `git` | Configured git remote URL | The row was imported from the configured git sync checkout |
| `file` | `NULL` | The row was imported by default `clog fill` as a read-only file import |

`origin_ref` is monomorphic: it is a git remote URL or `NULL`. It is read only
as the git remote URL value. No behavior branches on `origin_ref` nullness;
local versus imported behavior is always determined by `origin_kind`.

These columns are local-only. They never appear in `.meta.json` files, JSON
drain exports, markdown frontmatter, or pair metadata.

Purposes:

1. `clog list` can distinguish local rows from imported rows
2. Imported conversations are read-only — edit/tag/untag/save/diff refuse `origin_kind != 'local'`
3. `clog sync push` exports only local saved conversations
4. Git reconciliation scopes updates and deletions to `origin_kind = 'git' AND origin_ref = <configured remote URL>`
5. MCP server filters `origin: "local"` as `origin_kind = 'local'` and `origin: "remote"` as `origin_kind != 'local'`

Authority matrix:

| Kind | Writable | Saved by `clog save` | Pushed by git sync | Deleted by git reconciliation | Default `clog list` visibility |
|------|----------|----------------------|--------------------|-------------------------------|---------------------------------|
| `local` | Yes | Yes | Yes, when `author = config.author` | Never | Always |
| `git` | No | No | No | Only when `origin_ref` equals the configured remote URL | Only when `author = config.author` |
| `file` | No | No | No | Never | Only when `author = config.author` |

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
| `remote.visibilityConfirmed` | boolean | Persisted after the user explicitly accepted the visibility risk at `clog remote add` time (see §11.6) |
| `remote.lastSyncHead` | string or null | Git HEAD hash from last successful sync operation. Used for staleness detection |

Sync metadata lives in config (not DB) so that the DB remains disposable — users can delete `clog.db` and regenerate it from source files without losing sync configuration.

### 11.6 Commands

#### `clog remote add <url>`

Store the URL in `config.json`. Does **not** clone — `remote add` is a configuration operation, not data transport.

If a remote already exists, error: "Remote already configured. Use `clog remote remove` first."

**Visibility safety check** — before storing the config:

clog treats pushing conversations to a public repository as the single most dangerous operation in the sync layer. Every successful `clog remote add` must end in one of two states: either clog has positively confirmed the repository is public and refused, or the user has explicitly accepted the visibility risk for this repository at add time. There is no silent-proceed path.

The check has two outcomes:

| Outcome | Trigger | Action |
|---------|---------|--------|
| **Proven public** | Unauthenticated GitHub REST probe returns `200 OK` with `"private": false` in the JSON body | Refuse the add |
| **Not proven public** | Anything else — `404`, `403`, network error, timeout, malformed JSON, non-GitHub host, any other response | Interactive confirmation required before the URL is stored |

There is no "proven private" outcome and no silent-proceed outcome. GitHub's unauthenticated REST API deliberately returns `404` for private repositories — it never reveals that a private repo exists to an unauthenticated caller, because doing so would leak repository names via enumeration. An unauthenticated GET therefore cannot positively confirm that a repository is private; it can only positively confirm that one is public. clog does not attempt to authenticate the probe: authenticating would tie the check to whichever token the user happens to have configured (which may have different permissions than the repo's access model), and would introduce new failure modes unrelated to visibility.

**GitHub host detection and URL conversion:**

- `github.com` is matched by hostname. URLs like `git@github.com:org/repo.git` and `https://github.com/org/repo.git` map to `https://api.github.com/repos/org/repo`.
- GitHub Enterprise hosts are matched heuristically (e.g., `github.*` hostnames). URLs like `git@github.mycorp.com:org/repo.git` and `https://github.mycorp.com/org/repo.git` map to `https://github.mycorp.com/api/v3/repos/org/repo`.
- The `.git` suffix is stripped from the path. Trailing slashes are tolerated.

clog issues an unauthenticated `GET` to the derived API URL with a short timeout (e.g., 5 seconds), no auth headers, and no credential helper involvement. The probe is a one-shot per `remote add` invocation; it does not retry. For non-GitHub hosts, the probe is skipped and the flow goes directly to the confirmation branch.

**Proven-public refusal:**

When the probe returns `200 OK` with `"private": false`, clog refuses without a prompt. The refusal uses warning emphasis — the word "Error" and the repository identifier are rendered in bold red when the terminal supports color:

```
Error: Repository myorg/clog-team is public.
Pushing conversations to a public repository would make them visible
to anyone on the internet.
If this is intentional, add "allowPublicRemote": true to your clog config.
```

The `allowPublicRemote` flag must be manually edited into `config.json` — not settable via a CLI command or the `--yes` flag. This keeps public repos a deliberate, high-friction choice that cannot be reached by a mistyped command or an overly permissive automation script.

**Not-proven-public confirmation:**

When the probe returns anything other than a proven-public response, clog prints an interactive confirmation. The header line and the critical risk sentence use warning emphasis — the header in bold yellow, the risk sentence in bold red, the default answer `N` in bold — when the terminal supports color:

```
clog could not verify that git@github.com:myorg/clog-team.git is private.
Reason: <dynamic reason>.

If this repository is public, the conversations clog pushes to it will
be visible to anyone on the internet. clog refuses to push to a repository
it has positively identified as public, but it cannot guarantee privacy
when the visibility check could not complete.

Only continue if you are certain this repository is private.

Continue? [y/N]
```

The `Reason:` line is filled in dynamically so the user understands which branch they hit:

| Condition | Reason line |
|-----------|-------------|
| HTTP `404` | `repository not found or private (GitHub returns 404 for both)` |
| HTTP `403` | `GitHub API rate limited (HTTP 403)` |
| Other 4xx / 5xx | `unexpected GitHub API response (HTTP <status>)` |
| Network error, DNS failure, timeout | `network error: <error message>` |
| Malformed JSON body | `could not parse GitHub API response` |
| Non-GitHub host | `non-GitHub host — clog cannot probe visibility over REST` |
| Unexpected `200 OK` with `"private": true` | `GitHub returned a privacy claim clog did not expect; please verify manually` |

The default answer is `N`. Hitting enter without typing anything aborts the add with `"Aborted."` and does not write any config. On `y`, clog writes `remote.url` and `remote.visibilityConfirmed: true` to config and prints `"Remote configured. Run 'clog sync pull' to clone."`.

The `--yes` flag bypasses this confirmation (for scripts and tests). `--yes` does **not** bypass the proven-public refusal — even `--yes` cannot add a confirmed-public repo without also setting `allowPublicRemote` in `config.json`.

**Why this model:**

- One decision point at the moment the user is most engaged with the URL they just typed, rather than a deferred confirmation during a later `sync push` that is easy to click through
- One refusal condition, one confirmation condition, zero silent-proceed paths — every successful add is either positively-verified-not-public or explicitly-user-accepted
- The confirmation fires on the happy path (because unauthenticated 404 is the normal outcome for any real private repo), which means users come to expect the prompt and cannot have it sneak past them
- The probe is deterministic and unit-testable by mocking `fetch`, with no dependency on a `gh` binary, a credential helper, or a logged-in shell

**GitHub HTTPS URL warning** — GitHub does not support password authentication over HTTPS. If the URL matches `https://github.com/...`, warn the user, suggest the equivalent SSH URL, and prompt to continue. This warning is separate from the visibility confirmation and fires first; the visibility confirmation still runs afterward. Users with a personal access token or `gh auth login` configured can proceed; the warning ensures they're making an informed choice rather than hitting an opaque auth failure on first push.

#### `clog remote show`

Display: configured remote URL, last sync time, local saved count, and count of git conversations whose `origin_kind = 'git'` and `origin_ref` equals the configured remote URL. File-imported rows are not counted as conversations from the configured git remote.

#### `clog remote remove`

Remove the clone directory (`~/.clog/remote/`), purge git conversations whose `origin_kind = 'git'` and `origin_ref` equals the configured remote URL from the local DB (and deindex them from the vector store), and clear remote config. File-imported rows are not removed by `clog remote remove`.

Confirmation prompt required:

```
This will remove the remote and delete 47 conversations pulled from it.
Local conversations, saved or unsaved, are not affected.
Continue? [y/N]
```

#### `clog sync pull`

On first run (no `~/.clog/remote/` checkout): clone the repo, then reconcile.

On subsequent runs: `git pull --rebase` in the checkout, then reconcile (full reconciliation, see §11.8).

If `~/.clog/remote/` exists but was cloned manually: validate the remote URL matches config, then proceed normally.

Reports import results: "Pulled N conversations from remote. M new, K updated, J removed."

If search is configured and conversations were imported, report unindexed count (see §11.11).

#### `clog sync push`

Export locally saved conversations to the git checkout, commit, push. See §11.7 for full flow.

#### `clog refresh`

Standalone command — reconcile the local DB from the current state of the git checkout without fetching from the remote. This is the local-only half of `clog sync pull`.

Use case: the user ran `git pull` manually in `~/.clog/remote/`, or edited files in the checkout, and wants clog to catch up.

Runs the same reconciliation logic as pull (§11.8) without the `git pull` step.

If no remote is configured: `"No remote configured. Nothing to refresh."`

#### `clog rename-author` — Sync Context

`clog rename-author` is a Phase 1 command (see §5.12 for base behavior). When a remote is configured, the confirmation prompt includes additional context about the sync impact:

```
This will rename author "alice-work" to "alice" on 23 local conversations.
`clog rename-author` does not change `config.author`.
On next push, only conversations whose stored `author` matches `config.author` are exported.
To push these conversations under "alice/", also run `clog config set author alice`.
```

The following line is displayed in red:

```
The old "alice-work/" directory will remain until manually removed from the repo.
```

```
Continue? [y/N]
```

The command does not touch the git checkout, push, or config. On the next `clog sync push`, conversations are exported only when their stored `author` matches `config.author`; if the user also updates `config.author` to the renamed value, those conversations then appear under the new author directory. The old directory persists in the repo until manually cleaned up.

### 11.7 Push Flow

**Preconditions** (check before doing any work):

- Remote is configured. If not: error and stop.
- `config.author` is non-empty. If not: `"Set your author name first: clog config set author <name>"`
- Checkout exists (`~/.clog/remote/`). If not: `"You haven't pulled from the remote yet. Run 'clog sync pull' first."`
- `remote.visibilityConfirmed` is `true` in config. If not (only reachable via hand-edited config): refuse with `"Remote visibility was never confirmed. Run 'clog remote remove' and 'clog remote add <url>' to re-run the visibility check."`

**Pre-reconcile snapshot** (multi-machine safety):

1. Before the pull phase, snapshot the set of `(source, id)` tuples for every saved conversation where `author = config.author`, regardless of `origin_kind`. This includes local rows, git rows, and file rows by the same author. The snapshot is taken before `reconcileRemote` runs because reconcile may re-import conversations that the user intentionally retracted — a row absent from the pre-reconcile snapshot remains retractable.

This complements the import-side guards in §11.8 (`clogignore` import gating and out-of-scope owner rule). A same-author `file` row protects an existing checkout pair from retraction; an intentionally removed row is absent from the snapshot and stays retractable.

**Pull phase** (incorporate teammates' changes):

2. `git pull --rebase` in checkout. If rebase conflict: abort rebase, stop, inform user: `"Unexpected conflict during rebase. Inspect with: git -C ~/.clog/remote status"`
3. Reconcile DB from checkout — same logic as §11.8. This imports any new or updated conversations from teammates.

**Export phase** (write local state to checkout):

4. For each local saved conversation (`origin_kind = 'local' AND state = 'saved'`) where `author = config.author`:
   - Write `<author>/<source>/<id>.meta.json` with metadata, including `projectName`, `summaryKind`, and `summaryExtraction`, but not local-only `projectPath`, `originKind`, `originRef`, managed paths, or parser checkpoints
   - Copy `raw/<source>/<id>.jsonl` to `<author>/<source>/<id>.jsonl`
   - Use the shared pair writer, which writes JSONL first and metadata last
5. For each complete conversation pair under a supported `<config.author>/<source>/` directory in checkout that doesn't correspond to a local saved conversation or any same-author saved identity in the pre-reconcile snapshot: delete the `.jsonl` and `.meta.json`. Track these as retractions for the output summary. Retraction scanning is limited to `config.author`'s directory; `sync push` must never delete files under another author directory.

The export/retraction phase should use the lightest necessary touch:

- create author/source directories only when writing a conversation into them
- do not proactively remove empty author or source directories
- do not modify unknown source directories
- do not modify unrelated files
- do not delete orphaned `.jsonl` or `.meta.json` files unless they form the stale side of a previously complete conversation pair that clog owns for this author/source/id

**Commit and push phase:**

5. `git add -A`
6. If no changes: `"Nothing to push — all saved conversations are already synced."` Stop.
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

**Visibility confirmation is an add-time decision, not a push-time decision.** Every code path that reaches `sync push` has already seen `remote.visibilityConfirmed: true` in config, because `remote add` either refused the repository, aborted without writing config, or wrote the config with `visibilityConfirmed` set. `sync push` therefore performs no visibility check of its own and shows no visibility prompt. If `visibilityConfirmed` is somehow absent at push time (hand-edited config), `sync push` refuses with a message pointing at `clog remote remove` + `clog remote add` to re-run the add-time flow.

**Why `git pull --rebase`:** In the simultaneous-push scenario, the histories have diverged. `--rebase` replays the local commit on top of the remote cleanly, since developers write to different directories. This means users never see merge commits from normal clog usage. Clog should never create a merge commit.

### 11.8 Pull Flow: Full Reconciliation

After `git pull` (or in `clog refresh`, without the git pull), git
reconciliation runs the git-specific interchange planner in two stages:

1. a deterministic planner scans checkout conversation file pairs, compares
   them with a database snapshot, and emits explicit insert, update, delete, and
   skip actions without writing files, rows, or vectors
2. a git executor applies the plan in a database transaction and then
   best-effort deletes vectors for every deleted row

If vector cleanup fails after the database transaction commits, reconciliation
remains successful and prints a warning naming the affected short ID.

The scanner walks the checkout by author directory, source directory, and
conversation ID in code-point lexicographic order. Supported source directories
are reconciled; unsupported source directories emit `unsupported_source` and are
not modified. The scanner still protects credible supported identities found
under unsupported directories when readable metadata exposes them.

Reconciliation is scoped to the configured git remote only:

- in-scope rows are `origin_kind = 'git' AND origin_ref = <configured remote URL>`
- rows from other git remotes are out of scope
- `local` and `file` rows are out of scope
- deletion applies only to in-scope rows

The planner keys conversations by `(source, id)`. A valid pair insertion checks
the global owner for that identity. Any out-of-scope owner blocks the git insert:
a local unsaved row, a local saved row, a file-imported row, or a git row
from a different remote. Every resolution outcome is chosen so reconciliation
never trips the `UNIQUE(source, source_id)` constraint as an error.

Git reconciliation and `clog fill` (§5.7.4) share one policy-parameterized
resolution engine, so the two transports stay deliberately consistent where their
inputs agree and diverge only where they must. Resolution is by provenance and
deterministic order, never by timestamp: the engine does not compare `modifiedAt`
or `savedAt` to choose a winner, so a git pull never overwrites more up-to-date
local work. The one place recency is ignored on purpose is the cross-author
duplicate (§11.13), resolved by deterministic first-wins rather than a
clock-skew-prone recency tiebreak.

The authoritative reconciliation policy:

| Checkout state for `(source, id)` | In-scope git row? | Action |
|-----------------------------------|-------------------|--------|
| Complete valid pair, no owner | No | Insert saved `git` row with `origin_ref = <configured remote URL>` |
| Complete valid pair, in-scope owner | Yes | Update if pair metadata, derived checkout path, or parsed `savedMessageCount` changed |
| Complete valid pair, out-of-scope owner | Any | Skip; the existing owner takes precedence |
| Complete valid duplicate pairs in one checkout | Any | First valid pair wins by deterministic author/source/id order; later copies are skipped with a duplicate notice |
| Pair matches the import subset of `clogignore` | Any | Skip import/update and treat the pair as present for deletion planning |
| Complete pair absent | Yes | Delete the in-scope git row |
| Incomplete, invalid, or layout-mismatched pair present | Any | Warn, skip, leave DB rows unchanged, and protect credible identities from deletion |

Retraction requires both files to be absent. A metadata-only file, JSONL-only
file, invalid metadata file, invalid content file, or layout-mismatched pair is
present-but-bad repository state, not deletion intent. During a reconciliation
run, every incomplete or invalid pair protects every credible `(source, id)`
identity derivable from the path tuple and readable metadata. Deletion
protection is keyed by `(source, id)` across the whole checkout, not by author,
so a pair relocated between author directories cannot cause the existing row to
be deleted.

Git layout validation uses pair warnings accurately:

- metadata source differing from the source directory is `pair_layout_mismatch`
- metadata author differing from the author directory is `pair_layout_mismatch`
- filename stem differing from `meta.id` is `pair_id_mismatch`
- JSONL parse failure is `pair_invalid_content`

Warnings are emitted during the command that performs validation and are not
persisted as conversation state. Each warning uses the `ClogWarning` shape with
`pair: { author?, source, id }`, affected paths, the validation reason, the
reconciliation action taken, and a concrete fix suggestion when possible.

Ignored valid git pairs are non-destructive. Before importing or updating, the
planner checks `~/.clog/clogignore` using the import subset from §5.10. If a
pair ID or project name matches a local ignore rule, the pair is skipped but
still protects any existing in-scope git row from deletion. When reconciliation
skips one or more pairs because of `clogignore`, the command prints one summary
line naming the count.

Change detection is field-based. An in-scope git row updates when a `.meta.json`
field changes, the derived checkout path changes, or the parsed JSONL produces a
different `savedMessageCount`. A changed `savedMessageCount` is a parsed content
change. Reconciliation clears `indexedAt` only when title, summary, or parsed
transcript content changes. Tag-only changes and path-only locator changes
preserve `indexedAt` when title, summary, and parsed content are unchanged.

Properties:

- Idempotent — running pull/refresh twice produces the same result
- Robust to interrupted pulls
- No sync state to track beyond the git checkout itself
- O(all git checkout conversations) per pull — fine at <10 devs scale

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

`clog list` remains curated-by-default in Phase 3. With no flags, it shows the user's local curated library on this machine plus same-author imported saved conversations:

```sql
WHERE state = 'saved'
  AND (origin_kind = 'local' OR (origin_kind != 'local' AND author = <configured author>))
```

If `config.author` is empty or unset, fall back to:

```sql
WHERE state = 'saved'
  AND origin_kind = 'local'
```

This shows:
- All curated local conversations (`origin_kind = 'local'`), regardless of `author`
- Same-author imported conversations from git or file fills

Unsaved conversations remain visible through `clog status`, `clog list --state unsaved`, or `clog list --all`.

This preserves the Phase 1 mental model that `clog list` is the curated library view on the current machine, while still supporting multi-machine solo users and same-author file imports: someone using clog on laptop and desktop sees all of their curated local conversations on each machine plus same-author imported conversations.

#### Team conversation hint

When a remote is configured and git conversations from that configured remote exist in the DB with other authors, append a footer:

```
47 team conversations available (use `clog list --all` to include)
```

#### Filtering flags

Phase 3 adds `--origin <origin>` to `clog list`. Its semantics:

- `--all` — show all conversations (local + imported), including rediscovered ignored local source conversations per §5.3
- `--author <name>` — filter by author
- `--origin local` — only local conversations (`origin_kind = 'local'`)
- `--origin remote` — imported conversations (`origin_kind != 'local'`), including both git and file rows

These compose with existing filters (`--state`, `--project`, `--tag`, `--grep`).

### 11.11 Search Indexing After Pull

`clog save` auto-indexes newly saved local conversations when search is configured and dependencies are available. `clog sync pull` does not auto-index imported git conversations. Bulk imports may add hundreds of conversations, and embedding them during pull could turn sync into a long-running indexing job.

After pull, imported or updated git conversations that need indexing remain with `indexed_at = null`. The pull output must make this visible as a separate warning-style block, using spacing and color when available:

```
Pulled 583 conversations from remote.

Search index needs attention:
  583 saved conversations are not indexed.
  Run `clog index` to index new conversations, or `clog index --rebuild` to rebuild everything.
```

`clog status` reports pending index count: "N conversations not yet indexed."

The DB already tracks `indexed_at` per conversation, so tracking unindexed conversations is free.

### 11.12 MCP Server Changes

The MCP server already reads from the DB — if imported conversations are in the DB as saved, they're served automatically.

Phase 3 extends the Phase 1/2 MCP tool schemas with an optional `origin` filter on `clog_list_saved` and `clog_search`:

```typescript
// Added to clog_list_saved input in Phase 3
origin?: "local" | "remote";

// Added to clog_search input in Phase 3
origin?: "local" | "remote";
```

Its input semantics are:

- `"local"` — only `origin_kind = 'local'`
- `"remote"` — imported conversations (`origin_kind != 'local'`), including both git and file rows
- Omitted — both

Response payloads expose `originKind` and `originRef`; they do not expose a
legacy nullable `origin` field.

This lets an agent say "show me imported conversations" or "show me only local conversations" while preserving exact provenance in responses.

### 11.13 Duplicate Conversations

If two developers independently curate and save the same underlying conversation (same source and UUID), the repo contains both copies under their respective author directories, potentially with different metadata (titles, tags, summaries).

The DB primary key and `UNIQUE(source, source_id)` constraint enforce that a conversation exists at most once in the local database. For built-in sources, the source-native UUID is treated as the conversation's global identity.

**On pull:** any out-of-scope owner takes precedence. If a conversation with the same `source + source_id` already exists as a local row, file row, or git row from a different remote, the incoming git version is skipped. For git-vs-git duplicates within one checkout (two remote authors saved the same `(source, id)` conversation), the first encountered copy is imported; subsequent copies are skipped before hitting the uniqueness constraint. Deterministic scan order (author, source, then ID) determines which copy wins.

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
clog: alice — 47 added, 3 updated, 1 retracted
```

**Multi-author (manual/admin operations only — normal push always produces single-author commits):**

```
clog: 2 authors — 50 added, 4 updated, 1 retracted

  alice: 47 added, 3 updated
  bob: 3 added, 1 updated, 1 retracted
```

Multi-author commits never list individual conversations, only per-author summaries. There is no cap on the number of per-author lines.

**No changes:** If `git add -A` produces no changes, skip the commit entirely. Report: "Nothing to push — all saved conversations are already synced."

The first line is always a readable summary for `git log --oneline`. The `+`/`~`/`-` prefixes echo diff conventions.

### 11.15 Code Changes

#### New code

- `src/interchange/` — shared conversation file-pair and reconciliation module
  - `pairs.ts` — transport-neutral pair discovery, validation, metadata, and safe writing
  - `reconcile.ts` — deterministic git reconciliation planner
  - `fill.ts` — fill collision planner
- `src/sync/` — new module
  - `git.ts` — git command execution (clone, pull, push, rev-parse, status)
  - `push.ts` — push flow (export, commit, push)
  - `pull.ts` — git reconciliation executor
  - `meta.ts` — git-facing wrapper around interchange pair metadata
  - `staleness.ts` — HEAD hash comparison
- `src/cli/remote.ts` — `remote add/show/remove` command handler
- `src/cli/sync.ts` — `sync push/pull` command handler
- `src/cli/refresh.ts` — `refresh` command handler
- `src/cli/fill.ts` — `fill` command handler

#### DB schema changes

- Add `origin_kind` and `origin_ref` to conversations table (see §11.4, migration version 7 per §3.4.1)

#### Config schema changes

- Replace `remote: null` placeholder with structured Zod schema for `remote.url`, `remote.allowPublicRemote`, `remote.visibilityConfirmed`, `remote.lastSyncHead`

#### Existing code changes

- `src/cli/list.ts` — default filter to local rows plus same-author imported rows; add `--all`, `--origin` flags; configured-git team conversation footer
- `src/cli/edit.ts`, `src/cli/tag.ts`, `src/cli/untag.ts`, `src/cli/save.ts`, `src/cli/diff.ts` — refuse imported read-only conversations
- `src/cli/exclude.ts`, `src/cli/unexclude.ts`, `src/cli/remove.ts`, `src/cli/clogignore.ts` — shared ignore-rule model and explicit current-row removal
- `src/sync/pull.ts` — apply the interchange reconciliation plan, check `clogignore` before importing, and best-effort delete vectors for deleted rows
- `src/sync/push.ts` — write pairs through the shared writer and protect same-author saved identities across provenance kinds from retraction
- `src/cli/status.ts` — report configured-git remote info, unindexed count, staleness warning
- `src/mcp/server.ts` and `src/mcp/handlers.ts` — add optional `origin` filter to `clog_list_saved` and `clog_search`; include `source`, `originKind`, and `originRef` metadata
- `src/index.ts` — register new commands (remote, sync, refresh, fill)
- `src/db/index.ts` — add provenance helpers and `originKind` / `originRef` row mapping, inserts, updates, and filters

#### What doesn't change

- Phase 1 local curation workflow for local rows
- Search indexer (`src/search/indexer.ts` — indexes saved conversations regardless of provenance kind)
- Chunker, embedding providers, vector stores

#### Tests

See §13.2 and §13.4 for the interchange and sync test inventory (`interchange.test.ts`, `reconcile.test.ts`, `fill.test.ts`, `sync-meta.test.ts`, `sync-pull.test.ts`, `sync-push.test.ts`, `sync-integration.test.ts`).

---

## 12. Roadmap

**Phase 1 — Local MVP** (§§1-9): A working CLI and MCP server that a single developer can use to discover, curate, and browse their own Claude Code and Codex CLI conversations.

**Phase 2 — Semantic Search** (§10): Natural language search over saved conversations using local embeddings and a vector store.

**Phase 3 — Team Sharing** (§11): Share saved conversations with teammates via a shared git repository.

### Phase 4: Extensions

| Step | Task |
|------|------|
| 4.1 | Provider-backed automatic summarization, if agent-assisted summarization proves insufficient |
| 4.2 | Web UI for browsing the team knowledge base |
| 4.3 | Conversation analytics (what topics are your team asking about most?) |
| 4.4 | Import from exported Claude.ai conversations |
| 4.5 | Improve `clog show` (branch-aware rendering, collapsible tool output, better formatting for long conversations) |
| 4.6 | Cross-developer context handoff — MCP tool that lets an agent load a teammate's saved conversation as reference context in a new session, enabling "pick up where they left off" workflows without writing to source locations |
| 4.7 | Content-aware deduplication of conversations shared by multiple authors |
| 4.8 | Conversation diff functionality beyond new-since-save output |
| 4.9 | Cross-kind promotion from a synced or filled read-only copy to a local editable row |
| 4.10 | Local metadata overlays on imported conversations (local tags, notes) |
| 4.11 | `clog rename-author` automatic cleanup of old remote directory |
| 4.12 | Multi-remote support |
| 4.13 | Automatic retries on push rejection |

---

## 13. Testing

### 13.1 Principles

- **Deterministic and local-only.** No network calls, no time-dependent behavior, no randomness.
- **Never touch real data.** Tests must never read, write, or reference actual `~/.claude` files or any user home directory. All paths and data are programmatically generated fixtures in temp directories.
- **Sandboxed at runtime.** The application layer is configured to point at temp directories via `CLOG_HOME` and per-source `sources.<name>.paths` config values.
- **Source locations are never written to.** This is an application invariant (see Section 4.1), not just a test concern. The app must never write to, modify, or delete files in source locations like `~/.claude/`.

### 13.2 Framework and Structure

**Vitest** for the test runner. Fast, native ESM, built-in coverage.

```
tests/
├── adapter.test.ts          # Discovery parsing + full parsing
├── chunker.test.ts          # Turn-based chunking logic (Phase 2)
├── cli.test.ts              # CLI command unit tests (error handling, output, edge cases)
├── config.test.ts           # Config schema, load/save, defaults, init
├── db.test.ts               # CRUD, state transitions, save fields, project filtering
├── mcp.test.ts              # MCP tool handler tests (list, get, update, browse, search)
├── models.test.ts           # Zod schema validation for conversation and message types
├── scan.test.ts             # Scan pipeline, ignore/config filtering, stale entry pruning
├── plunge.test.ts           # Corruption audit (clog plunge)
├── search.test.ts           # Search integration, conditional on deps (Phase 2)
├── search-coherence.test.ts # Searchability invariants, deindexing, scan-cap behavior (Phase 2)
├── vectra-store.test.ts     # Vectra vector-store backend (Phase 2)
├── summaries.test.ts        # Agent-assisted summarization fields, MCP guides, and lifecycle rules
├── workflow.test.ts         # Multi-step workflows: save → edit → re-save, exclude → remove, etc.
├── interchange.test.ts      # Conversation file-pair discovery, validation, and safe writing
├── reconcile.test.ts        # Shared git reconciliation planner behavior
├── fill.test.ts             # fill import planning and command behavior
├── remote-guards.test.ts    # Read-only guards rejecting imported (git/file) rows
├── save-restored-overwrite.test.ts # Restored-content overwrite confirmation guard
├── sync-meta.test.ts        # .meta.json serialization/deserialization (Phase 3)
├── sync-pull.test.ts        # Reconciliation logic: import, update, delete (Phase 3)
├── sync-push.test.ts        # Commit message generation, export logic (Phase 3)
├── sync-integration.test.ts # End-to-end sync with bare git repos (Phase 3)
├── sync-visibility.test.ts  # Remote URL parsing and repo visibility probe (Phase 3)
├── e2e.test.ts              # End-to-end CLI tests via subprocess
└── helpers/
    └── fixtures.ts          # Small helpers for writing programmatic JSONL fixtures
```

Tests use a flat structure rather than unit/integration subdirectories. Fixtures are generated programmatically rather than checked-in as static JSONL files. This keeps fixtures self-documenting and avoids maintaining separate collections of fixtures as source formats change.

### 13.3 Test Environment Sandboxing

Tests create isolated temp directories with `fs.mkdtemp()`, set `CLOG_HOME` to point at the temp clog home, and clean up with `fs.rm(..., { recursive: true, force: true })` in `afterEach`. Source locations are set through the normal config shape, usually `sources.<name>.paths`, so the test harness uses the same inputs as real commands.

```typescript
let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clog-test-"));
  process.env.CLOG_HOME = tempDir;
});

afterEach(async () => {
  delete process.env.CLOG_HOME;
  await fs.rm(tempDir, { recursive: true, force: true });
});
```

The application code respects `CLOG_HOME` for the data directory. Source locations are controlled by `sources.<name>.paths` in the test config, falling back to built-in defaults only when unset. This is the core contract between the test harness and the application.

### 13.4 Test Coverage

**Adapter tests** (`adapter.test.ts`):

- Claude discovery parsing: correct metadata extraction (title, summary, projectName, projectPath, slug, dates) from the bounded metadata head without reading the full file
- Claude bounded-discovery behavior: malformed JSONL after the discovery line bound is ignored during scan-time discovery, while malformed JSONL encountered before metadata discovery stops warns and skips the file
- Claude full parsing: correct message normalization, deduplication by `message.id`, parser-derived ordering
- Claude discovery uses the first `cwd` for `projectPath` and derives `projectName` from that path; later `cwd` changes do not overwrite project identity
- Graceful handling of empty / no-message JSONL files
- Codex path normalization: configured Codex home scans `<home>/sessions/**/*.jsonl`; configured sessions directory scans `<sessionsDir>/**/*.jsonl`; missing derived sessions directory warns and skips
- Codex discovery parsing: `session_meta` ID, filename fallback, title precedence, fallback finality, cwd/projectPath fallback, derived projectName, empty summary, null slug
- Codex bounded-discovery behavior: discovery stops when primary metadata and title are complete, malformed JSONL after discovery stops is ignored during scan-time discovery, and malformed JSONL encountered while metadata discovery is still in progress warns and skips the file
- Codex full parsing: canonical user/assistant messages, user-message deduplication, tool correlation by `call_id`, `exec_command_end` fallback, telemetry omission, parser-derived ordering
- Malformed Codex files: missing session ID plus invalid filename, filename/content ID mismatch warning, missing projectPath / cwd fails closed with `path_filter_without_project` warning (`project path missing: these conversation files have no cwd metadata`) regardless of configured path filters

**CLI tests** (`cli.test.ts`):

- Unit tests for individual CLI command handlers
- Error handling: correct error messages, exit codes, actionable suggestions
- Edge cases: missing IDs, ambiguous prefixes, invalid arguments
- Output formatting and content verification

**DB tests** (`db.test.ts`):

- Schema creation succeeds and is idempotent
- CRUD operations for conversation metadata
- State transitions (unsaved → saved, saved resave behavior)
- Save fields written and cleared correctly
- ID prefix resolution (min 4 chars, ambiguity detection)
- Source-qualified ID resolution (`prefix@source`) and ambiguity errors with copy-pasteable candidates
- Browse distinct tags/projects/authors
- Project filtering by projectName with case-insensitive matching
- `saved_message_count` persistence and modified-since-save queries

**MCP tests** (`mcp.test.ts`):

- Tool handler tests for `clog_list_saved`, `clog_get`, `clog_update`, `clog_browse`, `clog_search`, `clog_summarization_guide`, and `clog_analysis_suggestions`
- Input validation and error responses
- Filter behavior (tags, project, author, grep)
- `source`, `summaryKind`, `extraction`, `originKind`, and `originRef` metadata in list/get/search payloads
- Structured scan warnings surfaced as top-level `warnings`

**Summaries tests** (`summaries.test.ts`):

- Schema v5 migration and round-trip persistence for `summaryKind` and `summaryExtraction`
- MCP `clog_update` summary-kind rules, including generated defaults, curated overrides, clearing behavior, and extraction-only edits
- `clog edit --summary` curation behavior
- Unsummarized predicate used by `clog talk` and the post-save hint
- Bundled summarization guide and analysis suggestions tool payloads

**Search coherence tests** (`search-coherence.test.ts`):

- Deindexing behavior: per-conversation delete failures warn and continue
- Search-not-configured vs dependency-failure warning behavior during deindex initialization
- Searchability invariant (`saved` + non-null `saved_at` + fresh `indexed_at >= saved_at`)
- Expanding search window behavior and the 5,000-result scan-cap warning

**Models tests** (`models.test.ts`):

- Zod schema validation for `ConversationMeta` and `Message` types
- Summary kind, outcome, and extraction schema validation
- Required vs optional field handling
- Edge cases in schema parsing (missing fields, extra fields, type coercion)

**Config tests** (`config.test.ts`):

- Zod schema defaults and validation
- Config load/save round-trip
- Missing config file falls back to defaults
- Init flow (first-run setup, idempotent re-init)
- Built-in source defaults for Claude Code and Codex CLI
- `CLOG_HOME` data-dir override
- Per-source path overrides through config
- No environment-variable source-path override is recognized

**Scan tests** (`scan.test.ts`):

- 2-layer path/privacy filter pipeline (`clogignore` → config) plus undiscoverable handling
- `source_mtime` comparison avoids database rewrites for unchanged rows after adapter discovery
- New conversation discovery
- Stale entry pruning when source files disappear
- Source path updates when files move between directories
- Discovery across all enabled built-in adapters
- Per-source pruning isolation
- Fail-closed path filtering when projectPath is unavailable within the discovery line bound
- Aggregated malformed-file warnings for malformed JSONL encountered during metadata discovery

**Workflow tests** (`workflow.test.ts`):

- Multi-step flows: save → edit → re-save, exclude → unexclude, exclude → remove
- Saved refresh flows: source grows after save → explicit `clog save <id>` refreshes the raw copy and resaves; bare `clog save` does not refresh changed source content without a selector
- Literal ignore-rule handling: exact-line append/remove semantics, `project:<name>` rejection on ignore-rule commands, and `clog remove` deleting current DB rows without editing `clogignore`
- State transitions through `withDb`

**Interchange tests** (`interchange.test.ts`):

- Complete conversation file-pair round-trip
- Union scanning of metadata-only and JSONL-only stems
- Deterministic nested scan order
- Same pair discovered in flat, nested, and git-style trees
- Filename stem versus `meta.id` mismatch emits `pair_id_mismatch` and names both values
- Pair writing routes both files through the atomic writer and installs metadata last

**Reconcile tests** (`reconcile.test.ts`):

- Exact git kind/ref scope and deletion enablement
- Out-of-scope owner collisions with local unsaved, local saved, file, and other-git rows
- Deterministic duplicate winner for git checkout duplicates
- Ignore-rule gating and ignored valid pairs protecting in-scope rows from deletion
- Incomplete or invalid pair identities protecting deletion by every credible `(source, id)`
- Deleted row IDs returned in the plan

**Fill tests** (`fill.test.ts`):

- Usage and exit-code branches, including `--dry-run` and `--allow-partial`
- Metadata-only and JSONL-only input warnings
- Duplicate input identities rejected with `pair_duplicate_identity`
- Default fail-before-writes behavior for validation failures, duplicate identities, unsupported promotions, and git-row collisions
- `--own` author guard, unsaved-row restore, and full collision matrix
- Filled rows stored as clean saved artifacts under `imports/<source>/<id>.jsonl`
- File-row metadata-only and content updates, including `indexedAt` preservation/clearing rules
- Removal of file-import managed content and restored-local only-copy warning
- Drain-to-fill workflow coverage for foreign fill and `--own` restore

**Sync meta tests** (`sync-meta.test.ts`, Phase 3):

- `.meta.json` Zod schema validation
- Read/write round-trip for meta files
- Conversion from meta format to `ConversationMeta`
- `summaryKind` and `summaryExtraction` serialization plus backward-compatible defaults for older meta files
- `.meta.json` does not contain `savedMessageCount`

**Sync pull tests** (`sync-pull.test.ts`, Phase 3):

- Reconciliation executor: insert new, update changed, delete only cleanly absent in-scope git rows, and preserve existing DB rows for orphaned or invalid pairs
- Git conversations skipped when `clogignore` matches by ID or project name
- Out-of-scope owners block git insert without uniqueness errors
- Source-separated remote layout scanning
- Git identity keyed by `(source, id)`, not `id` alone
- Deterministic git duplicate resolution by author/source/id order
- Unsupported source directories warn and skip without deletion
- Path/metadata mismatch for source or id warns and skips
- Git import derives local `savedMessageCount` from parsed `Message[]` length
- Reconciliation deletion best-effort deletes vectors

**Sync push tests** (`sync-push.test.ts`, Phase 3):

- Commit message generation (single-author, multi-author, ≤10 and >10 changes)
- Export logic for local saved conversations
- Source-separated remote layout export and retraction
- Lightest-necessary-touch behavior: unrelated files, unknown source dirs, orphaned files, and empty dirs are not proactively removed
- Shared pair writer use (`jsonl` first, metadata last)
- Same-author file rows preventing push retraction

**Sync integration tests** (`sync-integration.test.ts`, Phase 3):

- End-to-end push/pull cycles against bare git repos
- Conditional on git availability

**E2E tests** (`e2e.test.ts`):

- Full CLI subprocess tests via `npx tsx src/index.ts`
- Complete workflow: status → save → edit → tag → save → show
- Exclude/unexclude round-trip
- Config get/set
- Drain pair → foreign fill → show/list/drain round trip
- Drain pair → `fill --own` → editable local workflow

### 13.5 Fixture Generation

Fixtures are generated programmatically. `tests/helpers/fixtures.ts` provides `writeJsonl()`, a small helper that writes JSONL files from in-test objects. Individual test files build the specific conversation shapes they need, such as user messages, assistant messages with tool use, summaries, malformed records, or remote sync metadata. This approach is preferred over static fixture files because fixtures stay self-documenting and in sync with schema changes.

### 13.6 Linting

ESLint with `typescript-eslint` enforces two type-aware rules:

- **`@typescript-eslint/no-unused-vars`** — catches dead imports and variables. Uses `^_` ignore patterns for intentional underscores.
- **`@typescript-eslint/no-floating-promises`** — catches unhandled async calls (promises that are neither awaited nor returned).

Linting covers both `src/` and `tests/`. A separate `tsconfig.eslint.json` extends the base `tsconfig.json` to include test files (which are excluded from compilation).

Linting is not gated by `npm test` — it's a separate `npm run lint` step. This keeps the test cycle fast and avoids blocking on style issues.

### 13.7 npm Scripts

`package.json` is the authoritative source for npm scripts. The commonly used verification commands are `npm test`, `npm run lint`, and `npm run build`; `npm run build` also performs any post-compile binary setup needed by the CLI.
