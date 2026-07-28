# clog Design

**Status: Rationale.** This document explains *why* clog is shaped the way it
is — the problem, the principles, the scope boundaries, and the decisions that
would otherwise be tempting to "fix." It explains; it does not bind. What must
hold on disk is [FORMATS.md](FORMATS.md); how the code is organized is
[ARCHITECTURE.md](ARCHITECTURE.md); how to use clog is the README.

## Problem

Developers using AI coding agents (Claude Code, Codex CLI, and the like)
generate hundreds of conversations containing real institutional knowledge:
architectural decisions, debugging approaches, domain patterns, and
problem-solving strategies. That knowledge is trapped on individual machines in
opaque local storage, unsearchable across a team, lost when a machine is wiped
or a developer leaves, and invisible to other agents that could benefit from
the prior context.

## Solution

clog is a local-first CLI tool and MCP server that lets developers discover,
curate, and share their AI coding-agent conversations as a searchable team
knowledge base. It is built for small teams (fewer than ten developers) who
treat conversations with the same security posture as source code, and it
installs with nothing more than `npm install` — no native compilation — on
macOS, Windows, and Linux.

## The unit of work

The anchoring idea is not search, and not a knowledge base in the abstract. It
is the **curated, shared, multi-author transcript**: a conversation that
already happened, deliberately promoted into a small high-signal library, given
human- or agent-authored metadata, and distributed to a team.

That unit is the design center. Features are durable when they deepen it —
curation, provenance, sharing — and fragile when they chase a capability a more
focused tool already owns, like raw search breadth or document authoring. Every
scope boundary below follows from defending this unit.

## Design principles

1. **Files as source of truth, database as index.** Conversation content lives
   in JSONL on disk; SQLite stores only metadata. The database is regenerable
   from source files and stays small enough for `sql.js` to load into memory.
2. **Source locations are read-only.** clog never writes to, modifies, or
   deletes files in source locations like `~/.claude/`. All clog-managed state
   lives under `~/.clog/`.
3. **Curation tool, not an observability tool.** clog helps developers share
   knowledge — not measure activity. No analytics, no dashboards, no per-author
   metrics. This boundary is intentional.
4. **Author-only saving.** A developer saves their own conversations. There is
   no mechanism for saving, unsaving, or retracting on behalf of another
   author.
5. **Git-like when the metaphor fits, not pretending to be Git.** Command
   vocabulary borrows from Git where natural, but clog's state model is its
   own.
6. **Optional features are inert until configured.** Search and sync ship in
   the codebase but do nothing until the user opts in. No setup cost for
   features you don't use.
7. **Missing things repair silently; corrupted things error clearly.** A
   deleted directory is recreated. Invalid JSON gets a descriptive error.
8. **No native dependencies.** Everything installs with `npm install` — no C++
   toolchain, no platform-specific build steps.

## Scope boundaries

These are out of scope because they pull against the unit of work or the
principles above — not because other tools happen to do them.

- **Not a search engine over all history.** clog curates a chosen subset. Its
  search exists to *find what was curated*, not to index everything; breadth
  and ranking quality are a different product with a different cost structure.
  Semantic search *is* the index, with `clog list --grep` as the lexical escape
  hatch.
- **Not an observability or analytics tool.** No dashboards, no activity
  metrics, no developer or agent measurement. Metadata provenance stays tied to
  *explaining a conversation*, never to *measuring behavior*. This is the
  boundary most at risk of erosion as curation-history features are considered.
- **Not a document-authoring environment.** clog captures transcripts; it does
  not host living, mutable, co-authored documents or link graphs. A transcript
  is evidence of what happened, not a wiki article to be rewritten.
- **Not a per-project tool.** clog is home-directory-centric (`~/.clog/`) and
  spans every project on the machine. Designs that assume a single project
  directory should be reshaped, not ported.
- **No automatic secrets redaction.** Conversations carry the same security
  posture as source code. There is no redaction pipeline; a user who needs to
  scrub content edits the saved raw JSONL file directly. Project-path filtering,
  `clogignore`, and explicit saving are the privacy controls.
- **Scale ceiling by design.** `sql.js` in-memory loading and the "small team,
  no auth" posture are right for the target and wrong for a large org. Growth
  pressure should be met by sharpening the niche, not re-architecting toward
  scale clog wasn't built for.

Also explicitly not in the current design: real-time sync, a web UI, user
authentication or access control, user-authored linking between arbitrary
conversations (clog tracks the branch relationships the source tools record,
but conversations are not a wiki with a link graph), message-level editing,
and non-built-in sources beyond Claude Code and Codex CLI. Several of these
are revisitable — see the roadmap.

## Privacy is a fail-closed boundary

Developers run clog on personal machines that also hold conversations unrelated
to their work. Project path is the primary privacy boundary, so it is enforced
fail-closed: if discovery cannot determine a conversation's `projectPath`, the
conversation is skipped as *undiscoverable* rather than inserted — even when no
path filters are configured. Including projectless conversations would mean a
later filter change couldn't retroactively keep already-ingested private data
out. The filter layers are `config.json` `includePaths`/`excludePaths`
(persistent, directory-level) and `~/.clog/clogignore` (hand-editable
patterns).

## Decision records

### sql.js over better-sqlite3, with a lock-and-flush model

clog uses `sql.js` (SQLite compiled to WebAssembly) rather than the native
`better-sqlite3`. `sql.js` installs cleanly on every platform with no node-gyp
or C++ toolchain, which is what makes the zero-native-dependency install story
true. The tradeoff is that it loads the whole database into memory and is
slower than native SQLite — acceptable because the database holds only
metadata and stays well under 10 MB even at thousands of conversations. The DB
layer is isolated enough to swap in `better-sqlite3` later if that ever stops
being true.

