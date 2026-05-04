import chalk from "chalk";

import { loadConfig } from "../config/index.js";
import { clearSavedIndexedAt, listConversationsNeedingIndex, setConversationIndexedAt } from "../db/index.js";
import { parseConversationMessages } from "./common.js";
import { getSearchProviders } from "../search/deps.js";
import { indexConversation } from "../search/indexer.js";
import { nowIso } from "../utils/time.js";

export async function runIndexCommand(options: { rebuild?: boolean }): Promise<void> {
  const { embedding, vectorStore } = await getSearchProviders();

  if (options.rebuild) {
    await clearSavedIndexedAt();
    await vectorStore.reset?.();
  }

  const conversations = await listConversationsNeedingIndex();
  if (conversations.length === 0) {
    process.stdout.write(
      'All saved conversations are indexed. To rebuild, run "clog index --rebuild".\n',
    );
    return;
  }

  const config = await loadConfig();
  let indexed = 0;
  let errors = 0;

  if (process.stdout.isTTY && conversations.length > 1) {
    process.stdout.write(
      "Indexing conversations for vector search. Safe to interrupt; rerun to resume.\n",
    );
  }

  for (const conversation of conversations) {
    try {
      const messages = await parseConversationMessages(config, conversation);
      const chunkCount = await indexConversation(conversation, messages, embedding, vectorStore);
      await setConversationIndexedAt(conversation.id, nowIso());
      process.stdout.write(
        `Indexed ${chalk.cyan(conversation.id.slice(0, 8))} (${chunkCount} chunk${
          chunkCount === 1 ? "" : "s"
        })\n`,
      );
      indexed += 1;
    } catch (error) {
      errors += 1;
      process.stderr.write(
        `warning: failed to index ${conversation.id.slice(0, 8)}: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
  }

  process.stdout.write(`Indexed ${indexed} conversation(s)`);
  if (errors > 0) {
    process.stdout.write(`, ${errors} error(s)`);
  }
  process.stdout.write("\n");
}
