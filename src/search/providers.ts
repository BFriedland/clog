import { z } from "zod";

export interface ProviderRegistryEntry<TConfig> {
  name: string;
  description: string;
  packages: string[];
  configSchema: z.ZodType<TConfig>;
}

export const TransformersConfigSchema = z.object({
  model: z.string().default("Xenova/all-MiniLM-L6-v2"),
});

export type TransformersConfig = z.infer<typeof TransformersConfigSchema>;

export const embeddingProviders = {
  transformers: {
    name: "Local (transformers.js)",
    description: "Runs locally via WASM. No API key needed. Model downloaded from the Hugging Face Hub.",
    packages: ["@huggingface/transformers"],
    configSchema: TransformersConfigSchema as z.ZodType<TransformersConfig>,
  } satisfies ProviderRegistryEntry<TransformersConfig>,
} as const;

export type EmbeddingProviderType = keyof typeof embeddingProviders;

export const VectraConfigSchema = z.object({});

export type VectraConfig = z.infer<typeof VectraConfigSchema>;

export const vectorStoreProviders = {
  vectra: {
    name: "Vectra (local JSON files)",
    description: "Pure JS, zero native deps. Stores vectors locally.",
    packages: ["vectra"],
    configSchema: VectraConfigSchema,
  } satisfies ProviderRegistryEntry<VectraConfig>,
} as const;

export type VectorStoreProviderType = keyof typeof vectorStoreProviders;

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
