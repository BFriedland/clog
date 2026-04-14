import { Command } from "commander";

import { listConversations, updateConversation } from "../db/index.js";
import { nowIso } from "../utils/time.js";
import { confirm } from "./common.js";

export function buildRenameAuthorCommand(): Command {
  return new Command("rename-author")
    .description("Rename author across local conversations")
    .argument("<old>")
    .argument("<new>")
    .action(async (oldName: string, newName: string) => {
      const conversations = await listConversations({ author: oldName });
      if (conversations.length === 0) {
        process.stdout.write(`No conversations found for author "${oldName}".\n`);
        return;
      }

      const proceed = await confirm(
        `This will rename author "${oldName}" to "${newName}" on ${conversations.length} local conversations. Continue?`,
      );

      if (!proceed) {
        process.stdout.write("Aborted.\n");
        return;
      }

      const timestamp = nowIso();
      for (const conversation of conversations) {
        await updateConversation({
          ...conversation,
          author: newName,
          modifiedAt: timestamp,
        });
      }

      process.stdout.write(`Renamed author on ${conversations.length} conversation(s)\n`);
    });
}
