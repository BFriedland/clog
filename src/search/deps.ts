import { loadConfig } from "../config/index.js";
import { SearchDepsError, SearchNotConfiguredError } from "./errors.js";
import type { SearchConfig } from "./providers.js";
import type { EmbeddingProvider, VectorStore } from "./types.js";

async function importOptionalPackage(moduleName: string): Promise<void> {
  try {
    await import(moduleName);
  } catch {
    throw new SearchDepsError([moduleName]);
  }
}

let cachedProviders: { embedding: EmbeddingProvider; vectorStore: VectorStore } | null = null;
let pendingInit: Promise<{ embedding: EmbeddingProvider; vectorStore: VectorStore }> | null = null;

export async function getSearchProviders(): Promise<{
  embedding: EmbeddingProvider;
  vectorStore: VectorStore;
}> {
  if (cachedProviders) {
    return cachedProviders;
  }

  if (pendingInit) {
    return pendingInit;
  }

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

export async function searchAvailable(): Promise<boolean> {
  try {
    await getSearchProviders();
    return true;
  } catch {
    return false;
  }
}

export function resetSearchProviders(): void {
  cachedProviders = null;
  pendingInit = null;
}

async function createEmbeddingProvider(
  config: NonNullable<SearchConfig>,
): Promise<EmbeddingProvider> {
  switch (config.embedding.type) {
    case "transformers":
      await importOptionalPackage("@huggingface/transformers");
      return new (await import("./embeddings/transformers.js")).TransformersEmbedding(
        config.embedding,
        { localFilesOnly: true },
      );
    default:
      throw new Error(`Unknown embedding provider: ${(config.embedding as { type: string }).type}`);
  }
}

async function createVectorStore(
  config: NonNullable<SearchConfig>,
): Promise<VectorStore> {
  switch (config.vectorStore.type) {
    case "vectra":
      await importOptionalPackage("vectra");
      return new (await import("./vectorstores/vectra.js")).VectraStore();
    default:
      throw new Error(`Unknown vector store: ${(config.vectorStore as { type: string }).type}`);
  }
}
