import { describe, expect, it } from "vitest";

import type { ConversationMeta } from "../src/models/conversation.js";
import {
  buildFullConversationGraphStatusMap,
  buildRelatedConversationView,
} from "../src/conversations/view.js";
import {
  buildRelatedConversationGraphs,
  conversationIdentityKey,
  projectRelatedConversationGraph,
} from "../src/relationships/graph.js";

describe("related conversation graphs", () => {
  it("builds a deterministic linear graph and collapses it to its leaf", () => {
    const root = conversation("root", "2026-01-01T00:00:00.000Z");
    const child = conversation(
      "child",
      "2026-01-02T00:00:00.000Z",
      root,
    );
    const leaf = conversation(
      "leaf",
      "2026-01-03T00:00:00.000Z",
      child,
    );

    const [graph] = buildRelatedConversationGraphs([leaf, root, child]);
    const projection = projectRelatedConversationGraph(
      graph!,
      new Set([root, child, leaf].map(conversationIdentityKey)),
    );

    expect(graph).toMatchObject({
      root: { source: "codex-cli", sourceId: "root" },
      completeness: "complete",
    });
    expect(graph?.members.map((member) => member.conversation.id)).toEqual([
      "child",
      "leaf",
      "root",
    ]);
    expect(projection?.representative.conversation.id).toBe("leaf");
    expect(projection?.branchCount).toBe(1);
  });

  it("keeps sibling leaves in one graph and chooses the newest live endpoint", () => {
    const root = conversation("root", "2026-01-01T00:00:00.000Z");
    const older = conversation(
      "older",
      "2026-01-02T00:00:00.000Z",
      root,
      "2026-01-04T00:00:00.000Z",
    );
    const newer = conversation(
      "newer",
      "2026-01-03T00:00:00.000Z",
      root,
      "2026-01-05T00:00:00.000Z",
    );

    const [graph] = buildRelatedConversationGraphs([root, older, newer]);
    const projection = projectRelatedConversationGraph(
      graph!,
      new Set([root, older, newer].map(conversationIdentityKey)),
    );

    expect(projection?.branchCount).toBe(2);
    expect(projection?.representative.conversation.id).toBe("newer");
  });

  it("treats a parent continued after its newest child fork as a live endpoint", () => {
    const root = conversation(
      "root",
      "2026-01-01T00:00:00.000Z",
      null,
      "2026-01-04T00:00:00.000Z",
    );
    const child = conversation(
      "child",
      "2026-01-03T00:00:00.000Z",
      root,
      "2026-01-03T12:00:00.000Z",
    );

    const [graph] = buildRelatedConversationGraphs([root, child]);
    const projection = projectRelatedConversationGraph(
      graph!,
      new Set([root, child].map(conversationIdentityKey)),
    );

    expect(projection?.branchCount).toBe(2);
    expect(projection?.representative.conversation.id).toBe("root");
  });

  it("uses visible members when lifecycle filters hide a newer child", () => {
    const root = conversation("root", "2026-01-01T00:00:00.000Z");
    const child = conversation(
      "child",
      "2026-01-03T00:00:00.000Z",
      root,
    );
    const [graph] = buildRelatedConversationGraphs([root, child]);
    const projection = projectRelatedConversationGraph(
      graph!,
      new Set([conversationIdentityKey(root)]),
    );

    expect(projection?.representative.conversation.id).toBe("root");
    expect(projection?.branchCount).toBe(1);
    expect(projection?.hasHiddenMembers).toBe(true);
  });

  it("compresses hidden intermediaries without inventing another visible branch", () => {
    const root = conversation(
      "root",
      "2026-01-01T00:00:00.000Z",
      null,
      "2026-01-01T12:00:00.000Z",
    );
    const hidden = conversation(
      "hidden",
      "2026-01-02T00:00:00.000Z",
      root,
    );
    const leaf = conversation(
      "leaf",
      "2026-01-03T00:00:00.000Z",
      hidden,
    );
    const [graph] = buildRelatedConversationGraphs([root, hidden, leaf]);
    const visibleKeys = new Set(
      [root, leaf].map(conversationIdentityKey),
    );

    const projection = projectRelatedConversationGraph(graph!, visibleKeys);

    expect(projection?.branchCount).toBe(1);
    expect(projection?.representative.conversation.id).toBe("leaf");
    expect(projection?.liveness.get(conversationIdentityKey(root))).toBe(
      "superseded",
    );

    root.sourceMtime = "2026-01-04T00:00:00.000Z";
    const [continuedGraph] = buildRelatedConversationGraphs([
      root,
      hidden,
      leaf,
    ]);
    const continued = projectRelatedConversationGraph(
      continuedGraph!,
      visibleKeys,
    );

    expect(continued?.branchCount).toBe(2);
    expect(continued?.representative.conversation.id).toBe("root");
  });

  it("uses local source mtime and imported creation time", () => {
    const root = conversation("root", "2026-01-01T00:00:00.000Z");
    const local = conversation(
      "z-local",
      "2026-01-02T00:00:00.000Z",
      root,
      "2026-02-01T00:00:00.000Z",
    );
    const imported = conversation(
      "a-imported",
      "2026-01-20T00:00:00.000Z",
      root,
      "2026-03-01T00:00:00.000Z",
      "git",
    );
    const [graph] = buildRelatedConversationGraphs([root, imported, local]);
    const projection = projectRelatedConversationGraph(
      graph!,
      new Set([root, imported, local].map(conversationIdentityKey)),
    );

    expect(projection?.representative.conversation.id).toBe("z-local");
  });

  it("uses full source identity to break equal activity-time ties", () => {
    const root = conversation("root", "2026-01-01T00:00:00.000Z");
    const first = conversation(
      "a-child",
      "2026-01-02T00:00:00.000Z",
      root,
      "2026-01-03T00:00:00.000Z",
    );
    const second = conversation(
      "z-child",
      "2026-01-02T00:00:00.000Z",
      root,
      "2026-01-03T00:00:00.000Z",
    );
    const [graph] = buildRelatedConversationGraphs([second, root, first]);
    const projection = projectRelatedConversationGraph(
      graph!,
      new Set([root, first, second].map(conversationIdentityKey)),
    );

    expect(projection?.representative.identity).toEqual({
      source: "codex-cli",
      sourceId: "a-child",
    });
  });

  it("normalizes duplicate source identities independently of input order", () => {
    const root = conversation("root", "2026-01-01T00:00:00.000Z");
    const child = conversation(
      "child",
      "2026-01-02T00:00:00.000Z",
      root,
    );
    const duplicate = {
      ...child,
      id: "duplicate-row",
      sourceMtime: "2026-01-04T00:00:00.000Z",
    };

    expect(
      buildRelatedConversationGraphs([root, child, duplicate]),
    ).toEqual(
      buildRelatedConversationGraphs([duplicate, child, root]),
    );
  });

  it("keeps invalid observed activity distinct from proven supersession", () => {
    const root = conversation(
      "root",
      "2026-01-01T00:00:00.000Z",
      null,
      "not-a-timestamp",
    );
    const child = conversation(
      "child",
      "2026-01-02T00:00:00.000Z",
      root,
    );
    const [graph] = buildRelatedConversationGraphs([root, child]);
    const projection = projectRelatedConversationGraph(
      graph!,
      new Set([root, child].map(conversationIdentityKey)),
    );

    expect(projection?.liveness.get(conversationIdentityKey(root))).toBe(
      "unproven",
    );
    expect(projection?.representative.conversation.id).toBe("child");
  });

  it("keeps a missing parent as an external root and marks ancestry incomplete", () => {
    const missing = conversation("missing", "2025-01-01T00:00:00.000Z");
    const child = conversation(
      "child",
      "2026-01-01T00:00:00.000Z",
      missing,
    );
    const [graph] = buildRelatedConversationGraphs([child]);

    expect(graph).toMatchObject({
      root: { source: "codex-cli", sourceId: "missing" },
      completeness: "incomplete",
      externalParents: [{ source: "codex-cli", sourceId: "missing" }],
    });
    expect(buildRelatedConversationView([child])[0]).toMatchObject({
      immediateParentRelationship: branchTo(missing),
      immediateParentIdentity: {
        source: "codex-cli",
        sourceId: "missing",
      },
      immediateParentId: null,
      inheritedMessagesMayAppear: true,
    });
  });

  it("diagnoses cycles and conflicting confirmed parents without choosing an edge", () => {
    const first = conversation("first", "2026-01-01T00:00:00.000Z");
    const second = conversation(
      "second",
      "2026-01-02T00:00:00.000Z",
      first,
    );
    first.relationships = [branchTo(second)];

    const conflicting = conversation(
      "conflict",
      "2026-01-03T00:00:00.000Z",
      first,
    );
    const duplicate = {
      ...conflicting,
      id: "conflict-copy",
      relationships: [branchTo(second)],
    };

    const graphs = buildRelatedConversationGraphs([
      second,
      first,
      conflicting,
      duplicate,
    ]);
    const warnings = graphs.flatMap((graph) => graph.warnings);

    expect(warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "conversation_relationship_cycle" }),
      expect.objectContaining({
        code: "conversation_relationship_parent_conflict",
        conversation: { source: "codex-cli", sourceId: "conflict" },
      }),
    ]));
    expect(graphs.some((graph) => graph.completeness === "invalid")).toBe(true);

    const statuses = buildFullConversationGraphStatusMap([
      second,
      first,
      conflicting,
      duplicate,
    ]);
    expect(statuses.get(conversationIdentityKey(first))).toEqual({
      liveness: "unproven",
      relationshipCompleteness: "invalid",
    });
    expect(statuses.get(conversationIdentityKey(second))).toEqual({
      liveness: "unproven",
      relationshipCompleteness: "invalid",
    });
  });

  it("does not choose a parent when saved and live observations conflict", () => {
    const child = conversation("child", "2026-01-02T00:00:00.000Z");
    const savedParent = conversation(
      "saved-parent",
      "2026-01-01T00:00:00.000Z",
    );
    const liveParent = conversation(
      "live-parent",
      "2026-01-01T00:00:00.000Z",
    );
    child.relationships = [branchTo(savedParent)];

    const [graph] = buildRelatedConversationGraphs([child], [{
      source: child.source,
      sourceId: child.sourceId,
      relationships: [
        branchTo(savedParent),
        branchTo(liveParent),
      ],
      observationConflict: true,
    }]);

    expect(graph?.completeness).toBe("invalid");
    expect(graph?.members[0]).toMatchObject({
      parent: null,
      parentRelationship: null,
    });
    expect(graph?.warnings).toContainEqual({
      code: "conversation_relationship_observation_conflict",
      conversation: {
        source: "codex-cli",
        sourceId: "child",
      },
      parents: [
        { source: "codex-cli", sourceId: "live-parent" },
        { source: "codex-cli", sourceId: "saved-parent" },
      ],
    });
  });
});

function conversation(
  id: string,
  createdAt: string,
  parent: ConversationMeta | null = null,
  sourceMtime = createdAt,
  originKind: ConversationMeta["originKind"] = "local",
): ConversationMeta {
  return {
    id,
    sourceId: id,
    source: "codex-cli",
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
    state: "unsaved",
    savedAt: null,
    savedMessageCount: null,
    saveVersion: 0,
    transcriptProjectionVersion: null,
    sourcePath: `/tmp/${id}.jsonl`,
    filePath: null,
    sourceMtime,
    indexedAt: null,
    originKind,
    originRef: originKind === "local" ? null : "remote",
    relationshipInspection: parent
      ? { status: "linked", version: 1, diagnostic: null }
      : { status: "none_found", version: 1, diagnostic: null },
    relationships: parent ? [branchTo(parent)] : [],
  };
}

function branchTo(
  parent: Pick<ConversationMeta, "source" | "sourceId">,
): ConversationMeta["relationships"][number] {
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
