import fs from "node:fs/promises";
import path from "node:path";

import type { Config } from "../config/schema.js";
import type { ConversationMeta } from "../models/conversation.js";
import type { ClogWarning } from "../models/warnings.js";
import { nowIso } from "../utils/time.js";
import { BUILTIN_SOURCES } from "../utils/paths.js";
import {
  readPairMetadata,
  scanPairs,
  validatePair,
  type PairMetadata,
  type ScannedPair,
  type ValidatedPair,
} from "./pairs.js";

export interface SourceIdentity {
  source: string;
  id: string;
}

export interface GitValidatedPair {
  author: string;
  source: string;
  id: string;
  pair: ValidatedPair;
}

export type GitPairScanResult =
  | { kind: "valid"; pair: GitValidatedPair }
  | {
      kind: "invalid";
      scannedPair: ScannedPair;
      warning: ClogWarning;
      reportWarning?: boolean;
      protectedIdentities: SourceIdentity[];
    };

export interface GitPairScan {
  results: GitPairScanResult[];
  warnings: ClogWarning[];
}

export type ReconcileSkipReason =
  | "ignored"
  | "duplicate"
  | "local_discovered_owner"
  | "local_saved_owner"
  | "file_owner"
  | "other_git_owner"
  | "invalid_pair";

export type ReconcileAction =
  | { kind: "insert"; pair: GitValidatedPair; conversation: ConversationMeta }
  | {
      kind: "update";
      rowId: string;
      pair: GitValidatedPair;
      conversation: ConversationMeta;
    }
  | { kind: "delete"; rowId: string }
  | {
      kind: "skip";
      reason: ReconcileSkipReason;
      message: string;
      pair?: GitValidatedPair;
      scannedPair?: ScannedPair;
      owner?: ConversationMeta;
    };

export interface GitReconciliationPlan {
  actions: ReconcileAction[];
  warnings: ClogWarning[];
  protectedIdentities: SourceIdentity[];
  deletedRowIds: string[];
  ignoredCount: number;
}

