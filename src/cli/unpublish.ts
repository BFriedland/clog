import { Command } from "commander";

import { listConversations, updateConversation } from "../db/index.js";
import { tryDeleteConversationVectors } from "../search/coherence.js";
import { assertNoneRemote } from "./common.js";
import { collectBareUnpublishTargets, collectProjectUnpublishTargets } from "./project-targets.js";
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
          : await collectBareUnpublishTargets();

      if (conversations.length === 0) {
        process.stdout.write('No published conversations. Use "clog publish" to publish conversations first.\n');
        return;
      }

      assertNoneRemote(conversations, "clog unpublish");

      const showProgress = process.stdout.isTTY && conversations.length > 1;

      for (const [index, conversation] of conversations.entries()) {
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

        if (showProgress) {
          process.stdout.write(
            `\r${index + 1}/${conversations.length} conversations unpublished locally...`,
          );
        }
      }

      if (showProgress) {
        process.stdout.write("\n");
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
          `warning: ${failedId.slice(0, 7)} was unpublished but its search vectors could not be deleted\n`,
        );
      }

      process.stdout.write(`Unpublished ${conversations.length} conversation(s) (moved to staging).\n`);
    });
}
