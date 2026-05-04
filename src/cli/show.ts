import { Command } from "commander";

import { loadConfig } from "../config/index.js";
import { applyHeadTail, formatForSingleLine, parseConversationMessages, renderMessages, resolveConversationOrFail, resolveContentPath } from "./common.js";
import { ClogError } from "../utils/errors.js";

export function buildShowCommand(): Command {
  return new Command("show")
    .description("Display a conversation's content and metadata")
    .argument("<id>")
    .option("--path")
    .option("--head <n>")
    .option("--tail <n>")
    .option("--first <n>")
    .option("--last <n>")
    .action(async (id: string, options) => {
      const conversation = await resolveConversationOrFail(id);

      if (options.path) {
        process.stdout.write(`${resolveContentPath(conversation)}\n`);
        return;
      }

      const config = await loadConfig();
      const messages = await parseConversationMessages(config, conversation);
      const head = parseCount(options.head ?? options.first);
      const tail = parseCount(options.tail ?? options.last);
      const limited = applyHeadTail(messages, { head, tail });

      process.stdout.write(
        `ID:      ${conversation.id.slice(0, 8)}\nSource:  ${conversation.source}\nTitle:   ${formatForSingleLine(conversation.title)}\nProject: ${conversation.projectName ?? "-"}\nState:   ${conversation.state}\n\n`,
      );
      process.stdout.write(`${renderMessages(limited, { colorUserMessages: true })}\n`);
    });
}

function parseCount(value?: string): number | undefined {
  if (value == null) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ClogError("Message count must be a positive integer.");
  }

  return parsed;
}