export interface PlanGitReconciliationArgs {
  scan: GitPairScan;
  existingRows: ConversationMeta[];
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

export async function scanGitCheckoutPairs(
  rootDir: string,
  config: Config,
): Promise<GitPairScan> {
  const pairTree = await scanGitPairTree(rootDir);
  const pairs = pairTree.pairs;
  const results: GitPairScanResult[] = [];
  const warnings: ClogWarning[] = [...pairTree.warnings];

  for (const scannedPair of pairs) {
    const pathInfo = getGitPathInfo(scannedPair);

    if (scannedPair.metaExists && scannedPair.jsonlExists) {
      const parsedMeta = await readPairMetadata(scannedPair.metaPath);
      if (parsedMeta.ok && parsedMeta.meta.id === scannedPair.stem) {
        const layoutWarning = validateGitLayoutMetadata(
          scannedPair,
          parsedMeta.meta,
          pathInfo,
        );
        if (layoutWarning) {
          results.push({
            kind: "invalid",
            scannedPair,
            warning: layoutWarning,
            reportWarning: shouldReportInvalidPairWarning(pathInfo),
            protectedIdentities: await getProtectedIdentities(
              scannedPair,
              layoutWarning,
              pathInfo,
            ),
          });
          continue;
        }
      }
    }

    const validation = await validatePair(scannedPair, config);
    if (validation.kind === "invalid") {
      const warning = addPathPairToWarning(validation.warning, pathInfo);
      results.push({
        kind: "invalid",
        scannedPair,
        warning,
        reportWarning: shouldReportInvalidPairWarning(pathInfo),
        protectedIdentities: await getProtectedIdentities(scannedPair, warning, pathInfo),
      });
      continue;
    }

    results.push({
      kind: "valid",
      pair: {
        author: pathInfo.author!,
        source: pathInfo.source!,
        id: pathInfo.id,
        pair: validation.pair,
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
    remoteUrl,
    ignoreRules = [],
    matchesIgnoreRule,
    deletionsEnabled = true,
  } = args;
  const actions: ReconcileAction[] = [];
  const warnings = [...scan.warnings];
  const protectedIdentities: SourceIdentity[] = [];
  const protectedKeys = new Set<string>();
  const presentKeys = new Set<string>();
  const seenValidKeys = new Map<string, GitValidatedPair>();
  let ignoredCount = 0;

  const rowsByIdentity = new Map<string, ConversationMeta>();
  const inScopeRowsByIdentity = new Map<string, ConversationMeta>();

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
        reason: "invalid_pair",
        message: result.warning.message,
        scannedPair: result.scannedPair,
      });
      protectAll(result.protectedIdentities, protectedKeys, protectedIdentities);
      continue;
    }

    const pair = result.pair;
    const key = identityKey(pair.source, pair.id);
    const ignored =
      matchesIgnoreRule != null &&
      ignoreRules.some((rule) =>
        matchesIgnoreRule(rule, {
          sourceId: pair.id,
          projectName: pair.pair.meta.projectName,
        }),
      );

    if (ignored) {
      ignoredCount += 1;
      presentKeys.add(key);
      protectAll([{ source: pair.source, id: pair.id }], protectedKeys, protectedIdentities);
      actions.push({
        kind: "skip",
        reason: "ignored",
        message: `Skipping remote conversation ${formatGitPairPath(pair)} because it matches clogignore.`,
        pair,
      });
      continue;
    }

    if (seenValidKeys.has(key)) {
      const winner = seenValidKeys.get(key)!;
      actions.push({
        kind: "skip",
        reason: "duplicate",
        message: `Skipping duplicate remote conversation ${formatGitPairPath(pair)} - ${formatGitPairPath(winner)} was chosen first by deterministic checkout order.`,
        pair,
      });
      presentKeys.add(key);
      continue;
    }

    seenValidKeys.set(key, pair);
    presentKeys.add(key);
    const existingForRemote = inScopeRowsByIdentity.get(key);

    if (!existingForRemote) {
      const owner = rowsByIdentity.get(key);
      if (owner && !isGitRowForRemote(owner, remoteUrl)) {
        actions.push({
          kind: "skip",
          reason: ownerSkipReason(owner),
          message: ownerSkipMessage(pair, owner),
          pair,
          owner,
        });
        continue;
      }

      actions.push({
        kind: "insert",
        pair,
        conversation: buildConversationFromGitPair(pair, remoteUrl),
      });
      continue;
    }

    const updated = mergeGitPairIntoConversation(existingForRemote, pair, remoteUrl);
    if (updated) {
      actions.push({
        kind: "update",
        rowId: existingForRemote.id,
        pair,
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

export function buildConversationFromGitPair(
  pair: GitValidatedPair,
  remoteUrl: string,
): ConversationMeta {
  const now = nowIso();
  return {
    id: pair.pair.meta.id,
    sourceId: pair.pair.meta.id,
    source: pair.pair.meta.source,
    title: pair.pair.meta.title,
    summary: pair.pair.meta.summary,
    summaryKind: pair.pair.meta.summaryKind,
    summaryExtraction: pair.pair.meta.summaryExtraction,
    author: pair.pair.meta.author,
    projectName: pair.pair.meta.projectName,
    projectPath: null,
    tags: [...pair.pair.meta.tags],
    slug: pair.pair.meta.slug,
    createdAt: pair.pair.meta.createdAt,
    discoveredAt: now,
    modifiedAt: pair.pair.meta.modifiedAt,
    state: "saved",
    savedAt: pair.pair.meta.savedAt,
    savedMessageCount: pair.pair.messageCount,
    saveVersion: 1,
    sourcePath: pair.pair.jsonlPath,
    filePath: pair.pair.jsonlPath,
    sourceMtime: null,
    indexedAt: null,
    originKind: "git",
    originRef: remoteUrl,
  };
}

export function mergeGitPairIntoConversation(
  existing: ConversationMeta,
  pair: GitValidatedPair,
  remoteUrl: string,
): ConversationMeta | null {
  const titleChanged = existing.title !== pair.pair.meta.title;
  const summaryChanged = existing.summary !== pair.pair.meta.summary;
  const contentChanged = existing.savedMessageCount !== pair.pair.messageCount;
  const pathChanged =
    existing.sourcePath !== pair.pair.jsonlPath ||
    existing.filePath !== pair.pair.jsonlPath;
  const extractionChanged =
    JSON.stringify(existing.summaryExtraction ?? null) !==
    JSON.stringify(pair.pair.meta.summaryExtraction ?? null);

  const metadataChanged =
    titleChanged ||
    summaryChanged ||
    existing.author !== pair.pair.meta.author ||
    existing.projectName !== pair.pair.meta.projectName ||
    existing.slug !== pair.pair.meta.slug ||
    existing.createdAt !== pair.pair.meta.createdAt ||
    existing.modifiedAt !== pair.pair.meta.modifiedAt ||
    existing.savedAt !== pair.pair.meta.savedAt ||
    contentChanged ||
    existing.summaryKind !== pair.pair.meta.summaryKind ||
    extractionChanged ||
    !tagsEqual(existing.tags, pair.pair.meta.tags);

  if (!metadataChanged && !pathChanged) {
    return null;
  }

  return {
    ...existing,
    title: pair.pair.meta.title,
    summary: pair.pair.meta.summary,
    summaryKind: pair.pair.meta.summaryKind,
    summaryExtraction: pair.pair.meta.summaryExtraction,
    author: pair.pair.meta.author,
    projectName: pair.pair.meta.projectName,
    tags: [...pair.pair.meta.tags],
    slug: pair.pair.meta.slug,
    createdAt: pair.pair.meta.createdAt,
    modifiedAt: pair.pair.meta.modifiedAt,
    savedAt: pair.pair.meta.savedAt,
    savedMessageCount: pair.pair.messageCount,
    sourcePath: pair.pair.jsonlPath,
    filePath: pair.pair.jsonlPath,
    indexedAt:
      titleChanged || summaryChanged || contentChanged ? null : existing.indexedAt,
    originKind: "git",
    originRef: remoteUrl,
  };
}

function getGitPathInfo(pair: ScannedPair): GitPathInfo {
  const parts = pair.relativeDir.split("/").filter(Boolean);
  return {
    author: parts[0] ?? null,
    source: parts[1] ?? null,
    id: pair.stem,
    directoryDepth: parts.length,
  };
}

async function scanGitPairTree(rootDir: string): Promise<{
  pairs: ScannedPair[];
  warnings: ClogWarning[];
}> {
  const warnings = await collectUnsupportedSourceWarnings(rootDir);
  const pairs = await scanPairs(rootDir, {
    shouldDescend: ({ relativeDir, entryName }) => {
      const parts = relativeDir.split("/").filter(Boolean);
      if (parts.length === 0) {
        return !entryName.startsWith(".");
      }

      return true;
    },
  });

  return { pairs, warnings };
}

async function collectUnsupportedSourceWarnings(
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
      if (!isSupportedSource(source)) {
        warnings.push({
          code: "unsupported_source",
          message: `Unsupported source directory "${author}/${source}" in remote checkout - skipping.`,
          source,
        });
        continue;
      }

    }
  }

  return warnings;
}

function validateGitLayoutMetadata(
  pair: ScannedPair,
  meta: PairMetadata,
  pathInfo: GitPathInfo,
): ClogWarning | null {
  if (!pathInfo.author || !pathInfo.source || pathInfo.directoryDepth !== 2) {
    return {
      code: "pair_layout_mismatch",
      message: `Skipping remote conversation ${pair.stem} - expected git layout <author>/<source>/<id>.`,
      pair: {
        author: pathInfo.author ?? undefined,
        source: meta.source,
        id: meta.id,
      },
      paths: [pair.metaPath, pair.jsonlPath],
    };
  }

  if (pathInfo.source !== meta.source) {
    return {
      code: "pair_layout_mismatch",
      message: `Skipping remote conversation ${pair.stem} - meta.source "${meta.source}" does not match directory "${pathInfo.source}".`,
      pair: { author: pathInfo.author, source: pathInfo.source, id: pathInfo.id },
      path: pair.metaPath,
    };
  }

  if (pathInfo.author !== meta.author) {
    return {
      code: "pair_layout_mismatch",
      message: `Skipping remote conversation ${pair.stem} - meta.author "${meta.author}" does not match directory "${pathInfo.author}".`,
      pair: { author: pathInfo.author, source: pathInfo.source, id: pathInfo.id },
      path: pair.metaPath,
    };
  }

  return null;
}

async function getProtectedIdentities(
  scannedPair: ScannedPair,
  warning: ClogWarning,
  pathInfo: GitPathInfo,
): Promise<SourceIdentity[]> {
  const identities: SourceIdentity[] = [];

  if (pathInfo.source && isSupportedSource(pathInfo.source)) {
    identities.push({ source: pathInfo.source, id: pathInfo.id });
  }

  if (warning.pair && isSupportedSource(warning.pair.source)) {
    identities.push({ source: warning.pair.source, id: warning.pair.id });
  }

  if (scannedPair.metaExists) {
    const identity = await readMetadataIdentity(scannedPair.metaPath);
    if (identity && isSupportedSource(identity.source)) {
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

function addPathPairToWarning(
  warning: ClogWarning,
  pathInfo: GitPathInfo,
): ClogWarning {
  if (!pathInfo.author || !pathInfo.source || warning.pair) {
    return warning;
  }

  return {
    ...warning,
    pair: {
      author: pathInfo.author,
      source: pathInfo.source,
      id: pathInfo.id,
    },
  };
}

function shouldReportInvalidPairWarning(pathInfo: GitPathInfo): boolean {
  return !(pathInfo.author && pathInfo.source && !isSupportedSource(pathInfo.source));
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

function ownerSkipReason(owner: ConversationMeta): ReconcileSkipReason {
  if (owner.originKind === "local" && owner.state === "discovered") {
    return "local_discovered_owner";
  }

  if (owner.originKind === "local") {
    return "local_saved_owner";
  }

  if (owner.originKind === "file") {
    return "file_owner";
  }

  return "other_git_owner";
}

function ownerSkipMessage(pair: GitValidatedPair, owner: ConversationMeta): string {
  const shortId = pair.id.slice(0, 8);

  if (owner.originKind === "local" && owner.state === "discovered") {
    return `Skipping remote conversation ${shortId} - a local discovered copy already exists. Run 'clog save ${shortId}' to keep the local copy, or remove the local row before using the imported copy.`;
  }

  if (owner.originKind === "local") {
    return `Skipping remote conversation ${shortId} - the local saved copy takes precedence.`;
  }

  if (owner.originKind === "file") {
    return `Skipping remote conversation ${shortId} - a filled read-only copy takes precedence until it is removed.`;
  }

  return `Skipping remote conversation ${shortId} - another configured remote already owns this conversation.`;
}

function isGitRowForRemote(
  conversation: Pick<ConversationMeta, "originKind" | "originRef">,
  remoteUrl: string,
): boolean {
  return conversation.originKind === "git" && conversation.originRef === remoteUrl;
}

function formatGitPairPath(pair: GitValidatedPair): string {
  return path.posix.join(pair.author, pair.source, pair.id);
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

function isSupportedSource(source: string): boolean {
  return (BUILTIN_SOURCES as readonly string[]).includes(source);
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
