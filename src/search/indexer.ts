/**
 * Search indexer — orchestrates chunking, embedding, and vector storage.
 *
 * Depends only on the interfaces in types.ts. Concrete provider instances
 * are passed in by the caller (via deps.ts).
 */

import { chunkConversation } from "./chunker.js";
import type { EmbeddingProvider, VectorStore, VectorEntry, VectorResult } from "./types.js";
import type { ConversationMeta, Message } from "../models/conversation.js";

/**
 * Index a single conversation: chunk it, embed all chunks, upsert into
 * the vector store. Deletes existing chunks first for clean re-indexing.
 *
 * Returns the number of chunks indexed.
 */
export async function indexConversation(
  conv: ConversationMeta,
  messages: Message[],
  embedding: EmbeddingProvider,
  vectorStore: VectorStore,
): Promise<number> {
  const chunks = chunkConversation(conv, messages);
  if (chunks.length === 0) return 0;

  // Remove old chunks before re-inserting
  await vectorStore.delete(conv.id);

  // Embed all chunk texts
  const texts = chunks.map((c) => c.text);
  const vectors = await embedding.embed(texts);

  // Build vector entries
  const entries: VectorEntry[] = chunks.map((chunk, i) => ({
    id: `${chunk.conversationId}:${chunk.chunkIndex}`,
    vector: vectors[i],
    metadata: {
      conversationId: chunk.conversationId,
      chunkIndex: chunk.chunkIndex,
      messageStartIndex: chunk.messageStartIndex,
      messageEndIndex: chunk.messageEndIndex,
      text: chunk.text,
    },
  }));

  await vectorStore.upsert(entries);
  return chunks.length;
}

/** Default minimum cosine similarity score for search results. */
export const DEFAULT_MIN_SCORE = 0.15;

/**
 * Search the vector store for conversations matching a query.
 *
 * Returns results sorted by descending relevance, deduplicated to one
 * result per conversation (the best-matching chunk). Results below
 * minScore are filtered out.
 */
export async function searchConversations(
  query: string,
  limit: number,
  embedding: EmbeddingProvider,
  vectorStore: VectorStore,
  conversationIdFilter?: Set<string>,
  minScore: number = DEFAULT_MIN_SCORE,
): Promise<VectorResult[]> {
  const [queryVector] = await embedding.embed([query]);

  // Over-fetch to account for dedup and filtering
  const fetchCount = conversationIdFilter
    ? Math.min(limit * 10, 200)
    : limit * 3;
  const raw = await vectorStore.query(queryVector, fetchCount);

  // Deduplicate: keep best-scoring chunk per conversation
  const seen = new Set<string>();
  const deduped: VectorResult[] = [];

  for (const r of raw) {
    if (r.score < minScore) continue;
    if (conversationIdFilter && !conversationIdFilter.has(r.conversationId)) continue;
    if (seen.has(r.conversationId)) continue;
    seen.add(r.conversationId);
    deduped.push(r);
    if (deduped.length >= limit) break;
  }

  return deduped;
}
