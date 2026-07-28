import { classifyAdapterVersion } from "../adapters/adapter.js";
import {
  preserveConfirmedRelationship,
  type OriginKind,
  type SavedConversationMeta,
} from "../models/conversation.js";
import type { ClogWarning } from "../models/warnings.js";
import type { LocalDiscoveryCandidate } from "../conversations/view.js";
import type { ScannedConversationFiles, ValidatedConversationFiles } from "./conversation-files.js";

export type FillMode = "file" | "own";

export type FillCandidate =
  | { kind: "valid"; files: ValidatedConversationFiles }
  | {
      kind: "invalid";
      scannedFiles: ScannedConversationFiles;
      warning: ClogWarning;
      diagnosticPath?: string;
    };

export type FillSkipReason =
  | "ignored"
  | "invalid_files"
  | "duplicate_identity"
  | "author_mismatch"
  | "local_unsaved_precedence"
  | "local_saved_precedence"
  | "git_collision"
  | "unsupported_promotion"
  | "source_discovery_incomplete"
  | "adapter_version_skew";

export type FillWriteAction =
  | {
      kind: "insert";
      files: ValidatedConversationFiles;
      conversation: SavedConversationMeta;
      managedPath: string;
      copyContent: true;
    }
  | {
      kind: "update";
      files: ValidatedConversationFiles;
      rowId: string;
      conversation: SavedConversationMeta;
      managedPath: string;
      copyContent: boolean;
    }
  ;

export type FillAction =
  | FillWriteAction
  | {
      kind: "unchanged";
      files: ValidatedConversationFiles;
      owner: SavedConversationMeta;
      managedPath: string;
    }
  | {
      kind: "skip";
      reason: FillSkipReason;
      message: string;
      failure: boolean;
      files?: ValidatedConversationFiles;
      owner?: SavedConversationMeta;
      warning?: ClogWarning;
      scannedFiles?: ScannedConversationFiles;
      diagnosticPath?: string;
      count?: number;
    };

export interface FillPlan {
  actions: FillAction[];
  warnings: ClogWarning[];
  ignoredCount: number;
  hiddenExternalAuthorCount: number;
  allValidCandidatesMatchAuthor: boolean;
  hasFailures: boolean;
  hasAuthorGuardFailure: boolean;
}

export interface PlanFillArgs {
  candidates: FillCandidate[];
  existingRows: SavedConversationMeta[];
  localCandidates?: LocalDiscoveryCandidate[];
  incompleteSources?: string[];
  mode: FillMode;
  author: string;
  importTime: string;
  ignoreRules?: string[];
  matchesIgnoreRule?: (
    rule: string,
    target: { sourceId: string; projectName: string | null },
  ) => boolean;
  getManagedPath: (files: ValidatedConversationFiles, mode: FillMode) => string;
  formatDiagnosticPath?: (physicalPath: string) => string;
}

