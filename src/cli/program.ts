import { Command } from "commander";

import { buildConfigCommand } from "./config.js";
import { buildDiffCommand } from "./diff.js";
import { buildDrainCommand } from "./drain.js";
import { buildEditCommand } from "./edit.js";
import { buildExcludeCommand } from "./exclude.js";
import { buildFillCommand } from "./fill.js";
import { buildInitCommand } from "./init.js";
import { buildMcpCommand } from "./mcp.js";
import { runIndexCommand } from "./index-cmd.js";
import { buildListCommand } from "./list.js";
import { buildPathCommand } from "./path.js";
import { buildPlungeCommand } from "./plunge.js";
import { preAction, shouldSkipPreAction } from "./prelude.js";
import { buildSaveCommand } from "./save.js";
import { buildRefreshCommand } from "./refresh.js";
import { buildRemoveCommand } from "./remove.js";
import { buildRemoteCommand } from "./remote.js";
import { buildRenameAuthorCommand } from "./rename-author.js";
import { buildSyncCommand } from "./sync.js";
import { buildShowCommand } from "./show.js";
import { buildStatusCommand } from "./status.js";
import { buildSummarizeCommand, buildTalkCommand } from "./talk.js";
import { buildTagCommand } from "./tag.js";
import { buildUnexcludeCommand } from "./unexclude.js";
import { buildUntagCommand } from "./untag.js";
import { buildUninstallCommand } from "./uninstall.js";
import { runSearchInitCommand } from "./search-init.js";
import { runSearchCommand } from "./search.js";

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("clog")
    .description(
      "Discover, curate, and share AI coding agent conversations as a searchable knowledge base",
    )
    .addHelpText("after", (context) => {
      // Show the agent-integration hint only for non-interactive invocations —
      // piped or captured output, as when an agent runs `clog --help` through a
      // bash tool. A human at a terminal gets a TTY and does not see it.
      const stream = context.error ? process.stderr : process.stdout;
      if (stream.isTTY) {
        return "";
      }
      return (
        "\nAI agent integration: when clog's MCP server is configured, use its MCP" +
        "\ntools for conversation discovery, retrieval, organization, and analysis." +
        "\nRun 'clog mcp setup <claude|codex|both>' to configure the integration."
      );
    })
    .hook("preAction", async (_thisCommand, actionCommand) => {
      if (shouldSkipPreAction(actionCommand.name(), actionCommand.parent?.name())) {
        return;
      }

      const isConfigCommand =
        actionCommand.name() === "config" ||
        actionCommand.parent?.name() === "config";
      await preAction({
        interactive: Boolean(process.stdin.isTTY),
        refreshRelationshipInspections: !isConfigCommand,
        showRelationshipWarnings: actionCommand.name() === "status",
        verboseWarnings:
          actionCommand.name() === "status" &&
          actionCommand.opts().verboseWarnings === true,
      });
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
    .option("--all-branches", "Show every matching branch and superseded generation")
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
  program.addCommand(buildUninstallCommand());

  return program;
}
