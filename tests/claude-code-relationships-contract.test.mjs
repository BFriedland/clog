import fs from "node:fs";

import { describe, expect, it } from "vitest";

const document = JSON.parse(
  fs.readFileSync(
    new URL("./fixtures/claude-code-relationships.json", import.meta.url),
    "utf8",
  ),
);

const REQUIRED_CASES = [
  "slashBranch",
  "forkSession",
  "multiGenerationChain",
  "provenanceFreeFork",
];
const SYNTHETIC_SESSION_ID =
  /^([a-e])\1{7}-\1{4}-4\1{3}-8\1{3}-\1{12}$/;

describe("Claude Code relationship fixtures", () => {
  it("records the observed source version, branch surface, and fixture origin", () => {
    expect(document.formatVersion).toBe(1);
    expect(document.claudeCodeVersion).toBe("2.1.206");
    expect(document.observedAt).toBe("2026-07-24");
    expect(Object.keys(document.cases).sort()).toEqual(
      [...REQUIRED_CASES].sort(),
    );

    for (const name of REQUIRED_CASES) {
      const fixture = document.cases[name];
      expect(fixture.origin).toContain("Directly observed");
      expect(fixture.surface.length).toBeGreaterThan(0);
      expect(fixture.childSourceId).toMatch(
        /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/,
      );
      expect(fixture.sourceRecords.length).toBeGreaterThan(0);
    }
  });

  it("uses synthetic UUIDs for every recorded session identity", () => {
    for (const fixture of Object.values(document.cases)) {
      for (
        const key of [
          "childSourceId",
          "parentSourceId",
          "ancestorSourceId",
          "unobservableParentSourceId",
        ]
      ) {
        if (fixture[key] != null) {
          expect(fixture[key]).toMatch(SYNTHETIC_SESSION_ID);
        }
      }

      for (const record of fixture.sourceRecords) {
        for (const key of ["sessionId", "session_id"]) {
          if (record[key] != null) {
            expect(record[key]).toMatch(SYNTHETIC_SESSION_ID);
          }
        }
        if (record.forkedFrom?.sessionId != null) {
          expect(record.forkedFrom.sessionId).toMatch(SYNTHETIC_SESSION_ID);
        }
      }
    }
  });
});
