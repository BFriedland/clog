import { confirm } from "@inquirer/prompts";
import { Command } from "commander";

import { promptForMcpSetupTarget, runMcpSetup } from "./mcp.js";
import { runSearchInitCommand } from "./search-init.js";
import { loadConfig } from "../config/index.js";
import { initializeClog } from "../config/init.js";
import { searchAvailable } from "../search/deps.js";
import { getClogHome, getSearchRuntimeRoot } from "../utils/paths.js";

export function buildInitCommand(): Command {
  return new Command("init")
    .alias("setup")
    .description("Initialize clog")
    .action(async () => {
      const interactive = Boolean(process.stdin.isTTY);
      const result = await initializeClog({ interactive, forcePromptAuthor: interactive });

      if (result.createdConfig) {
        process.stdout.write(`\nInitialized clog at ${getClogHome()}\n\n`);
      }

      if (!interactive) {
        return;
      }

      const config = await loadConfig();
      if (config.search) {
        if (await searchAvailable()) {
          process.stdout.write("\nVector search is already configured.\n");
          process.stdout.write(
            "Re-running setup can change the search provider or vector store and may require re-indexing saved conversations.\n",
          );

          const rerunSearchSetup = await confirm({
            message: "Re-run vector search setup?",
            default: false,
          });

          if (rerunSearchSetup) {
            await runSearchInitCommand();
          }
        } else {
          process.stdout.write(
            `\nVector search is configured, but runtime packages are missing or unusable in ${getSearchRuntimeRoot()}.\n`,
          );

          const repairSearchSetup = await confirm({
            message: "Repair vector search setup?",
            default: true,
          });

          if (repairSearchSetup) {
            await runSearchInitCommand();
          }
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

      process.stdout.write("\n");

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
