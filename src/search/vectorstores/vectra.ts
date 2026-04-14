import fs from "node:fs/promises";

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

    try {
      const results = await index.queryItems(embedding, "", limit, toVectraFilter(filter));
      return results.map((result) => ({
        id: String(result.item.id),
        score: Number(result.score),
        text: String(result.item.metadata.text ?? ""),
        metadata: normalizeMetadata(result.item.metadata),
      }));
    } catch {
      return [];
    }
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
  const { LocalIndex } = await import("vectra");
  await fs.mkdir(getVectorsRoot(), { recursive: true });
  const index = new LocalIndex(getVectorsRoot());

  if (!(await index.isIndexCreated())) {
    await index.createIndex();
  }

  return index;
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
