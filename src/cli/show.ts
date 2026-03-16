import chalk from "chalk";
import { withDb } from "../db/index.js";
import { ClaudeCodeAdapter } from "../adapters/claude-code.js";
import { stateColors } from "./colors.js";
import { resolveLimit, applyLimit } from "./diff.js";
import { resolveContentPath } from "../sync/resolve-content-path.js";
import type { Message } from "../models/conversation.js";

export interface ShowOpts {
  path?: boolean;
  head?: number;
  first?: number;
  tail?: number;
  last?: number;
}

export async function showCommand(
  id: string,
  opts: ShowOpts
): Promise<void> {
  const conv = await withDb((ctx) => {
    const fullId = ctx.resolveId(id);
    const conversation = ctx.getConversation(fullId);
    if (!conversation) {
      throw new Error(`Conversation not found: ${fullId}. Run \`clog list --all\` to see available IDs.`);
    }
    return conversation;
  });

  const resolvedPath = resolveContentPath(conv);

  // --path flag: just print the file path and return
  if (opts.path) {
    console.log(resolvedPath);
    return;
  }

  // Print metadata header
  console.log(chalk.bold.white("Title:   ") + conv.title);
  console.log(chalk.bold.white("ID:      ") + conv.id);
  console.log(chalk.bold.white("State:   ") + formatState(conv.state));
  if (conv.project) {
    console.log(chalk.bold.white("Project: ") + conv.project);
  }
  if (conv.author) {
    console.log(chalk.bold.white("Author:  ") + conv.author);
  }
  if (conv.tags.length > 0) {
    console.log(
      chalk.bold.white("Tags:    ") +
        conv.tags.map((t) => chalk.yellow(t)).join(", ")
    );
  }
  console.log(chalk.bold.white("Created: ") + conv.createdAt);
  if (conv.summary) {
    console.log(chalk.bold.white("Summary: ") + conv.summary);
  }
  console.log("");

  // Parse and display messages
  const adapter = new ClaudeCodeAdapter([]);
  const messages = await adapter.parseMessages(resolvedPath);
  const limit = resolveLimit(opts);
  const display = applyLimit(messages, limit);

  if (display.length < messages.length) {
    console.log(chalk.dim(`showing ${display.length} of ${messages.length} messages`));
    console.log("");
  }

  printMessages(display);
}

export function printMessages(messages: Message[]): void {
  for (const msg of messages) {
    switch (msg.role) {
      case "user":
        console.log(chalk.blue.bold("You: ") + msg.content);
        break;
      case "assistant":
        console.log(chalk.bold("Assistant: ") + msg.content);
        break;
      case "tool_use":
        console.log(
          chalk.dim.gray("Tool: ") +
            chalk.dim(msg.content)
        );
        break;
      case "tool_result": {
        const truncated =
          msg.content.length > 200
            ? msg.content.slice(0, 200) + "..."
            : msg.content;
        console.log(chalk.dim("Result: ") + chalk.dim(truncated));
        break;
      }
    }
    console.log("");
  }
}

function formatState(state: string): string {
  const colorFn = stateColors[state as keyof typeof stateColors];
  return colorFn ? colorFn(state) : state;
}
