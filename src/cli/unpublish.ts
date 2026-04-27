import { Command } from "commander";

import { listConversations, updateConversation } from "../db/index.js";
import { tryDeleteConversationVectors } from "../search/coherence.js";
import { assertNoneRemote } from "./common.js";
import { collectProjectUnpublishTargets } from "./project-targets.js";
import { resolveConversationSelectors } from "./selectors.js";

export function buildUnpublishCommand(): Command {
  return new Command("unpublish")
    .description("Move published conversations back to staged")
    .argument("[selectors...]")
    .action(async (selectors: string[]) => {
      const conversations =
        selectors.length > 0
          ? resolveConversationSelectors({
              commandName: "clog unpublish",
              tokens: selectors,
              idCandidates: await listConversations(),
              projectCandidates: await collectProjectUnpublishTargets(),
            })
          : await collectProjectUnpublishTargets();

      if (conversations.length === 0) {
        process.stdout.write("No published conversations to unpublish.\n");
        return;
      }

      assertNoneRemote(conversations, "clog unpublish");

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
