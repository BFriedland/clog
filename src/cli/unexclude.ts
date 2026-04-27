import { Command } from "commander";

import { getClogIgnorePath } from "../utils/paths.js";
import { removeExactClogIgnoreRules } from "./clogignore.js";

export function buildUnexcludeCommand(): Command {
  return new Command("unexclude")
    .description("Remove exact ignore rules from clogignore")
    .argument("<rules...>")
    .action(async (rules: string[]) => {
      const clogIgnorePath = getClogIgnorePath();
      const result = await removeExactClogIgnoreRules(rules);

      if (!result.changed) {
        process.stdout.write(`No matching ignore rules were removed from ${clogIgnorePath}.\n`);
        return;
      }

      for (const rule of [...new Set(result.removed)]) {
        process.stdout.write(`Removed ignore rule from ${clogIgnorePath}:\n  ${rule}\n`);
      }
    });
}
