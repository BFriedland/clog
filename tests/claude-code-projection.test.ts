import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { projectClaudeCodeTranscript } from "../src/adapters/claude-code-transcript.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code.js";
import { getDefaultConfig } from "../src/config/index.js";
import { writeJsonl } from "./helpers/fixtures.js";

interface ProjectionFixture {
  name: string;
  sourceRecords: unknown[];
  expected: {
    messages: unknown[];
    warningCodes: string[];
  };
}

interface ProjectionFixtureDocument {
  fixtures: ProjectionFixture[];
}

const fixtureDocument = JSON.parse(
  await fs.readFile(
    new URL("./fixtures/claude-code-transcript-projection.json", import.meta.url),
    "utf8",
  ),
) as ProjectionFixtureDocument;

describe("Claude Code transcript projection", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clog-claude-projection-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it.each(fixtureDocument.fixtures)(
    "projects $name through the production adapter",
    async (fixture) => {
      const filePath = path.join(tempDir, `${fixture.name}.jsonl`);
      await writeJsonl(filePath, fixture.sourceRecords);

      const adapter = new ClaudeCodeAdapter(getDefaultConfig("alice"));
      const transcript = await adapter.parseTranscript(filePath);

      expect(transcript.messages).toEqual(fixture.expected.messages);
      expect(transcript.warnings.map((warning) => warning.code)).toEqual(
        fixture.expected.warningCodes,
      );
      for (const warning of transcript.warnings) {
        expect(warning).toMatchObject({
          source: "claude-code",
          path: filePath,
        });
      }
    },
  );

  it("excludes sidechain records from a legacy transcript", async () => {
    const filePath = path.join(tempDir, "legacy-sidechain.jsonl");
    await writeJsonl(filePath, [
      {
        type: "user",
        timestamp: "2026-07-24T10:00:00.000Z",
        message: { role: "user", content: "Main prompt." },
      },
      {
        type: "assistant",
        timestamp: "2026-07-24T10:00:01.000Z",
        message: {
          id: "main-response",
          role: "assistant",
          content: [{ type: "text", text: "Main response." }],
        },
      },
      {
        type: "user",
        isSidechain: true,
        timestamp: "2026-07-24T10:00:02.000Z",
        message: { role: "user", content: "Nested task." },
      },
      {
        type: "assistant",
        isSidechain: true,
        timestamp: "2026-07-24T10:00:03.000Z",
        message: {
          id: "nested-response",
          role: "assistant",
          content: [{ type: "text", text: "Nested output." }],
        },
      },
    ]);

    const adapter = new ClaudeCodeAdapter(getDefaultConfig("alice"));
    const transcript = await adapter.parseTranscript(filePath);

    expect(transcript.messages).toEqual([
      {
        role: "user",
        content: "Main prompt.",
        timestamp: "2026-07-24T10:00:00.000Z",
      },
      {
        role: "assistant",
        content: "Main response.",
        timestamp: "2026-07-24T10:00:01.000Z",
      },
    ]);
    expect(transcript.warnings.map((warning) => warning.code)).toEqual([
      "claude_transcript_legacy_file_order",
    ]);
  });

  it.each([
    "July 25, 2026 10:01:00 UTC",
    "2026-02-30T10:01:00.000Z",
  ])(
    "treats non-ISO or calendar-invalid timestamp %s as invalid",
    async (invalidTimestamp) => {
      const filePath = path.join(tempDir, "invalid-timestamp.jsonl");
      await writeJsonl(filePath, [
        {
          type: "user",
          uuid: "timestamp-root",
          parentUuid: null,
          timestamp: "July 24, 2026 10:00:00 UTC",
          message: { role: "user", content: "Choose a branch." },
        },
        {
          type: "assistant",
          uuid: "valid-timestamp-leaf",
          parentUuid: "timestamp-root",
          timestamp: "2026-07-24T10:01:00.000Z",
          message: {
            id: "valid-response",
            role: "assistant",
            content: [{ type: "text", text: "Valid timestamp branch." }],
          },
        },
        {
          type: "assistant",
          uuid: "invalid-timestamp-leaf",
          parentUuid: "timestamp-root",
          timestamp: invalidTimestamp,
          message: {
            id: "invalid-response",
            role: "assistant",
            content: [{ type: "text", text: "Invalid timestamp branch." }],
          },
        },
      ]);

      const adapter = new ClaudeCodeAdapter(getDefaultConfig("alice"));
      const transcript = await adapter.parseTranscript(filePath);

      expect(transcript.messages).toEqual([
        {
          role: "user",
          content: "Choose a branch.",
          timestamp: null,
        },
        {
          role: "assistant",
          content: "Valid timestamp branch.",
          timestamp: "2026-07-24T10:01:00.000Z",
        },
      ]);
      expect(transcript.warnings).toEqual([]);
    },
  );

  it("preserves a valid ISO timestamp with an offset", async () => {
    const filePath = path.join(tempDir, "offset-timestamp.jsonl");
    await writeJsonl(filePath, [{
      type: "user",
      timestamp: "2026-07-24T10:00:00+02:00",
      message: { role: "user", content: "Offset timestamp." },
    }]);

    const adapter = new ClaudeCodeAdapter(getDefaultConfig("alice"));
    const transcript = await adapter.parseTranscript(filePath);

    expect(transcript.messages).toEqual([{
      role: "user",
      content: "Offset timestamp.",
      timestamp: "2026-07-24T10:00:00+02:00",
    }]);
    expect(transcript.warnings).toEqual([]);
  });

  it("uses the compact summary when logical history is cyclic", async () => {
    const filePath = path.join(tempDir, "cyclic-compaction-history.jsonl");
    await writeJsonl(filePath, [
      {
        type: "user",
        uuid: "cyclic-history-user",
        parentUuid: "cyclic-history-assistant",
        timestamp: "2026-07-24T10:00:00.000Z",
        message: { role: "user", content: "Unusable cyclic history." },
      },
      {
        type: "assistant",
        uuid: "cyclic-history-assistant",
        parentUuid: "cyclic-history-user",
        timestamp: "2026-07-24T10:00:01.000Z",
        message: {
          id: "cyclic-history-response",
          role: "assistant",
          content: [{ type: "text", text: "Unusable cyclic response." }],
        },
      },
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "cyclic-compact-boundary",
        parentUuid: null,
        logicalParentUuid: "cyclic-history-assistant",
        timestamp: "2026-07-24T10:01:00.000Z",
      },
      {
        type: "user",
        uuid: "cyclic-compact-summary",
        parentUuid: "cyclic-compact-boundary",
        isCompactSummary: true,
        timestamp: "2026-07-24T10:01:00.100Z",
        message: {
          role: "user",
          content: "The persisted summary is the available prefix.",
        },
      },
      {
        type: "user",
        uuid: "cyclic-current-leaf",
        parentUuid: "cyclic-compact-summary",
        timestamp: "2026-07-24T10:02:00.000Z",
        message: { role: "user", content: "Continue from the summary." },
      },
    ]);

    const adapter = new ClaudeCodeAdapter(getDefaultConfig("alice"));
    const transcript = await adapter.parseTranscript(filePath);

    expect(transcript.messages).toEqual([
      {
        role: "user",
        content: "The persisted summary is the available prefix.",
        timestamp: "2026-07-24T10:01:00.100Z",
      },
      {
        role: "user",
        content: "Continue from the summary.",
        timestamp: "2026-07-24T10:02:00.000Z",
      },
    ]);
    expect(transcript.warnings.map((warning) => warning.code)).toEqual([
      "claude_transcript_parent_cycle",
      "claude_transcript_compaction_history_missing",
    ]);
  });

  it("uses the compact summary when the compaction boundary is cyclic", async () => {
    const filePath = path.join(tempDir, "cyclic-compaction-boundary.jsonl");
    await writeJsonl(filePath, [
      {
        type: "user",
        uuid: "boundary-logical-history",
        parentUuid: null,
        timestamp: "2026-07-24T10:00:00.000Z",
        message: { role: "user", content: "Unreachable logical history." },
      },
      {
        type: "system",
        subtype: "status",
        uuid: "boundary-cycle-member",
        parentUuid: "cyclic-compact-boundary",
      },
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "cyclic-compact-boundary",
        parentUuid: "boundary-cycle-member",
        logicalParentUuid: "boundary-logical-history",
        timestamp: "2026-07-24T10:01:00.000Z",
      },
      {
        type: "user",
        uuid: "boundary-compact-summary",
        parentUuid: "cyclic-compact-boundary",
        isCompactSummary: true,
        timestamp: "2026-07-24T10:01:00.100Z",
        message: {
          role: "user",
          content: "The compact summary starts the coherent suffix.",
        },
      },
      {
        type: "user",
        uuid: "boundary-current-leaf",
        parentUuid: "boundary-compact-summary",
        timestamp: "2026-07-24T10:02:00.000Z",
        message: { role: "user", content: "Continue from the summary." },
      },
    ]);

    const adapter = new ClaudeCodeAdapter(getDefaultConfig("alice"));
    const transcript = await adapter.parseTranscript(filePath);

    expect(transcript.messages).toEqual([
      {
        role: "user",
        content: "The compact summary starts the coherent suffix.",
        timestamp: "2026-07-24T10:01:00.100Z",
      },
      {
        role: "user",
        content: "Continue from the summary.",
        timestamp: "2026-07-24T10:02:00.000Z",
      },
    ]);
    expect(transcript.warnings.map((warning) => warning.code)).toEqual([
      "claude_transcript_parent_cycle",
      "claude_transcript_missing_parent",
    ]);
  });

  it("reports a large cyclic graph without overflowing the call stack", () => {
    const recordCount = 20_000;
    const records = Array.from({ length: recordCount }, (_, index) => ({
      type: "user",
      uuid: `large-cycle-${index}`,
      parentUuid:
        index === 0
          ? `large-cycle-${recordCount - 1}`
          : `large-cycle-${index - 1}`,
      timestamp: "2026-07-24T10:00:00.000Z",
      message: { role: "user", content: "Cycle member." },
    }));

    const transcript = projectClaudeCodeTranscript(records, "large-cycle.jsonl");

    expect(transcript.messages).toEqual([]);
    expect(transcript.warnings).toHaveLength(1);
    expect(transcript.warnings[0]).toMatchObject({
      code: "claude_transcript_parent_cycle",
      source: "claude-code",
      path: "large-cycle.jsonl",
    });
    expect(transcript.warnings[0]?.relatedUuids).toHaveLength(recordCount);
  });
});
