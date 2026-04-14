import type { Config } from "../config/schema.js";
import type { Message } from "../models/conversation.js";
import type { ClogWarning } from "../models/warnings.js";

export interface DiscoveredConversation {
  sourceId: string;
  sourcePath: string;
  metadata: {
    title: string;
    summary: string;
    projectName: string | null;
    projectPath: string | null;
    slug: string | null;
    createdAt: string;
  };
}

export interface DiscoverOptions {
  onWarning?: (warning: ClogWarning) => void;
}

export interface SourceAdapter {
  name: string;
  discover(options?: DiscoverOptions): AsyncIterable<DiscoveredConversation>;
  parseMessages(filePath: string): Promise<Message[]>;
  watchPaths(): string[];
}

export type SourceAdapterFactory = (config: Config) => SourceAdapter;
