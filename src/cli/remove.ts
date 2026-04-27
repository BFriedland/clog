import { Command } from "commander";

import { deleteConversation, listConversations } from "../db/index.js";
import { tryDeleteConversationVectors } from "../search/coherence.js";
import { ClogError, UsageError } from "../utils/errors.js";
import { removeRawCopyIfPresent } from "./common.js";
import { conversationMatchesAnyClogIgnoreRule, isRecognizedClogIgnoreRule } from "./clogignore.js";

export function buildRemoveCommand(): Command {
  return new Command("remove")
    .description("Remove currently matching conversations from clog's database")
    .argument("<rules...>")
    .action(async (rules: string[]) => {
      assertValidLiteralRules(rules);

      const matches = (await listConversations()).filter((conversation) =>
        conversationMatchesAnyClogIgnoreRule(conversation, rules),
      );

      if (matches.length === 0) {
        process.stdout.write("No conversations in clog's database match those rules.\n");
        return;
      }

      for (const conversation of matches) {
        if (conversation.origin == null) {
          await removeRawCopyIfPresent(conversation);
        }
        await deleteConversation(conversation.id);
      }

      const failures = await tryDeleteConversationVectors(matches.map((conversation) => conversation.id));
      for (const failedId of failures) {
        process.stderr.write(
          `warning: ${failedId.slice(0, 7)} was removed but its search vectors could not be deleted\n`,
        );
      }

      process.stdout.write(
        `Removed ${matches.length} conversation${matches.length === 1 ? "" : "s"} from clog's database.\n`,
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
        `clog remove does not accept project selectors like "${rule}". Pass a stored ignore-rule shape such as a simple name, filename, ID, or path instead.`,
      );
    }

    if (!isRecognizedClogIgnoreRule(rule)) {
      throw new UsageError(
        `clog remove does not accept unsupported ignore-rule syntax like "${rule}". Pass a simple name, filename, ID, or path instead.`,
      );
    }
  }
}
