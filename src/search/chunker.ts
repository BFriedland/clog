import type { Message } from "../models/conversation.js";
import type { SearchChunk } from "./types.js";

const CHARS_PER_TOKEN = 4;
const TARGET_CHUNK_TOKENS = 800;
const OVERLAP_TOKENS = 100;
const TARGET_CHUNK_CHARS = TARGET_CHUNK_TOKENS * CHARS_PER_TOKEN;
const OVERLAP_CHARS = OVERLAP_TOKENS * CHARS_PER_TOKEN;

interface Turn {
  startMessageIndex: number;
  endMessageIndex: number;
  messages: Message[];
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function groupMessagesIntoTurns(messages: Message[]): Turn[] {
  const turns: Turn[] = [];
  let currentMessages: Message[] = [];
  let startMessageIndex = 0;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];

    if (message.role === "user" && currentMessages.length > 0) {
      turns.push({
        startMessageIndex,
        endMessageIndex: index - 1,
        messages: currentMessages,
      });
      currentMessages = [];
      startMessageIndex = index;
    }

    currentMessages.push(message);
  }

  if (currentMessages.length > 0) {
    turns.push({
      startMessageIndex,
      endMessageIndex: messages.length - 1,
      messages: currentMessages,
    });
  }

  return turns;
}

function renderMessageForEmbedding(message: Message): string | null {
  switch (message.role) {
    case "user":
      return message.content.trim() ? `Human: ${message.content.trim()}` : null;
    case "assistant":
      return message.content.trim() ? `Assistant: ${message.content.trim()}` : null;
    case "tool_use":
      return renderToolUseSummary(message);
    case "tool_result":
      return null;
    default:
      return null;
  }
}

function renderTurnForEmbedding(messages: Message[]): string {
  return messages
    .map((message) => renderMessageForEmbedding(message))
    .filter((entry): entry is string => Boolean(entry))
    .join("\n");
}

export function chunkConversationMessages(
  conversation: Pick<SearchChunk, "conversationId"> & {
    title: string;
    summary: string;
  },
  messages: Message[],
): SearchChunk[] {
  const chunks: SearchChunk[] = [];
  let chunkIndex = 0;

  const metadataChunkText = buildMetadataChunkText(conversation.title, conversation.summary);
  if (metadataChunkText) {
    chunks.push({
      conversationId: conversation.conversationId,
      chunkIndex,
      startMessageIndex: -1,
      endMessageIndex: -1,
      text: metadataChunkText,
    });
    chunkIndex += 1;
  }

  for (const turn of groupMessagesIntoTurns(messages)) {
    const rendered = renderTurnForEmbedding(turn.messages);
    if (!rendered.trim()) {
      continue;
    }

    for (const segment of splitLongChunkText(rendered)) {
      chunks.push({
        conversationId: conversation.conversationId,
        chunkIndex,
        startMessageIndex: turn.startMessageIndex,
        endMessageIndex: turn.endMessageIndex,
        text: segment,
      });
      chunkIndex += 1;
    }
  }

  return chunks;
}

function buildMetadataChunkText(title: string, summary: string): string {
  const parts: string[] = [];

  if (title.trim()) {
    parts.push(`Title: ${title.trim()}`);
  }

  if (summary.trim()) {
    parts.push(`Summary: ${summary.trim()}`);
  }

  return parts.join("\n");
}

function splitLongChunkText(text: string): string[] {
  if (estimateTokens(text) <= TARGET_CHUNK_TOKENS) {
    return [text];
  }

  const segments: string[] = [];
  let offset = 0;

  while (offset < text.length) {
    const end = Math.min(offset + TARGET_CHUNK_CHARS, text.length);
    const segment = text.slice(offset, end).trim();
    if (segment) {
      segments.push(segment);
    }

    if (end >= text.length) {
      break;
    }

    offset = Math.max(0, end - OVERLAP_CHARS);
  }

  return segments;
}

function renderToolUseSummary(message: Message): string | null {
  const toolName = message.toolName?.trim();
  if (!toolName) {
    return null;
  }

  const summary = summarizeToolInput(toolName, message.toolInput);
  return summary ? `${toolName}: ${summary}` : toolName;
}

function summarizeToolInput(toolName: string, input: unknown): string | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const record = input as Record<string, unknown>;
  const preferredKeys = preferredToolInputKeys(toolName);

  for (const key of preferredKeys) {
    const value = record[key];
    const formatted = formatToolInputValue(key, value);
    if (formatted) {
      return formatted;
    }
  }

  for (const [key, value] of Object.entries(record)) {
    const formatted = formatToolInputValue(key, value);
    if (formatted) {
      return formatted;
    }
  }

  return null;
}

function preferredToolInputKeys(toolName: string): string[] {
  switch (toolName.toLowerCase()) {
    case "bash":
    case "exec_command":
      return ["command", "cmd"];
    case "read":
    case "write":
    case "edit":
      return ["file_path", "path", "target_file"];
    case "grep":
      return ["pattern", "glob"];
    case "glob":
      return ["pattern"];
    default:
      return ["path", "file_path", "pattern", "glob", "command", "cmd"];
  }
}

function formatToolInputValue(key: string, value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    const normalizedKey = key.replace(/_/g, "");
    if (normalizedKey === "command" || normalizedKey === "cmd") {
      return value.trim();
    }

    return `${key}=${JSON.stringify(value.trim())}`;
  }

  if (Array.isArray(value) && value.length > 0) {
    const first = value.find((entry) => typeof entry === "string");
    if (typeof first === "string" && first.trim()) {
      return `${key}=${JSON.stringify(first.trim())}`;
    }
  }

  return null;
}
