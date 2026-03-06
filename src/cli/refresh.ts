import chalk from "chalk";
import { loadConfig, saveConfig } from "../config/schema.js";
import { getRemoteDir } from "../config/index.js";
import { reconcile } from "../sync/pull.js";
import { isGitRepo, gitRevParseHead } from "../sync/git.js";

export async function refreshCommand(): Promise<void> {
  const config = await loadConfig();

  if (!config.remote.url) {
    console.log("No remote configured. Nothing to refresh.");
    return;
  }

  const remoteDir = getRemoteDir();
  if (!(await isGitRepo(remoteDir))) {
    console.log("No checkout found. Run `clog sync pull` first.");
    return;
  }

  const result = await reconcile(config);

  // Update lastSyncHead
  try {
    const head = await gitRevParseHead(remoteDir);
    config.remote.lastSyncHead = head;
    await saveConfig(config);
  } catch {
    // non-fatal
  }

  const parts: string[] = [];
  if (result.inserted > 0) parts.push(`${result.inserted} new`);
  if (result.updated > 0) parts.push(`${result.updated} updated`);
  if (result.deleted > 0) parts.push(`${result.deleted} removed`);

  const total = result.inserted + result.updated + result.deleted;
  if (total > 0) {
    console.log(`Refreshed. ${parts.join(", ")}.`);
  } else {
    console.log("Already up to date.");
  }

  for (const w of result.warnings) {
    console.log(chalk.yellow("warning: ") + w);
  }
}
