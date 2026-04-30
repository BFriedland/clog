# Phase 1 Implementation Plan

## Purpose

This document is the active implementation plan for Phase 1 of clog.

It exists to answer three practical questions:

- What are we building first?
- Where should each concern live?
- How do we avoid painting later phases into a corner?

This document is not a second spec. `SPEC.md` remains the product source of truth.

## Documentation Strategy

Keep implementation docs small and useful.

- `SPEC.md` describes intended behavior.
- This plan describes build order, module boundaries, and execution stages.
- A later architecture doc should describe the stable implementation shape once it exists.
- Decision docs should be rare and only used for non-obvious choices worth preserving.

Avoid:

- restating the spec
- progress journals
- file-by-file inventories
- abstract process language without code-level consequences

Write for low reading effort. Prefer short sections, direct statements, and concrete ownership.

## Goals

Phase 1 should deliver:

- local discovery for Claude Code and Codex CLI conversations
- local curation workflow through the CLI
- on-demand conversation parsing and display
- a working MCP server for browsing, retrieval, and curation
- a code structure that can absorb Phase 2 and Phase 3 without rework

## Design Priorities

Build shared cores before command surfaces.

- Keep source-specific logic in adapters.
- Keep state and query logic in the DB layer.
- Keep scan filtering and warnings centralized.
- Keep CLI handlers thin.
- Keep MCP handlers close to CLI semantics, not as a separate product.
- Avoid local-only assumptions in interfaces that Phase 3 will extend.

## Planned Structure

Target structure for Phase 1:

```text
src/
  adapters/
  cli/
  config/
  db/
  mcp/
  models/
  utils/
  index.ts
tests/
  helpers/
  ...
```

`utils/` should stay small. It is for true shared helpers, not overflow.

## Stages

### 1. Foundation

Owns:

- `package.json`
- runtime/tooling setup
- base `src/` and `tests/` layout
- shared model types and schemas
- shared error and warning types
- config loading and initialization
- path and filesystem helpers

Exit criteria:

- project installs and builds
- test runner and lint runner work
- config/init paths are defined and tested
- shared warning shape exists and is reused

Notes:

- Use ESM.
- Keep Node support at `>=18` unless a Phase 1 need forces a change.
- Prefer native `readline` for the single Phase 1 init prompt unless a stronger reason emerges.

### 2. Persistence Core

Owns:

- schema creation and migration
- lock-wrapped DB access
- row mapping
- query helpers
- filter helpers
- ID prefix resolution

Exit criteria:

- conversations can be inserted, updated, listed, and resolved
- schema creation is idempotent
- source-qualified ID resolution works
- Phase 1 metadata fields are fully represented

Notes:

- Build DB helpers around source-aware data now.
- Do not hardcode local-only assumptions into query shapes.

### 3. Adapter Core

Owns:

- adapter interface
- adapter registry
- Claude Code discovery and parse
- Codex CLI discovery and parse
- fixture generation needed for adapter tests

Exit criteria:

- both built-in adapters pass discovery tests
- both built-in adapters pass full-parse tests
- Codex correlation and fallback rules are covered by fixtures

Notes:

- Treat the Codex adapter as a primary design problem, not cleanup work.
- Keep adapter output deterministic and independent of DB state.

### 4. Discovery Pipeline

Owns:

- excluded-file parsing and validation
- `clogignore` parsing and matching
- config path filters
- scan pipeline
- per-source pruning
- structured scan warnings

Exit criteria:

- scan handles insert, update, move, and prune cases
- filter order matches the spec
- warnings are aggregated in a reusable internal form

Notes:

- Scan output should become shared infrastructure for both CLI and MCP.
- Discovery should remain lightweight and metadata-first.

### 5. Local Workflow

Owns:

- `status`
- `list`
- `add`
- `reset`
- `edit`
- `tag`
- `untag`
- `exclude`
- `unexclude`
- `save`
- `unsave`
- `diff`
- `show`
- `path`
- `rename-author`

Exit criteria:

- the full Phase 1 CLI workflow works end to end
- curated raw-file handling follows the spec
- content path resolution is centralized
- saved-message checkpoint behavior is implemented

Notes:

- Prefer shared workflow helpers where commands overlap.
- Do not let command handlers own parsing or DB policy directly.

### 6. MCP Surface

Owns:

- server bootstrap
- handler implementations
- MCP-facing validation
- truncation behavior
- warning propagation

Exit criteria:

- `clog_list_saved`
- `clog_list_staged`
- `clog_get`
- `clog_update`
- `clog_browse`

all work against the same core semantics as the CLI.

Notes:

- MCP should reuse core services, not duplicate command logic.
- Keep source-aware parsing and warning shapes identical to the CLI path.

### 7. Hardening

Owns:

- workflow tests
- MCP tests
- CLI tests
- e2e tests
- output cleanup where the spec is specific
- interface cleanup between modules

Exit criteria:

- Phase 1 success criteria are met
- required test coverage exists for the implemented surface
- module boundaries are clear enough for later phase work

## Cross-Cutting Rules

These rules apply in every stage:

- Files are the source of truth; the DB is an index.
- Source locations are read-only.
- Discovery and parsing are separate concerns.
- Adapter parsing must be deterministic.
- Structured warnings should be created once and formatted later.
- Commands should compose shared services instead of embedding policy.

## Main Risks

### Codex parsing complexity

Risk:
The Codex source format has the densest normalization rules in Phase 1.

Response:
Build fixture-driven tests before relying on the adapter in workflow code.

### Boundary drift

Risk:
CLI commands could absorb DB, parsing, or scan policy and become hard to extend.

Response:
Centralize scan, ID resolution, content-path resolution, and save-candidate logic.

### Phase 3 coupling surprises

Risk:
Local-only assumptions in DB or content resolution could force rework later.

Response:
Keep source-aware and origin-ready interfaces from the start.

## Expected Follow-On Docs

Likely future docs:

- `docs/IMPLEMENTATION_ARCHITECTURE.md`
- small decision notes only when needed

Those docs should explain the final implementation shape, not narrate the build process.
