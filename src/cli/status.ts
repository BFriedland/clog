import path from "node:path";
import { scanSources } from "./scan.js";
import { withDb } from "../db/index.js";
import { stateColors } from "./colors.js";
import type { ConversationMeta } from "../models/conversation.js";

export async function statusCommand(): Promise<void> {
  const scanCounts = await scanSources();

  const { staged, modified, discovered } = await withDb((ctx) => ({
    staged: ctx.listConversations({ state: "staged" }),
    modified: ctx.listModifiedSincePublish(),
    discovered: ctx.listConversations({ state: "discovered" }),
  }));

  const termWidth = process.stdout.columns || 80;

  if (staged.length > 0) {
    console.log("Conversations to be published:");
    console.log('  (use "clog reset <id>" to unstage)');
    for (const conv of staged) {
      const line = formatRow("added", conv, termWidth);
      console.log(stateColors.staged(line));
    }
    console.log("");
  }

  if (modified.length > 0) {
    console.log("Changes not staged for publishing:");
    console.log('  (use "clog publish <id>" to update the published version)');
    for (const conv of modified) {
      const line = formatRow("modified", conv, termWidth);
      console.log(stateColors.modified(line));
    }
    console.log("");
  }

  if (discovered.length > 0) {
    console.log("Conversations not staged for publishing:");
    console.log('  (use "clog add <id>" to stage for publishing)');
    for (const conv of discovered) {
      const line = formatRow("discovered", conv, termWidth);
      console.log(stateColors.discovered(line));
    }
    console.log("");
  }

  if (staged.length === 0 && modified.length === 0 && discovered.length === 0) {
    console.log("nothing to publish, working tree clean");
  }

  // Show filter summary if anything was filtered
  const parts: string[] = [];
  if (scanCounts.excluded > 0) parts.push(`${scanCounts.excluded} excluded`);
  if (scanCounts.filtered > 0) parts.push(`${scanCounts.filtered} filtered by config`);
  if (scanCounts.ignored > 0) parts.push(`${scanCounts.ignored} ignored by clogignore`);
  if (parts.length > 0) {
    console.log(`(${parts.join(", ")})`);
  }
}

function formatRow(
  label: string,
  conv: ConversationMeta,
  termWidth: number
): string {
  const shortId = conv.id.slice(0, 7);
  const date = conv.createdAt.slice(0, 10);
  const project = conv.project ? path.basename(conv.project) : "";
  const prefix = `    ${pad(label + ":", 15)}${pad(shortId, 9)}${pad(date, 12)}${pad(project, 17)}`;
  const titleWidth = Math.max(1, termWidth - prefix.length);
  const title = conv.title.replace(/[\r\n]+/g, " ").slice(0, titleWidth);
  return prefix + title;
}

function pad(str: string, width: number): string {
  if (str.length >= width) return str.slice(0, width - 1) + " ";
  return str + " ".repeat(width - str.length);
}
