import fs from "node:fs/promises";

import { Command } from "commander";

import { loadConfig } from "../config/index.js";
import { gitRevParseHead } from "../sync/git.js";
import { getRemoteGitDir, getRemoteRoot } from "../sync/paths.js";
import { reconcileRemote } from "../sync/pull.js";
import { updateLastSyncHead } from "../sync/staleness.js";
import { renderWarnings } from "./common.js";

export function buildRefreshCommand(): Command {
  return new Command("refresh")
    .description(
      "Reconcile the local DB from the current state of the remote checkout without fetching from the remote",
    )
    .action(async () => {
      await runRefresh();
    });
}

async function runRefresh(): Promise<void> {
  const config = await loadConfig();

  if (!config.remote.url) {
    process.stdout.write("No remote configured. Nothing to refresh.\n");
    return;
  }

  if (!(await directoryExists(getRemoteGitDir()))) {
    process.stdout.write(
      "No checkout found. Run 'clog sync pull' to clone the remote first.\n",
    );
    return;
  }

  const stats = await reconcileRemote(config, config.remote.url);
  const total = stats.inserted + stats.updated + stats.deleted;
  process.stdout.write(
    `Refreshed ${total} conversation(s) from local checkout. ${stats.inserted} new, ${stats.updated} updated, ${stats.deleted} removed.\n`,
  );
  renderWarnings(stats.warnings);

  try {
    const head = await gitRevParseHead(getRemoteRoot());
    await updateLastSyncHead(head);
  } catch {
    // Best-effort — refresh still succeeded even if we can't read HEAD.
  }
}

async function directoryExists(dir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dir);
    return stat.isDirectory();
  } catch {
    return false;
  }
}
