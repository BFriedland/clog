import { Command } from "commander";

import {
  readExcludedEntriesForMutation,
  removeExcludedEntryByPrefix,
  writeExcludedEntries,
} from "./excluded.js";

export function buildUnexcludeCommand(): Command {
  return new Command("unexclude")
    .description("Remove conversations from the excluded list")
    .argument("<ids...>")
    .action(async (ids: string[]) => {
      let { entries } = await readExcludedEntriesForMutation();

      for (const id of ids) {
        entries = removeExcludedEntryByPrefix(entries, id).entries;
      }

      await writeExcludedEntries(entries);
      process.stdout.write(`Unexcluded ${ids.length} conversation(s)\n`);
    });
}
