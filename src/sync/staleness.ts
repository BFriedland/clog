import fs from "node:fs/promises";

import { loadConfig, saveConfig } from "../config/index.js";
import { gitRevParseHead } from "./git.js";
import { getRemoteGitDir, getRemoteRoot } from "./paths.js";

export type StalenessResult =
  | { kind: "no-remote" }
  | { kind: "no-checkout" }
  | { kind: "in-sync"; head: string }
  | { kind: "stale"; head: string; lastSyncHead: string | null };

export async function checkStaleness(): Promise<StalenessResult> {
  const config = await loadConfig();

  if (!config.remote.url) {
    return { kind: "no-remote" };
  }

  if (!(await directoryExists(getRemoteGitDir()))) {
    return { kind: "no-checkout" };
  }

  let head: string;
  try {
    head = await gitRevParseHead(getRemoteRoot());
  } catch {
    return { kind: "no-checkout" };
  }

  const lastSyncHead = config.remote.lastSyncHead;
  if (!lastSyncHead || head !== lastSyncHead) {
    return { kind: "stale", head, lastSyncHead };
  }

  return { kind: "in-sync", head };
}

export async function updateLastSyncHead(head: string): Promise<void> {
  const config = await loadConfig();
  config.remote.lastSyncHead = head;
  await saveConfig(config);
}

async function directoryExists(dir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dir);
    return stat.isDirectory();
  } catch {
    return false;
  }
}
