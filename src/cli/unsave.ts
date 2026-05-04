import { Command } from "commander";

import { listConversations, updateConversation } from "../db/index.js";
import { tryDeleteConversationVectors } from "../search/coherence.js";
import { searchAvailable } from "../search/deps.js";
import { assertNoneRemote } from "./common.js";
import { collectBareUnsaveTargets, collectProjectUnsaveTargets } from "./project-targets.js";
import { resolveConversationSelectors } from "./selectors.js";

export function buildUnsaveCommand(): Command {
  return new Command("unsave")
    .description("Move saved conversations back to staged")
    .argument("[selectors...]")
    .action(async (selectors: string[]) => {
      const conversations =
        selectors.length > 0
          ? resolveConversationSelectors({
              commandName: "clog unsave",
              tokens: selectors,
              idCandidates: await listConversations(),
              projectCandidates: await collectProjectUnsaveTargets(),
            })
          : await collectBareUnsaveTargets();

      if (conversations.length === 0) {
        process.stdout.write('No saved conversations. Use "clog save" to save conversations first.\n');
        return;
      }

      assertNoneRemote(conversations, "clog unsave");

      const showProgress = process.stdout.isTTY && conversations.length > 1;

      for (const [index, conversation] of conversations.entries()) {
        if (conversation.state !== "saved") {
          throw new Error(
            `Conversation ${conversation.id.slice(0, 8)} is not saved. Use "clog add <id>" to stage it first.`,
          );
        }

        await updateConversation({
          ...conversation,
          state: "staged",
          indexedAt: null,
        });

        if (showProgress) {
          process.stdout.write(
            `\r${index + 1}/${conversations.length} conversations unsaved locally...`,
          );
        }
      }

      if (showProgress) {
        process.stdout.write("\n");
      }

      if (showProgress && (await searchAvailable())) {
        process.stdout.write("Removing conversations from vector search. Safe to interrupt.\n");
      }

      const failures = await tryDeleteConversationVectors(
        conversations.map((conversation) => conversation.id),
        showProgress
          ? (completed, total) => {
              process.stdout.write(`\r${completed}/${total} conversations removed from vector search...`);
              if (completed === total) {
                process.stdout.write("\n");
              }
            }
          : undefined,
      );
      for (const failedId of failures) {
        process.stderr.write(
          `warning: ${failedId.slice(0, 8)} was unsaved but its search vectors could not be deleted\n`,
        );
      }

      process.stdout.write(`Unsaved ${conversations.length} conversation(s) (moved to staging).\n`);
    });
}
