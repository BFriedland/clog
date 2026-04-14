import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  browseValues,
  deleteConversation,
  getConversationById,
  insertConversation,
  listConversations,
  resolveConversationId,
  updateConversation,
  withDb,
} from "../src/db/index.js";
import { nowIso } from "../src/utils/time.js";

describe("db", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clog-db-"));
    process.env.CLOG_HOME = tempDir;
  });

  afterEach(async () => {
    delete process.env.CLOG_HOME;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("creates schema on first access", async () => {
    await withDb(() => undefined);

    const dbPath = path.join(tempDir, "clog.db");
    await expect(fs.stat(dbPath)).resolves.toBeTruthy();
  });

  it("inserts and reads a conversation", async () => {
    const conversation = makeConversation();
    await insertConversation(conversation);

    const loaded = await getConversationById(conversation.id);
    expect(loaded).toEqual(conversation);
  });

  it("updates a conversation", async () => {
    const conversation = makeConversation();
    await insertConversation(conversation);

    const updated = {
      ...conversation,
      title: "Updated title",
      projectName: "other-project",
      tags: ["debugging", "auth"],
    };

    await updateConversation(updated);

    await expect(getConversationById(conversation.id)).resolves.toEqual(updated);
  });

  it("lists conversations with state and project filters", async () => {
    await insertConversation(makeConversation());
    await insertConversation(
      makeConversation({
        id: "b2345678-1234-1234-1234-123456789012",
        sourceId: "b2345678-1234-1234-1234-123456789012",
        state: "published",
        projectName: "api-service",
      }),
    );

    const published = await listConversations({ states: ["published"] });
    expect(published).toHaveLength(1);

    const byProject = await listConversations({ projectName: "api-service" });
    expect(byProject).toHaveLength(2);
  });

  it("filters tags by exact case-insensitive match", async () => {
    await insertConversation(
      makeConversation({
        tags: ["debugging"],
      }),
    );
    await insertConversation(
      makeConversation({
        id: "d2345678-1234-1234-1234-123456789012",
        sourceId: "d2345678-1234-1234-1234-123456789012",
        tags: ["bug"],
      }),
    );

    const bug = await listConversations({ tag: "BUG" });
    const debugging = await listConversations({ tag: "debugging" });

    expect(bug).toHaveLength(1);
    expect(bug[0]?.tags).toEqual(["bug"]);
    expect(debugging).toHaveLength(1);
    expect(debugging[0]?.tags).toEqual(["debugging"]);
  });

  it("resolves short ids and source-qualified ids", async () => {
    await insertConversation(makeConversation());
    await insertConversation(
      makeConversation({
        id: "a123ffff-1234-1234-1234-123456789012",
        sourceId: "a123ffff-1234-1234-1234-123456789012",
        source: "codex-cli",
      }),
    );

    await expect(resolveConversationId("a123")).rejects.toThrow(/ambiguous/i);
    await expect(resolveConversationId("a123@claude-code")).resolves.toEqual({
      id: "a1234567-1234-1234-1234-123456789012",
      source: "claude-code",
    });
  });

  it("browses published authors and tags", async () => {
    await insertConversation(
      makeConversation({
        state: "published",
        tags: ["auth", "debugging"],
      }),
    );
    await insertConversation(
      makeConversation({
        id: "c2345678-1234-1234-1234-123456789012",
        sourceId: "c2345678-1234-1234-1234-123456789012",
        state: "published",
        author: "bob",
        tags: ["auth"],
      }),
    );

    await expect(browseValues("author")).resolves.toEqual([
      { name: "alice", count: 1 },
      { name: "bob", count: 1 },
    ]);
    await expect(browseValues("tags_json")).resolves.toEqual([
      { name: "auth", count: 2 },
      { name: "debugging", count: 1 },
    ]);
  });

  it("deletes a conversation", async () => {
    const conversation = makeConversation();
    await insertConversation(conversation);

    await deleteConversation(conversation.id);

    await expect(getConversationById(conversation.id)).resolves.toBeNull();
  });
});

function makeConversation(
  overrides: Partial<ReturnType<typeof baseConversation>> = {},
) {
  return {
    ...baseConversation(),
    ...overrides,
  };
}

function baseConversation() {
  const timestamp = nowIso();

  return {
    id: "a1234567-1234-1234-1234-123456789012",
    sourceId: "a1234567-1234-1234-1234-123456789012",
    source: "claude-code",
    title: "Debug auth",
    summary: "",
    author: "alice",
    projectName: "api-service",
    projectPath: "/tmp/api-service",
    tags: ["debugging"],
    slug: null,
    createdAt: timestamp,
    discoveredAt: timestamp,
    modifiedAt: timestamp,
    state: "discovered" as const,
    publishedAt: null,
    publishedMessageCount: null,
    publishVersion: 0,
    sourcePath: "/tmp/source.jsonl",
    filePath: null,
    sourceMtime: null,
  };
}
