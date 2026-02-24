import chalk from "chalk";
import { withDb } from "../db/index.js";
import {
  getSearchProviders,
  SearchNotConfiguredError,
  SearchDepsError,
} from "../search/deps.js";
import { indexConversation } from "../search/indexer.js";
import { ClaudeCodeAdapter } from "../adapters/claude-code.js";
import { getDefaultSourcePaths } from "../config/index.js";
import { loadConfig } from "../config/schema.js";

export async function indexCommand(opts: { rebuild?: boolean } = {}): Promise<void> {
  let embedding, vectorStore;
  try {
    ({ embedding, vectorStore } = await getSearchProviders());
  } catch (err) {
    if (err instanceof SearchNotConfiguredError || err instanceof SearchDepsError) {
      console.error(err.message);
      return;
    }
    throw err;
  }

  if (opts.rebuild) {
    await withDb((ctx) => {
      ctx.clearAllIndexedAt();
    });
  }

  const toIndex = await withDb((ctx) => ctx.listConversationsNeedingIndex());

  if (toIndex.length === 0) {
    console.log("All published conversations are indexed. To fully rebuild the index, use: clog index --rebuild");
    return;
  }

  console.log(`Indexing ${toIndex.length} conversation(s)...`);

  const config = await loadConfig();
  const sourcePaths =
    config.sources["claude-code"].paths.length > 0
      ? config.sources["claude-code"].paths
      : getDefaultSourcePaths();
  const adapter = new ClaudeCodeAdapter(sourcePaths);

  let indexed = 0;
  let errors = 0;
  const total = toIndex.length;
  const numWidth = String(total).length;

  for (let i = 0; i < toIndex.length; i++) {
    const conv = toIndex[i];
    const num = String(i + 1).padStart(numWidth);
    try {
      const filePath = conv.filePath || conv.sourcePath;
      const messages = await adapter.parseMessages(filePath);
      const chunkCount = await indexConversation(
        conv,
        messages,
        embedding,
        vectorStore,
      );

      const now = new Date().toISOString();
      await withDb((ctx) => {
        ctx.setIndexedAt(conv.id, now);
      });

      const shortId = conv.id.slice(0, 7);
      const maxTitle = 50;
      const rawTitle = conv.title.replace(/[\r\n]+/g, " ");
      const title = rawTitle.length > maxTitle
        ? rawTitle.slice(0, maxTitle) + "..."
        : rawTitle;
      console.log(
        `  ${num}. ${chalk.green("Indexed")} ${chalk.cyan(shortId)} (${chunkCount} chunks) ${chalk.dim(title)}`,
      );
      indexed++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `  ${num}. ${chalk.red("Error")} indexing ${conv.id.slice(0, 7)}: ${message}`,
      );
      errors++;
    }
  }

  const summary = `Indexed ${indexed} conversation(s)`;
  const errorNote = errors > 0 ? `, ${errors} error(s)` : "";
  console.log(`\n${summary}${errorNote}`);
}
