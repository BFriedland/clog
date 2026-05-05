import fs from "node:fs/promises";
import path from "node:path";

import chalk from "chalk";
import { Command } from "commander";

import { loadConfig } from "../config/index.js";
import { listConversations } from "../db/index.js";
import {
  gitAddAll,
  gitClone,
  gitCommit,
  gitConfiguredUserEmail,
  gitHasChanges,
  gitPullRebase,
  gitPush,
  gitRebaseAbort,
  gitRemoteGetUrl,
  gitRevParseHead,
  isGitAvailable,
  GitError,
} from "../sync/git.js";
import { getRemoteGitDir, getRemoteRoot } from "../sync/paths.js";
import { reconcileRemote, type PullStats } from "../sync/pull.js";
import {
  buildCommitMessage,
  collectRemoteOriginIds,
  exportAuthorToCheckout,
  type ChangeRecord,
  type ExportStats,
} from "../sync/push.js";
import { updateLastSyncHead } from "../sync/staleness.js";
import { ClogError } from "../utils/errors.js";
import { renderWarnings } from "./common.js";

export function buildSyncCommand(): Command {
  const sync = new Command("sync").description(
    "Sync conversations with the configured git remote",
  );

  sync
    .command("pull")
    .description("Pull and reconcile conversations from the remote")
    .action(async () => {
      await runSyncPull();
    });

  sync
    .command("push")
    .description("Push locally-saved conversations to the remote")
    .action(async () => {
      await runSyncPush();
    });

  return sync;
}

async function requireGit(): Promise<void> {
  if (!(await isGitAvailable())) {
    throw new ClogError(
      "Git is required for sync. Install git and try again.",
    );
  }
}

async function requireRemoteConfigured() {
  const config = await loadConfig();
  if (!config.remote.url) {
    throw new ClogError(
      "No remote configured. Run 'clog remote add <url>' first.",
    );
  }
  return config;
}

export async function runSyncPull(): Promise<void> {
  await requireGit();
  const config = await requireRemoteConfigured();
  const remoteUrl = config.remote.url!;

  await ensureCheckoutExists(remoteUrl);
  await advisoryGitIdentityCheck();

  try {
    await gitPullRebase(getRemoteRoot());
  } catch (error) {
    if (error instanceof GitError) {
      await gitRebaseAbort(getRemoteRoot()).catch(() => undefined);
      throw new ClogError(
        `Unexpected conflict during rebase. Inspect with: git -C ${getRemoteRoot()} status\n${error.stderr}`,
      );
    }
    throw error;
  }

  const stats = await reconcileRemote(config, remoteUrl);
  printPullResult(stats);

  renderWarnings(stats.warnings);

  if (config.search) {
    await printPostPullIndexNudge(stats);
  }

  const head = await gitRevParseHead(getRemoteRoot());
  await updateLastSyncHead(head);
}

async function printPostPullIndexNudge(stats: PullStats): Promise<void> {
  if (stats.inserted === 0 && stats.updated === 0) {
    return;
  }

  const unindexed = (
    await listConversations({ states: ["saved"], indexed: false })
  ).length;

  if (unindexed === 0) {
    return;
  }

  process.stdout.write("\n");
  process.stdout.write(chalk.yellow("Search index needs attention:\n"));
  process.stdout.write(
    `  ${unindexed} saved conversation(s) are not indexed.\n`,
  );
  process.stdout.write(
    "  Run `clog index` to index new conversations, or `clog index --rebuild` to rebuild everything.\n",
  );
}

export async function runSyncPush(): Promise<void> {
  await requireGit();
  const config = await requireRemoteConfigured();
  const remoteUrl = config.remote.url!;

  if (!config.remote.visibilityConfirmed) {
    throw new ClogError(
      "Remote visibility was never confirmed. Run 'clog remote remove' and 'clog remote add <url>' to re-run the visibility check.",
    );
  }

  if (!config.author.trim()) {
    throw new ClogError(
      "Set your author name first: clog config set author <name>",
    );
  }

  if (!(await directoryExists(getRemoteGitDir()))) {
    throw new ClogError(
      "You haven't pulled from the remote yet. Run 'clog sync pull' first.",
    );
  }

  await advisoryGitIdentityCheck();

  // Snapshot remote-origin IDs for this author before reconcile.
  // Conversations present here were pulled from the remote and not deleted
  // locally — they must not be retracted from the checkout during export.
  // Conversations that reconcileRemote re-imports during the pull phase below
  // are NOT in this snapshot, so intentional retractions still proceed.
  const preReconcileRemoteIds = await collectRemoteOriginIds(config.author, remoteUrl);

  // Pull phase: incorporate teammates' changes first.
  try {
    await gitPullRebase(getRemoteRoot());
  } catch (error) {
    if (error instanceof GitError) {
      await gitRebaseAbort(getRemoteRoot()).catch(() => undefined);
      throw new ClogError(
        `Unexpected conflict during rebase. Inspect with: git -C ${getRemoteRoot()} status\n${error.stderr}`,
      );
    }
    throw error;
  }

  const pullStats = await reconcileRemote(config, remoteUrl);
  renderWarnings(pullStats.warnings);

  // Export phase: write local state to checkout.
  const exportStats = await exportAuthorToCheckout(config.author, preReconcileRemoteIds);

  // Commit and push.
  await gitAddAll(getRemoteRoot());

  if (!(await gitHasChanges(getRemoteRoot()))) {
    // Pull/reconcile may have advanced HEAD with teammate-only changes; record
    // it so subsequent `clog status` doesn't flag the checkout as stale.
    const head = await gitRevParseHead(getRemoteRoot());
    await updateLastSyncHead(head);
    process.stdout.write(
      "Nothing to push — all saved conversations are already synced.\n",
    );
    return;
  }

  if (exportStats.changes.length === 0) {
    throw new ClogError(
      `Unexpected state: git reports changes in ${getRemoteRoot()} but clog has no conversations to add, update, or retract. Inspect with: git -C ${getRemoteRoot()} status`,
    );
  }

  const message = buildCommitMessage({ changes: exportStats.changes });

  try {
    await gitCommit(getRemoteRoot(), message);
  } catch (error) {
    if (error instanceof GitError) {
      throw new ClogError(
        `git commit failed.\n${error.stderr}\n\n` +
          "clog uses your existing git identity for commits. If git has no identity configured, set it with:\n" +
          '  git config --global user.email "you@example.com"\n' +
          '  git config --global user.name  "Your Name"',
      );
    }
    throw error;
  }

  try {
    await gitPush(getRemoteRoot());
  } catch (error) {
    if (error instanceof GitError) {
      throw new ClogError(
        "Push was rejected — likely a simultaneous push from a teammate. Run 'clog sync push' again to retry.\n" +
          error.stderr,
      );
    }
    throw error;
  }

  const head = await gitRevParseHead(getRemoteRoot());
  await updateLastSyncHead(head);

  printPushResult(remoteUrl, exportStats);
}

