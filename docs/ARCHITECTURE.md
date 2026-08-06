# Architecture Reference

## Purpose

This document describes the stable implementation shape of clog: the current
code boundaries and how new work should fit into them. It is a reference for
extending the codebase, not a project history.

It sits alongside three other documents, each answering a different question:

- [FORMATS.md](FORMATS.md) says what must hold on disk and in interchange —
  the normative formats other tools and teammates depend on.
- [DESIGN.md](DESIGN.md) says why clog is shaped the way it is — the problem,
  principles, and decisions.
- **this document** says how the code is currently organized.
- the [README](../README.md) says how to use clog.

Update this document when stable code boundaries or module responsibilities
change. It should evolve more slowly than the code and faster than the design
rationale.

## Design Center

The implementation is organized around shared cores first and interfaces second.

The important centers are:

- source adapters
- DB and ID resolution
- scan pipeline
- content-path and save-candidate resolution
- optional search composition and coherence
- thin CLI handlers
- MCP handlers that reuse the same semantics as the CLI

The intended flow is:

1. adapters produce source-native discovery metadata and parsed messages
2. the scan pipeline decides what enters or updates the DB
3. DB helpers own stored state and filtering
4. shared CLI helpers resolve content paths, save candidates, warnings, and table rendering
5. optional search modules index and query through their own interfaces
6. command handlers compose those shared helpers
7. MCP handlers stay close to CLI semantics instead of inventing a parallel model

## Module Boundaries

### `src/models`

Owns the shared data contracts.

- `conversation.ts` defines `ConversationMeta`, `Message`, and state/role schemas
- `warnings.ts` defines the structured warning shape used by scan and related flows

Rules:

- keep these models product-shaped, not command-shaped
- if a concept is shared across adapters, DB, CLI, and MCP, it belongs here before anywhere else

### `src/config`

Owns config loading, defaults, validation, and initialization.

- `schema.ts` defines the config contract
- `index.ts` loads and validates config
- `init.ts` handles first-run filesystem setup and config bootstrap

Rules:

- config parsing and defaults live here, not in command handlers
- callers should receive validated config objects, not partial raw JSON

### `src/adapters`

Owns all source-specific behavior.

- `adapter.ts` defines the adapter interface
- `registry.ts` maps source keys to adapter factories and is the only place that knows the built-in adapter set
- `claude-code.ts` and `codex-cli.ts` own source discovery and full transcript parsing for their formats

The adapter boundary is:

- discovery output: lightweight metadata for scan
- parse output: canonical `Message[]` for show, diff, save, and MCP retrieval

Rules:

- do not put DB knowledge into adapters
- do not put source-format parsing in CLI or MCP handlers
- `getEnabledAdapters(config)` is for local discovery
- `getAdapter(source, config)` is for parsing already-tracked conversations and ignores discovery enablement

This separation matters because local scanning and later remote/import parsing are different concerns.

### `src/db`

Owns persistence, schema migration, row mapping, filtering, and ID resolution.

- `schema.ts` creates and migrates the SQLite schema
- `index.ts` wraps DB access with locking and exposes read APIs plus guarded
  conversation-authority write APIs
- `unsafe-conversations.ts` contains low-level full-row insert, update, and
  delete primitives for narrow executor modules and test seeding

Current responsibilities include:

- list filtering
- short-ID and source-qualified ID resolution
- browsing distinct authors/projects/tags
- local conversation updates, local author renames, and explicit row-removal
  helpers that re-check provenance before writing
- narrow search-cache writes for `indexedAt`

Rules:

- commands should not issue ad hoc SQL
- command handlers should not import unsafe full-row conversation writers
- filtering semantics that affect multiple surfaces should live here or be composed from DB results in one shared place
- ID ambiguity and not-found behavior should be centralized here, not reimplemented per command
- searchability bookkeeping such as `indexedAt` storage and stale-index queries belongs here, but provider-specific search logic does not
- schema version 10 is the public compatibility baseline:
  `SCHEMA_BASELINE_VERSION` remains 10 when `CURRENT_SCHEMA_VERSION` advances,
  and the removed pre-release migrations below version 10 must not be restored
