# clog Formats

**Status: Normative.** The implementation conforms to this document. Other
tools and teammates' machines depend on the rules here: changes to this
document are format changes and need corresponding code, tests, and an entry
in the changelog at the bottom.

This document covers the four format surfaces clog owns or depends on:

1. the lossy path encoding used by source directory names
2. the `~/.clog` data directory layout
3. the portable conversation file pair (and the archive form of it)
4. the team git repository layout

How to *use* clog is README territory. Why these formats look the way they do
is [DESIGN.md](DESIGN.md) territory. The on-disk formats of the source tools
clog reads (Claude Code, Codex CLI) are documented in
[SOURCE_FORMATS.md](SOURCE_FORMATS.md).

## 1. Lossy path encoding

Claude Code names its per-project conversation directories with an encoded
form of the project's working directory path. The encoding rule is:

1. Replace every `/` and `\` with `-`.
2. Replace every remaining character that is not ASCII alphanumeric
   (`[A-Za-z0-9]`) or `-` with `-`.

Case is preserved, hyphens are not collapsed, and leading/trailing hyphens are
kept:

| Path | Encoded |
|---|---|
| `/Users/alice/myproject` | `-Users-alice-myproject` |
| `C:\Users\alice\myproject` | `C--Users-alice-myproject` |
| `\\server\share\proj\` | `--server-share-proj-` |

The encoding is **lossy**: many distinct paths map to the same encoded name,
and the original path cannot be recovered from it. The normative consequence
for clog and for anything reading clog's data:

> `projectPath` and `projectName` must come from real working-directory
> metadata inside the conversation data (Claude Code `cwd` fields, Codex CLI
> `session_meta.payload.cwd`). They must never be decoded from an encoded
> directory name.

## 2. The `~/.clog` data directory

All clog-managed state lives in one directory, `~/.clog` by default
(`%USERPROFILE%\.clog` on Windows, resolved via `os.homedir()`). The
`CLOG_HOME` environment variable overrides the location on all platforms;
`~` is expanded and the value is normalized to an absolute path. clog never
writes to source locations such as `~/.claude/` or `~/.codex/`.

```
~/.clog/
├── clog.db                  # SQLite database — metadata only, no transcript content
├── clog.db.lock             # Advisory cross-process lockfile for database access
├── config.json              # User configuration (JSON)
├── clogignore               # User-edited ignore rules, plain text
├── raw/                     # Content copies created by explicit local saves
│   └── <source>/
│       └── <id>.jsonl
├── imports/                 # Managed content copies created by default `clog fill`
│   └── <source>/
│       └── <id>.jsonl
├── remote/                  # Standard git working tree: clone of the team repo (§4)
│   ├── .git/
│   └── <author>/<source>/<id>.{jsonl,meta.json}
├── vectors/                 # Optional semantic-search vector store data
└── search-runtime/          # Optional clog-owned npm prefix for search packages
    └── models/              # Embedding-model cache
