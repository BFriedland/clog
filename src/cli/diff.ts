import chalk from "chalk";
import { withDb } from "../db/index.js";
import { ClaudeCodeAdapter } from "../adapters/claude-code.js";
import { printMessages, getFilePath } from "./show.js";
import type { Message } from "../models/conversation.js";

export interface DiffOpts {
  staged?: boolean;
  head?: number;
  first?: number;
  tail?: number;
  last?: number;
}

export function resolveLimit(opts: { head?: number; first?: number; tail?: number; last?: number }): { head?: number; tail?: number } {
  const head = opts.head ?? opts.first;
  const tail = opts.tail ?? opts.last;
  if (head != null && tail != null) {
    throw new Error("Cannot use --head/--first and --tail/--last together.");
  }
  if (head != null && (isNaN(head) || head < 0)) {
    throw new Error("--head/--first must be a non-negative integer.");
  }
  if (tail != null && (isNaN(tail) || tail < 0)) {
    throw new Error("--tail/--last must be a non-negative integer.");
  }
  return { head, tail };
}

export function applyLimit(messages: Message[], limit: { head?: number; tail?: number }): Message[] {
  if (limit.head != null) return messages.slice(0, limit.head);
  if (limit.tail != null && limit.tail > 0) return messages.slice(-limit.tail);
  if (limit.tail === 0) return [];
  return messages;
}

export async function diffCommand(
  ids: string[],
  opts: DiffOpts
): Promise<void> {
  const limit = resolveLimit(opts);
  if (opts.staged) {
    await diffStaged(ids, limit);
  } else {
    await diffModified(ids, limit);
  }
}

async function diffModified(ids: string[], limit: { head?: number; tail?: number }): Promise<void> {
  const conversations = await withDb((ctx) => {
    if (ids.length > 0) {
      return ids.map((id) => {
        const fullId = ctx.resolveId(id);
        const conv = ctx.getConversation(fullId);
        if (!conv) throw new Error(`Conversation not found: ${id}`);
        if (conv.state !== "published") {
          throw new Error(
            `Conversation ${id} is ${conv.state}, not published. Use --staged for staged conversations.`
          );
        }
        return conv;
      });
    }
    return ctx.listModifiedSincePublish();
  });

  if (conversations.length === 0) return;

  const adapter = new ClaudeCodeAdapter([]);
  let first = true;

  for (const conv of conversations) {
    const filePath = getFilePath(conv);
    const allMessages = await adapter.parseMessages(filePath);

    // Filter to messages after publishedAt
    const newMessages = conv.publishedAt
      ? allMessages.filter(
          (m) => m.timestamp != null && m.timestamp > conv.publishedAt!
        )
      : allMessages;

    if (newMessages.length === 0) continue;

    const display = applyLimit(newMessages, limit);

    if (!first) console.log("---\n");
    first = false;

    const shortId = conv.id.slice(0, 7);
    const total = newMessages.length;
    const countNote = display.length < total
      ? `showing ${display.length} of ${total} new messages since v${conv.publishVersion}`
      : `${total} new message${total === 1 ? "" : "s"} since v${conv.publishVersion}`;
    console.log(chalk.bold(`--- ${shortId} "${conv.title}" (${countNote})`));
    console.log("");
    printMessages(display);
  }
}

async function diffStaged(ids: string[], limit: { head?: number; tail?: number }): Promise<void> {
  const conversations = await withDb((ctx) => {
    if (ids.length > 0) {
      return ids.map((id) => {
        const fullId = ctx.resolveId(id);
        const conv = ctx.getConversation(fullId);
        if (!conv) throw new Error(`Conversation not found: ${id}`);
        if (conv.state !== "staged") {
          throw new Error(
            `Conversation ${id} is ${conv.state}, not staged.`
          );
        }
        return conv;
      });
    }
    return ctx.listConversations({ state: "staged" });
  });

  if (conversations.length === 0) return;

  const adapter = new ClaudeCodeAdapter([]);
  let first = true;

  for (const conv of conversations) {
    const filePath = getFilePath(conv);
    const messages = await adapter.parseMessages(filePath);

    if (messages.length === 0) continue;

    const display = applyLimit(messages, limit);

    if (!first) console.log("---\n");
    first = false;

    const shortId = conv.id.slice(0, 7);
    const total = messages.length;
    const countNote = display.length < total
      ? `showing ${display.length} of ${total} messages`
      : `${total} message${total === 1 ? "" : "s"}`;
    console.log(chalk.bold(`--- ${shortId} "${conv.title}" (${countNote})`));
    console.log("");
    printMessages(display);
  }
}
