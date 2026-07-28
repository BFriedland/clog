import fs from "node:fs/promises";

import { isGitConversation, isNonLocalConversation } from "../db/index.js";
import type {
  ConversationMeta,
  ConversationState,
  Message,
} from "../models/conversation.js";
import { ClogError } from "../utils/errors.js";
import { resolveContentPath } from "./common.js";

export interface ConversationExport {
  id: string;
  source: string;
  title: string;
  summary: string;
  summaryKind: ConversationMeta["summaryKind"];
  extraction: ConversationMeta["summaryExtraction"];
  author: string;
  projectName: string | null;
  tags: string[];
  slug: string | null;
  createdAt: string;
  savedAt: string | null;
  state: ConversationState;
  messages: Message[];
}

export function buildConversationExport(
  conversation: ConversationMeta,
  messages: Message[],
): ConversationExport {
  return {
    id: conversation.id,
    source: conversation.source,
    title: conversation.title,
    summary: conversation.summary,
    summaryKind: conversation.summaryKind,
    extraction: conversation.summaryExtraction,
    author: conversation.author,
    projectName: conversation.projectName,
    tags: [...conversation.tags],
    slug: conversation.slug,
    createdAt: conversation.createdAt,
    savedAt: conversation.savedAt,
    state: conversation.state,
    messages,
  };
}

export function serializeConversationJson(
  exported: ConversationExport | ConversationExport[],
): string {
  return `${serializeJsonWithoutTrailingNewline(exported)}\n`;
}

export function renderConversationMarkdown(
  conversation: ConversationMeta,
  messages: Message[],
): string {
  const exported = buildConversationExport(conversation, messages);
  const frontmatterLines = ["---"];
  frontmatterLines.push(`id: ${quoteYamlString(exported.id)}`);
  frontmatterLines.push(`source: ${quoteYamlString(exported.source)}`);
  frontmatterLines.push(`title: ${quoteYamlString(exported.title)}`);
  if (exported.summary !== "") {
    frontmatterLines.push(`summary: ${quoteYamlString(exported.summary)}`);
  }
  if (exported.summaryKind !== "none") {
    frontmatterLines.push(`summaryKind: ${quoteYamlString(exported.summaryKind)}`);
  }
  if (exported.extraction != null) {
    frontmatterLines.push(
      `extraction: ${quoteYamlString(JSON.stringify(exported.extraction))}`,
    );
  }
  frontmatterLines.push(`author: ${quoteYamlString(exported.author)}`);
  if (exported.projectName != null) {
    frontmatterLines.push(`project: ${quoteYamlString(exported.projectName)}`);
  }
  if (exported.tags.length > 0) {
    frontmatterLines.push(
      `tags: [${exported.tags.map((tag) => quoteYamlString(tag)).join(", ")}]`,
    );
  }
  if (exported.slug != null) {
    frontmatterLines.push(`slug: ${quoteYamlString(exported.slug)}`);
  }
  frontmatterLines.push(`created: ${quoteYamlString(exported.createdAt)}`);
  if (exported.savedAt != null) {
    frontmatterLines.push(`saved: ${quoteYamlString(exported.savedAt)}`);
  }
  frontmatterLines.push(`state: ${quoteYamlString(exported.state)}`);
  frontmatterLines.push(`messages: ${exported.messages.length}`);
  frontmatterLines.push("---");

  const transcript = exported.messages
    .map((message) => renderMarkdownMessage(message))
    .join("\n\n");

  return `${frontmatterLines.join("\n")}\n${transcript}${transcript ? "\n" : ""}`;
}

export async function readConversationRaw(
  conversation: ConversationMeta,
): Promise<Buffer> {
  const contentPath = resolveContentPath(conversation);

  try {
    return await fs.readFile(contentPath);
  } catch (error) {
    if (
      error != null &&
      typeof error === "object" &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      if (conversation.state === "unsaved") {
        throw new ClogError(
          `Source file is missing for ${conversation.id}. Run "clog status" to rescan your sources.`,
        );
      }

      if (isGitConversation(conversation)) {
        throw new ClogError(
          `Remote checkout file is missing for ${conversation.id}. Run "clog refresh" to inspect the checkout, or "clog sync pull" to re-sync it.`,
        );
      }

      if (isNonLocalConversation(conversation)) {
        throw new ClogError(
          `Imported content file is missing for ${conversation.id}. Remove the imported conversation and import it again from its source.`,
        );
      }

      throw new ClogError(
        `The saved copy is missing for ${conversation.id}. Run "clog save ${conversation.id.slice(0, 8)}" to recreate it from source if the source file is still available.`,
      );
    }

    throw error instanceof Error ? error : new Error(String(error));
  }
}

function renderMarkdownMessage(message: Message): string {
  const heading = getMarkdownHeading(message);
  const block = renderMarkdownMessageBlock(message);
  return block ? `${heading}\n\n${block}` : heading;
}

function getMarkdownHeading(message: Message): string {
  if (message.role === "user") {
    return "## User";
  }
  if (message.role === "assistant") {
    return "## Assistant";
  }
  if (message.role === "tool_use") {
    return message.toolName ? `## Tool Use: ${message.toolName}` : "## Tool Use";
  }
  return message.toolName ? `## Tool Result: ${message.toolName}` : "## Tool Result";
}

function renderMarkdownMessageBlock(message: Message): string | null {
  if (message.role === "tool_use") {
    if (message.toolInput === undefined) {
      return null;
    }
    if (typeof message.toolInput === "string") {
      return renderFencedBlock("text", message.toolInput);
    }
    return renderFencedBlock("json", serializeJsonWithoutTrailingNewline(message.toolInput));
  }

  return renderFencedBlock("text", message.content);
}

function renderFencedBlock(info: string, content: string): string {
  const maxRun = Math.max(
    ...Array.from(content.matchAll(/`+/g), (match) => match[0].length),
    0,
  );
  const fence = "`".repeat(Math.max(3, maxRun + 1));
  return `${fence}${info}\n${content}\n${fence}`;
}

function serializeJsonWithoutTrailingNewline(value: unknown): string {
  return JSON.stringify(canonicalizeJson(value), null, 2);
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeJson(entry));
  }

  if (value != null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const orderedKeys = isConversationMessageObject(value)
      ? ["role", "content", "timestamp", "toolName", "toolInput"].filter((key) =>
          Object.hasOwn(value as object, key),
        )
      : isConversationExportObject(value)
        ? [
            "id",
            "source",
            "title",
            "summary",
            "summaryKind",
            "extraction",
            "author",
            "projectName",
            "tags",
            "slug",
            "createdAt",
            "savedAt",
            "state",
            "messages",
          ]
        : entries.map(([key]) => key).sort((left, right) => left.localeCompare(right));

    return Object.fromEntries(
      orderedKeys.map((key) => [
        key,
        canonicalizeJson((value as Record<string, unknown>)[key]),
      ]),
    );
  }

  return value;
}

function isConversationMessageObject(value: unknown): value is Record<string, unknown> {
  return (
    value != null &&
    typeof value === "object" &&
    "role" in value &&
    "content" in value &&
    "timestamp" in value
  );
}

function isConversationExportObject(value: unknown): value is ConversationExport {
  return (
    value != null &&
    typeof value === "object" &&
    "id" in value &&
    "source" in value &&
    "messages" in value
  );
}

function quoteYamlString(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/"/g, '\\"')}"`;
}
