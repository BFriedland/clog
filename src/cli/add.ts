import { Command } from "commander";

import { loadConfig } from "../config/index.js";
import { deleteConversation, updateConversation } from "../db/index.js";
import type { ClogWarning } from "../models/warnings.js";
import { ClogError } from "../utils/errors.js";
import { nowIso } from "../utils/time.js";
import {
  ensureRawCopy,
  compareFileContents,
  pathExists,
  renderWarnings,
  resolveManyConversationsOrFail,
} from "./common.js";
import { scanLocalSources } from "./scan.js";

export function buildAddCommand(): Command {
  return new Command("add")
    .description("Stage or refresh conversations")
    .argument("[ids...]", "Conversation IDs")
    .option("--all")
    .option("--project <name>")
    .action(async (ids: string[], options) => {
      const config = await loadConfig();

      let conversations: Awaited<ReturnType<typeof resolveManyConversationsOrFail>> = [];

      if (ids.length > 0) {
        try {
          conversations = await resolveManyConversationsOrFail(ids);
        } catch {
          const scanResult = await scanLocalSources(config);
          renderWarnings(scanResult.warnings);
          try {
            conversations = await resolveManyConversationsOrFail(ids);
          } catch (err) {
            if (err instanceof ClogError && err.message.startsWith("No conversation matches")) {
              throw new ClogError(
                `${err.message}\nhint: pass a conversation ID prefix (4+ chars), or --project <name> to stage a whole project`,
              );
            }
            throw err;
          }
        }
      }

      if (options.all || options.project) {
        const scanResult = await scanLocalSources(config);
        renderWarnings(scanResult.warnings);
        conversations = await import("../db/index.js").then(({ listConversations }) =>
          listConversations({
            states: ["discovered"],
            projectName: options.project,
          }),
        );
      }

      if (conversations.length === 0) {
        process.stdout.write("No conversations selected.\n");
        return;
      }

      let changed = 0;
      const warnings: ClogWarning[] = [];
      const isScanDrivenSelection = Boolean(options.all || options.project);

      for (const conversation of conversations) {
        if (!(await pathExists(conversation.sourcePath))) {
          if (isScanDrivenSelection && conversation.state === "discovered") {
            warnings.push({
              code: "missing_source_file",
              message: `Skipping ${conversation.id.slice(0, 7)} because the source file disappeared before it could be added.`,
              source: conversation.source,
              path: conversation.sourcePath,
              guidance: "The stale discovered entry was removed. Re-run status to refresh discovery.",
            });
            await deleteConversation(conversation.id);
            continue;
          }

          throw new Error(
            `Source file is missing for ${conversation.id}. Run "clog status" to refresh discovery.`,
          );
        }

        const identical =
          conversation.state !== "discovered" &&
          conversation.filePath != null &&
          (await compareFileContents(conversation.sourcePath, conversation.filePath));

        const destination = await ensureRawCopy(conversation);

        const updated = {
          ...conversation,
          state: conversation.state === "published" ? "published" : "staged",
          filePath: destination,
          modifiedAt: identical ? conversation.modifiedAt : nowIso(),
          indexedAt:
            conversation.state === "published" && !identical ? null : conversation.indexedAt,
        } as const;

        await updateConversation(updated);
        changed += 1;
      }

      renderWarnings(warnings);
      process.stdout.write(`Added ${changed} conversation${changed === 1 ? "" : "s"}\n`);
    });
}
