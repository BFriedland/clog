import chalk from "chalk";

import type { ConversationMeta } from "../models/conversation.js";

export function colorizeStateLabel(
  label: string,
  conversation: ConversationMeta,
): string {
  if (conversation.state === "discovered") {
    return chalk.red(label);
  }

  return label;
}

export function colorizeStatusLabel(
  label: string,
  tone: "ready" | "attention",
): string {
  return tone === "ready" ? chalk.green(label) : chalk.red(label);
}

export function dimText(value: string): string {
  return chalk.dim(value);
}

export function colorizeUserMessage(value: string): string {
  return chalk.hex("#8fa7b3")(value);
}
