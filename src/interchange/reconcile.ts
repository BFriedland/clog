import fs from "node:fs/promises";
import path from "node:path";

import { classifyAdapterVersion } from "../adapters/adapter.js";
import { isSourceParseSupported } from "../adapters/registry.js";
import type { Config } from "../config/schema.js";
import {
  preserveConfirmedRelationship,
  type ConversationMeta,
  type SavedConversationMeta,
} from "../models/conversation.js";
import type { ClogWarning } from "../models/warnings.js";
import type { LocalDiscoveryCandidate } from "../conversations/view.js";
import { nowIso } from "../utils/time.js";
import { isValidSourceKey } from "../utils/source-keys.js";
import {
  readSidecar,
  scanConversationFiles,
  validateConversationFiles,
  type SidecarMeta,
  type ScannedConversationFiles,
  type ValidatedConversationFiles,
} from "./conversation-files.js";

interface SourceIdentity {
  source: string;
  id: string;
}

export interface GitValidatedConversationFiles {
  author: string;
  source: string;
  id: string;
  validated: ValidatedConversationFiles;
}

type GitScanResult =
  | { kind: "valid"; files: GitValidatedConversationFiles }
  | {
      kind: "invalid";
      scannedFiles: ScannedConversationFiles;
      warning: ClogWarning;
      reportWarning?: boolean;
      protectedIdentities: SourceIdentity[];
    };

export interface GitCheckoutScan {
  results: GitScanResult[];
  warnings: ClogWarning[];
}

type ReconcileSkipReason =
  | "ignored"
  | "duplicate"
  | "local_unsaved_owner"
  | "local_discovery_incomplete"
  | "local_saved_owner"
  | "file_owner"
  | "other_git_owner"
  | "invalid_files"
  | "adapter_version_skew";

export type ReconcileAction =
  | { kind: "insert"; files: GitValidatedConversationFiles; conversation: SavedConversationMeta }
  | {
      kind: "update";
      rowId: string;
      files: GitValidatedConversationFiles;
      conversation: SavedConversationMeta;
    }
  | { kind: "delete"; rowId: string }
  | {
      kind: "skip";
      reason: ReconcileSkipReason;
      message: string;
      files?: GitValidatedConversationFiles;
      scannedFiles?: ScannedConversationFiles;
      owner?: SavedConversationMeta;
    };

export interface GitReconciliationPlan {
  actions: ReconcileAction[];
  warnings: ClogWarning[];
  protectedIdentities: SourceIdentity[];
  deletedRowIds: string[];
  ignoredCount: number;
}

export interface PlanGitReconciliationArgs {
  scan: GitCheckoutScan;
  existingRows: SavedConversationMeta[];
  localCandidates?: LocalDiscoveryCandidate[];
  incompleteSources?: string[];
  localWarnings?: ClogWarning[];
  remoteUrl: string;
  ignoreRules?: string[];
  matchesIgnoreRule?: (
    rule: string,
    target: { sourceId: string; projectName: string | null },
  ) => boolean;
  deletionsEnabled?: boolean;
}

interface GitPathInfo {
  author: string | null;
  source: string | null;
  id: string;
  directoryDepth: number;
}

