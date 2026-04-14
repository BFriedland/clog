import { Command } from "commander";

import { updateConversation } from "../db/index.js";
import { resolveManyConversationsOrFail } from "./common.js";

export function buildUnpublishCommand(): Command {
  return new Command("unpublish")
    .description("Move published conversations back to staged")
    .argument("<ids...>")
    .action(async (ids: string[]) => {
      const conversations = await resolveManyConversationsOrFail(ids);

      for (const conversation of conversations) {
        if (conversation.state !== "published") {
          throw new Error(
            `Conversation ${conversation.id.slice(0, 7)} is not published. Use "clog add <id>" to stage it first.`,
          );
        }

        await updateConversation({
          ...conversation,
          state: "staged",
        });
      }

      process.stdout.write(`Unpublished ${conversations.length} conversation(s) (moved to staged)\n`);
    });
}