- ordinary database access migrates integer schema versions from the baseline
  through the current version in ascending order; malformed and pre-baseline
  versions require reset recovery, while versions above the current version
  require a compatible newer clog build
- `clog plunge` reports the same schema-version ranges without migrating the
  database and stops database-row inspection when the schema is not current
- each migration validates the database shape and data it expects before
  changing them, then updates `schema_version` only after that migration
  succeeds
- `ensureCurrentSchema` returns whether it created or advanced the schema;
  `withDb` uses that result to persist schema changes even when the database
  was opened for ordinary read access

### `src/relationships`

Owns the derived conversation graph built from stored branch relationships.

- `graph.ts` is the pure relationship-graph projection: it groups conversation
  records into related-branch components and classifies completeness
  (`complete`/`incomplete`/`invalid`) and per-branch status
  (`endpoint`/`superseded`/`unproven`) under display and indexing policies
- `refresh.ts` recomputes versioned relationship metadata for saved rows when
  an adapter's relationship-inspection contract version advances — durable
  adapter maintenance, not a one-time migration

Rules:

- the graph is derived at read time from stored relationships; it has no
  stored ID and owns no curation
- graph projection stays pure — callers pass conversation inputs in and get
  classifications out; database access stays with the callers
- source-format knowledge stays in adapters; this module sees only generic
  relationships

### `src/conversations`

Owns conversation-level composition and write-authority guards shared by CLI
and MCP surfaces.

- `view.ts` composes stored rows, scan candidates, and the relationship graph
  into presentation views: collapsed related-branch views for list-style
  surfaces, representative-branch selection, and current-source attachment
- `write-guards.ts` owns provenance narrowing (`local`/`git`/`file`
  conversation types) and the locally-writable check that gates every local
  metadata write

Rules:

- surfaces that present conversations (CLI list/status, MCP list/search)
  compose through `view.ts` rather than re-implementing collapsing
- authority checks flow through `write-guards.ts`, not ad hoc
  `originKind` comparisons in commands

### `src/search`

Owns the optional semantic-search subsystem.

- `types.ts` defines search-facing interfaces
- `providers.ts` defines the provider registry, config schema fragments, and
  package checks
- `deps.ts` is the composition root for optional runtime providers
- `chunker.ts` owns deterministic turn-based chunking
- `indexer.ts` owns chunk embedding and vector-query orchestration
- `coherence.ts` owns DB/vector-store coherence helpers and best-effort search
  lifecycle hooks
- `relationships.ts` owns relationship-graph collapse and branch selection for
  search results
- `runtime.ts` owns the mechanics of resolving and spawning the opt-in search
  runtime under `~/.clog/search-runtime`
- `embeddings/transformers.ts` and `vectorstores/vectra.ts` hold the default
  provider implementations

The intended boundary is:

- the rest of clog provides canonical `ConversationMeta`, parsed `Message[]`,
  and DB state
- the search module turns those into derived vector artifacts
- command handlers and MCP use the search module through narrow helpers rather
  than importing provider-specific code directly

Rules:

- keep optional dependency imports inside `src/search`
- keep the database authoritative for whether a conversation is searchable
- query-time snippets should come from stored chunk text, not transcript
  reparsing
- lifecycle hooks should invalidate or delete vectors through coherence
  helpers, not by duplicating search policy in commands
- package installation and model warm-up belong only to `search-init`, not to
  `search`, `index`, or background lifecycle hooks
- DB metadata filters such as tags are not part of vector similarity unless
  they are explicitly embedded; DB-only filter changes should not trigger
  reindexing

### `src/interchange`

Owns portable conversation-pair handling shared by git sync, directory export,
and file import.

- `pairs.ts` owns the transport-neutral pair format: `<id>.jsonl` plus
  `<id>.meta.json`, pair discovery, metadata validation, parser-backed content
  validation, and safe pair writing
