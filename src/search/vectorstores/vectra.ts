/**
 * Vector store using Vectra (local JSON files).
 *
 * Stores vectors as a JSON index file in ~/.clog/vectors/.
 * Brute-force cosine similarity — fine for <10K items.
 */

import path from "node:path";
import { getClogHome } from "../../config/index.js";
import type { VectorStore, VectorEntry, VectorResult, ChunkMetadata } from "../types.js";

type LocalIndexType = InstanceType<typeof import("vectra").LocalIndex>;

let indexInstance: LocalIndexType | null = null;

function getVectorsDir(): string {
  return path.join(getClogHome(), "vectors");
}

async function getIndex(): Promise<LocalIndexType> {
  if (indexInstance) return indexInstance;

  const { LocalIndex } = await import("vectra");
  const idx = new LocalIndex(getVectorsDir());

  if (!(await idx.isIndexCreated())) {
    await idx.createIndex();
  }

  indexInstance = idx;
  return idx;
}

export class VectraStore implements VectorStore {
  async upsert(entries: VectorEntry[]): Promise<void> {
    const index = await getIndex();

    await index.beginUpdate();
    try {
      for (const entry of entries) {
        await index.upsertItem({
          id: entry.id,
          vector: entry.vector,
          metadata: entry.metadata as unknown as Record<string, string | number | boolean>,
        });
      }
      await index.endUpdate();
    } catch (err) {
      index.cancelUpdate();
      throw err;
    }
  }

  async delete(conversationId: string): Promise<void> {
    const index = await getIndex();

    // Find all items for this conversation
    let items;
    try {
      items = await index.listItemsByMetadata({
        conversationId: { $eq: conversationId },
      });
    } catch {
      // Index might be empty or not created yet
      return;
    }

    if (items.length === 0) return;

    await index.beginUpdate();
    try {
      for (const item of items) {
        await index.deleteItem(item.id);
      }
      await index.endUpdate();
    } catch (err) {
      index.cancelUpdate();
      throw err;
    }
  }

  async query(
    vector: number[],
    topK: number,
  ): Promise<VectorResult[]> {
    const index = await getIndex();

    let results;
    try {
      // Vectra's queryItems: (vector, query, topK, filter?, isBm25?)
      // Empty string disables BM25 keyword search — pure vector similarity only
      results = await index.queryItems(vector, "", topK);
    } catch {
      // Index might be empty
      return [];
    }

    return results.map((result) => {
      const metadata = result.item.metadata as unknown as ChunkMetadata;
      return {
        conversationId: metadata.conversationId,
        chunkIndex: metadata.chunkIndex,
        score: result.score,
        text: metadata.text,
      };
    });
  }
}

/** Reset cached index instance (for testing). */
export function resetVectraIndex(): void {
  indexInstance = null;
}
