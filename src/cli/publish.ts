import { Command } from "commander";

import { loadConfig } from "../config/index.js";
import { listConversations, updateConversation } from "../db/index.js";
import type { ConversationMeta } from "../models/conversation.js";
import { maybeAutoIndexConversations } from "../search/coherence.js";
import { nowIso } from "../utils/time.js";
import {
  assertNoneRemote,
  defaultPublishFilePath,
  ensureRawCopy,
  getPublishCandidate,
  parseConversationMessages,
  parseConversationMessagesFromPath,
} from "./common.js";
import { collectBarePublishTargets, collectProjectPublishTargets } from "./project-targets.js";
import { resolveConversationSelectors } from "./selectors.js";

export function buildPublishCommand(): Command {
  return new Command("publish")
    .description("Publish conversations")
    .argument("[selectors...]")
    .action(async (selectors: string[]) => {
      const config = await loadConfig();
      const conversations =
        selectors.length > 0
          ? resolveConversationSelectors({
              commandName: "clog publish",
              tokens: selectors,
              idCandidates: await listConversations(),
              projectCandidates: await collectProjectPublishTargets(),
            })
          : await collectBarePublishTargets();

      if (conversations.length === 0) {
        process.stdout.write('No staged conversations. Use "clog add <id>" to stage conversations first.\n');
        return;
      }

      assertNoneRemote(conversations, "clog publish");

      const publishedConversations: ConversationMeta[] = [];
      const showProgress = process.stdout.isTTY && conversations.length > 1;

      for (const [index, conversation] of conversations.entries()) {
        if (
          selectors.length > 0 &&
          conversation.state !== "discovered" &&
          conversation.state !== "staged" &&
          conversation.state !== "published"
        ) {
          throw new Error(`Conversation ${conversation.id} is not publishable.`);
        }

        const candidate = await getPublishCandidate(conversation);
        const rawPath =
          conversation.state === "discovered" || !conversation.filePath
            ? defaultPublishFilePath(conversation)
            : conversation.filePath;

        if (candidate.shouldRefreshRawCopy) {
          await ensureRawCopy(conversation);
        }

        const parsePath =
          candidate.shouldRefreshRawCopy && conversation.state === "discovered"
            ? rawPath
            : candidate.shouldRefreshRawCopy
              ? rawPath
              : candidate.path;

        const messages =
          parsePath === resolveFilePathOrFallback(conversation, rawPath)
            ? await parseConversationMessages(config, {
                ...conversation,
                filePath: parsePath,
                state: conversation.state === "discovered" ? "staged" : conversation.state,
              })
            : await parseConversationMessagesFromPath(config, conversation.source, parsePath);
        const timestamp = nowIso();

        const publishedConversation = {
          ...conversation,
          filePath: rawPath,
          state: "published" as const,
          publishVersion: conversation.publishVersion + 1,
          publishedAt: timestamp,
          modifiedAt: timestamp,
          publishedMessageCount: messages.length,
          indexedAt: null,
        };

        await updateConversation(publishedConversation);
        publishedConversations.push(publishedConversation);

        if (showProgress) {
          process.stdout.write(
            `\r${index + 1}/${conversations.length} conversations published locally...`,
          );
        }
      }

      if (showProgress) {
        process.stdout.write("\n");
      }

      const indexedFailures = await maybeAutoIndexConversations(
        publishedConversations,
        showProgress
          ? (completed, total) => {
              process.stdout.write(`\r${completed}/${total} conversations indexed for vector search...`);
              if (completed === total) {
                process.stdout.write("\n");
              }
            }
          : undefined,
      );

      for (const failedId of indexedFailures) {
        process.stderr.write(
          `warning: published ${failedId.slice(0, 7)} but failed to index it for search\n`,
        );
      }

      process.stdout.write(`Published ${conversations.length} conversation(s).\n`);
    });
}

function resolveFilePathOrFallback(
  conversation: { filePath: string | null },
  fallback: string,
): string {
  return conversation.filePath ?? fallback;
}