- `reconcile.ts` owns the deterministic git reconciliation planner: it compares
  validated git checkout pairs with database snapshots and emits explicit
  insert, update, delete, and skip actions without writing files, database rows,
  or search vectors
- `fill.ts` owns the file-import collision planner
- `archive.ts` owns deterministic zip creation and safe selected-entry extraction

The interchange boundary separates portable pair mechanics from transport
authority. Pair validation says whether the two files describe a readable saved
conversation. Git reconciliation policy then decides what that pair can do to
rows owned by the configured git remote URL.

Rules:

- pair discovery and validation should not know whether the pair came from git
  sync, `clog drain --format pair`, or `clog fill`
- git layout checks belong with the git reconciliation planner because author
  and source directories are a git checkout policy, not a portable pair rule
- the git reconciliation planner is pure: callers pass scanned pair results and
  database snapshots in, and it returns actions and warnings out
- database writes, checkout writes, and search-vector cleanup happen in
  transport executors, not in the planner

### `src/cli/scan.ts`

Owns the discovery pipeline.

The scan pipeline is the boundary between source adapters and presented
state. It is responsible for:

- running enabled adapters
- applying exclusion and ignore filters
- enforcing project-path safety rules
- collecting local discovery candidates into an in-memory scan snapshot
- aggregating structured warnings

Rules:

- scan writes nothing: discovered-but-unsaved conversations are ephemeral
  scan results composed into views at read time, never database rows
- raw copies and database rows are created only by explicit save and import
  operations
- warning aggregation belongs here, while presentation belongs elsewhere

### `src/cli/common.ts`

Owns shared workflow helpers used across multiple commands.

This file is the main internal glue layer for local workflows. It currently owns:

- conversation resolution helpers
- content-path resolution
- on-demand parse dispatch through the adapter registry
- save-candidate selection
- raw-copy creation and file comparison
- warning rendering
- common table rendering
- shared message rendering and truncation helpers
- confirmation prompt helper

This is the right home for behavior that is:

- not source-specific
- not DB-specific
- reused across multiple commands
- still part of workflow semantics rather than generic utilities

Rules:

- prefer adding shared local-workflow behavior here before duplicating it in commands
- keep truly generic helpers in `src/utils`, not here

### `src/cli`

Owns command handlers and command-local presentation.

Each file should stay thin:

- parse flags and arguments
- call shared helpers
- format output
- avoid owning business rules that should be shared with other surfaces

Notable command groupings:

- discovery & curation: `status`, `list`, `edit`, `tag`, `untag`, `exclude`, `unexclude`, `remove`, `rename-author`
- saving & inspection: `save`, `diff`, `show`, `path`, `drain`, `fill`, `plunge`
- agent sessions: `talk`, `summarize`
- semantic search: `search-init`, `search`, `index-cmd`
- team sharing: `remote`, `sync`, `refresh`
- configuration: `init`, `mcp`, `config`

Rules:

- command handlers should compose shared workflow helpers instead of directly parsing source files or rewriting DB policy
- if two commands need the same operational rule, move that rule below the command layer

### `src/mcp`

Owns MCP server bootstrap and handler translation.

- `server.ts` is the stdio entrypoint
- `create-server.ts` registers tools/resources and their descriptions
- `handlers.ts` implements tool semantics using the same underlying DB and parsing behavior as the CLI
- `guides/` holds the bundled summarization and analysis guidance served by the guide tools

The intended shape is not “CLI over here, MCP over there.”
It is “shared core semantics, two interfaces.”

Rules:

- MCP handlers should reuse the same stored metadata and parser behavior as the CLI
- differences should mostly be about schema validation, truncation defaults, and response shaping
- do not create MCP-only state or duplicate source parsing logic here
- semantic search should reuse the same DB searchability checks as the CLI rather
  than trusting raw vector-store hits; a row is searchable only when it is saved
  and `indexedAt` is at least as fresh as `savedAt`

### `src/sync`

Owns the optional team-sharing subsystem.

