import type {
  DiscoveredConversation,
  Message,
} from "../models/conversation.js";

export interface SourceAdapter {
  name: string;
  discover(): AsyncIterable<DiscoveredConversation>;
  parseMessages(filePath: string): Promise<Message[]>;
  watchPaths(): string[];
}
