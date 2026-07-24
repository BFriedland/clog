import fs from "node:fs";

import { describe, expect, it } from "vitest";

import { messageSchema } from "../src/models/conversation.js";

const fixtureUrl = new URL(
  "./fixtures/claude-code-transcript-projection.json",
  import.meta.url,
);
const document = JSON.parse(fs.readFileSync(fixtureUrl, "utf8"));

const REQUIRED_FIXTURES = new Set([
  "linear-session",
  "ordinary-resume",
  "single-rewind",
  "two-rewind-alternatives",
  "concurrent-tool-results",
  "split-assistant-response",
  "compacted-session",
  "top-level-and-sidechain-records",
  "user-content-block-composition",
  "legacy-file-order",
  "stale-last-prompt",
  "equal-and-missing-leaf-timestamps",
  "missing-parent",
  "duplicate-uuid",
  "cyclic-parent-graph",
  "compaction-history-missing",
  "malformed-modern-record",
  "tool-result-provenance-mismatch",
]);

const EVIDENCE_KINDS = new Set([
  "observed-source-file",
  "controlled-reproduction",
  "implementation-inspection",
]);

const WARNING_CODES = new Set([
  "claude_transcript_leaf_order_fallback",
  "claude_transcript_legacy_file_order",
  "claude_transcript_malformed_graph_record",
  "claude_transcript_missing_parent",
  "claude_transcript_duplicate_uuid",
  "claude_transcript_parent_cycle",
  "claude_transcript_tool_result_mismatch",
  "claude_transcript_compaction_history_missing",
]);

describe("Claude Code transcript projection contract", () => {
  it("keeps every golden fixture complete and usable by transcript parser tests", () => {
    expect(document.schemaVersion).toBe(1);
    expect(Array.isArray(document.fixtures)).toBe(true);

    const seenNames = new Set();
    const coveredWarningCodes = new Set();

    for (const fixture of document.fixtures) {
      const prefix =
        typeof fixture.name === "string" ? fixture.name : "<unnamed>";

      expect(fixture.name, `${prefix}: name must be nonempty`).toBeTypeOf(
        "string",
      );
      expect(
        fixture.name.length,
        `${prefix}: name must be nonempty`,
      ).toBeGreaterThan(0);
      expect(
        seenNames.has(fixture.name),
        `${prefix}: fixture name is duplicated`,
      ).toBe(false);
      seenNames.add(fixture.name);

      expect(
        Array.isArray(fixture.covers) && fixture.covers.length > 0,
        `${prefix}: covers must be nonempty`,
      ).toBe(true);
      expect(
        Array.isArray(fixture.evidence) && fixture.evidence.length > 0,
        `${prefix}: evidence must be nonempty`,
      ).toBe(true);

      for (const [evidenceIndex, evidence] of fixture.evidence.entries()) {
        const evidencePrefix = `${prefix}: evidence ${evidenceIndex}`;
        expect(
          EVIDENCE_KINDS.has(evidence.kind),
          `${evidencePrefix}: unsupported evidence kind`,
        ).toBe(true);
        expect(
          nonemptyString(evidence.claudeCodeVersion),
          `${evidencePrefix}: claudeCodeVersion must be nonempty`,
        ).toBe(true);
        expect(
          nonemptyString(evidence.sourceVersionRange),
          `${evidencePrefix}: sourceVersionRange must be nonempty`,
        ).toBe(true);
        expect(
          evidence.sourceSession === null ||
            nonemptyString(evidence.sourceSession),
          `${evidencePrefix}: sourceSession must be null or nonempty`,
        ).toBe(true);
        expect(
          nonemptyString(evidence.surface),
          `${evidencePrefix}: surface must be nonempty`,
        ).toBe(true);
        expect(
          Array.isArray(evidence.sourceRecordUuids),
          `${evidencePrefix}: sourceRecordUuids must be an array`,
        ).toBe(true);
        if (evidence.kind === "observed-source-file") {
          expect(
            evidence.sourceRecordUuids.length > 0,
            `${evidencePrefix}: observed evidence must name source UUIDs`,
          ).toBe(true);
        }
        if (evidence.sourceArtifact !== undefined) {
          expect(
            nonemptyString(evidence.sourceArtifact),
            `${evidencePrefix}: sourceArtifact must be nonempty`,
          ).toBe(true);
        }
        expect(
          nonemptyString(evidence.notes),
          `${evidencePrefix}: notes must be nonempty`,
        ).toBe(true);
      }

      expect(
        Array.isArray(fixture.sourceRecords) &&
          fixture.sourceRecords.length > 0,
        `${prefix}: sourceRecords must be nonempty`,
      ).toBe(true);

      const jsonl = fixture.sourceRecords
        .map((record) => JSON.stringify(record))
        .join("\n");
      expect(
        jsonl.split("\n").map((line) => JSON.parse(line)),
        `${prefix}: source records must round-trip as JSONL`,
      ).toEqual(fixture.sourceRecords);

      if (fixture.expected.selectedLeaf !== null) {
        expect(
          nonemptyString(fixture.expected.selectedLeaf),
          `${prefix}: selectedLeaf must be null or nonempty`,
        ).toBe(true);
        expect(
          fixture.sourceRecords.some(
            (record) => record.uuid === fixture.expected.selectedLeaf,
          ),
          `${prefix}: selectedLeaf must name a source record`,
        ).toBe(true);
      }

      const classifiedIndexes = new Set();
      for (const [classification, entries] of [
        ["included", fixture.expected.includedRecords],
        ["excluded", fixture.expected.excludedRecords],
      ]) {
        expect(
          Array.isArray(entries),
          `${prefix}: ${classification}Records must be an array`,
        ).toBe(true);
        for (const entry of entries) {
          expect(
            Number.isInteger(entry.index) &&
              entry.index >= 0 &&
              entry.index < fixture.sourceRecords.length,
            `${prefix}: ${classification} record index must be in range`,
          ).toBe(true);
          expect(
            classifiedIndexes.has(entry.index),
            `${prefix}: source record ${entry.index} is classified twice`,
          ).toBe(false);
          classifiedIndexes.add(entry.index);
          expect(
            nonemptyString(entry.reason),
            `${prefix}: ${classification} reason must be nonempty`,
          ).toBe(true);
        }
      }
      expect(
        classifiedIndexes.size,
        `${prefix}: every source record must be included or excluded`,
      ).toBe(fixture.sourceRecords.length);

      expect(() =>
        messageSchema.array().parse(fixture.expected.messages),
      ).not.toThrow();

      expect(
        Array.isArray(fixture.expected.warningCodes),
        `${prefix}: warningCodes must be an array`,
      ).toBe(true);

      const fixtureWarningCodes = new Set();
      for (const code of fixture.expected.warningCodes) {
        expect(
          WARNING_CODES.has(code),
          `${prefix}: warning code ${code} must be declared`,
        ).toBe(true);
        expect(
          fixtureWarningCodes.has(code),
          `${prefix}: warning code ${code} is duplicated`,
        ).toBe(false);
        fixtureWarningCodes.add(code);
        coveredWarningCodes.add(code);
      }
    }

    expect(seenNames).toEqual(REQUIRED_FIXTURES);
    expect(coveredWarningCodes).toEqual(WARNING_CODES);
  });
});

function nonemptyString(value) {
  return typeof value === "string" && value.length > 0;
}