- `git.ts` is a thin wrapper around the system `git` binary. Every subprocess call to git in the codebase flows through this file — no other module shells out to git directly.
- `meta.ts` re-exports the interchange pair metadata schema for git-facing callers. Git metadata strips local-only fields such as `projectPath`, `originKind`, `originRef`, and `savedMessageCount` on write and populates derived fields on read.
- `visibility.ts` owns GitHub URL parsing, unauthenticated REST visibility probing, and the `VisibilityResult` discriminated union (`"public"` vs `"unverified"`). There is no `gh` dependency and no authenticated probe; see DESIGN.md for the two-outcome rationale.
- `paths.ts` owns path helpers for the remote checkout tree (`~/.clog/remote/<author>/<source>/…`).
- `pull.ts` owns git reconciliation orchestration. It scans the checkout through
  the interchange layer, applies the resulting plan inside a database
  transaction for the currently configured remote URL only, and then performs
  best-effort search-vector cleanup for deleted rows.
- `reconcile-executor.ts` applies git reconciliation actions and can write only
  `git` rows whose `originRef` matches the configured remote URL.
- `push.ts` owns export and commit-message generation. Retractions are scoped to `config.author`'s directory with lightest-necessary-touch semantics, and the pre-reconcile protection snapshot covers every same-author saved row regardless of provenance kind.
- `staleness.ts` owns the `HEAD` vs `lastSyncHead` comparison used by `status` and `list`.
- `remote-config.ts` owns read/write helpers for the structured `config.remote` block so CLI handlers don't reach into raw config objects.

Rules:

- shelling out to git happens only inside `src/sync/git.ts`
- remote-specific file format parsing uses `src/interchange/pairs.ts`, not adapters or DB
- git reconciliation policy (insert/update/delete/warn-skip) lives inside `src/interchange/reconcile.ts`; `src/sync/reconcile-executor.ts` applies the plan, and `src/sync/pull.ts` reports executor-side cleanup warnings
- nothing outside `src/sync/` and the team-sharing CLI handlers (`remote.ts`, `sync.ts`, `refresh.ts`) should import from this module
- clog never writes `user.name` or `user.email` into `~/.clog/remote/.git/config`; the commit identity is whatever git's own resolution chain produces for that working tree
- the visibility probe has two outcomes only: proven public (refuse) and anything else (confirm at add-time). A 200 + `"private": true` is treated as unverified because an unauthenticated GitHub API cannot positively confirm private visibility.

### `src/utils`

Owns small, generic helpers with no workflow policy.

Current examples:

- `paths.ts`
- `time.ts`
- `errors.ts`
- `fs.ts`

Rule:

- `utils` is for genuine low-level reuse, not a catch-all for overflow

### `src/types`

Ambient TypeScript declarations for dependencies without their own types
(`sql.js`, the optional search runtime packages). Declarations only — no
runtime code.

## Core Runtime Paths

### Discovery

Local discovery flows through these layers:

1. `getEnabledAdapters(config)`
2. adapter `discover()`
3. scan filtering and warning aggregation in `scan.ts`
4. read-time composition of the scan snapshot with stored rows through
   `src/conversations/view.ts` — discovery results are never persisted

This keeps source-format concerns separate from stored-state concerns.

### Conversation Views

List-style surfaces do not render rows directly. They compose a view:

1. DB rows (plus scan candidates, where the surface shows unsaved
   conversations) feed `src/conversations/view.ts`
2. `src/relationships/graph.ts` classifies related-branch components and
   per-branch status
3. the composed view collapses related branches to a representative branch by
   default, expanding only on explicit all-branches requests

CLI `list`/`status`, MCP `list_conversations`, and semantic-search result
shaping all share this path, so branch collapsing behaves identically across
surfaces.

### Content Reads

All transcript reads should flow through shared path resolution and adapter dispatch:

1. resolve a conversation row
2. resolve its content path or save candidate
3. dispatch to `getAdapter(conversation.source, config)`
4. parse into canonical `Message[]`

This is used by:

- `show`
- `diff`
- explicit save
- MCP `get_conversation`

### Search

Semantic search flows through these layers:

1. command or MCP handler resolves the configured providers via `src/search/deps`
2. DB state determines which saved conversations are currently searchable
3. `chunker.ts` builds deterministic search chunks from canonical messages
4. `indexer.ts` embeds and upserts chunks into the configured vector store
5. query handlers validate vector hits back against current DB state before
   returning them

This keeps the vector store a derived cache instead of a second authority.

### Save

Save behavior is centered on the save-candidate helper, not on ad hoc command logic.

The important distinction is:

- unsaved conversations save from source after creating a raw copy
- saved conversations either reuse the raw copy or push through newer source content depending on file comparison

That decision belongs in shared workflow helpers because `status`, `diff`, and `save` all need compatible answers.

## State Boundaries

The DB row is the durable state center for a saved conversation. The
database stores saved conversations only: `unsaved` is a presentation state
that the conversation view derives from the current scan snapshot, and a
conversation gains a row the moment it is saved or imported.

The conversation lifecycle state a user sees is one of:

- `unsaved` (ephemeral — a scan result, not a row)
- `saved`

Provenance is an orthogonal dimension expressed through `originKind` and
`originRef`. `originKind` is the provenance class: `local` rows are locally
writable, `git` rows are read-only mirrors from the configured git sync
checkout, and `file` rows are read-only copies imported by `clog fill`.
`originRef` is the configured git remote URL for `git` rows and `NULL` for
`local` and `file` rows.

Important implementation rules:

- local discovery never writes rows; current source locations are attached to saved rows in memory at view-composition time, and persisted locator fields advance only on save
- `clog save` manages the local raw copy and advances save checkpoint fields
- `clog edit`, `clog tag`, `clog untag`, `clog save`, and MCP
  `update_conversation` use local-authority APIs (gated through
  `src/conversations/write-guards.ts`) that require `originKind = "local"`
  and `originRef = NULL` before writing
- `exclude` appends literal rules to `clogignore`; `remove` deletes current matching DB rows without editing the file; the same ignore-rule model gates both local scan results and remote reconciliation
- default `clog fill` writes only `file` rows, and `clog fill --own` writes only
  `local` rows
- git reconciliation writes or deletes only `git` rows whose `originRef`
  exactly matches the currently configured remote URL
- unsafe full-row database writers are internal primitives; ordinary CLI and
  MCP modules should call authority-specific APIs or delegate to narrow
  transport executors

These rules should remain centered in shared helpers and DB updates, not spread through output code.

## Extension Rules

When adding new work, prefer these placements:

- new source format: `src/adapters`, plus registry wiring and adapter tests
- new stored metadata or filter semantics: `src/db` and shared models
- new relationship classification or collapsed-view behavior:
  `src/relationships` and `src/conversations/view.ts`, never per surface
- new local discovery rule: `src/cli/scan.ts` or exclusion/filter helpers
- new behavior shared by multiple commands: `src/cli/common.ts`
- new command-only output detail: the specific command file
- new MCP tool: `src/mcp/handlers.ts` plus `src/mcp/server.ts`
- new sync behavior: add it inside `src/sync/`; only `remote.ts`, `sync.ts`, `refresh.ts`, and the small handful of files with remote-read-only guards should import from `src/sync/`
- new git subprocess call: add the wrapper inside `src/sync/git.ts`; never shell out from anywhere else

Questions to ask before adding code:

- is this source-specific?
- is this persistent-state logic?
- is this shared workflow logic?
- is this only presentation?

If the answer is unclear, the code probably wants a lower layer rather than another command-local implementation.

## What To Preserve

These boundaries are worth protecting:

- adapters own source-native parsing
- scan owns discovery reconciliation
- DB owns stored-state queries and ID resolution
- shared workflow helpers own content-path and save-candidate logic
- CLI and MCP are interfaces over the same underlying semantics

If future work pressures these seams, prefer extending the seam over bypassing it.
