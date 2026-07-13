import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { getDefaultConfig } from "../src/config/index.js";
import {
  planGitReconciliation,
  scanGitCheckoutPairs,
  type GitPairScan,
  type GitValidatedPair,
} from "../src/interchange/reconcile.js";
import type { ConversationMeta } from "../src/models/conversation.js";

const REMOTE_URL = "git@github.com:myorg/clog-team.git";
const OTHER_REMOTE = "git@github.com:myorg/other.git";

describe("git reconciliation planner", () => {
  it("keeps physical checkout paths when shared pair validation reports an incomplete pair", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "clog-reconcile-paths-"));
    const id = "a0101010-1010-1010-1010-101010101010";
    const pairDir = path.join(rootDir, "alice", "claude-code");
    const metaPath = path.join(pairDir, `${id}.meta.json`);
    const jsonlPath = path.join(pairDir, `${id}.jsonl`);

    try {
      await fs.mkdir(pairDir, { recursive: true });
      await fs.writeFile(jsonlPath, "{}\n", "utf8");

      const scan = await scanGitCheckoutPairs(rootDir, getDefaultConfig("alice"));
      const result = scan.results[0];

      expect(result?.kind).toBe("invalid");
      if (result?.kind === "invalid") {
        expect(result.warning.code).toBe("pair_incomplete");
        expect(result.warning.paths).toEqual([metaPath, jsonlPath]);
      }
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("deletes only git rows for the exact configured remote", () => {
    const active = conversation({
      id: "a1111111-1111-1111-1111-111111111111",
      originKind: "git",
      originRef: REMOTE_URL,
    });
    const other = conversation({
      id: "a2222222-2222-2222-2222-222222222222",
      originKind: "git",
      originRef: OTHER_REMOTE,
    });
    const local = conversation({
      id: "a3333333-3333-3333-3333-333333333333",
      originKind: "local",
      originRef: null,
    });
    const file = conversation({
      id: "a4444444-4444-4444-4444-444444444444",
      originKind: "file",
      originRef: null,
    });

    const plan = planGitReconciliation({
      scan: emptyScan(),
      existingRows: [active, other, local, file],
      remoteUrl: REMOTE_URL,
    });

    expect(plan.actions).toEqual([{ kind: "delete", rowId: active.id }]);
    expect(plan.deletedRowIds).toEqual([active.id]);
  });

  it("can disable deletions while still planning inserts and updates", () => {
    const existing = conversation({
      id: "a5555555-5555-5555-5555-555555555555",
      originKind: "git",
      originRef: REMOTE_URL,
    });
    const incoming = pair({
      id: "a6666666-6666-6666-6666-666666666666",
      author: "alice",
      title: "New remote row",
    });

    const plan = planGitReconciliation({
      scan: scanOf(incoming),
      existingRows: [existing],
      remoteUrl: REMOTE_URL,
      deletionsEnabled: false,
    });

    expect(plan.actions.map((action) => action.kind)).toEqual(["insert"]);
    expect(plan.deletedRowIds).toEqual([]);
  });

  it.each([
    {
      label: "local unsaved",
      owner: conversation({
        id: "b1111111-1111-1111-1111-111111111111",
        state: "unsaved",
        originKind: "local",
        originRef: null,
      }),
      reason: "local_unsaved_owner",
      message: "local unsaved copy",
    },
    {
      label: "local saved",
      owner: conversation({
        id: "b2222222-2222-2222-2222-222222222222",
        originKind: "local",
        originRef: null,
      }),
      reason: "local_saved_owner",
      message: "local saved copy",
    },
    {
      label: "file",
      owner: conversation({
        id: "b3333333-3333-3333-3333-333333333333",
        originKind: "file",
        originRef: null,
      }),
      reason: "file_owner",
      message: "filled read-only copy",
    },
    {
      label: "other git remote",
      owner: conversation({
        id: "b4444444-4444-4444-4444-444444444444",
        originKind: "git",
        originRef: OTHER_REMOTE,
      }),
      reason: "other_git_owner",
      message: "another configured remote",
    },
  ] as const)("skips git insert when a $label row owns the identity", ({ owner, reason, message }) => {
    const incoming = pair({
      id: owner.sourceId,
      author: "bob",
      title: "Incoming copy",
    });

    const plan = planGitReconciliation({
      scan: scanOf(incoming),
      existingRows: [owner],
      remoteUrl: REMOTE_URL,
    });

    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({
      kind: "skip",
      reason,
      owner,
    });
    expect(plan.actions[0]?.kind === "skip" ? plan.actions[0].message : "").toContain(message);
  });

  it("uses deterministic first-wins for duplicate valid git pairs", () => {
    const first = pair({
      id: "c1111111-1111-1111-1111-111111111111",
      author: "alice",
      title: "Alice copy",
    });
    const second = pair({
      id: "c1111111-1111-1111-1111-111111111111",
      author: "bob",
      title: "Bob copy",
    });

    const plan = planGitReconciliation({
      scan: scanOf(first, second),
      existingRows: [],
      remoteUrl: REMOTE_URL,
    });

    expect(plan.actions.map((action) => action.kind)).toEqual(["insert", "skip"]);
    expect(plan.actions[0]).toMatchObject({
      kind: "insert",
      conversation: { title: "Alice copy" },
    });
    expect(plan.actions[1]).toMatchObject({
      kind: "skip",
      reason: "duplicate",
    });
  });

  it("skips ignored valid pairs and protects existing in-scope rows from deletion", () => {
    const existing = conversation({
      id: "d1111111-1111-1111-1111-111111111111",
      originKind: "git",
      originRef: REMOTE_URL,
    });
    const ignored = pair({
      id: existing.id,
      author: "alice",
      title: "Ignored",
    });

    const plan = planGitReconciliation({
      scan: scanOf(ignored),
      existingRows: [existing],
      remoteUrl: REMOTE_URL,
      ignoreRules: [existing.id],
      matchesIgnoreRule: (rule, target) => target.sourceId === rule,
    });

    expect(plan.ignoredCount).toBe(1);
    expect(plan.actions).toMatchObject([
      { kind: "skip", reason: "ignored" },
    ]);
    expect(plan.deletedRowIds).toEqual([]);
  });

  it("does not let an ignored duplicate consume the deterministic winner slot", () => {
    const ignoredFirst = pair({
      id: "d2222222-2222-2222-2222-222222222222",
      author: "alice",
      title: "Ignored copy",
      projectName: "ignored-project",
    });
    const importedSecond = pair({
      id: ignoredFirst.id,
      author: "bob",
      title: "Imported copy",
      projectName: "visible-project",
    });

    const plan = planGitReconciliation({
      scan: scanOf(ignoredFirst, importedSecond),
      existingRows: [],
      remoteUrl: REMOTE_URL,
      ignoreRules: ["ignored-project"],
      matchesIgnoreRule: (rule, target) => target.projectName === rule,
    });

    expect(plan.actions).toMatchObject([
      { kind: "skip", reason: "ignored" },
      { kind: "insert", conversation: { title: "Imported copy" } },
    ]);
  });

  it("uses invalid-pair protected identities to block deletion", () => {
    const existing = conversation({
      id: "e1111111-1111-1111-1111-111111111111",
      originKind: "git",
      originRef: REMOTE_URL,
    });

    const plan = planGitReconciliation({
      scan: {
        warnings: [],
        results: [
          {
            kind: "invalid",
            scannedPair: {
              rootDir: "/tmp/remote",
              relativeDir: "bob/claude-code",
              stem: existing.id,
              normalizedRelativePath: `bob/claude-code/${existing.id}`,
              metaPath: `/tmp/remote/bob/claude-code/${existing.id}.meta.json`,
              jsonlPath: `/tmp/remote/bob/claude-code/${existing.id}.jsonl`,
              metaExists: true,
              jsonlExists: true,
            },
            warning: {
              code: "pair_layout_mismatch",
              message: "layout mismatch",
              pair: { author: "bob", source: "claude-code", id: existing.id },
            },
            protectedIdentities: [{ source: "claude-code", id: existing.id }],
          },
        ],
      },
      existingRows: [existing],
      remoteUrl: REMOTE_URL,
    });

    expect(plan.actions).toMatchObject([
      { kind: "skip", reason: "invalid_pair" },
    ]);
    expect(plan.protectedIdentities).toEqual([
      { source: "claude-code", id: existing.id },
    ]);
    expect(plan.deletedRowIds).toEqual([]);
  });
});