export async function scanGitCheckoutConversationFiles(
  rootDir: string,
  config: Config,
): Promise<GitCheckoutScan> {
  const checkoutTree = await scanGitCheckoutTree(rootDir);
  const allFiles = checkoutTree.files;
  const results: GitScanResult[] = [];
  const warnings: ClogWarning[] = [...checkoutTree.warnings];

  for (const scannedFiles of allFiles) {
    const pathInfo = getGitPathInfo(scannedFiles);
    const sourceDirectoryWarning = validateGitSourceDirectory(scannedFiles, pathInfo);
    if (sourceDirectoryWarning) {
      results.push({
        kind: "invalid",
        scannedFiles,
        warning: sourceDirectoryWarning,
        reportWarning: shouldReportInvalidPairWarning(pathInfo),
        protectedIdentities: await getProtectedIdentities(
          scannedFiles,
          sourceDirectoryWarning,
          pathInfo,
        ),
      });
      continue;
    }

    if (scannedFiles.metaExists && scannedFiles.jsonlExists) {
      const parsedMeta = await readSidecar(scannedFiles.metaPath);
      if (parsedMeta.ok && parsedMeta.meta.id === scannedFiles.stem) {
        const layoutWarning = validateGitLayoutMetadata(
          scannedFiles,
          parsedMeta.meta,
          pathInfo,
        );
        if (layoutWarning) {
          results.push({
            kind: "invalid",
            scannedFiles,
            warning: layoutWarning,
            reportWarning: shouldReportInvalidPairWarning(pathInfo),
            protectedIdentities: await getProtectedIdentities(
              scannedFiles,
              layoutWarning,
              pathInfo,
            ),
          });
          continue;
        }
      }
    }

    const validation = await validateConversationFiles(scannedFiles, config);
    if (validation.kind === "invalid") {
      const warning = addPathIdentityToWarning(validation.warning, pathInfo);
      results.push({
        kind: "invalid",
        scannedFiles,
        warning,
        reportWarning: shouldReportInvalidPairWarning(pathInfo),
        protectedIdentities: await getProtectedIdentities(scannedFiles, warning, pathInfo),
      });
      continue;
    }

    results.push({
      kind: "valid",
      files: {
        author: pathInfo.author!,
        source: pathInfo.source!,
        id: pathInfo.id,
        validated: validation.files,
      },
    });
  }

  return { results, warnings };
}