```

Notes on individual entries:

- **`clog.db`** stores conversation metadata and state only. Full transcript
  content always lives in JSONL files; the database is an index over them and
  is regenerable in principle.
- **`clog.db.lock`** serializes database access across the CLI and MCP server
  processes. The lock is advisory (not OS-enforced); every clog process
  respects it.
- **`raw/<source>/<id>.jsonl`** is the curated copy created when a
  conversation is saved locally (including `clog fill --own` restores). It
  preserves the exact bytes of the source file at save time. Source
  subdirectories are created lazily on first write and are not removed when
  they become empty.
- **`imports/<source>/<id>.jsonl`** is the managed copy for read-only file
  imports created by default `clog fill`.
- **`remote/`** is a standard git checkout of the configured team repository.
  Users may run git commands in it directly; `clog sync pull` or
  `clog refresh` reconciles afterward.
- **`vectors/` and `search-runtime/`** exist only when the user opts into
  semantic search. `search-runtime/` is an npm prefix owned by clog; search
  packages are installed there, never into the user's global or project
  Node.js environment.
- **`<source>`** path segments are source keys (§3.2), which are constrained
  so they are always safe cross-platform path components.

### 2.1 Content-path resolution

Every conversation row resolves to exactly one content path:

- **Unsaved local conversations** read from `sourcePath` — the original file
  in the source tool's directory (read-only).
- **Saved conversations** read from `filePath`:
  - locally saved rows → `raw/<source>/<id>.jsonl`
  - git-imported rows → `remote/<author>/<source>/<id>.jsonl`
  - file-imported rows → `imports/<source>/<id>.jsonl`

There is no special branch for file-imported rows; all saved rows follow the
same `filePath` rule.

## 3. Portable conversation file pairs

The conversation file pair is clog's transport-neutral interchange unit. Git
sync, archive export/import (`clog drain` / `clog fill`), and pair-directory
export all use the same serialization:

```
<id>.jsonl        # exact bytes of the conversation's stored content
<id>.meta.json    # conversation metadata (schema below)
```

The JSONL file is byte-preserved: export copies the exact bytes at the
conversation's resolved content path, and import stores them unmodified. clog
never rewrites transcript content in transit.

### 3.1 Pair discovery

Pair discovery walks an input directory and every subdirectory, looking only
at files whose names end in `.meta.json` or `.jsonl`. Two files form a
candidate pair when they are in the same directory and share the same filename
stem (the name before the suffix). A one-file candidate is still reported so
validation can flag it as `pair_incomplete` — an incomplete pair is never
silently dropped.

Results are ordered by the normalized relative path (forward-slash separators)
using raw code-point comparison, so pair processing order does not depend on
filesystem or locale ordering.

### 3.2 `.meta.json` schema

The metadata file is a UTF-8 JSON object. clog writes it pretty-printed with
two-space indentation and a trailing newline; readers must accept any valid
JSON encoding of the schema.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Conversation ID from the source (a UUID for the built-in sources). Must equal the filename stem of both pair files |
| `title` | string | yes | Curated or auto-generated title |
| `summary` | string | yes | Prose summary; may be empty |
| `summaryKind` | `"none"` \| `"imported"` \| `"generated"` \| `"curated"` | no | Who or what produced the prose summary. When absent: `curated` if `summary` is non-blank, otherwise `none` |
| `summaryExtraction` | object \| null | no | Structured summary fields (`topics`, `outcome`, `toolsUsed`, `notableMoments`). When absent: `null` |
| `tags` | string[] | yes | Curated tags |
| `author` | string (non-empty) | yes | Who curated the conversation |
| `projectName` | string \| null | yes | Display project name. Pair metadata never includes local project paths |
| `savedAt` | ISO timestamp | yes | When the conversation was saved to clog |
| `modifiedAt` | ISO timestamp | yes | Last metadata edit or content-change marker |
| `source` | string | yes | Source key (see below) |
| `createdAt` | ISO timestamp | yes | When the conversation started (source chronology) |
| `slug` | string \| null | yes | Source-native human-readable name, if any |
| `relationshipInspection` | object | no | Branch-relationship inspection state (see below). Present iff `relationships` is present |
| `relationships` | array | no | Branch relationships to other conversations (see below). Present iff `relationshipInspection` is present |

**Timestamps** must be full ISO 8601 date-times of the shape
`YYYY-MM-DDTHH:mm:ss[.sss](Z|±HH:MM|±HHMM)`. Date-only or looser forms are
rejected so field-based change detection is never fed ambiguous values.

**Source keys** are interchange identifiers and path segments, not display
names. They are lowercase ASCII strings matching
`^(?:[a-z0-9]|[a-z0-9][a-z0-9._-]{0,78}[a-z0-9])$`, and must not use a Windows
reserved device name (`con`, `prn`, `aux`, `nul`, `com1`–`com9`,
`lpt1`–`lpt9`) as the full basename or the part before the first dot,
case-insensitively. Source-key identity is byte-for-byte after syntax
validation — no case folding, Unicode normalization, or aliasing. A
syntactically valid source key may name a source the reading clog build cannot
parse; syntax validity and parser support are separate concepts.

**Relationship metadata.** The two optional relationship fields must either
both be present or both be absent; clog always writes both. They record
whether the writing clog inspected the conversation's source content for
branch relationships, and what it found:

- `relationshipInspection` is an object with three fields: `status`, one of
  `"unexamined"`, `"none_found"`, `"linked"`, or `"unknown"`; `version`, a
  positive integer or `null` — the writing adapter's relationship-inspection
  contract version; and `diagnostic`, a non-empty string or `null`.
- `relationships` is an array of relationship objects, each with `kind`
  (always `"branch"`), `parent` (an object with non-empty `source` and
  `sourceId` strings identifying the parent by source-native identity, never
  by a clog-local ID), `evidence` (`"source"` for a relationship the source
  tool recorded, `"inferred"` for one clog derived), and `branchPoint`
  (`null`, or an object with `kind` — `"source-turn"` or `"source-message"` —
  and a non-empty `id` naming where the child diverged, in source-native
  terms).

The fields are cross-validated against `status`: `unexamined` requires a null
`version`, null `diagnostic`, and no relationships; `none_found` requires a
positive `version`, null `diagnostic`, and no relationships; `linked` requires
a positive `version`, null `diagnostic`, and exactly one relationship;
`unknown` requires a positive `version`, a `diagnostic`, and no
relationships.

The `version` governs how importers treat the recorded inspection. A version
equal to the reading adapter's contract version is trusted as-is. An older or
absent version causes the importer to re-inspect the content itself
(preserving a source-confirmed relationship where safe). A *newer* version
rejects the pair with an `adapter_version_skew` warning — the metadata was
written by a newer clog, and importing it would discard information.

**Objective identifiers only.** Pair metadata contains no local/remote
relative terms and no machine-local state: no `projectPath`, no provenance
fields (`originKind`/`originRef`), no managed file paths, and no parser
checkpoints such as `savedMessageCount`. Importers derive local state
themselves (for example, `savedMessageCount` is recomputed from the parsed
message count at import time). Relationship parents follow the same rule:
they are identified by `(source, sourceId)`, never by clog row IDs.

### 3.3 Pair validity and importability

A pair's **metadata is valid** when:

- the metadata file is valid JSON and matches the schema above
- `savedAt`, `modifiedAt`, and `createdAt` are ISO timestamps as specified
- `source` is a syntactically valid source key
- `id` equals the filename stem of both the `.meta.json` and `.jsonl` files

A pair is **importable** when, additionally:

- both files of the pair are present
- `source` is parse-supported by the reading clog build
- the recorded relationship-inspection `version`, if any, is not newer than
  the reading adapter's contract version
- the `.jsonl` content parses successfully through the adapter selected by
  `meta.source`

Validation failures map to stable warning codes: a missing side is
`pair_incomplete`; unreadable or schema-invalid metadata is
`pair_invalid_metadata`; a filename stem differing from `meta.id` is
`pair_id_mismatch` (the message names both values); a JSONL parse failure is
`pair_invalid_content`; a syntactically valid but unsupported source is
`unsupported_source`; relationship metadata written by a newer clog version
is `adapter_version_skew`. Pair validation does not cross-check source-native
embedded IDs — source adapters apply their own discovery-time checks.

### 3.4 Pair writing

Pair writing is ordered and atomic: the `.jsonl` file is written first, then
the `.meta.json`, each through an atomic temp-file-and-rename write. A
complete metadata file therefore implies its content file is present. Writers
that replace existing pairs must preserve this order so readers never observe
metadata that points at missing or partial content.

### 3.5 Archives

`clog drain` (archive format) and `clog fill` (archive input) move the same
pair files inside a zip archive:

```
<source>/<id>.jsonl
<source>/<id>.meta.json
```

A clog-created archive contains regular pair-file records only — no explicit
directory records, no manifest, no unrelated files. Entry names use `/`
separators and are stored in code-point sort order. Every entry gets one fixed
DOS modification time and deterministic deflate compression, so two exports of
the same pair corpus by the same clog and `fflate` versions are byte-identical
across machines and time zones. (Byte identity across different `fflate`
versions is not part of the contract.)

Entry names must be safe relative forward-slash paths: no empty components, C0
controls, backslashes, Windows-forbidden characters, absolute paths, `.`/`..`
components, trailing spaces or periods, or reserved Windows device basenames.

Fixed resource limits apply to archive input and output: 1 GiB of zip file
bytes, 60,000 archive entries, and 2 GiB of selected pair bytes. On import,
only entries ending in `.jsonl` or `.meta.json` (case-sensitively) are
selected; selected entries may use stored (method 0) or deflate (method 8)
compression, and archive permissions, ownership, timestamps, and symlink
attributes are ignored. Archive reading does not verify CRC-32 checksums or
reject every inconsistent size declaration: the compatibility contract covers
archives clog itself produced, not arbitrary zip tools' output.

## 4. Team repository layout

Team sharing stores conversation pairs in a shared git repository, cloned
locally at `~/.clog/remote/`. The layout is author-partitioned:

```
clog-team/
├── alice/
│   ├── claude-code/
│   │   ├── c7044ea5-c019-44d6-a77a-500036740f9a.jsonl
│   │   └── c7044ea5-c019-44d6-a77a-500036740f9a.meta.json
│   └── codex-cli/
│       └── ...
└── bob/
    └── claude-code/
        └── ...
