import { describe, expect, it } from "vitest";

import type {
  ConversationMeta,
  ConversationRelationship,
} from "../src/models/conversation.js";
import {
  collapseRelatedConversationSearchHits,
  selectIndexEligibleConversations,
} from "../src/search/relationships.js";

describe("related-conversation search policy", () => {
  it("indexes leaves and continued parents while skipping superseded parents", () => {
    const parent = conversation("parent", "2026-01-01T00:00:00.000Z");
    const child = conversation(
      "child",
      "2026-01-02T00:00:00.000Z",
      parent,
    );

    expect(
      selectIndexEligibleConversations([parent, child]).map(({ id }) => id),
    ).toEqual(["child"]);

    parent.sourceMtime = "2026-01-03T00:00:00.000Z";
    expect(
      selectIndexEligibleConversations([parent, child]).map(({ id }) => id),
    ).toEqual(["parent", "child"]);
  });

  it("keeps a parent indexable when its source activity cannot be proven", () => {
    const parent = conversation("parent", "2026-01-01T00:00:00.000Z");
    const child = conversation(
      "child",
      "2026-01-02T00:00:00.000Z",
      parent,
    );
    parent.sourceMtime = null;
    parent.originKind = "git";
    parent.originRef = "https://example.test/conversations.git";

    expect(
      selectIndexEligibleConversations([parent, child]).map(({ id }) => id),
    ).toEqual(["parent", "child"]);
  });

  it("requires current relationship and transcript contracts before indexing", () => {
    const stale = conversation("stale", "2026-01-01T00:00:00.000Z");
    stale.relationshipInspection = {
      status: "none_found",
      version: 1,
      diagnostic: null,
    };

    expect(selectIndexEligibleConversations([stale])).toEqual([]);
  });

  it("restores superseded branches when index-all-branches is enabled", () => {
    const parent = conversation("parent", "2026-01-01T00:00:00.000Z");
    const child = conversation(
      "child",
      "2026-01-02T00:00:00.000Z",
      parent,
    );

    expect(
      selectIndexEligibleConversations(
        [parent, child],
        { indexAllBranches: true },
      ).map(({ id }) => id),
    ).toEqual(["parent", "child"]);
  });

  it("collapses related hits to the highest score and reports the snippet owner", () => {
    const parent = conversation("parent", "2026-01-01T00:00:00.000Z");
    const child = conversation(
      "child",
      "2026-01-02T00:00:00.000Z",
      parent,
    );
    const results = collapseRelatedConversationSearchHits(
      [parent, child],
      [
        hit("parent", 0.7),
        hit("child", 0.9),
      ],
    );

    expect(results).toEqual([
      expect.objectContaining({
        conversationId: "child",
        snippetBranchId: "child",
        endpointCount: 1,
        knownRootIdentity: {
          source: "claude-code",
          sourceId: "parent",
        },
        relationshipCompleteness: "complete",
      }),
    ]);
  });

  it("returns concrete hits for all-branches requests and invalid graphs", () => {
    const first = conversation("first", "2026-01-01T00:00:00.000Z");
    const second = conversation(
      "second",
      "2026-01-02T00:00:00.000Z",
      first,
    );
    const hits = [hit("first", 0.9), hit("second", 0.8)];

    expect(
      collapseRelatedConversationSearchHits(
        [first, second],
        hits,
        { allBranches: true },
      ),
    ).toHaveLength(2);

    first.relationships = [branchTo(second)];
    const invalid = collapseRelatedConversationSearchHits(
      [first, second],
      hits,
    );
    expect(invalid).toHaveLength(2);
    expect(invalid.every(
      (result) => result.relationshipCompleteness === "invalid",
    )).toBe(true);
  });

  it("connects children through one unresolved parent identity", () => {
    const missingParent = conversation(
      "missing",
      "2026-01-01T00:00:00.000Z",
    );
    const first = conversation(
      "first",
      "2026-01-02T00:00:00.000Z",
      missingParent,
    );
    const second = conversation(
      "second",
      "2026-01-03T00:00:00.000Z",
      missingParent,
    );

    const results = collapseRelatedConversationSearchHits(
      [first, second],
      [hit("first", 0.9), hit("second", 0.8)],
    );
    expect(results).toEqual([
      expect.objectContaining({
        conversationId: "first",
        relationshipCompleteness: "incomplete",
      }),
    ]);
  });
});

function conversation(
  id: string,
  createdAt: string,
  parent: ConversationMeta | null = null,
): ConversationMeta {
  return {
    id,
    sourceId: id,
    source: "claude-code",
    title: id,
    summary: "",
    summaryKind: "none",
    summaryExtraction: null,
    author: "alice",
    projectName: "clog",
    projectPath: "/repo/clog",
    tags: [],
    slug: null,
    createdAt,
    discoveredAt: createdAt,
    modifiedAt: createdAt,
    state: "saved",
    savedAt: createdAt,
    savedMessageCount: 1,
    saveVersion: 1,
    transcriptProjectionVersion: 2,
    sourcePath: `/sources/${id}.jsonl`,
    filePath: `/managed/${id}.jsonl`,
    sourceMtime: createdAt,
    indexedAt: null,
    originKind: "local",
    originRef: null,
    relationshipInspection: parent
      ? {
          status: "linked",
          version: 2,
          diagnostic: null,
        }
      : {
          status: "none_found",
          version: 2,
          diagnostic: null,
        },
    relationships: parent ? [branchTo(parent)] : [],
  };
}

function branchTo(
  parent: Pick<ConversationMeta, "source" | "sourceId">,
): ConversationRelationship {
  return {
    kind: "branch",
    parent: {
      source: parent.source,
      sourceId: parent.sourceId,
    },
    evidence: "source",
    branchPoint: null,
  };
}

function hit(conversationId: string, score: number) {
  return {
    conversationId,
    score,
    text: `match from ${conversationId}`,
    metadata: { conversationId },
  };
}
