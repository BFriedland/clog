# Phase 3 Implementation Plan

## Purpose

This document describes the intended implementation shape for Phase 3, team
sharing via git. It is an execution guide for the current codebase, not a
second specification.

- `SPEC.md` §11 defines required behavior
- `docs/ARCHITECTURE.md` describes stable module boundaries
- this document describes the Phase 3 build sequence and sync-specific
  integration points

## Goals

- add team sharing without changing the Phase 1 local curation workflow
- keep all sync behavior behind a single `src/sync/` module that the rest of
  the codebase imports through narrow interfaces
- shell out to system git for transport; never embed a git implementation
- treat the git checkout as an external resource that clog reconciles into the
  DB, not as a second source of truth
- preserve the Phase 1 invariant that source locations are read-only and the
  Phase 2 invariant that the DB row is authoritative for searchability

## Non-Goals

- no `isomorphic-git` or in-process git
- no custom server, REST API, or P2P transport
- no per-developer branches; single shared branch with directory-per-author
  isolation
- no automatic retries on push rejection
- no auto-indexing of imported remote conversations during pull
- no local edits to remote conversations (read-only in v1)
- no merge commits — clog must never produce one
- no per-checkout `user.name` / `user.email` writes; commits use the user's
  global git identity (see SPEC §11.1 "Commits Use the User's Existing Git
  Identity")
- no use of `gh` for visibility checks; the public-repo probe is an
  unauthenticated REST call (see SPEC §11.6)
- no silent-proceed path for visibility: every successful `clog remote add`
  is either a positively-not-public repo that the user explicitly confirmed,
  or refused outright. There is no "proven private" branch — GitHub's
  unauthenticated API cannot return one.
- no visibility confirmation at push time — the decision happens once, at
  `remote add`, when the user is engaged with the URL they just typed

## Module Shape

Phase 3 adds a dedicated `src/sync/` module tree:

- `src/sync/git.ts`
  Thin wrapper over system `git` invoked as a subprocess. Owns `git --version`
  detection, `clone`, `pull --rebase`, `add -A`, `commit`, `push`, `rev-parse
  HEAD`, and `config user.email` lookup. Returns structured results, never
  shells out from outside this file.
- `src/sync/meta.ts`
  `.meta.json` Zod schema, serialization, deserialization, and the conversion
  between `ConversationMeta` and remote meta format. Strips local-only fields
  (`projectPath`, `origin`, `publishedMessageCount`) on write; populates
  derived fields on read.
- `src/sync/visibility.ts`
  Public-repo REST probe and GitHub URL parsing (github.com and GHE host
  detection, SSH↔HTTPS conversion, API URL construction). Exposes one function
  that returns a discriminated `VisibilityResult`: either `{ kind: "public" }`
  (positively identified as public — caller must refuse) or `{ kind:
  "unverified", reason: string }` (caller must run the interactive
  confirmation with `reason` in the prompt). No other outcomes. `fetch` is
  unauthenticated, times out quickly, and does not retry. The module has no
  dependency on a `gh` binary.
- `src/sync/pull.ts`
  Reconciliation flow. Walks the checkout by `(author, source, id)`, validates
  pairs, applies the table in SPEC §11.8, and reports counts. Does not touch
  git itself — pull-from-remote is the caller's responsibility.
- `src/sync/push.ts`
  Export flow. Selects locally-originated published rows for `config.author`,
  writes pairs into the checkout, computes retractions scoped to
  `config.author`'s directory, generates the commit message (SPEC §11.14), and
  reports counts.
- `src/sync/staleness.ts`
  HEAD hash comparison against `config.remote.lastSyncHead`. Pure helper used
  by `status` and `list`.
- `resolveContentPath` stays in `src/cli/common.ts`. The Phase 1 implementation
  already returns the right on-disk path for remote conversations without
  modification, because pull.ts sets `sourcePath` and `filePath` to the same
  checkout path and marks the row `state = "published"`. No new file. The
  plan originally considered a dedicated `src/sync/resolve-content-path.ts`;
  that was unnecessary once the existing helper's branching was verified.
- `src/sync/remote-config.ts`
  Helpers that read and update the structured `config.remote` block. Keeps the
  config-side state changes in one place so command handlers don't reach into
  raw config.

Phase 3 also adds three CLI handlers:

- `src/cli/remote.ts` — `clog remote add | show | remove`
- `src/cli/sync.ts` — `clog sync push | pull`
- `src/cli/refresh.ts` — `clog refresh`

## Integration Points

Phase 3 should touch existing code in only these places.

### Config

- replace the placeholder `remote: null` slot in `src/config/schema.ts` with a
  structured `remote` block: `url`, `allowPublicRemote`, `visibilityConfirmed`,
  `lastSyncHead`. All fields are optional / nullable and default in a way that
  is equivalent to "no remote configured."
- no other config-loading behavior changes

### Conversation Model

- add `origin: string | null` to `ConversationMeta`
- update Zod schema and tests in `src/models/conversation.ts`

### DB

- add migration version 3: `ALTER TABLE conversations ADD COLUMN origin TEXT
  DEFAULT NULL`
- update `insertConversation`, `rowToConversation`, `updateConversation`, and
  `listConversations` to round-trip `origin`
- extend `listConversations` filtering with `origin` ("local" | "remote") and
  the default-filter clause from SPEC §11.10
- add a helper for "rows with this exact origin URL" used by reconciliation,
  and a helper for "rows where origin IS NOT NULL" used by status counts
- no other DB behavior changes

### CLI Lifecycle Hooks

- `edit`, `tag`, `untag`, `unpublish` — refuse rows where `origin IS NOT NULL`
  with a clear error message ("This conversation came from the remote and is
  read-only. Edit it on the publishing author's machine."). The guard goes in
  shared workflow code (`src/cli/common.ts`) so all four commands share one
  implementation and message.
- `exclude` — extend to operate on remote rows. Excluding a remote row deletes
  the DB row and adds the source-qualified ID to `~/.clog/excluded`. The
  excluded file is already the single blocklist consulted by `scan` and will
  also be consulted by `pull.ts`.
- `unexclude` — already works against the excluded file, so the only change is
  ensuring the next `clog sync pull` or `clog refresh` re-imports the row.
- `status` — append remote info: configured URL (if any), unindexed count
  (already available), and a staleness warning when HEAD differs from
  `lastSyncHead`.
- `list` — apply the new default filter (SPEC §11.10), accept `--all` and
  `--origin <local|remote>`, and append the team-conversation footer when
  remote rows exist in the DB.
- `show`, `path`, `diff`, MCP `clog_get`, search indexer — route content reads
  through `resolveContentPath()` instead of branching on state directly. This
  is the only change that ripples through Phase 1/2 surfaces.

### MCP

- extend `clog_list_published` and `clog_search` input schemas with optional
  `origin: "local" | "remote"`
- thread the new filter through to the existing DB query helpers
- no other MCP changes

### Index Registration

- register `remote`, `sync`, and `refresh` commands in `src/index.ts`

## Execution Order

1. Update SPEC §11.1 and §11.6, then add this plan doc
2. Add the `origin` column migration (DB schema v3), update `ConversationMeta`,
   round-trip through `src/db/index.ts`
3. Replace the `remote: null` config slot with the structured `remote` block
4. Implement `src/sync/meta.ts` + `tests/sync-meta.test.ts`
5. Implement `src/sync/visibility.ts` with `fetch` mocking in tests
6. Implement `src/sync/git.ts` (subprocess wrapper, `git --version` detection)
7. Implement `src/sync/resolve-content-path.ts` and migrate Phase 1/2 callers
   to use it (smallest possible diff per call site)
8. Implement `src/sync/pull.ts` reconciliation + `tests/sync-pull.test.ts`
   (covers SPEC §11.8 table exhaustively, no real git)
9. Implement `src/sync/push.ts` export + commit message generation +
   `tests/sync-push.test.ts`
10. Implement `src/sync/staleness.ts`
11. Wire up `src/cli/remote.ts`, `src/cli/sync.ts`, `src/cli/refresh.ts`,
    register in `src/index.ts`
12. Add remote read-only guards to `edit/tag/untag/unpublish` via
    `src/cli/common.ts`
13. Extend `src/cli/exclude.ts` to handle remote rows; update `pull.ts` to
    consult the excluded file
14. Update `src/cli/list.ts` (default filter, flags, footer) and
    `src/cli/status.ts` (remote info, staleness, unindexed count)
15. Extend MCP `clog_list_published` and `clog_search` with the `origin`
    filter
16. Add `tests/sync-integration.test.ts` against bare local git repos, gated
    on `git --version` success
17. Run full test suite, lint, and update `docs/ARCHITECTURE.md` if any
    boundary moved

## Invariants

- system git is the only transport; no in-process git library
- the local curation workflow is unchanged for `origin IS NULL` rows
- remote rows are read-only in v1 — `edit`, `tag`, `untag`, `unpublish` refuse
  them with one shared error
- the excluded file is the single blocklist for both local discovery and
  remote import
- reconciliation is idempotent — running pull or refresh twice produces the
  same DB state
- incomplete or invalid remote pairs are non-destructive: they warn and skip,
  they never delete or degrade an existing imported row
- `sync push` only ever writes to or deletes from `<config.author>/`; it never
  modifies another author's directory
- clog never writes `user.name` or `user.email` into the checkout's
  `.git/config`
- clog never produces a merge commit; pull is always `--rebase`
- the public-repo probe refuses an `add` only when the response positively
  confirms public visibility; everything else proceeds
- the DB row remains authoritative for search; remote import marks
  `indexed_at = NULL` and lets the user run `clog index` explicitly
- tests never make network calls; integration tests use bare local repos via
  `file://` URLs and skip when git is not installed

## Error Path

Sync UX should be linear and self-explanatory:

1. `clog remote add <url>`
2. URL is validated, GitHub visibility is probed, config is written
3. `clog sync pull` clones the repo and reconciles
4. `clog sync push` exports `config.author`'s published conversations and
   pushes
5. `clog status` shows remote URL, unindexed count, and a staleness warning if
   anything outside clog modified the checkout

Common failure modes and the responses clog gives:

- no git installed → "Git is required for sync. Install git and try again."
- `git --version` works but commit fails with no `user.email` → surface git's
  error, hint at `git config --global user.email "you@example.com"`
- public repo detected → refuse with the SPEC §11.6 message
- network/timeout/rate-limit during visibility probe → proceed, require
  first-push confirmation
- push rejected → "Push was rejected — likely a simultaneous push from a
  teammate. Run 'clog sync push' again to retry."
- rebase conflict during pull phase → abort rebase, stop, point at `git -C
  ~/.clog/remote status`
- orphaned or invalid pair on disk → warn, skip, leave any existing imported
  row unchanged
- staleness detected (HEAD != lastSyncHead) on `status`/`list` → informational
  warning suggesting `clog refresh`

## Testing Plan

Phase 3 adds four test files (SPEC §13.4):

- `tests/sync-meta.test.ts` — `.meta.json` Zod schema, read/write round-trip,
  `ConversationMeta` ↔ meta format conversion, absence of
  `publishedMessageCount` on the wire
- `tests/sync-pull.test.ts` — full reconciliation table from SPEC §11.8,
  excluded-file gating, local-takes-precedence, remote-vs-remote duplicates,
  unsupported source dirs, path/metadata mismatches, derived
  `publishedMessageCount`. No real git; tests construct fake checkout
  directories on disk.
- `tests/sync-push.test.ts` — commit message generation (single-author and
  multi-author, ≤10 and >10 changes), export logic, retraction scoping to
  `config.author`'s directory, lightest-necessary-touch behavior
  (orphaned/unrelated/empty-dir invariants). No real git.
- `tests/sync-integration.test.ts` — end-to-end push/pull cycles against bare
  local git repos created with `git init --bare`, exercised via `file://`
  URLs. Gated on `git --version` success at file load; skipped otherwise.

Visibility probe tests (in a small dedicated file alongside
`sync-meta.test.ts`) mock `fetch` and assert the SPEC §11.6 two-outcome
model:

- `200` + `"private": false` → `{ kind: "public" }`
- `200` + `"private": true` → `{ kind: "unverified", reason: ... }`
  (unexpected-but-possible — treated as unverified for safety)
- `404`, `403`, other non-`200` statuses → `{ kind: "unverified", reason: ... }`
  with the reason text matching SPEC §11.6's reason table
- network error, timeout, malformed JSON → `{ kind: "unverified", reason: ... }`
- non-GitHub host → the probe is skipped and the caller sees
  `{ kind: "unverified", reason: "non-GitHub host ..." }` without any network
  call happening

Command-level tests in `cli` / `sync-integration` exercise the full add flow:
proven-public refusal is refused even with `--yes`; unverified + `--yes`
writes config with `visibilityConfirmed: true`; unverified + interactive `n`
aborts and writes no config.

All tests must continue to honor the existing testing principles (SPEC §13.1):
deterministic, no network, no real `~/.claude` access, sandboxed via
`CLOG_HOME` and per-source paths.

## Follow-Up Candidates

Listed for reference; explicitly out of scope for Phase 3.

- explicit "materialize remote conversation back into a local source" workflow
  so a user can continue a teammate's session locally (SPEC §11.1)
- local metadata overlays on remote conversations (local tags, notes)
- content-aware deduplication of conversations shared by multiple authors
- automatic retries on push rejection
- multi-remote support
- `clog rename-author` automatic cleanup of the old remote directory
