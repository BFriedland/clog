import fs from "node:fs";

import { glob, type GlobOptions } from "glob";

import type { Config } from "../config/schema.js";
import type { Message } from "../models/conversation.js";
import type { ClogWarning } from "../models/warnings.js";

export const SCAN_METADATA_MAX_LINES = 100;

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
  onIncomplete?: () => void;
}

export interface SourceAdapter {
  name: string;
  discover(options?: DiscoverOptions): AsyncIterable<DiscoveredConversation>;
  parseMessages(filePath: string): Promise<Message[]>;
  watchPaths(): string[];
}

export type SourceAdapterFactory = (config: Config) => SourceAdapter;

export async function globSourceFiles(
  pattern: string,
  cwd: string,
  onIncomplete?: () => void,
): Promise<string[]> {
  // glob treats directory-read failures as empty branches. Observe those
  // failures so callers can retain partial matches without claiming a complete scan.
  const monitoredFs: NonNullable<GlobOptions["fs"]> = {
    readdir(filePath, options, callback) {
      fs.readdir(filePath, options, (error, entries) => {
        if (error) {
          onIncomplete?.();
        }
        callback(error, entries);
      });
    },
    promises: {
      async readdir(filePath, options) {
        try {
          return await fs.promises.readdir(filePath, options);
        } catch (error) {
          onIncomplete?.();
          throw error;
        }
      },
    },
  };

  return glob(pattern, {
    cwd,
    absolute: true,
    nodir: true,
    fs: monitoredFs,
  });
}
