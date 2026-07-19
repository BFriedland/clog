import chalk from "chalk";
import { Command } from "commander";

import { loadConfig } from "../config/index.js";
import {
  listConversations,
  listConversationsNeedingIndex,
  removeConversationCopy,
  saveLocalConversation,
} from "../db/index.js";
import { isUnsummarized, type ConversationMeta } from "../models/conversation.js";
import { maybeAutoIndexConversations } from "../search/coherence.js";
import { searchAvailable } from "../search/deps.js";
import { UsageError } from "../utils/errors.js";
import { nowIso } from "../utils/time.js";
import {
  assertNoneRemote,
  confirm,
  defaultSaveFilePath,
  ensureRawCopy,
  getScanWarningsForCommand,
  getSaveCandidate,
  isLikelyRestoredLocalConversation,
  pathsIdentifySameManagedCopy,
  parseConversationMessagesFromPath,
  renderWarnings,
  SourceFileMissingError,
} from "./common.js";
import {
  collectAllSaveTargets,
  collectBareSaveTargets,
  collectProjectSaveTargets,
} from "./project-targets.js";
import { scanLocalSources } from "./scan.js";
import { resolveConversationSelectors } from "./selectors.js";

export function buildSaveCommand(): Command {
  return new Command("save")
    .description("Save conversations")
    .argument("[selectors...]", "Conversation IDs or project names to save")
    .option("--all", "Save all unsaved conversations and saved pending changes")
    .action(async (selectors: string[], options: { all?: boolean }) => {
      if (options.all && selectors.length > 0) {
        throw new UsageError(
          "Cannot combine --all with selectors. Use either 'clog save --all' or 'clog save <selector...>'.",
        );
      }

      const config = await loadConfig();
      const scanResult = await scanLocalSources(config);
      renderWarnings(getScanWarningsForCommand(scanResult));

      const conversations = options.all
        ? await collectAllSaveTargets()
        : selectors.length > 0
          ? await resolveSaveSelectors(selectors)
          : await collectBareSaveTargets();

      if (conversations.length === 0) {
        process.stdout.write('No conversations need saving. Use "clog save <id>" or "clog save <project>" to save unsaved conversations.\n');
        await maybePrintUnindexedHint(config);
        return;
      }

      assertNoneRemote(conversations, "clog save");

      const savedConversations: ConversationMeta[] = [];
      const showProgress = process.stdout.isTTY && conversations.length > 1;

      for (const [index, conversation] of conversations.entries()) {
        try {
          const candidate = await getSaveCandidate(conversation);
          const rawPath =
            conversation.state === "unsaved" || !conversation.filePath
              ? defaultSaveFilePath(conversation)
              : conversation.filePath;

          if (!(await confirmRestoredOverwriteIfNeeded(conversation, candidate))) {
            continue;
          }

          if (candidate.shouldRefreshRawCopy) {
            await ensureRawCopy(conversation);
          }

          const parsePath = candidate.shouldRefreshRawCopy ? rawPath : candidate.path;
          const messages = await parseConversationMessagesFromPath(
            config,
            conversation.source,
            parsePath,
          );
          const timestamp = nowIso();

          const savedConversation = {
            ...conversation,
            filePath: rawPath,
            state: "saved" as const,
            saveVersion: conversation.saveVersion + 1,
            savedAt: timestamp,
            modifiedAt: timestamp,
            savedMessageCount: messages.length,
            indexedAt: null,
          };

          const saved = await saveLocalConversation(savedConversation, {
            command: "clog save",
          });
          savedConversations.push(saved);
        } catch (error) {
          if (await skipMissingDiscoveredSource(error, conversation)) {
            continue;
          }
          throw error;
        }

        if (showProgress) {
          process.stdout.write(
            `\r${index + 1}/${conversations.length} conversations saved locally...`,
          );
        }
      }

      if (showProgress) {
        process.stdout.write("\n");
      }

      process.stdout.write(`Saved ${savedConversations.length} conversation(s).\n`);
      await printSaveIndexingOutcome(config, savedConversations);
      await maybePrintUnindexedHint(config);
      await maybePrintSummarizationHint();
    });
}

