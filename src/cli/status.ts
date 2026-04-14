import { Command } from "commander";

import { loadConfig } from "../config/index.js";
import { listConversations } from "../db/index.js";
import type { ConversationMeta } from "../models/conversation.js";
import { scanLocalSources } from "./scan.js";
import {
  getFileMtimeIso,
  getPublishCandidate,
  parseConversationMessages,
  parseConversationMessagesFromPath,
  renderWarnings,
} from "./common.js";
import { colorizeStateLabel, dimText } from "./colors.js";

export function buildStatusCommand(): Command {
  return new Command("status")
    .description("Show staged, modified, and discovered conversations")
    .option("--source", "show the source column after the short ID")
    .action(async (options: { source?: boolean }) => {
      const config = await loadConfig();
      const scanResult = await scanLocalSources(config);
      renderWarnings(scanResult.warnings);
      const staged = await listConversations({ states: ["staged"] });
      const published = await listConversations({ states: ["published"] });
      const discovered = await listConversations({ states: ["discovered"] });
      const modifiedPublished: ConversationMeta[] = [];
      const cleanPublished: ConversationMeta[] = [];

      for (const conversation of published) {
        if (await isModifiedSincePublish(conversation)) {
          modifiedPublished.push(conversation);
        } else {
          cleanPublished.push(conversation);
        }
      }

      const sections: Array<() => void> = [];

      if (staged.length > 0) {
        sections.push(() => {
          process.stdout.write("Conversations to be published:\n");
          process.stdout.write(`${dimText('  (use "clog reset <id>" to unstage)')}\n`);
          renderStatusLikeRows(staged, "added", { includeSource: options.source === true });
        });
      }

      if (modifiedPublished.length > 0) {
        sections.push(() => {
          process.stdout.write("Changes to be published:\n");
          process.stdout.write(
            `${dimText('  (use "clog add <id>" to refresh the curated copy, or "clog publish <id>" to publish directly)')}\n`,
          );
          renderStatusLikeRows(modifiedPublished, "modified", {
            includeSource: options.source === true,
          });
        });
      }

      if (discovered.length > 0) {
        sections.push(() => {
          process.stdout.write("Conversations not staged for publishing:\n");
          process.stdout.write(
            `${dimText('  (use "clog add <id>" to stage for publishing)')}\n`,
          );
          renderStatusLikeRows(discovered, "discovered", {
            includeSource: options.source === true,
          });
        });
      }

      if (sections.length === 0) {
        process.stdout.write("No conversations pending publication.\n");
        if (cleanPublished.length > 0) {
          process.stdout.write(
            `${dimText('Published conversations are up to date. Use "clog list" to browse the curated set.')}\n`,
          );
        } else {
          process.stdout.write(
            `${dimText('Nothing to publish. Use "clog add" or "clog status" after new conversations appear.')}\n`,
          );
        }
      } else {
        sections.forEach((render, index) => {
          if (index > 0) {
            process.stdout.write("\n");
          }
          render();
        });
      }

      const { counts } = scanResult;
      if (counts.excluded || counts.filtered || counts.ignored || counts.pruned) {
        process.stdout.write(
          `\n${dimText(`(${counts.excluded} excluded, ${counts.filtered} filtered by config, ${counts.ignored} ignored by clogignore, ${counts.pruned} pruned)`)}\n`,
        );
      }
    });
}

function renderStatusLikeRows(
  conversations: ConversationMeta[],
  label: "added" | "modified" | "discovered",
  options: { includeSource: boolean },
): void {
  const projectWidth = getStatusProjectWidth(conversations);

  for (const conversation of conversations) {
    const prefix = colorizeStateLabel(`${label}:`.padEnd(12), conversation);
    const id = `${conversation.id.slice(0, 7)}`.padEnd(9);
    const source = options.includeSource ? `${conversation.source}`.padEnd(13) : "";
    const date = formatDate(conversation.createdAt).padEnd(12);
    const project = `${conversation.projectName ?? "-"}`.padEnd(projectWidth);
    process.stdout.write(
      `    ${prefix} ${id}${source}${date}${project}${formatStatusTitle(conversation.title, {
        includeSource: options.includeSource,
        projectWidth,
      })}\n`,
    );
  }
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "----------";
  }

  return date.toISOString().slice(0, 10);
}

function formatStatusTitle(
  value: string,
  options: { includeSource: boolean; projectWidth: number },
): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  const width = Math.max(4, getStatusTitleWidth(options));
  if (singleLine.length <= width) {
    return singleLine;
  }

  return `${singleLine.slice(0, width - 3)}...`;
}

function getStatusTitleWidth(options: {
  includeSource: boolean;
  projectWidth: number;
}): number {
  const envColumns = Number(process.env.COLUMNS);
  const width =
    (Number.isFinite(envColumns) && envColumns > 0 ? envColumns : process.stdout.columns) ?? 100;
  const sourceWidth = options.includeSource ? 13 : 0;
  return width - (38 + sourceWidth + options.projectWidth);
}

function getStatusProjectWidth(conversations: ConversationMeta[]): number {
  const widestProject = conversations.reduce((maxWidth, conversation) => {
    return Math.max(maxWidth, (conversation.projectName ?? "-").length);
  }, 0);

  return Math.max("PROJECT".length, widestProject) + 1;
}

async function isModifiedSincePublish(conversation: ConversationMeta): Promise<boolean> {
  if (!conversation.publishedAt) {
    return true;
  }

  if (conversation.modifiedAt > conversation.publishedAt) {
    return true;
  }

  if (conversation.filePath) {
    const rawMtime = await getFileMtimeIso(conversation.filePath);
    if (rawMtime && rawMtime > conversation.publishedAt) {
      return true;
    }
  }

  const config = await loadConfig();
  const candidate = await getPublishCandidate(conversation);

  if (candidate.path !== conversation.filePath) {
    return true;
  }

  if (conversation.publishedMessageCount == null) {
    return true;
  }

  const messages =
    candidate.path === conversation.filePath
      ? await parseConversationMessages(config, conversation)
      : await parseConversationMessagesFromPath(config, conversation.source, candidate.path);

  return messages.length > conversation.publishedMessageCount;
}
