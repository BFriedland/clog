import fs from "node:fs";

import { glob, type GlobOptions } from "glob";

import type { Config } from "../config/schema.js";
import type {
  Message,
  RelationshipInspection,
  RelationshipInspectionState,
  ConversationRelationship,
} from "../models/conversation.js";
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
  relationshipInspection: RelationshipInspectionState;
  relationships: ConversationRelationship[];
}

export interface DiscoverOptions {
  onWarning?: (warning: ClogWarning) => void;
  onIncomplete?: () => void;
}

export interface SourceAdapter {
  readonly name: string;
  readonly relationshipInspectionVersion: number;
  readonly transcriptProjectionVersion: number;
  discover(options?: DiscoverOptions): AsyncIterable<DiscoveredConversation>;
  inspectRelationships(
    filePath: string,
    options?: DiscoverOptions,
  ): Promise<RelationshipInspection>;
  parseTranscript(filePath: string): Promise<Transcript>;
  watchPaths(): string[];
}

export interface Transcript {
  messages: Message[];
  warnings: ClogWarning[];
}

export type SourceAdapterFactory = (config: Config) => SourceAdapter;

export type AdapterVersionClassification =
  | "current"
  | "refreshable"
  | "version_skew";

export function classifyAdapterVersion(
  storedVersion: number | null,
  localVersion: number,
): AdapterVersionClassification {
  if (!Number.isInteger(localVersion) || localVersion < 1) {
    throw new Error("Adapter contract versions must be positive integers.");
  }
  if (storedVersion === localVersion) {
    return "current";
  }
  if (storedVersion == null || storedVersion < localVersion) {
    return "refreshable";
  }
  return "version_skew";
}

export function relationshipInspectionNotImplemented(
  version: number,
): RelationshipInspection {
  return {
    status: "unknown",
    version,
    diagnostic: "relationship_inspection_not_implemented",
    relationships: [],
  };
}

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
