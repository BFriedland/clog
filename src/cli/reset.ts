import { Command } from "commander";

import { updateConversation } from "../db/index.js";
import { removeRawCopyIfPresent, resolveManyConversationsOrFail } from "./common.js";

export function buildResetCommand(): Command {
  return new Command("reset")
    .description("Unstage conversations back to discovered")
    .argument("<ids...>")
    .action(async (ids: string[]) => {
      const conversations = await resolveManyConversationsOrFail(ids);

      for (const conversation of conversations) {
        if (conversation.state === "discovered") {
          throw new Error(
            `Conversation ${conversation.id.slice(0, 7)} is not staged. Use "clog add <id>" before resetting it.`,
          );
        }

        if (conversation.state === "published") {
          throw new Error(`Conversation ${conversation.id} is published. Use "clog unpublish" first.`);
        }

        await removeRawCopyIfPresent(conversation);
        await updateConversation({
          ...conversation,
          state: "discovered",
          filePath: null,
          publishedAt: null,
          publishedMessageCount: null,
          publishVersion: 0,
        });
      }

      process.stdout.write(`Reset ${conversations.length} conversation(s)\n`);
    });
}
