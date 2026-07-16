import type { Config } from "../config/schema.js";
import { ClogError } from "../utils/errors.js";
import { ClaudeCodeAdapter } from "./claude-code.js";
import type { SourceAdapter, SourceAdapterFactory } from "./adapter.js";
import { CodexCliAdapter } from "./codex-cli.js";

type SourceAdapterRegistry = Record<string, SourceAdapterFactory>;

const FACTORIES: SourceAdapterRegistry = {
  "claude-code": (config) => new ClaudeCodeAdapter(config),
  "codex-cli": (config) => new CodexCliAdapter(config),
};

export function getAdapter(source: string, config: Config): SourceAdapter {
  if (!Object.hasOwn(FACTORIES, source)) {
    throw new ClogError(`Unsupported source "${source}".`);
  }

  const factory = FACTORIES[source];

  return factory(config);
}

export function isSourceParseSupported(source: string): boolean {
  return Object.hasOwn(FACTORIES, source);
}

export function getEnabledAdapters(config: Config): SourceAdapter[] {
  return Object.entries(FACTORIES)
    .filter(
      ([source]) => config.sources[source as keyof Config["sources"]]?.enabled !== false,
    )
    .map(([, factory]) => factory(config));
}
