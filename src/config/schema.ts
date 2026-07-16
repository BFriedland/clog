import { z } from "zod";

import { SearchConfigSchema } from "../search/providers.js";
import { BUILTIN_SOURCES } from "../utils/paths.js";

const sourceConfigSchema = z.object({
  enabled: z.boolean().default(true),
  paths: z.array(z.string()).default([]),
  includePaths: z.array(z.string()).default([]),
  excludePaths: z.array(z.string()).default([]),
});

const sourceEntries = Object.fromEntries(
  BUILTIN_SOURCES.map((source) => [source, sourceConfigSchema.default({})]),
);

const remoteConfigSchema = z
  .object({
    url: z.string().nullable().default(null),
    allowPublicRemote: z.boolean().default(false),
    visibilityConfirmed: z.boolean().default(false),
    lastSyncHead: z.string().nullable().default(null),
  })
  .default({
    url: null,
    allowPublicRemote: false,
    visibilityConfirmed: false,
    lastSyncHead: null,
  });

export const configSchema = z.object({
  author: z.string().default(""),
  sources: z.object(sourceEntries),
  defaultTags: z.array(z.string()).default([]),
  autoScan: z.boolean().default(false),
  search: SearchConfigSchema,
  remote: remoteConfigSchema,
});

export type RemoteConfig = z.infer<typeof remoteConfigSchema>;
export type Config = z.infer<typeof configSchema>;

export function parseConfig(raw: unknown): Config {
  return configSchema.parse(raw);
}
