import { describe, expect, it } from "vitest";

import { resolveConversationSelectors } from "../src/cli/selectors.js";
import type { ConversationMeta } from "../src/models/conversation.js";

describe("resolveConversationSelectors", () => {
  it("matches source-qualified selectors by exact source key", () => {
    const conversation = makeConversation({
      id: "a1234567-1234-1234-1234-123456789012",
      source: "future.agent",
    });

    const resolved = resolveConversationSelectors({
      commandName: "test",
      tokens: ["a123@future.agent"],
      idCandidates: [conversation],
      projectCandidates: [],
    });

    expect(resolved).toEqual([conversation]);
  });

  it("rejects invalid source-qualified selector source keys", () => {
    const conversation = makeConversation({
      id: "a1234567-1234-1234-1234-123456789012",
      source: "future.agent",
    });

    expect(() =>
      resolveConversationSelectors({
        commandName: "test",
        tokens: ["a123@Future.Agent"],
        idCandidates: [conversation],
        projectCandidates: [],
      }),
    ).toThrow(/Invalid source-qualified conversation ID/);
  });

  it("rejects source-qualified selectors with extra separators", () => {
    const conversation = makeConversation({
      id: "a1234567-1234-1234-1234-123456789012",
      source: "future.agent",
    });

    expect(() =>
      resolveConversationSelectors({
        commandName: "test",
        tokens: ["a123@extra@future.agent"],
        idCandidates: [conversation],
        projectCandidates: [],
      }),
    ).toThrow(/Invalid source-qualified conversation ID/);
  });

  it("reports no-match for non-matching source-qualified ID prefixes", () => {
    const conversation = makeConversation({
      id: "a1234567-1234-1234-1234-123456789012",
      source: "future.agent",
    });

    expect(() =>
      resolveConversationSelectors({
        commandName: "test",
        tokens: ["zzzz@future.agent"],
        idCandidates: [conversation],
        projectCandidates: [],
      }),
    ).toThrow(/No conversation or project matches/);
  });
});

function makeConversation(overrides: Partial<ConversationMeta> = {}): ConversationMeta {
  const now = "2026-02-01T10:00:00.000Z";
  const id = overrides.id ?? "a1234567-1234-1234-1234-123456789012";
  return {
    id,
    sourceId: id,
    source: "claude-code",
    title: "Test conversation",
    summary: "",
    summaryKind: "none",
    summaryExtraction: null,
    author: "alice",
    projectName: "webapp",
    projectPath: "/Users/alice/projects/webapp",
    tags: [],
    slug: null,
    createdAt: now,
    discoveredAt: now,
    modifiedAt: now,
    state: "unsaved",
    savedAt: null,
    savedMessageCount: null,
    saveVersion: 0,
    sourcePath: "/tmp/source.jsonl",
    filePath: null,
    sourceMtime: now,
    indexedAt: null,
    originKind: "local",
    originRef: null,
    ...overrides,
  };
}
