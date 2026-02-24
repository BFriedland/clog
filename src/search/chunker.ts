/**
 * Turn-based chunking of conversations for embedding.
 *
 * Converts a conversation's messages into text chunks suitable for
 * vector embedding. Pure logic — no search dependencies.
 */

import type { Message, ConversationMeta } from "../models/conversation.js";
import type { Chunk } from "./types.js";

// Rough token estimation: ~4 chars per token
const CHARS_PER_TOKEN = 4;
const MAX_CHUNK_TOKENS = 800;
const OVERLAP_TOKENS = 100;
const MAX_CHUNK_CHARS = MAX_CHUNK_TOKENS * CHARS_PER_TOKEN; // 3200
const OVERLAP_CHARS = OVERLAP_TOKENS * CHARS_PER_TOKEN; // 400

interface Turn {
  startIndex: number;
  endIndex: number; // exclusive
  messages: Message[];
}

/**
 * Groups messages into turns. A turn starts with a user message
 * and includes all subsequent messages until the next user message.
 */
export function groupIntoTurns(messages: Message[]): Turn[] {
  const turns: Turn[] = [];
  let currentMessages: Message[] = [];
  let startIndex = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "user" && currentMessages.length > 0) {
      turns.push({ startIndex, endIndex: i, messages: currentMessages });
      currentMessages = [];
      startIndex = i;
    }
    currentMessages.push(msg);
  }

  if (currentMessages.length > 0) {
    turns.push({
      startIndex,
      endIndex: messages.length,
      messages: currentMessages,
    });
  }

  return turns;
}

/**
 * Renders a turn's messages into embeddable text.
 *
 * Includes: user messages, assistant text, tool names (e.g. "Tool: Read").
 * Excludes: tool_result (bulk output like file dumps / command output).
 */
export function renderTurn(messages: Message[]): string {
  const parts: string[] = [];

  for (const msg of messages) {
    switch (msg.role) {
      case "user":
        parts.push(`Human: ${msg.content}`);
        break;
      case "assistant":
        if (msg.content.trim()) {
          parts.push(`Assistant: ${msg.content}`);
        }
        break;
      case "tool_use":
        if (msg.toolName) {
          parts.push(`Tool: ${msg.toolName}`);
        }
        break;
      // tool_result excluded — bulk output (file dumps, command output)
      // is low signal-to-noise for embeddings
    }
  }

  return parts.join("\n");
}

/**
 * Splits text that exceeds MAX_CHUNK_CHARS into overlapping segments.
 */
export function splitLongText(text: string): string[] {
  if (text.length <= MAX_CHUNK_CHARS) return [text];

  const segments: string[] = [];
  let offset = 0;

  while (offset < text.length) {
    const end = Math.min(offset + MAX_CHUNK_CHARS, text.length);
    segments.push(text.slice(offset, end));
    if (end >= text.length) break;
    offset = end - OVERLAP_CHARS;
  }

  return segments;
}

/**
 * Chunk a conversation for embedding.
 *
 * Produces a metadata chunk (title + summary) at index 0, followed by
 * turn-based content chunks. Long turns are split with overlap.
 */
export function chunkConversation(
  conv: Pick<ConversationMeta, "id" | "title" | "summary">,
  messages: Message[],
): Chunk[] {
  const chunks: Chunk[] = [];
  let chunkIndex = 0;

  // Metadata chunk: title + summary
  const metaParts: string[] = [];
  if (conv.title) metaParts.push(`Title: ${conv.title}`);
  if (conv.summary) metaParts.push(`Summary: ${conv.summary}`);

  if (metaParts.length > 0) {
    chunks.push({
      conversationId: conv.id,
      chunkIndex: chunkIndex++,
      messageStartIndex: -1,
      messageEndIndex: -1,
      text: metaParts.join("\n"),
    });
  }

  // Turn-based chunks
  const turns = groupIntoTurns(messages);

  for (const turn of turns) {
    const text = renderTurn(turn.messages);
    if (!text.trim()) continue;

    const segments = splitLongText(text);
    for (const segment of segments) {
      chunks.push({
        conversationId: conv.id,
        chunkIndex: chunkIndex++,
        messageStartIndex: turn.startIndex,
        messageEndIndex: turn.endIndex,
        text: segment,
      });
    }
  }

  return chunks;
}
