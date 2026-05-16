import chalk from "chalk";
import { Command } from "commander";

import { loadConfig } from "../config/index.js";
import {
  deleteConversation,
  listConversations,
  listConversationsNeedingIndex,
  updateConversation,
} from "../db/index.js";
import { isUnsummarized, type ConversationMeta } from "../models/conversation.js";
import { maybeAutoIndexConversations } from "../search/coherence.js";
import { searchAvailable } from "../search/deps.js";
import { UsageError } from "../utils/errors.js";
import { nowIso } from "../utils/time.js";
import {
  assertNoneRemote,
  defaultSaveFilePath,
  ensureRawCopy,
  getScanWarningsForCommand,
  getSaveCandidate,
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
    .argument("[selectors...]")
    .option("--all", "Save all discovered conversations")
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
          ? resolveConversationSelectors({
              commandName: "clog save",
              tokens: selectors,
              idCandidates: await listConversations(),
              projectCandidates: await collectProjectSaveTargets(),
            })
          : await collectBareSaveTargets();

      if (conversations.length === 0) {
        process.stdout.write('No conversations need saving. Use "clog save <id>" or "clog save <project>" to save discovered conversations.\n');
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
            conversation.state === "discovered" || !conversation.filePath
              ? defaultSaveFilePath(conversation)
              : conversation.filePath;

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

          await updateConversation(savedConversation);
          savedConversations.push(savedConversation);
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

      if (showProgress && (await searchAvailable())) {
        process.stdout.write(
          'Indexing conversations for vector search. Safe to interrupt; run "clog index" to resume.\n',
        );
      }

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

      process.stdout.write(`Saved ${savedConversations.length} conversation(s).\n`);
      await maybePrintUnindexedHint(config);
      await maybePrintSummarizationHint();
    });
}

async function skipMissingDiscoveredSource(
  error: unknown,
  conversation: ConversationMeta,
): Promise<boolean> {
  if (!(error instanceof SourceFileMissingError) || conversation.state !== "discovered") {
    return false;
  }

  await deleteConversation(conversation.id);
  process.stderr.write(
    `warning: skipped ${conversation.id.slice(0, 8)} because its source file is missing; removed stale discovered row from clog's database (path=${conversation.sourcePath})\n`,
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
