import { Command } from "commander";

import { listConversations, updateConversation } from "../db/index.js";
import {
  assertNoneRemote,
  isSavedReadyForResave,
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
        const saved = await listConversations({ states: ["saved"], origin: "local" });
        let modifiedSavedCount = 0;
        for (const conversation of saved) {
          if (await isSavedReadyForResave(conversation)) {
            modifiedSavedCount += 1;
          }
        }

        if (modifiedSavedCount > 0) {
          process.stdout.write(
            `No added conversations to reset. ${modifiedSavedCount} saved conversation(s) still have unsaved changes; use "clog save" to save them.\n`,
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
            `Conversation ${conversation.id.slice(0, 8)} is not staged. Use "clog add <id>" before resetting it.`,
          );
        }

        if (conversation.state === "saved") {
          throw new Error(`Conversation ${conversation.id} is saved. Use "clog unsave" first.`);
        }

        await removeRawCopyIfPresent(conversation);
        await updateConversation({
          ...conversation,
          state: "discovered",
          filePath: null,
          savedAt: null,
          savedMessageCount: null,
          saveVersion: 0,
        });
      }

      process.stdout.write(`Reset ${conversations.length} conversation(s)\n`);
    });
}
