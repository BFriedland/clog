import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { createReadStream } from "node:fs";

import { glob } from "glob";

import type { Config } from "../config/schema.js";
import type { Message } from "../models/conversation.js";
import type { ClogWarning } from "../models/warnings.js";
import { normalizeUserPath } from "../utils/paths.js";
import type { DiscoverOptions, DiscoveredConversation, SourceAdapter } from "./adapter.js";

interface ClaudeJsonLine {
  type?: string;
  timestamp?: string;
  cwd?: string;
  slug?: string;
  message?: {
    id?: string;
    role?: string;
    content?: string | ClaudeContentBlock[];
  };
}

type ClaudeContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

const KNOWN_HIDDEN_USER_WRAPPER_BLOCKS = ["local-command-caveat"];
const LOCAL_COMMAND_WRAPPER_REGEX =
  /<(command-name|command-message|command-args|local-command-stdout|local-command-stderr)>([\s\S]*?)<\/\1>/g;

export class ClaudeCodeAdapter implements SourceAdapter {
  readonly name = "claude-code";

  constructor(private readonly config: Config) {}

  async *discover(options: DiscoverOptions = {}): AsyncIterable<DiscoveredConversation> {
    for (const basePath of this.watchPaths()) {
      const files = await glob("*/*.jsonl", {
        cwd: basePath,
        absolute: true,
        nodir: true,
      });

      for (const filePath of files.sort()) {
        const discovered = await this.discoverFile(filePath, options.onWarning);
        if (discovered) {
          yield discovered;
        }
      }
    }
  }

  async parseMessages(filePath: string): Promise<Message[]> {
    const lines = await readJsonlFile<ClaudeJsonLine>(filePath);
    const toolNames = new Map<string, string>();
    const mergedAssistants = new Map<
      string,
      {
        index: number;
        timestamp: string | null;
        blocks: ClaudeContentBlock[];
      }
    >();
    const items: Array<
      | { kind: "user"; index: number; line: ClaudeJsonLine }
      | { kind: "assistant"; key: string; index: number }
    > = [];

    for (const [index, line] of lines.entries()) {
      if (line.type === "user") {
        items.push({ kind: "user", index, line });
        continue;
      }

      if (line.type !== "assistant" || !line.message) {
        continue;
      }

      const content = Array.isArray(line.message.content) ? line.message.content : [];
      const key =
        typeof line.message.id === "string" && line.message.id
          ? line.message.id
          : `assistant-${index}`;

      if (!mergedAssistants.has(key)) {
        mergedAssistants.set(key, {
          index,
          timestamp: normalizeTimestamp(line.timestamp),
          blocks: [],
        });
        items.push({ kind: "assistant", key, index });
      }

      const merged = mergedAssistants.get(key);
      if (!merged) {
        continue;
      }

      for (const block of content) {
        merged.blocks.push(block);
        if (block.type === "tool_use" && typeof block.id === "string") {
          toolNames.set(block.id, block.name);
        }
      }
    }

    items.sort((left, right) => left.index - right.index);

    const messages: Message[] = [];

    for (const item of items) {
      if (item.kind === "user") {
        const projected = projectClaudeUserLine(item.line, toolNames);
        if (projected) {
          messages.push(projected);
        }
        continue;
      }

      const merged = mergedAssistants.get(item.key);
      if (!merged) {
        continue;
      }

      for (const block of merged.blocks) {
        if (block.type === "thinking") {
          continue;
        }

        if (block.type === "text") {
          messages.push({
            role: "assistant",
            content: block.text,
            timestamp: merged.timestamp,
          });
          continue;
        }

        messages.push({
          role: "tool_use",
          content: `${block.name}: ${summarizeToolInput(block.input)}`,
          timestamp: merged.timestamp,
          toolName: block.name,
          toolInput: block.input,
        });
      }
    }

    return messages;
  }

  watchPaths(): string[] {
    return this.config.sources["claude-code"].paths.map(normalizeUserPath);
  }