export function planGitReconciliation(
  args: PlanGitReconciliationArgs,
): GitReconciliationPlan {
  const {
    scan,
    existingRows,
    localCandidates = [],
    incompleteSources = [],
    localWarnings = [],
    remoteUrl,
    ignoreRules = [],
    matchesIgnoreRule,
    deletionsEnabled = true,
  } = args;
  const actions: ReconcileAction[] = [];
  const warnings = [...scan.warnings, ...localWarnings];
  const protectedIdentities: SourceIdentity[] = [];
  const protectedKeys = new Set<string>();
  const presentKeys = new Set<string>();
  const seenValidKeys = new Map<string, GitValidatedConversationFiles>();
  let ignoredCount = 0;

  const rowsByIdentity = new Map<string, SavedConversationMeta>();
  const inScopeRowsByIdentity = new Map<string, SavedConversationMeta>();
  const localCandidateKeys = new Set(
    localCandidates.map((candidate) => identityKey(candidate.source, candidate.sourceId)),
  );
  const incompleteSourceSet = new Set(incompleteSources);

  for (const row of existingRows) {
    const key = identityKey(row.source, row.sourceId);
    rowsByIdentity.set(key, row);
    if (isGitRowForRemote(row, remoteUrl)) {
      inScopeRowsByIdentity.set(key, row);
    }
  }

  for (const result of scan.results) {
    if (result.kind === "invalid") {
      if (result.reportWarning !== false) {
        warnings.push(result.warning);
      }
      actions.push({
        kind: "skip",
        reason: "invalid_files",
        message: result.warning.message,
        scannedFiles: result.scannedFiles,
      });
      protectAll(result.protectedIdentities, protectedKeys, protectedIdentities);
      continue;
    }

    const entry = result.files;
    const key = identityKey(entry.source, entry.id);
    const ignored =
      matchesIgnoreRule != null &&
      ignoreRules.some((rule) =>
        matchesIgnoreRule(rule, {
          sourceId: entry.id,
          projectName: entry.validated.meta.projectName,
        }),
      );

    if (ignored) {
      ignoredCount += 1;
      presentKeys.add(key);
      protectAll([{ source: entry.source, id: entry.id }], protectedKeys, protectedIdentities);
      actions.push({
        kind: "skip",
        reason: "ignored",
        message: `Skipping remote conversation ${formatGitFilesPath(entry)} because it matches clogignore.`,
        files: entry,
      });
      continue;
    }

    if (seenValidKeys.has(key)) {
      const winner = seenValidKeys.get(key)!;
      actions.push({
        kind: "skip",
        reason: "duplicate",
        message: `Skipping duplicate remote conversation ${formatGitFilesPath(entry)} - ${formatGitFilesPath(winner)} was chosen first by deterministic checkout order.`,
        files: entry,
      });
      presentKeys.add(key);
      continue;
    }

    seenValidKeys.set(key, entry);
    presentKeys.add(key);
    const existingForRemote = inScopeRowsByIdentity.get(key);

    if (!existingForRemote) {
      const owner = rowsByIdentity.get(key);
      if (owner && !isGitRowForRemote(owner, remoteUrl)) {
        actions.push({
          kind: "skip",
          reason: ownerSkipReason(owner),
          message: ownerSkipMessage(entry, owner),
          files: entry,
          owner,
        });
        continue;
      }

      if (!owner && localCandidateKeys.has(key)) {
        actions.push({
          kind: "skip",
          reason: "local_unsaved_owner",
          message: `Skipping remote conversation ${entry.id.slice(0, 8)} - a local unsaved source copy already exists. Run 'clog save ${entry.id.slice(0, 8)}' to keep the local copy.`,
          files: entry,
        });
        continue;
      }

      if (!owner && incompleteSourceSet.has(entry.source)) {
        actions.push({
          kind: "skip",
          reason: "local_discovery_incomplete",
          message: `Skipping remote conversation ${entry.id.slice(0, 8)} because the ${entry.source} scan did not complete, so clog could not determine whether a local unsaved source copy owns this identity.`,
          files: entry,
        });
        continue;
      }

      actions.push({
        kind: "insert",
        files: entry,
        conversation: buildConversationFromGitFiles(entry, remoteUrl),
      });
      continue;
    }

    if (
      classifyAdapterVersion(
        existingForRemote.transcriptProjectionVersion,
        entry.validated.transcriptProjectionVersion,
      ) === "version_skew" ||
      classifyAdapterVersion(
        existingForRemote.relationshipInspection.version,
        entry.validated.relationshipInspection.version,
      ) === "version_skew"
    ) {
      const warning: ClogWarning = {
        code: "adapter_version_skew",
        message:
          "Skipping a conversation that was saved by a newer clog version.",
        source: existingForRemote.source,
        conversation: {
          id: existingForRemote.id,
          source: existingForRemote.source,
        },
        guidance: "Upgrade clog before synchronizing this conversation again.",
      };
      warnings.push(warning);
      actions.push({
        kind: "skip",
        reason: "adapter_version_skew",
        message: warning.message,
        files: entry,
        owner: existingForRemote,
      });
      continue;
    }

    const updated = mergeGitFilesIntoConversation(existingForRemote, entry, remoteUrl);
    if (updated) {
      actions.push({
        kind: "update",
        rowId: existingForRemote.id,
        files: entry,
        conversation: updated,
      });
    }
  }

  const deletedRowIds: string[] = [];
  if (deletionsEnabled) {
    for (const [key, row] of inScopeRowsByIdentity) {
      if (presentKeys.has(key) || protectedKeys.has(key)) {
        continue;
      }
      actions.push({ kind: "delete", rowId: row.id });
      deletedRowIds.push(row.id);
    }
  }

  return {
    actions,
    warnings,
    protectedIdentities,
    deletedRowIds,
    ignoredCount,
  };
}

function buildConversationFromGitFiles(
  files: GitValidatedConversationFiles,
  remoteUrl: string,
): SavedConversationMeta {
  const now = nowIso();
  return {
    id: files.validated.meta.id,
    sourceId: files.validated.meta.id,
    source: files.validated.meta.source,
    title: files.validated.meta.title,
    summary: files.validated.meta.summary,
    summaryKind: files.validated.meta.summaryKind,
    summaryExtraction: files.validated.meta.summaryExtraction,
    author: files.validated.meta.author,
    projectName: files.validated.meta.projectName,
    projectPath: null,
    tags: [...files.validated.meta.tags],
    slug: files.validated.meta.slug,
    createdAt: files.validated.meta.createdAt,
    discoveredAt: now,
    modifiedAt: files.validated.meta.modifiedAt,
    state: "saved",
    savedAt: files.validated.meta.savedAt,
    savedMessageCount: files.validated.messageCount,
    saveVersion: 1,
    transcriptProjectionVersion: files.validated.transcriptProjectionVersion,
    sourcePath: files.validated.jsonlPath,
    filePath: files.validated.jsonlPath,
    sourceMtime: null,
    indexedAt: null,
    originKind: "git",
    originRef: remoteUrl,
    relationshipInspection: {
      status: files.validated.relationshipInspection.status,
      version: files.validated.relationshipInspection.version,
      diagnostic: files.validated.relationshipInspection.diagnostic,
    },
    relationships: files.validated.relationshipInspection.relationships,
  };
}

