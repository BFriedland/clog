/**
 * Composition root for search providers.
 *
 * Reads the search config and creates the appropriate EmbeddingProvider
 * and VectorStore instances. All provider-specific imports happen here —
 * the rest of the search module depends only on the interfaces in types.ts.
 */

import type { SearchConfig } from "./providers.js";
import type { EmbeddingProvider, VectorStore } from "./types.js";
import { loadConfig } from "../config/schema.js";

export class SearchNotConfiguredError extends Error {
  constructor() {
    super(
      'Search is not configured. Run "clog search --init" to set up search.',
    );
    this.name = "SearchNotConfiguredError";
  }
}

export class SearchDepsError extends Error {
  constructor(packages: string[]) {
    super(
      `Search dependencies not installed. Run:\n  npm install ${packages.join(" ")}\n`,
    );
    this.name = "SearchDepsError";
  }
}

// Cached instances (singleton per process)
let cachedProviders: { embedding: EmbeddingProvider; vectorStore: VectorStore } | null = null;
let pendingInit: Promise<{ embedding: EmbeddingProvider; vectorStore: VectorStore }> | null = null;

/**
 * Load and return the configured search providers.
 * Throws SearchNotConfiguredError if search is not set up.
 * Throws SearchDepsError if required packages are not installed.
 */
export async function getSearchProviders(): Promise<{
  embedding: EmbeddingProvider;
  vectorStore: VectorStore;
}> {
  if (cachedProviders) return cachedProviders;
  if (pendingInit) return pendingInit;

  pendingInit = (async () => {
    const config = await loadConfig();
    const searchConfig = config.search as SearchConfig | null;

    if (!searchConfig) {
      throw new SearchNotConfiguredError();
    }

    const embedding = await createEmbeddingProvider(searchConfig);
    const vectorStore = await createVectorStore(searchConfig);

    cachedProviders = { embedding, vectorStore };
    return cachedProviders;
  })();

  try {
    return await pendingInit;
  } finally {
    pendingInit = null;
  }
}

/**
 * Check whether search is configured and dependencies are available.
 * Returns false without throwing.
 */
export async function searchAvailable(): Promise<boolean> {
  try {
    await getSearchProviders();
    return true;
  } catch {
    return false;
  }
}

/** Reset cached providers (for testing). */
export function resetSearchProviders(): void {
  cachedProviders = null;
  pendingInit = null;
}

// ---------------------------------------------------------------------------
// Factory functions (one case per provider type)
// ---------------------------------------------------------------------------

async function createEmbeddingProvider(
  config: NonNullable<SearchConfig>,
): Promise<EmbeddingProvider> {
  switch (config.embedding.type) {
    case "transformers": {
      try {
        await import("@huggingface/transformers");
      } catch {
        throw new SearchDepsError(["@huggingface/transformers"]);
      }
      const { TransformersEmbedding } = await import(
        "./embeddings/transformers.js"
      );
      return new TransformersEmbedding(config.embedding);
    }
    default:
      throw new Error(
        `Unknown embedding provider: ${(config.embedding as { type: string }).type}`,
      );
  }
}

async function createVectorStore(
  config: NonNullable<SearchConfig>,
): Promise<VectorStore> {
  switch (config.vectorStore.type) {
    case "vectra": {
      try {
        await import("vectra");
      } catch {
        throw new SearchDepsError(["vectra"]);
      }
      const { VectraStore } = await import("./vectorstores/vectra.js");
      return new VectraStore();
    }
    default:
      throw new Error(
        `Unknown vector store: ${(config.vectorStore as { type: string }).type}`,
      );
  }
}
