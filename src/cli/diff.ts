import { Command } from "commander";

import { loadConfig } from "../config/index.js";
import type { ConversationMeta } from "../models/conversation.js";
import { ClogError } from "../utils/errors.js";
import { listConversations } from "../db/index.js";
import {
  applyHeadTail,
  getSaveCandidate,
  parseConversationMessages,
  parseConversationMessagesFromPath,
  renderMessages,
  resolveManyConversationsOrFail,
} from "./common.js";

export function buildDiffCommand(): Command {
  return new Command("diff")
    .description("Show new messages since last save")
    .argument("[ids...]")
    .option("--staged")
    .option("--head <n>")
    .option("--tail <n>")
    .option("--first <n>")
    .option("--last <n>")
    .action(async (ids: string[], options) => {
      const config = await loadConfig();
      const conversations =
        ids.length > 0
          ? await resolveManyConversationsOrFail(ids)
          : await listConversations({
              states: options.staged ? ["staged"] : ["saved"],
            });

      const head = parseCount(options.head ?? options.first);
      const tail = parseCount(options.tail ?? options.last);

      for (const conversation of conversations) {
        validateDiffTarget(conversation, options.staged);

        const messages = options.staged
          ? await parseConversationMessages(config, conversation)
          : await loadDiffCandidateMessages(config, conversation);
        const diffMessages = options.staged
          ? messages
          : messages.slice(conversation.savedMessageCount ?? 0);

        if (
          !options.staged &&
          conversation.savedMessageCount != null &&
          messages.length < conversation.savedMessageCount
        ) {
          throw new Error(
            `Conversation ${conversation.id.slice(0, 8)} has fewer parsed messages than its last saved checkpoint.`,
          );
        }

        const limited = applyHeadTail(diffMessages, { head, tail });

        if (limited.length === 0) {
          continue;
        }

        const truncationNote =
          limited.length !== diffMessages.length
            ? `, showing ${limited.length} of ${diffMessages.length} new message${diffMessages.length === 1 ? "" : "s"}`
            : "";

        process.stdout.write(
          `--- ${conversation.id.slice(0, 8)} "${conversation.title}" (${diffMessages.length} new message${diffMessages.length === 1 ? "" : "s"} since v${conversation.saveVersion}${truncationNote})\n`,
        );
        process.stdout.write(`${renderMessages(limited)}\n\n`);
      }
    });
}

function parseCount(value?: string): number | undefined {
  if (value == null) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ClogError("Message count must be a positive integer.");
  }

  return parsed;
}

function validateDiffTarget(conversation: ConversationMeta, stagedMode: boolean): void {
  if (stagedMode) {
    if (conversation.state !== "staged") {
      throw new ClogError(
        `Conversation ${conversation.id.slice(0, 8)} is not staged. Use "clog diff" for saved conversations.`,
      );
    }
    return;
  }

  if (conversation.state !== "saved") {
    throw new ClogError(
      `Conversation ${conversation.id.slice(0, 8)} is not saved. Use "clog diff --staged" for staged conversations.`,
    );
  }
}

async function loadDiffCandidateMessages(
  config: Awaited<ReturnType<typeof loadConfig>>,
  conversation: Awaited<ReturnType<typeof resolveManyConversationsOrFail>>[number],
) {
  const candidate = await getSaveCandidate(conversation);

  if (candidate.path === conversation.filePath) {
    return parseConversationMessages(config, conversation);
  }

  return parseConversationMessagesFromPath(config, conversation.source, candidate.path);
}
