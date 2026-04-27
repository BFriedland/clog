#!/usr/bin/env node

import { Command } from "commander";

import { buildAddCommand } from "./cli/add.js";
import { buildConfigCommand } from "./cli/config.js";
import { buildDiffCommand } from "./cli/diff.js";
import { buildDrainCommand } from "./cli/drain.js";
import { buildEditCommand } from "./cli/edit.js";
import { buildExcludeCommand } from "./cli/exclude.js";
import { runIndexCommand } from "./cli/index-cmd.js";
import { buildListCommand } from "./cli/list.js";
import { buildPathCommand } from "./cli/path.js";
import { buildPlungeCommand } from "./cli/plunge.js";
import { preAction, runWithCliErrorHandling } from "./cli/prelude.js";
import { buildPublishCommand } from "./cli/publish.js";
import { buildRefreshCommand } from "./cli/refresh.js";
import { buildRemoveCommand } from "./cli/remove.js";
import { buildRemoteCommand } from "./cli/remote.js";
import { buildRenameAuthorCommand } from "./cli/rename-author.js";
import { buildResetCommand } from "./cli/reset.js";
import { buildSyncCommand } from "./cli/sync.js";
import { buildShowCommand } from "./cli/show.js";
import { buildStatusCommand } from "./cli/status.js";
import { buildTagCommand } from "./cli/tag.js";
import { buildUnexcludeCommand } from "./cli/unexclude.js";
import { buildUnpublishCommand } from "./cli/unpublish.js";
import { buildUntagCommand } from "./cli/untag.js";
import { runSearchInitCommand } from "./cli/search-init.js";
import { runSearchCommand } from "./cli/search.js";
import { initializeClog } from "./config/init.js";
import { getClogHome } from "./utils/paths.js";

async function main(): Promise<void> {
  const program = new Command();

  program
    .name("clog")
    .description(
      "Discover, curate, and share AI coding agent conversations as a searchable knowledge base",
    )
    .hook("preAction", async (_thisCommand, actionCommand) => {
      if (actionCommand.name() === "plunge") {
        return;
      }

      await preAction({ interactive: Boolean(process.stdin.isTTY) });
    });

  program
    .command("init")
    .description("Initialize clog")
    .action(async () => {
      const result = await initializeClog({ interactive: Boolean(process.stdin.isTTY) });
      if (result.createdConfig) {
        process.stdout.write(`Initialized clog at ${getClogHome()}\n`);
      }
    });

  program.addCommand(buildStatusCommand());
  program.addCommand(buildListCommand());
  program.addCommand(buildAddCommand());
  program.addCommand(buildResetCommand());
  program.addCommand(buildEditCommand());
  program.addCommand(buildTagCommand());
  program.addCommand(buildUntagCommand());
  program.addCommand(buildPublishCommand());
  program.addCommand(buildUnpublishCommand());
  program.addCommand(buildShowCommand());
  program.addCommand(buildPathCommand());
  program.addCommand(buildPlungeCommand());
  program.addCommand(buildDiffCommand());
  program.addCommand(buildDrainCommand());
  program.addCommand(buildExcludeCommand());
  program.addCommand(buildUnexcludeCommand());
  program.addCommand(buildRemoveCommand());
  program.addCommand(buildConfigCommand());
  program.addCommand(buildRenameAuthorCommand());
  program.addCommand(buildRemoteCommand());
  program.addCommand(buildSyncCommand());
  program.addCommand(buildRefreshCommand());
  program
    .command("index")
    .description("Index published conversations for semantic search")
    .option("--rebuild", "Re-index all published conversations from scratch")
    .action(async (options: { rebuild?: boolean }) => {
      await runIndexCommand(options);
    });

  program
    .command("search [query]")
    .description("Semantic search across published conversations")
    .option("--init", "Set up search")
    .option("-p, --project <name>")
    .option("-a, --author <name>")
    .option("-t, --tag <tag>")
    .option("-l, --limit <n>", "Maximum results", (value) => Number(value))
    .action(async (query: string | undefined, options) => {
      if (options.init) {
        await runSearchInitCommand();
        return;
      }

      if (!query) {
        throw new Error('Usage: clog search <query>\n\nRun "clog search --init" to set up search.');
      }

      await runSearchCommand(query, options);
    });

  await program.parseAsync(process.argv);
}

await runWithCliErrorHandling(main);
