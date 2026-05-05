import fs from "node:fs/promises";
import path from "node:path";

import { clearSavedIndexedAt } from "../../db/index.js";
import { writeFileAtomic } from "../../utils/atomic-write.js";
import { getVectorsRoot } from "../../utils/paths.js";
import type { IndexedChunk, SearchHit, VectorStore } from "../types.js";

type VectraLocalIndex = InstanceType<typeof import("vectra").LocalIndex>;

let vectraIndexPromise: Promise<VectraLocalIndex> | null = null;

export class VectraStore implements VectorStore {
  async upsert(id: string, chunks: IndexedChunk[]): Promise<void> {
    const index = await getVectraIndex();

    await index.beginUpdate();
    try {
      await deleteConversationItems(index, id);

      for (const chunk of chunks) {
        const chunkIndex = chunk.metadata.chunkIndex ?? "0";
        await index.upsertItem({
          id: `${id}:${chunkIndex}`,
          vector: chunk.embedding,
          metadata: {
            ...chunk.metadata,
            conversationId: id,
            text: chunk.text,
          },
        });
      }

      await index.endUpdate();
    } catch (error) {
      index.cancelUpdate();
      throw error;
    }
  }

  async search(
    embedding: number[],
    limit: number,
    filter?: Record<string, string>,
  ): Promise<SearchHit[]> {
    const index = await getVectraIndex();
    const results = await index.queryItems(embedding, "", limit, toVectraFilter(filter));
    return results.map((result) => ({
      id: String(result.item.id),
      score: Number(result.score),
      text: String(result.item.metadata.text ?? ""),
      metadata: normalizeMetadata(result.item.metadata),
    }));
  }

  async delete(id: string): Promise<void> {
    const index = await getVectraIndex();

    await index.beginUpdate();
    try {
      await deleteConversationItems(index, id);
      await index.endUpdate();
    } catch (error) {
      index.cancelUpdate();
      throw error;
    }
  }

  async reset(): Promise<void> {
    vectraIndexPromise = null;
    await fs.rm(path.join(getVectorsRoot(), "index.json"), { force: true });
  }
}

export function resetVectraIndex(): void {
  vectraIndexPromise = null;
}

async function getVectraIndex(): Promise<VectraLocalIndex> {
  if (!vectraIndexPromise) {
    vectraIndexPromise = createVectraIndex();
  }

  return vectraIndexPromise;
}

async function createVectraIndex(): Promise<VectraLocalIndex> {
  const { LocalIndex, LocalFileStorage } = await import("vectra");

  // Vectra's default upsertFile writes index.json non-atomically. A Ctrl-C
  // mid-write leaves a torn file that subsequent runs can't read.
  class AtomicLocalFileStorage extends LocalFileStorage {
    async upsertFile(filePath: string, content: Buffer | string): Promise<void> {
      await writeFileAtomic(filePath, content);
    }
  }

  await fs.mkdir(getVectorsRoot(), { recursive: true });
  const index = new LocalIndex(getVectorsRoot(), undefined, new AtomicLocalFileStorage());

  if (!(await index.isIndexCreated())) {
    await index.createIndex();
    return index;
  }

  if (await isVectraIndexTorn()) {
    await recoverUnreadableVectraIndex(index);
  }

  return index;
}

async function isVectraIndexTorn(): Promise<boolean> {
  // Targets the specific failure mode this fix exists for: a Ctrl-C mid-write
  // before atomic upsertFile shipped, leaving a partial JSON file. A schema
  // mismatch or unrelated read error should surface as a normal vectra error
  // rather than silently triggering a destructive rename.
  const indexPath = path.join(getVectorsRoot(), "index.json");

  let content: string;
  try {
    content = await fs.readFile(indexPath, "utf8");
  } catch {
    return false;
  }

  try {
    JSON.parse(content);
    return false;
  } catch {
    return true;
  }
}

async function recoverUnreadableVectraIndex(index: VectraLocalIndex): Promise<void> {
  const indexPath = path.join(getVectorsRoot(), "index.json");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const corruptPath = path.join(getVectorsRoot(), `index.corrupt-${stamp}.json`);

  try {
    await fs.rename(indexPath, corruptPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  await index.createIndex();
  await clearSavedIndexedAt();
  process.stderr.write(
    'warning: vector search index was unreadable and has been reset; run "clog index" to rebuild search.\n',
  );
}

async function deleteConversationItems(index: VectraLocalIndex, conversationId: string): Promise<void> {
  let items: Array<{ id: string }> = [];

  try {
    items = await index.listItemsByMetadata({
      conversationId: { $eq: conversationId },
    });
  } catch {
    items = [];
  }

  for (const item of items) {
    await index.deleteItem(item.id);
  }
}

function toVectraFilter(
  filter: Record<string, string> | undefined,
): Record<string, { $eq: string }> | undefined {
  if (!filter || Object.keys(filter).length === 0) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(filter).map(([key, value]) => [key, { $eq: value }]),
  );
}

function normalizeMetadata(metadata: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [key, value == null ? "" : String(value)]),
  );
}
