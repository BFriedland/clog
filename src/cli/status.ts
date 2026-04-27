import chalk from "chalk";
import { Command } from "commander";

import { loadConfig } from "../config/index.js";
import { listConversations } from "../db/index.js";
import type { ConversationMeta } from "../models/conversation.js";
import { checkStaleness } from "../sync/staleness.js";
import { scanLocalSources } from "./scan.js";
import {
  classifyPublishedDelta,
  getScanWarningsForCommand,
  isPublishedReadyForRepublishWithDelta,
  renderWarnings,
} from "./common.js";
import { colorizeStatusLabel, dimText } from "./colors.js";

export function buildStatusCommand(): Command {
  return new Command("status")
    .description("Show staged, modified, and discovered conversations")
    .option("--source", "show the source column after the short ID")
    .option("--undiscoverable", "list conversations skipped due to missing project path")
    .action(async (options: { source?: boolean; undiscoverable?: boolean }) => {
      const config = await loadConfig();
      const scanResult = await scanLocalSources(config);
      renderWarnings(getScanWarningsForCommand(scanResult, { suppressUndiscoverable: true }));
      const staged = await listConversations({ states: ["staged"], origin: "local" });
      const published = await listConversations({ states: ["published"], origin: "local" });
      const discovered = await listConversations({ states: ["discovered"], origin: "local" });
      const readyPublished: ConversationMeta[] = [];
      const sourceAheadPublished: ConversationMeta[] = [];
      const cleanPublished: ConversationMeta[] = [];

      for (const conversation of published) {
        const kind = await classifyPublishedDelta(conversation);
        if (kind === "ready") {
          readyPublished.push(conversation);
        } else if (kind === "source_ahead") {
          sourceAheadPublished.push(conversation);
        } else if (isPublishedReadyForRepublishWithDelta(conversation, kind)) {
          readyPublished.push(conversation);
        } else {
          cleanPublished.push(conversation);
        }
      }

      const sections: Array<() => void> = [];

      if (staged.length > 0 || readyPublished.length > 0) {
        sections.push(() => {
          process.stdout.write("Conversations to be published:\n");
          process.stdout.write(`${dimText('  (use "clog reset <id>" to unstage)')}\n`);
          if (staged.length > 0) {
            renderStatusLikeRows(staged, "added", "staged", {
              includeSource: options.source === true,
            });
          }
          if (readyPublished.length > 0) {
            renderStatusLikeRows(readyPublished, "modified", "staged", {
              includeSource: options.source === true,
            });
          }
        });
      }

      if (sourceAheadPublished.length > 0) {
        sections.push(() => {
          process.stdout.write("Changes not staged for publishing:\n");
          process.stdout.write(
            `${dimText('  (use "clog add <id>" to refresh the curated copy, or "clog publish <id>" to publish directly)')}\n`,
          );
          renderStatusLikeRows(sourceAheadPublished, "modified", "unstaged", {
            includeSource: options.source === true,
          });
        });
      }

      if (discovered.length > 0) {
        sections.push(() => {
          process.stdout.write("Untracked conversations:\n");
          process.stdout.write(
            `${dimText('  (use "clog add <id>" to stage for publishing)')}\n`,
          );
          renderStatusLikeRows(discovered, "discovered", "unstaged", {
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
      if (counts.filtered || counts.ignored || counts.pruned || counts.undiscoverable) {
        const parts = `${counts.filtered} filtered by config, ${counts.ignored} ignored by clogignore, ${counts.pruned} pruned`;
        const undiscoverableCount = counts.undiscoverable
          ? `, ${counts.undiscoverable} undiscoverable`
          : "";
        const undiscoverableHint = counts.undiscoverable && !options.undiscoverable
          ? `; run "clog status --undiscoverable" for details`
          : "";
        process.stdout.write(
          `\n${dimText(`(${parts}${undiscoverableCount}${undiscoverableHint})`)}\n`,
        );
      }

      if (options.undiscoverable) {
        if (scanResult.undiscoverable.length > 0) {
          process.stdout.write("\nUndiscoverable conversations:\n");
          process.stdout.write(
            `${dimText("  (project path missing: these conversation files have no cwd metadata)")}\n`,
          );
          for (const entry of scanResult.undiscoverable) {
            process.stdout.write(`    ${entry.source}  ${entry.path}\n`);
          }
        } else {
          process.stdout.write("\nNo undiscoverable conversations found.\n");
        }
      }

      await renderSearchSection();
      await renderRemoteSection(config);
    });
}

async function renderSearchSection(): Promise<void> {
  const unindexed = (
    await listConversations({ states: ["published"], indexed: false })
  ).length;

  if (unindexed === 0) {
    return;
  }

  process.stdout.write(`\nSearch:\n`);
  process.stdout.write(
    `  ${unindexed} conversation(s) not yet indexed. Run \`clog index\` to index.\n`,
  );
}

async function renderRemoteSection(
  config: Awaited<ReturnType<typeof loadConfig>>,
): Promise<void> {
  if (!config.remote.url) {
    return;
  }

  const remoteCount = (await listConversations({ origin: "remote" })).length;

  process.stdout.write(`\nRemote: ${config.remote.url}\n`);
  process.stdout.write(`  ${remoteCount} conversation(s) imported from remote.\n`);

  const staleness = await checkStaleness();
  if (staleness.kind === "stale") {
    process.stdout.write(
      `${chalk.yellow(
        "  Warning: remote checkout has changed outside of clog. Run `clog refresh` to reconcile.",
      )}\n`,
    );
  }
}

function renderStatusLikeRows(
  conversations: ConversationMeta[],
  label: "added" | "modified" | "discovered",
  stagingState: "staged" | "unstaged",
  options: { includeSource: boolean },
): void {
  const projectWidth = getStatusProjectWidth(conversations);

  for (const conversation of conversations) {
    const prefix = colorizeStatusLabel(`${label}:`.padEnd(12), stagingState);
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
