import path from "node:path";

import { getClogHome } from "../utils/paths.js";

export function getRemoteRoot(): string {
  return path.join(getClogHome(), "remote");
}

export function getRemoteGitDir(): string {
  return path.join(getRemoteRoot(), ".git");
}

export function getRemoteAuthorDir(author: string): string {
  return path.join(getRemoteRoot(), author);
}

export function getRemoteSourceDir(author: string, source: string): string {
  return path.join(getRemoteAuthorDir(author), source);
}

export function getRemoteJsonlPath(
  author: string,
  source: string,
  id: string,
): string {
  return path.join(getRemoteSourceDir(author, source), `${id}.jsonl`);
}

export function getRemoteMetaPath(
  author: string,
  source: string,
  id: string,
): string {
  return path.join(getRemoteSourceDir(author, source), `${id}.meta.json`);
}
