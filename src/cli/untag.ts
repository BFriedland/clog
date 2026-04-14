import { Command } from "commander";

import { nowIso } from "../utils/time.js";
import { updateConversation } from "../db/index.js";
import { resolveConversationOrFail } from "./common.js";
import { normalizeTags } from "./tag.js";

export function buildUntagCommand(): Command {
  return new Command("untag")
    .description("Remove tags from a conversation")
    .argument("<id>")
    .argument("<tags...>")
    .action(async (id: string, tags: string[]) => {
      const conversation = await resolveConversationOrFail(id);
      const remove = new Set(normalizeTags(tags));
      const nextTags = conversation.tags.filter((tag) => !remove.has(tag));

      if (nextTags.length === conversation.tags.length) {
        process.stdout.write("No matching tags were found.\n");
        return;
      }

      await updateConversation({
        ...conversation,
        tags: nextTags,
        modifiedAt: nowIso(),
      });
    });
}
