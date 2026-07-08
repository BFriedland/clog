import type { TransformersConfig } from "../providers.js";
import { SearchSetupIncompleteError } from "../errors.js";
import { importSearchRuntimePackage } from "../runtime.js";
import type { EmbeddingProvider } from "../types.js";
import { getSearchRuntimeModelCacheRoot } from "../../utils/paths.js";

type FeatureExtractionPipeline = (
  input: string,
  options: Record<string, unknown>,
) => Promise<{ tolist(): number[][] }>;

type TransformersModule = typeof import("@huggingface/transformers");

const KNOWN_MODEL_DIMENSIONS: Record<string, number> = {
  "Xenova/all-MiniLM-L6-v2": 384,
};

let pipelineCache = new Map<string, Promise<FeatureExtractionPipeline>>();
let dimensionCache = new Map<string, number>();

export class TransformersEmbedding implements EmbeddingProvider {
  readonly name = "transformers.js";
  readonly dimensions: number;
  private readonly model: string;
  private readonly localFilesOnly: boolean;

  constructor(
    config: TransformersConfig,
    options: { localFilesOnly?: boolean } = {},
  ) {
    this.model = config.model;
    this.dimensions = KNOWN_MODEL_DIMENSIONS[this.model] ?? 384;
    this.localFilesOnly = options.localFilesOnly ?? true;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const pipeline = await getPipeline(this.model, this.localFilesOnly);
    const vectors: number[][] = [];

    for (const text of texts) {
      const output = await pipeline(text, { pooling: "mean", normalize: true });
      const vector = output.tolist()[0] ?? [];
      if (vector.length > 0) {
        dimensionCache.set(this.model, vector.length);
      }
      vectors.push(vector);
    }

    return vectors;
  }
}

export function resetTransformersEmbedding(): void {
  pipelineCache = new Map();
  dimensionCache = new Map();
}

export async function warmTransformersModel(config: TransformersConfig): Promise<void> {
  await getPipeline(config.model, false);
}

async function getPipeline(model: string, localFilesOnly: boolean): Promise<FeatureExtractionPipeline> {
  const cacheKey = `${model}:${localFilesOnly ? "local" : "remote"}`;
  const cached = pipelineCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const created = (async () => {
    const transformers = await importSearchRuntimePackage<TransformersModule>(
      "@huggingface/transformers",
    );
    if (transformers.env) {
      transformers.env.cacheDir = getSearchRuntimeModelCacheRoot();
    }

    try {
      return (await transformers.pipeline("feature-extraction", model, {
        dtype: "fp32",
        local_files_only: localFilesOnly,
      })) as FeatureExtractionPipeline;
    } catch (error) {
      if (
        localFilesOnly &&
        error instanceof Error &&
        (
          error.message.includes("local_files_only=true") ||
          error.message.includes("env.allowRemoteModels=false") ||
          error.message.includes("file was not found locally")
        )
      ) {
        throw new SearchSetupIncompleteError();
      }

      throw error;
    }
  })();

  pipelineCache.set(cacheKey, created);
  return created;
}