// CR-05/06: a save that would replace filled/restored content with a live
// local source version must confirm before overwriting the managed copy. This is
// reachable today — the scan at the top of `clog save` re-attaches a live
// sourcePath to a restored `fill --own` row (leaving projectPath null), so a
// continued source makes sourcePath and filePath diverge and trips this branch.
// Off a TTY, confirm() returns false, so we skip rather than overwrite. Completing
// re-attachment per CR-05 (also setting projectPath) would make
// isLikelyRestoredLocalConversation false and disable this guard; the coupling is
// pinned by tests/save-restored-overwrite.test.ts.
async function confirmRestoredOverwriteIfNeeded(
  conversation: ConversationMeta,
  candidate: { shouldRefreshRawCopy: boolean },
): Promise<boolean> {
  if (
    !candidate.shouldRefreshRawCopy ||
    !isLikelyRestoredLocalConversation(conversation) ||
    pathsIdentifySameManagedCopy(conversation.sourcePath, conversation.filePath)
  ) {
    return true;
  }

  const accepted = await confirm(
    `Conversation ${conversation.id.slice(0, 8)} was restored from pair files. Refreshing it will overwrite the managed raw copy with the live local source file. Continue?`,
  );
  if (!accepted) {
    process.stdout.write(
      `Skipped ${conversation.id.slice(0, 8)}; restored content was left unchanged.\n`,
    );
  }
  return accepted;
}

async function printSaveIndexingOutcome(
  config: Awaited<ReturnType<typeof loadConfig>>,
  savedConversations: ConversationMeta[],
): Promise<void> {
  if (savedConversations.length === 0) {
    return;
  }

  if (!config.search) {
    process.stdout.write("Search indexing is not configured; no indexing necessary.\n");
    return;
  }

  if (!(await searchAvailable())) {
    process.stdout.write(
      "Search indexing is unavailable; saved conversation(s) were left unindexed.\n",
    );
    return;
  }

  process.stdout.write(
    `Indexing ${savedConversations.length} conversation(s) for vector search. Safe to interrupt; run "clog index" to resume.\n`,
  );

  const showProgress = process.stdout.isTTY && savedConversations.length > 1;
  const indexedFailures = await maybeAutoIndexConversations(
    savedConversations,
    showProgress
      ? (completed, total) => {
          process.stdout.write(`\r${completed}/${total} conversations indexed for vector search...`);
          if (completed === total) {
            process.stdout.write("\n");
          }
        }
      : undefined,
  );

  for (const failedId of indexedFailures) {
    process.stderr.write(
      `warning: saved ${failedId.slice(0, 8)} but failed to index it for search\n`,
    );
  }

  const indexedCount = savedConversations.length - indexedFailures.length;
  process.stdout.write(
    `Indexed ${indexedCount}/${savedConversations.length} conversation(s) for vector search.\n`,
  );
}

async function resolveSaveSelectors(
  selectors: string[],
): Promise<ConversationMeta[]> {
  const projectTargets = await collectProjectSaveTargets();
  const projectTargetIds = new Set(projectTargets.map((conversation) => conversation.id));

  return resolveConversationSelectors({
    commandName: "clog save",
    tokens: selectors,
    idCandidates: await listConversations(),
    projectCandidates: await listConversations({ origin: "local" }),
    projectSelectionFilter: (conversation) => projectTargetIds.has(conversation.id),
  });
}

async function skipMissingDiscoveredSource(
  error: unknown,
  conversation: ConversationMeta,
): Promise<boolean> {
  if (!(error instanceof SourceFileMissingError) || conversation.state !== "unsaved") {
    return false;
  }

  await removeConversationCopy(conversation, { command: "clog save" });
  process.stderr.write(
    `warning: skipped ${conversation.id.slice(0, 8)} because its source file is missing; removed stale unsaved row from clog's database (path=${conversation.sourcePath})\n`,
  );
  return true;
}

export async function maybePrintSummarizationHint(): Promise<void> {
  const saved = await listConversations({
    states: ["saved"],
    origin: "local",
  });

  const unsummarized = saved.filter(isUnsummarized);

  if (unsummarized.length === 0) {
    return;
  }

  process.stdout.write(
    `\n${chalk.bold(`${unsummarized.length} saved conversation(s) don't have structured summaries.`)} Run \`clog talk\` to start an agent session.\n`,
  );
}

async function maybePrintUnindexedHint(
  config: Awaited<ReturnType<typeof loadConfig>>,
): Promise<void> {
  if (!config.search) {
    return;
  }

  const count = (await listConversationsNeedingIndex()).length;
  if (count === 0) {
    return;
  }

  process.stdout.write(
    `hint: ${chalk.bold(`${count} saved conversation(s) still unindexed.`)} Run \`clog index\` to finish.\n`,
  );
}
