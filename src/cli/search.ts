import chalk from "chalk";
import path from "node:path";
import { withDb } from "../db/index.js";
import {
  getSearchProviders,
  SearchNotConfiguredError,
  SearchDepsError,
} from "../search/deps.js";
import { searchConversations } from "../search/indexer.js";
import type { ConversationMeta } from "../models/conversation.js";

export async function searchCommand(
  query: string,
  opts: {
    project?: string;
    author?: string;
    tag?: string;
    limit?: number;
  },
): Promise<void> {
  let embedding, vectorStore;
  try {
    ({ embedding, vectorStore } = await getSearchProviders());
  } catch (err) {
    if (err instanceof SearchNotConfiguredError || err instanceof SearchDepsError) {
      throw new Error(`${err.message} Run \`clog search --init\` to configure search.`);
    }
    throw err;
  }

  const limit = opts.limit ?? 10;

  // Pre-filter via SQLite if metadata filters provided
  let conversationIdFilter: Set<string> | undefined;
  if (opts.project || opts.author || opts.tag) {
    const convs = await withDb((ctx) =>
      ctx.listConversations({
        state: "published",
        project: opts.project,
        author: opts.author,
        tag: opts.tag,
      }),
    );
    conversationIdFilter = new Set(convs.map((c) => c.id));
    if (conversationIdFilter.size === 0) {
      console.log("No published conversations match the specified filters.");
      return;
    }
  }

  const results = await searchConversations(
    query,
    limit,
    embedding,
    vectorStore,
    conversationIdFilter,
  );

  if (results.length === 0) {
    console.log("No results found.");
    return;
  }

  // Fetch full metadata for matched conversations
  const convMap = await withDb((ctx) => {
    const map = new Map<string, ConversationMeta>();
    for (const r of results) {
      const conv = ctx.getConversation(r.conversationId);
      if (conv) map.set(r.conversationId, conv);
    }
    return map;
  });

  // Display results
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const conv = convMap.get(r.conversationId);
    if (!conv) continue;

    const score = (r.score * 100).toFixed(0);
    const shortId = conv.id.slice(0, 7);
    const project = conv.project ? path.basename(conv.project) : "";
    const termWidth = process.stdout.columns || 80;
    const title = conv.title.replace(/[\r\n]+/g, " ").slice(0, termWidth - 30);

    console.log(
      `${chalk.yellow(`${i + 1}.`)} ${chalk.cyan(shortId)} ${chalk.dim(`[${score}%]`)} ${title}`,
    );
    if (project) {
      console.log(`   ${chalk.dim(project)}`);
    }
    // Show snippet (first 200 chars of matched chunk)
    const snippet = r.text.replace(/\n/g, " ").slice(0, 200);
    console.log(`   ${chalk.dim(snippet)}`);
    if (i < results.length - 1) console.log("");
  }
}