function mergeGitFilesIntoConversation(
  existing: SavedConversationMeta,
  files: GitValidatedConversationFiles,
  remoteUrl: string,
): SavedConversationMeta | null {
  const titleChanged = existing.title !== files.validated.meta.title;
  const summaryChanged = existing.summary !== files.validated.meta.summary;
  const contentChanged = existing.savedMessageCount !== files.validated.messageCount;
  const projectionChanged =
    existing.transcriptProjectionVersion !==
    files.validated.transcriptProjectionVersion;
  const refreshedRelationshipInspection = preserveConfirmedRelationship(
    existing,
    files.validated.relationshipInspection,
  );
  const relationshipChanged =
    JSON.stringify({
      ...existing.relationshipInspection,
      relationships: existing.relationships,
    }) !== JSON.stringify(refreshedRelationshipInspection);
  const pathChanged =
    existing.sourcePath !== files.validated.jsonlPath ||
    existing.filePath !== files.validated.jsonlPath;
  const extractionChanged =
    JSON.stringify(existing.summaryExtraction ?? null) !==
    JSON.stringify(files.validated.meta.summaryExtraction ?? null);

  const metadataChanged =
    titleChanged ||
    summaryChanged ||
    existing.author !== files.validated.meta.author ||
    existing.projectName !== files.validated.meta.projectName ||
    existing.slug !== files.validated.meta.slug ||
    existing.createdAt !== files.validated.meta.createdAt ||
    existing.modifiedAt !== files.validated.meta.modifiedAt ||
    existing.savedAt !== files.validated.meta.savedAt ||
    contentChanged ||
    existing.summaryKind !== files.validated.meta.summaryKind ||
    extractionChanged ||
    !tagsEqual(existing.tags, files.validated.meta.tags);

  if (
    !metadataChanged &&
    !projectionChanged &&
    !relationshipChanged &&
    !pathChanged
  ) {
    return null;
  }

  return {
    ...existing,
    title: files.validated.meta.title,
    summary: files.validated.meta.summary,
    summaryKind: files.validated.meta.summaryKind,
    summaryExtraction: files.validated.meta.summaryExtraction,
    author: files.validated.meta.author,
    projectName: files.validated.meta.projectName,
    tags: [...files.validated.meta.tags],
    slug: files.validated.meta.slug,
    createdAt: files.validated.meta.createdAt,
    modifiedAt: files.validated.meta.modifiedAt,
    savedAt: files.validated.meta.savedAt,
    savedMessageCount: files.validated.messageCount,
    transcriptProjectionVersion: files.validated.transcriptProjectionVersion,
    relationshipInspection: {
      status: refreshedRelationshipInspection.status,
      version: refreshedRelationshipInspection.version,
      diagnostic: refreshedRelationshipInspection.diagnostic,
    },
    relationships: refreshedRelationshipInspection.relationships,
    sourcePath: files.validated.jsonlPath,
    filePath: files.validated.jsonlPath,
    indexedAt:
      titleChanged || summaryChanged || contentChanged || projectionChanged
        ? null
        : existing.indexedAt,
    originKind: "git",
    originRef: remoteUrl,
  };
}

function getGitPathInfo(entry: ScannedConversationFiles): GitPathInfo {
  const parts = entry.relativeDir.split("/").filter(Boolean);
  return {
    author: parts[0] ?? null,
    source: parts[1] ?? null,
    id: entry.stem,
    directoryDepth: parts.length,
  };
}