function emptyScan(): GitPairScan {
  return { results: [], warnings: [] };
}

function scanOf(...pairs: GitValidatedPair[]): GitPairScan {
  return {
    warnings: [],
    results: pairs.map((gitPair) => ({ kind: "valid", pair: gitPair })),
  };
}

function pair(options: {
  id: string;
  author: string;
  title: string;
  source?: string;
  projectName?: string | null;
  messageCount?: number;
}): GitValidatedPair {
  const source = options.source ?? "claude-code";
  const createdAt = "2026-02-01T10:00:00.000Z";
  return {
    author: options.author,
    source,
    id: options.id,
    pair: {
      rootDir: "/tmp/remote",
      relativeDir: `${options.author}/${source}`,
      stem: options.id,
      normalizedRelativePath: `${options.author}/${source}/${options.id}`,
      metaPath: `/tmp/remote/${options.author}/${source}/${options.id}.meta.json`,
      jsonlPath: `/tmp/remote/${options.author}/${source}/${options.id}.jsonl`,
      meta: {
        id: options.id,
        title: options.title,
        summary: "",
        summaryKind: "none",
        summaryExtraction: null,
        tags: [],
        author: options.author,
        projectName: options.projectName ?? null,
        savedAt: createdAt,
        modifiedAt: createdAt,
        source: source as "claude-code",
        createdAt,
        slug: null,
      },
      messageCount: options.messageCount ?? 1,
    },
  };
}

function conversation(
  options: Partial<ConversationMeta> & {
    id: string;
    originKind: ConversationMeta["originKind"];
    originRef: string | null;
  },
): ConversationMeta {
  const timestamp = "2026-02-01T10:00:00.000Z";
  return {
    id: options.id,
    sourceId: options.sourceId ?? options.id,
    source: options.source ?? "claude-code",
    title: options.title ?? "Existing",
    summary: options.summary ?? "",
    summaryKind: options.summaryKind ?? "none",
    summaryExtraction: options.summaryExtraction ?? null,
    author: options.author ?? "alice",
    projectName: options.projectName ?? null,
    projectPath: options.projectPath ?? null,
    tags: options.tags ?? [],
    slug: options.slug ?? null,
    createdAt: options.createdAt ?? timestamp,
    discoveredAt: options.discoveredAt ?? timestamp,
    modifiedAt: options.modifiedAt ?? timestamp,
    state: options.state ?? "saved",
    savedAt: options.savedAt ?? timestamp,
    savedMessageCount: options.savedMessageCount ?? 1,
    saveVersion: options.saveVersion ?? 1,
    sourcePath: options.sourcePath ?? "/tmp/source.jsonl",
    filePath: options.filePath ?? "/tmp/source.jsonl",
    sourceMtime: options.sourceMtime ?? null,
    indexedAt: options.indexedAt ?? null,
    originKind: options.originKind,
    originRef: options.originRef,
  };
}
