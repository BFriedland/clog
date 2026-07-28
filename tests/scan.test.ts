import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as adapterRegistry from "../src/adapters/registry.js";
import type { SourceAdapter } from "../src/adapters/adapter.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code.js";
import { buildDrainCommand } from "../src/cli/drain.js";
import { buildListCommand } from "../src/cli/list.js";
import { buildSaveCommand } from "../src/cli/save.js";
import { scanLocalSources } from "../src/cli/scan.js";
import { buildShowCommand } from "../src/cli/show.js";
import { buildStatusCommand } from "../src/cli/status.js";
import {
  classifySavedDelta,
  parseConversationMessages,
} from "../src/cli/common.js";
import { getDefaultConfig, saveConfig } from "../src/config/index.js";
import {
  attachCurrentRelationshipInspection,
  buildRelatedConversationView,
  buildDiscoveredConversation,
  composeConversationView,
  listConversationView,
  resolveConversationView,
} from "../src/conversations/view.js";
import { conversationStateSchema, unsavedConversationViewSchema } from "../src/models/conversation.js";
import { getConversationById } from "../src/db/index.js";
import { handleList } from "../src/mcp/handlers.js";
import { getClogDbPath } from "../src/utils/paths.js";
import { insertConversation } from "./helpers/db.js";
import { writeJsonl } from "./helpers/fixtures.js";
import { captureOutput } from "./helpers/output.js";

const TEST_DISCOVERED_RELATIONSHIP_FIELDS = {
  relationshipInspection: {
    status: "unknown" as const,
    version: 1,
    diagnostic: "relationship_inspection_not_implemented",
  },
  relationships: [],
};

const TEST_ADAPTER_CONTRACT = {
  relationshipInspectionVersion: 1,
  transcriptProjectionVersion: 1,
  inspectRelationships: async () => ({
    ...TEST_DISCOVERED_RELATIONSHIP_FIELDS.relationshipInspection,
    relationships: [],
  }),
  parseTranscript: async () => ({ messages: [], warnings: [] }),
};

