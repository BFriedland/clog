import { describe, expect, it } from "vitest";

import {
  conversationBranchPointSchema,
  conversationMetaSchema,
  messageSchema,
  preserveConfirmedRelationship,
  relationshipInspectionSchema,
} from "../src/models/conversation.js";

describe("messageSchema", () => {
  it("accepts a minimal message", () => {
    const parsed = messageSchema.parse({
      role: "assistant",
      content: "hello",
      timestamp: null,
    });

    expect(parsed.role).toBe("assistant");
  });
});

describe("conversationMetaSchema", () => {
  it("accepts a phase 1 conversation row", () => {
    const parsed = conversationMetaSchema.parse({
      id: "abc",
      sourceId: "abc",
      source: "claude-code",
      title: "Title",
      summary: "",
      author: "alice",
      projectName: "repo",
      projectPath: "/tmp/repo",
      tags: ["tag"],
      slug: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      discoveredAt: "2026-01-01T00:00:00.000Z",
      modifiedAt: "2026-01-01T00:00:00.000Z",
      state: "unsaved",
      savedAt: null,
      savedMessageCount: null,
      saveVersion: 0,
      sourcePath: "/tmp/source.jsonl",
      filePath: null,
      sourceMtime: null,
      indexedAt: null,
      originKind: "local",
      originRef: null,
    });

    expect(parsed.state).toBe("unsaved");
    expect(parsed.relationshipInspection).toEqual({
      status: "unexamined",
      version: null,
      diagnostic: null,
    });
    expect(parsed.relationships).toEqual([]);
    expect(parsed.transcriptProjectionVersion).toBeNull();
  });
});

describe("relationshipInspectionSchema", () => {
  const branch = {
    kind: "branch" as const,
    parent: {
      source: "codex-cli",
      sourceId: "parent-id",
    },
    evidence: "source" as const,
    branchPoint: null,
  };

  it.each([
    {
      status: "unexamined",
      version: null,
      diagnostic: null,
      relationships: [],
    },
    {
      status: "none_found",
      version: 1,
      diagnostic: null,
      relationships: [],
    },
    {
      status: "linked",
      version: 1,
      diagnostic: null,
      relationships: [branch],
    },
    {
      status: "unknown",
      version: 1,
      diagnostic: "conflicting_parent",
      relationships: [],
    },
  ])("accepts the $status invariant", (inspection) => {
    expect(relationshipInspectionSchema.parse(inspection)).toEqual(inspection);
  });

  it.each([
    {
      status: "unexamined",
      version: 1,
      diagnostic: null,
      relationships: [],
    },
    {
      status: "none_found",
      version: 1,
      diagnostic: "unexpected",
      relationships: [],
    },
    {
      status: "linked",
      version: 1,
      diagnostic: null,
      relationships: [],
    },
    {
      status: "unknown",
      version: 1,
      diagnostic: null,
      relationships: [],
    },
  ])("rejects an invalid $status invariant", (inspection) => {
    expect(() => relationshipInspectionSchema.parse(inspection)).toThrow();
  });

  it("rejects empty branch-point identifiers", () => {
    expect(() =>
      conversationBranchPointSchema.parse({
        kind: "source-message",
        id: "",
      }),
    ).toThrow();
  });
});

describe("preserveConfirmedRelationship", () => {
  it("keeps source-confirmed evidence while advancing the inspection version", () => {
    const confirmedBranch = {
      kind: "branch" as const,
      parent: {
        source: "claude-code",
        sourceId: "confirmed-parent",
      },
      evidence: "source" as const,
      branchPoint: null,
    };

    expect(
      preserveConfirmedRelationship(
        {
          relationshipInspection: {
            status: "linked",
            version: 1,
            diagnostic: null,
          },
          relationships: [confirmedBranch],
        },
        {
          status: "linked",
          version: 2,
          diagnostic: null,
          relationships: [{
            kind: "branch",
            parent: {
              source: "claude-code",
              sourceId: "inferred-parent",
            },
            evidence: "inferred",
            branchPoint: null,
          }],
        },
      ),
    ).toEqual({
      status: "linked",
      version: 2,
      diagnostic: null,
      relationships: [confirmedBranch],
    });
  });
});
