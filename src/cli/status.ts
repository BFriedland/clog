import chalk from "chalk";
import { Command } from "commander";

import { classifyInstalledTranscriptProjectionVersion } from "../adapters/registry.js";
import { loadConfig } from "../config/index.js";
import {
  attachCurrentSourceCandidate,
  findScanCandidateForConversation,
  listConversationView,
} from "../conversations/view.js";
import { gitOriginFilter, listConversations } from "../db/index.js";
import type { ConversationMeta } from "../models/conversation.js";
import { checkStaleness } from "../sync/staleness.js";
import { scanLocalSources } from "./scan.js";
import {
  classifySavedDelta,
  getTerminalWidth,
  getScanWarningsForCommand,
  renderWarnings,
} from "./common.js";
import { colorizeStatusLabel, dimText } from "./colors.js";

type StatusLabel = "unsaved" | "modified" | "source" | "unreadable";
type StatusTone = "ready" | "attention";

interface StatusEntry {
  conversation: ConversationMeta;
  label: StatusLabel;
  tone: StatusTone;
}

export function buildStatusCommand(): Command {
  return new Command("status")
    .description("Show unsaved conversations and saved conversations needing attention")
    .option("--source", "show conversation rows with the source column after the short ID")
    .option("-c, --conversations", "show one row per conversation")
    .option("--undiscoverable", "list conversations skipped due to missing project path")
    .option("--verbose-warnings", "show every scan warning individually instead of aggregating repeats")
    .action(async (options: {
      source?: boolean;
      conversations?: boolean;
      undiscoverable?: boolean;
      verboseWarnings?: boolean;
    }) => {
      const config = await loadConfig();
      const scanResult = await scanLocalSources(config);
      renderWarnings(
        getScanWarningsForCommand(scanResult, {
          suppressUndiscoverable: true,
          verbose: options.verboseWarnings === true,
        }),
      );
      const saved = (
        await listConversationView({ states: ["saved"], origin: "local" })
      ).map((conversation) => attachCurrentSourceCandidate(conversation, scanResult));
      const unsaved = await listConversationView(
        { states: ["unsaved"], origin: "local" },
        scanResult,
      );
      const readySaved: ConversationMeta[] = [];
      const sourceAheadSaved: ConversationMeta[] = [];
      const unreadableSaved: ConversationMeta[] = [];
      const cleanSaved: ConversationMeta[] = [];
      const projectionVersionSkewSaved: ConversationMeta[] = [];
      const showConversations = options.conversations === true || options.source === true;

      for (const conversation of saved) {
        const kind = await classifySavedDelta(
          conversation,
          findScanCandidateForConversation(conversation, scanResult),
        );
        if (kind === "ready") {
          readySaved.push(conversation);
        } else if (kind === "content_unavailable") {
          unreadableSaved.push(conversation);
        } else if (kind === "source_ahead") {
          sourceAheadSaved.push(conversation);
        } else if (kind === "version_skew") {
          if (
            classifyInstalledTranscriptProjectionVersion(
              conversation.source,
              conversation.transcriptProjectionVersion,
            ) === "version_skew"
          ) {
            projectionVersionSkewSaved.push(conversation);
          }
        } else {
          cleanSaved.push(conversation);
        }
      }

      renderWarnings(
        projectionVersionSkewSaved.map((conversation) => ({
          code: "adapter_version_skew",
          message:
            "A conversation uses a transcript projection version from a newer clog version.",
          source: conversation.source,
          conversation: {
            id: conversation.id,
            source: conversation.source,
          },
          guidance: "Upgrade clog before reading, refreshing, or indexing this conversation.",
        })),
      );

      const sections: Array<() => void> = [];

      if (readySaved.length > 0) {
        sections.push(() => {
          process.stdout.write("Saved conversations to resave:\n");
          process.stdout.write(
            `${dimText('  (use "clog save" to save these updates)')}\n`,
          );
          renderStatusEntries(
            toStatusEntries(readySaved, "modified", "ready"),
            {
              includeSource: options.source === true,
              showConversations,
            },
          );
        });
      }

      if (sourceAheadSaved.length > 0) {
        sections.push(() => {
          process.stdout.write("Saved conversations whose source files changed:\n");
          process.stdout.write(
            `${dimText('  (use "clog save <id>" to refresh the saved copy from its source file)')}\n`,
          );
          renderStatusEntries(toStatusEntries(sourceAheadSaved, "source", "attention"), {
            includeSource: options.source === true,
            showConversations,
          });
        });
      }

      if (unreadableSaved.length > 0) {
        sections.push(() => {
          process.stdout.write("Saved conversations whose content files cannot be read:\n");
          process.stdout.write(
            `${dimText('  (restore the content file from a backup, or remove the conversation from clog with "clog remove <id>")')}\n`,
          );
          renderStatusEntries(
            toStatusEntries(unreadableSaved, "unreadable", "attention"),
            {
              includeSource: options.source === true,
              showConversations: true,
            },
          );
        });
      }

      if (unsaved.length > 0) {
        sections.push(() => {
          process.stdout.write("Unsaved conversations:\n");
          process.stdout.write(
            `${dimText('  (use "clog save <id>" or "clog save <project>" to save)')}\n`,
          );
          renderStatusEntries(toStatusEntries(unsaved, "unsaved", "attention"), {
            includeSource: options.source === true,
            showConversations,
          });
        });
      }

      if (sections.length === 0) {
        process.stdout.write("Nothing to save.\n");
        if (cleanSaved.length > 0) {
          process.stdout.write(
            `${dimText('Saved conversations are up to date. Use "clog list" to browse the curated set.')}\n`,
          );
        } else {
          process.stdout.write(
            `${dimText('Use "clog status" after new conversations appear.')}\n`,
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
      if (counts.filtered || counts.ignored || counts.undiscoverable) {
        const parts = `${counts.filtered} filtered by config, ${counts.ignored} ignored by clogignore`;
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

      await renderSearchSection(config);
      await renderRemoteSection(config);
    });
}

async function renderSearchSection(
  config: Awaited<ReturnType<typeof loadConfig>>,
): Promise<void> {
  if (!config.search) {
    return;
  }

  const unindexed = (
    await listConversations({ indexed: false })
  ).length;

  if (unindexed === 0) {
    return;
  }

  process.stdout.write(`\nSearch:\n`);
  process.stdout.write(
    `  ${chalk.bold(`${unindexed} conversation(s) not yet indexed for vector search.`)} Run \`clog index\` to index.\n`,
  );
}

async function renderRemoteSection(
  config: Awaited<ReturnType<typeof loadConfig>>,
): Promise<void> {
  if (!config.remote.url) {
    return;
  }

  const remoteCount = (await listConversations({ origin: gitOriginFilter(config.remote.url) })).length;

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

function toStatusEntries(
  conversations: ConversationMeta[],
  label: StatusLabel,
  tone: StatusTone,
): StatusEntry[] {
  return conversations.map((conversation) => ({
    conversation,
    label,
    tone,
  }));
}

function renderStatusEntries(
  entries: StatusEntry[],
  options: { includeSource: boolean; showConversations: boolean },
): void {
  if (options.showConversations) {
    renderStatusLikeRows(entries, {
      includeSource: options.includeSource,
    });
    return;
  }

  renderProjectStatusRows(entries);
}

function renderStatusLikeRows(
  entries: StatusEntry[],
  options: { includeSource: boolean },
): void {
  const projectWidth = getStatusProjectWidth(entries.map((entry) => entry.conversation));

  for (const entry of entries) {
    const { conversation } = entry;
    const prefix = colorizeStatusLabel(`${entry.label}:`.padEnd(12), entry.tone);
    const id = `${conversation.id.slice(0, 8)}`.padEnd(10);
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

function renderProjectStatusRows(entries: StatusEntry[]): void {
  const projectEntries = entries.filter(hasStatusProject);
  const conversationEntries = entries.filter((entry) => !hasStatusProject(entry));

  if (projectEntries.length > 0) {
    const groups = groupStatusEntriesByProject(projectEntries);
    const projectWidth = getProjectSummaryNameWidth(groups);
    const countsWidth = getProjectSummaryCountsWidth(groups);

    for (const group of groups) {
      const project = group.projectName.padEnd(projectWidth);
      const counts = formatProjectCounts(group.entries).padEnd(countsWidth);
      const date = formatLatestConversationDate(group.entries);
      process.stdout.write(
        `    ${project}${colorizeStatusLabel(counts, group.tone)}${date}\n`,
      );
    }
  }

  if (conversationEntries.length > 0) {
    renderStatusLikeRows(conversationEntries, { includeSource: false });
  }
}

function hasStatusProject(entry: StatusEntry): boolean {
  return (entry.conversation.projectName?.trim().length ?? 0) > 0;
}

function groupStatusEntriesByProject(entries: StatusEntry[]): Array<{
  projectName: string;
  entries: StatusEntry[];
  tone: StatusTone;
}> {
  const groupsByProject = new Map<string, StatusEntry[]>();

  for (const entry of entries) {
    const projectName = entry.conversation.projectName?.trim();
    if (!projectName) {
      continue;
    }

    const group = groupsByProject.get(projectName) ?? [];
    group.push(entry);
    groupsByProject.set(projectName, group);
  }

  return Array.from(groupsByProject.entries())
    .map(([projectName, groupEntries]) => ({
      projectName,
      entries: groupEntries,
      tone: groupEntries[0]?.tone ?? "attention",
      latestTimestamp: getLatestConversationTimestamp(groupEntries),
    }))
    .sort(compareProjectStatusGroups);
}

function compareProjectStatusGroups(
  left: { projectName: string; latestTimestamp: number },
  right: { projectName: string; latestTimestamp: number },
): number {
  if (left.latestTimestamp !== right.latestTimestamp) {
    return right.latestTimestamp - left.latestTimestamp;
  }

  return left.projectName.localeCompare(right.projectName);
}

function getProjectSummaryNameWidth(
  groups: Array<{ projectName: string }>,
): number {
  const widestProject = groups.reduce((maxWidth, group) => {
    return Math.max(maxWidth, group.projectName.length);
  }, 0);

  return widestProject + 2;
}

function getProjectSummaryCountsWidth(
  groups: Array<{ entries: StatusEntry[] }>,
): number {
  const widestCounts = groups.reduce((maxWidth, group) => {
    return Math.max(maxWidth, formatProjectCounts(group.entries).length);
  }, 0);

  return widestCounts + 2;
}

function formatProjectCounts(entries: StatusEntry[]): string {
  const counts = new Map<StatusLabel, number>();

  for (const entry of entries) {
    counts.set(entry.label, (counts.get(entry.label) ?? 0) + 1);
  }

  return (["unsaved", "source", "modified"] satisfies StatusLabel[])
    .filter((label) => (counts.get(label) ?? 0) > 0)
    .map((label) => formatProjectCount(label, counts.get(label) ?? 0))
    .join(", ");
}

function formatProjectCount(label: StatusLabel, count: number): string {
  if (label === "source") {
    return `${count} conversation${count === 1 ? "" : "s"}`;
  }

  return `${count} ${label}`;
}

function formatLatestConversationDate(entries: StatusEntry[]): string {
  const latest = getLatestConversationTimestamp(entries);
  const latestEntry = entries.find((entry) => Date.parse(entry.conversation.createdAt) === latest);
  return formatDate(latestEntry?.conversation.createdAt ?? "");
}

function getLatestConversationTimestamp(entries: StatusEntry[]): number {
  let latest = Number.NEGATIVE_INFINITY;

  for (const entry of entries) {
    const timestamp = Date.parse(entry.conversation.createdAt);
    if (Number.isNaN(timestamp) || timestamp <= latest) {
      continue;
    }

    latest = timestamp;
  }

  return latest;
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
  const sourceWidth = options.includeSource ? 13 : 0;
  return getTerminalWidth() - (39 + sourceWidth + options.projectWidth);
}

function getStatusProjectWidth(conversations: ConversationMeta[]): number {
  const widestProject = conversations.reduce((maxWidth, conversation) => {
    return Math.max(maxWidth, (conversation.projectName ?? "-").length);
  }, 0);

  return Math.max("PROJECT".length, widestProject) + 1;
}
