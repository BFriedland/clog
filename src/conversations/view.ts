import { isDeepStrictEqual } from "node:util";

import type { DiscoveredConversation } from "../adapters/adapter.js";
import { classifyAdapterVersion } from "../adapters/adapter.js";
import type { Config } from "../config/schema.js";
import {
  listConversations,
  type ListConversationFilters,
} from "../db/index.js";
import type {
  ConversationMeta,
  ConversationState,
} from "../models/conversation.js";
import {
  preserveConfirmedRelationship,
  summaryKindForDiscoveredSummary,
} from "../models/conversation.js";
import { ClogError, UsageError } from "../utils/errors.js";
import { parseSourceQualifiedId } from "../utils/source-keys.js";
import { pathMatchesBoundary } from "../cli/clogignore.js";

export interface LocalDiscoveryCandidate {
  source: string;
  sourceId: string;
  sourcePath: string;
  sourceMtime: string;
  metadata: DiscoveredConversation["metadata"];
  relationshipInspection: DiscoveredConversation["relationshipInspection"];
  relationships: DiscoveredConversation["relationships"];
}

interface IgnoredLocalDiscoveryCandidate {
  source: string;
  sourceId: string;
  sourcePath: string;
  sourceMtime: string;
  metadata: DiscoveredConversation["metadata"];
  relationshipInspection: DiscoveredConversation["relationshipInspection"];
  relationships: DiscoveredConversation["relationships"];
}

interface SourceDiscoveryStatus {
  source: string;
  complete: boolean;
}

export interface LocalScanSnapshot {
  scanTime: string;
  author: string;
  candidates: LocalDiscoveryCandidate[];
  ignoredCandidates: IgnoredLocalDiscoveryCandidate[];
  sourceStatuses: SourceDiscoveryStatus[];
}

export interface ConversationViewFilters extends ListConversationFilters {
  states?: ConversationState[];
}

export interface ResolveConversationViewOptions {
  states?: ConversationState[];
  scanSnapshot?: LocalScanSnapshot;
  filters?: Omit<ConversationViewFilters, "states">;
}

export function passesConfigPathFilters(
  source: string,
  config: Config,
  projectPath: string,
): boolean {
  const sourceConfig = config.sources[source as keyof Config["sources"]];

  if (!sourceConfig) {
    return true;
  }

  if (
    sourceConfig.includePaths.length > 0 &&
    !sourceConfig.includePaths.some((entry) => pathMatchesBoundary(projectPath, entry))
  ) {
    return false;
  }

  if (sourceConfig.excludePaths.some((entry) => pathMatchesBoundary(projectPath, entry))) {
    return false;
  }

  return true;
}

export function buildDiscoveredConversation(
  candidate: LocalDiscoveryCandidate,
  author: string,
  timestamp: string,
): ConversationMeta {
  return {
    id: candidate.sourceId,
    sourceId: candidate.sourceId,
    source: candidate.source,
    title: candidate.metadata.title,
    summary: candidate.metadata.summary,
    summaryKind: summaryKindForDiscoveredSummary(candidate.metadata.summary),
    summaryExtraction: null,
    author,
    projectName: candidate.metadata.projectName,
    projectPath: candidate.metadata.projectPath,
    tags: [],
    slug: candidate.metadata.slug,
    createdAt: candidate.metadata.createdAt,
    discoveredAt: timestamp,
    modifiedAt: candidate.sourceMtime,
    state: "unsaved",
    savedAt: null,
    savedMessageCount: null,
    saveVersion: 0,
    transcriptProjectionVersion: null,
    sourcePath: candidate.sourcePath,
    filePath: null,
    sourceMtime: candidate.sourceMtime,
    indexedAt: null,
    originKind: "local",
    originRef: null,
    relationshipInspection: candidate.relationshipInspection,
    relationships: candidate.relationships,
  };
}