Because `sql.js` operates in memory, changes must be explicitly flushed to
disk, and concurrent writers (the CLI and MCP server can run at once) risk
last-write-wins loss. Both are handled by a single discipline: every database
access acquires an advisory lockfile (`~/.clog/clog.db.lock`), loads the DB,
runs a read or write callback, flushes once after a successful write (or after
a read that created/migrated the schema), and releases the lock. This
serializes access across processes and turns a 100-row scan into one file
write, not a hundred.

### Files as truth, database as index

Full transcript content — messages, tool inputs, tool outputs — lives in JSONL
on disk. SQLite stores only metadata and state: enough to power listing,
filtering, and the curation workflow. Content is parsed on demand. This keeps
the database small for `sql.js`'s in-memory model, avoids storing large tool
outputs in the DB, and means the database is a rebuildable index rather than a
second source of truth.

### Search is an opt-in local runtime

Semantic search needs two heavy dependencies (a vector store and an embedding
provider) that would break the zero-native-dep install if bundled. So the
search module is always present but inert until `clog search --init`, which
installs those packages into a clog-owned npm prefix at
`~/.clog/search-runtime` — never into the user's global or project environment.
The default embedding provider (`all-MiniLM-L6-v2` via `@huggingface/transformers`,
run over WASM) works fully offline with no API key, consistent with local-first.
Providers and vector stores sit behind narrow interfaces so alternatives can be
added without touching the indexer or commands. Search is intentionally weak:
it exists to find what was curated, not to be a ranking engine.

### Git as the sharing transport, directory-per-author

Team sharing uses a private git repository as its transport rather than a
custom server or REST API. Git already provides auth, transport security,
access control, an audit log, conflict detection, versioning, hosting, offline
support, and backups — for free, and every target user already has it. clog
shells out to system git rather than bundling `isomorphic-git`.

Within the repo, each developer writes only to their own author directory. This
prevents file-level conflicts without per-developer branches, which were
rejected because pull would have to fetch and merge N branches to assemble the
knowledge base, the team tree wouldn't be visible as a single thing, and branch
lifecycle becomes its own management problem. Directories give the same
isolation with none of that.

Two related decisions fall out of the git model: commits use the user's
existing git identity (clog never writes `user.name`/`user.email` into the
checkout, preserving SSO attribution and signing), and pushing to a repository
clog has *positively confirmed* is public is refused outright — every other
outcome of the visibility probe requires an explicit add-time confirmation,
with no silent-proceed path.

### Imported conversations are read-only (for now)

Conversations imported from a teammate's push or a `clog fill` cannot be edited
or tagged locally, even when the author name matches. This avoids the
complexity of local overlays, sync-back, and conflicts with the original
author's edits. It is a v1 simplification, revisitable once sync stabilizes —
see roadmap items 4.9 and 4.10.

### One conversation, many branches

Coding-agent tools store divergent history differently: Codex CLI creates a
new session file with copied history when an earlier prompt is edited, while
Claude Code retains rewind paths inside one resumable session file and
creates new files for `/branch` and `--fork-session`. clog absorbs both
without leaking source formats past the adapters: each adapter emits one
coherent transcript per stored branch plus generic parent relationships, and
clog derives a conversation graph from those relationships at read time.
Related branches present as one conversation by default, represented by the
most recently updated endpoint; explicit all-branches views and MCP
navigation still reach every saved branch. The graph is deliberately derived
rather than stored — it has no ID of its own and owns no curation — so
relationship evidence can improve without schema migrations. When the
evidence is invalid, presentation degrades conservatively: clog shows
branches separately rather than guessing a collapse.

### Agent-assisted rather than built-in summarization

clog does not call an LLM itself. It exposes storage plus MCP tools
(`get_conversation`, `update_conversation`, `summarization_guide`,
`analysis_suggestions`) and lets the user's own trusted agent harness
(Claude Code or Codex CLI) do the interactive summarization and analysis work.
The MCP surface is a read *and write* surface — agents author curation, not
just read hits — which is the part most adjacent tools don't have. This keeps
clog free of provider credentials, token accounting, and subprocess LLM calls,
and defers provider-backed automatic summarization to a possible later phase
(roadmap 4.1) only if the agent-assisted approach proves insufficient.

## Roadmap

clog was built in three phases, all now part of the product:

- **Phase 1 — Local MVP.** A CLI and MCP server for one developer to discover,
  curate, and browse their own Claude Code and Codex CLI conversations.
- **Phase 2 — Semantic search.** Natural-language search over saved
  conversations using local embeddings and a vector store.
- **Phase 3 — Team sharing.** Sharing saved conversations with teammates via a
  shared git repository.

Possible future extensions (Phase 4), roughly in priority order and none
committed:

| Step | Task |
|------|------|
| 4.1 | Provider-backed automatic summarization, if agent-assisted summarization proves insufficient |
| 4.2 | Web UI for browsing the team knowledge base |
| 4.3 | Conversation analytics (what topics is your team asking about most?) |
| 4.4 | Import from exported Claude.ai conversations |
| 4.5 | Better `clog show` (branch-aware rendering, collapsible tool output, long-conversation formatting) |
| 4.6 | Cross-developer context handoff — an MCP tool that loads a teammate's saved conversation as reference context in a new session |
| 4.7 | Content-aware deduplication of conversations shared by multiple authors |
| 4.8 | Conversation diff beyond new-since-save output |
| 4.9 | Cross-kind promotion from a synced/imported read-only copy to a local editable row |
| 4.10 | Local metadata overlays on imported conversations (local tags, notes) |
| 4.11 | `clog rename-author` automatic cleanup of the old remote directory |
| 4.12 | Multi-remote support |
| 4.13 | Automatic retries on push rejection |
