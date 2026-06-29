import { Command } from "commander";

import type { ConversationMeta } from "../models/conversation.js";
import { nowIso } from "../utils/time.js";
import { updateLocalConversation } from "../db/index.js";
import { maybeReindexUpdatedConversation } from "../search/coherence.js";
import { assertNotRemote, resolveConversationOrFail } from "./common.js";

export function buildEditCommand(): Command {
  const command = new Command("edit")
    .description("Edit conversation metadata")
    .argument("<id>")
    .option("--title <text>")
    .option("--summary <text>")
    .option("--author <name>")
    .action(async (id: string, options, actionCommand: Command) => {
      if (
        options.title === undefined &&
        options.summary === undefined &&
        options.author === undefined
      ) {
        process.stdout.write(actionCommand.helpInformation());
        return;
      }

      const conversation = await resolveConversationOrFail(id);
      assertNotRemote(conversation, "clog edit");
      if (conversation.state !== "saved") {
        throw new Error(
          `Conversation ${conversation.id.slice(0, 8)} is not saved. Use "clog save ${conversation.id.slice(0, 8)}" before editing metadata.`,
        );
      }
      const summaryProvided = options.summary !== undefined;
      const nextSummary = options.summary ?? conversation.summary;
      const updated: ConversationMeta = {
        ...conversation,
        title: options.title ?? conversation.title,
        summary: nextSummary,
        author: options.author ?? conversation.author,
      };

      if (summaryProvided) {
        // Passing --summary at all is the curation gesture, even if the text
        // happens to match what was already there: the user is claiming this
        // exact summary as their curated choice. Clearing ("--summary ''")
        // resets summaryKind to 'none' and drops the structured extraction
        // so the conversation looks unsummarized again. No-op behavior is
        // then decided from the resulting metadata below.
        if (updated.summary.trim()) {
          updated.summaryKind = "curated";
        } else {
          updated.summaryKind = "none";
          updated.summaryExtraction = null;
        }
      }

      const changed =
        updated.title !== conversation.title ||
        updated.summary !== conversation.summary ||
        updated.author !== conversation.author ||
        updated.summaryKind !== conversation.summaryKind ||
        updated.summaryExtraction !== conversation.summaryExtraction;

      if (!changed) {
        process.stdout.write("Nothing changed.\n");
        return;
      }

      let nextConversation: ConversationMeta = {
        ...updated,
        modifiedAt: nowIso(),
      };

      if (
        conversation.state === "saved" &&
        (
          updated.title !== conversation.title ||
          updated.summary !== conversation.summary
        )
      ) {
        nextConversation = await maybeReindexUpdatedConversation(nextConversation);
      }

      await updateLocalConversation(nextConversation, { command: "clog edit" });
      process.stdout.write(`Updated ${conversation.id.slice(0, 8)}\n`);
    });

  return command;
}
