import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CLAUDE_CODE_ADAPTER_VERSIONS,
} from "../src/adapters/claude-code.js";
import {
  CODEX_CLI_ADAPTER_VERSIONS,
  CodexCliAdapter,
} from "../src/adapters/codex-cli.js";
import { collapseAggregatableWarnings } from "../src/cli/common.js";
import { preAction } from "../src/cli/prelude.js";
import { buildProgram } from "../src/cli/program.js";
import { getDefaultConfig, saveConfig } from "../src/config/index.js";
import { getConversationById } from "../src/db/index.js";
import type { SavedConversationMeta } from "../src/models/conversation.js";
import { refreshSavedRelationshipInspections } from "../src/relationships/refresh.js";
import { deleteConversation, insertConversation } from "./helpers/db.js";
import { writeJsonl } from "./helpers/fixtures.js";

describe("saved relationship inspection refresh", () => {
  let tempDir: string;
  let config: ReturnType<typeof getDefaultConfig>;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clog-relationship-refresh-"));
    process.env.CLOG_HOME = tempDir;
    config = getDefaultConfig("alice");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.CLOG_HOME;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("refreshes a saved Codex child from its managed transcript only", async () => {
    const childId = "22222222-2222-2222-2222-222222222222";
    const parentId = "11111111-1111-1111-1111-111111111111";
    const managedPath = path.join(tempDir, "raw", "codex-cli", `${childId}.jsonl`);
    const livePath = path.join(tempDir, "live", `${childId}.jsonl`);
    await writeJsonl(managedPath, [codexSessionMeta(childId, parentId)]);
    await writeJsonl(livePath, [codexSessionMeta(childId)]);

    const saved = makeSavedConversation({
      id: childId,
      sourceId: childId,
      sourcePath: livePath,
      filePath: managedPath,
    });
    await insertConversation(saved);
    const rawBefore = await fs.readFile(managedPath);

    const report = await refreshSavedRelationshipInspections(config);
    const updated = await getConversationById(childId);

    expect(report).toEqual([]);
    expect(updated).toMatchObject({
      relationshipInspection: {
        status: "linked",
        version: CODEX_CLI_ADAPTER_VERSIONS.relationshipInspection,
        diagnostic: null,
      },
      relationships: [{
        kind: "branch",
        parent: {
          source: "codex-cli",
          sourceId: parentId,
        },
        evidence: "source",
        branchPoint: null,
      }],
    });
    expect(withoutRelationshipState(updated!)).toEqual(
      withoutRelationshipState(saved),
    );
    await expect(fs.readFile(managedPath)).resolves.toEqual(rawBefore);
  });

  it("is idempotent after the saved row reaches the adapter version", async () => {
    const id = "22222222-2222-2222-2222-222222222222";
    const managedPath = path.join(tempDir, "raw", "codex-cli", `${id}.jsonl`);
    await writeJsonl(managedPath, [codexSessionMeta(id)]);
    await insertConversation(makeSavedConversation({
      id,
      sourceId: id,
      filePath: managedPath,
      relationshipInspection: {
        status: "unknown",
        version: 1,
        diagnostic: "relationship_inspection_not_implemented",
      },
    }));

    await refreshSavedRelationshipInspections(config);
    await fs.rm(managedPath);
    const second = await refreshSavedRelationshipInspections(config);

    expect(second).toEqual([]);
  });

  it("stores malformed managed evidence as an inspectable diagnostic and continues", async () => {
    const id = "22222222-2222-2222-2222-222222222222";
    const managedPath = path.join(tempDir, "raw", "codex-cli", `${id}.jsonl`);
    await fs.mkdir(path.dirname(managedPath), { recursive: true });
    await fs.writeFile(managedPath, "{not: valid json\n", "utf8");
    await insertConversation(makeSavedConversation({
      id,
      sourceId: id,
      filePath: managedPath,
    }));

    const report = await refreshSavedRelationshipInspections(config);
    const updated = await getConversationById(id);

    expect(report).toEqual([]);
    expect(updated?.relationshipInspection).toEqual({
      status: "unknown",
      version: CODEX_CLI_ADAPTER_VERSIONS.relationshipInspection,
      diagnostic: "codex_relationship_malformed_jsonl",
    });
    expect(updated?.relationships).toEqual([]);
  });

  it("continues after missing managed transcripts and aggregates failures", async () => {
    const goodId = "22222222-2222-2222-2222-222222222222";
    const goodPath = path.join(tempDir, "raw", "codex-cli", `${goodId}.jsonl`);
    await writeJsonl(goodPath, [codexSessionMeta(goodId)]);
    await insertConversation(makeSavedConversation({
      id: goodId,
      sourceId: goodId,
      filePath: goodPath,
    }));

    for (const id of [
      "33333333-3333-3333-3333-333333333333",
      "44444444-4444-4444-4444-444444444444",
    ]) {
      await insertConversation(makeSavedConversation({
        id,
        sourceId: id,
        filePath: path.join(tempDir, "raw", "codex-cli", `${id}.jsonl`),
      }));
    }

    const report = await refreshSavedRelationshipInspections(config);
    const good = await getConversationById(goodId);
    const collapsed = collapseAggregatableWarnings(report);

    expect(good?.relationshipInspection).toMatchObject({
      status: "none_found",
      version: CODEX_CLI_ADAPTER_VERSIONS.relationshipInspection,
    });
    expect(collapsed).toEqual([expect.objectContaining({
      code: "relationship_inspection_refresh_failed",
      message: expect.stringContaining("(2 occurrences)"),
    })]);
  });

  it("does not misreport a database persistence failure as a content-file failure", async () => {
    const id = "22222222-2222-2222-2222-222222222222";
    const managedPath = path.join(tempDir, "raw", "codex-cli", `${id}.jsonl`);
    await writeJsonl(managedPath, [codexSessionMeta(id)]);
    await insertConversation(makeSavedConversation({
      id,
      sourceId: id,
      filePath: managedPath,
    }));
    vi.spyOn(
      CodexCliAdapter.prototype,
      "inspectRelationships",
    ).mockImplementation(async () => {
      await deleteConversation(id);
      return {
        status: "none_found",
        version: CODEX_CLI_ADAPTER_VERSIONS.relationshipInspection,
        diagnostic: null,
        relationships: [],
      };
    });

    await expect(
      refreshSavedRelationshipInspections(config),
    ).rejects.toThrow(`Conversation "${id}" not found.`);
  });

  it("preserves rows stamped by a newer adapter and reports version skew", async () => {
    const id = "22222222-2222-2222-2222-222222222222";
    const saved = makeSavedConversation({
      id,
      sourceId: id,
      filePath: path.join(tempDir, "missing.jsonl"),
      relationshipInspection: {
        status: "unknown",
        version: 99,
        diagnostic: "future_inspection",
      },
    });
    await insertConversation(saved);

    const report = await refreshSavedRelationshipInspections(config);

    expect(report).toEqual([expect.objectContaining({
      code: "adapter_version_skew",
    })]);
    await expect(getConversationById(id)).resolves.toEqual(saved);

    config.sources["claude-code"].enabled = false;
    config.sources["codex-cli"].enabled = false;
    await saveConfig(config);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await buildProgram().parseAsync(["status"], { from: "user" });

    const rendered = stderr.mock.calls
      .map(([chunk]) => String(chunk))
      .join("");
    expect(rendered.match(/warning:/g)).toHaveLength(1);
    expect(rendered).toContain(
      `relationship inspection version 99, which is newer than this clog build's version ${CODEX_CLI_ADAPTER_VERSIONS.relationshipInspection}`,
    );
    expect(rendered).not.toContain("transcript projection version");
  });

  it("refreshes a version-1 Claude Code row from its managed transcript", async () => {
    const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const parentId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const managedPath = path.join(
      tempDir,
      "raw",
      "claude-code",
      `${id}.jsonl`,
    );
    await writeJsonl(managedPath, [
      claudeForkedRecord(id, parentId),
      {
        type: "user",
        timestamp: "2026-07-24T11:00:00.000Z",
        sessionId: id,
      },
    ]);
    const saved = makeSavedConversation({
      id,
      sourceId: id,
      source: "claude-code",
      filePath: managedPath,
      relationshipInspection: {
        status: "unknown",
        version: 1,
        diagnostic: "relationship_inspection_not_implemented",
      },
      transcriptProjectionVersion:
        CLAUDE_CODE_ADAPTER_VERSIONS.transcriptProjection,
    });
    await insertConversation(saved);
    const rawBefore = await fs.readFile(managedPath);

    const report = await refreshSavedRelationshipInspections(config);
    const updated = await getConversationById(id);

    expect(report).toEqual([]);
    expect(updated).toMatchObject({
      relationshipInspection: {
        status: "linked",
        version: CLAUDE_CODE_ADAPTER_VERSIONS.relationshipInspection,
        diagnostic: null,
      },
      relationships: [{
        parent: {
          source: "claude-code",
          sourceId: parentId,
        },
        evidence: "source",
        branchPoint: null,
      }],
    });
    expect(withoutRelationshipState(updated!)).toEqual(
      withoutRelationshipState(saved),
    );
    await expect(fs.readFile(managedPath)).resolves.toEqual(rawBefore);
  });

  it("advances Claude Code inspection without replacing source evidence with inference", async () => {
    const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const confirmedParentId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const inferredParentId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const managedPath = path.join(
      tempDir,
      "raw",
      "claude-code",
      `${id}.jsonl`,
    );
    await writeJsonl(managedPath, [
      {
        type: "assistant",
        uuid: "10000000-0000-4000-8000-000000000001",
        sessionId: id,
        session_id: inferredParentId,
      },
      {
        type: "assistant",
        uuid: "10000000-0000-4000-8000-000000000002",
        sessionId: id,
        session_id: id,
      },
    ]);
    const confirmedRelationship = {
      kind: "branch" as const,
      parent: {
        source: "claude-code",
        sourceId: confirmedParentId,
      },
      evidence: "source" as const,
      branchPoint: null,
    };
    await insertConversation(makeSavedConversation({
      id,
      sourceId: id,
      source: "claude-code",
      filePath: managedPath,
      relationshipInspection: {
        status: "linked",
        version: 1,
        diagnostic: null,
      },
      relationships: [confirmedRelationship],
      transcriptProjectionVersion:
        CLAUDE_CODE_ADAPTER_VERSIONS.transcriptProjection,
    }));

    const report = await refreshSavedRelationshipInspections(config);

    expect(report).toEqual([]);
    await expect(getConversationById(id)).resolves.toMatchObject({
      relationshipInspection: {
        status: "linked",
        version: CLAUDE_CODE_ADAPTER_VERSIONS.relationshipInspection,
      },
      relationships: [confirmedRelationship],
    });
  });

  it("replaces inferred Claude Code evidence when source provenance appears", async () => {
    const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const inferredParentId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const confirmedParentId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const managedPath = path.join(
      tempDir,
      "raw",
      "claude-code",
      `${id}.jsonl`,
    );
    await writeJsonl(managedPath, [
      claudeForkedRecord(id, confirmedParentId),
      {
        type: "user",
        timestamp: "2026-07-24T11:00:00.000Z",
        sessionId: id,
      },
    ]);
    await insertConversation(makeSavedConversation({
      id,
      sourceId: id,
      source: "claude-code",
      filePath: managedPath,
      relationshipInspection: {
        status: "linked",
        version: 1,
        diagnostic: null,
      },
      relationships: [{
        kind: "branch",
        parent: {
          source: "claude-code",
          sourceId: inferredParentId,
        },
        evidence: "inferred",
        branchPoint: null,
      }],
      transcriptProjectionVersion:
        CLAUDE_CODE_ADAPTER_VERSIONS.transcriptProjection,
    }));

    const report = await refreshSavedRelationshipInspections(config);

    expect(report).toEqual([]);
    await expect(getConversationById(id)).resolves.toMatchObject({
      relationshipInspection: {
        status: "linked",
        version: CLAUDE_CODE_ADAPTER_VERSIONS.relationshipInspection,
      },
      relationships: [{
        parent: { sourceId: confirmedParentId },
        evidence: "source",
      }],
    });
  });

  it("preserves a Claude Code row stamped by a newer inspection contract", async () => {
    const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const saved = makeSavedConversation({
      id,
      sourceId: id,
      source: "claude-code",
      filePath: path.join(tempDir, "missing.jsonl"),
      relationshipInspection: {
        status: "unknown",
        version: 99,
        diagnostic: "future_claude_inspection",
      },
      transcriptProjectionVersion:
        CLAUDE_CODE_ADAPTER_VERSIONS.transcriptProjection,
    });
    await insertConversation(saved);

    const report = await refreshSavedRelationshipInspections(config);

    expect(report).toEqual([expect.objectContaining({
      code: "adapter_version_skew",
      source: "claude-code",
    })]);
    await expect(getConversationById(id)).resolves.toEqual(saved);
  });

  it("refreshes stale inspections during ordinary command startup", async () => {
    const id = "22222222-2222-2222-2222-222222222222";
    const managedPath = path.join(tempDir, "raw", "codex-cli", `${id}.jsonl`);
    await writeJsonl(managedPath, [codexSessionMeta(id)]);
    await insertConversation(makeSavedConversation({
      id,
      sourceId: id,
      filePath: managedPath,
    }));
    await saveConfig(config);

    await preAction({ interactive: false });

    expect((await getConversationById(id))?.relationshipInspection).toEqual({
      status: "none_found",
      version: CODEX_CLI_ADAPTER_VERSIONS.relationshipInspection,
      diagnostic: null,
    });
  });

  it("shows individual inspection refresh failures for status --verbose-warnings", async () => {
    const missingPaths: string[] = [];
    for (const id of [
      "33333333-3333-3333-3333-333333333333",
      "44444444-4444-4444-4444-444444444444",
    ]) {
      const filePath = path.join(
        tempDir,
        "raw",
        "codex-cli",
        `${id}.jsonl`,
      );
      missingPaths.push(filePath);
      await insertConversation(makeSavedConversation({
        id,
        sourceId: id,
        filePath,
      }));
    }
    config.sources["claude-code"].enabled = false;
    config.sources["codex-cli"].enabled = false;
    await saveConfig(config);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await buildProgram().parseAsync(["list"], { from: "user" });
    const listWarnings = stderr.mock.calls
      .map(([chunk]) => String(chunk))
      .join("");
    expect(listWarnings).not.toContain("relationship inspection version");

    stderr.mockClear();
    await buildProgram().parseAsync(
      ["status", "--verbose-warnings"],
      { from: "user" },
    );

    const rendered = stderr.mock.calls
      .map(([chunk]) => String(chunk))
      .join("");
    expect(rendered).not.toContain("occurrences");
    for (const filePath of missingPaths) {
      expect(rendered).toContain(filePath);
    }
  });

  it("shows persisted unknown warnings only in status and keeps status usable", async () => {
    const malformedPaths: string[] = [];
    for (const id of [
      "55555555-5555-5555-5555-555555555555",
      "66666666-6666-6666-6666-666666666666",
    ]) {
      const filePath = path.join(
        tempDir,
        "raw",
        "codex-cli",
        `${id}.jsonl`,
      );
      malformedPaths.push(filePath);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, "{not: valid json\n", "utf8");
      await insertConversation(makeSavedConversation({
        id,
        sourceId: id,
        filePath,
      }));
    }
    config.sources["claude-code"].enabled = false;
    config.sources["codex-cli"].enabled = false;
    await saveConfig(config);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await buildProgram().parseAsync(["list"], { from: "user" });
    const firstWarnings = stderr.mock.calls
      .map(([chunk]) => String(chunk))
      .join("");
    expect(firstWarnings).not.toContain("branch history");

    stderr.mockClear();
    stdout.mockClear();
    await buildProgram().parseAsync(["status"], { from: "user" });

    const aggregatedWarnings = stderr.mock.calls
      .map(([chunk]) => String(chunk))
      .join("");
    expect(aggregatedWarnings).toContain("(2 occurrences)");
    expect(aggregatedWarnings).toContain(
      "codex_relationship_malformed_jsonl",
    );

    stderr.mockClear();
    stdout.mockClear();
    await buildProgram().parseAsync(
      ["status", "--verbose-warnings"],
      { from: "user" },
    );

    const verboseWarnings = stderr.mock.calls
      .map(([chunk]) => String(chunk))
      .join("");
    expect(verboseWarnings).not.toContain("occurrences");
    for (const filePath of malformedPaths) {
      expect(verboseWarnings).toContain(filePath);
    }
    const statusOutput = stdout.mock.calls
      .map(([chunk]) => String(chunk))
      .join("");
    expect(statusOutput).toContain(
      "Saved conversations whose content files cannot be read:",
    );
  });

  it("keeps config commands usable when the conversation database is unreadable", async () => {
    await saveConfig(config);
    await fs.writeFile(path.join(tempDir, "clog.db"), "not a database", "utf8");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await buildProgram().parseAsync(
      ["config", "get", "author"],
      { from: "user" },
    );

    expect(stdout.mock.calls.map(([chunk]) => String(chunk)).join("")).toBe(
      '"alice"\n',
    );
  });
});

