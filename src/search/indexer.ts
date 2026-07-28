import type { ConversationMeta, Message } from "../models/conversation.js";
import { chunkConversationMessages } from "./chunker.js";
import type { EmbeddingProvider, SearchHit, VectorStore } from "./types.js";

const MIN_SEARCH_SCORE = 0.15;
export const MAX_SEARCH_SCAN_WINDOW = 5_000;

export interface IndexedConversationHit {
  conversationId: string;
  score: number;
  text: string;
  metadata: Record<string, string>;
}

export async function indexConversation(
  conversation: ConversationMeta,
  messages: Message[],
  embedding: EmbeddingProvider,
  vectorStore: VectorStore,
): Promise<number> {
  const chunks = chunkConversationMessages(
    {
      conversationId: conversation.id,
      title: conversation.title,
      summary: conversation.summary,
    },
    messages,
  );

  await vectorStore.delete(conversation.id);

  if (chunks.length === 0) {
    return 0;
  }

  const vectors = await embedding.embed(chunks.map((chunk) => chunk.text));
  await vectorStore.upsert(
    conversation.id,
    chunks.map((chunk, index) => ({
      text: chunk.text,
      embedding: vectors[index] ?? [],
      metadata: {
        conversationId: chunk.conversationId,
        chunkIndex: String(chunk.chunkIndex),
        startMessageIndex: String(chunk.startMessageIndex),
        endMessageIndex: String(chunk.endMessageIndex),
      },
    })),
  );

  return chunks.length;
}

export async function searchConversations<
  T extends IndexedConversationHit = IndexedConversationHit,
>(
  query: string,
  limit: number,
  embedding: EmbeddingProvider,
  vectorStore: VectorStore,
  options: {
    filter?: Record<string, string>;
    minScore?: number;
    isConversationSearchable?: (conversationId: string) => boolean | Promise<boolean>;
    composeResults?: (
      hits: IndexedConversationHit[],
    ) => T[] | Promise<T[]>;
    onScanCapReached?: () => void;
  } = {},
): Promise<T[]> {
  const [queryEmbedding] = await embedding.embed([query]);
  const minScore = options.minScore ?? MIN_SEARCH_SCORE;
  const searchableCache = new Map<string, boolean>();
  let fetchCount = Math.max(limit * 3, 20);

  while (true) {
    const requestCount = Math.min(fetchCount, MAX_SEARCH_SCAN_WINDOW);
    const hits = await vectorStore.search(queryEmbedding ?? [], requestCount, options.filter);
    const filtered = await dedupeAndFilterHits(hits, minScore, searchableCache, options);
    const composed: T[] = options.composeResults
      ? await options.composeResults(filtered)
      : filtered as T[];

    if (composed.length >= limit) {
      return composed.slice(0, limit);
    }

    if (hits.length < requestCount) {
      return composed;
    }

    if (requestCount === MAX_SEARCH_SCAN_WINDOW) {
      options.onScanCapReached?.();
      return composed;
    }

    fetchCount = Math.min(fetchCount * 2, MAX_SEARCH_SCAN_WINDOW);
  }
}

async function dedupeAndFilterHits(
  hits: SearchHit[],
  minScore: number,
  searchableCache: Map<string, boolean>,
  options: {
    isConversationSearchable?: (conversationId: string) => boolean | Promise<boolean>;
  },
): Promise<IndexedConversationHit[]> {
  const deduped: IndexedConversationHit[] = [];
  const seenConversationIds = new Set<string>();

  for (const hit of hits) {
    const conversationId = hit.metadata.conversationId ?? hit.id;
    if (hit.score < minScore || seenConversationIds.has(conversationId)) {
      continue;
    }

    if (options.isConversationSearchable) {
      let searchable = searchableCache.get(conversationId);
      if (searchable == null) {
        searchable = await options.isConversationSearchable(conversationId);
        searchableCache.set(conversationId, searchable);
      }

      if (!searchable) {
        continue;
      }
    }

    seenConversationIds.add(conversationId);
    deduped.push({
      conversationId,
      score: hit.score,
      text: hit.text,
      metadata: hit.metadata,
    });
  }

  return deduped;
}
