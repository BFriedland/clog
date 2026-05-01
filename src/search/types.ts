export interface ChunkMetadata {
  conversationId: string;
  chunkIndex: number;
  startMessageIndex: number;
  endMessageIndex: number;
}

export interface SearchChunk extends ChunkMetadata {
  text: string;
}

export interface IndexedChunk {
  text: string;
  embedding: number[];
  metadata: Record<string, string>;
}

export interface SearchHit {
  id: string;
  score: number;
  text: string;
  metadata: Record<string, string>;
}

export interface EmbeddingProvider {
  name: string;
  dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

export interface VectorStore {
  upsert(id: string, chunks: IndexedChunk[]): Promise<void>;
  search(
    embedding: number[],
    limit: number,
    filter?: Record<string, string>,
  ): Promise<SearchHit[]>;
  delete(id: string): Promise<void>;
  reset?(): Promise<void>;
}
