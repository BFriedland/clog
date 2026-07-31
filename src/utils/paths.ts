import os from "node:os";
import path from "node:path";

export const BUILTIN_SOURCES = ["claude-code", "codex-cli"] as const;

export type BuiltinSource = (typeof BUILTIN_SOURCES)[number];

const STANDARD_SOURCE_PATHS = {
  "claude-code": ["~/.claude/projects/"],
  "codex-cli": ["~/.codex/sessions/"],
} as const satisfies Record<BuiltinSource, readonly string[]>;

function expandHomePath(value: string): string {
  if (value === "~") {
    return os.homedir();
  }

  if (value.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), value.slice(2));
  }

  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }

  return value;
}

export function normalizeUserPath(value: string): string {
  return path.normalize(path.resolve(expandHomePath(value)));
}

export function getClogHome(): string {
  const configured = process.env.CLOG_HOME;
  return normalizeUserPath(configured && configured.trim() ? configured : "~/.clog");
}

export function getClogDbPath(): string {
  return path.join(getClogHome(), "clog.db");
}

export function getConfigPath(): string {
  return path.join(getClogHome(), "config.json");
}

export function getClogIgnorePath(): string {
  return path.join(getClogHome(), "clogignore");
}

export function getRawRoot(): string {
  return path.join(getClogHome(), "raw");
}

export function getImportsRoot(): string {
  return path.join(getClogHome(), "imports");
}

export function getVectorsRoot(): string {
  return path.join(getClogHome(), "vectors");
}

export function getSearchRuntimeRoot(): string {
  return path.join(getClogHome(), "search-runtime");
}

export function getSearchRuntimeModelCacheRoot(): string {
  return path.join(getSearchRuntimeRoot(), "models");
}

export function getRawSourceDir(source: string): string {
  return path.join(getRawRoot(), source);
}

export function getRawConversationPath(source: string, id: string): string {
  return path.join(getRawSourceDir(source), `${id}.jsonl`);
}

function getImportSourceDir(source: string): string {
  return path.join(getImportsRoot(), source);
}

export function getImportConversationPath(source: string, id: string): string {
  return path.join(getImportSourceDir(source), `${id}.jsonl`);
}

export function getStandardSourcePaths(source: BuiltinSource): string[] {
  return [...STANDARD_SOURCE_PATHS[source]];
}

export function getDbLockPath(): string {
  return path.join(getClogHome(), "clog.db.lock");
}
