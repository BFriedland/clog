# Source Conversation Formats

**Status: Observed reference.** This document describes the on-disk
conversation formats of the coding-agent tools clog reads — Claude Code and
Codex CLI. These formats are undocumented by their upstream tools and were
reverse-engineered from real session logs. Upstream tools can change their
layouts at any time without notice, so each section carries an *as observed*
date. Treat this as a field guide, not a contract: clog's adapters
(`src/adapters/claude-code.ts`, `src/adapters/codex-cli.ts`) are the working
implementation, and the tests exercise the behavior described here.

The formats clog itself owns (its data directory, the portable conversation
pair, the team repo) are in [FORMATS.md](FORMATS.md).

Three concepts recur throughout:

- **Discovery** is a lightweight metadata pass that reads only a bounded head
  of each source file (the first `SCAN_METADATA_MAX_LINES` lines, currently
  100) to extract title, summary, project, dates, and slug. Anything appearing
  only past that bound is treated as absent during discovery.
- **Full parse** reads the entire file and projects it into clog's canonical
  `Message[]` shape. The projection is intentionally lossy — the raw JSONL
  remains the source of truth for full detail.
- **Relationship inspection** examines a source file for evidence that it
  branched from another session (an edited prompt, an explicit branch or fork
  command) and records the parent by source-native ID. The result travels in
  the `relationshipInspection`/`relationships` fields of pair metadata
  ([FORMATS.md §3.2](FORMATS.md#32-metajson-schema)).

---

## Claude Code

*As observed: 2026-07 (Claude Code 2.1.x-era logs).*

Claude Code stores conversations in `~/.claude/projects/` as JSONL files, one
JSON object per line, one conversation per file. The directory name encodes the
project path using the lossy encoding in [FORMATS.md §1](FORMATS.md#1-lossy-path-encoding);
it must not be decoded back into a path.

```
~/.claude/projects/
├── -Users-alice-myproject/
│   ├── c7044ea5-c019-44d6-a77a-500036740f9a.jsonl   # one conversation per file
│   ├── c7044ea5-c019-44d6-a77a-500036740f9a/
│   │   └── subagents/
│   │       ├── agent-aprompt_suggestion-*.jsonl     # UI prompt suggestions (skip)
│   │       └── agent-a<id>.jsonl                     # Task subagent sidechains (skip)
│   └── 123e4567-e89b-12d3-a456-426614174000.jsonl
└── -Users-alice-other-repo/
    └── 550e8400-e29b-41d4-a716-446655440000.jsonl
```

The filename without `.jsonl` is a UUID that serves as the `sessionId` /
`sourceId` / conversation `id`. One file holds one *resumable session*, and a
session file is not a linear log: records form a tree via `parentUuid`, and a
file can retain several divergent paths after the user rewinds to an earlier
point and continues differently. Only one path is the session's current
transcript (see Full-parse behavior).

### Subagent conversations

A main conversation may have a `<sessionId>/subagents/` directory of subagent
(Task tool) JSONL files, all with `isSidechain: true`:

- **`agent-aprompt_suggestion-*.jsonl`** — internal UI prompt suggestions with
  no meaningful content. Skipped entirely.
- **`agent-a<hex-id>.jsonl`** — Task subagent conversations (Explore, Bash
  agents, etc.). These are auxiliary sidechain logs. clog does not treat them
  as separate conversations and does not parse their content into the parent.

The parent conversation is the only first-class clog unit. Any user-visible
evidence of delegated work must come from records in the parent file itself,
not from sidechain logs.

### Line types

Each line has a `type` field:

| `type` | Purpose | Used by clog? |
|--------|---------|---------------|
| `user` | Human message or tool result | Yes — primary content |
| `assistant` | Model response (text, tool_use, thinking) | Yes — primary content |
| `summary` | Claude Code's own conversation summary | Yes — default summary |
| `system` | Operational entries (has a `subtype`, e.g. `turn_duration`) | Ancestry only — `compact_boundary` records join the message graph (see Compaction); none emit messages |
| `attachment` | Attached file/content records | Ancestry only — no messages |
| `progress` | Real-time progress (hook events, agent spawning) | No — transparent for ancestry, never content |
| `file-history-snapshot` | File backup tracking for undo | No — skip |
| `queue-operation` | Background task queue events | No — skip |
| `last-prompt`, `ai-title`, `mode`, `permission-mode` | Editor/UI metadata | No — skip (`last-prompt.leafUuid` is advisory only) |

Common fields that may appear on any line: `uuid`, `parentUuid` (forms a tree,
not a flat list), `sessionId`, `timestamp` (ISO 8601), `isSidechain`, `cwd`,
`version`, `slug`, `userType` (always `"external"` observed), `gitBranch`.
User records may also carry `isMeta` (non-conversational) and
`isCompactSummary` (see Compaction); records copied into a branched session
carry `forkedFrom` (see Rewinds, branches, and forks).

### User messages (`type: "user"`)

Two variants, distinguished by the shape of `message.content`:

- **Human-typed message** — `message.content` is a **string**. May carry
  optional `todos` and `permissionMode` fields (ignored).
- **Tool result** — `message.content` is an **array** containing `tool_result`
  blocks (`{ type: "tool_result", tool_use_id, content }`). May carry
  `toolUseResult` (structured metadata) and `sourceToolAssistantUUID` (links
  back to the assistant tool call).

### Assistant messages (`type: "assistant"`)

`message.content` is an array of content blocks:

```typescript
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown>; caller?: { type: string } };
```

**Streaming split:** multiple assistant lines may share the same
`message.id` — Claude Code writes a new line as each content block streams in,
so one model response (one API call) can produce 3–5 lines. Deduplicate by
`message.id`: collect all content blocks from lines sharing an ID into one
logical message.

### Summary lines (`type: "summary"`)

```typescript
{ type: "summary", summary: string, leafUuid: string }
```

Only longer conversations get an auto-generated summary line, and it appears at
or near the end of the file — often past the discovery bound, in which case it
is absent from discovery-time metadata. A file has at most one. When found
in-bound during discovery, it becomes the default `summary` with
`summaryKind = "imported"`.

### Rewinds, branches, and forks

*As observed: Claude Code 2.1.206.*

Three user actions produce divergent history, and each persists differently:

- **Rewind in place.** Rewinding to an earlier message and continuing stays
  inside the same session file: the continuation records name the earlier
  record as `parentUuid`, so the file retains both the abandoned path and the
  new one. No new file and no cross-session relationship is created.
- **`/branch`.** Creates a *new* session file whose head is a copied prefix of
  the parent session's history. Every copied record carries a `forkedFrom`
  object — `forkedFrom.sessionId` names the parent session and
  `forkedFrom.messageUuid` equals the record's own retained `uuid`. clog
  records the parent relationship with `evidence: "source"`; all `forkedFrom`
  records in one file must agree on a single parent. The first record *after*
  the copied prefix marks when the branch was created.
- **`--fork-session`** (via `--resume <id> --fork-session` or
  `--continue --fork-session`). Also creates a new session file with copied
  history, but writes **no `forkedFrom` records at all**. The only in-file
  signal is incidental: copied records retain the writing ancestor's session
  ID in a snake_case `session_id` field, which differs from the new file's
  filename UUID. clog records that parent with `evidence: "inferred"`.

### Compaction

A `system` record with `subtype: "compact_boundary"` marks a context
compaction. It participates in message ancestry and carries a
`logicalParentUuid` naming the final pre-compaction record; a user record with
`isCompactSummary: true` carries the replacement summary text Claude Code
sends to the model afterward. When the logical parent resolves in the same
file, clog follows it to present the real pre-compaction history and omits the
compact summary (the summary describes replacement model context, not the
conversation people had). A branched child file can copy only the
post-compaction path; when the logical parent is absent, the compact summary
is projected as a user message because it is the only persisted
representation of the inherited prefix. Compaction never creates a clog
conversation relationship.

### Discovery behavior

Reading only the bounded head, the adapter:

1. Globs `~/.claude/projects/*/*.jsonl` for main conversations (direct children
   of project dirs); ignores `*/*/subagents/` files.
2. Sets `projectPath` from the **first** `cwd` in the file. A conversation may
   record multiple `cwd` values as the agent moves into subdirectories; the
   first is authoritative because it best represents where Claude Code started.
   Later `cwd` values must not overwrite it.
3. Takes the first projected canonical user message (a `type: "user"` line
   whose `message.content` is a string, after skipping wrapper-only strings —
   see below) as the title, truncated to 100 characters with no ellipsis.
4. Takes the `summary` line if present; the `slug` field from any line that has
   it; the basename of `projectPath` as `projectName`.
5. Sets `createdAt` from the first `timestamp` — except in a branched or
   forked session, where the copied prefix predates the session itself.
   There, `createdAt` is the timestamp of the first record after the copied
   prefix (source branches) or the first record following the inferred copy
   boundary (forked sessions), falling back to file mtime.
6. Stops early once all metadata is found, otherwise at the discovery bound
   (relationship inspection continues past the bound when needed).

A missing in-bound `cwd` leaves `projectPath` unknown, and the conversation is
reported as undiscoverable rather than inserted — project path is clog's
primary privacy boundary (see DESIGN.md), so a projectless conversation fails
closed.

### Full-parse behavior

Because a session file can retain several divergent paths, the adapter
projects the session's *current path*, not the whole file. In outline:

1. Read the entire parent file only; never inline `subagents/` sidechain
   content.
2. Build the message graph from UUID-bearing `user`, `assistant`,
   `attachment`, and `system` records linked by `parentUuid`. `progress`
   records are transparent: a parent link naming one resolves through to the
   nearest non-progress ancestor.
3. Select the current leaf: among conversation-bearing records with no
   conversation-bearing descendant, take the latest by timestamp, breaking
   ties by file position. `last-prompt.leafUuid` is advisory and never
   overrides this order.
4. Walk `parentUuid` ancestry from that leaf back to the root, in
   root-to-leaf order; abandoned rewind paths are excluded.
5. Recompose split responses: one assistant API response can persist as
   several assistant records sharing one `message.id`, and concurrent tool
   calls can leave tool-result records as *siblings* of the active path
   (linked back via `tool_use_id` and `sourceToolAssistantUUID`). Fragments
   and results belonging to an active response are recovered and ordered
   with it.
6. Follow compaction boundaries' `logicalParentUuid` edges (see Compaction
   above).
7. Normalize the composed records into canonical `Message[]`:
   - visible user text → `role: "user"`
   - assistant `text` block → `role: "assistant"`; `thinking` blocks dropped
   - assistant `tool_use` block → `role: "tool_use"` with `toolName`/`toolInput`
   - user `tool_result` block → `role: "tool_result"` with a compact status
     summary (e.g. `"Read: ok"`, `"Bash: error"`); the bulk tool output is
     stripped, and `is_error` determines the status
   - confirmed hidden wrapper records → dropped

Malformed graphs degrade conservatively: the adapter returns the coherent
suffix after a missing parent, excludes duplicate-UUID, cyclic, or
identity-less records with structured warnings, and never falls back to
concatenating every visible record in file order. The exception is a *legacy*
file with no usable ancestry at all, which is projected in source order with
a warning.

**Hidden-wrapper filter.** A user-string record is *wrapper-only* when its
trimmed text consists entirely of one or more known hidden wrapper blocks and
nothing else user-visible; such records are dropped. The allowlist is
deliberately narrow: unknown XML-like tags are **not** treated as hidden, and
known user-visible local-command/status wrappers stay in the transcript. The
only confirmed hidden Claude wrapper block name is `local-command-caveat`.

**Edge cases the adapter handles:** files with only
`file-history-snapshot` lines (treated as empty); lines missing `sessionId`
(use the filename UUID); `message.content` as either string or array; large
files with heavy `progress` noise (filtered early).

---

## Codex CLI

*As observed: 2026-07 (Codex CLI rollout logs).*

Codex CLI stores sessions as event-log JSONL files under `~/.codex/sessions/`:

```
~/.codex/sessions/
└── YYYY/MM/DD/
    └── rollout-<timestamp>-<sessionId>.jsonl
```

The Codex home defaults to `~/.codex/` (resolved via the user home directory
on every platform). A configured Codex path may point either at a Codex home
directory (any name/location) or directly at a `sessions` directory.
Normalization is deterministic:

1. Expand `~` and normalize the path.
2. If the basename is `sessions`, treat the path as the sessions directory.
3. Otherwise treat it as a Codex home and use `<configured>/sessions`.
4. If the derived sessions directory is missing or unreadable, warn and skip.
5. Glob `<sessionsDir>/**/*.jsonl`.

The adapter never appends `sessions/` to a path that already names it. Only
files whose basename matches `rollout-*.jsonl` are candidate conversations;
other JSONL files (`history.jsonl`, logs, state) are skipped silently without
malformed-file warnings. Malformed-file warnings apply only to rollout
candidates.

### Line types

Each line has a top-level `type`:

| `type` | Purpose | Used by clog? |
|--------|---------|---------------|
| `session_meta` | Stable session metadata (id, timestamp, cwd, version, provider) | Yes — discovery |
| `turn_context` | Turn-scoped context (cwd, date, timezone, sandbox, model) | Fallback only |
| `response_item` | Canonical transcript items, tool calls, tool outputs | Yes |
| `event_msg` | Operational events, user-message duplicates, token counts, command-end metadata | Selective |

Important payload shapes:

- `session_meta.payload.id` — canonical Codex session ID.
- `session_meta.payload.cwd` — primary `projectPath`.
- `session_meta.payload.forked_from_id` — when present, the session whose
  history this session copied (see Branching below).
- `session_meta.payload.thread_source` — what created the session; observed
  values include `"user"`, `"subagent"`, and `"memory_consolidation"`.
- `session_meta.payload.cli_version` — the writing Codex CLI version.
- `response_item.payload.type == "message"` — `payload.role` identifies the
  role; `payload.content` is an ordered array of blocks. User text is in
  `{ type: "input_text", text }` blocks; assistant text in
  `{ type: "output_text", text }` blocks. `role: "developer"` records are
  instruction/context material, not transcript.
- `response_item.payload.type == "function_call"` — tool name in `payload.name`,
  args in `payload.arguments`, correlation key in `payload.call_id`.
- `response_item.payload.type == "function_call_output"` — correlation key in
  `payload.call_id`, rendered output in `payload.output` when it is a string.
- `response_item.payload.type == "reasoning"` — internal reasoning, not
  transcript.
- `event_msg.payload.type == "user_message"` — may duplicate the user prompt;
  fallback text in `payload.message` when it is a string.
- `event_msg.payload.type == "agent_message"` — operational progress, not
  transcript.
- `event_msg.payload.type == "exec_command_end"` — command status keyed by
  `payload.call_id`; observed fields: `exit_code`, `status`, `stdout`,
  `stderr`, `aggregated_output`, `formatted_output`.

### Branching (edited prompts)

*As observed: Codex CLI 0.145.0.*

Editing an earlier prompt makes Codex CLI create a **new session file**: the
child retains a copied prefix of the source history and names its immediate
source in `session_meta.payload.forked_from_id`. That field alone is not
proof of a user branch — Codex also writes it for copied-history subagent
threads and memory-consolidation sessions. clog records a source-confirmed
branch relationship only when `forked_from_id` is a valid UUID different from
the session's own ID **and** `thread_source` is `"user"`. A `"subagent"` or
`"memory_consolidation"` provenance is not a branch, and any other
provenance combined with a `forked_from_id` is recorded as unknown rather
than guessed.

The adapter must not assume `session_meta` is the first line, even though it
commonly is. Within the bounded scan:

1. Normalize configured paths and glob rollout candidates.
2. One `rollout-*.jsonl` = one conversation.
3. Use `session_meta.payload.id` as `sourceId` when UUID-shaped.
4. Otherwise derive a fallback ID from the filename only when it matches
   `rollout-<timestamp>-<sessionId>.jsonl` and ends with a UUID-shaped suffix
   (match the UUID before `.jsonl`, don't naively split on `-`).
5. If an embedded ID was present but malformed, warn. If both embedded and
   filename IDs are valid but differ, use the embedded ID and warn. If neither
   yields a valid UUID, report malformed and skip.
6. Use `session_meta.payload.cwd` as `projectPath`, falling back to the first
   valid `turn_context.payload.cwd` in-bound; derive `projectName` from it.
7. Title from the earliest human prompt in source order, truncated to 100
   characters. When that prompt has both a canonical
   `response_item.message(role="user")` and an `event_msg.user_message`
   duplicate, prefer the `event_msg.user_message` text as the cleaner
   rendering; otherwise fall back to the canonical text after skipping
   wrapper-only messages. If no usable prompt exists, use `"(untitled)"`.
8. `summary` is always the empty string; `slug` is always `null`; `summaryKind`
   is `none`. The observed Codex format exposes no trusted native summary/slug,
   and clog does not synthesize one.
9. `createdAt` from `session_meta.payload.timestamp`, falling back to the first
   valid top-level timestamp in-bound, then file mtime.

A fallback candidate (filename-derived ID, top-level timestamp,
`turn_context.cwd`) becomes final only after the matching primary
`session_meta.payload.*` value is found in-bound, or after the discovery bound
is reached without it.

As with Claude Code, if `projectPath` cannot be determined the conversation
fails closed: it is skipped and aggregated into a `path_filter_without_project`
warning (`project path missing: these conversation files have no cwd
metadata`), even when no path filters are configured. Discovery filtering
operates on the detected `projectPath`, not the `~/.codex/sessions/...` storage
path.

**Codex wrapper-only titles.** A canonical user message is wrapper-only when
its trimmed extracted text consists entirely of known context wrapper blocks
with no other prose. The known block names are `environment_context` and
`user_shell_command`; the allowlist is deliberately narrow.

### Full-parse behavior

1. Read the whole file.
2. Preserve top-level source-file order after projection, except where the
   tool-correlation rules suppress duplicate fallbacks.
3. Emit user prompts from canonical `response_item.message(role="user")` via
   `input_text` blocks; assistant prose from `role="assistant"` via
   `output_text` blocks.
4. Emit tool uses from `response_item.function_call`.
5. Emit compact tool results from `response_item.function_call_output`,
   correlated by `call_id`, at the output record's position.
6. Emit fallback user prompts from `event_msg.user_message` only when the
   nearby-dedup rule finds no matching canonical user message.
7. Use `event_msg.exec_command_end` as a fallback tool result only when no
   `function_call_output` exists anywhere for the same `call_id`.
8. Drop `response_item.message` with other roles (including `developer`), plus
   `session_meta`, `turn_context`, `token_count`, `agent_message`, and
   `reasoning`.

**Text extraction.** Process `payload.content` in array order, concatenating
matching `input_text` (user) or `output_text` (assistant) blocks joined by a
blank line. If no matching blocks are present, emit no message. Unknown block
types are ignored.

**Hidden prelude stripping (canonical user messages).** Strip a leading hidden
prelude before deciding whether to emit: an optional
`# AGENTS.md instructions for …` header followed by an
`<INSTRUCTIONS>…</INSTRUCTIONS>` block, then zero or more leading known wrapper
blocks (`environment_context`, `user_shell_command`). Emit whatever user text
remains; if nothing remains, emit no canonical user message. This keeps
agent-only setup and environment scaffolding out of the projected transcript
while the raw JSONL retains it.

**User-message deduplication.** `event_msg.user_message` is an event-bus copy
of a human prompt and is a fallback source only. Do not emit it when a nearby
canonical `response_item.message(role="user")` has the same normalized text
(CRLF→LF, trimmed). "Nearby" means the same top-level timestamp or adjacency
after ignoring non-transcript records. Canonical user messages are never
deduplicated against each other, and branch structure is never inferred from
duplicate text alone. For adjacency, the ignored records are exactly
`session_meta`, `turn_context`, `event_msg.token_count`, dropped `reasoning`,
dropped `response_item.message` records, and other fully-dropped records;
`function_call`, `function_call_output`, and `exec_command_end` are **not**
ignored for adjacency.

**Timestamps.** Each emitted message's `timestamp` comes from the top-level
timestamp of the record that emitted it, or `null` if that record has none.
Borrowing a tool name or status from a correlated record does not change the
emitted result's timestamp.

### Tool correlation

Codex tool calls are correlated by `call_id`:

- `function_call` registers name + arguments and emits a `tool_use`.
- `function_call_output` is the canonical result record and emits the preferred
  `tool_result` at its own position.
- `exec_command_end` records command status and can provide a fallback result
  for the same `call_id`.
- If both output forms exist for a `call_id`, only the `function_call_output`
  result is emitted; the `exec_command_end` status may still refine the summary.
- Multiple `function_call_output` for one `call_id`: use the first valid,
  ignore the rest. Multiple `exec_command_end`: use the last valid in source
  order.
- A result with no matching call still emits a compact `tool_result` with
  unknown tool metadata rather than being dropped.

Because a `function_call_output` summary may borrow status from an
`exec_command_end` elsewhere in the file, the adapter collects tool records by
`call_id` before projection (or does an equivalent two-pass parse).

**Compact content.** Tool use renders `<toolName>: <summarized arguments>`
(preserve parsed `toolInput` when arguments are valid JSON; otherwise keep the
raw string in the summary). Tool results are status-oriented and never inline
bulk output — observed `exec_command_end` payloads carry multi-KB
`aggregated_output`/`formatted_output` strings, which clog uses only to detect
whether output is *present*. The rendered summaries follow a fixed decision
table over exit code, status string, and output presence, producing forms like
`<toolName>: output`, `<toolName>: completed`, `<toolName>: exit <code>`, or
`<toolName>: <status>` (falling back to `tool` / `exec_command` when the name
is unknown). Raw command output stays in the source JSONL and is never copied
into message content.
