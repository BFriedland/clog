import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { glob } from "glob";
import path from "node:path";
import type { SourceAdapter } from "./adapter.js";
import type {
  DiscoveredConversation,
  Message,
} from "../models/conversation.js";

export class ClaudeCodeAdapter implements SourceAdapter {
  name = "claude-code";
  private sourcePaths: string[];

  constructor(sourcePaths: string[]) {
    this.sourcePaths = sourcePaths;
  }

  async *discover(): AsyncIterable<DiscoveredConversation> {
    for (const sourcePath of this.sourcePaths) {
      const pattern = path.join(sourcePath, "*", "*.jsonl");
      const files = await glob(pattern, { absolute: true });

      for (const filePath of files) {
        // Skip subagent files — they live inside <sessionId>/subagents/
        const rel = path.relative(sourcePath, filePath);
        const parts = rel.split(path.sep);
        if (parts.length !== 2) continue;

        const metadata = await this.extractMetadata(filePath);
        if (!metadata) continue;

        const filename = path.basename(filePath, ".jsonl");
        const dirName = parts[0];
        const project = decodeDirName(dirName);

        yield {
          sourceId: filename,
          sourcePath: filePath,
          metadata: {
            title: metadata.title,
            summary: metadata.summary,
            project,
            slug: metadata.slug,
            createdAt: metadata.createdAt,
          },
        };
      }
    }
  }

