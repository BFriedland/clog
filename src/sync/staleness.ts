import type { Config } from "../config/schema.js";
import { getRemoteDir } from "../config/index.js";
import { isGitRepo, gitRevParseHead } from "./git.js";

export interface StalenessResult {
  isStale: boolean;
  hasRemote: boolean;
  hasCheckout: boolean;
}

export async function checkStaleness(config: Config): Promise<StalenessResult> {
  if (!config.remote.url) {
    return { isStale: false, hasRemote: false, hasCheckout: false };
  }

  const remoteDir = getRemoteDir();
  const hasCheckout = await isGitRepo(remoteDir);
  if (!hasCheckout) {
    return { isStale: false, hasRemote: true, hasCheckout: false };
  }

  if (!config.remote.lastSyncHead) {
    return { isStale: true, hasRemote: true, hasCheckout: true };
  }

  try {
    const currentHead = await gitRevParseHead(remoteDir);
    const isStale = currentHead !== config.remote.lastSyncHead;
    return { isStale, hasRemote: true, hasCheckout: true };
  } catch {
    return { isStale: false, hasRemote: true, hasCheckout: true };
  }
}
