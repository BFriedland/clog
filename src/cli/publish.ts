import { Command } from "commander";

import { loadConfig } from "../config/index.js";
import { listConversations, updateConversation } from "../db/index.js";
import type { ConversationMeta } from "../models/conversation.js";
import { maybeAutoIndexConversations } from "../search/coherence.js";
import { nowIso } from "../utils/time.js";
import {
  defaultPublishFilePath,
  ensureRawCopy,
  getPublishCandidate,
  parseConversationMessages,
  parseConversationMessagesFromPath,
  resolveManyConversationsOrFail,
} from "./common.js";

export function buildPublishCommand(): Command {
  return new Command("publish")
    .description("Publish conversations")
    .argument("[ids...]")
    .action(async (ids: string[]) => {
      const config = await loadConfig();
      const conversations =
        ids.length > 0
          ? await resolveManyConversationsOrFail(ids)
          : await listConversations({ states: ["staged"] });

      if (conversations.length === 0) {
        process.stdout.write('No staged conversations. Use "clog add <id>" to stage conversations first.\n');
        return;
      }

      const publishedConversations: ConversationMeta[] = [];

      for (const conversation of conversations) {
        if (ids.length > 0 && conversation.state !== "discovered" && conversation.state !== "staged" && conversation.state !== "published") {
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
      }

      const indexedFailures = await maybeAutoIndexConversations(publishedConversations);

      for (const failedId of indexedFailures) {
        process.stderr.write(
          `warning: published ${failedId.slice(0, 7)} but failed to index it for search\n`,
        );
      }

      process.stdout.write(`Published ${conversations.length} conversation(s)\n`);
    });
}

function resolveFilePathOrFallback(
  conversation: { filePath: string | null },
  fallback: string,
): string {
  return conversation.filePath ?? fallback;
}
