import { Command } from "commander";

import type { ConversationMeta } from "../models/conversation.js";
import { nowIso } from "../utils/time.js";
import { updateConversation } from "../db/index.js";
import { maybeReindexUpdatedConversation } from "../search/coherence.js";
import { resolveConversationOrFail } from "./common.js";

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
      const updated = {
        ...conversation,
        title: options.title ?? conversation.title,
        summary: options.summary ?? conversation.summary,
        author: options.author ?? conversation.author,
      };

      const changed =
        updated.title !== conversation.title ||
        updated.summary !== conversation.summary ||
        updated.author !== conversation.author;

      if (!changed) {
        process.stdout.write("Nothing changed.\n");
        return;
      }

      let nextConversation: ConversationMeta = {
        ...updated,
        modifiedAt: nowIso(),
      };

      if (
        conversation.state === "published" &&
        (
          updated.title !== conversation.title ||
          updated.summary !== conversation.summary
        )
      ) {
        nextConversation = await maybeReindexUpdatedConversation(nextConversation);
      }

      await updateConversation(nextConversation);
      process.stdout.write(`Updated ${conversation.id.slice(0, 7)}\n`);
    });

  return command;
}