  private async discoverFile(
    filePath: string,
    onWarning?: (warning: ClogWarning) => void,
  ): Promise<DiscoveredConversation | null> {
    const sourceId = path.basename(filePath, ".jsonl");
    const fileStat = await fs.stat(filePath);
    const metadata = {
      title: "(untitled)",
      summary: "",
      projectName: null as string | null,
      projectPath: null as string | null,
      slug: null as string | null,
      createdAt: fileStat.mtime.toISOString(),
    };

    const rl = readline.createInterface({
      input: createReadStream(filePath, "utf8"),
      crlfDelay: Infinity,
    });

    try {
      for await (const rawLine of rl) {
        const trimmed = rawLine.trim();
        if (!trimmed) {
          continue;
        }

        let line: ClaudeJsonLine;

        try {
          line = JSON.parse(trimmed) as ClaudeJsonLine;
        } catch {
          onWarning?.({
            code: "malformed_jsonl",
            message: "Skipping malformed Claude Code conversation file.",
            source: this.name,
            path: filePath,
            guidance: "Fix the JSONL or remove the malformed file.",
          });
          return null;
        }

        if (metadata.createdAt === fileStat.mtime.toISOString()) {
          const timestamp = normalizeTimestamp(line.timestamp);
          if (timestamp) {
            metadata.createdAt = timestamp;
          }
        }

        if (!metadata.projectPath && typeof line.cwd === "string" && line.cwd.trim()) {
          metadata.projectPath = line.cwd;
          metadata.projectName = path.basename(line.cwd);
        }

        if (!metadata.slug && typeof line.slug === "string" && line.slug.trim()) {
          metadata.slug = line.slug;
        }

        const projectedTitle =
          line.type === "user" && typeof line.message?.content === "string"
            ? normalizeClaudeVisibleUserText(line.message.content)
            : null;

        if (metadata.title === "(untitled)" && projectedTitle) {
          metadata.title = truncateTitle(projectedTitle);
        }

        if (
          line.type === "summary" &&
          typeof (line as { summary?: unknown }).summary === "string"
        ) {
          metadata.summary = (line as { summary: string }).summary;
        }

        if (
          metadata.title !== "(untitled)" &&
          metadata.summary !== "" &&
          metadata.slug !== null &&
          metadata.projectPath !== null
        ) {
          break;
        }
      }
    } finally {
      rl.close();
    }

    return {
      sourceId,
      sourcePath: filePath,
      metadata,
    };
  }
}

function projectClaudeUserLine(
  line: ClaudeJsonLine,
  toolNames: Map<string, string>,
): Message | null {
  const content = line.message?.content;
  const timestamp = normalizeTimestamp(line.timestamp);

  if (typeof content === "string") {
    const projected = normalizeClaudeVisibleUserText(content);
    if (!projected) {
      return null;
    }

    return {
      role: "user",
      content: projected,
      timestamp,
    };
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const toolResultBlock = content.find(
    (block) =>
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      (block as { type?: string }).type === "tool_result",
  ) as
    | {
        tool_use_id?: string;
        is_error?: boolean;
      }
    | undefined;

  if (!toolResultBlock) {
    return null;
  }

  const toolName =
    (toolResultBlock.tool_use_id && toolNames.get(toolResultBlock.tool_use_id)) ?? "tool";
  const status = toolResultBlock.is_error ? "error" : "ok";

  return {
    role: "tool_result",
    content: `${toolName}: ${status}`,
    timestamp,
    toolName,
  };
}

function truncateTitle(value: string): string {
  return value.length <= 100 ? value : `${value.slice(0, 100)}...`;
}

function stripClaudeUserWrappers(text: string): string {
  let remaining = text.trim();
  let changed = true;

  while (changed) {
    changed = false;

    for (const wrapper of KNOWN_HIDDEN_USER_WRAPPER_BLOCKS) {
      const leadingWrapperRegex = new RegExp(
        `^<${wrapper}>[\\s\\S]*?<\\/${wrapper}>\\s*`,
      );
      const withoutWrapper = remaining.replace(leadingWrapperRegex, "");
      if (withoutWrapper !== remaining) {
        remaining = withoutWrapper.trimStart();
        changed = true;
      }
    }
  }

  return remaining.trim();
}

function normalizeClaudeVisibleUserText(text: string): string {
  const stripped = stripClaudeUserWrappers(text);
  if (!stripped) {
    return "";
  }

  const wrappers = [...stripped.matchAll(LOCAL_COMMAND_WRAPPER_REGEX)];
  if (wrappers.length === 0) {
    return stripped;
  }

  const matchedText = wrappers.map((match) => match[0]).join("").replace(/\s+/g, "");
  const sourceText = stripped.replace(/\s+/g, "");
  if (matchedText !== sourceText) {
    return stripped;
  }

  const values = new Map<string, string>();
  for (const [, name, value] of wrappers) {
    values.set(name, decodeClaudeWrapperText(value.trim()));
  }

  const commandName = values.get("command-name");
  const commandMessage = values.get("command-message");
  const commandArgs = values.get("command-args");
  const stdout = values.get("local-command-stdout");
  const stderr = values.get("local-command-stderr");

  if (stdout != null || stderr != null) {
    return [stdout, stderr].filter(Boolean).join("\n").trim();
  }

  if (commandName != null || commandMessage != null || commandArgs != null) {
    const baseCommand = commandName && commandName.trim() ? commandName.trim() : commandMessage?.trim() ?? "";
    const args = commandArgs?.trim() ?? "";
    return `${baseCommand}${args ? ` ${args}` : ""}`.trim();
  }

  return stripped;
}

function decodeClaudeWrapperText(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function summarizeToolInput(input: unknown): string {
  if (input == null) {
    return "{}";
  }

  const json = JSON.stringify(input);
  return json.length <= 120 ? json : `${json.slice(0, 117)}...`;
}

function normalizeTimestamp(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

async function readJsonlFile<T>(filePath: string): Promise<T[]> {
  const raw = await fs.readFile(filePath, "utf8");
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.map((line) => JSON.parse(line) as T);
}
