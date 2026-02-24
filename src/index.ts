#!/usr/bin/env node

import { Command } from "commander";
import { ensureClogHome } from "./config/init.js";

function wrapAction<A extends unknown[]>(
  fn: (...args: A) => Promise<void>,
): (...args: A) => Promise<void> {
  return async (...args) => {
    if (process.env.CLOG_DEBUG) {
      await fn(...args);
      return;
    }
    try {
      await fn(...args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`error: ${message}`);
      process.exitCode = 1;
    }
  };
}

const program = new Command();

program
  .name("clog")
  .description(
    "Discover, curate, and share AI coding agent conversations as a searchable knowledge base"
  )
  .version("0.1.0");

// Ensure clog home exists before any command runs.
// On first run (no config yet), prompt for author name.
program.hook("preAction", async (_thisCommand, actionCommand) => {
  const { access } = await import("node:fs/promises");
  const { getConfigPath } = await import("./config/index.js");
  let firstRun = false;
  try {
    await access(getConfigPath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      firstRun = true;
    } else {
      throw err;
    }
  }

  if (actionCommand.name() === "init") {
    // Let the init action handle its own setup
    return;
  }

  if (firstRun) {
    const { initInteractive } = await import("./config/init.js");
    await initInteractive();
  } else {
    await ensureClogHome();
  }
});

program
  .command("init")
  .description("Initialize clog (runs automatically on first use)")
  .action(wrapAction(async () => {
    const { initInteractive } = await import("./config/init.js");
    await initInteractive();
  }));

program
  .command("status")
  .description("Show counts by state and recent activity")
  .action(wrapAction(async () => {
    const { statusCommand } = await import("./cli/status.js");
    await statusCommand();
  }));

program
  .command("list")
  .description("List conversations (default: staged + published)")
  .option("-s, --state <state>", "Filter by state (discovered, staged, published)")
  .option("--all", "Show all conversations including discovered and excluded")
  .option("-p, --project <project>", "Filter by project")
  .option("-a, --author <author>", "Filter by author")
  .option("-t, --tag <tag>", "Filter by tag")
  .option("-g, --grep <text>", "Filter by text match on title/summary")
  .option("-c, --columns <cols>", "Columns to show (comma-separated: id,date,state,project,author,title)")
  .action(wrapAction(async (opts) => {
    const { listCommand } = await import("./cli/list.js");
    await listCommand(opts);
  }));

program
  .command("add [ids...]")
  .description("Stage conversation(s)")
  .option("--all", "Add all discovered conversations")
  .option("--project <project>", "Add all discovered for a project")
  .action(wrapAction(async (ids: string[], opts) => {
    const { addCommand } = await import("./cli/add.js");
    await addCommand(ids, opts);
  }));

program
  .command("reset <ids...>")
  .description("Move conversation(s) back to discovered")
  .action(wrapAction(async (ids: string[]) => {
    const { resetCommand } = await import("./cli/reset.js");
    await resetCommand(ids);
  }));

program
  .command("exclude <ids...>")
  .description("Exclude conversation(s) from discovery")
  .action(wrapAction(async (ids: string[]) => {
    const { excludeCommand } = await import("./cli/exclude.js");
    await excludeCommand(ids);
  }));

program
  .command("unexclude <ids...>")
  .description("Remove conversation(s) from the excluded list")
  .action(wrapAction(async (ids: string[]) => {
    const { unexcludeCommand } = await import("./cli/unexclude.js");
    await unexcludeCommand(ids);
  }));

program
  .command("edit <id>")
  .description("Edit conversation metadata")
  .option("--title <title>", "Set the conversation title")
  .option("--summary <summary>", "Set the conversation summary")
  .action(wrapAction(async (id: string, opts) => {
    const { editCommand } = await import("./cli/edit.js");
    await editCommand(id, opts);
  }));

program
  .command("tag <id> <tags...>")
  .description("Add tags to a conversation")
  .action(wrapAction(async (id: string, tags: string[]) => {
    const { tagCommand } = await import("./cli/tag.js");
    await tagCommand(id, tags);
  }));

program
  .command("untag <id> <tags...>")
  .description("Remove tags from a conversation")
  .action(wrapAction(async (id: string, tags: string[]) => {
    const { untagCommand } = await import("./cli/untag.js");
    await untagCommand(id, tags);
  }));

program
  .command("publish [ids...]")
  .description("Publish conversations to the knowledge base")
  .option("-m, --message <message>", "Publish message")
  .action(wrapAction(async (ids: string[], opts) => {
    const { publishCommand } = await import("./cli/publish.js");
    await publishCommand(ids, opts);
  }));

program
  .command("unpublish <ids...>")
  .description("Move published conversation(s) back to staged")
  .action(wrapAction(async (ids: string[]) => {
    const { unpublishCommand } = await import("./cli/unpublish.js");
    await unpublishCommand(ids);
  }));

program
  .command("diff [ids...]")
  .description("Show new messages since last publish")
  .option("--staged", "Show full content of staged conversations")
  .option("--head <n>", "Show only the first N messages", parseInt)
  .option("--first <n>", "Show only the first N messages (alias for --head)", parseInt)
  .option("--tail <n>", "Show only the last N messages", parseInt)
  .option("--last <n>", "Show only the last N messages (alias for --tail)", parseInt)
  .action(wrapAction(async (ids: string[], opts) => {
    const { diffCommand } = await import("./cli/diff.js");
    await diffCommand(ids, opts);
  }));

program
  .command("show <id>")
  .description("Display a conversation")
  .option("--path", "Print only the file path")
  .option("--head <n>", "Show only the first N messages", parseInt)
  .option("--first <n>", "Show only the first N messages (alias for --head)", parseInt)
  .option("--tail <n>", "Show only the last N messages", parseInt)
  .option("--last <n>", "Show only the last N messages (alias for --tail)", parseInt)
  .action(wrapAction(async (id: string, opts) => {
    const { showCommand } = await import("./cli/show.js");
    await showCommand(id, opts);
  }));

program
  .command("path <id>")
  .description("Print the file path for a conversation")
  .action(wrapAction(async (id: string) => {
    const { pathCommand } = await import("./cli/path.js");
    await pathCommand(id);
  }));

program
  .command("log")
  .description("Show publish history")
  .action(wrapAction(async () => {
    const { logCommand } = await import("./cli/log.js");
    await logCommand();
  }));

program
  .command("config [action] [key] [value]")
  .description("View or edit configuration")
  .action(wrapAction(async (action: string, key: string, value: string) => {
    const { configCommand } = await import("./cli/config.js");
    await configCommand(action, key, value);
  }));

program.parse();
