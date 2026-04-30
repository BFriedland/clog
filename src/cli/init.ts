import { confirm } from "@inquirer/prompts";
import { Command } from "commander";
import chalk from "chalk";

import { promptForMcpSetupTarget, runMcpSetup } from "./mcp.js";
import { runSearchInitCommand } from "./search-init.js";
import { loadConfig } from "../config/index.js";
import { initializeClog } from "../config/init.js";
import { getClogHome } from "../utils/paths.js";

export function buildInitCommand(): Command {
  return new Command("init")
    .alias("setup")
    .description("Initialize clog")
    .action(async () => {
      const interactive = Boolean(process.stdin.isTTY);
      const result = await initializeClog({ interactive, forcePromptAuthor: interactive });

      if (result.createdConfig) {
        process.stdout.write(`Initialized clog at ${getClogHome()}\n`);
      }

      if (!interactive) {
        return;
      }

      const config = await loadConfig();
      if (config.search) {
        process.stdout.write(
          `${chalk.bold("\nWarning: Vector search is already configured. Re-running setup may replace your current search configuration and require re-indexing saved conversations.\n")}`,
        );

        const rerunSearchSetup = await confirm({
          message: "Re-run vector search setup?",
          default: false,
        });

        if (rerunSearchSetup) {
          await runSearchInitCommand();
        }
      } else {
        const setupSearch = await confirm({
          message: "Set up vector search now?",
          default: true,
        });

        if (setupSearch) {
          await runSearchInitCommand();
        }
      }

      const setupMcp = await confirm({
        message: "Set up MCP integration now?",
        default: true,
      });

      if (!setupMcp) {
        return;
      }

      const client = await promptForMcpSetupTarget();
      await runMcpSetup(client);
    });
}
