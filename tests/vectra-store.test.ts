import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getConversationById, insertConversation } from "../src/db/index.js";
import type { ConversationMeta } from "../src/models/conversation.js";
import { resetVectraIndex, VectraStore } from "../src/search/vectorstores/vectra.js";
import { getVectorsRoot } from "../src/utils/paths.js";

describe("VectraStore", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clog-vectra-"));
    process.env.CLOG_HOME = tempDir;
    resetVectraIndex();
  });

  afterEach(async () => {
    resetVectraIndex();
    delete process.env.CLOG_HOME;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("recovers from an unreadable index by renaming it aside and clearing indexed_at", async () => {
    const conversation = makeConversation({
      indexedAt: "2026-02-01T10:00:00.000Z",
    });
    await insertConversation(conversation);
    await fs.mkdir(getVectorsRoot(), { recursive: true });
    await fs.writeFile(path.join(getVectorsRoot(), "index.json"), "{", "utf8");
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    try {
      await new VectraStore().delete(conversation.id);

      const reloaded = await getConversationById(conversation.id);
      expect(reloaded?.indexedAt).toBeNull();
      const files = await fs.readdir(getVectorsRoot());
      expect(files).toContain("index.json");
      expect(files.some((file) => file.startsWith("index.corrupt-"))).toBe(true);
      expect(stderrSpy).toHaveBeenCalledWith(
        'warning: vector search index was unreadable and has been reset; run "clog index" to rebuild search.\n',
      );
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("survives a fresh index without triggering recovery", async () => {
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    try {
      await new VectraStore().upsert("abc12345-1234-1234-1234-123456789012", [
        {
          text: "chunk",
          embedding: [1, 0, 0],
          metadata: {
            conversationId: "abc12345-1234-1234-1234-123456789012",
            chunkIndex: "0",
          },
        },
      ]);

      const files = await fs.readdir(getVectorsRoot());
      expect(files).toContain("index.json");
      expect(files.some((file) => file.startsWith("index.corrupt-"))).toBe(false);
      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("propagates query errors instead of silently returning no results", async () => {
    // Set up a real index, then overwrite with a structurally-valid but
    // semantically-wrong shape (e.g. what could happen after a botched
    // migration or incompatible vectra version). isVectraIndexTorn() only
    // catches torn JSON, so this gets past startup and fails at query time.
    await new VectraStore().upsert("abc12345-1234-1234-1234-123456789012", [
      {
        text: "chunk",
        embedding: [1, 0, 0],
        metadata: {
          conversationId: "abc12345-1234-1234-1234-123456789012",
          chunkIndex: "0",
        },
      },
    ]);
    await fs.writeFile(
      path.join(getVectorsRoot(), "index.json"),
      '{"items":"not-an-array"}',
      "utf8",
    );
    resetVectraIndex();

    await expect(new VectraStore().search([1, 0, 0], 5)).rejects.toThrow();
  });

  it("reset() wipes the index file and the next access creates a fresh one", async () => {
    const store = new VectraStore();
    await store.upsert("abc12345-1234-1234-1234-123456789012", [
      {
        text: "chunk",
        embedding: [1, 0, 0],
        metadata: {
          conversationId: "abc12345-1234-1234-1234-123456789012",
          chunkIndex: "0",
        },
      },
    ]);
    expect(await readVectraItemCount()).toBe(1);

    await store.reset();
    expect(
      await fs
        .access(path.join(getVectorsRoot(), "index.json"))
        .then(() => true)
        .catch(() => false),
    ).toBe(false);

    await store.upsert("def45678-1234-1234-1234-123456789012", [
      {
        text: "fresh chunk",
        embedding: [0, 1, 0],
        metadata: {
          conversationId: "def45678-1234-1234-1234-123456789012",
          chunkIndex: "0",
        },
      },
    ]);
    expect(await readVectraItemCount()).toBe(1);
  });
});

async function readVectraItemCount(): Promise<number> {
  const raw = await fs.readFile(path.join(getVectorsRoot(), "index.json"), "utf8");
  const parsed = JSON.parse(raw) as { items?: unknown[] };
  return parsed.items?.length ?? 0;
}

function makeConversation(overrides: Partial<ConversationMeta> = {}): ConversationMeta {
  const id = overrides.id ?? "abc12345-1234-1234-1234-123456789012";
  return {
    id,
    sourceId: id,
    source: "claude-code",
    title: "Recovered index",
    summary: "Search index recovery",
    author: "alice",
    projectName: "api-service",
    projectPath: "/tmp/api-service",
    tags: [],
    slug: null,
    createdAt: "2026-02-01T10:00:00.000Z",
    discoveredAt: "2026-02-01T10:00:00.000Z",
    modifiedAt: "2026-02-01T10:00:00.000Z",
    state: "saved",
    savedAt: "2026-02-01T10:00:00.000Z",
    savedMessageCount: 1,
    saveVersion: 1,
    sourcePath: "/tmp/source.jsonl",
    filePath: "/tmp/raw.jsonl",
    sourceMtime: null,
    indexedAt: null,
    origin: null,
    ...overrides,
  };
}