describe("ephemeral local source scans", () => {
  let tempDir: string;
  let sourceRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clog-scan-"));
    process.env.CLOG_HOME = path.join(tempDir, ".clog");
    sourceRoot = path.join(tempDir, "claude");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.CLOG_HOME;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("returns unsaved candidates without creating or writing the database", async () => {
    const id = "11111111-1111-1111-1111-111111111111";
    await writeClaudeConversation(id, "/Users/alice/work/app", "Investigate auth");
    const config = scanConfig();

    const snapshot = await scanLocalSources(config);

    expect(snapshot.candidates.map((candidate) => candidate.sourceId)).toEqual([id]);
    expect(snapshot.sourceStatuses).toEqual([{ source: "claude-code", complete: true }]);
    await expect(fs.stat(getClogDbPath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("marks real adapters incomplete when configured source roots are unavailable", async () => {
    const claudeConfig = scanConfig();
    claudeConfig.sources["claude-code"].paths = [path.join(tempDir, "missing-claude")];
    const claudeSnapshot = await scanLocalSources(claudeConfig);

    expect(claudeSnapshot.sourceStatuses).toEqual([
      { source: "claude-code", complete: false },
    ]);
    expect(claudeSnapshot.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "source_discovery_incomplete",
        source: "claude-code",
      }),
    ]));
    await expect(
      resolveConversationView("aaaa@claude-code", { scanSnapshot: claudeSnapshot }),
    ).rejects.toThrow(/could not determine/i);

    const codexConfig = getDefaultConfig("alice");
    codexConfig.sources["claude-code"].enabled = false;
    codexConfig.sources["codex-cli"].paths = [path.join(tempDir, "missing-codex")];
    const codexSnapshot = await scanLocalSources(codexConfig);

    expect(codexSnapshot.sourceStatuses).toEqual([
      { source: "codex-cli", complete: false },
    ]);
    expect(codexSnapshot.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "source_discovery_incomplete",
        source: "codex-cli",
      }),
    ]));
  });

  it("marks real adapter discovery incomplete when directory traversal is denied", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) {
      return;
    }

    const unreadableRoot = path.join(tempDir, "unreadable-claude-root");
    await fs.mkdir(unreadableRoot, { recursive: true });
    await fs.chmod(unreadableRoot, 0o000);

    try {
      await expect(fs.stat(unreadableRoot)).resolves.toMatchObject({});
      await expect(fs.readdir(unreadableRoot)).rejects.toMatchObject({ code: "EACCES" });

      const config = scanConfig();
      config.sources["claude-code"].paths = [unreadableRoot];
      const snapshot = await scanLocalSources(config);

      expect(snapshot.sourceStatuses).toEqual([
        { source: "claude-code", complete: false },
      ]);
      expect(snapshot.warnings).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "source_discovery_incomplete",
          source: "claude-code",
        }),
      ]));
    } finally {
      await fs.chmod(unreadableRoot, 0o700);
    }

    const readableRoot = path.join(tempDir, "claude-with-unreadable-project");
    const unreadableProject = path.join(readableRoot, "project");
    await fs.mkdir(unreadableProject, { recursive: true });
    await fs.chmod(unreadableProject, 0o000);

    try {
      const config = scanConfig();
      config.sources["claude-code"].paths = [readableRoot];
      const snapshot = await scanLocalSources(config);

      expect(snapshot.sourceStatuses).toEqual([
        { source: "claude-code", complete: false },
      ]);
    } finally {
      await fs.chmod(unreadableProject, 0o700);
    }
  });

  it("applies clogignore before config filtering and retains ignored display candidates", async () => {
    const ignoredId = "22222222-2222-2222-2222-222222222222";
    const filteredId = "33333333-3333-3333-3333-333333333333";
    const includedId = "44444444-4444-4444-4444-444444444444";
    await writeClaudeConversation(ignoredId, "/Users/alice/work/ignored");
    await writeClaudeConversation(filteredId, "/Users/alice/private/app");
    await writeClaudeConversation(includedId, "/Users/alice/work/public");
    await fs.mkdir(process.env.CLOG_HOME!, { recursive: true });
    await fs.writeFile(path.join(process.env.CLOG_HOME!, "clogignore"), `${ignoredId}\n`);
    const config = scanConfig();
    config.sources["claude-code"].includePaths = ["/Users/alice/work"];

    const snapshot = await scanLocalSources(config);

    expect(snapshot.counts).toMatchObject({ discovered: 1, filtered: 1, ignored: 1 });
    expect(snapshot.candidates[0]?.sourceId).toBe(includedId);
    expect(snapshot.ignoredCandidates[0]).toMatchObject({
      sourceId: ignoredId,
      sourceMtime: expect.any(String),
      relationshipInspection: {
        status: "none_found",
        version: 2,
        diagnostic: null,
      },
      relationships: [],
    });
  });

  it("keeps ignored display candidates inside the configured project-path scope", async () => {
    const includedId = "24444444-4444-4444-4444-444444444444";
    const excludedId = "25555555-5555-5555-5555-555555555555";
    const unknownPathId = "26666666-6666-6666-6666-666666666666";
    await writeClaudeConversation(includedId, "/Users/alice/work/included");
    await writeClaudeConversation(excludedId, "/Users/alice/private/excluded");
    await writeJsonl(path.join(sourceRoot, "project", `${unknownPathId}.jsonl`), [{
      type: "user",
      timestamp: "2026-02-01T10:00:00.000Z",
      message: { role: "user", content: "No project path" },
    }]);
    await fs.mkdir(process.env.CLOG_HOME!, { recursive: true });
    await fs.writeFile(
      path.join(process.env.CLOG_HOME!, "clogignore"),
      `${includedId}\n${excludedId}\n${unknownPathId}\n`,
    );
    const config = scanConfig();
    config.sources["claude-code"].includePaths = ["/Users/alice/work"];

    const snapshot = await scanLocalSources(config);

    expect(snapshot.counts.ignored).toBe(3);
    expect(snapshot.ignoredCandidates.map((candidate) => candidate.sourceId)).toEqual([
      includedId,
    ]);
  });

  it("sorts conversation views by timestamp instant and puts invalid timestamps last", async () => {
    const laterId = "27777777-7777-7777-7777-777777777777";
    const earlierId = "28888888-8888-8888-8888-888888888888";
    const invalidId = "29999999-9999-9999-9999-999999999999";
    await insertConversation(savedConversation(laterId, "/tmp/later.jsonl", {
      createdAt: "2025-12-31T23:00:00.000Z",
    }));
    await insertConversation(savedConversation(invalidId, "/tmp/invalid.jsonl", {
      createdAt: "not-a-timestamp",
    }));
    const snapshot = {
      scanTime: "2026-02-01T10:00:00.000Z",
      author: "alice",
      candidates: [{
        source: "claude-code",
        sourceId: earlierId,
        sourcePath: "/tmp/earlier.jsonl",
        sourceMtime: "2026-02-01T10:00:00.000Z",
        metadata: {
          title: "Earlier despite its date spelling",
          summary: "",
          projectName: "app",
          projectPath: "/Users/alice/work/app",
          slug: null,
          createdAt: "2026-01-01T00:30:00.000+02:00",
        },
      }],
      ignoredCandidates: [],
      sourceStatuses: [{ source: "claude-code", complete: true }],
    };

    const conversations = await listConversationView(
      { states: ["saved", "unsaved"] },
      snapshot,
    );

    expect(conversations.map((conversation) => conversation.id)).toEqual([
      laterId,
      earlierId,
      invalidId,
    ]);
  });

  it("builds prospective unsaved metadata from current config and source mtime", async () => {
    const id = "55555555-5555-5555-5555-555555555555";
    await writeClaudeConversation(id, "/Users/alice/work/app");
    const config = scanConfig();
    config.author = "current-author";
    config.defaultTags = ["should-not-appear"];
    const snapshot = await scanLocalSources(config);

    const [conversation] = await listConversationView(
      { states: ["unsaved"] },
      snapshot,
    );

    expect(conversation).toMatchObject({
      id,
      state: "unsaved",
      author: "current-author",
      tags: [],
      savedAt: null,
      savedMessageCount: null,
      saveVersion: 0,
    });
    expect(conversation?.modifiedAt).toBe(conversation?.sourceMtime);
    expect(unsavedConversationViewSchema.parse(conversation)).toEqual(conversation);
    expect(conversationStateSchema.options).toEqual(["unsaved", "saved"]);
    expect(buildDiscoveredConversation(
      snapshot.candidates[0]!,
      snapshot.author,
      snapshot.scanTime,
    )).toEqual(conversation);
  });

  it("lets a saved database row suppress the matching scan identity", async () => {
    const id = "66666666-6666-6666-6666-666666666666";
    const sourcePath = await writeClaudeConversation(id, "/Users/alice/work/app");
    await insertConversation(savedConversation(id, sourcePath));
    const snapshot = await scanLocalSources(scanConfig());

    const all = await listConversationView(
      { states: ["saved", "unsaved"] },
      snapshot,
    );

    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      state: "saved",
      sourceMtime: snapshot.candidates[0]?.sourceMtime,
      relationshipInspection: {
        status: "unexamined",
        version: null,
        diagnostic: null,
      },
      relationships: [],
    });
    await expect(getConversationById(id)).resolves.toMatchObject({
      sourceMtime: "2026-02-01T10:00:00.000Z",
      relationshipInspection: {
        status: "unexamined",
        version: null,
        diagnostic: null,
      },
    });
    await expect(resolveConversationView(id, { scanSnapshot: snapshot })).resolves.toMatchObject({
      state: "saved",
    });
  });

  it("keeps known relatives outside a lifecycle filter in the graph universe", async () => {
    const parentId = "67777777-7777-7777-7777-777777777777";
    const childId = "68888888-8888-8888-8888-888888888888";
    await insertConversation(savedConversation(parentId, "/managed/parent.jsonl"));
    const snapshot = {
      scanTime: "2026-02-02T10:00:00.000Z",
      author: "alice",
      candidates: [{
        source: "claude-code",
        sourceId: childId,
        sourcePath: "/live/child.jsonl",
        sourceMtime: "2026-02-02T10:00:00.000Z",
        metadata: {
          title: "Unsaved child",
          summary: "",
          projectName: "app",
          projectPath: "/Users/alice/work/app",
          slug: null,
          createdAt: "2026-02-02T09:00:00.000Z",
        },
        relationshipInspection: {
          status: "linked" as const,
          version: 2,
          diagnostic: null,
        },
        relationships: [{
          kind: "branch" as const,
          parent: { source: "claude-code", sourceId: parentId },
          evidence: "source" as const,
          branchPoint: null,
        }],
      }],
      ignoredCandidates: [],
      sourceStatuses: [{ source: "claude-code", complete: true }],
    };

    const saved = await composeConversationView(
      { states: ["saved"] },
      snapshot,
    );
    const unsaved = await composeConversationView(
      { states: ["unsaved"] },
      snapshot,
    );
    const [savedGraph] = buildRelatedConversationView(
      saved.graphUniverse,
      saved.conversations,
    );
    const [unsavedGraph] = buildRelatedConversationView(
      unsaved.graphUniverse,
      unsaved.conversations,
    );

    expect(savedGraph).toMatchObject({
      conversation: { id: parentId },
      branchCount: 1,
      hasMoreBranches: true,
    });
    expect(unsavedGraph).toMatchObject({
      conversation: { id: childId },
      branchCount: 1,
      hasMoreBranches: true,
    });
  });

  it("reports ambiguity when a saved row and a distinct scan conversation share a prefix", async () => {
    const savedId = "c0de1111-1111-1111-1111-111111111111";
    const unsavedId = "c0de2222-2222-2222-2222-222222222222";
    await insertConversation(savedConversation(savedId, "/managed/saved.jsonl"));
    await writeClaudeConversation(unsavedId, "/Users/alice/work/app");
    const snapshot = await scanLocalSources(scanConfig());

    await expect(
      resolveConversationView("c0de", { scanSnapshot: snapshot }),
    ).rejects.toThrow(/ambiguous/i);
  });

  it("drops a deleted or disabled source conversation from the next unsaved view", async () => {
    const id = "77777777-7777-7777-7777-777777777777";
    const sourcePath = await writeClaudeConversation(id, "/Users/alice/work/app");
    const config = scanConfig();
    expect((await scanLocalSources(config)).candidates).toHaveLength(1);

    await fs.unlink(sourcePath);
    expect((await scanLocalSources(config)).candidates).toHaveLength(0);

    await writeClaudeConversation(id, "/Users/alice/work/app");
    config.sources["claude-code"].enabled = false;
    expect((await scanLocalSources(config)).candidates).toHaveLength(0);
  });

  it.each([
    [null, 0],
    [null, 1],
    [null, 2],
    [1, 0],
    [1, 1],
    [1, 2],
  ] as const)(
    "treats transcript projection version %s as refreshable with saved count %s",
    async (transcriptProjectionVersion, savedMessageCount) => {
      const id = `70000000-0000-0000-0000-00000000000${savedMessageCount}`;
      const sourcePath = await writeClaudeConversation(
        id,
        "/Users/alice/work/app",
      );
      const conversation = savedConversation(id, sourcePath, {
        savedMessageCount,
        transcriptProjectionVersion,
      });

      await expect(classifySavedDelta(conversation)).resolves.toBe("ready");
    },
  );

  it("treats a missing relationship inspection version as refreshable", async () => {
    const id = "70555555-5555-5555-5555-555555555555";
    const sourcePath = await writeClaudeConversation(
      id,
      "/Users/alice/work/app",
    );
    const conversation = savedConversation(id, sourcePath, {
      transcriptProjectionVersion: 2,
      relationshipInspection: {
        status: "unexamined",
        version: null,
        diagnostic: null,
      },
    });

    await expect(classifySavedDelta(conversation)).resolves.toBe("ready");
  });

  it("prioritizes transcript projection version skew over source changes", async () => {
    const id = "70666666-6666-6666-6666-666666666666";
    const sourcePath = await writeClaudeConversation(
      id,
      "/Users/alice/work/app",
      "Changed live source",
    );
    const rawPath = path.join(tempDir, "raw-newer-projection.jsonl");
    await writeJsonl(rawPath, [{
      type: "user",
      timestamp: "2026-02-01T09:00:00.000Z",
      cwd: "/Users/alice/work/app",
      message: { role: "user", content: "Saved source" },
    }]);
    const conversation = savedConversation(id, sourcePath, {
      filePath: rawPath,
      transcriptProjectionVersion: 3,
      relationshipInspection: {
        status: "unknown",
        version: 1,
        diagnostic: "relationship_inspection_not_implemented",
      },
    });

    await expect(classifySavedDelta(conversation)).resolves.toBe("version_skew");
  });

  it("treats a newer relationship inspection version as version skew", async () => {
    const id = "70777777-7777-7777-7777-777777777777";
    const sourcePath = await writeClaudeConversation(
      id,
      "/Users/alice/work/app",
    );
    const conversation = savedConversation(id, sourcePath, {
      relationshipInspection: {
        status: "unknown",
        version: 3,
        diagnostic: "newer_inspection",
      },
    });

    await expect(classifySavedDelta(conversation)).resolves.toBe("version_skew");
  });

  it("propagates unexpected transcript parser failures while classifying saved changes", async () => {
    const id = "70778888-8888-8888-8888-888888888888";
    const sourcePath = await writeClaudeConversation(
      id,
      "/Users/alice/work/app",
    );
    const conversation = savedConversation(id, sourcePath, {
      relationshipInspection: {
        status: "none_found",
        version: 2,
        diagnostic: null,
      },
    });
    vi.spyOn(adapterRegistry, "getAdapter").mockReturnValue({
      ...TEST_ADAPTER_CONTRACT,
      name: "claude-code",
      transcriptProjectionVersion: 2,
      watchPaths: () => [],
      discover: async function* () {},
      parseTranscript: async () => {
        throw new Error("unexpected adapter failure");
      },
    });

    await expect(classifySavedDelta(conversation)).rejects.toThrow(
      "unexpected adapter failure",
    );
  });

  it("rejects same-version saved and live relationship disagreement", () => {
    const id = "70888888-8888-8888-8888-888888888888";
    const sourcePath = path.join(tempDir, `${id}.jsonl`);
    const conversation = savedConversation(id, sourcePath, {
      relationshipInspection: {
        status: "linked",
        version: 1,
        diagnostic: null,
      },
      relationships: [{
        kind: "branch",
        parent: {
          source: "claude-code",
          sourceId: "saved-parent",
        },
        evidence: "source",
        branchPoint: null,
      }],
    });

    expect(() =>
      attachCurrentRelationshipInspection(conversation, {
        source: "claude-code",
        sourceId: id,
        sourcePath,
        sourceMtime: "2026-02-01T10:00:00.000Z",
        metadata: {
          title: "Saved title",
          summary: "",
          projectName: "app",
          projectPath: "/Users/alice/work/app",
          slug: null,
          createdAt: "2026-02-01T10:00:00.000Z",
        },
        relationshipInspection: {
          status: "linked",
          version: 1,
          diagnostic: null,
        },
        relationships: [{
          kind: "branch",
          parent: {
            source: "claude-code",
            sourceId: "live-parent",
          },
          evidence: "source",
          branchPoint: null,
        }],
      }),
    ).toThrow(/conflicting saved and live relationship metadata/);
  });

  it("reports same-version saved and live disagreement in read-only graph views", async () => {
    const id = "70889999-8888-8888-8888-888888888888";
    const sourcePath = path.join(tempDir, `${id}.jsonl`);
    const savedParentId = "saved-parent";
    const liveParentId = "live-parent";
    await insertConversation(savedConversation(id, sourcePath, {
      relationshipInspection: {
        status: "linked",
        version: 2,
        diagnostic: null,
      },
      relationships: [{
        kind: "branch",
        parent: {
          source: "claude-code",
          sourceId: savedParentId,
        },
        evidence: "source",
        branchPoint: null,
      }],
    }));
    const snapshot = {
      scanTime: "2026-02-01T11:00:00.000Z",
      author: "alice",
      candidates: [{
        source: "claude-code",
        sourceId: id,
        sourcePath,
        sourceMtime: "2026-02-01T11:00:00.000Z",
        metadata: {
          title: "Live title",
          summary: "",
          projectName: "app",
          projectPath: "/Users/alice/work/app",
          slug: null,
          createdAt: "2026-02-01T10:00:00.000Z",
        },
        relationshipInspection: {
          status: "linked" as const,
          version: 2,
          diagnostic: null,
        },
        relationships: [{
          kind: "branch" as const,
          parent: {
            source: "claude-code",
            sourceId: liveParentId,
          },
          evidence: "source" as const,
          branchPoint: null,
        }],
      }],
      ignoredCandidates: [],
      sourceStatuses: [{ source: "claude-code", complete: true }],
    };

    const composition = await composeConversationView(
      { states: ["saved"] },
      snapshot,
    );
    const [related] = buildRelatedConversationView(
      composition.graphUniverse,
      composition.conversations,
      { relationshipOverrides: composition.relationshipOverrides },
    );

    expect(composition.conversations[0]).toMatchObject({
      sourceMtime: "2026-02-01T11:00:00.000Z",
      relationshipInspection: {
        status: "linked",
        version: 2,
        diagnostic: null,
      },
      relationships: [{
        parent: {
          source: "claude-code",
          sourceId: savedParentId,
        },
      }],
    });
    expect(related).toMatchObject({
      immediateParentRelationship: null,
      relationshipCompleteness: "invalid",
      relationshipWarnings: [{
        code: "conversation_relationship_observation_conflict",
        conversation: {
          source: "claude-code",
          sourceId: id,
        },
      }],
    });
    await expect(
      resolveConversationView(id, { scanSnapshot: snapshot }),
    ).resolves.toMatchObject({ id, state: "saved" });
  });

  it("reinspects a stale saved relationship during a bare save", async () => {
    const id = "70999999-9999-9999-9999-999999999999";
    const rawPath = path.join(
      process.env.CLOG_HOME!,
      "raw",
      "claude-code",
      `${id}.jsonl`,
    );
    await writeJsonl(rawPath, [{
      type: "user",
      timestamp: "2026-02-01T09:00:00.000Z",
      cwd: "/Users/alice/work/app",
      message: { role: "user", content: "Saved source" },
    }]);
    await insertConversation(savedConversation(id, rawPath));
    await saveConfig(scanConfig());

    await captureOutput(async () => {
      const command = buildSaveCommand();
      command.exitOverride();
      await command.parseAsync([], { from: "user" });
    });

    await expect(getConversationById(id)).resolves.toMatchObject({
      relationshipInspection: {
        status: "none_found",
        version: 2,
        diagnostic: null,
      },
      relationships: [],
      transcriptProjectionVersion: 2,
    });
  });

  it("persists a Claude Code child's fork-time createdAt only when explicitly refreshed", async () => {
    const id = "70a00000-0000-4000-8000-000000000000";
    const parentId = "70b00000-0000-4000-8000-000000000000";
    const copiedHistoryCreatedAt = "2026-01-01T09:00:00.000Z";
    const forkCreatedAt = "2026-02-01T11:00:00.000Z";
    const sourcePath = path.join(
      sourceRoot,
      "project",
      `${id}.jsonl`,
    );
    const records = [
      {
        type: "user",
        uuid: "10000000-0000-4000-8000-000000000001",
        timestamp: copiedHistoryCreatedAt,
        sessionId: id,
        forkedFrom: {
          sessionId: parentId,
          messageUuid: "10000000-0000-4000-8000-000000000001",
        },
        cwd: "/Users/alice/work/app",
        message: { role: "user", content: "Copied parent prompt" },
      },
      {
        type: "user",
        uuid: "10000000-0000-4000-8000-000000000002",
        timestamp: forkCreatedAt,
        sessionId: id,
        cwd: "/Users/alice/work/app",
        message: { role: "user", content: "Fork prompt" },
      },
    ];
    await writeJsonl(sourcePath, records);
    const rawPath = path.join(
      process.env.CLOG_HOME!,
      "raw",
      "claude-code",
      `${id}.jsonl`,
    );
    await writeJsonl(rawPath, records);
    await insertConversation(savedConversation(id, sourcePath, {
      filePath: rawPath,
      createdAt: copiedHistoryCreatedAt,
      relationshipInspection: {
        status: "unknown",
        version: 1,
        diagnostic: "relationship_inspection_not_implemented",
      },
    }));
    await saveConfig(scanConfig());

    await scanLocalSources(scanConfig());
    await expect(getConversationById(id)).resolves.toMatchObject({
      createdAt: copiedHistoryCreatedAt,
    });

    await captureOutput(async () => {
      const command = buildSaveCommand();
      command.exitOverride();
      await command.parseAsync([id], { from: "user" });
    });

    await expect(getConversationById(id)).resolves.toMatchObject({
      createdAt: forkCreatedAt,
      relationshipInspection: {
        status: "linked",
        version: 2,
        diagnostic: null,
      },
      relationships: [{
        parent: {
          source: "claude-code",
          sourceId: parentId,
        },
        evidence: "source",
      }],
    });
  });

  it("does not downgrade source-confirmed evidence during bare-save reinspection", async () => {
    const id = "70aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const confirmedParentId = "70bbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const inferredParentId = "70cccccc-cccc-cccc-cccc-cccccccccccc";
    const rawPath = path.join(
      process.env.CLOG_HOME!,
      "raw",
      "claude-code",
      `${id}.jsonl`,
    );
    await writeJsonl(rawPath, [
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
    await insertConversation(savedConversation(id, rawPath, {
      relationshipInspection: {
        status: "linked",
        version: 1,
        diagnostic: null,
      },
      relationships: [confirmedRelationship],
    }));
    await saveConfig(scanConfig());

    await captureOutput(async () => {
      const command = buildSaveCommand();
      command.exitOverride();
      await command.parseAsync([], { from: "user" });
    });

    await expect(getConversationById(id)).resolves.toMatchObject({
      relationshipInspection: {
        status: "linked",
        version: 2,
        diagnostic: null,
      },
      relationships: [confirmedRelationship],
    });
  });

  it("does not parse a saved transcript stamped by a newer adapter", async () => {
    const id = "71111111-1111-1111-1111-111111111111";
    const sourcePath = await writeClaudeConversation(
      id,
      "/Users/alice/work/app",
    );
    const conversation = savedConversation(id, sourcePath, {
      transcriptProjectionVersion: 3,
    });
    const parse = vi.spyOn(ClaudeCodeAdapter.prototype, "parseTranscript");

    await expect(classifySavedDelta(conversation)).resolves.toBe("version_skew");
    await expect(
      parseConversationMessages(scanConfig(), conversation),
    ).rejects.toThrow(/newer clog version/);
    expect(parse).not.toHaveBeenCalled();
  });

  it("does not refresh or overwrite a saved transcript stamped by a newer adapter", async () => {
    const id = "72222222-2222-2222-2222-222222222222";
    const sourcePath = await writeClaudeConversation(
      id,
      "/Users/alice/work/app",
      "New live source",
    );
    const rawPath = path.join(
      process.env.CLOG_HOME!,
      "raw",
      "claude-code",
      `${id}.jsonl`,
    );
    await writeJsonl(rawPath, [{
      type: "user",
      timestamp: "2026-02-01T09:00:00.000Z",
      cwd: "/Users/alice/work/app",
      message: { role: "user", content: "Newer saved projection" },
    }]);
    await insertConversation(savedConversation(id, sourcePath, {
      filePath: rawPath,
      transcriptProjectionVersion: 3,
    }));
    await saveConfig(scanConfig());
    const beforeRow = await getConversationById(id);
    const beforeRaw = await fs.readFile(rawPath);

    await expect(
      captureOutput(async () => {
        const command = buildSaveCommand();
        command.exitOverride();
        await command.parseAsync([id], { from: "user" });
      }),
    ).rejects.toThrow(/newer clog version/);

    await expect(getConversationById(id)).resolves.toEqual(beforeRow);
    await expect(fs.readFile(rawPath)).resolves.toEqual(beforeRaw);
  });

  it("retains yielded candidates and marks an adapter incomplete when discovery throws", async () => {
    const adapter: SourceAdapter = {
      ...TEST_ADAPTER_CONTRACT,
      name: "claude-code",
      watchPaths: () => [],
      async *discover() {
        const sourcePath = await writeClaudeConversation(
          "88888888-8888-8888-8888-888888888888",
          "/Users/alice/work/app",
        );
        yield {
          ...TEST_DISCOVERED_RELATIONSHIP_FIELDS,
          sourceId: "88888888-8888-8888-8888-888888888888",
          sourcePath,
          metadata: {
            title: "Retained",
            summary: "",
            projectName: "app",
            projectPath: "/Users/alice/work/app",
            slug: null,
            createdAt: "2026-02-01T10:00:00.000Z",
          },
        };
        throw new Error("source unavailable");
      },
    };
    vi.spyOn(adapterRegistry, "getEnabledAdapters").mockReturnValue([adapter]);

    const snapshot = await scanLocalSources(scanConfig());

    expect(snapshot.candidates).toHaveLength(1);
    expect(snapshot.sourceStatuses).toEqual([{ source: "claude-code", complete: false }]);
    expect(snapshot.warnings).toContainEqual(expect.objectContaining({
      code: "source_discovery_incomplete",
      source: "claude-code",
    }));
    await expect(
      resolveConversationView("9999@claude-code", { scanSnapshot: snapshot }),
    ).rejects.toThrow(/could not determine/i);
    await expect(
      resolveConversationView("88888888@claude-code", { scanSnapshot: snapshot }),
    ).rejects.toThrow(/could not determine/i);
  });

  it("keeps broad partial results but only exempts exact identities from completed sources", async () => {
    const healthyId = "a1111111-1111-1111-1111-111111111111";
    const partialId = "b2222222-2222-2222-2222-222222222222";
    const healthyPath = await writeClaudeConversation(healthyId, "/Users/alice/work/healthy");
    const partialPath = await writeClaudeConversation(partialId, "/Users/alice/work/partial");
    const metadata = (title: string, projectPath: string) => ({
      title,
      summary: "",
      projectName: path.basename(projectPath),
      projectPath,
      slug: null,
      createdAt: "2026-02-01T10:00:00.000Z",
    });
    const healthy: SourceAdapter = {
      ...TEST_ADAPTER_CONTRACT,
      name: "claude-code",
      watchPaths: () => [],
      async *discover() {
        yield {
          ...TEST_DISCOVERED_RELATIONSHIP_FIELDS,
          sourceId: healthyId,
          sourcePath: healthyPath,
          metadata: metadata("Healthy", "/Users/alice/work/healthy"),
        };
      },
    };
    const incomplete: SourceAdapter = {
      ...TEST_ADAPTER_CONTRACT,
      name: "codex-cli",
      watchPaths: () => [],
      async *discover() {
        yield {
          ...TEST_DISCOVERED_RELATIONSHIP_FIELDS,
          sourceId: partialId,
          sourcePath: partialPath,
          metadata: metadata("Partial", "/Users/alice/work/partial"),
        };
        throw new Error("partial failure");
      },
    };
    vi.spyOn(adapterRegistry, "getEnabledAdapters").mockReturnValue([healthy, incomplete]);

    const snapshot = await scanLocalSources(scanConfig());
    const broad = await listConversationView({ states: ["unsaved"] }, snapshot);

    expect(broad.map((conversation) => conversation.id)).toEqual([healthyId, partialId]);
    await expect(
      resolveConversationView(`${healthyId}@claude-code`, { scanSnapshot: snapshot }),
    ).resolves.toMatchObject({ id: healthyId });
    await expect(
      resolveConversationView(healthyId, { scanSnapshot: snapshot }),
    ).rejects.toThrow(/could not determine/i);
    await expect(
      resolveConversationView("a111", { scanSnapshot: snapshot }),
    ).rejects.toThrow(/could not determine/i);
  });

  it("keeps partial results and incomplete-source warnings in broad CLI and MCP views", async () => {
    const healthyId = "b3111111-1111-1111-1111-111111111111";
    const partialId = "b3222222-2222-2222-2222-222222222222";
    const healthyPath = await writeClaudeConversation(healthyId, "/Users/alice/work/healthy");
    const partialPath = await writeClaudeConversation(partialId, "/Users/alice/work/partial");
    const discovered = (sourceId: string, sourcePath: string, projectName: string) => ({
      ...TEST_DISCOVERED_RELATIONSHIP_FIELDS,
      sourceId,
      sourcePath,
      metadata: {
        title: `${projectName} conversation`,
        summary: "",
        projectName,
        projectPath: `/Users/alice/work/${projectName}`,
        slug: null,
        createdAt: "2026-02-01T10:00:00.000Z",
      },
    });
    const healthy: SourceAdapter = {
      ...TEST_ADAPTER_CONTRACT,
      name: "claude-code",
      watchPaths: () => [],
      async *discover() {
        yield discovered(healthyId, healthyPath, "healthy");
      },
    };
    const incomplete: SourceAdapter = {
      ...TEST_ADAPTER_CONTRACT,
      name: "codex-cli",
      watchPaths: () => [],
      async *discover() {
        yield discovered(partialId, partialPath, "partial");
        throw new Error("partial failure");
      },
    };
    vi.spyOn(adapterRegistry, "getEnabledAdapters").mockReturnValue([healthy, incomplete]);
    await saveConfig(scanConfig());

    const cli = await captureOutput(async () => {
      const command = buildListCommand();
      command.exitOverride();
      await command.parseAsync(["--all"], { from: "user" });
    });
    expect(cli.stdout).toContain(healthyId.slice(0, 8));
    expect(cli.stdout).toContain(partialId.slice(0, 8));
    expect(cli.stderr).toContain("Discovery did not complete for codex-cli");

    const mcp = await handleList({ state: "all", limit: 100 });
    expect(mcp.conversations.map((conversation) => conversation.id)).toEqual(
      expect.arrayContaining([healthyId, partialId]),
    );
    expect(mcp.warnings).toContainEqual(expect.objectContaining({
      code: "source_discovery_incomplete",
      source: "codex-cli",
    }));
  });

  it("runs each adapter discovery once when list --all also renders ignored rows", async () => {
    const includedId = "c3333333-3333-3333-3333-333333333333";
    const ignoredId = "d4444444-4444-4444-4444-444444444444";
    const includedPath = await writeClaudeConversation(includedId, "/Users/alice/work/app");
    const ignoredPath = await writeClaudeConversation(ignoredId, "/Users/alice/work/app");
    await fs.mkdir(process.env.CLOG_HOME!, { recursive: true });
    await fs.writeFile(path.join(process.env.CLOG_HOME!, "clogignore"), `${ignoredId}\n`);
    const discover = vi.fn(async function* () {
      for (const [sourceId, sourcePath] of [
        [includedId, includedPath],
        [ignoredId, ignoredPath],
      ] as const) {
        yield {
          ...TEST_DISCOVERED_RELATIONSHIP_FIELDS,
          sourceId,
          sourcePath,
          metadata: {
            title: sourceId === includedId ? "Included" : "Ignored",
            summary: "",
            projectName: "app",
            projectPath: "/Users/alice/work/app",
            slug: null,
            createdAt: "2026-02-01T10:00:00.000Z",
          },
        };
      }
    });
    vi.spyOn(adapterRegistry, "getEnabledAdapters").mockReturnValue([{
      ...TEST_ADAPTER_CONTRACT,
      name: "claude-code",
      watchPaths: () => [],
      discover,
    }]);
    await saveConfig(scanConfig());

    const output = await captureOutput(async () => {
      const command = buildListCommand();
      command.exitOverride();
      await command.parseAsync(["--all"], { from: "user" });
    });

    expect(discover).toHaveBeenCalledOnce();
    expect(output.stdout).toContain("Included");
    expect(output.stdout).toContain("Ignored");
  });

  it("collapses related ignored rows in list --all and restores them with --all-branches", async () => {
    const rootId = "d5000000-4444-4444-4444-444444444444";
    const parentId = "d5000001-4444-4444-4444-444444444444";
    const childId = "d5000002-4444-4444-4444-444444444444";
    const rootPath = await writeClaudeConversation(rootId, "/Users/alice/work/app");
    const parentPath = await writeClaudeConversation(parentId, "/Users/alice/work/app");
    const childPath = await writeClaudeConversation(childId, "/Users/alice/work/app");
    const rootTime = new Date("2026-01-01T10:00:00.000Z");
    const parentTime = new Date("2026-02-01T10:00:00.000Z");
    const childTime = new Date("2026-02-02T10:00:00.000Z");
    await fs.utimes(rootPath, rootTime, rootTime);
    await fs.utimes(parentPath, parentTime, parentTime);
    await fs.utimes(childPath, childTime, childTime);
    await fs.mkdir(process.env.CLOG_HOME!, { recursive: true });
    await fs.writeFile(
      path.join(process.env.CLOG_HOME!, "clogignore"),
      `${rootId}\n${childId}\n`,
    );
    const discover = async function* () {
      yield {
        sourceId: rootId,
        sourcePath: rootPath,
        metadata: {
          title: "Ignored root",
          summary: "",
          projectName: "app",
          projectPath: "/Users/alice/work/app",
          slug: null,
          createdAt: "2026-01-01T10:00:00.000Z",
        },
        relationshipInspection: {
          status: "none_found" as const,
          version: 1,
          diagnostic: null,
        },
        relationships: [],
      };
      yield {
        sourceId: parentId,
        sourcePath: parentPath,
        metadata: {
          title: "Visible parent",
          summary: "",
          projectName: "app",
          projectPath: "/Users/alice/work/app",
          slug: null,
          createdAt: "2026-02-01T10:00:00.000Z",
        },
        relationshipInspection: {
          status: "linked" as const,
          version: 1,
          diagnostic: null,
        },
        relationships: [{
          kind: "branch" as const,
          parent: { source: "claude-code", sourceId: rootId },
          evidence: "source" as const,
          branchPoint: null,
        }],
      };
      yield {
        sourceId: childId,
        sourcePath: childPath,
        metadata: {
          title: "Ignored child",
          summary: "",
          projectName: "app",
          projectPath: "/Users/alice/work/app",
          slug: null,
          createdAt: "2026-02-02T10:00:00.000Z",
        },
        relationshipInspection: {
          status: "linked" as const,
          version: 1,
          diagnostic: null,
        },
        relationships: [{
          kind: "branch" as const,
          parent: { source: "claude-code", sourceId: parentId },
          evidence: "source" as const,
          branchPoint: null,
        }],
      };
    };
    vi.spyOn(adapterRegistry, "getEnabledAdapters").mockReturnValue([{
      ...TEST_ADAPTER_CONTRACT,
      name: "claude-code",
      watchPaths: () => [],
      discover,
    }]);
    await saveConfig(scanConfig());

    const collapsed = await captureOutput(async () => {
      const command = buildListCommand();
      command.exitOverride();
      await command.parseAsync(["--all"], { from: "user" });
    });
    const expanded = await captureOutput(async () => {
      const command = buildListCommand();
      command.exitOverride();
      await command.parseAsync(["--all", "--all-branches"], { from: "user" });
    });
    const defaultIgnoredGrep = await captureOutput(async () => {
      const command = buildListCommand();
      command.exitOverride();
      await command.parseAsync(
        ["--all", "--grep", "ignored root"],
        { from: "user" },
      );
    });
    const defaultVisibleGrep = await captureOutput(async () => {
      const command = buildListCommand();
      command.exitOverride();
      await command.parseAsync(
        ["--all", "--grep", "visible parent"],
        { from: "user" },
      );
    });
    const expandedIgnoredGrep = await captureOutput(async () => {
      const command = buildListCommand();
      command.exitOverride();
      await command.parseAsync(
        ["--all", "--all-branches", "--grep", "ignored root"],
        { from: "user" },
      );
    });
    const expandedVisibleGrep = await captureOutput(async () => {
      const command = buildListCommand();
      command.exitOverride();
      await command.parseAsync(
        ["--all", "--all-branches", "--grep", "visible parent"],
        { from: "user" },
      );
    });

    expect(collapsed.stdout).not.toContain(rootId.slice(0, 8));
    expect(collapsed.stdout).not.toContain(parentId.slice(0, 8));
    expect(collapsed.stdout).toContain(childId.slice(0, 8));
    expect(collapsed.stdout).toContain("ignored");
    expect(expanded.stdout).toContain(rootId.slice(0, 8));
    expect(expanded.stdout).toContain(parentId.slice(0, 8));
    expect(expanded.stdout).toContain(childId.slice(0, 8));
    expect(defaultIgnoredGrep.stdout).not.toContain(rootId.slice(0, 8));
    expect(defaultVisibleGrep.stdout).not.toContain(parentId.slice(0, 8));
    expect(expandedIgnoredGrep.stdout).toContain(rootId.slice(0, 8));
    expect(expandedIgnoredGrep.stdout).toContain("[superseded]");
    expect(expandedVisibleGrep.stdout).toContain(parentId.slice(0, 8));
    expect(expandedVisibleGrep.stdout).toContain("[superseded]");
    await expect(getConversationById(rootId)).resolves.toBeNull();
    await expect(getConversationById(parentId)).resolves.toBeNull();
    await expect(getConversationById(childId)).resolves.toBeNull();
  });

  it("keeps filtered-out children in the branch graph for list --all grep", async () => {
    const parentId = "d5010001-4444-4444-4444-444444444444";
    const childId = "d5010002-4444-4444-4444-444444444444";
    await insertConversation(savedConversation(parentId, "/managed/parent.jsonl", {
      title: "Filtered superseded parent",
      createdAt: "2026-01-01T00:00:00.000Z",
      sourceMtime: "2026-01-01T00:00:00.000Z",
      relationshipInspection: {
        status: "none_found",
        version: 2,
        diagnostic: null,
      },
    }));
    await insertConversation(savedConversation(childId, "/managed/child.jsonl", {
      title: "Current child in another project",
      projectName: "other",
      projectPath: "/Users/alice/work/other",
      createdAt: "2026-02-01T00:00:00.000Z",
      sourceMtime: "2026-02-01T00:00:00.000Z",
      relationshipInspection: {
        status: "linked",
        version: 2,
        diagnostic: null,
      },
      relationships: [{
        kind: "branch",
        parent: { source: "claude-code", sourceId: parentId },
        evidence: "source",
        branchPoint: null,
      }],
    }));
    vi.spyOn(adapterRegistry, "getEnabledAdapters").mockReturnValue([{
      ...TEST_ADAPTER_CONTRACT,
      name: "claude-code",
      watchPaths: () => [],
      async *discover() {},
    }]);
    await saveConfig(scanConfig());

    const collapsed = await captureOutput(async () => {
      const command = buildListCommand();
      command.exitOverride();
      await command.parseAsync(
        ["--all", "--project", "app", "--grep", "filtered superseded"],
        { from: "user" },
      );
    });
    const expanded = await captureOutput(async () => {
      const command = buildListCommand();
      command.exitOverride();
      await command.parseAsync(
        [
          "--all",
          "--all-branches",
          "--project",
          "app",
          "--grep",
          "filtered superseded",
        ],
        { from: "user" },
      );
    });

    expect(collapsed.stdout).not.toContain(parentId.slice(0, 8));
    expect(expanded.stdout).toContain(parentId.slice(0, 8));
    expect(expanded.stdout).toContain("[superseded]");
  });

  it("merges a matching ignored source observation into its saved list row", async () => {
    const parentId = "d5111111-4444-4444-4444-444444444444";
    const childId = "d5222222-4444-4444-4444-444444444444";
    const parentPath = await writeClaudeConversation(
      parentId,
      "/Users/alice/work/app",
    );
    const currentParentTime = new Date("2026-03-01T00:00:00.000Z");
    await fs.utimes(parentPath, currentParentTime, currentParentTime);
    await fs.mkdir(process.env.CLOG_HOME!, { recursive: true });
    await fs.writeFile(
      path.join(process.env.CLOG_HOME!, "clogignore"),
      `${parentId}\n`,
    );
    await insertConversation(savedConversation(parentId, parentPath, {
      title: "Curated saved parent",
      createdAt: "2026-01-01T00:00:00.000Z",
      sourceMtime: "2026-01-01T00:00:00.000Z",
      relationshipInspection: {
        status: "none_found",
        version: 2,
        diagnostic: null,
      },
    }));
    await insertConversation(savedConversation(
      childId,
      "/managed/child.jsonl",
      {
        title: "Saved child",
        createdAt: "2026-02-01T00:00:00.000Z",
        sourceMtime: "2026-02-02T00:00:00.000Z",
        relationshipInspection: {
          status: "linked",
          version: 2,
          diagnostic: null,
        },
        relationships: [{
          kind: "branch",
          parent: {
            source: "claude-code",
            sourceId: parentId,
          },
          evidence: "source",
          branchPoint: null,
        }],
      },
    ));
    await saveConfig(scanConfig());

    const collapsed = await captureOutput(async () => {
      const command = buildListCommand();
      command.exitOverride();
      await command.parseAsync(["--all"], { from: "user" });
    });
    const expanded = await captureOutput(async () => {
      const command = buildListCommand();
      command.exitOverride();
      await command.parseAsync(
        ["--all", "--all-branches"],
        { from: "user" },
      );
    });

    expect(collapsed.stdout).toContain(parentId.slice(0, 8));
    expect(collapsed.stdout).toContain("Curated saved parent");
    expect(collapsed.stdout).not.toContain(childId.slice(0, 8));
    expect(
      expanded.stdout
        .split("\n")
        .filter((line) => line.startsWith(parentId.slice(0, 8))),
    ).toHaveLength(1);
    expect(expanded.stdout).toContain(childId.slice(0, 8));
    expect(expanded.stdout).not.toContain("ignored");
    expect(expanded.stdout).not.toContain("[2 branches]");
    expect(expanded.stdout).toContain(
      `[parent ${parentId.slice(0, 8)}]`,
    );
  });

  it("does not discover local sources for the default saved-only list", async () => {
    const discover = vi.fn(async function* () {
      throw new Error("saved-only list must not scan");
    });
    vi.spyOn(adapterRegistry, "getEnabledAdapters").mockReturnValue([{
      ...TEST_ADAPTER_CONTRACT,
      name: "claude-code",
      watchPaths: () => [],
      discover,
    }]);
    await saveConfig(scanConfig());
    await insertConversation(savedConversation(
      "e5555555-5555-5555-5555-555555555555",
      "/managed/conversation.jsonl",
    ));

    await captureOutput(async () => {
      const command = buildListCommand();
      command.exitOverride();
      await command.parseAsync([], { from: "user" });
    });

    expect(discover).not.toHaveBeenCalled();
  });

  it("collapses saved branch graphs in list and restores concrete rows with --all-branches", async () => {
    const parentId = "e6000001-0000-0000-0000-000000000001";
    const firstChildId = "e6000002-0000-0000-0000-000000000002";
    const secondChildId = "e6000003-0000-0000-0000-000000000003";
    const parent = savedConversation(parentId, "/managed/parent.jsonl", {
      title: "Parent",
      createdAt: "2026-01-01T00:00:00.000Z",
      sourceMtime: "2026-01-01T00:00:00.000Z",
    });
    const childRelationship = {
      kind: "branch" as const,
      parent: { source: "claude-code", sourceId: parentId },
      evidence: "source" as const,
      branchPoint: null,
    };
    await insertConversation(parent);
    await insertConversation(savedConversation(firstChildId, "/managed/first.jsonl", {
      title: "First child",
      createdAt: "2026-01-02T00:00:00.000Z",
      sourceMtime: "2026-01-03T00:00:00.000Z",
      relationshipInspection: {
        status: "linked",
        version: 2,
        diagnostic: null,
      },
      relationships: [childRelationship],
    }));
    await insertConversation(savedConversation(secondChildId, "/managed/second.jsonl", {
      title: "Second child",
      createdAt: "2026-01-03T00:00:00.000Z",
      sourceMtime: "2026-01-04T00:00:00.000Z",
      relationshipInspection: {
        status: "linked",
        version: 2,
        diagnostic: null,
      },
      relationships: [childRelationship],
    }));

    const collapsed = await captureOutput(async () => {
      const command = buildListCommand();
      command.exitOverride();
      await command.parseAsync([], { from: "user" });
    });
    const expanded = await captureOutput(async () => {
      const command = buildListCommand();
      command.exitOverride();
      await command.parseAsync(["--all-branches"], { from: "user" });
    });

    expect(collapsed.stdout).not.toContain(parentId.slice(0, 8));
    expect(collapsed.stdout).not.toContain(firstChildId.slice(0, 8));
    expect(collapsed.stdout).toContain(secondChildId.slice(0, 8));
    expect(collapsed.stdout).toContain("[2 branches]");
    expect(collapsed.stdout).toContain(
      "Conversations marked with a branch count show the most recently updated branch.",
    );
    expect(collapsed.stdout).toContain("clog list --all-branches");
    expect(expanded.stdout).toContain(parentId.slice(0, 8));
    expect(expanded.stdout).toContain(firstChildId.slice(0, 8));
    expect(expanded.stdout).toContain(secondChildId.slice(0, 8));
    expect(expanded.stdout).not.toContain("[2 branches]");
    expect(expanded.stdout).not.toContain(
      "Conversations marked with a branch count show the most recently updated branch.",
    );
    expect(expanded.stdout).toContain("[superseded]");
    expect(
      expanded.stdout.match(
        new RegExp(`\\[parent ${parentId.slice(0, 8)}\\]`, "g"),
      ),
    ).toHaveLength(2);
  });

  it("marks a collapsed row whose branch history is incomplete", async () => {
    const childId = "e6100001-0000-4000-8000-000000000001";
    const missingParentId = "e6100002-0000-4000-8000-000000000002";
    await insertConversation(savedConversation(
      childId,
      "/managed/missing-parent-child.jsonl",
      {
        title: "Child with unavailable parent",
        relationshipInspection: {
          status: "linked",
          version: 2,
          diagnostic: null,
        },
        relationships: [{
          kind: "branch",
          parent: {
            source: "claude-code",
            sourceId: missingParentId,
          },
          evidence: "source",
          branchPoint: null,
        }],
      },
    ));

    const output = await captureOutput(async () => {
      const command = buildListCommand();
      command.exitOverride();
      await command.parseAsync([], { from: "user" });
    });

    expect(output.stdout).toContain(childId.slice(0, 8));
    expect(output.stdout).toContain("[incomplete branch history]");
  });

  it("identifies conversations with invalid branch metadata in list warnings", async () => {
    const id = "e6111111-0000-4000-8000-000000000001";
    await insertConversation(savedConversation(id, "/managed/self-parent.jsonl", {
      relationshipInspection: {
        status: "linked",
        version: 2,
        diagnostic: null,
      },
      relationships: [{
        kind: "branch",
        parent: {
          source: "claude-code",
          sourceId: id,
        },
        evidence: "source",
        branchPoint: null,
      }],
    }));

    const output = await captureOutput(async () => {
      const command = buildListCommand();
      command.exitOverride();
      await command.parseAsync([], { from: "user" });
    });

    expect(output.stderr).toContain(
      "A conversation identifies itself as its branch parent.",
    );
    expect(output.stderr).toContain(
      `conversation=${id.slice(0, 8)}@claude-code`,
    );
    expect(output.stderr).toContain(
      "hint: Inspect the conversation's branch metadata in its source file before saving the conversation again.",
    );
  });

  it("leaves the current-schema database byte-identical after scan-backed reads", async () => {
    const id = "f6666666-6666-6666-6666-666666666666";
    const sourcePath = await writeClaudeConversation(id, "/Users/alice/work/app");
    await saveConfig(scanConfig());
    await insertConversation(savedConversation(id, sourcePath));
    const before = await fs.readFile(getClogDbPath());

    for (const [build, args] of [
      [buildListCommand, ["--all"]],
      [buildStatusCommand, []],
      [buildShowCommand, [id]],
      [buildDrainCommand, [id, "--output", path.join(tempDir, "read-only.zip")]],
    ] as const) {
      await captureOutput(async () => {
        const command = build();
        command.exitOverride();
        await command.parseAsync([...args], { from: "user" });
      });
    }
    await handleList({ state: "all" });

    await expect(fs.readFile(getClogDbPath())).resolves.toEqual(before);
  });

  it("uses a moved live source for status and persists the repaired path only when saving", async () => {
    const id = "f6777777-7777-7777-7777-777777777777";
    const currentSourcePath = await writeClaudeConversation(
      id,
      "/Users/alice/work/app",
      "Current live content",
    );
    const rawPath = path.join(process.env.CLOG_HOME!, "raw", "claude-code", `${id}.jsonl`);
    await writeJsonl(rawPath, [{
      type: "user",
      timestamp: "2026-02-01T10:00:00.000Z",
      cwd: "/Users/alice/work/app",
      message: { role: "user", content: "Older saved content" },
    }]);
    const staleSourcePath = path.join(tempDir, "old-location", `${id}.jsonl`);
    await insertConversation({
      ...savedConversation(id, staleSourcePath),
      filePath: rawPath,
    });
    await saveConfig(scanConfig());

    const status = await captureOutput(async () => {
      const command = buildStatusCommand();
      command.exitOverride();
      await command.parseAsync([], { from: "user" });
    });
    expect(status.stdout).toContain("Saved conversations whose source files changed:");
    await expect(getConversationById(id)).resolves.toMatchObject({
      sourcePath: staleSourcePath,
      saveVersion: 1,
    });

    await captureOutput(async () => {
      const command = buildSaveCommand();
      command.exitOverride();
      await command.parseAsync([id], { from: "user" });
    });

    await expect(getConversationById(id)).resolves.toMatchObject({
      sourcePath: currentSourcePath,
      saveVersion: 2,
    });
    await expect(fs.readFile(rawPath)).resolves.toEqual(await fs.readFile(currentSourcePath));
  });

  it("leaves a direct saved target unchanged when its source adapter is incomplete", async () => {
    const id = "f6888888-8888-8888-8888-888888888888";
    const rawPath = path.join(process.env.CLOG_HOME!, "raw", "claude-code", `${id}.jsonl`);
    await writeJsonl(rawPath, [{
      type: "user",
      timestamp: "2026-02-01T10:00:00.000Z",
      cwd: "/Users/alice/work/app",
      message: { role: "user", content: "Saved content" },
    }]);
    await insertConversation({
      ...savedConversation(id, path.join(tempDir, "missing-source.jsonl")),
      filePath: rawPath,
    });
    const incomplete: SourceAdapter = {
      ...TEST_ADAPTER_CONTRACT,
      name: "claude-code",
      watchPaths: () => [],
      async *discover() {
        throw new Error("adapter unavailable");
      },
    };
    vi.spyOn(adapterRegistry, "getEnabledAdapters").mockReturnValue([incomplete]);
    await saveConfig(scanConfig());
    const beforeRow = await getConversationById(id);
    const beforeRaw = await fs.readFile(rawPath);
    const beforeDb = await fs.readFile(getClogDbPath());

    await expect(captureOutput(async () => {
      const command = buildSaveCommand();
      command.exitOverride();
      await command.parseAsync([id], { from: "user" });
    })).rejects.toThrow(/could not determine/i);

    await expect(getConversationById(id)).resolves.toEqual(beforeRow);
    await expect(fs.readFile(rawPath)).resolves.toEqual(beforeRaw);
    await expect(fs.readFile(getClogDbPath())).resolves.toEqual(beforeDb);
  });

  it("shares one adapter discovery pass across save --all", async () => {
    const id = "a7777777-7777-7777-7777-777777777777";
    const sourcePath = await writeClaudeConversation(id, "/Users/alice/work/app");
    const discover = vi.fn(async function* () {
      yield {
        ...TEST_DISCOVERED_RELATIONSHIP_FIELDS,
        sourceId: id,
        sourcePath,
        metadata: {
          title: "Save once",
          summary: "",
          projectName: "app",
          projectPath: "/Users/alice/work/app",
          slug: null,
          createdAt: "2026-02-01T10:00:00.000Z",
        },
      };
    });
    vi.spyOn(adapterRegistry, "getEnabledAdapters").mockReturnValue([{
      ...TEST_ADAPTER_CONTRACT,
      name: "claude-code",
      watchPaths: () => [],
      discover,
    }]);
    const config = scanConfig();
    config.author = "current-save-author";
    config.defaultTags = [" Current ", "current", "Release"];
    await saveConfig(config);

    await captureOutput(async () => {
      const command = buildSaveCommand();
      command.exitOverride();
      await command.parseAsync(["--all"], { from: "user" });
    });

    expect(discover).toHaveBeenCalledOnce();
    await expect(getConversationById(id)).resolves.toMatchObject({
      state: "saved",
      author: "current-save-author",
      tags: ["current", "release"],
      transcriptProjectionVersion: 2,
      relationshipInspection: {
        status: "unknown",
        version: 1,
        diagnostic: "relationship_inspection_not_implemented",
      },
      relationships: [],
    });
  });

  it("save --all writes every concrete member of a discovered branch graph", async () => {
    const parentId = "a7878787-7878-7878-7878-787878787878";
    const childId = "a7979797-7979-7979-7979-797979797979";
    const parentPath = await writeClaudeConversation(
      parentId,
      "/Users/alice/work/app",
    );
    const childPath = await writeClaudeConversation(
      childId,
      "/Users/alice/work/app",
    );
    const relationship = {
      kind: "branch" as const,
      parent: {
        source: "claude-code",
        sourceId: parentId,
      },
      evidence: "source" as const,
      branchPoint: null,
    };
    const discovered = [
      {
        sourceId: parentId,
        sourcePath: parentPath,
        metadata: {
          title: "Branch parent",
          summary: "",
          projectName: "app",
          projectPath: "/Users/alice/work/app",
          slug: null,
          createdAt: "2026-02-01T10:00:00.000Z",
        },
        relationshipInspection: {
          status: "none_found" as const,
          version: 2,
          diagnostic: null,
        },
        relationships: [],
      },
      {
        sourceId: childId,
        sourcePath: childPath,
        metadata: {
          title: "Branch child",
          summary: "",
          projectName: "app",
          projectPath: "/Users/alice/work/app",
          slug: null,
          createdAt: "2026-02-02T10:00:00.000Z",
        },
        relationshipInspection: {
          status: "linked" as const,
          version: 2,
          diagnostic: null,
        },
        relationships: [relationship],
      },
    ];
    vi.spyOn(adapterRegistry, "getEnabledAdapters").mockReturnValue([{
      ...TEST_ADAPTER_CONTRACT,
      name: "claude-code",
      relationshipInspectionVersion: 2,
      watchPaths: () => [],
      async *discover() {
        yield* discovered;
      },
    }]);
    await saveConfig(scanConfig());

    const output = await captureOutput(async () => {
      const command = buildSaveCommand();
      command.exitOverride();
      await command.parseAsync(["--all"], { from: "user" });
    });

    expect(output.stdout).toContain("Saved 2 conversation(s)");
    await expect(getConversationById(parentId)).resolves.toMatchObject({
      state: "saved",
      relationshipInspection: {
        status: "none_found",
        version: 2,
        diagnostic: null,
      },
    });
    await expect(getConversationById(childId)).resolves.toMatchObject({
      state: "saved",
      relationshipInspection: {
        status: "linked",
        version: 2,
        diagnostic: null,
      },
      relationships: [relationship],
    });
  });

  it("does not discover local sources for bare save", async () => {
    const discover = vi.fn(async function* () {
      throw new Error("bare save must not scan");
    });
    vi.spyOn(adapterRegistry, "getEnabledAdapters").mockReturnValue([{
      ...TEST_ADAPTER_CONTRACT,
      name: "claude-code",
      watchPaths: () => [],
      discover,
    }]);
    await saveConfig(scanConfig());

    await captureOutput(async () => {
      const command = buildSaveCommand();
      command.exitOverride();
      await command.parseAsync([], { from: "user" });
    });

    expect(discover).not.toHaveBeenCalled();
  });

  it("never changes an existing saved row while scanning", async () => {
    const id = "99999999-9999-9999-9999-999999999999";
    const sourcePath = await writeClaudeConversation(id, "/Users/alice/work/app");
    const saved = savedConversation(id, sourcePath);
    await insertConversation(saved);
    await writeClaudeConversation(id, "/Users/alice/work/app", "Changed source title");

    await scanLocalSources(scanConfig());

    await expect(getConversationById(id)).resolves.toEqual(saved);
  });

  function scanConfig() {
    const config = getDefaultConfig("alice");
    config.sources["claude-code"].paths = [sourceRoot];
    config.sources["codex-cli"].enabled = false;
    return config;
  }

  async function writeClaudeConversation(
    id: string,
    cwd: string,
    title = "Test conversation",
  ): Promise<string> {
    const filePath = path.join(sourceRoot, "project", `${id}.jsonl`);
    await writeJsonl(filePath, [
      {
        type: "user",
        timestamp: "2026-02-01T10:00:00.000Z",
        cwd,
        message: { role: "user", content: title },
      },
    ]);
    return filePath;
  }
});

function savedConversation(
  id: string,
  sourcePath: string,
  overrides: Partial<ReturnType<typeof savedConversationBase>> = {},
) {
  return { ...savedConversationBase(id, sourcePath), ...overrides };
}

function savedConversationBase(id: string, sourcePath: string) {
  const timestamp = "2026-02-01T10:00:00.000Z";
  return {
    id,
    sourceId: id,
    source: "claude-code",
    title: "Saved title",
    summary: "",
    summaryKind: "none" as const,
    summaryExtraction: null,
    author: "alice",
    projectName: "app",
    projectPath: "/Users/alice/work/app",
    tags: [],
    slug: null,
    createdAt: timestamp,
    discoveredAt: timestamp,
    modifiedAt: timestamp,
    state: "saved" as const,
    savedAt: timestamp,
    savedMessageCount: 1,
    saveVersion: 1,
    sourcePath,
    filePath: sourcePath,
    sourceMtime: timestamp,
    indexedAt: null,
    originKind: "local" as const,
    originRef: null,
    relationshipInspection: {
      status: "unexamined" as const,
      version: null,
      diagnostic: null,
    },
    relationships: [],
    transcriptProjectionVersion: 2,
  };
}
