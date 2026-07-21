import { Command, type ErrorOptions } from "commander";

import { loadConfig } from "../config/index.js";
import type { ConversationMeta } from "../models/conversation.js";
import {
  applyHeadTail,
  formatForSingleLine,
  getScanWarningsForCommand,
  parseConversationMessages,
  renderMessages,
  renderWarnings,
  resolveContentPath,
} from "./common.js";
import { resolveConversationView } from "../conversations/view.js";
import { scanLocalSources } from "./scan.js";
import { UsageError } from "../utils/errors.js";
import {
  buildConversationExport,
  readConversationRaw,
  renderConversationMarkdown,
  serializeConversationJson,
} from "./conversation-renderers.js";

interface ShowOptions {
  path?: boolean;
  json?: boolean;
  md?: boolean;
  raw?: boolean;
  head?: string;
  tail?: string;
}

type ShowFormat = "default" | "json" | "md" | "raw";

class ShowCommand extends Command {
  override error(message: string, errorOptions?: ErrorOptions): never {
    if (errorOptions?.code === "commander.optionMissingArgument") {
      throw new UsageError(message.replace(/^error:\s*/, ""));
    }

    return super.error(message, errorOptions);
  }
}

export function buildShowCommand(): Command {
  return new ShowCommand("show")
    .description("Display a conversation's content and metadata")
    .argument("<id>")
    .option("--path", "Print the resolved conversation content path")
    .option("--json", "Render the conversation as structured JSON")
    .option("--md", "Render the conversation as Markdown")
    .option("--raw", "Emit the exact resolved conversation content bytes")
    .option("--first, --head <n>", "Render the first N parsed messages")
    .option("--last, --tail <n>", "Render the last N parsed messages")
    .action(async (id: string, options: ShowOptions) => {
      if (id.startsWith("project:")) {
        throw new UsageError(
          `This command only accepts conversation IDs. Project selectors like "${id}" are not allowed here.`,
        );
      }
      const { format, head, tail } = validateShowOptions(options);
      const config = await loadConfig();
      const scanSnapshot = await scanLocalSources(config);
      renderWarnings(getScanWarningsForCommand(scanSnapshot));
      const conversation = await resolveConversationView(id, { scanSnapshot });

      if (options.path) {
        process.stdout.write(`${resolveContentPath(conversation)}\n`);
        return;
      }

      if (format === "raw") {
        process.stdout.write(await readConversationRaw(conversation));
        return;
      }

      const messages = await parseConversationMessages(config, conversation);
      const limited = applyHeadTail(messages, { head, tail });

      if (format === "json") {
        process.stdout.write(
          serializeConversationJson(buildConversationExport(conversation, limited)),
        );
        return;
      }

      if (format === "md") {
        process.stdout.write(renderConversationMarkdown(conversation, limited));
        return;
      }

      process.stdout.write(
        `ID:      ${conversation.id.slice(0, 8)}\nSource:  ${conversation.source}\nTitle:   ${formatForSingleLine(conversation.title)}\nProject: ${conversation.projectName ?? "-"}\nState:   ${conversation.state}\n`,
      );
      process.stdout.write(renderSummaryBlock(conversation));
      process.stdout.write("\n");
      process.stdout.write(`${renderMessages(limited, { colorUserMessages: true })}\n`);
    });
}

function validateShowOptions(options: ShowOptions): {
  format: ShowFormat;
  head?: number;
  tail?: number;
} {
  const requestedFormats: ShowFormat[] = [];
  if (options.json) requestedFormats.push("json");
  if (options.md) requestedFormats.push("md");
  if (options.raw) requestedFormats.push("raw");

  if (requestedFormats.length > 1) {
    throw new UsageError("--json, --md, and --raw are mutually exclusive.");
  }

  const format = requestedFormats[0] ?? "default";
  const head = parseCount(options.head);
  const tail = parseCount(options.tail);

  if (head != null && tail != null) {
    throw new UsageError(
      "Cannot combine --head/--first with --tail/--last.",
    );
  }

  const hasMessageWindow = head != null || tail != null;
  if (options.path && (format !== "default" || hasMessageWindow)) {
    throw new UsageError(
      "--path cannot be combined with render formats or message-window options.",
    );
  }

  if (format === "raw" && hasMessageWindow) {
    throw new UsageError(
      "--raw cannot be combined with message-window options.",
    );
  }

  return { format, head, tail };
}

function renderSummaryBlock(conversation: ConversationMeta): string {
  const lines: string[] = [];
  if (conversation.summary.trim()) {
    lines.push(`Summary: ${formatForSingleLine(conversation.summary)} (${conversation.summaryKind})`);
  }

  const extraction = conversation.summaryExtraction;
  if (extraction) {
    if (extraction.topics && extraction.topics.length > 0) {
      lines.push(`Topics:  ${extraction.topics.join(", ")}`);
    }
    if (extraction.outcome) {
      lines.push(`Outcome: ${extraction.outcome}`);
    }
    if (extraction.toolsUsed && extraction.toolsUsed.length > 0) {
      lines.push(`Tools:   ${extraction.toolsUsed.join(", ")}`);
    }
    if (extraction.notableMoments && extraction.notableMoments.length > 0) {
      lines.push(
        `Notable: ${extraction.notableMoments.length} moment${extraction.notableMoments.length === 1 ? "" : "s"}`,
      );
    }
  }

  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

function parseCount(value?: string): number | undefined {
  if (value == null) {
    return undefined;
  }

  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new UsageError("Message count must be a positive integer.");
  }

  return parsed;
}