function makeSavedConversation(
  overrides: Partial<SavedConversationMeta> = {},
): SavedConversationMeta {
  const timestamp = "2026-02-01T10:00:00.000Z";
  const id = overrides.id ?? "22222222-2222-2222-2222-222222222222";
  return {
    id,
    sourceId: id,
    source: "codex-cli",
    title: "Saved conversation",
    summary: "Curated summary",
    summaryKind: "curated",
    summaryExtraction: null,
    author: "alice",
    projectName: "clog",
    projectPath: "/Users/alice/clog",
    tags: ["important"],
    slug: null,
    createdAt: timestamp,
    discoveredAt: timestamp,
    modifiedAt: "2026-02-02T10:00:00.000Z",
    state: "saved",
    savedAt: "2026-02-03T10:00:00.000Z",
    savedMessageCount: 17,
    saveVersion: 4,
    sourcePath: "/source/live.jsonl",
    filePath: null,
    sourceMtime: "2026-02-04T10:00:00.000Z",
    indexedAt: "2026-02-05T10:00:00.000Z",
    originKind: "local",
    originRef: null,
    relationshipInspection: {
      status: "unexamined",
      version: null,
      diagnostic: null,
    },
    relationships: [],
    transcriptProjectionVersion: 1,
    ...overrides,
  };
}

function codexSessionMeta(id: string, parentId?: string): unknown {
  return {
    type: "session_meta",
    payload: {
      id,
      cli_version: "0.145.0",
      forked_from_id: parentId,
      cwd: "/Users/alice/clog",
      timestamp: "2026-02-01T10:00:00.000Z",
    },
  };
}

function claudeForkedRecord(id: string, parentId: string): unknown {
  const uuid = "10000000-0000-4000-8000-000000000001";
  return {
    type: "assistant",
    uuid,
    sessionId: id,
    forkedFrom: {
      sessionId: parentId,
      messageUuid: uuid,
    },
  };
}

function withoutRelationshipState(
  conversation: SavedConversationMeta,
): Omit<SavedConversationMeta, "relationshipInspection" | "relationships"> {
  const {
    relationshipInspection: _relationshipInspection,
    relationships: _relationships,
    ...rest
  } = conversation;
  return rest;
}
