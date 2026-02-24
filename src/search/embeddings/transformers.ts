/**
 * Embedding provider using @huggingface/transformers (local WASM).
 *
 * Downloads the model (~30MB) on first use. Subsequent calls use the
 * cached model. Produces 384-dimensional vectors with all-MiniLM-L6-v2.
 */

import type { EmbeddingProvider } from "../types.js";
import type { TransformersConfig } from "../providers.js";

// The pipeline instance and model info are lazily initialized
let pipelineInstance: ((text: string | string[], opts: Record<string, unknown>) => Promise<{ tolist(): number[][] }>) | null = null;
let modelDimensions: number | null = null;

// Dimension lookup for known models
const KNOWN_DIMENSIONS: Record<string, number> = {
  "Xenova/all-MiniLM-L6-v2": 384,
  "Xenova/all-MiniLM-L12-v2": 384,
  "Xenova/all-mpnet-base-v2": 768,
};

async function getPipeline(model: string) {
  if (pipelineInstance) return pipelineInstance;

  const { pipeline } = await import("@huggingface/transformers");
  pipelineInstance = (await pipeline("feature-extraction", model, {
    dtype: "fp32",
  })) as unknown as typeof pipelineInstance;
  return pipelineInstance!;
}

export class TransformersEmbedding implements EmbeddingProvider {
  readonly name = "transformers.js";
  private readonly model: string;

  constructor(config: TransformersConfig) {
    this.model = config.model;
  }

  get dimensions(): number {
    if (modelDimensions !== null) return modelDimensions;
    return KNOWN_DIMENSIONS[this.model] ?? 384;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const pipe = await getPipeline(this.model);
    const results: number[][] = [];

    // Process sequentially to avoid memory spikes with large batches
    for (const text of texts) {
      const output = await pipe(text, { pooling: "mean", normalize: true });
      const nested = output.tolist();
      // output shape is [1, dimensions] for a single text
      const vector = nested[0];
      if (modelDimensions === null) {
        modelDimensions = vector.length;
      }
      results.push(vector);
    }

    return results;
  }
}
