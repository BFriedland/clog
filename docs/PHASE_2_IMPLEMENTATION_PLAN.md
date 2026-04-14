# Phase 2 Implementation Plan

## Purpose

This document describes the intended implementation shape for Phase 2,
semantic search. It is an execution guide for the current codebase, not a
second specification.

- `SPEC.md` defines required behavior
- `docs/ARCHITECTURE.md` describes stable module boundaries
- this document describes the Phase 2 build sequence and search-specific
  integration points

## Goals

- add optional semantic search without weakening the Phase 1 install and usage
  story
- keep search modular behind clean provider and vector-store interfaces
- integrate with Phase 1 through narrow lifecycle hooks rather than broad
  cross-module coupling
- preserve the database as the authority for whether a conversation is
  searchable

## Non-Goals

- no native dependency requirement for core clog
- no automatic search setup during `clog init`
- no query-time transcript reparsing for snippets
- no provider-specific logic outside `src/search/`
- no Phase 3 remote-specific work beyond keeping the Phase 2 interfaces ready
  for it
- no package installation or model download outside `clog search --init`

## Module Shape

Phase 2 adds a dedicated `src/search/` module tree:

- `src/search/types.ts`
  Search-facing contracts such as `EmbeddingProvider`, `VectorStore`, search
  hits, and chunk metadata.
- `src/search/providers.ts`
  Static provider registry, config schema fragments, and package checks.
- `src/search/deps.ts`
  Search composition root. Reads config, validates optional dependencies, and
  constructs provider instances.
- `src/search/chunker.ts`
  Pure chunking logic. Deterministic turn-based chunk construction with an
  approximate token estimator.
- `src/search/indexer.ts`
  Index and search orchestration. Converts conversations into chunks, embeds
  text, writes to the vector store, and performs filtered search.
- `src/search/coherence.ts`
  DB/vector-store coherence helpers: stale marking, searchable-state checks,
  best-effort deindex helpers, and auto-index hooks.
- `src/search/vectorstores/vectra.ts`
  Default vector-store implementation.
- `src/search/embeddings/transformers.ts`
  Default local embedding provider implementation.

Phase 2 also adds three CLI handlers:

- `src/cli/search-init.ts`
- `src/cli/search.ts`
- `src/cli/index-cmd.ts`

## Integration Points

Phase 2 should touch Phase 1 in only these places:

### Config

- extend config schema with optional `search.embedding` and
  `search.vectorStore`
- add no search-specific behavior to normal config loading beyond validation

### DB

- add schema migration version 2 with `indexed_at`
- expose helpers for:
  - listing published conversations needing indexing
  - clearing `indexed_at`
  - updating `indexed_at`

### Conversation Model

- add `indexedAt` to `ConversationMeta`

### CLI Lifecycle Hooks

- `publish`
  Best-effort auto-index if search is configured and dependencies are
  available.
- `edit`, `tag`, `untag`
  Immediate best-effort reindex for published conversations when embedded
  search content changes, specifically title/summary edits. Tag changes stay
  DB-only and do not reindex because tags are not embedded.
- `unpublish`, `exclude`
  Best-effort delete vectors for conversations leaving the searchable set.

### MCP

- add `clog_search`
- update `clog_update` to apply the same stale-index semantics as the CLI

## Execution Order

1. Add plan doc and search module skeleton
2. Add model, config, and DB schema support for `indexed_at`
3. Add provider registry and dependency/composition root
4. Implement chunker and indexing/search orchestration
5. Implement default providers: transformers embedding and Vectra vector store
6. Add CLI commands: `search --init`, `search`, `index`
7. Integrate lifecycle hooks into publish/edit/tag/untag/unpublish/exclude and
   MCP update/search
8. Add tests and update architecture documentation

## Invariants

- search remains optional until explicitly configured
- missing search packages never break non-search commands
- the DB row is authoritative for whether a conversation is searchable
- stale or orphaned vector entries must never be surfaced in results
- snippets come from stored chunk text, not query-time transcript reparsing
- chunking is deterministic for a given transcript

## Error Path

Fresh-user search UX should be linear:

1. `clog search ...`
2. error: search is not configured; run `clog search --init`
3. `clog search --init`
4. config is saved
5. setup shows the exact package-install command and asks for confirmation
6. package installation runs visibly in the same terminal
7. setup initializes the embedding provider so any model download happens here
8. setup offers to index all currently published conversations immediately
9. if the user accepts, indexing runs during setup; otherwise the user runs `clog index` later
10. user runs `clog search ...` successfully

If setup does not complete, later search commands must fail clearly rather than
triggering surprise downloads.

## Testing Plan

- extend DB tests for schema migration and `indexedAt`
- add chunker unit tests for turn grouping, long-turn splitting, and overlap
- add search/coherence unit tests for stale marking and DB-state filtering
- add CLI and MCP tests for search configuration and error messaging
- add integration tests for indexing and querying that skip cleanly when
  optional search packages are not installed

## Follow-Up Candidates

- additional embedding providers
- additional vector stores
- richer chunk/snippet formatting
- rebuild guidance when the configured embedding model changes
