import type { Config } from "../config/schema.js";
import { ClogError } from "../utils/errors.js";
import {
  classifyAdapterVersion,
  type AdapterVersionClassification,
  type SourceAdapter,
  type SourceAdapterFactory,
} from "./adapter.js";
import {
  CLAUDE_CODE_ADAPTER_VERSIONS,
  ClaudeCodeAdapter,
} from "./claude-code.js";
import {
  CODEX_CLI_ADAPTER_VERSIONS,
  CodexCliAdapter,
} from "./codex-cli.js";

interface SourceAdapterRegistration {
  factory: SourceAdapterFactory;
  relationshipInspectionRefresh: boolean;
  versions: {
    relationshipInspection: number;
    transcriptProjection: number;
  };
}

const REGISTRY: Record<string, SourceAdapterRegistration> = {
  "claude-code": {
    factory: (config) => new ClaudeCodeAdapter(config),
    relationshipInspectionRefresh: false,
    versions: CLAUDE_CODE_ADAPTER_VERSIONS,
  },
  "codex-cli": {
    factory: (config) => new CodexCliAdapter(config),
    relationshipInspectionRefresh: true,
    versions: CODEX_CLI_ADAPTER_VERSIONS,
  },
};

export function getAdapter(source: string, config: Config): SourceAdapter {
  if (!Object.hasOwn(REGISTRY, source)) {
    throw new ClogError(`Unsupported source "${source}".`);
  }

  const registration = REGISTRY[source];

  return registration.factory(config);
}

export function isSourceParseSupported(source: string): boolean {
  return Object.hasOwn(REGISTRY, source);
}

export function getAdapterVersions(
  source: string,
): SourceAdapterRegistration["versions"] | null {
  return REGISTRY[source]?.versions ?? null;
}

export function classifyInstalledTranscriptProjectionVersion(
  source: string,
  storedVersion: number | null,
): AdapterVersionClassification {
  const versions = getAdapterVersions(source);
  if (!versions) {
    return "version_skew";
  }
  return classifyAdapterVersion(storedVersion, versions.transcriptProjection);
}

export function classifyInstalledRelationshipInspectionVersion(
  source: string,
  storedVersion: number | null,
): AdapterVersionClassification {
  const versions = getAdapterVersions(source);
  if (!versions) {
    return "version_skew";
  }
  return classifyAdapterVersion(storedVersion, versions.relationshipInspection);
}

export function getEnabledAdapters(config: Config): SourceAdapter[] {
  return Object.entries(REGISTRY)
    .filter(
      ([source]) => config.sources[source as keyof Config["sources"]]?.enabled !== false,
    )
    .map(([, registration]) => registration.factory(config));
}

export function getRelationshipInspectionRefreshAdapters(
  config: Config,
): SourceAdapter[] {
  return Object.values(REGISTRY)
    .filter((registration) => registration.relationshipInspectionRefresh)
    .map((registration) => registration.factory(config));
}