async function ensureCheckoutExists(remoteUrl: string): Promise<void> {
  const root = getRemoteRoot();
  const gitDir = getRemoteGitDir();

  if (await directoryExists(gitDir)) {
    const actualUrl = await gitRemoteGetUrl(root);
    if (actualUrl && actualUrl !== remoteUrl) {
      throw new ClogError(
        `The checkout at ${root} points to ${actualUrl}, which does not match the configured remote ${remoteUrl}. Aborting.`,
      );
    }
    return;
  }

  // No checkout yet — clone fresh. If the directory exists but has no .git, refuse.
  if (await directoryExists(root)) {
    throw new ClogError(
      `${root} exists but has no .git directory. Remove it manually and try again.`,
    );
  }

  await fs.mkdir(path.dirname(root), { recursive: true });
  try {
    await gitClone(remoteUrl, root);
  } catch (error) {
    if (error instanceof GitError) {
      throw new ClogError(
        `Failed to clone ${remoteUrl}.\n${error.stderr}\n\n` +
          "Git authentication failed. Check your SSH keys or credential helper configuration.",
      );
    }
    throw error;
  }
}

async function advisoryGitIdentityCheck(): Promise<void> {
  const email = await gitConfiguredUserEmail(getRemoteRoot());
  if (email) return;

  process.stderr.write(
    `${chalk.yellow("warning:")} git has no user.email configured for the clog remote checkout.\n` +
      "clog uses your existing git identity for commits. Configure it with:\n" +
      '  git config --global user.email "you@example.com"\n' +
      '  git config --global user.name  "Your Name"\n',
  );
}

async function directoryExists(dir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dir);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function printPullResult(stats: PullStats): void {
  const total = stats.inserted + stats.updated + stats.deleted;
  process.stdout.write(
    `Pulled ${total} conversation(s) from remote. ${stats.inserted} new, ${stats.updated} updated, ${stats.deleted} removed.\n`,
  );
}

function printPushResult(remoteUrl: string, stats: ExportStats): void {
  const counts = summarizeChanges(stats.changes);
  process.stdout.write(`\nPushed to ${remoteUrl}\n\n`);

  if (stats.changes.length <= 10) {
    for (const change of [...stats.changes].sort(sortChanges)) {
      const prefix =
        change.kind === "added" ? "+" : change.kind === "updated" ? "~" : "-";
      process.stdout.write(
        `  ${prefix} ${change.id.slice(0, 8)} ${change.title}\n`,
      );
    }
    process.stdout.write("\n");
  }

  const parts: string[] = [];
  if (counts.added > 0) parts.push(`${counts.added} added`);
  if (counts.updated > 0) parts.push(`${counts.updated} updated`);
  if (counts.retracted > 0) parts.push(`${counts.retracted} retracted`);
  process.stdout.write(`${parts.join(", ")}.\n`);
}

function summarizeChanges(changes: ChangeRecord[]) {
  let added = 0;
  let updated = 0;
  let retracted = 0;
  for (const change of changes) {
    if (change.kind === "added") added += 1;
    else if (change.kind === "updated") updated += 1;
    else retracted += 1;
  }
  return { added, updated, retracted };
}

function sortChanges(a: ChangeRecord, b: ChangeRecord): number {
  const order: Record<ChangeRecord["kind"], number> = {
    added: 0,
    updated: 1,
    retracted: 2,
  };
  if (order[a.kind] !== order[b.kind]) return order[a.kind] - order[b.kind];
  return a.id.localeCompare(b.id);
}
