import { Command } from "commander";

import { listConversations } from "../db/index.js";
import { ClogError, UsageError } from "../utils/errors.js";
import { getClogIgnorePath } from "../utils/paths.js";
import {
  appendClogIgnoreRules,
  conversationMatchesAnyClogIgnoreRule,
  isRecognizedClogIgnoreRule,
} from "./clogignore.js";

export function buildExcludeCommand(): Command {
  return new Command("exclude")
    .description("Append literal ignore rules to clogignore")
    .argument("<rules...>")
    .action(async (rules: string[]) => {
      assertValidLiteralRules(rules);
      await appendClogIgnoreRules(rules);

      const clogIgnorePath = getClogIgnorePath();
      for (const rule of rules) {
        process.stdout.write(`Added ignore rule to ${clogIgnorePath}:\n  ${rule}\n`);
      }

      const conversations = await listConversations();
      const matched = conversations.filter((conversation) =>
        conversationMatchesAnyClogIgnoreRule(conversation, rules),
      );

      if (matched.length === 0) {
        return;
      }

      process.stdout.write(
        `\n${matched.length} conversation${matched.length === 1 ? "" : "s"} currently in clog's database match ${
          matched.length === 1 ? "this rule" : "these rules"
        }.\n`,
      );
      process.stdout.write(
        `Use 'clog remove ${rules.join(" ")}' to remove them from clog's database.\n`,
      );
    });
}

function assertValidLiteralRules(rules: string[]): void {
  for (const rule of rules) {
    if (rule.trim().length === 0) {
      throw new ClogError("Ignore rules cannot be blank.");
    }

    if (rule.startsWith("project:")) {
      throw new UsageError(
        `clog exclude does not accept project selectors like "${rule}". Pass a stored ignore-rule shape such as a simple name, filename, ID, or path instead.`,
      );
    }

    if (!isRecognizedClogIgnoreRule(rule)) {
      throw new UsageError(
        `clog exclude does not accept unsupported ignore-rule syntax like "${rule}". Pass a simple name, filename, ID, or path instead.`,
      );
    }
  }
}
