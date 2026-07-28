import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SCAN_METADATA_MAX_LINES } from "../src/adapters/adapter.js";
import {
  CLAUDE_CODE_ADAPTER_VERSIONS,
  ClaudeCodeAdapter,
} from "../src/adapters/claude-code.js";
import { CodexCliAdapter } from "../src/adapters/codex-cli.js";
import { getAdapter } from "../src/adapters/registry.js";
import { scanLocalSources } from "../src/cli/scan.js";
import { getDefaultConfig } from "../src/config/index.js";
import type { ClogWarning } from "../src/models/warnings.js";
import { writeJsonl, writeRawJsonlLines } from "./helpers/fixtures.js";

interface ClaudeRelationshipFixture {
  origin: string;
  surface: string;
  childSourceId: string;
  parentSourceId?: string;
  ancestorSourceId?: string;
  unobservableParentSourceId?: string;
  expectedCreatedAt?: string;
  sourceRecords: Array<Record<string, unknown>>;
}

interface ClaudeRelationshipFixtureDocument {
  formatVersion: number;
  claudeCodeVersion: string;
  observedAt: string;
  cases: Record<string, ClaudeRelationshipFixture>;
}

const claudeRelationshipFixtures = JSON.parse(
  await fs.readFile(
    new URL("./fixtures/claude-code-relationships.json", import.meta.url),
    "utf8",
  ),
) as ClaudeRelationshipFixtureDocument;

