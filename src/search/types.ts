/**
 * Provider interfaces and shared types for semantic search.
 *
 * The indexer depends only on these interfaces — concrete implementations
 * (Vectra, transformers.js, etc.) live in separate files and are wired
 * together by deps.ts based on the user's config.
 */

// ---------------------------------------------------------------------------
// Embedding provider
// ---------------------------------------------------------------------------

export interface EmbeddingProvider {
  /** Display name (e.g. "transformers.js") */
  readonly name: string;

  /** Vector dimensionality (e.g. 384 for all-MiniLM-L6-v2) */
  readonly dimensions: number;

  /** Embed one or more texts. Returns one vector per input text. */
  embed(texts: string[]): Promise<number[][]>;
}

// ---------------------------------------------------------------------------
// Vector store
// ---------------------------------------------------------------------------

export interface VectorEntry {
  /** Unique ID for this vector (e.g. "{conversationId}:{chunkIndex}") */
  id: string;
  vector: number[];
  metadata: ChunkMetadata;
}

export interface VectorResult {
  conversationId: string;
  chunkIndex: number;
  score: number;
  text: string;
}

export interface VectorStore {
  /** Insert or replace vectors. */
  upsert(entries: VectorEntry[]): Promise<void>;

  /** Delete all vectors for a conversation. */
  delete(conversationId: string): Promise<void>;

  /**
   * Query for similar vectors. Returns raw results sorted by descending score.
   * May return multiple results per conversation (one per matching chunk).
   * Deduplication to one result per conversation is handled by the caller.
   */
  query(
    vector: number[],
    topK: number,
  ): Promise<VectorResult[]>;
}

// ---------------------------------------------------------------------------
// Chunk types (output of the chunker, input to the indexer)
// ---------------------------------------------------------------------------

export interface ChunkMetadata {
  conversationId: string;
  chunkIndex: number;
  /** Index of first message in this chunk (-1 for metadata-only chunk) */
  messageStartIndex: number;
  /** Index past last message in this chunk (-1 for metadata-only chunk) */
  messageEndIndex: number;
  /** The text that was embedded */
  text: string;
}

export interface Chunk {
  conversationId: string;
  chunkIndex: number;
  messageStartIndex: number;
  messageEndIndex: number;
  text: string;
}
