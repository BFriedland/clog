import fs from "node:fs/promises";

import { confirm } from "@inquirer/prompts";
import chalk from "chalk";
import { Command } from "commander";

import {
  gitOriginFilter,
  listConversations,
  listConversationsInDb,
  removeGitConversationsForRemoteInDb,
  withDb,
} from "../db/index.js";
import { tryDeleteConversationVectors } from "../search/coherence.js";
import {
  clearRemoteConfig,
  getRemoteConfig,
  hasRemoteConfigured,
  setRemoteUrl,
} from "../sync/remote-config.js";
import { getRemoteRoot } from "../sync/paths.js";
import {
  checkVisibility,
  parseGitHubUrl,
} from "../sync/visibility.js";
import { ClogError } from "../utils/errors.js";

export function buildRemoteCommand(): Command {
  const remote = new Command("remote").description(
    "Manage the git remote clog uses for team sharing",
  );

  remote
    .command("add")
    .description("Configure a git remote for clog sync")
    .argument("<url>", "Git remote URL")
    .option("--yes", "Skip interactive confirmations (scripts/tests)")
    .action(async (url: string, options: { yes?: boolean }) => {
      await runRemoteAdd(url, { yes: Boolean(options.yes) });
    });

  remote
    .command("show")
    .description("Show the configured remote and sync state")
    .action(async () => {
      await runRemoteShow();
    });

  remote
    .command("remove")
    .description("Remove the configured remote and purge imported conversations")
    .option("--yes", "Skip interactive confirmation (scripts/tests)")
    .action(async (options: { yes?: boolean }) => {
      await runRemoteRemove({ yes: Boolean(options.yes) });
    });

  return remote;
}

async function runRemoteAdd(
  url: string,
  options: { yes: boolean },
): Promise<void> {
  if (await hasRemoteConfigured()) {
    throw new ClogError(
      "Remote already configured. Use `clog remote remove` first.",
    );
  }

  const trimmed = url.trim();
  if (!trimmed) {
    throw new ClogError("Remote URL cannot be empty.");
  }

  const existingRemoteConfig = await getRemoteConfig();
  const allowPublic = existingRemoteConfig.allowPublicRemote === true;

  // GitHub HTTPS warning (separate from the visibility check).
  if (/^https:\/\/github\.com\//i.test(trimmed)) {
    process.stderr.write(
      `${chalk.yellow("Warning:")} GitHub does not support password authentication over HTTPS.\n` +
        `Consider using the SSH URL instead (git@github.com:owner/repo.git).\n\n`,
    );
    if (!options.yes) {
      const proceed = await confirm({
        message: "Continue with the HTTPS URL?",
        default: false,
      });
      if (!proceed) {
        process.stdout.write("Aborted.\n");
        return;
      }
    }
  }

  const visibility = await checkVisibility(trimmed);

  if (visibility.kind === "public") {
    if (!allowPublic) {
      const parsed = parseGitHubUrl(trimmed);
      const repoLabel = parsed ? `${parsed.owner}/${parsed.repo}` : trimmed;
      throw new ClogError(
        `${chalk.red.bold(`Repository ${repoLabel} is public.`)}\n` +
          `Pushing conversations to a public repository would make them visible\n` +
          `to anyone on the internet.\n` +
          `If this is intentional, add "allowPublicRemote": true to your clog config.`,
      );
    }

    process.stderr.write(
      `${chalk.yellow("Warning:")} Repository is public, but \`allowPublicRemote\` is set in config — proceeding.\n`,
    );
  } else {
    // Unverified — confirm with the user (unless --yes).
    printUnverifiedPrompt(trimmed, visibility.reason);

    if (!options.yes) {
      const proceed = await confirm({
        message: "Continue?",
        default: false,
      });
      if (!proceed) {
        process.stdout.write("Aborted.\n");
        return;
      }
    }
  }

  await setRemoteUrl(trimmed, { visibilityConfirmed: true });
  process.stdout.write(
    `Remote configured. Run 'clog sync pull' to clone.\n`,
  );
}

function printUnverifiedPrompt(url: string, reason: string): void {
  const header = chalk.yellow.bold(
    `clog could not verify that ${url} is private.`,
  );
  const reasonLine = `Reason: ${reason}.`;
  const riskLine = chalk.red.bold(
    "If this repository is public, the conversations clog pushes to it will\n" +
      "be visible to anyone on the internet. clog refuses to push to a repository\n" +
      "it has positively identified as public, but it cannot guarantee privacy\n" +
      "when the visibility check could not complete.",
  );
  const advice = "Only continue if you are certain this repository is private.";

  process.stdout.write(`${header}\n${reasonLine}\n\n${riskLine}\n\n${advice}\n\n`);
}

async function runRemoteShow(): Promise<void> {
  const remote = await getRemoteConfig();

  if (!remote.url) {
    process.stdout.write("No remote configured.\n");
    return;
  }

  const localCount = (await listConversations({ origin: "local", states: ["saved"] })).length;
  const remoteCount = (await listConversations({ origin: gitOriginFilter(remote.url) })).length;

  process.stdout.write(`Remote URL: ${remote.url}\n`);
  process.stdout.write(
    `Last sync HEAD: ${remote.lastSyncHead ?? "(never synced)"}\n`,
  );
  process.stdout.write(`Local saved conversations: ${localCount}\n`);
  process.stdout.write(`Remote conversations imported: ${remoteCount}\n`);
}

async function runRemoteRemove(options: { yes: boolean }): Promise<void> {
  const remote = await getRemoteConfig();

  if (!remote.url) {
    throw new ClogError("No remote configured.");
  }

  const remoteRows = await withDb((db) =>
    listConversationsInDb(db, { origin: gitOriginFilter(remote.url!) }),
  );

  if (!options.yes) {
    process.stdout.write(
      `This will remove the remote and delete ${remoteRows.length} conversation(s) pulled from it.\n` +
        `Conversations you discovered or saved locally are not affected.\n`,
    );
    const proceed = await confirm({ message: "Continue?", default: false });
    if (!proceed) {
      process.stdout.write("Aborted.\n");
      return;
    }
  }

  // Delete DB rows, best-effort deindex, clear config, remove checkout.
  const idsToDelete = remoteRows.map((row) => row.id);
  await withDb((db) => {
    removeGitConversationsForRemoteInDb(db, remote.url!);
  });

  const failures = await tryDeleteConversationVectors(idsToDelete);
  for (const failedId of failures) {
    process.stderr.write(
      `warning: ${failedId.slice(0, 8)} removed from DB but search vectors could not be deleted\n`,
    );
  }

  await fs.rm(getRemoteRoot(), { recursive: true, force: true });
  await clearRemoteConfig();

  process.stdout.write(
    `Remote removed. Deleted ${idsToDelete.length} conversation(s) imported from it.\n`,
  );
}
