#!/usr/bin/env node

import { Command } from "commander";

import { buildAddCommand } from "./cli/add.js";
import { buildConfigCommand } from "./cli/config.js";
import { buildDiffCommand } from "./cli/diff.js";
import { buildEditCommand } from "./cli/edit.js";
import { buildExcludeCommand } from "./cli/exclude.js";
import { buildListCommand } from "./cli/list.js";
import { buildPathCommand } from "./cli/path.js";
import { preAction, runWithCliErrorHandling } from "./cli/prelude.js";
import { buildPublishCommand } from "./cli/publish.js";
import { buildRenameAuthorCommand } from "./cli/rename-author.js";
import { buildResetCommand } from "./cli/reset.js";
import { buildShowCommand } from "./cli/show.js";
import { buildStatusCommand } from "./cli/status.js";
import { buildTagCommand } from "./cli/tag.js";
import { buildUnexcludeCommand } from "./cli/unexclude.js";
import { buildUnpublishCommand } from "./cli/unpublish.js";
import { buildUntagCommand } from "./cli/untag.js";
import { initializeClog } from "./config/init.js";
import { getClogHome } from "./utils/paths.js";

async function main(): Promise<void> {
  const program = new Command();

  program
    .name("clog")
    .description(
      "Discover, curate, and share AI coding agent conversations as a searchable knowledge base",
    )
    .hook("preAction", async () => {
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
  program.addCommand(buildDiffCommand());
  program.addCommand(buildExcludeCommand());
  program.addCommand(buildUnexcludeCommand());
  program.addCommand(buildConfigCommand());
  program.addCommand(buildRenameAuthorCommand());

  await program.parseAsync(process.argv);
}

await runWithCliErrorHandling(main);