export function planFill(args: PlanFillArgs): FillPlan {
  const {
    candidates,
    existingRows,
    localCandidates = [],
    incompleteSources = [],
    mode,
    author,
    importTime,
    ignoreRules = [],
    matchesIgnoreRule,
    getManagedPath,
    formatDiagnosticPath = (physicalPath) => physicalPath,
  } = args;
  const actions: FillAction[] = [];
  const warnings: ClogWarning[] = [];
  const validForCollision: ValidatedConversationFiles[] = [];
  let ignoredCount = 0;
  let hasFailures = false;

  for (const candidate of candidates) {
    if (candidate.kind === "invalid") {
      hasFailures = true;
      warnings.push(candidate.warning);
      actions.push({
        kind: "skip",
        reason: "invalid_files",
        message: candidate.warning.message,
        failure: true,
        warning: candidate.warning,
        scannedFiles: candidate.scannedFiles,
        diagnosticPath: candidate.diagnosticPath,
      });
      continue;
    }

    const files = candidate.files;
    const ignored =
      matchesIgnoreRule != null &&
      ignoreRules.some((rule) =>
        matchesIgnoreRule(rule, {
          sourceId: files.meta.id,
          projectName: files.meta.projectName,
        }),
      );

    if (ignored) {
      ignoredCount += 1;
      actions.push({
        kind: "skip",
        reason: "ignored",
        message: `Skipping conversation ${files.meta.id.slice(0, 8)} because it matches clogignore.`,
        failure: false,
        files,
      });
      continue;
    }

    validForCollision.push(files);
  }

  const duplicateKeys = findDuplicateIdentityKeys(validForCollision);
  const duplicateKeySet = new Set(duplicateKeys);
  for (const key of duplicateKeys) {
    const group = validForCollision.filter((files) => identityKey(files.meta.source, files.meta.id) === key);
    const first = group[0]!;
    const warning: ClogWarning = {
      code: "pair_duplicate_identity",
      message: `Skipping duplicate input identity ${first.meta.source}/${first.meta.id} - ${group.length} files claim the same conversation.`,
      conversation: {
        source: first.meta.source,
        id: first.meta.id,
      },
      paths: group.flatMap((files) => [
        formatDiagnosticPath(files.metaPath),
        formatDiagnosticPath(files.jsonlPath),
      ]),
    };
    hasFailures = true;
    warnings.push(warning);
    actions.push({
      kind: "skip",
      reason: "duplicate_identity",
      message: warning.message,
      failure: true,
      warning,
      count: group.length,
    });
  }

  const uniqueValid = validForCollision.filter(
    (files) => !duplicateKeySet.has(identityKey(files.meta.source, files.meta.id)),
  );

  if (mode === "own") {
    const mismatches = uniqueValid.filter((files) => files.meta.author !== author);
    if (mismatches.length > 0) {
      for (const files of mismatches) {
        actions.push({
          kind: "skip",
          reason: "author_mismatch",
          message: `Skipping ${files.meta.id.slice(0, 8)} - its author "${files.meta.author}" does not match configured author "${author}".`,
          failure: true,
          files,
        });
      }

      return buildPlanResult({
        actions,
        warnings,
        ignoredCount,
        validPairs: validForCollision,
        author,
        hasFailures: true,
        hasAuthorGuardFailure: true,
      });
    }
  }

  const rowsByIdentity = new Map<string, SavedConversationMeta>();
  for (const row of existingRows) {
    rowsByIdentity.set(identityKey(row.source, row.sourceId), row);
  }
  const localCandidateKeys = new Set(
    localCandidates.map((candidate) => identityKey(candidate.source, candidate.sourceId)),
  );
  const incompleteSourceSet = new Set(incompleteSources);

  for (const files of uniqueValid) {
    const key = identityKey(files.meta.source, files.meta.id);
    const owner = rowsByIdentity.get(key);
    const managedPath = getManagedPath(files, mode);

    if (!owner) {
      if (localCandidateKeys.has(key) && mode === "file") {
        actions.push({
          kind: "skip",
          reason: "local_unsaved_precedence",
          message: `Skipping ${files.meta.id.slice(0, 8)} - a local unsaved source copy already exists. Run 'clog save ${files.meta.id.slice(0, 8)}' to keep source metadata, or re-run with --own to import this conversation as an editable local copy.`,
          failure: false,
          files,
        });
        continue;
      }

      if (
        mode === "file" &&
        !localCandidateKeys.has(key) &&
        incompleteSourceSet.has(files.meta.source)
      ) {
        actions.push({
          kind: "skip",
          reason: "source_discovery_incomplete",
          message: `Skipping ${files.meta.id.slice(0, 8)} because the ${files.meta.source} scan did not complete, so clog could not determine whether a local unsaved source copy owns this identity.`,
          failure: true,
          files,
        });
        hasFailures = true;
        continue;
      }

      actions.push({
        kind: "insert",
        files,
        managedPath,
        copyContent: true,
        conversation: buildConversationFromFillPair({
          files,
          managedPath,
          originKind: mode === "own" ? "local" : "file",
          importTime,
        }),
      });
      continue;
    }

    const planned = planFillCollision({
      mode,
      files,
      owner,
      managedPath,
    });
    actions.push(planned);
    if (planned.kind === "skip" && planned.warning) {
      warnings.push(planned.warning);
    }
    if (planned.kind === "skip" && planned.failure) {
      hasFailures = true;
    }
  }

  return buildPlanResult({
    actions,
    warnings,
    ignoredCount,
    validPairs: validForCollision,
    author,
    hasFailures,
    hasAuthorGuardFailure: false,
  });
}

export function isFillWriteAction(action: FillAction): action is FillWriteAction {
  return (
    action.kind === "insert" ||
    action.kind === "update"
  );
}