describe("adapters", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clog-adapter-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("rejects unsupported source keys that collide with object prototype properties", () => {
    expect(() => getAdapter("constructor", getDefaultConfig("alice"))).toThrow(
      'Unsupported source "constructor"',
    );
  });

  it.each([
    "claude-code",
    "codex-cli",
  ] as const)("%s satisfies the shared adapter contract", async (source) => {
    const config = getDefaultConfig("alice");
    config.sources["claude-code"].enabled = source === "claude-code";
    config.sources["codex-cli"].enabled = source === "codex-cli";
    let filePath: string;

    if (source === "claude-code") {
      const sourceRoot = path.join(tempDir, "claude");
      filePath = path.join(
        sourceRoot,
        "project",
        "11111111-1111-1111-1111-111111111111.jsonl",
      );
      await writeJsonl(filePath, [{
        type: "user",
        timestamp: "2026-02-01T10:00:00.000Z",
        cwd: "/Users/alice/project",
        message: { role: "user", content: "Hello" },
      }]);
      config.sources["claude-code"].paths = [sourceRoot];
    } else {
      const sourceRoot = path.join(tempDir, "codex");
      filePath = path.join(
        sourceRoot,
        "sessions",
        "2026",
        "02",
        "01",
        "rollout-22222222-2222-2222-2222-222222222222.jsonl",
      );
      await writeJsonl(filePath, [{
        type: "session_meta",
        timestamp: "2026-02-01T10:00:00.000Z",
        payload: {
          id: "22222222-2222-2222-2222-222222222222",
          cli_version: "0.145.0",
          cwd: "/Users/alice/project",
          timestamp: "2026-02-01T10:00:00.000Z",
        },
      }]);
      config.sources["codex-cli"].paths = [sourceRoot];
    }

    const adapter = getAdapter(source, config);
    const inspect = vi.spyOn(adapter, "inspectRelationships");
    const discovered = [];
    for await (const conversation of adapter.discover()) {
      discovered.push(conversation);
    }
    const transcript = await adapter.parseTranscript(filePath);
    const expectedSourceMtime = (await fs.stat(filePath)).mtime.toISOString();
    const scan = await scanLocalSources(config);

    expect(adapter.relationshipInspectionVersion).toBeGreaterThan(0);
    expect(adapter.transcriptProjectionVersion).toBeGreaterThan(0);
    expect(inspect).toHaveBeenCalledOnce();
    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toMatchObject({
      relationshipInspection: {
        status: "none_found",
        version: adapter.relationshipInspectionVersion,
        diagnostic: null,
      },
      relationships: [],
    });
    expect(Array.isArray(transcript.messages)).toBe(true);
    expect(transcript.warnings).toEqual([]);
    expect(scan.candidates).toHaveLength(1);
    expect(scan.candidates[0]?.sourceMtime).toBe(expectedSourceMtime);
  });

  describe("Codex contextual branch inspection", () => {
    const parentId = "11111111-1111-1111-1111-111111111111";
    const childId = "22222222-2222-2222-2222-222222222222";
    const grandchildId = "33333333-3333-3333-3333-333333333333";
    const siblingId = "44444444-4444-4444-4444-444444444444";

    it.each(["0.144.0", "0.145.0"])(
      "marks a standalone Codex %s rollout as inspected with no relationship",
      async (cliVersion) => {
        const filePath = path.join(tempDir, `rollout-${childId}.jsonl`);
        await writeJsonl(filePath, [
          codexSessionMeta(childId, { cliVersion }),
        ]);

        const adapter = new CodexCliAdapter(getDefaultConfig("alice"));
        await expect(adapter.inspectRelationships(filePath)).resolves.toEqual({
          status: "none_found",
          version: adapter.relationshipInspectionVersion,
          diagnostic: null,
          relationships: [],
        });
      },
    );

    it("does not treat spawned-agent ownership as a branch relationship", async () => {
      const filePath = path.join(tempDir, `rollout-${childId}.jsonl`);
      await writeJsonl(filePath, [
        codexSessionMeta(childId, {
          parentThreadId: parentId,
          threadSource: "subagent",
        }),
      ]);

      const adapter = new CodexCliAdapter(getDefaultConfig("alice"));
      await expect(adapter.inspectRelationships(filePath)).resolves.toEqual({
        status: "none_found",
        version: adapter.relationshipInspectionVersion,
        diagnostic: null,
        relationships: [],
      });
    });

    it("creates a source-confirmed branch for a user-classified fork", async () => {
      const filePath = path.join(tempDir, `rollout-${childId}.jsonl`);
      await writeJsonl(filePath, [
        codexSessionMeta(childId, {
          cliVersion: "0.145.0",
          parentId,
          threadSource: "user",
        }),
      ]);

      const adapter = new CodexCliAdapter(getDefaultConfig("alice"));
      await expect(adapter.inspectRelationships(filePath)).resolves.toEqual({
        status: "linked",
        version: adapter.relationshipInspectionVersion,
        diagnostic: null,
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
    });

    it.each([
      {
        label: "a copied-history subagent",
        cliVersion: "0.145.0",
        threadSource: "subagent",
        parentThreadId: parentId,
      },
      {
        label: "a memory-consolidation thread",
        cliVersion: "0.145.0",
        threadSource: "memory_consolidation",
        parentThreadId: undefined,
      },
      {
        label: "a Codex 0.136.0 ownership-only subagent",
        cliVersion: "0.136.0",
        threadSource: "subagent",
        parentThreadId: undefined,
      },
    ])(
      "does not create a conversation branch for $label",
      async ({ cliVersion, threadSource, parentThreadId }) => {
        const filePath = path.join(tempDir, `rollout-${childId}.jsonl`);
        await writeJsonl(filePath, [
          codexSessionMeta(childId, {
            cliVersion,
            parentId,
            parentThreadId,
            threadSource,
          }),
        ]);

        const adapter = new CodexCliAdapter(getDefaultConfig("alice"));
        await expect(adapter.inspectRelationships(filePath)).resolves.toEqual({
          status: "none_found",
          version: adapter.relationshipInspectionVersion,
          diagnostic: null,
          relationships: [],
        });
      },
    );

    it.each([
      {
        label: "missing",
        cliVersion: "0.128.0",
        threadSource: undefined,
      },
      {
        label: "null",
        cliVersion: "0.145.0",
        threadSource: null,
      },
      {
        label: "feature-style",
        cliVersion: "0.145.0",
        threadSource: "experimental_feature",
      },
      {
        label: "non-string",
        cliVersion: "0.145.0",
        threadSource: { kind: "user" },
      },
    ])(
      "keeps a valid fork with $label provenance reviewable",
      async ({ cliVersion, threadSource }) => {
        const filePath = path.join(tempDir, `rollout-${childId}.jsonl`);
        await writeJsonl(filePath, [
          codexSessionMeta(childId, {
            cliVersion,
            parentId,
            threadSource,
          }),
        ]);

        const adapter = new CodexCliAdapter(getDefaultConfig("alice"));
        await expect(adapter.inspectRelationships(filePath)).resolves.toEqual({
          status: "unknown",
          version: adapter.relationshipInspectionVersion,
          diagnostic: "codex_relationship_fork_provenance_ambiguous",
          relationships: [],
        });
      },
    );

    it("uses only canonical metadata when copied ancestor metadata conflicts", async () => {
      const filePath = path.join(tempDir, `rollout-${childId}.jsonl`);
      await writeJsonl(filePath, [
        codexSessionMeta(childId, { parentId, threadSource: "user" }),
        codexSessionMeta(parentId, {
          parentId: grandchildId,
          threadSource: "subagent",
        }),
      ]);

      const adapter = new CodexCliAdapter(getDefaultConfig("alice"));
      await expect(adapter.inspectRelationships(filePath)).resolves.toEqual({
        status: "linked",
        version: adapter.relationshipInspectionVersion,
        diagnostic: null,
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
    });

    it("preserves immediate parents for chains, siblings, and absent parents", async () => {
      const adapter = new CodexCliAdapter(getDefaultConfig("alice"));
      const cases = [
        { id: childId, parentId },
        { id: grandchildId, parentId: childId },
        { id: siblingId, parentId },
        {
          id: "55555555-5555-5555-5555-555555555555",
          parentId: "99999999-9999-9999-9999-999999999999",
        },
      ];

      for (const fixture of cases) {
        const filePath = path.join(tempDir, `rollout-${fixture.id}.jsonl`);
        await writeJsonl(filePath, [
          codexSessionMeta(fixture.id, {
            parentId: fixture.parentId,
            threadSource: "user",
          }),
        ]);
        const inspection = await adapter.inspectRelationships(filePath);
        expect(inspection).toMatchObject({
          status: "linked",
          relationships: [{
            parent: {
              source: "codex-cli",
              sourceId: fixture.parentId,
            },
          }],
        });
      }
    });

    it("keeps malformed canonical parent evidence reviewable without an edge", async () => {
      const filePath = path.join(tempDir, `rollout-${childId}.jsonl`);
      await writeJsonl(filePath, [
        codexSessionMeta(childId, { parentId: "not-a-thread-id" }),
      ]);

      const adapter = new CodexCliAdapter(getDefaultConfig("alice"));
      await expect(adapter.inspectRelationships(filePath)).resolves.toEqual({
        status: "unknown",
        version: adapter.relationshipInspectionVersion,
        diagnostic: "codex_relationship_parent_id_invalid",
        relationships: [],
      });
    });

    it("rejects parent IDs that merely end with a UUID", async () => {
      const filePath = path.join(tempDir, `rollout-${childId}.jsonl`);
      await writeJsonl(filePath, [
        codexSessionMeta(childId, {
          parentId: `prefix${parentId}`,
        }),
      ]);

      const adapter = new CodexCliAdapter(getDefaultConfig("alice"));
      await expect(adapter.inspectRelationships(filePath)).resolves.toEqual({
        status: "unknown",
        version: adapter.relationshipInspectionVersion,
        diagnostic: "codex_relationship_parent_id_invalid",
        relationships: [],
      });
    });

    it("keeps a canonical self-parent relationship reviewable without an edge", async () => {
      const filePath = path.join(tempDir, `rollout-${childId}.jsonl`);
      await writeJsonl(filePath, [
        codexSessionMeta(childId, {
          parentId: childId,
          threadSource: "user",
        }),
      ]);

      const adapter = new CodexCliAdapter(getDefaultConfig("alice"));
      await expect(adapter.inspectRelationships(filePath)).resolves.toEqual({
        status: "unknown",
        version: adapter.relationshipInspectionVersion,
        diagnostic: "codex_relationship_self_parent",
        relationships: [],
      });
    });

    it("returns an unknown diagnostic for a structurally invalid JSONL record", async () => {
      const filePath = path.join(tempDir, `rollout-${childId}.jsonl`);
      await writeRawJsonlLines(filePath, ["null"]);

      const adapter = new CodexCliAdapter(getDefaultConfig("alice"));
      await expect(adapter.inspectRelationships(filePath)).resolves.toEqual({
        status: "unknown",
        version: adapter.relationshipInspectionVersion,
        diagnostic: "codex_relationship_malformed_jsonl",
        relationships: [],
      });
    });

    it("does not infer an edge for a first-prompt-style fresh thread", async () => {
      const filePath = path.join(tempDir, `rollout-${childId}.jsonl`);
      await writeJsonl(filePath, [
        codexSessionMeta(childId),
        {
          type: "response_item",
          timestamp: "2026-02-01T10:00:00.000Z",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Same first prompt" }],
          },
        },
      ]);

      const adapter = new CodexCliAdapter(getDefaultConfig("alice"));
      const inspection = await adapter.inspectRelationships(filePath);
      expect(inspection.status).toBe("none_found");
      expect(inspection.relationships).toEqual([]);
    });

    it("ignores replayed message timestamps when selecting the parent", async () => {
      const filePath = path.join(tempDir, `rollout-${childId}.jsonl`);
      await writeJsonl(filePath, [
        codexSessionMeta(childId, { parentId, threadSource: "user" }),
        {
          type: "response_item",
          timestamp: "2030-01-01T00:00:00.000Z",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Replayed prompt" }],
          },
        },
      ]);

      const adapter = new CodexCliAdapter(getDefaultConfig("alice"));
      const inspection = await adapter.inspectRelationships(filePath);
      expect(inspection.relationships[0]?.parent.sourceId).toBe(parentId);
      expect(inspection.relationships[0]?.branchPoint).toBeNull();
    });

    it("keeps relationship inspection within the metadata line bound", async () => {
      const filePath = path.join(tempDir, `rollout-${childId}.jsonl`);
      await writeRawJsonlLines(filePath, [
        jsonLine(codexSessionMeta(childId, {
          parentId,
          threadSource: "user",
        })),
        ...validJsonlPadding(SCAN_METADATA_MAX_LINES - 1),
        "{not: valid json",
      ]);

      const adapter = new CodexCliAdapter(getDefaultConfig("alice"));
      const inspection = await adapter.inspectRelationships(filePath);
      expect(inspection.status).toBe("linked");
      expect(inspection.relationships[0]?.parent.sourceId).toBe(parentId);
    });

    it("continues discovery after a structurally invalid Codex file", async () => {
      const sessionsDir = path.join(
        tempDir,
        ".codex",
        "sessions",
        "2026",
        "02",
        "01",
      );
      const malformedPath = path.join(
        sessionsDir,
        `rollout-${childId}.jsonl`,
      );
      const validPath = path.join(
        sessionsDir,
        `rollout-${grandchildId}.jsonl`,
      );
      await writeRawJsonlLines(malformedPath, ["null"]);
      await writeJsonl(validPath, [
        codexSessionMeta(grandchildId),
        {
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "Valid conversation",
          },
        },
      ]);

      const config = getDefaultConfig("alice");
      config.sources["codex-cli"].paths = [path.join(tempDir, ".codex")];
      const warnings: ClogWarning[] = [];
      const adapter = new CodexCliAdapter(config);
      const discovered = await collect(
        adapter.discover({
          onWarning: (warning) => warnings.push(warning),
        }),
      );

      expect(discovered).toHaveLength(1);
      expect(discovered[0]?.sourceId).toBe(grandchildId);
      expect(warnings).toEqual([expect.objectContaining({
        code: "malformed_jsonl",
        path: malformedPath,
      })]);
    });
  });

  describe("Claude Code cross-session branch inspection", () => {
    it.each([
      ["slashBranch", "source"],
      ["forkSession", "inferred"],
    ] as const)(
      "uses the observed %s provenance and discovers the fork moment",
      async (fixtureName, evidence) => {
        const fixture = claudeRelationshipFixtures.cases[fixtureName]!;
        const sourceRoot = path.join(tempDir, "claude");
        const filePath = path.join(
          sourceRoot,
          "project",
          `${fixture.childSourceId}.jsonl`,
        );
        await writeJsonl(filePath, fixture.sourceRecords);

        const config = getDefaultConfig("alice");
        config.sources["claude-code"].paths = [sourceRoot];
        const adapter = new ClaudeCodeAdapter(config);
        const inspect = vi.spyOn(adapter, "inspectRelationships");
        const discovered = await collect(adapter.discover());

        expect(inspect).toHaveBeenCalledOnce();
        expect(discovered).toHaveLength(1);
        expect(discovered[0]).toMatchObject({
          sourceId: fixture.childSourceId,
          metadata: {
            createdAt: fixture.expectedCreatedAt,
          },
          relationshipInspection: {
            status: "linked",
            version: CLAUDE_CODE_ADAPTER_VERSIONS.relationshipInspection,
            diagnostic: null,
          },
          relationships: [{
            kind: "branch",
            parent: {
              source: "claude-code",
              sourceId: fixture.parentSourceId,
            },
            evidence,
            branchPoint: null,
          }],
        });
      },
    );

    it("uses the newest copied foreign session ID in a multi-generation fallback", async () => {
      const fixture =
        claudeRelationshipFixtures.cases.multiGenerationChain!;
      const filePath = path.join(
        tempDir,
        `${fixture.childSourceId}.jsonl`,
      );
      const records = fixture.sourceRecords.map((record) => {
        const { forkedFrom: _forkedFrom, ...withoutForkedFrom } = record;
        return withoutForkedFrom;
      });
      await writeJsonl(filePath, records);

      const adapter = new ClaudeCodeAdapter(getDefaultConfig("alice"));
      await expect(adapter.inspectRelationships(filePath)).resolves.toMatchObject({
        status: "linked",
        relationships: [{
          parent: {
            source: "claude-code",
            sourceId: fixture.parentSourceId,
          },
          evidence: "inferred",
        }],
      });
    });

    it("prefers source provenance over incidental multi-generation session IDs", async () => {
      const fixture =
        claudeRelationshipFixtures.cases.multiGenerationChain!;
      const filePath = path.join(
        tempDir,
        `${fixture.childSourceId}.jsonl`,
      );
      await writeJsonl(filePath, fixture.sourceRecords);

      const adapter = new ClaudeCodeAdapter(getDefaultConfig("alice"));
      await expect(adapter.inspectRelationships(filePath)).resolves.toMatchObject({
        status: "linked",
        relationships: [{
          parent: {
            source: "claude-code",
            sourceId: fixture.parentSourceId,
          },
          evidence: "source",
        }],
      });
    });

    it("reports none_found for an observed provenance-free fork", async () => {
      const fixture =
        claudeRelationshipFixtures.cases.provenanceFreeFork!;
      const filePath = path.join(
        tempDir,
        `${fixture.childSourceId}.jsonl`,
      );
      await writeJsonl(filePath, fixture.sourceRecords);

      const adapter = new ClaudeCodeAdapter(getDefaultConfig("alice"));
      await expect(adapter.inspectRelationships(filePath)).resolves.toEqual({
        status: "none_found",
        version: CLAUDE_CODE_ADAPTER_VERSIONS.relationshipInspection,
        diagnostic: null,
        relationships: [],
      });
    });

    it("inspects consistent source provenance across a long copied prefix", async () => {
      const childId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const parentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const sourceRoot = path.join(tempDir, "claude");
      const filePath = path.join(
        sourceRoot,
        "project",
        `${childId}.jsonl`,
      );
      const copiedRecords = Array.from({ length: 150 }, (_entry, index) => {
        const uuid =
          `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
        return {
          type: "assistant",
          uuid,
          timestamp: `2026-07-24T08:${String(index % 60).padStart(2, "0")}:00.000Z`,
          sessionId: childId,
          forkedFrom: {
            sessionId: parentId,
            messageUuid: uuid,
          },
        };
      });
      await writeJsonl(filePath, [
        ...copiedRecords,
        {
          type: "user",
          uuid: "20000000-0000-4000-8000-000000000001",
          timestamp: "2026-07-24T11:00:00.000Z",
          sessionId: childId,
          message: { role: "user", content: "Continue here" },
        },
      ]);

      const config = getDefaultConfig("alice");
      config.sources["claude-code"].paths = [sourceRoot];
      const adapter = new ClaudeCodeAdapter(config);
      await expect(adapter.inspectRelationships(filePath)).resolves.toMatchObject({
        status: "linked",
        relationships: [{
          parent: { sourceId: parentId },
          evidence: "source",
        }],
      });
      const discovered = await collect(adapter.discover());
      expect(discovered[0]?.metadata.createdAt).toBe(
        "2026-07-24T11:00:00.000Z",
      );
    });

    it("keeps conflicting source parents reviewable without an edge", async () => {
      const childId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const filePath = path.join(tempDir, `${childId}.jsonl`);
      await writeJsonl(filePath, [
        claudeForkedRecord(
          childId,
          "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          "10000000-0000-4000-8000-000000000001",
        ),
        claudeForkedRecord(
          childId,
          "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          "10000000-0000-4000-8000-000000000002",
        ),
        { type: "user", timestamp: "2026-07-24T11:00:00.000Z" },
      ]);

      const adapter = new ClaudeCodeAdapter(getDefaultConfig("alice"));
      await expect(adapter.inspectRelationships(filePath)).resolves.toEqual({
        status: "unknown",
        version: CLAUDE_CODE_ADAPTER_VERSIONS.relationshipInspection,
        diagnostic: "claude_relationship_parent_conflict",
        relationships: [],
      });
    });

    it("keeps malformed parent-session provenance reviewable without an edge", async () => {
      const childId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const filePath = path.join(tempDir, `${childId}.jsonl`);
      await writeJsonl(filePath, [
        claudeForkedRecord(
          childId,
          "not-a-session-id",
          "10000000-0000-4000-8000-000000000001",
        ),
        { type: "user", timestamp: "2026-07-24T11:00:00.000Z" },
      ]);

      const adapter = new ClaudeCodeAdapter(getDefaultConfig("alice"));
      await expect(adapter.inspectRelationships(filePath)).resolves.toEqual({
        status: "unknown",
        version: CLAUDE_CODE_ADAPTER_VERSIONS.relationshipInspection,
        diagnostic: "claude_relationship_parent_id_invalid",
        relationships: [],
      });
    });

    it("keeps source provenance that names the child as its own parent reviewable without an edge", async () => {
      const childId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const filePath = path.join(tempDir, `${childId}.jsonl`);
      await writeJsonl(filePath, [
        claudeForkedRecord(
          childId,
          childId,
          "10000000-0000-4000-8000-000000000001",
        ),
        { type: "user", timestamp: "2026-07-24T11:00:00.000Z" },
      ]);

      const adapter = new ClaudeCodeAdapter(getDefaultConfig("alice"));
      await expect(adapter.inspectRelationships(filePath)).resolves.toEqual({
        status: "unknown",
        version: CLAUDE_CODE_ADAPTER_VERSIONS.relationshipInspection,
        diagnostic: "claude_relationship_self_parent",
        relationships: [],
      });
    });

    it("ignores malformed unused source-message provenance", async () => {
      const childId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const parentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const filePath = path.join(tempDir, `${childId}.jsonl`);
      const record = claudeForkedRecord(
        childId,
        parentId,
        "10000000-0000-4000-8000-000000000001",
      );
      (record.forkedFrom as { messageUuid: unknown }).messageUuid = 42;
      await writeJsonl(filePath, [
        record,
        { type: "user", timestamp: "2026-07-24T11:00:00.000Z" },
      ]);

      const adapter = new ClaudeCodeAdapter(getDefaultConfig("alice"));
      await expect(adapter.inspectRelationships(filePath)).resolves.toMatchObject({
        status: "linked",
        relationships: [{
          parent: { sourceId: parentId },
          evidence: "source",
          branchPoint: null,
        }],
      });
    });

    it.each([
      [
        "same-file rewind",
        [
          {
            type: "user",
            uuid: "10000000-0000-4000-8000-000000000001",
            parentUuid: null,
            sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          },
          {
            type: "user",
            uuid: "10000000-0000-4000-8000-000000000002",
            parentUuid: "10000000-0000-4000-8000-000000000001",
            sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          },
          {
            type: "user",
            uuid: "10000000-0000-4000-8000-000000000003",
            parentUuid: "10000000-0000-4000-8000-000000000001",
            sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          },
        ],
      ],
      [
        "compaction ancestry",
        [{
          type: "system",
          subtype: "compact_boundary",
          uuid: "10000000-0000-4000-8000-000000000004",
          parentUuid: null,
          logicalParentUuid: "10000000-0000-4000-8000-000000000001",
          sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        }],
      ],
      [
        "subagent ownership",
        [{
          type: "assistant",
          isSidechain: true,
          agentId: "agent-1",
          uuid: "10000000-0000-4000-8000-000000000005",
          sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          session_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        }],
      ],
    ] as const)(
      "does not treat %s as a conversation relationship",
      async (_name, records) => {
        const childId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        const filePath = path.join(tempDir, `${childId}.jsonl`);
        await writeJsonl(filePath, [...records]);

        const adapter = new ClaudeCodeAdapter(getDefaultConfig("alice"));
        await expect(adapter.inspectRelationships(filePath)).resolves.toEqual({
          status: "none_found",
          version: CLAUDE_CODE_ADAPTER_VERSIONS.relationshipInspection,
          diagnostic: null,
          relationships: [],
        });
      },
    );

    it("uses file time when a source-confirmed child has no self-written record", async () => {
      const childId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const parentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const sourceRoot = path.join(tempDir, "claude");
      const filePath = path.join(sourceRoot, "project", `${childId}.jsonl`);
      await writeJsonl(filePath, [
        claudeForkedRecord(
          childId,
          parentId,
          "10000000-0000-4000-8000-000000000001",
        ),
      ]);
      const expectedMtime = (await fs.stat(filePath)).mtime.toISOString();

      const config = getDefaultConfig("alice");
      config.sources["claude-code"].paths = [sourceRoot];
      const adapter = new ClaudeCodeAdapter(config);
      const discovered = await collect(adapter.discover());

      expect(discovered[0]?.metadata.createdAt).toBe(expectedMtime);
      expect(discovered[0]?.relationships[0]).toMatchObject({
        parent: { sourceId: parentId },
        evidence: "source",
      });
    });
  });

  it("Claude discovery extracts metadata from the first cwd and summary line", async () => {
    const filePath = path.join(
      tempDir,
      "claude",
      "-Users-alice-api-service",
      "c7044ea5-c019-44d6-a77a-500036740f9a.jsonl",
    );

    await writeJsonl(filePath, [
      {
        type: "user",
        timestamp: "2026-02-01T10:00:00.000Z",
        cwd: "/Users/alice/api-service",
        slug: "breezy-coalescing-pony",
        message: {
          role: "user",
          content: "Debug auth token refresh logic",
        },
      },
      {
        type: "user",
        cwd: "/Users/alice/api-service/subdir",
        message: {
          role: "user",
          content: "Another prompt",
        },
      },
      {
        type: "summary",
        summary: "Walked through auth token refresh behavior.",
      },
    ]);

    const config = getDefaultConfig("alice");
    config.sources["claude-code"].paths = [path.join(tempDir, "claude")];
    const adapter = new ClaudeCodeAdapter(config);

    const discovered = await collect(adapter.discover());
    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.metadata).toEqual({
      title: "Debug auth token refresh logic",
      summary: "Walked through auth token refresh behavior.",
      projectName: "api-service",
      projectPath: "/Users/alice/api-service",
      slug: "breezy-coalescing-pony",
      createdAt: "2026-02-01T10:00:00.000Z",
    });
  });

  it("Claude discovery stops at the metadata line bound when summary and slug are absent", async () => {
    const filePath = path.join(
      tempDir,
      "claude",
      "-Users-alice-api-service",
      "c7044ea5-c019-44d6-a77a-500036740f9d.jsonl",
    );

    await writeRawJsonlLines(filePath, [
      jsonLine({
        type: "user",
        timestamp: "2026-02-01T10:00:00.000Z",
        cwd: "/Users/alice/api-service",
        message: {
          role: "user",
          content: "Debug auth token refresh logic",
        },
      }),
      ...validJsonlPadding(SCAN_METADATA_MAX_LINES - 1),
      "{not: valid json",
    ]);

    const warnings: ClogWarning[] = [];
    const config = getDefaultConfig("alice");
    config.sources["claude-code"].paths = [path.join(tempDir, "claude")];
    const adapter = new ClaudeCodeAdapter(config);

    const discovered = await collect(
      adapter.discover({ onWarning: (warning) => warnings.push(warning) }),
    );

    expect(warnings).toEqual([]);
    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.metadata).toMatchObject({
      title: "Debug auth token refresh logic",
      summary: "",
      projectName: "api-service",
      projectPath: "/Users/alice/api-service",
      slug: null,
      createdAt: "2026-02-01T10:00:00.000Z",
    });
  });

  it("Claude discovery warns and skips when malformed JSONL appears before metadata discovery stops", async () => {
    const filePath = path.join(
      tempDir,
      "claude",
      "-Users-alice-api-service",
      "c7044ea5-c019-44d6-a77a-500036740f9e.jsonl",
    );

    await writeRawJsonlLines(filePath, [
      jsonLine({
        type: "user",
        timestamp: "2026-02-01T10:00:00.000Z",
        cwd: "/Users/alice/api-service",
        message: {
          role: "user",
          content: "Debug auth token refresh logic",
        },
      }),
      "{not: valid json",
    ]);

    const warnings: ClogWarning[] = [];
    const config = getDefaultConfig("alice");
    config.sources["claude-code"].paths = [path.join(tempDir, "claude")];
    const adapter = new ClaudeCodeAdapter(config);

    const discovered = await collect(
      adapter.discover({ onWarning: (warning) => warnings.push(warning) }),
    );

    expect(discovered).toEqual([]);
    expect(warnings.map((warning) => warning.code)).toEqual(["malformed_jsonl"]);
  });

  it("Claude discovery skips hidden local-command wrapper text when deriving titles", async () => {
    const filePath = path.join(
      tempDir,
      "claude",
      "-Users-alice-api-service",
      "c7044ea5-c019-44d6-a77a-500036740f9b.jsonl",
    );

    await writeJsonl(filePath, [
      {
        type: "user",
        timestamp: "2026-02-01T10:00:00.000Z",
        cwd: "/Users/alice/api-service",
        message: {
          role: "user",
          content:
            "<local-command-caveat>\nHidden model-only wrapper\n</local-command-caveat>",
        },
      },
      {
        type: "user",
        timestamp: "2026-02-01T10:00:01.000Z",
        message: {
          role: "user",
          content: "Debug auth token refresh logic",
        },
      },
    ]);

    const config = getDefaultConfig("alice");
    config.sources["claude-code"].paths = [path.join(tempDir, "claude")];
    const adapter = new ClaudeCodeAdapter(config);

    const discovered = await collect(adapter.discover());
    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.metadata.title).toBe("Debug auth token refresh logic");
  });

  it("Claude discovery renders visible local-command wrappers into plain title text", async () => {
    const filePath = path.join(
      tempDir,
      "claude",
      "-Users-alice-api-service",
      "c7044ea5-c019-44d6-a77a-500036740f9c.jsonl",
    );

    await writeJsonl(filePath, [
      {
        type: "user",
        timestamp: "2026-02-01T10:00:00.000Z",
        cwd: "/Users/alice/api-service",
        message: {
          role: "user",
          content:
            "<local-command-caveat>\nHidden model-only wrapper\n</local-command-caveat>",
        },
      },
      {
        type: "user",
        timestamp: "2026-02-01T10:00:01.000Z",
        message: {
          role: "user",
          content:
            "<command-name>/copy</command-name>\n            <command-message>copy</command-message>\n            <command-args></command-args>",
        },
      },
    ]);

    const config = getDefaultConfig("alice");
    config.sources["claude-code"].paths = [path.join(tempDir, "claude")];
    const adapter = new ClaudeCodeAdapter(config);

    const discovered = await collect(adapter.discover());
    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.metadata.title).toBe("/copy");
  });

  it("Claude full parsing deduplicates assistant message ids and strips thinking", async () => {
    const filePath = path.join(tempDir, "claude-parse.jsonl");

    await writeJsonl(filePath, [
      {
        type: "user",
        timestamp: "2026-02-01T10:00:00.000Z",
        message: { role: "user", content: "Read the config file" },
      },
      {
        type: "assistant",
        timestamp: "2026-02-01T10:00:01.000Z",
        message: {
          id: "msg_1",
          role: "assistant",
          content: [{ type: "text", text: "I will inspect it." }],
        },
      },
      {
        type: "assistant",
        timestamp: "2026-02-01T10:00:01.000Z",
        message: {
          id: "msg_1",
          role: "assistant",
          content: [{ type: "thinking", thinking: "internal" }],
        },
      },
      {
        type: "assistant",
        timestamp: "2026-02-01T10:00:01.000Z",
        message: {
          id: "msg_1",
          role: "assistant",
          content: [{ type: "tool_use", id: "tool_1", name: "Read", input: { file_path: "src/config.ts" } }],
        },
      },
      {
        type: "user",
        timestamp: "2026-02-01T10:00:02.000Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool_1", content: "..." }],
        },
      },
    ]);

    const adapter = new ClaudeCodeAdapter(getDefaultConfig("alice"));
    const messages = (await adapter.parseTranscript(filePath)).messages;

    expect(messages).toEqual([
      {
        role: "user",
        content: "Read the config file",
        timestamp: "2026-02-01T10:00:00.000Z",
      },
      {
        role: "assistant",
        content: "I will inspect it.",
        timestamp: "2026-02-01T10:00:01.000Z",
      },
      {
        role: "tool_use",
        content: 'Read: {"file_path":"src/config.ts"}',
        timestamp: "2026-02-01T10:00:01.000Z",
        toolName: "Read",
        toolInput: { file_path: "src/config.ts" },
      },
      {
        role: "tool_result",
        content: "Read: ok",
        timestamp: "2026-02-01T10:00:02.000Z",
        toolName: "Read",
      },
    ]);
  });

  it("Claude parsing strips hidden local-command wrapper text from canonical user messages", async () => {
    const filePath = path.join(tempDir, "claude-strip-wrappers.jsonl");

    await writeJsonl(filePath, [
      {
        type: "user",
        timestamp: "2026-02-01T10:00:00.000Z",
        message: {
          role: "user",
          content:
            "<local-command-caveat>\nHidden model-only wrapper\n</local-command-caveat>\n\nPlease explain the auth flow.",
        },
      },
    ]);

    const adapter = new ClaudeCodeAdapter(getDefaultConfig("alice"));
    const messages = (await adapter.parseTranscript(filePath)).messages;

    expect(messages).toEqual([
      {
        role: "user",
        content: "Please explain the auth flow.",
        timestamp: "2026-02-01T10:00:00.000Z",
      },
    ]);
  });

  it("Claude parsing renders visible local-command wrappers as plain user text", async () => {
    const filePath = path.join(tempDir, "claude-local-command.jsonl");

    await writeJsonl(filePath, [
      {
        type: "user",
        timestamp: "2026-02-01T10:00:00.000Z",
        message: {
          role: "user",
          content:
            "<local-command-caveat>\nHidden model-only wrapper\n</local-command-caveat>",
        },
      },
      {
        type: "user",
        timestamp: "2026-02-01T10:00:00.000Z",
        message: {
          role: "user",
          content:
            "<command-name>/copy</command-name>\n            <command-message>copy</command-message>\n            <command-args></command-args>",
        },
      },
      {
        type: "user",
        timestamp: "2026-02-01T10:00:00.000Z",
        message: {
          role: "user",
          content:
            "<local-command-stdout>Copied to clipboard (2983 characters, 35 lines)\nAlso written to /tmp/claude/response.md</local-command-stdout>",
        },
      },
    ]);

    const adapter = new ClaudeCodeAdapter(getDefaultConfig("alice"));
    const messages = (await adapter.parseTranscript(filePath)).messages;

    expect(messages).toEqual([
      {
        role: "user",
        content: "/copy",
        timestamp: "2026-02-01T10:00:00.000Z",
      },
      {
        role: "user",
        content: "Copied to clipboard (2983 characters, 35 lines)\nAlso written to /tmp/claude/response.md",
        timestamp: "2026-02-01T10:00:00.000Z",
      },
    ]);
  });

  it("Codex discovery normalizes a codex home path and prefers user_message title text", async () => {
    const sessionsDir = path.join(tempDir, ".codex", "sessions", "2026", "02", "01");
    const filePath = path.join(
      sessionsDir,
      "rollout-2026-02-01T10-00-00-550e8400-e29b-41d4-a716-446655440000.jsonl",
    );

    await writeJsonl(filePath, [
      {
        type: "turn_context",
        payload: {
          cwd: "/Users/alice/api-service",
        },
        timestamp: "2026-02-01T10:00:00.000Z",
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "<environment_context>wrapped</environment_context>" },
          ],
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "Debug the auth race condition",
        },
      },
      {
        type: "session_meta",
        payload: {
          id: "550e8400-e29b-41d4-a716-446655440000",
          timestamp: "2026-02-01T09:59:59.000Z",
          cwd: "/Users/alice/api-service",
        },
      },
    ]);

    const warnings: ClogWarning[] = [];
    const config = getDefaultConfig("alice");
    config.sources["codex-cli"].paths = [path.join(tempDir, ".codex")];

    const adapter = new CodexCliAdapter(config);
    const discovered = await collect(adapter.discover({ onWarning: (warning) => warnings.push(warning) }));

    expect(warnings).toEqual([]);
    expect(discovered[0]?.sourceId).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(discovered[0]?.metadata).toEqual({
      title: "Debug the auth race condition",
      summary: "",
      projectName: "api-service",
      projectPath: "/Users/alice/api-service",
      slug: null,
      createdAt: "2026-02-01T09:59:59.000Z",
    });
  });

  it("Codex discovery ignores malformed JSONL after metadata is complete", async () => {
    const sessionsDir = path.join(tempDir, ".codex", "sessions", "2026", "02", "01");
    const filePath = path.join(
      sessionsDir,
      "rollout-2026-02-01T10-00-00-750e8400-e29b-41d4-a716-446655440000.jsonl",
    );

    await writeRawJsonlLines(filePath, [
      jsonLine({
        type: "session_meta",
        payload: {
          id: "750e8400-e29b-41d4-a716-446655440000",
          timestamp: "2026-02-01T09:59:59.000Z",
          cwd: "/Users/alice/api-service",
        },
      }),
      jsonLine({
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "Debug the auth race condition",
        },
      }),
      "{not: valid json",
    ]);

    const warnings: ClogWarning[] = [];
    const config = getDefaultConfig("alice");
    config.sources["codex-cli"].paths = [path.join(tempDir, ".codex")];
    const adapter = new CodexCliAdapter(config);

    const discovered = await collect(
      adapter.discover({ onWarning: (warning) => warnings.push(warning) }),
    );

    expect(warnings).toEqual([]);
    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.metadata.title).toBe("Debug the auth race condition");
  });

  it("Codex discovery finalizes fallback metadata at the line bound and ignores later malformed JSONL", async () => {
    const sessionsDir = path.join(tempDir, ".codex", "sessions", "2026", "02", "01");
    const id = "850e8400-e29b-41d4-a716-446655440000";
    const filePath = path.join(
      sessionsDir,
      `rollout-2026-02-01T10-00-00-${id}.jsonl`,
    );

    await writeRawJsonlLines(filePath, [
      jsonLine({
        type: "turn_context",
        timestamp: "2026-02-01T10:00:00.000Z",
        payload: {
          cwd: "/Users/alice/api-service",
        },
      }),
      jsonLine({
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "Summarize the deployment plan",
        },
      }),
      ...validJsonlPadding(SCAN_METADATA_MAX_LINES - 2),
      "{not: valid json",
    ]);

    const warnings: ClogWarning[] = [];
    const config = getDefaultConfig("alice");
    config.sources["codex-cli"].paths = [path.join(tempDir, ".codex")];
    const adapter = new CodexCliAdapter(config);

    const discovered = await collect(
      adapter.discover({ onWarning: (warning) => warnings.push(warning) }),
    );

    expect(warnings).toEqual([]);
    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.sourceId).toBe(id);
    expect(discovered[0]?.metadata.projectPath).toBe("/Users/alice/api-service");
    expect(discovered[0]?.metadata.createdAt).toBe("2026-02-01T10:00:00.000Z");
    expect(discovered[0]?.metadata.title).toBe("Summarize the deployment plan");
  });

  it("Codex discovery warns and skips when malformed JSONL appears before metadata is complete", async () => {
    const sessionsDir = path.join(tempDir, ".codex", "sessions", "2026", "02", "01");
    const filePath = path.join(
      sessionsDir,
      "rollout-2026-02-01T10-00-00-950e8400-e29b-41d4-a716-446655440000.jsonl",
    );

    await writeRawJsonlLines(filePath, [
      jsonLine({
        type: "session_meta",
        payload: {
          id: "950e8400-e29b-41d4-a716-446655440000",
          timestamp: "2026-02-01T09:59:59.000Z",
        },
      }),
      "{not: valid json",
    ]);

    const warnings: ClogWarning[] = [];
    const config = getDefaultConfig("alice");
    config.sources["codex-cli"].paths = [path.join(tempDir, ".codex")];
    const adapter = new CodexCliAdapter(config);

    const discovered = await collect(
      adapter.discover({ onWarning: (warning) => warnings.push(warning) }),
    );

    expect(discovered).toEqual([]);
    expect(warnings.map((warning) => warning.code)).toEqual(["malformed_jsonl"]);
  });

  it("Codex discovery uses a nearby duplicate user_message as the title after ignored events", async () => {
    const sessionsDir = path.join(tempDir, ".codex", "sessions", "2026", "02", "01");
    const filePath = path.join(
      sessionsDir,
      "rollout-2026-02-01T10-00-00-a50e8400-e29b-41d4-a716-446655440000.jsonl",
    );

    await writeJsonl(filePath, [
      {
        type: "session_meta",
        payload: {
          id: "a50e8400-e29b-41d4-a716-446655440000",
          timestamp: "2026-02-01T09:59:59.000Z",
          cwd: "/Users/alice/api-service",
        },
      },
      {
        type: "response_item",
        timestamp: "2026-02-01T10:00:00.000Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Normalize\r\nthis title" }],
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-02-01T10:00:01.000Z",
        payload: {
          type: "agent_message",
          message: "Working...",
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-02-01T10:00:02.000Z",
        payload: {
          type: "user_message",
          message: "Normalize\nthis title",
        },
      },
    ]);

    const config = getDefaultConfig("alice");
    config.sources["codex-cli"].paths = [path.join(tempDir, ".codex")];
    const adapter = new CodexCliAdapter(config);

    const discovered = await collect(adapter.discover());

    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.metadata.title).toBe("Normalize\nthis title");
  });

  it("Codex discovery keeps the earliest canonical prompt when a later event message is unrelated", async () => {
    const sessionsDir = path.join(tempDir, ".codex", "sessions", "2026", "02", "01");
    const filePath = path.join(
      sessionsDir,
      "rollout-2026-02-01T10-00-00-b50e8400-e29b-41d4-a716-446655440000.jsonl",
    );

    await writeJsonl(filePath, [
      {
        type: "session_meta",
        payload: {
          id: "b50e8400-e29b-41d4-a716-446655440000",
          timestamp: "2026-02-01T09:59:59.000Z",
          cwd: "/Users/alice/api-service",
        },
      },
      {
        type: "response_item",
        timestamp: "2026-02-01T10:00:00.000Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "First prompt" }],
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-02-01T10:00:01.000Z",
        payload: {
          type: "user_message",
          message: "Second prompt",
        },
      },
    ]);

    const config = getDefaultConfig("alice");
    config.sources["codex-cli"].paths = [path.join(tempDir, ".codex")];
    const adapter = new CodexCliAdapter(config);

    const discovered = await collect(adapter.discover());

    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.metadata.title).toBe("First prompt");
  });

  it("Codex discovery lets in-bound session_meta override filename, timestamp, and turn_context fallbacks", async () => {
    const filenameId = "c50e8400-e29b-41d4-a716-446655440000";
    const embeddedId = "d50e8400-e29b-41d4-a716-446655440000";
    const sessionsDir = path.join(tempDir, ".codex", "sessions", "2026", "02", "01");
    const filePath = path.join(
      sessionsDir,
      `rollout-2026-02-01T10-00-00-${filenameId}.jsonl`,
    );

    await writeJsonl(filePath, [
      {
        type: "turn_context",
        timestamp: "2026-02-01T10:00:00.000Z",
        payload: {
          cwd: "/Users/alice/fallback-project",
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "Use primary metadata",
        },
      },
      {
        type: "session_meta",
        payload: {
          id: embeddedId,
          timestamp: "2026-02-01T09:59:59.000Z",
          cwd: "/Users/alice/primary-project",
        },
      },
    ]);

    const warnings: ClogWarning[] = [];
    const config = getDefaultConfig("alice");
    config.sources["codex-cli"].paths = [path.join(tempDir, ".codex")];
    const adapter = new CodexCliAdapter(config);

    const discovered = await collect(
      adapter.discover({ onWarning: (warning) => warnings.push(warning) }),
    );

    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.sourceId).toBe(embeddedId);
    expect(discovered[0]?.metadata).toMatchObject({
      title: "Use primary metadata",
      projectName: "primary-project",
      projectPath: "/Users/alice/primary-project",
      createdAt: "2026-02-01T09:59:59.000Z",
    });
    expect(warnings).toMatchObject([
      {
        code: "source_id_mismatch",
        source: "codex-cli",
        path: filePath,
      },
    ]);
  });

  it("Codex parsing correlates tool calls and suppresses duplicate fallback user messages", async () => {
    const filePath = path.join(tempDir, "codex-parse.jsonl");

    await writeJsonl(filePath, [
      {
        type: "response_item",
        timestamp: "2026-02-01T10:00:00.000Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Show me git status" }],
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-02-01T10:00:00.000Z",
        payload: {
          type: "user_message",
          message: "Show me git status",
        },
      },
      {
        type: "response_item",
        timestamp: "2026-02-01T10:00:01.000Z",
        payload: {
          type: "function_call",
          call_id: "call_1",
          name: "exec_command",
          arguments: "{\"cmd\":\"git status\"}",
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-02-01T10:00:02.000Z",
        payload: {
          type: "exec_command_end",
          call_id: "call_1",
          exit_code: 0,
          formatted_output: "On branch main",
        },
      },
      {
        type: "response_item",
        timestamp: "2026-02-01T10:00:03.000Z",
        payload: {
          type: "function_call_output",
          call_id: "call_1",
          output: "Command completed.\nOutput:\nOn branch main",
        },
      },
      {
        type: "response_item",
        timestamp: "2026-02-01T10:00:04.000Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "The repo is clean." }],
        },
      },
    ]);

    const adapter = new CodexCliAdapter(getDefaultConfig("alice"));
    const messages = (await adapter.parseTranscript(filePath)).messages;

    expect(messages).toEqual([
      {
        role: "user",
        content: "Show me git status",
        timestamp: "2026-02-01T10:00:00.000Z",
      },
      {
        role: "tool_use",
        content: 'exec_command: {"cmd":"git status"}',
        timestamp: "2026-02-01T10:00:01.000Z",
        toolName: "exec_command",
        toolInput: { cmd: "git status" },
      },
      {
        role: "tool_result",
        content: "exec_command: output",
        timestamp: "2026-02-01T10:00:03.000Z",
        toolName: "exec_command",
      },
      {
        role: "assistant",
        content: "The repo is clean.",
        timestamp: "2026-02-01T10:00:04.000Z",
      },
    ]);
  });

  it("Codex parsing strips leading AGENTS and environment wrapper text from canonical user messages", async () => {
    const filePath = path.join(tempDir, "codex-strip-wrappers.jsonl");

    await writeJsonl(filePath, [
      {
        type: "response_item",
        timestamp: "2026-03-28T15:36:57.521Z",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                "# AGENTS.md instructions for /Users/alice/project\n\n<INSTRUCTIONS>\nAgent-only setup\n</INSTRUCTIONS>\n\n<environment_context>\n  <cwd>/Users/alice/project</cwd>\n</environment_context>\n\nPlease explain how go imports work.",
            },
          ],
        },
      },
    ]);

    const adapter = new CodexCliAdapter(getDefaultConfig("alice"));
    const messages = (await adapter.parseTranscript(filePath)).messages;

    expect(messages).toEqual([
      {
        role: "user",
        content: "Please explain how go imports work.",
        timestamp: "2026-03-28T15:36:57.521Z",
      },
    ]);
  });

  // ============================================================
  // Additional Claude discovery edge cases (SPEC §4.2.6)
  // ============================================================

  it("Claude discovery stores a clean 100-character title for a very long first user message", async () => {
    const longBody = "A".repeat(250);
    const filePath = path.join(
      tempDir,
      "claude",
      "-Users-alice-api-service",
      "c8000000-0000-0000-0000-000000000001.jsonl",
    );

    await writeJsonl(filePath, [
      {
        type: "user",
        timestamp: "2026-02-01T10:00:00.000Z",
        cwd: "/Users/alice/api-service",
        message: { role: "user", content: longBody },
      },
    ]);

    const config = getDefaultConfig("alice");
    config.sources["claude-code"].paths = [path.join(tempDir, "claude")];
    const adapter = new ClaudeCodeAdapter(config);

    const discovered = await collect(adapter.discover());
    const title = discovered[0]?.metadata.title ?? "";
    expect(title).toBe("A".repeat(100));
    expect(title.length).toBe(100);
    expect(title).not.toContain("...");
  });

  it("Codex discovery stores a clean 100-character title for a very long user message", async () => {
    const sessionsDir = path.join(tempDir, ".codex", "sessions", "2026", "02", "01");
    const filePath = path.join(
      sessionsDir,
      "rollout-2026-02-01T10-00-00-650e8400-e29b-41d4-a716-446655440000.jsonl",
    );

    await writeJsonl(filePath, [
      {
        type: "turn_context",
        payload: {
          cwd: "/Users/alice/api-service",
        },
        timestamp: "2026-02-01T10:00:00.000Z",
      },
      {
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "B".repeat(250),
        },
      },
      {
        type: "session_meta",
        payload: {
          id: "650e8400-e29b-41d4-a716-446655440000",
          timestamp: "2026-02-01T09:59:59.000Z",
          cwd: "/Users/alice/api-service",
        },
      },
    ]);

    const config = getDefaultConfig("alice");
    config.sources["codex-cli"].paths = [path.join(tempDir, ".codex")];
    const adapter = new CodexCliAdapter(config);

    const discovered = await collect(adapter.discover());
    const title = discovered[0]?.metadata.title ?? "";
    expect(title).toBe("B".repeat(100));
    expect(title.length).toBe(100);
    expect(title).not.toContain("...");
  });

  it("Claude discovery skips a leading file-history-snapshot line and still derives a title", async () => {
    const filePath = path.join(
      tempDir,
      "claude",
      "-Users-alice-api-service",
      "c8000000-0000-0000-0000-000000000002.jsonl",
    );

    await writeJsonl(filePath, [
      {
        type: "file-history-snapshot",
        messageId: "fhs-1",
        snapshot: { messageId: "fhs-1", trackedFileBackups: {}, timestamp: "2026-02-01T10:00:00.000Z" },
      },
      {
        type: "user",
        timestamp: "2026-02-01T10:00:00.000Z",
        cwd: "/Users/alice/api-service",
        message: { role: "user", content: "Investigate the flaky test" },
      },
    ]);

    const config = getDefaultConfig("alice");
    config.sources["claude-code"].paths = [path.join(tempDir, "claude")];
    const adapter = new ClaudeCodeAdapter(config);

    const discovered = await collect(adapter.discover());
    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.metadata.title).toBe("Investigate the flaky test");
    expect(discovered[0]?.metadata.projectPath).toBe("/Users/alice/api-service");
  });

  // ============================================================
  // Additional Claude parsing edge cases (SPEC §4.2.7)
  // ============================================================

  it("Claude parsing renders a tool_result with is_error=true as 'ToolName: error'", async () => {
    const filePath = path.join(tempDir, "claude-tool-error.jsonl");

    await writeJsonl(filePath, [
      {
        type: "user",
        timestamp: "2026-02-01T10:00:00.000Z",
        message: { role: "user", content: "Try to run the build" },
      },
      {
        type: "assistant",
        timestamp: "2026-02-01T10:00:01.000Z",
        message: {
          id: "msg_1",
          role: "assistant",
          content: [
            { type: "tool_use", id: "tool_err", name: "Bash", input: { command: "npm run build" } },
          ],
        },
      },
      {
        type: "user",
        timestamp: "2026-02-01T10:00:02.000Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_err",
              content: "TypeError: Cannot read property 'x' of undefined",
              is_error: true,
            },
          ],
        },
      },
    ]);

    const adapter = new ClaudeCodeAdapter(getDefaultConfig("alice"));
    const messages = (await adapter.parseTranscript(filePath)).messages;

    const toolResult = messages.find((message) => message.role === "tool_result");
    expect(toolResult).toBeDefined();
    expect(toolResult?.content).toBe("Bash: error");
    expect(toolResult?.toolName).toBe("Bash");
  });

  it("Claude parsing falls back to 'tool: ok' when a tool_result references an unknown tool_use_id", async () => {
    const filePath = path.join(tempDir, "claude-orphan-tool-result.jsonl");

    await writeJsonl(filePath, [
      {
        type: "user",
        timestamp: "2026-02-01T10:00:00.000Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "never-seen-this-tool",
              content: "Some output",
            },
          ],
        },
      },
    ]);

    const adapter = new ClaudeCodeAdapter(getDefaultConfig("alice"));
    const messages = (await adapter.parseTranscript(filePath)).messages;

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "tool_result",
      content: "tool: ok",
      toolName: "tool",
    });
  });

  it("Claude parsing returns an empty message list when only file-history-snapshot lines are present", async () => {
    const filePath = path.join(tempDir, "claude-empty.jsonl");

    await writeJsonl(filePath, [
      {
        type: "file-history-snapshot",
        messageId: "fhs-1",
        snapshot: { messageId: "fhs-1", trackedFileBackups: {}, timestamp: "2026-02-01T10:00:00.000Z" },
      },
      {
        type: "file-history-snapshot",
        messageId: "fhs-2",
        snapshot: { messageId: "fhs-2", trackedFileBackups: {}, timestamp: "2026-02-01T10:00:01.000Z" },
      },
    ]);

    const adapter = new ClaudeCodeAdapter(getDefaultConfig("alice"));
    const messages = (await adapter.parseTranscript(filePath)).messages;
    expect(messages).toEqual([]);
  });

  // ============================================================
  // Additional Codex discovery edge cases (SPEC §4.3.2)
  // ============================================================

  it("Codex discovery uses the filename-derived source id when session_meta is missing", async () => {
    const sessionsDir = path.join(tempDir, ".codex", "sessions", "2026", "02", "01");
    const filePath = path.join(
      sessionsDir,
      "rollout-2026-02-01T10-00-00-123e4567-e89b-12d3-a456-426614174000.jsonl",
    );

    await writeJsonl(filePath, [
      {
        type: "turn_context",
        timestamp: "2026-02-01T10:00:00.000Z",
        payload: { cwd: "/Users/alice/api-service" },
      },
      {
        type: "event_msg",
        timestamp: "2026-02-01T10:00:00.000Z",
        payload: { type: "user_message", message: "Check the logs" },
      },
    ]);

    const warnings: ClogWarning[] = [];
    const config = getDefaultConfig("alice");
    config.sources["codex-cli"].paths = [path.join(tempDir, ".codex")];

    const adapter = new CodexCliAdapter(config);
    const discovered = await collect(
      adapter.discover({ onWarning: (warning) => warnings.push(warning) }),
    );

    expect(warnings).toEqual([]);
    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.sourceId).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(discovered[0]?.metadata.title).toBe("Check the logs");
  });

  it("Codex discovery skips non-rollout JSONL files under the sessions directory", async () => {
    const sessionsDir = path.join(tempDir, ".codex", "sessions", "2026", "02", "01");

    // Valid rollout.
    await writeJsonl(
      path.join(sessionsDir, "rollout-2026-02-01T10-00-00-22222222-2222-2222-2222-222222222222.jsonl"),
      [
        {
          type: "session_meta",
          payload: {
            id: "22222222-2222-2222-2222-222222222222",
            timestamp: "2026-02-01T10:00:00.000Z",
            cwd: "/Users/alice/api-service",
          },
        },
        {
          type: "event_msg",
          payload: { type: "user_message", message: "Real conversation" },
        },
      ],
    );

    // Non-rollout JSONL under the same directory (log-like file).
    await writeJsonl(path.join(sessionsDir, "debug-trace.jsonl"), [
      { type: "debug", message: "internal" },
    ]);

    const warnings: ClogWarning[] = [];
    const config = getDefaultConfig("alice");
    config.sources["codex-cli"].paths = [path.join(tempDir, ".codex")];

    const adapter = new CodexCliAdapter(config);
    const discovered = await collect(
      adapter.discover({ onWarning: (warning) => warnings.push(warning) }),
    );

    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.sourceId).toBe("22222222-2222-2222-2222-222222222222");
    // No malformed warning for the non-rollout file.
    expect(warnings.filter((warning) => warning.code === "malformed_jsonl")).toEqual([]);
  });

  // ============================================================
  // Additional Codex parsing edge cases (SPEC §4.3.4)
  // ============================================================

  it("Codex parsing renders a failed exec_command as '<tool>: exit N'", async () => {
    const filePath = path.join(tempDir, "codex-exec-exit.jsonl");

    await writeJsonl(filePath, [
      {
        type: "response_item",
        timestamp: "2026-02-01T10:00:01.000Z",
        payload: {
          type: "function_call",
          call_id: "call_fail",
          name: "exec_command",
          arguments: '{"cmd":"npm run build"}',
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-02-01T10:00:02.000Z",
        payload: {
          type: "exec_command_end",
          call_id: "call_fail",
          exit_code: 2,
          formatted_output: "error: build failed",
        },
      },
      {
        type: "response_item",
        timestamp: "2026-02-01T10:00:03.000Z",
        payload: {
          type: "function_call_output",
          call_id: "call_fail",
          output: "Command failed.",
        },
      },
    ]);

    const adapter = new CodexCliAdapter(getDefaultConfig("alice"));
    const messages = (await adapter.parseTranscript(filePath)).messages;

    const toolResult = messages.find((message) => message.role === "tool_result");
    expect(toolResult?.content).toBe("exec_command: exit 2");
    expect(toolResult?.toolName).toBe("exec_command");
  });

  it("Codex parsing drops response_item.message records with role='developer' (SPEC §4.3.3)", async () => {
    const filePath = path.join(tempDir, "codex-developer-drop.jsonl");

    await writeJsonl(filePath, [
      {
        type: "response_item",
        timestamp: "2026-02-01T10:00:00.000Z",
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "Agent-only configuration block" }],
        },
      },
      {
        type: "response_item",
        timestamp: "2026-02-01T10:00:01.000Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Please help" }],
        },
      },
    ]);

    const adapter = new CodexCliAdapter(getDefaultConfig("alice"));
    const messages = (await adapter.parseTranscript(filePath)).messages;

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "user", content: "Please help" });
  });

  it("Codex discovery yields metadata with null project path when cwd is missing", async () => {
    const sessionsDir = path.join(tempDir, ".codex", "sessions", "2026", "02", "01");
    const filePath = path.join(
      sessionsDir,
      "rollout-2026-02-01T10-00-00-550e8400-e29b-41d4-a716-446655440000.jsonl",
    );

    await writeJsonl(filePath, [
      {
        type: "session_meta",
        payload: {
          id: "550e8400-e29b-41d4-a716-446655440000",
          timestamp: "2026-02-01T09:59:59.000Z",
        },
      },
    ]);

    const warnings: ClogWarning[] = [];
    const config = getDefaultConfig("alice");
    config.sources["codex-cli"].paths = [path.join(tempDir, ".codex")];

    const adapter = new CodexCliAdapter(config);
    const discovered = await collect(adapter.discover({ onWarning: (warning) => warnings.push(warning) }));

    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toMatchObject({
      sourceId: "550e8400-e29b-41d4-a716-446655440000",
      metadata: {
        projectName: null,
        projectPath: null,
      },
    });
    expect(warnings).toEqual([]);
  });
});

function jsonLine(value: unknown): string {
  return JSON.stringify(value);
}

function validJsonlPadding(count: number): string[] {
  return Array.from({ length: count }, (_entry, index) =>
    jsonLine({ type: "progress", message: `padding ${index}` }),
  );
}

function codexSessionMeta(
  id: string,
  options: {
    cliVersion?: string;
    parentId?: string;
    parentThreadId?: string;
    threadSource?: unknown;
  } = {},
): unknown {
  return {
    type: "session_meta",
    timestamp: "2026-02-01T10:00:00.000Z",
    payload: {
      id,
      cli_version: options.cliVersion ?? "0.145.0",
      forked_from_id: options.parentId,
      parent_thread_id: options.parentThreadId,
      thread_source: options.threadSource,
      cwd: "/Users/alice/project",
      timestamp: "2026-02-01T10:00:00.000Z",
    },
  };
}

function claudeForkedRecord(
  childId: string,
  parentId: string,
  uuid: string,
): Record<string, unknown> {
  return {
    type: "assistant",
    uuid,
    timestamp: "2026-07-24T10:00:00.000Z",
    sessionId: childId,
    forkedFrom: {
      sessionId: parentId,
      messageUuid: uuid,
    },
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];

  for await (const value of iterable) {
    values.push(value);
  }

  return values;
}
