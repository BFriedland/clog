# Architecture Reference

## Purpose

This document describes the stable implementation shape of clog.

It answers a different question than `SPEC.md` and a different question than the
implementation plan:

- `SPEC.md` answers: what should clog do?
- `docs/PHASE_1_IMPLEMENTATION_PLAN.md` answers: what should be built first and where should it go while the implementation is still moving?
- this document answers: what are the current code boundaries and how should new work fit into them?

This is a reference for extending the codebase, not a second spec and not a
project history.

In the documentation hierarchy, this document sits below `SPEC.md` and above
phase implementation plans.

- if intended behavior changes, update `SPEC.md`
- if stable code boundaries or module responsibilities change, update this document
- if build order or execution strategy changes for a phase, update or add the relevant phase plan

This document should evolve more slowly than implementation plans and more
quickly than the spec.

## Design Center

The implementation is organized around shared cores first and interfaces second.

The important centers are:

- source adapters
- DB and ID resolution
- scan pipeline
- content-path and publish-candidate resolution
- optional search composition and coherence
- thin CLI handlers
- MCP handlers that reuse the same semantics as the CLI

The intended flow is:

1. adapters produce source-native discovery metadata and parsed messages
2. the scan pipeline decides what enters or updates the DB
3. DB helpers own stored state and filtering
4. shared CLI helpers resolve content paths, publish candidates, warnings, and table rendering
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
- parse output: canonical `Message[]` for show, diff, publish, and MCP retrieval

Rules:

- do not put DB knowledge into adapters
- do not put source-format parsing in CLI or MCP handlers
- `getEnabledAdapters(config)` is for local discovery
- `getAdapter(source, config)` is for parsing already-tracked conversations and ignores discovery enablement

This separation matters because local scanning and later remote/import parsing are different concerns.

### `src/db`

Owns persistence, schema migration, row mapping, filtering, and ID resolution.

- `schema.ts` creates and migrates the SQLite schema
- `index.ts` wraps DB access with locking and exposes the query/update surface

Current responsibilities include:

- insert/update/delete conversation rows
- list filtering
- short-ID and source-qualified ID resolution
- browsing distinct authors/projects/tags

Rules:

- commands should not issue ad hoc SQL
- filtering semantics that affect multiple surfaces should live here or be composed from DB results in one shared place
- ID ambiguity and not-found behavior should be centralized here, not reimplemented per command
- searchability bookkeeping such as `indexedAt` storage belongs here, but provider-specific search logic does not

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
- `embeddings/transformers.ts` and `vectorstores/vectra.ts` hold the default
  provider implementations

The intended boundary is:

- Phase 1 provides canonical `ConversationMeta`, parsed `Message[]`, and DB
  state
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

### `src/cli/scan.ts`

Owns the discovery pipeline.

The scan pipeline is the boundary between source adapters and stored state. It is responsible for:

- running enabled adapters
- applying exclusion and ignore filters
- enforcing project-path safety rules
- inserting newly discovered rows
- updating existing rows when source files move or change
- pruning stale discovered rows
- aggregating structured warnings

Rules:

- scan is metadata-first and read-only with respect to raw curated files
- raw copies are created only by explicit curation operations such as `add` or explicit publish pushthrough
- warning aggregation belongs here, while presentation belongs elsewhere

### `src/cli/common.ts`

Owns shared workflow helpers used across multiple commands.

This file is the main internal glue layer for local workflows. It currently owns:

- conversation resolution helpers
- content-path resolution
- on-demand parse dispatch through the adapter registry
- publish-candidate selection
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

- curation state changes: `add`, `reset`, `publish`, `unpublish`
- metadata changes: `edit`, `tag`, `rename-author`
- inspection: `status`, `list`, `show`, `path`, `diff`
- exclusion/filter control: `exclude`, `unexclude`, `excluded`, `clogignore`
- search: `search-init`, `search`, `index-cmd`

Rules:

- command handlers should compose shared workflow helpers instead of directly parsing source files or rewriting DB policy
- if two commands need the same operational rule, move that rule below the command layer

### `src/mcp`

Owns MCP server bootstrap and handler translation.

- `server.ts` registers tools/resources and handles MCP transport
- `handlers.ts` implements tool semantics using the same underlying DB and parsing behavior as the CLI

The intended shape is not “CLI over here, MCP over there.”
It is “shared core semantics, two interfaces.”

Rules:

- MCP handlers should reuse the same stored metadata and parser behavior as the CLI
- differences should mostly be about schema validation, truncation defaults, and response shaping
- do not create MCP-only state or duplicate source parsing logic here
- semantic search should reuse the same DB searchability checks as the CLI rather
  than trusting raw vector-store hits

### `src/utils`

Owns small, generic helpers with no workflow policy.

Current examples:

- `paths.ts`
- `time.ts`
- `errors.ts`
- `fs.ts`

Rule:

- `utils` is for genuine low-level reuse, not a catch-all for overflow

## Core Runtime Paths

### Discovery

Local discovery flows through these layers:

1. `getEnabledAdapters(config)`
2. adapter `discover()`
3. scan filtering and warning aggregation in `scan.ts`
4. DB insert/update/prune in `src/db`

This keeps source-format concerns separate from stored-state concerns.

### Content Reads

All transcript reads should flow through shared path resolution and adapter dispatch:

1. resolve a conversation row
2. resolve its content path or publish candidate
3. dispatch to `getAdapter(conversation.source, config)`
4. parse into canonical `Message[]`

### Search

Semantic search flows through these layers:

1. command or MCP handler resolves the configured providers via `src/search/deps`
2. DB state determines which published conversations are currently searchable
3. `chunker.ts` builds deterministic search chunks from canonical messages
4. `indexer.ts` embeds and upserts chunks into the configured vector store
5. query handlers validate vector hits back against current DB state before
   returning them

This keeps the vector store a derived cache instead of a second authority.

This is used by:

- `show`
- `diff`
- explicit publish
- MCP `clog_get`

### Publish

Publish behavior is centered on the publish-candidate helper, not on ad hoc command logic.

The important distinction is:

- discovered conversations publish from source after creating a raw copy
- staged conversations publish from the curated raw copy
- published conversations either reuse the raw copy or push through newer source content depending on file comparison

That decision belongs in shared workflow helpers because `status`, `diff`, and `publish` all need compatible answers.

## State Boundaries

The DB row is the durable state center for a conversation.

Phase 1 state transitions are:

- `discovered`
- `staged`
- `published`

Important implementation rules:

- scan may update operational locator fields on curated conversations without rewriting curated metadata
- `add` manages the curated raw copy
- `publish` advances publish checkpoint fields
- `reset` clears active publish fields when moving back to `discovered`
- `unpublish` preserves the last-publish checkpoint while moving back to `staged`

These rules should remain centered in shared helpers and DB updates, not spread through output code.

## Extension Rules

When adding new work, prefer these placements:

- new source format: `src/adapters`, plus registry wiring and adapter tests
- new stored metadata or filter semantics: `src/db` and shared models
- new local discovery rule: `src/cli/scan.ts` or exclusion/filter helpers
- new behavior shared by multiple commands: `src/cli/common.ts`
- new command-only output detail: the specific command file
- new MCP tool: `src/mcp/handlers.ts` plus `src/mcp/server.ts`

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
- shared workflow helpers own content-path and publish-candidate logic
- CLI and MCP are interfaces over the same underlying semantics

If future work pressures these seams, prefer extending the seam over bypassing it.