function planFillCollision(args: {
  mode: FillMode;
  files: ValidatedConversationFiles;
  owner: SavedConversationMeta;
  managedPath: string;
}): FillAction {
  const { mode, files, owner, managedPath } = args;

  if (owner.originKind === "local") {
    return {
      kind: "skip",
      reason: "local_saved_precedence",
      message:
        mode === "own"
          ? `Skipping ${files.meta.id.slice(0, 8)} - this conversation is already saved locally. 'clog fill --own' will not replace local metadata or content; remove the local copy first if you want this files to replace it.`
          : `Skipping ${files.meta.id.slice(0, 8)} - this conversation is already saved locally. 'clog fill' imports read-only copies and will not replace local metadata or content.`,
      failure: false,
      files,
      owner,
    };
  }

  if (owner.originKind === "git") {
    return {
      kind: "skip",
      reason: mode === "own" ? "unsupported_promotion" : "git_collision",
      message:
        mode === "own"
          ? `Skipping ${files.meta.id.slice(0, 8)} - this synced conversation is read-only and cannot be made editable. Remove it from clog first, then re-run with --own to import it as an editable local copy.`
          : `Skipping ${files.meta.id.slice(0, 8)} - a synced read-only copy already owns this identity.`,
      failure: true,
      files,
      owner,
    };
  }

  if (mode === "own") {
    return {
      kind: "skip",
      reason: "unsupported_promotion",
      message: `Skipping ${files.meta.id.slice(0, 8)} - this imported conversation is read-only and cannot be made editable. Remove it from clog first, then re-run with --own to import it as an editable local copy.`,
      failure: true,
      files,
      owner,
    };
  }

  if (
    classifyAdapterVersion(
      owner.transcriptProjectionVersion,
      files.transcriptProjectionVersion,
    ) === "version_skew" ||
    classifyAdapterVersion(
      owner.relationshipInspection.version,
      files.relationshipInspection.version,
    ) === "version_skew"
  ) {
    const warning: ClogWarning = {
      code: "adapter_version_skew",
      message:
        "Skipping a conversation that was saved by a newer clog version.",
      source: owner.source,
      conversation: {
        id: owner.id,
        source: owner.source,
      },
      guidance: "Upgrade clog before importing this conversation again.",
    };
    return {
      kind: "skip",
      reason: "adapter_version_skew",
      message: warning.message,
      failure: true,
      files,
      owner,
      warning,
    };
  }

  const merged = mergeFilePairIntoConversation(owner, files, managedPath);
  if (!merged) {
    return {
      kind: "unchanged",
      files,
      owner,
      managedPath,
    };
  }

  return {
    kind: "update",
    rowId: owner.id,
    files,
    managedPath,
    copyContent: merged.copyContent,
    conversation: merged.conversation,
  };
}

function buildConversationFromFillPair(args: {
  files: ValidatedConversationFiles;
  managedPath: string;
  originKind: Extract<OriginKind, "local" | "file">;
  importTime: string;
  discoveredAt?: string;
}): SavedConversationMeta {
  const { files, managedPath, originKind, importTime, discoveredAt } = args;
  return {
    id: files.meta.id,
    sourceId: files.meta.id,
    source: files.meta.source,
    title: files.meta.title,
    summary: files.meta.summary,
    summaryKind: files.meta.summaryKind,
    summaryExtraction: files.meta.summaryExtraction,
    author: files.meta.author,
    projectName: files.meta.projectName,
    projectPath: null,
    tags: [...files.meta.tags],
    slug: files.meta.slug,
    createdAt: files.meta.createdAt,
    discoveredAt: discoveredAt ?? importTime,
    modifiedAt: files.meta.modifiedAt,
    state: "saved",
    savedAt: files.meta.savedAt,
    savedMessageCount: files.messageCount,
    saveVersion: 1,
    transcriptProjectionVersion: files.transcriptProjectionVersion,
    sourcePath: managedPath,
    filePath: managedPath,
    sourceMtime: null,
    indexedAt: null,
    originKind,
    originRef: null,
    relationshipInspection: {
      status: files.relationshipInspection.status,
      version: files.relationshipInspection.version,
      diagnostic: files.relationshipInspection.diagnostic,
    },
    relationships: files.relationshipInspection.relationships,
  };
}

