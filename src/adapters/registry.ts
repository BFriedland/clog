import type { Config } from "../config/schema.js";
import { ClogError } from "../utils/errors.js";
import {
  type BuiltinSource,
  getStandardSourcePaths,
} from "../utils/paths.js";
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
  displayName: string;
  factory: SourceAdapterFactory;
  relationshipInspectionRefresh: boolean;
  standardPaths: readonly string[];
  versions: {
    relationshipInspection: number;
    transcriptProjection: number;
  };
}

const REGISTRY: Record<BuiltinSource, SourceAdapterRegistration> = {
  "claude-code": {
    displayName: "Claude Code",
    factory: (config) => new ClaudeCodeAdapter(config),
    relationshipInspectionRefresh: true,
    standardPaths: getStandardSourcePaths("claude-code"),
    versions: CLAUDE_CODE_ADAPTER_VERSIONS,
  },
  "codex-cli": {
    displayName: "Codex CLI",
    factory: (config) => new CodexCliAdapter(config),
    relationshipInspectionRefresh: true,
    standardPaths: getStandardSourcePaths("codex-cli"),
    versions: CODEX_CLI_ADAPTER_VERSIONS,
  },
};

export interface RegisteredSourceMetadata {
  source: BuiltinSource;
  displayName: string;
  standardPaths: readonly string[];
}

export function getRegisteredSourceMetadata(): RegisteredSourceMetadata[] {
  return (Object.entries(REGISTRY) as Array<
    [BuiltinSource, SourceAdapterRegistration]
  >).map(([source, registration]) => ({
    source,
    displayName: registration.displayName,
    standardPaths: [...registration.standardPaths],
  }));
}

export function getAdapter(source: string, config: Config): SourceAdapter {
  if (!isRegisteredSource(source)) {
    throw new ClogError(`Unsupported source "${source}".`);
  }

  const registration = REGISTRY[source];

  return registration.factory(config);
}

export function isSourceParseSupported(source: string): boolean {
  return isRegisteredSource(source);
}

export function getAdapterVersions(
  source: string,
): SourceAdapterRegistration["versions"] | null {
  if (!isRegisteredSource(source)) {
    return null;
  }
  return REGISTRY[source]?.versions ?? null;
}

function isRegisteredSource(source: string): source is BuiltinSource {
  return Object.hasOwn(REGISTRY, source);
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
