import { z } from "zod";

export const conversationStateSchema = z.enum([
  "discovered",
  "staged",
  "published",
]);

export type ConversationState = z.infer<typeof conversationStateSchema>;

export const messageRoleSchema = z.enum([
  "user",
  "assistant",
  "tool_use",
  "tool_result",
]);

export type MessageRole = z.infer<typeof messageRoleSchema>;

export const messageSchema = z.object({
  role: messageRoleSchema,
  content: z.string(),
  timestamp: z.string().nullable(),
  toolName: z.string().optional(),
  toolInput: z.unknown().optional(),
});

export type Message = z.infer<typeof messageSchema>;

export const conversationMetaSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  source: z.string(),
  title: z.string(),
  summary: z.string(),
  author: z.string(),
  projectName: z.string().nullable(),
  projectPath: z.string().nullable(),
  tags: z.array(z.string()),
  slug: z.string().nullable(),
  createdAt: z.string(),
  discoveredAt: z.string(),
  modifiedAt: z.string(),
  state: conversationStateSchema,
  publishedAt: z.string().nullable(),
  publishedMessageCount: z.number().int().nonnegative().nullable(),
  publishVersion: z.number().int().nonnegative(),
  sourcePath: z.string(),
  filePath: z.string().nullable(),
  sourceMtime: z.string().nullable(),
  indexedAt: z.string().nullable(),
  origin: z.string().nullable(),
});

export type ConversationMeta = z.infer<typeof conversationMetaSchema>;
