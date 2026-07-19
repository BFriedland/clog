#!/usr/bin/env node

import { Command } from "commander";

import { buildConfigCommand } from "./cli/config.js";
import { buildDiffCommand } from "./cli/diff.js";
import { buildDrainCommand } from "./cli/drain.js";
import { buildEditCommand } from "./cli/edit.js";
import { buildExcludeCommand } from "./cli/exclude.js";
import { buildFillCommand } from "./cli/fill.js";
import { buildInitCommand } from "./cli/init.js";
import { buildMcpCommand } from "./cli/mcp.js";
import { runIndexCommand } from "./cli/index-cmd.js";
import { buildListCommand } from "./cli/list.js";
import { buildPathCommand } from "./cli/path.js";
import { buildPlungeCommand } from "./cli/plunge.js";
import {
  installBrokenPipeHandler,
  preAction,
  runWithCliErrorHandling,
  shouldSkipPreAction,
} from "./cli/prelude.js";
import { buildSaveCommand } from "./cli/save.js";
import { buildRefreshCommand } from "./cli/refresh.js";
import { buildRemoveCommand } from "./cli/remove.js";
import { buildRemoteCommand } from "./cli/remote.js";
import { buildRenameAuthorCommand } from "./cli/rename-author.js";
import { buildSyncCommand } from "./cli/sync.js";
import { buildShowCommand } from "./cli/show.js";
import { buildStatusCommand } from "./cli/status.js";
import { buildSummarizeCommand, buildTalkCommand } from "./cli/talk.js";
import { buildTagCommand } from "./cli/tag.js";
import { buildUnexcludeCommand } from "./cli/unexclude.js";
import { buildUntagCommand } from "./cli/untag.js";
import { runSearchInitCommand } from "./cli/search-init.js";
import { runSearchCommand } from "./cli/search.js";

async function main(): Promise<void> {
  const program = new Command();

  program
    .name("clog")
    .description(
      "Discover, curate, and share AI coding agent conversations as a searchable knowledge base",
    )
    .hook("preAction", async (_thisCommand, actionCommand) => {
      if (shouldSkipPreAction(actionCommand.name(), actionCommand.parent?.name())) {
        return;
      }

      await preAction({ interactive: Boolean(process.stdin.isTTY) });
    });

  // These command groups mirror the command tables in README.md. Until the
  // reference generator lands, changes here (groups, ordering, add/remove)
  // must be mirrored there by hand.
  program.commandsGroup("Discovery & Curation");
  program.addCommand(buildStatusCommand());
  program.addCommand(buildListCommand());
  program.addCommand(buildEditCommand());
  program.addCommand(buildTagCommand());
  program.addCommand(buildUntagCommand());
  program.addCommand(buildExcludeCommand());
  program.addCommand(buildUnexcludeCommand());
  program.addCommand(buildRemoveCommand());
  program.addCommand(buildRenameAuthorCommand());

  program.commandsGroup("Saving & Inspection");
  program.addCommand(buildSaveCommand());
  program.addCommand(buildDiffCommand());
  program.addCommand(buildShowCommand());
  program.addCommand(buildPathCommand());
  program.addCommand(buildDrainCommand());
  program.addCommand(buildFillCommand());
  program.addCommand(buildPlungeCommand());

  program.commandsGroup("Agent Sessions");
  program.addCommand(buildTalkCommand());
  program.addCommand(buildSummarizeCommand());

  program.commandsGroup("Semantic Search");
  program
    .command("search [query]")
    .description("Semantic search across saved conversations")
    .option("--init", "Set up search")
    .option("-p, --project <name>", "Filter by project")
    .option("-a, --author <name>", "Filter by author")
    .option("-t, --tag <tag>", "Filter by tag")
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
  program
    .command("index")
    .description("Index saved conversations for semantic search")
    .option("--rebuild", "Re-index all saved conversations from scratch")
    .action(async (options: { rebuild?: boolean }) => {
      await runIndexCommand(options);
    });

  program.commandsGroup("Team Sharing");
  program.addCommand(buildRemoteCommand());
  program.addCommand(buildSyncCommand());
  program.addCommand(buildRefreshCommand());

  program.commandsGroup("Configuration");
  program.addCommand(buildInitCommand());
  program.addCommand(buildMcpCommand());
  program.addCommand(buildConfigCommand());

  await program.parseAsync(process.argv);
}

installBrokenPipeHandler();
await runWithCliErrorHandling(main);
