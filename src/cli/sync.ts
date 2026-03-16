import chalk from "chalk";
import { createInterface } from "node:readline";
import { loadConfig, saveConfig } from "../config/schema.js";
import { withDb } from "../db/index.js";
import { syncPull } from "../sync/pull.js";
import { syncPush } from "../sync/push.js";
import { ensureGit } from "../sync/git.js";

function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${message} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

export async function syncPullCommand(): Promise<void> {
  await ensureGit();
  const config = await loadConfig();

  if (!config.remote.url) {
    throw new Error("No remote configured. Run `clog remote add <url>` first.");
  }

  const result = await syncPull(config);

  const parts: string[] = [];
  if (result.inserted > 0) parts.push(`${result.inserted} new`);
  if (result.updated > 0) parts.push(`${result.updated} updated`);
  if (result.deleted > 0) parts.push(`${result.deleted} removed`);

  const total = result.inserted + result.updated + result.deleted;
  if (total > 0) {
    console.log(
      `Pulled from ${chalk.cyan(config.remote.url)}. ${parts.join(", ")}.`
    );
  } else {
    console.log("Already up to date.");
  }

  if (result.skippedExcluded > 0) {
    console.log(chalk.dim(`(${result.skippedExcluded} excluded)`));
  }
  if (result.skippedDuplicate > 0) {
    console.log(chalk.dim(`(${result.skippedDuplicate} skipped — local copy takes precedence)`));
  }

  for (const w of result.warnings) {
    console.log(chalk.yellow("warning: ") + w);
  }

  // Report unindexed count if search is configured
  try {
    const { indexed, published } = await withDb((ctx) => ctx.getIndexCoverage());
    const unindexed = published - indexed;
    if (unindexed > 0) {
      console.log(
        chalk.dim(
          `Search index is out of date (${unindexed} conversations unindexed). Run \`clog index\` to update.`
        )
      );
    }
  } catch {
    // search may not be configured
  }
}

export async function syncPushCommand(): Promise<void> {
  await ensureGit();
  const config = await loadConfig();

  if (!config.remote.url) {
    throw new Error("No remote configured. Run `clog remote add <url>` first.");
  }
  if (!config.author) {
    throw new Error('Set your author name first: clog config set author <name>');
  }

  // First-push visibility confirmation for non-GitHub remotes
  if (
    !config.remote.url.includes("github.com") &&
    !config.remote.visibilityConfirmed
  ) {
    const localCount = await withDb((ctx) =>
      ctx.listConversations({ state: "published", origin: "local", author: config.author }).length
    );
    const confirmed = await confirm(
      `You are about to push ${localCount} conversations to ${config.remote.url}.\n` +
      `clog cannot verify whether this remote is private.\n` +
      `Continue?`
    );
    if (!confirmed) {
      console.log("Aborted.");
      return;
    }
    config.remote.visibilityConfirmed = true;
    await saveConfig(config);
  }

  const result = await syncPush(config);

  if (!result.committed) {
    console.log("Nothing to push — all published conversations are already synced.");
    return;
  }

  if (!result.pushed) {
    console.error(
      "Push was rejected — likely a simultaneous push from a teammate. Run `clog sync push` again to retry."
    );
    if (result.error) {
      console.error(result.error);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`Pushed to ${chalk.cyan(config.remote.url)}`);
  console.log("");

  const added = result.changes.filter((c) => c.type === "added");
  const updated = result.changes.filter((c) => c.type === "updated");
  const retracted = result.changes.filter((c) => c.type === "retracted");

  if (result.changes.length <= 10) {
    for (const c of result.changes) {
      const prefix =
        c.type === "added" ? "+" : c.type === "updated" ? "~" : "-";
      const color =
        c.type === "added"
          ? chalk.green
          : c.type === "updated"
            ? chalk.yellow
            : chalk.red;
      console.log(color(`  ${prefix} ${c.id.slice(0, 6)} ${c.title}`));
    }
    console.log("");
  }

  const summary: string[] = [];
  if (added.length > 0) summary.push(`${added.length} added`);
  if (updated.length > 0) summary.push(`${updated.length} updated`);
  if (retracted.length > 0) summary.push(`${retracted.length} retracted`);
  console.log(summary.join(", ") + ".");
}
