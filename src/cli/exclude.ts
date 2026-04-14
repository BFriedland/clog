import { Command } from "commander";

import { deleteConversation } from "../db/index.js";
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

      for (const conversation of await resolveManyConversationsOrFail(ids)) {
        await removeRawCopyIfPresent(conversation);
        await deleteConversation(conversation.id);
        const next = addExcludedEntry(entries, conversation.sourceId, conversation.source);
        entries.splice(0, entries.length, ...next);
      }

      await writeExcludedEntries(entries);
      process.stdout.write(`Excluded ${ids.length} conversation(s)\n`);
    });
}
