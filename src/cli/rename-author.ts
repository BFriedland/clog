import { Command } from "commander";

import { listConversations, renameLocalAuthor } from "../db/index.js";
import { nowIso } from "../utils/time.js";
import { confirm } from "./common.js";

type ConfirmFn = (message: string) => Promise<boolean>;

export function buildRenameAuthorCommand(): Command {
  return new Command("rename-author")
    .description("Rename author across local conversations")
    .argument("<old>")
    .argument("<new>")
    .action(async (oldName: string, newName: string) => {
      await runRenameAuthor(oldName, newName);
    });
}

export async function runRenameAuthor(
  oldName: string,
  newName: string,
  confirmFn: ConfirmFn = confirm,
): Promise<void> {
  const conversations = await listConversations({ author: oldName, origin: "local" });
  if (conversations.length === 0) {
    process.stdout.write(`No conversations found for author "${oldName}".\n`);
    return;
  }

  const proceed = await confirmFn(
    `This will rename author "${oldName}" to "${newName}" on ${conversations.length} local conversations. Continue?`,
  );

  if (!proceed) {
    process.stdout.write("Operation cancelled.\n");
    return;
  }

  const renamed = await renameLocalAuthor(oldName, newName, { modifiedAt: nowIso() });

  process.stdout.write(`Renamed author on ${renamed} conversation(s)\n`);
}