async function scanGitCheckoutTree(rootDir: string): Promise<{
  files: ScannedConversationFiles[];
  warnings: ClogWarning[];
}> {
  const warnings = await collectSourceDirectoryWarnings(rootDir);
  const allFiles = await scanConversationFiles(rootDir, {
    shouldDescend: ({ relativeDir, entryName }) => {
      const parts = relativeDir.split("/").filter(Boolean);
      if (parts.length === 0) {
        return !entryName.startsWith(".");
      }

      return true;
    },
  });

  return { files: allFiles, warnings };
}

async function collectSourceDirectoryWarnings(
  rootDir: string,
): Promise<ClogWarning[]> {
  let authorEntries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    authorEntries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const warnings: ClogWarning[] = [];
  const authorNames = authorEntries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort(compareCodePoints);

  for (const author of authorNames) {
    const authorDir = path.join(rootDir, author);
    let sourceEntries: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      sourceEntries = await fs.readdir(authorDir, { withFileTypes: true });
    } catch {
      continue;
    }

    const sourceNames = sourceEntries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(compareCodePoints);

    for (const source of sourceNames) {
      if (!isValidSourceKey(source)) {
        warnings.push({
          code: "pair_layout_mismatch",
          message: `Invalid source directory "${author}/${source}" in remote checkout - the directory name is not a valid source key, so any conversations found there were skipped.`,
          source,
        });
        continue;
      }

      if (!isSourceParseSupported(source)) {
        warnings.push({
          code: "unsupported_source",
          message: `Unsupported source directory "${author}/${source}" in remote checkout - any conversations found there were skipped; matching conversations are protected from deletion.`,
          source,
        });
      }
    }
  }

  return warnings;
}

function validateGitSourceDirectory(
  entry: ScannedConversationFiles,
  pathInfo: GitPathInfo,
): ClogWarning | null {
  if (!pathInfo.author || !pathInfo.source || pathInfo.directoryDepth < 2) {
    return null;
  }

  if (isValidSourceKey(pathInfo.source)) {
    return null;
  }

  return {
    code: "pair_layout_mismatch",
    message: `Skipping remote conversation ${entry.stem} - source directory "${pathInfo.source}" is not a valid source key.`,
    conversation: { author: pathInfo.author, source: pathInfo.source, id: pathInfo.id },
    paths: [entry.metaPath, entry.jsonlPath],
  };
}

function validateGitLayoutMetadata(
  entry: ScannedConversationFiles,
  meta: SidecarMeta,
  pathInfo: GitPathInfo,
): ClogWarning | null {
  if (!pathInfo.author || !pathInfo.source || pathInfo.directoryDepth !== 2) {
    return {
      code: "pair_layout_mismatch",
      message: `Skipping remote conversation ${entry.stem} - expected git layout <author>/<source>/<id>.`,
      conversation: {
        author: pathInfo.author ?? undefined,
        source: meta.source,
        id: meta.id,
      },
      paths: [entry.metaPath, entry.jsonlPath],
    };
  }

  if (pathInfo.source !== meta.source) {
    return {
      code: "pair_layout_mismatch",
      message: `Skipping remote conversation ${entry.stem} - meta.source "${meta.source}" does not match directory "${pathInfo.source}".`,
      conversation: { author: pathInfo.author, source: pathInfo.source, id: pathInfo.id },
      path: entry.metaPath,
    };
  }

  if (pathInfo.author !== meta.author) {
    return {
      code: "pair_layout_mismatch",
      message: `Skipping remote conversation ${entry.stem} - meta.author "${meta.author}" does not match directory "${pathInfo.author}".`,
      conversation: { author: pathInfo.author, source: pathInfo.source, id: pathInfo.id },
      path: entry.metaPath,
    };
  }

  return null;
}

async function getProtectedIdentities(
  scannedFiles: ScannedConversationFiles,
  warning: ClogWarning,
  pathInfo: GitPathInfo,
): Promise<SourceIdentity[]> {
  const identities: SourceIdentity[] = [];

  if (pathInfo.source && isValidSourceKey(pathInfo.source)) {
    identities.push({ source: pathInfo.source, id: pathInfo.id });
  }

  if (warning.conversation && isValidSourceKey(warning.conversation.source)) {
    identities.push({ source: warning.conversation.source, id: warning.conversation.id });
  }

  if (scannedFiles.metaExists) {
    const identity = await readMetadataIdentity(scannedFiles.metaPath);
    if (identity && isValidSourceKey(identity.source)) {
      identities.push(identity);
    }
  }

  return uniqueIdentities(identities);
}

