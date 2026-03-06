import { z } from "zod";

export const MessageSchema = z.object({
  role: z.enum(["user", "assistant", "tool_use", "tool_result"]),
  content: z.string(),
  timestamp: z.string().nullable(),
  toolName: z.string().optional(),
  toolInput: z.unknown().optional(),
  toolOutput: z.unknown().optional(),
});

export type Message = z.infer<typeof MessageSchema>;

export const ConversationStateSchema = z.enum([
  "discovered",
  "staged",
  "published",
]);

export type ConversationState = z.infer<typeof ConversationStateSchema>;

export const ConversationMetaSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  source: z.string(),
  title: z.string(),
  summary: z.string(),
  author: z.string(),
  project: z.string().nullable(),
  tags: z.array(z.string()),
  slug: z.string().nullable(),
  createdAt: z.string(),
  discoveredAt: z.string(),
  modifiedAt: z.string(),
  state: ConversationStateSchema,
  publishedAt: z.string().nullable(),
  publishVersion: z.number(),
  sourcePath: z.string(),
  filePath: z.string().nullable(),
  sourceMtime: z.string().nullable(),
  indexedAt: z.string().nullable(),
  origin: z.string().nullable().default(null),
});

export type ConversationMeta = z.infer<typeof ConversationMetaSchema>;

export const DiscoveredConversationSchema = z.object({
  sourceId: z.string(),
  sourcePath: z.string(),
  metadata: z.object({
    title: z.string(),
    summary: z.string(),
    project: z.string().nullable(),
    slug: z.string().nullable(),
    createdAt: z.string(),
  }),
});

export type DiscoveredConversation = z.infer<
  typeof DiscoveredConversationSchema
>;