export async function listConversationView(
  filters: ConversationViewFilters = {},
  scanSnapshot?: LocalScanSnapshot,
): Promise<ConversationMeta[]> {
  const requestedStates = filters.states ?? ["saved", "unsaved"];
  const includesSaved = requestedStates.includes("saved");
  const includesUnsaved = requestedStates.includes("unsaved");

  if (includesUnsaved && !scanSnapshot) {
    throw new Error("A local scan snapshot is required for an unsaved conversation view.");
  }

  // Load saved rows before filtering so their source identities suppress scan
  // candidates even when the saved metadata itself does not pass the filter.
  const allSaved = await listConversations();
  const savedIdentityKeys = new Set(
    allSaved.map((conversation) => identityKey(conversation.source, conversation.sourceId)),
  );
  const unsavedByIdentity = new Map<string, ConversationMeta>();

  if (scanSnapshot) {
    for (const candidate of scanSnapshot.candidates) {
      const key = identityKey(candidate.source, candidate.sourceId);
      if (savedIdentityKeys.has(key)) {
        continue;
      }
      unsavedByIdentity.set(
        key,
        buildDiscoveredConversation(candidate, scanSnapshot.author, scanSnapshot.scanTime),
      );
    }
  }

  const composed = [
    ...(includesSaved ? allSaved : []),
    ...(includesUnsaved ? unsavedByIdentity.values() : []),
  ];

  return composed
    .filter((conversation) => conversationPassesViewFilters(conversation, filters))
    .sort(compareConversationViewRows);
}

export async function resolveConversationView(
  input: string,
  options: ResolveConversationViewOptions = {},
): Promise<ConversationMeta> {
  const parsed = parseSourceQualifiedId(input);
  if (!parsed.ok) {
    throw new UsageError(
      `Invalid source-qualified conversation ID "${input}". Use "<prefix>@<source>".`,
    );
  }

  if (parsed.value.prefix.length < 4) {
    throw new UsageError("Conversation IDs must use at least 4 characters.");
  }

  const states = options.states ?? ["saved", "unsaved"];
  const candidates = await listConversationView(
    { ...options.filters, states },
    options.scanSnapshot,
  );
  const prefix = parsed.value.prefix.toLowerCase();
  const matches = candidates.filter((conversation) => {
    return (
      (parsed.value.source == null || conversation.source === parsed.value.source) &&
      conversation.id.toLowerCase().startsWith(prefix)
    );
  });

  if (matches.length > 1) {
    throw new ClogError(buildAmbiguousConversationMessage(input, matches));
  }

  if (states.includes("unsaved") && options.scanSnapshot) {
    const incompleteSources = relevantIncompleteSources(
      parsed.value.source,
      options.scanSnapshot,
    );
    const exactQualifiedMatch =
      parsed.value.source != null &&
      matches.length === 1 &&
      matches[0]!.id.toLowerCase() === prefix &&
      !incompleteSources.includes(parsed.value.source);

    if (incompleteSources.length > 0 && !exactQualifiedMatch) {
      throw new ClogError(
        `Could not determine whether conversation "${input}" exists because source discovery was incomplete for ${incompleteSources.join(", ")}.`,
      );
    }
  }

  if (matches.length === 0) {
    throw new ClogError(`No conversation matches "${input}".`);
  }

  return matches[0]!;
}

export function findScanCandidateForConversation(
  conversation: Pick<ConversationMeta, "source" | "sourceId">,
  scanSnapshot: LocalScanSnapshot,
): LocalDiscoveryCandidate | null {
  return (
    scanSnapshot.candidates.find(
      (candidate) =>
        candidate.source === conversation.source &&
        candidate.sourceId === conversation.sourceId,
    ) ?? null
  );
}

export function attachCurrentSourceCandidate(
  conversation: ConversationMeta,
  scanSnapshot: LocalScanSnapshot,
): ConversationMeta {
  const candidate = findScanCandidateForConversation(conversation, scanSnapshot);
  if (!candidate) {
    return conversation;
  }

  return {
    ...conversation,
    sourcePath: candidate.sourcePath,
    sourceMtime: candidate.sourceMtime,
  };
}

