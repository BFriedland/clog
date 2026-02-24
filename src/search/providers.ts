/**
 * Provider registry for embedding providers and vector stores.
 *
 * Each entry declares what npm packages are required, and a factory
 * function to create the provider instance. To add a new provider,
 * add an entry here and create the implementation file.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Registry types
// ---------------------------------------------------------------------------

export interface ProviderRegistryEntry<TConfig> {
  /** Display name for interactive selection */
  name: string;
  /** Short description shown during setup */
  description: string;
  /** npm packages required at runtime */
  packages: string[];
  /** Zod schema for provider-specific config fields */
  configSchema: z.ZodType<TConfig>;
}

// ---------------------------------------------------------------------------
// Embedding provider registry
// ---------------------------------------------------------------------------

export const TransformersConfigSchema = z.object({
  model: z.string().default("Xenova/all-MiniLM-L6-v2"),
});

export type TransformersConfig = z.infer<typeof TransformersConfigSchema>;

export const embeddingProviders = {
  transformers: {
    name: "Local (transformers.js)",
    description:
      "Runs locally via WASM. No API key needed. Downloads ~30MB model on first use.",
    packages: ["@huggingface/transformers"],
    configSchema: TransformersConfigSchema as z.ZodType<TransformersConfig>,
  } satisfies ProviderRegistryEntry<TransformersConfig>,
} as const;

export type EmbeddingProviderType = keyof typeof embeddingProviders;

// ---------------------------------------------------------------------------
// Vector store registry
// ---------------------------------------------------------------------------

export const VectraConfigSchema = z.object({});

export type VectraConfig = z.infer<typeof VectraConfigSchema>;

export const vectorStoreProviders = {
  vectra: {
    name: "Vectra (local JSON files)",
    description:
      "Pure JS, zero native deps. Stores vectors as JSON files locally.",
    packages: ["vectra"],
    configSchema: VectraConfigSchema,
  } satisfies ProviderRegistryEntry<VectraConfig>,
} as const;

export type VectorStoreProviderType = keyof typeof vectorStoreProviders;

// ---------------------------------------------------------------------------
// Config schema for the "search" section of config.json
// ---------------------------------------------------------------------------

export const SearchEmbeddingConfigSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("transformers"), ...TransformersConfigSchema.shape }),
]);

export const SearchVectorStoreConfigSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("vectra"), ...VectraConfigSchema.shape }),
]);

export const SearchConfigSchema = z
  .object({
    embedding: SearchEmbeddingConfigSchema,
    vectorStore: SearchVectorStoreConfigSchema,
  })
  .nullable()
  .default(null);

export type SearchConfig = z.infer<typeof SearchConfigSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if a set of npm packages are importable at runtime. */
export async function checkPackages(packages: string[]): Promise<boolean> {
  for (const pkg of packages) {
    try {
      await import(pkg);
    } catch {
      return false;
    }
  }
  return true;
}
