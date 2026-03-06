import { z } from "zod";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { ConversationMeta } from "../models/conversation.js";

export const MetaJsonSchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string().default(""),
  tags: z.array(z.string()).default([]),
  author: z.string(),
  project: z.string().nullable().default(null),
  publishedAt: z.string(),
  modifiedAt: z.string(),
  source: z.string(),
  createdAt: z.string(),
  slug: z.string().nullable().default(null),
});

export type MetaJson = z.infer<typeof MetaJsonSchema>;

export async function readMetaJson(filePath: string): Promise<MetaJson | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return MetaJsonSchema.parse(parsed);
  } catch {
    return null;
  }
}

export async function writeMetaJson(
  filePath: string,
  conv: ConversationMeta
): Promise<void> {
  const meta: MetaJson = {
    id: conv.id,
    title: conv.title,
    summary: conv.summary,
    tags: conv.tags,
    author: conv.author,
    project: conv.project,
    publishedAt: conv.publishedAt || new Date().toISOString(),
    modifiedAt: conv.modifiedAt,
    source: conv.source,
    createdAt: conv.createdAt,
    slug: conv.slug,
  };
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(meta, null, 2) + "\n", "utf-8");
}

export function metaToConversation(
  meta: MetaJson,
  opts: { origin: string; sourcePath: string; filePath: string }
): ConversationMeta {
  return {
    id: meta.id,
    sourceId: meta.id,
    source: meta.source,
    title: meta.title,
    summary: meta.summary,
    author: meta.author,
    project: meta.project,
    tags: meta.tags,
    slug: meta.slug,
    createdAt: meta.createdAt,
    discoveredAt: new Date().toISOString(),
    modifiedAt: meta.modifiedAt,
    state: "published",
    publishedAt: meta.publishedAt,
    publishVersion: 0,
    sourcePath: opts.sourcePath,
    filePath: opts.filePath,
    sourceMtime: null,
    indexedAt: null,
    origin: opts.origin,
  };
}