export function attachCurrentRelationshipInspection(
  conversation: ConversationMeta,
  candidate: LocalDiscoveryCandidate | null | undefined,
): ConversationMeta {
  if (
    conversation.state !== "saved" ||
    !candidate ||
    candidate.relationshipInspection.version == null
  ) {
    return conversation;
  }

  const versionClassification = classifyAdapterVersion(
    conversation.relationshipInspection.version,
    candidate.relationshipInspection.version,
  );
  if (versionClassification === "version_skew") {
    return conversation;
  }

  const refreshedInspection = preserveConfirmedRelationship(conversation, {
    ...candidate.relationshipInspection,
    relationships: candidate.relationships,
  });
  if (
    versionClassification === "current" &&
    !isDeepStrictEqual(
      {
        ...conversation.relationshipInspection,
        relationships: conversation.relationships,
      },
      refreshedInspection,
    )
  ) {
    throw new ClogError(
      `Conversation ${conversation.id.slice(0, 8)} has conflicting saved and live relationship metadata for inspection version ${candidate.relationshipInspection.version}. The saved copy was left unchanged.`,
    );
  }

  return {
    ...conversation,
    relationshipInspection: {
      status: refreshedInspection.status,
      version: refreshedInspection.version,
      diagnostic: refreshedInspection.diagnostic,
    },
    relationships: refreshedInspection.relationships,
  };
}

export function isSourceDiscoveryComplete(
  source: string,
  scanSnapshot: LocalScanSnapshot,
): boolean {
  const status = scanSnapshot.sourceStatuses.find((candidate) => candidate.source === source);
  return status?.complete ?? true;
}

function conversationPassesViewFilters(
  conversation: ConversationMeta,
  filters: ConversationViewFilters,
): boolean {
  if (
    filters.projectName &&
    conversation.projectName?.toLowerCase() !== filters.projectName.toLowerCase()
  ) {
    return false;
  }

  if (filters.author && conversation.author !== filters.author) {
    return false;
  }

  if (filters.indexed != null && (conversation.indexedAt != null) !== filters.indexed) {
    return false;
  }

  if (filters.origin && !conversationMatchesOrigin(conversation, filters.origin)) {
    return false;
  }

  if (
    filters.curatedDefault &&
    conversation.originKind !== "local" &&
    conversation.author !== filters.curatedDefault.author
  ) {
    return false;
  }

  if (filters.tag) {
    const normalizedTag = filters.tag.trim().toLowerCase();
    if (!conversation.tags.some((tag) => tag.trim().toLowerCase() === normalizedTag)) {
      return false;
    }
  }

  return true;
}

function conversationMatchesOrigin(
  conversation: ConversationMeta,
  origin: NonNullable<ListConversationFilters["origin"]>,
): boolean {
  if (origin === "local") {
    return conversation.originKind === "local";
  }
  if (origin === "remote") {
    return conversation.originKind !== "local";
  }
  return (
    conversation.originKind === origin.kind &&
    (origin.ref === undefined || conversation.originRef === origin.ref)
  );
}

function compareConversationViewRows(
  left: ConversationMeta,
  right: ConversationMeta,
): number {
  const leftInstant = Date.parse(left.createdAt);
  const rightInstant = Date.parse(right.createdAt);
  const leftValid = !Number.isNaN(leftInstant);
  const rightValid = !Number.isNaN(rightInstant);

  if (leftValid && rightValid && leftInstant !== rightInstant) {
    return rightInstant < leftInstant ? -1 : 1;
  }
  if (leftValid !== rightValid) {
    return leftValid ? -1 : 1;
  }
  return left.id.localeCompare(right.id);
}

function relevantIncompleteSources(
  qualifiedSource: string | null,
  scanSnapshot: LocalScanSnapshot,
): string[] {
  return scanSnapshot.sourceStatuses
    .filter(
      (status) =>
        !status.complete &&
        (qualifiedSource == null || status.source === qualifiedSource),
    )
    .map((status) => status.source);
}

function buildAmbiguousConversationMessage(
  input: string,
  matches: ConversationMeta[],
): string {
  const rendered = matches
    .map((conversation) => `${conversation.id}@${conversation.source}`)
    .join(", ");
  return `Conversation ID "${input}" is ambiguous. Matches: ${rendered}`;
}

function identityKey(source: string, sourceId: string): string {
  return `${source}\u0000${sourceId}`;
}
