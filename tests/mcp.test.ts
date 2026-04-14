import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleBrowse, handleGet, handleListPublished, handleListStaged, handleUpdate } from "../src/mcp/handlers.js";
import { getConversationById, insertConversation } from "../src/db/index.js";
import { writeJsonl } from "./helpers/fixtures.js";

describe("mcp handlers", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clog-mcp-"));
    process.env.CLOG_HOME = tempDir;

    const rawDir = path.join(tempDir, "raw", "claude-code");
    await fs.mkdir(rawDir, { recursive: true });
    const filePath = path.join(rawDir, "abc12345-1234-1234-1234-123456789012.jsonl");

    await writeJsonl(filePath, [
      {
        type: "user",
        timestamp: "2026-02-01T10:00:00.000Z",
        message: { role: "user", content: "Debug auth flow" },
      },
      {
        type: "assistant",
        timestamp: "2026-02-01T10:00:01.000Z",
        message: {
          id: "msg_1",
          role: "assistant",
          content: [{ type: "text", text: "Looking into it." }],
        },
      },
    ]);

    await insertConversation({
      id: "abc12345-1234-1234-1234-123456789012",
      sourceId: "abc12345-1234-1234-1234-123456789012",
      source: "claude-code",
      title: "Debug auth flow",
      summary: "",
      author: "alice",
      projectName: "api-service",
      projectPath: "/tmp/api-service",
      tags: ["auth"],
      slug: null,
      createdAt: "2026-02-01T10:00:00.000Z",
      discoveredAt: "2026-02-01T10:00:00.000Z",
      modifiedAt: "2026-02-01T10:00:00.000Z",
      state: "published",
      publishedAt: "2026-02-01T10:00:02.000Z",
      publishedMessageCount: 2,
      publishVersion: 1,
      sourcePath: filePath,
      filePath,
      sourceMtime: null,
      indexedAt: "2026-02-01T10:00:03.000Z",
    });
  });

  afterEach(async () => {
    delete process.env.CLOG_HOME;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("lists published conversations", async () => {
    const result = await handleListPublished({});
    expect(result.totalCount).toBe(1);
    expect(result.conversations[0]?.source).toBe("claude-code");
  });

  it("gets a conversation with parsed messages", async () => {
    const result = await handleGet({ id: "abc12345", maxMessages: 20 });
    expect(result.totalMessages).toBe(2);
    expect(result.messages[0]?.content).toBe("Debug auth flow");
  });

  it("returns clog-style guidance when content is missing", async () => {
    await fs.rm(path.join(tempDir, "raw", "claude-code", "abc12345-1234-1234-1234-123456789012.jsonl"));

    await expect(handleGet({ id: "abc12345", maxMessages: 20 })).rejects.toThrow(
      'Curated raw file is missing for abc12345-1234-1234-1234-123456789012. Run "clog add abc1234" to recreate it.',
    );
  });

  it("includes a request-more truncation note when clog_get is truncated", async () => {
    const result = await handleGet({ id: "abc12345", maxMessages: 1 });
    expect(result.truncated).toBe(true);
    expect(result.truncationNote).toContain("Request a larger maxMessages value");
  });

  it("updates metadata and tags", async () => {
    const result = await handleUpdate({
      id: "abc12345",
      title: "Updated title",
      addTags: ["debugging"],
    });

    expect(result.conversation.title).toBe("Updated title");
    expect(result.conversation.tags).toContain("debugging");
  });

  it("leaves indexedAt unchanged for tag-only updates", async () => {
    await handleUpdate({
      id: "abc12345",
      addTags: ["debugging"],
    });

    const conversation = await getConversationById("abc12345-1234-1234-1234-123456789012");
    expect(conversation?.indexedAt).toBe("2026-02-01T10:00:03.000Z");
  });

  it("leaves indexedAt unchanged when search is not configured", async () => {
    await handleUpdate({
      id: "abc12345",
      title: "Updated title",
    });

    const conversation = await getConversationById("abc12345-1234-1234-1234-123456789012");
    expect(conversation?.indexedAt).toBe("2026-02-01T10:00:03.000Z");
  });

  it("leaves modifiedAt unchanged for no-op updates", async () => {
    const before = await getConversationById("abc12345-1234-1234-1234-123456789012");
    const result = await handleUpdate({
      id: "abc12345",
      title: "Debug auth flow",
      addTags: ["auth"],
    });
    const after = await getConversationById("abc12345-1234-1234-1234-123456789012");

    expect(result.conversation.modifiedAt).toBe(before?.modifiedAt);
    expect(after?.modifiedAt).toBe(before?.modifiedAt);
  });

  it("browses distinct values", async () => {
    const tags = await handleBrowse({ by: "tags" });
    const authors = await handleBrowse({ by: "authors" });
    expect(tags.items).toEqual([{ name: "auth", count: 1 }]);
    expect(authors.items).toEqual([{ name: "alice", count: 1 }]);
  });

  it("lists staged separately", async () => {
    const result = await handleListStaged({});
    expect(result.totalCount).toBe(0);
  });
});
