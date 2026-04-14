import { Command } from "commander";

import { updateConversation } from "../db/index.js";
import { tryDeleteConversationVectors } from "../search/coherence.js";
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
          indexedAt: null,
        });
      }

      const failures = await tryDeleteConversationVectors(conversations.map((conversation) => conversation.id));
      for (const failedId of failures) {
        process.stderr.write(
          `warning: ${failedId.slice(0, 7)} was unpublished but its search vectors could not be deleted\n`,
        );
      }

      process.stdout.write(`Unpublished ${conversations.length} conversation(s) (moved to staged)\n`);
    });
}
