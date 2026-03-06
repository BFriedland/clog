import chalk from "chalk";
import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { loadConfig, saveConfig } from "../config/schema.js";
import { getRemoteDir } from "../config/index.js";
import { withDb } from "../db/index.js";

const execFileAsync = promisify(execFile);

function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${message} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

async function mightBePublicGitHubRepo(url: string): Promise<boolean> {
  const match = url.match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
  if (!match) return false;

  const [, owner, repo] = match;

  // Try gh CLI first
  try {
    const { stdout } = await execFileAsync("gh", [
      "api",
      `repos/${owner}/${repo}`,
      "--jq",
      ".visibility",
    ]);
    return stdout.trim() === "public";
  } catch {
    // gh not available or not authenticated, try REST API
  }

  try {
    const { stdout } = await execFileAsync("curl", [
      "-s",
      "-o",
      "/dev/null",
      "-w",
      "%{http_code}",
      `https://api.github.com/repos/${owner}/${repo}`,
    ]);
    return stdout.trim() === "200";
  } catch {
    // This would mean curl failed.
  }
  // Safely returns true ("might be") in the case where the URL matches the
  // GitHub repo pattern, but for some reason, the previous checks failed.
  return true;
}

export async function remoteAddCommand(url: string): Promise<void> {
  const config = await loadConfig();

  if (config.remote.url) {
    throw new Error(
      "Remote already configured. Use `clog remote remove` first."
    );
  }

  // GitHub public repo safety check
  if (!config.remote.allowPublicRemote && await mightBePublicGitHubRepo(url)) {
    const match = url.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
    const repoName = match ? match[1] : url;
    throw new Error(
      `Repository ${repoName} is public.\n` +
      `Pushing conversations to a public repository would make them visible to anyone.\n` +
      `If this is intentional, add "allowPublicRemote": true to your clog config.`
    );
  }

  config.remote.url = url;
  await saveConfig(config);
  console.log(chalk.green("Remote configured:") + ` ${url}`);
  console.log('Run `clog sync pull` to fetch conversations from the remote.');
}

export async function remoteShowCommand(): Promise<void> {
  const config = await loadConfig();

  if (!config.remote.url) {
    console.log("No remote configured.");
    return;
  }

  console.log(chalk.bold("Remote:") + ` ${config.remote.url}`);

  if (config.remote.lastSyncHead) {
    console.log(chalk.bold("Last sync:") + ` ${config.remote.lastSyncHead.slice(0, 7)}`);
  } else {
    console.log(chalk.bold("Last sync:") + " never");
  }

  const counts = await withDb((ctx) => ({
    localPublished: ctx.listConversations({ state: "published", origin: "local" }).length,
    remote: ctx.countByOrigin(config.remote.url!),
  }));

  console.log(chalk.bold("Local published:") + ` ${counts.localPublished}`);
  console.log(chalk.bold("Remote conversations:") + ` ${counts.remote}`);
}

export async function remoteRemoveCommand(): Promise<void> {
  const config = await loadConfig();

  if (!config.remote.url) {
    console.log("No remote configured.");
    return;
  }

  const remoteUrl = config.remote.url;
  const count = await withDb((ctx) => ctx.countByOrigin(remoteUrl));

  const confirmed = await confirm(
    `This will remove the remote and delete ${count} conversations pulled from it.\n` +
    `Conversations you discovered, staged, or published locally are not affected.\n` +
    `Continue?`
  );

  if (!confirmed) {
    console.log("Aborted.");
    return;
  }

  // Get IDs for deindexing before deletion
  const remoteIds = await withDb((ctx) =>
    ctx.listConversations({ origin: "remote" }).map((c) => c.id)
  );

  // Delete remote conversations from DB
  await withDb((ctx) => {
    ctx.deleteByOrigin(remoteUrl);
  });

  // Deindex from vector store (best-effort)
  if (remoteIds.length > 0) {
    try {
      const { getSearchProviders } = await import("../search/deps.js");
      const { vectorStore } = await getSearchProviders();
      for (const id of remoteIds) {
        await vectorStore.delete(id);
      }
    } catch {
      // Search not configured or deps unavailable — skip
    }
  }

  // Remove checkout directory
  const remoteDir = getRemoteDir();
  try {
    await rm(remoteDir, { recursive: true, force: true });
  } catch {
    // may not exist
  }

  // Clear config
  config.remote.url = null;
  config.remote.lastSyncHead = null;
  config.remote.visibilityConfirmed = false;
  await saveConfig(config);

  console.log(chalk.green("Remote removed.") + ` Deleted ${count} remote conversation(s).`);
}
