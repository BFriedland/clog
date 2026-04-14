import { Command } from "commander";

import { deleteConversation } from "../db/index.js";
import { tryDeleteConversationVectors } from "../search/coherence.js";
import { removeRawCopyIfPresent, resolveManyConversationsOrFail } from "./common.js";
import {
  addExcludedEntry,
  readExcludedEntriesForMutation,
  writeExcludedEntries,
} from "./excluded.js";

export function buildExcludeCommand(): Command {
  return new Command("exclude")
    .description("Delete conversations and block rediscovery")
    .argument("<ids...>")
    .action(async (ids: string[]) => {
      const { entries } = await readExcludedEntriesForMutation();

      const conversations = await resolveManyConversationsOrFail(ids);

      for (const conversation of conversations) {
        await removeRawCopyIfPresent(conversation);
        await deleteConversation(conversation.id);
        const next = addExcludedEntry(entries, conversation.sourceId, conversation.source);
        entries.splice(0, entries.length, ...next);
      }

      const failures = await tryDeleteConversationVectors(conversations.map((conversation) => conversation.id));
      for (const failedId of failures) {
        process.stderr.write(
          `warning: ${failedId.slice(0, 7)} was excluded but its search vectors could not be deleted\n`,
        );
      }

      await writeExcludedEntries(entries);
      process.stdout.write(`Excluded ${ids.length} conversation(s)\n`);
    });
}
