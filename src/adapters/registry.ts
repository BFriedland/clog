import type { Config } from "../config/schema.js";
import { ClogError } from "../utils/errors.js";
import { ClaudeCodeAdapter } from "./claude-code.js";
import type { SourceAdapter, SourceAdapterFactory } from "./adapter.js";
import { CodexCliAdapter } from "./codex-cli.js";

const FACTORIES: Record<string, SourceAdapterFactory> = {
  "claude-code": (config) => new ClaudeCodeAdapter(config),
  "codex-cli": (config) => new CodexCliAdapter(config),
};

export function getAdapter(source: string, config: Config): SourceAdapter {
  const factory = FACTORIES[source];

  if (!factory) {
    throw new ClogError(`Unsupported source "${source}".`);
  }

  return factory(config);
}

export function getEnabledAdapters(config: Config): SourceAdapter[] {
  return Object.entries(FACTORIES)
    .filter(
      ([source]) => config.sources[source as keyof Config["sources"]]?.enabled !== false,
    )
    .map(([, factory]) => factory(config));
}
