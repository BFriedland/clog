import chalk from "chalk";
import { withDb } from "../db/index.js";

export async function logCommand(): Promise<void> {
  await withDb((ctx) => {
    const entries = ctx.getPublishLog();

    if (entries.length === 0) {
      console.log(chalk.dim("No publish history."));
      return;
    }

    const termWidth = process.stdout.columns || 80;

    for (const entry of entries) {
      const date = formatDate(entry.publishedAt);
      const version = `v${entry.version}`;
      const shortId = entry.conversationId.slice(0, 7);
      const message = entry.message ? ` - ${entry.message}` : "";

      // [date] vN id "title..." - message
      // prefix = everything before the title quote
      const prefix = `[${date}] ${version} ${shortId} "`;
      const suffix = `"${message}`;
      const titleWidth = Math.max(1, termWidth - prefix.length - suffix.length);
      const cleanTitle = (entry.title || "").replace(/[\r\n]+/g, " ");
      const titlePreview = cleanTitle.slice(0, titleWidth);

      console.log(
        chalk.dim(`[${date}]`) +
          ` ${chalk.green(version)} ${chalk.cyan(shortId)} "${titlePreview}"${chalk.dim(message)}`
      );
    }
  });
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}