```

The remote path tuple is `(author, source, id)`:

- `<author>` is the directory of the person who saved the conversation, and
  must equal `meta.author`
- `<source>` must be a syntactically valid source key and must equal
  `meta.source`
- `<id>` is the source-native conversation ID and must equal `meta.id` and
  both filename stems

A valid pair in the wrong author or source directory is a
`pair_layout_mismatch` — layout damage, not invalid metadata. These layout
invariants are git-specific: pair directories used by `clog drain --format
pair` and `clog fill` are layout-neutral and require no author directories.

**Provenance by presence.** A pair's presence in the repository is what
establishes its git provenance; the `.meta.json` carries only objective
identifiers (§3.2). Import identity is `(source, id)`, not `id` alone.

**Each author writes only to their own directory.** `clog sync push` exports
the pushing user's saved local conversations into `<config.author>/…` and
never modifies other authors' directories, unknown source directories, or
unrelated files.

**Retraction requires both files to be absent.** A pair that has disappeared
from the author's directory is a retraction of that conversation. A
metadata-only file, JSONL-only file, invalid pair, or layout-mismatched pair
is present-but-bad repository state, never deletion intent: during
reconciliation every incomplete or invalid pair protects each credible
`(source, id)` identity derivable from its path and readable metadata.
Deletion protection is keyed by `(source, id)` across the whole checkout, not
per author, so a pair relocated between author directories cannot delete the
existing row.

**Duplicate conversations.** Two authors may save the same underlying
conversation; the repository then contains both copies under their respective
author directories, possibly with different metadata. Locally, a conversation
exists at most once per `(source, id)`. On import, the first valid copy in
deterministic code-point order over `(author, source, id)` wins; later copies
are skipped with a duplicate notice. Resolution is by provenance and
deterministic order, never by timestamp.

### 4.1 Sync commit message format

`clog sync push` generates commit messages in a fixed shape. Single author,
ten or fewer changes:

```
clog: alice — 3 added, 1 updated

  + abc123ef Fix authentication bug
  + def45678 Refactor database layer
  + 789fedcb Debug memory leak
  ~ aaa111bb Update session metadata
```

More than ten changes collapse to the header line only:

```
clog: alice — 47 added, 3 updated, 1 retracted
```

The header counts appear only for non-zero categories, in the order added,
updated, retracted. Body lines use `+` (added), `~` (updated), `-`
(retracted), followed by the 8-character short ID and title. Multi-author
commits (possible only through manual or administrative operations — a normal
push is always single-author) use `clog: <N> authors — <totals>` with one
per-author summary line each and never list individual conversations:

```
clog: 2 authors — 50 added, 4 updated, 1 retracted

  alice: 47 added, 3 updated
  bob: 3 added, 1 updated, 1 retracted
```

"Retracted" is the term for pairs removed by push, distinguishing it from
`clog remote remove`. clog never creates merge commits, and commits are
authored by the user's own git identity — clog never writes `user.name` or
`user.email` into the checkout's git config.

## Changelog

- **2026-07-28** — Documented the optional `relationshipInspection` and
  `relationships` metadata fields (branch relationships between
  conversations), the `adapter_version_skew` importability rule, and the
  archive input-compatibility scope.
- **2026-07-19** — Initial version, extracted from the retired generative
  specification (kept in git history) and verified against the
  implementation.
