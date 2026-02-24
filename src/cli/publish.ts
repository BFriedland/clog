import chalk from "chalk";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { withDb } from "../db/index.js";
import { getRawDir } from "../config/index.js";
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
    }
  });
}