async function readMetadataIdentity(metaPath: string): Promise<SourceIdentity | null> {
  let raw: string;
  try {
    raw = await fs.readFile(metaPath, "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  if (typeof record.source !== "string" || typeof record.id !== "string") {
    return null;
  }

  return { source: record.source, id: record.id };
}

function addPathIdentityToWarning(
  warning: ClogWarning,
  pathInfo: GitPathInfo,
): ClogWarning {
  if (!pathInfo.author || !pathInfo.source || warning.conversation) {
    return warning;
  }

  return {
    ...warning,
    conversation: {
      author: pathInfo.author,
      source: pathInfo.source,
      id: pathInfo.id,
    },
  };
}

function shouldReportInvalidPairWarning(pathInfo: GitPathInfo): boolean {
  return !isUnknownSourceDirectory(pathInfo) && !isInvalidSourceDirectory(pathInfo);
}

function protectAll(
  identities: SourceIdentity[],
  protectedKeys: Set<string>,
  protectedIdentities: SourceIdentity[],
): void {
  for (const identity of identities) {
    const key = identityKey(identity.source, identity.id);
    if (protectedKeys.has(key)) {
      continue;
    }
    protectedKeys.add(key);
    protectedIdentities.push(identity);
  }
}

function uniqueIdentities(identities: SourceIdentity[]): SourceIdentity[] {
  const seen = new Set<string>();
  const unique: SourceIdentity[] = [];

  for (const identity of identities) {
    const key = identityKey(identity.source, identity.id);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(identity);
  }

  return unique;
}

function ownerSkipReason(owner: SavedConversationMeta): ReconcileSkipReason {
  if (owner.originKind === "local") {
    return "local_saved_owner";
  }

  if (owner.originKind === "file") {
    return "file_owner";
  }

  return "other_git_owner";
}

function ownerSkipMessage(files: GitValidatedConversationFiles, owner: SavedConversationMeta): string {
  const shortId = files.id.slice(0, 8);

  if (owner.originKind === "local") {
    return `Skipping remote conversation ${shortId} - the local saved copy takes precedence.`;
  }

  if (owner.originKind === "file") {
    return `Skipping remote conversation ${shortId} - an imported read-only copy takes precedence until it is removed.`;
  }

  return `Skipping remote conversation ${shortId} - another configured remote already owns this conversation.`;
}

function isGitRowForRemote(
  conversation: Pick<ConversationMeta, "originKind" | "originRef">,
  remoteUrl: string,
): boolean {
  return conversation.originKind === "git" && conversation.originRef === remoteUrl;
}

function formatGitFilesPath(files: GitValidatedConversationFiles): string {
  return path.posix.join(files.author, files.source, files.id);
}

function tagsEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function identityKey(source: string, id: string): string {
  return `${source}\u0000${id}`;
}

function isUnknownSourceDirectory(pathInfo: GitPathInfo): boolean {
  return (
    pathInfo.author != null &&
    pathInfo.source != null &&
    isValidSourceKey(pathInfo.source) &&
    !isSourceParseSupported(pathInfo.source)
  );
}

function isInvalidSourceDirectory(pathInfo: GitPathInfo): boolean {
  return (
    pathInfo.author != null &&
    pathInfo.source != null &&
    pathInfo.directoryDepth >= 2 &&
    !isValidSourceKey(pathInfo.source)
  );
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left);
  const rightPoints = Array.from(right);
  const length = Math.min(leftPoints.length, rightPoints.length);

  for (let i = 0; i < length; i += 1) {
    const leftCode = leftPoints[i]!.codePointAt(0)!;
    const rightCode = rightPoints[i]!.codePointAt(0)!;
    if (leftCode !== rightCode) {
      return leftCode - rightCode;
    }
  }

  return leftPoints.length - rightPoints.length;
}
