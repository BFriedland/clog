import { Command } from "commander";

import { listConversations, updateConversation } from "../db/index.js";
import {
  assertNoneRemote,
  isPublishedReadyForRepublish,
  removeRawCopyIfPresent,
} from "./common.js";
import { collectBareResetTargets, collectProjectResetTargets } from "./project-targets.js";
import { resolveConversationSelectors } from "./selectors.js";

export function buildResetCommand(): Command {
  return new Command("reset")
    .description("Unstage conversations back to discovered")
    .argument("[selectors...]")
    .action(async (selectors: string[]) => {
      const conversations =
        selectors.length > 0
          ? resolveConversationSelectors({
              commandName: "clog reset",
              tokens: selectors,
              idCandidates: await listConversations(),
              projectCandidates: await collectProjectResetTargets(),
            })
          : await collectBareResetTargets();

      if (conversations.length === 0) {
        const published = await listConversations({ states: ["published"], origin: "local" });
        let modifiedPublishedCount = 0;
        for (const conversation of published) {
          if (await isPublishedReadyForRepublish(conversation)) {
            modifiedPublishedCount += 1;
          }
        }

        if (modifiedPublishedCount > 0) {
          process.stdout.write(
            `No added conversations to reset. ${modifiedPublishedCount} published conversation(s) still have unpublished changes; use "clog publish" to publish them.\n`,
          );
          return;
        }

        process.stdout.write('No staged conversations. Use "clog add <id>" to stage conversations first.\n');
        return;
      }

      assertNoneRemote(conversations, "clog reset");

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
