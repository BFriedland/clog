import os from "node:os";
import path from "node:path";

export function getClogHome(): string {
  return process.env.CLOG_HOME || path.join(os.homedir(), ".clog");
}

export function getDbPath(): string {
  return path.join(getClogHome(), "clog.db");
}

export function getRawDir(): string {
  return path.join(getClogHome(), "raw");
}

export function getExcludedPath(): string {
  return path.join(getClogHome(), "excluded");
}

export function getClogignorePath(): string {
  return path.join(getClogHome(), "clogignore");
}

export function getConfigPath(): string {
  return path.join(getClogHome(), "config.json");
}

export function getRemoteDir(): string {
  return path.join(getClogHome(), "remote");
}

export function getDefaultSourcePaths(): string[] {
  const envSources = process.env.CLOG_SOURCES;
  if (envSources) {
    return envSources.split(path.delimiter);
  }
  return [path.join(os.homedir(), ".claude", "projects")];
}