function mergeFilePairIntoConversation(
  existing: SavedConversationMeta,
  files: ValidatedConversationFiles,
  managedPath: string,
): { conversation: SavedConversationMeta; copyContent: boolean } | null {
  const titleChanged = existing.title !== files.meta.title;
  const summaryChanged = existing.summary !== files.meta.summary;
  const contentChanged = existing.savedMessageCount !== files.messageCount;
  const projectionChanged =
    existing.transcriptProjectionVersion !== files.transcriptProjectionVersion;
  const refreshedRelationshipInspection = preserveConfirmedRelationship(
    existing,
    files.relationshipInspection,
  );
  const relationshipChanged =
    JSON.stringify({
      ...existing.relationshipInspection,
      relationships: existing.relationships,
    }) !== JSON.stringify(refreshedRelationshipInspection);
  const pathChanged =
    existing.sourcePath !== managedPath || existing.filePath !== managedPath;
  const extractionChanged =
    JSON.stringify(existing.summaryExtraction ?? null) !==
    JSON.stringify(files.meta.summaryExtraction ?? null);

  const metadataChanged =
    titleChanged ||
    summaryChanged ||
    existing.author !== files.meta.author ||
    existing.projectName !== files.meta.projectName ||
    existing.slug !== files.meta.slug ||
    existing.createdAt !== files.meta.createdAt ||
    existing.modifiedAt !== files.meta.modifiedAt ||
    existing.savedAt !== files.meta.savedAt ||
    existing.summaryKind !== files.meta.summaryKind ||
    extractionChanged ||
    !tagsEqual(existing.tags, files.meta.tags);

  if (
    !metadataChanged &&
    !contentChanged &&
    !projectionChanged &&
    !relationshipChanged &&
    !pathChanged
  ) {
    return null;
  }

  return {
    copyContent: contentChanged || projectionChanged || pathChanged,
    conversation: {
      ...existing,
      sourceId: files.meta.id,
      source: files.meta.source,
      title: files.meta.title,
      summary: files.meta.summary,
      summaryKind: files.meta.summaryKind,
      summaryExtraction: files.meta.summaryExtraction,
      author: files.meta.author,
      projectName: files.meta.projectName,
      projectPath: null,
      tags: [...files.meta.tags],
      slug: files.meta.slug,
      createdAt: files.meta.createdAt,
      modifiedAt: files.meta.modifiedAt,
      state: "saved",
      savedAt: files.meta.savedAt,
      savedMessageCount: files.messageCount,
      transcriptProjectionVersion: files.transcriptProjectionVersion,
      relationshipInspection: {
        status: refreshedRelationshipInspection.status,
        version: refreshedRelationshipInspection.version,
        diagnostic: refreshedRelationshipInspection.diagnostic,
      },
      relationships: refreshedRelationshipInspection.relationships,
      sourcePath: managedPath,
      filePath: managedPath,
      indexedAt:
        titleChanged || summaryChanged || contentChanged || projectionChanged
          ? null
          : existing.indexedAt,
      originKind: "file",
      originRef: null,
    },
  };
}

function findDuplicateIdentityKeys(pairs: ValidatedConversationFiles[]): string[] {
  const counts = new Map<string, number>();
  for (const files of pairs) {
    const key = identityKey(files.meta.source, files.meta.id);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([key]) => key);
}

function buildPlanResult(args: {
  actions: FillAction[];
  warnings: ClogWarning[];
  ignoredCount: number;
  validPairs: ValidatedConversationFiles[];
  author: string;
  hasFailures: boolean;
  hasAuthorGuardFailure: boolean;
}): FillPlan {
  const hiddenExternalAuthorIds = new Set<string>();
  for (const action of args.actions) {
    if (
      args.author &&
      isFillWriteAction(action) &&
      action.conversation.originKind === "file" &&
      action.conversation.author !== args.author
    ) {
      hiddenExternalAuthorIds.add(action.conversation.id);
    }
  }

  return {
    actions: args.actions,
    warnings: args.warnings,
    ignoredCount: args.ignoredCount,
    hiddenExternalAuthorCount: hiddenExternalAuthorIds.size,
    allValidCandidatesMatchAuthor:
      args.validPairs.length > 0 &&
      args.author.length > 0 &&
      args.validPairs.every((files) => files.meta.author === args.author),
    hasFailures:
      args.hasFailures ||
      args.actions.some((action) => action.kind === "skip" && action.failure),
    hasAuthorGuardFailure: args.hasAuthorGuardFailure,
  };
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