  async extractMetadata(
    filePath: string
  ): Promise<{
    title: string;
    summary: string;
    slug: string | null;
    createdAt: string;
  } | null> {
    let title = "";
    let summary = "";
    let slug: string | null = null;
    let createdAt = "";
    let hasContent = false;

    const rl = createInterface({
      input: createReadStream(filePath, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      const type = parsed.type as string;

      // Capture earliest timestamp
      if (parsed.timestamp && !createdAt) {
        createdAt = parsed.timestamp as string;
      }

      // Capture slug from any line
      if (parsed.slug && !slug) {
        slug = parsed.slug as string;
      }

      if (type === "user") {
        const msg = parsed.message as Record<string, unknown> | undefined;
        if (msg && typeof msg.content === "string" && !title) {
          title = msg.content.slice(0, 100);
          hasContent = true;
        } else if (msg && Array.isArray(msg.content)) {
          // tool_result — still counts as content
          hasContent = true;
        }
      } else if (type === "assistant") {
        hasContent = true;
      } else if (type === "summary") {
        summary = (parsed.summary as string) || "";
      }

      // Early exit: once we have title + summary + slug + timestamp, stop
      if (title && summary && slug && createdAt) break;
    }

    if (!hasContent) return null;

    return {
      title: title || "(untitled)",
      summary,
      slug,
      createdAt: createdAt || new Date().toISOString(),
    };
  }

  async parseMessages(filePath: string): Promise<Message[]> {
    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());

    interface RawLine {
      parsed: Record<string, unknown>;
      timestamp: string;
    }

    const rawLines: RawLine[] = [];
    for (const line of lines) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const type = parsed.type as string;
      if (type === "user" || type === "assistant") {
        rawLines.push({ parsed, timestamp: (parsed.timestamp as string) || "" });
      }
    }

    // Phase 1: Deduplicate assistant messages by message.id, merge content blocks
    // and build tool_use_id -> tool name map
    const toolUseIdToName = new Map<string, string>();
    const assistantById = new Map<
      string,
      { contentBlocks: Array<Record<string, unknown>>; timestamp: string }
    >();

    for (const { parsed, timestamp } of rawLines) {
      if ((parsed.type as string) !== "assistant") continue;
      const msg = parsed.message as Record<string, unknown>;
      if (!msg) continue;
      const msgId = msg.id as string;
      if (!msgId) continue;

      const contentBlocks = (msg.content as Array<Record<string, unknown>>) || [];

      // Build tool_use_id map
      for (const block of contentBlocks) {
        if (block.type === "tool_use") {
          toolUseIdToName.set(block.id as string, block.name as string);
        }
      }

      const existing = assistantById.get(msgId);
      if (existing) {
        existing.contentBlocks.push(...contentBlocks);
        if (timestamp && (!existing.timestamp || timestamp < existing.timestamp)) {
          existing.timestamp = timestamp;
        }
      } else {
        assistantById.set(msgId, { contentBlocks: [...contentBlocks], timestamp });
      }
    }

    // Phase 2: Build messages array from all lines in order
    const messages: Message[] = [];
    const processedAssistantIds = new Set<string>();

    for (const { parsed, timestamp } of rawLines) {
      const type = parsed.type as string;

      if (type === "user") {
        const msg = parsed.message as Record<string, unknown>;
        if (!msg) continue;
        const msgContent = msg.content;

        if (typeof msgContent === "string") {
          messages.push({ role: "user", content: msgContent, timestamp: timestamp || null });
        } else if (Array.isArray(msgContent)) {
          for (const block of msgContent) {
            const b = block as Record<string, unknown>;
            if (b.type === "tool_result") {
              const toolUseId = b.tool_use_id as string;
              const toolName = toolUseIdToName.get(toolUseId);
              const isError = b.is_error === true;
              const label = toolName || "tool";
              messages.push({
                role: "tool_result",
                content: isError ? `${label}: error` : `${label}: ok`,
                timestamp: timestamp || null,
                ...(toolName ? { toolName } : {}),
              });
            }
          }
        }
      } else if (type === "assistant") {
        const msg = parsed.message as Record<string, unknown>;
        if (!msg) continue;
        const msgId = msg.id as string;
        if (!msgId || processedAssistantIds.has(msgId)) continue;
        processedAssistantIds.add(msgId);

        const deduped = assistantById.get(msgId)!;
        for (const block of deduped.contentBlocks) {
          if (block.type === "thinking") continue;
          if (block.type === "text") {
            messages.push({
              role: "assistant",
              content: block.text as string,
              timestamp: deduped.timestamp || null,
            });
          } else if (block.type === "tool_use") {
            messages.push({
              role: "tool_use",
              content: `${block.name}: ${summarizeToolInput(block.input as Record<string, unknown>)}`,
              timestamp: deduped.timestamp || null,
              toolName: block.name as string,
              toolInput: block.input,
            });
          }
        }
      }
    }

    // Sort by timestamp
    messages.sort((a, b) => {
      if (!a.timestamp && !b.timestamp) return 0;
      if (!a.timestamp) return -1;
      if (!b.timestamp) return 1;
      return a.timestamp.localeCompare(b.timestamp);
    });

    return messages;
  }

  watchPaths(): string[] {
    return this.sourcePaths;
  }
}

export function decodeDirName(dirName: string): string | null {
  if (!dirName.startsWith("-")) return null;

  // Handle Windows drive letter: -C-Users-... => C:\Users\...
  const withoutDash = dirName.slice(1);
  if (/^[A-Z]-/.test(withoutDash)) {
    // Windows path with drive letter
    const drive = withoutDash[0];
    const rest = withoutDash.slice(2).replace(/-/g, path.sep);
    return `${drive}:${path.sep}${rest}`;
  }

  // Unix path: -Users-alice-project => /Users/alice/project
  return path.sep + withoutDash.replace(/-/g, path.sep);
}

function summarizeToolInput(input: Record<string, unknown>): string {
  if (!input) return "";
  // Common tool patterns
  if (input.command) return String(input.command).slice(0, 100);
  if (input.file_path) return String(input.file_path);
  if (input.pattern) {
    const result = `pattern='${input.pattern}'`;
    if (input.glob) return `${result}, glob='${input.glob}'`;
    return result;
  }
  if (input.query) return String(input.query).slice(0, 100);
  if (input.url) return String(input.url).slice(0, 100);
  // Fallback
  const keys = Object.keys(input);
  if (keys.length === 0) return "";
  return keys.slice(0, 3).join(", ");
}
