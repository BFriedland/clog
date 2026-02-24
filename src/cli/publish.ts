import chalk from "chalk";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { withDb } from "../db/index.js";
import { getRawDir, getDefaultSourcePaths } from "../config/index.js";
import { loadConfig } from "../config/schema.js";
import type { ConversationMeta } from "../models/conversation.js";

export async function publishCommand(
  ids: string[],
  opts: { message?: string }
): Promise<void> {
  const config = await loadConfig();
  const author = config.author || "";
  const now = new Date().toISOString();
  const rawDir = getRawDir();

  // Collect published conversation IDs so we can auto-index after releasing the lock
  const publishedIds: string[] = [];

  await withDb(async (ctx) => {
    let conversations: ConversationMeta[];

    if (ids.length === 0) {
      // Publish all staged conversations
      conversations = ctx.listConversations({ state: "staged" });
      if (conversations.length === 0) {
        console.log(chalk.yellow("No staged conversations to publish."));
        return;
      }
    } else {
      // Resolve each ID
      conversations = ids.map((id) => {
        const fullId = ctx.resolveId(id);
        const conv = ctx.getConversation(fullId);
        if (!conv) {
          throw new Error(`Conversation not found: ${fullId}`);
        }
        return conv;
      });
    }

    for (const conv of conversations) {
      let filePath = conv.filePath;

      // If discovered (no raw copy), implicitly copy source file to raw dir first
      if (conv.state === "discovered" || !filePath) {
        const sourceRawDir = path.join(rawDir, conv.source);
        await mkdir(sourceRawDir, { recursive: true });
        const destName = `${conv.id}.jsonl`;
        filePath = path.join(sourceRawDir, destName);
        await copyFile(conv.sourcePath, filePath);
      }

      const newVersion = conv.publishVersion + 1;

      ctx.updateConversation(conv.id, {
        state: "published",
        publishVersion: newVersion,
        publishedAt: now,
        modifiedAt: now,
        filePath,
      });

      ctx.insertPublishLogEntry({
        conversationId: conv.id,
        version: newVersion,
        publishedAt: now,
        author,
        message: opts.message || "",
      });

      const prefix = `Published ${conv.id.slice(0, 12)} v${newVersion} `;
      const termWidth = process.stdout.columns || 80;
      const titleWidth = Math.max(1, termWidth - prefix.length);
      const title = conv.title.replace(/[\r\n]+/g, " ").slice(0, titleWidth);
      console.log(
        chalk.green("Published") +
          ` ${chalk.cyan(conv.id.slice(0, 12))} v${newVersion} ${chalk.dim(title)}`
      );

      publishedIds.push(conv.id);
    }
  });

  // Auto-index published conversations if search is configured
  if (publishedIds.length === 0) return;

  try {
    const { searchAvailable, getSearchProviders } = await import(
      "../search/deps.js"
    );
    if (!(await searchAvailable())) return;

    const { embedding, vectorStore } = await getSearchProviders();
    const { indexConversation } = await import("../search/indexer.js");
    const { ClaudeCodeAdapter } = await import("../adapters/claude-code.js");

    const sourcePaths =
      config.sources["claude-code"].paths.length > 0
        ? config.sources["claude-code"].paths
        : getDefaultSourcePaths();
    const adapter = new ClaudeCodeAdapter(sourcePaths);

    const label = publishedIds.length === 1 ? "conversation" : "conversations";
    process.stdout.write(
      chalk.dim(`Indexing ${publishedIds.length} ${label} for search...`),
    );

    let indexed = 0;
    for (const id of publishedIds) {
      try {
        const conv = await withDb((ctx) => ctx.getConversation(id));
        if (!conv) continue;

        const filePath = conv.filePath || conv.sourcePath;
        const messages = await adapter.parseMessages(filePath);
        await indexConversation(conv, messages, embedding, vectorStore);

        await withDb((ctx) => {
          ctx.setIndexedAt(id, new Date().toISOString());
        });
        indexed++;
      } catch {
        // Silent failure — indexing is best-effort during publish
      }
    }

    console.log(chalk.dim(` done (${indexed} indexed)`));
  } catch {
    // Search deps not available or not configured — skip silently
  }
}
