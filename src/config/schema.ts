import { z } from "zod";
import { readFile, writeFile } from "node:fs/promises";
import { getClogHome } from "./index.js";
import path from "node:path";

export const SourceConfigSchema = z.object({
  enabled: z.boolean().default(true),
  paths: z.array(z.string()).default([]),
  includePaths: z.array(z.string()).default([]),
  excludePaths: z.array(z.string()).default([]),
});

export type SourceConfig = z.infer<typeof SourceConfigSchema>;

export const ConfigSchema = z.object({
  author: z.string().default(""),
  sources: z
    .object({
      "claude-code": SourceConfigSchema.default({}),
      "codex-cli": SourceConfigSchema.default({ enabled: false }),
    })
    .default({}),
  defaultTags: z.array(z.string()).default([]),
  autoScan: z.boolean().default(false),
  remote: z.unknown().nullable().default(null),
});

export type Config = z.infer<typeof ConfigSchema>;

export function defaultConfig(): Config {
  return ConfigSchema.parse({});
}

export async function loadConfig(): Promise<Config> {
  const configPath = path.join(getClogHome(), "config.json");
  try {
    const raw = await readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    return ConfigSchema.parse(parsed);
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return defaultConfig();
    }
    throw err;
  }
}

export async function saveConfig(config: Config): Promise<void> {
  const configPath = path.join(getClogHome(), "config.json");
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}
