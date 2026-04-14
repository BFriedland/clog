import { Command } from "commander";

import { nowIso } from "../utils/time.js";
import { updateConversation } from "../db/index.js";
import { assertNotRemote, resolveConversationOrFail } from "./common.js";

export function buildTagCommand(): Command {
  return new Command("tag")
    .description("Add tags to a conversation")
    .argument("<id>")
    .argument("<tags...>")
    .action(async (id: string, tags: string[]) => {
      const conversation = await resolveConversationOrFail(id);
      assertNotRemote(conversation, "clog tag");
      const nextTags = [...new Set([...conversation.tags, ...normalizeTags(tags)])];

      if (nextTags.length === conversation.tags.length) {
        process.stdout.write("No new tags were added.\n");
        return;
      }

      await updateConversation({
        ...conversation,
        tags: nextTags,
        modifiedAt: nowIso(),
      });
    });
}

export function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
}
