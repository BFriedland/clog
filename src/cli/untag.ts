import { Command } from "commander";

import { nowIso } from "../utils/time.js";
import { updateLocalConversation } from "../db/index.js";
import { assertNotRemote, resolveConversationOrFail } from "./common.js";
import { normalizeTags } from "./tag.js";

export function buildUntagCommand(): Command {
  return new Command("untag")
    .description("Remove tags from a conversation")
    .argument("<id>")
    .argument("<tags...>")
    .action(async (id: string, tags: string[]) => {
      const conversation = await resolveConversationOrFail(id);
      assertNotRemote(conversation, "clog untag");
      if (conversation.state !== "saved") {
        throw new Error(
          `Conversation ${conversation.id.slice(0, 8)} is not saved. Use "clog save ${conversation.id.slice(0, 8)}" before editing tags.`,
        );
      }
      const remove = new Set(normalizeTags(tags));
      const nextTags = conversation.tags.filter((tag) => !remove.has(tag));

      if (nextTags.length === conversation.tags.length) {
        process.stdout.write("No matching tags were found.\n");
        return;
      }

      await updateLocalConversation({
        ...conversation,
        tags: nextTags,
        modifiedAt: nowIso(),
      }, { command: "clog untag" });
    });
}
