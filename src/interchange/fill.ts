import type { ConversationMeta, OriginKind } from "../models/conversation.js";
import type { ClogWarning } from "../models/warnings.js";
import type { ScannedPair, ValidatedPair } from "./pairs.js";

export type FillMode = "file" | "own";

export type FillCandidate =
  | { kind: "valid"; pair: ValidatedPair }
  | { kind: "invalid"; scannedPair: ScannedPair; warning: ClogWarning };

export type FillSkipReason =
  | "ignored"
  | "invalid_pair"
  | "duplicate_identity"
  | "author_mismatch"
  | "local_unsaved_precedence"
  | "local_saved_precedence"
  | "git_collision"
  | "unsupported_promotion";

export type FillWriteAction =
  | {
      kind: "insert";
      pair: ValidatedPair;
      conversation: ConversationMeta;
      managedPath: string;
      copyContent: true;
    }
  | {
      kind: "update";
      pair: ValidatedPair;
      rowId: string;
      conversation: ConversationMeta;
      managedPath: string;
      copyContent: boolean;
    }
  | {
      kind: "restore_unsaved";
      pair: ValidatedPair;
      rowId: string;
      conversation: ConversationMeta;
      managedPath: string;
      copyContent: true;
    };

export type FillAction =
  | FillWriteAction
  | {
      kind: "unchanged";
      pair: ValidatedPair;
      owner: ConversationMeta;
      managedPath: string;
    }
  | {
      kind: "skip";
      reason: FillSkipReason;
      message: string;
      failure: boolean;
      pair?: ValidatedPair;
      owner?: ConversationMeta;
      warning?: ClogWarning;
      scannedPair?: ScannedPair;
      count?: number;
    };

export interface FillPlan {
  actions: FillAction[];
  warnings: ClogWarning[];
  ignoredCount: number;
  validCandidateCount: number;
  hiddenForeignAuthorCount: number;
  allValidCandidatesMatchAuthor: boolean;
  hasFailures: boolean;
  hasAuthorGuardFailure: boolean;
}

export interface PlanFillArgs {
  candidates: FillCandidate[];
  existingRows: ConversationMeta[];
  mode: FillMode;
  author: string;
  importTime: string;
  ignoreRules?: string[];
  matchesIgnoreRule?: (
    rule: string,
    target: { sourceId: string; projectName: string | null },
  ) => boolean;
  getManagedPath: (pair: ValidatedPair, mode: FillMode) => string;
}

export function planFill(args: PlanFillArgs): FillPlan {
  const {
    candidates,
    existingRows,
    mode,
    author,
    importTime,
    ignoreRules = [],
    matchesIgnoreRule,
    getManagedPath,
  } = args;
  const actions: FillAction[] = [];
  const warnings: ClogWarning[] = [];
  const validForCollision: ValidatedPair[] = [];
  let ignoredCount = 0;
  let hasFailures = false;

  for (const candidate of candidates) {
    if (candidate.kind === "invalid") {
      hasFailures = true;
      warnings.push(candidate.warning);
      actions.push({
        kind: "skip",
        reason: "invalid_pair",
        message: candidate.warning.message,
        failure: true,
        warning: candidate.warning,
        scannedPair: candidate.scannedPair,
      });
      continue;
    }

    const pair = candidate.pair;
    const ignored =
      matchesIgnoreRule != null &&
      ignoreRules.some((rule) =>
        matchesIgnoreRule(rule, {
          sourceId: pair.meta.id,
          projectName: pair.meta.projectName,
        }),
      );

    if (ignored) {
      ignoredCount += 1;
      actions.push({
        kind: "skip",
        reason: "ignored",
        message: `Skipping conversation ${pair.meta.id.slice(0, 8)} because it matches clogignore.`,
        failure: false,
        pair,
      });
      continue;
    }

    validForCollision.push(pair);
  }

  const duplicateKeys = findDuplicateIdentityKeys(validForCollision);
  const duplicateKeySet = new Set(duplicateKeys);
  for (const key of duplicateKeys) {
    const group = validForCollision.filter((pair) => identityKey(pair.meta.source, pair.meta.id) === key);
    const first = group[0]!;
    const warning: ClogWarning = {
      code: "pair_duplicate_identity",
      message: `Skipping duplicate input identity ${first.meta.source}/${first.meta.id} - ${group.length} pairs claim the same conversation.`,
      pair: {
        source: first.meta.source,
        id: first.meta.id,
      },
      paths: group.flatMap((pair) => [pair.metaPath, pair.jsonlPath]),
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
    (pair) => !duplicateKeySet.has(identityKey(pair.meta.source, pair.meta.id)),
  );

  if (mode === "own") {
    const mismatches = uniqueValid.filter((pair) => pair.meta.author !== author);
    if (mismatches.length > 0) {
      for (const pair of mismatches) {
        actions.push({
          kind: "skip",
          reason: "author_mismatch",
          message: `Skipping ${pair.meta.id.slice(0, 8)} - pair author "${pair.meta.author}" does not match configured author "${author}".`,
          failure: true,
          pair,
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

  const rowsByIdentity = new Map<string, ConversationMeta>();
  for (const row of existingRows) {
    rowsByIdentity.set(identityKey(row.source, row.sourceId), row);
  }

  for (const pair of uniqueValid) {
    const owner = rowsByIdentity.get(identityKey(pair.meta.source, pair.meta.id));
    const managedPath = getManagedPath(pair, mode);

    if (!owner) {
      actions.push({
        kind: "insert",
        pair,
        managedPath,
        copyContent: true,
        conversation: buildConversationFromFillPair({
          pair,
          managedPath,
          originKind: mode === "own" ? "local" : "file",
          importTime,
        }),
      });
      continue;
    }

    const planned = planFillCollision({
      mode,
      pair,
      owner,
      managedPath,
      importTime,
    });
    actions.push(planned);
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
    action.kind === "update" ||
    action.kind === "restore_unsaved"
  );
}

function planFillCollision(args: {
  mode: FillMode;
  pair: ValidatedPair;
  owner: ConversationMeta;
  managedPath: string;
  importTime: string;
}): FillAction {
  const { mode, pair, owner, managedPath, importTime } = args;

  if (owner.originKind === "local" && owner.state === "unsaved") {
    if (mode === "own") {
      return {
        kind: "restore_unsaved",
        rowId: owner.id,
        pair,
        managedPath,
        copyContent: true,
        conversation: buildConversationFromFillPair({
          pair,
          managedPath,
          originKind: "local",
          importTime,
          discoveredAt: owner.discoveredAt,
        }),
      };
    }

    return {
      kind: "skip",
      reason: "local_unsaved_precedence",
      message: `Skipping ${pair.meta.id.slice(0, 8)} - a local unsaved source copy already exists. Run 'clog save ${pair.meta.id.slice(0, 8)}' to keep source metadata, or 'clog fill <dir> --own' to restore pair metadata.`,
      failure: false,
      pair,
      owner,
    };
  }

  if (owner.originKind === "local") {
    return {
      kind: "skip",
      reason: "local_saved_precedence",
      message:
        mode === "own"
          ? `Skipping ${pair.meta.id.slice(0, 8)} - this conversation is already saved locally. 'clog fill --own' will not replace local metadata or content; remove the local copy first if you want this pair to replace it.`
          : `Skipping ${pair.meta.id.slice(0, 8)} - this conversation is already saved locally. 'clog fill' imports read-only copies and will not replace local metadata or content.`,
      failure: false,
      pair,
      owner,
    };
  }

  if (owner.originKind === "git") {
    return {
      kind: "skip",
      reason: mode === "own" ? "unsupported_promotion" : "git_collision",
      message:
        mode === "own"
          ? `Skipping ${pair.meta.id.slice(0, 8)} - promoting a synced read-only copy to local is not supported. Remove the imported row first, then run 'clog fill <dir> --own'.`
          : `Skipping ${pair.meta.id.slice(0, 8)} - a synced read-only copy already owns this identity.`,
      failure: true,
      pair,
      owner,
    };
  }

  if (mode === "own") {
    return {
      kind: "skip",
      reason: "unsupported_promotion",
      message: `Skipping ${pair.meta.id.slice(0, 8)} - promoting a filled read-only copy to local is not supported. Remove the imported row first, then run 'clog fill <dir> --own'.`,
      failure: true,
      pair,
      owner,
    };
  }

  const merged = mergeFilePairIntoConversation(owner, pair, managedPath);
  if (!merged) {
    return {
      kind: "unchanged",
      pair,
      owner,
      managedPath,
    };
  }

  return {
    kind: "update",
    rowId: owner.id,
    pair,
    managedPath,
    copyContent: merged.copyContent,
    conversation: merged.conversation,
  };
}

function buildConversationFromFillPair(args: {
  pair: ValidatedPair;
  managedPath: string;
  originKind: Extract<OriginKind, "local" | "file">;
  importTime: string;
  discoveredAt?: string;
}): ConversationMeta {
  const { pair, managedPath, originKind, importTime, discoveredAt } = args;
  return {
    id: pair.meta.id,
    sourceId: pair.meta.id,
    source: pair.meta.source,
    title: pair.meta.title,
    summary: pair.meta.summary,
    summaryKind: pair.meta.summaryKind,
    summaryExtraction: pair.meta.summaryExtraction,
    author: pair.meta.author,
    projectName: pair.meta.projectName,
    projectPath: null,
    tags: [...pair.meta.tags],
    slug: pair.meta.slug,
    createdAt: pair.meta.createdAt,
    discoveredAt: discoveredAt ?? importTime,
    modifiedAt: pair.meta.modifiedAt,
    state: "saved",
    savedAt: pair.meta.savedAt,
    savedMessageCount: pair.messageCount,
    saveVersion: 1,
    sourcePath: managedPath,
    filePath: managedPath,
    sourceMtime: null,
    indexedAt: null,
    originKind,
    originRef: null,
  };
}

function mergeFilePairIntoConversation(
  existing: ConversationMeta,
  pair: ValidatedPair,
  managedPath: string,
): { conversation: ConversationMeta; copyContent: boolean } | null {
  const titleChanged = existing.title !== pair.meta.title;
  const summaryChanged = existing.summary !== pair.meta.summary;
  const contentChanged = existing.savedMessageCount !== pair.messageCount;
  const pathChanged =
    existing.sourcePath !== managedPath || existing.filePath !== managedPath;
  const extractionChanged =
    JSON.stringify(existing.summaryExtraction ?? null) !==
    JSON.stringify(pair.meta.summaryExtraction ?? null);

  const metadataChanged =
    titleChanged ||
    summaryChanged ||
    existing.author !== pair.meta.author ||
    existing.projectName !== pair.meta.projectName ||
    existing.slug !== pair.meta.slug ||
    existing.createdAt !== pair.meta.createdAt ||
    existing.modifiedAt !== pair.meta.modifiedAt ||
    existing.savedAt !== pair.meta.savedAt ||
    existing.summaryKind !== pair.meta.summaryKind ||
    extractionChanged ||
    !tagsEqual(existing.tags, pair.meta.tags);

  if (!metadataChanged && !contentChanged && !pathChanged) {
    return null;
  }

  return {
    copyContent: contentChanged || pathChanged,
    conversation: {
      ...existing,
      sourceId: pair.meta.id,
      source: pair.meta.source,
      title: pair.meta.title,
      summary: pair.meta.summary,
      summaryKind: pair.meta.summaryKind,
      summaryExtraction: pair.meta.summaryExtraction,
      author: pair.meta.author,
      projectName: pair.meta.projectName,
      projectPath: null,
      tags: [...pair.meta.tags],
      slug: pair.meta.slug,
      createdAt: pair.meta.createdAt,
      modifiedAt: pair.meta.modifiedAt,
      state: "saved",
      savedAt: pair.meta.savedAt,
      savedMessageCount: pair.messageCount,
      sourcePath: managedPath,
      filePath: managedPath,
      indexedAt:
        titleChanged || summaryChanged || contentChanged ? null : existing.indexedAt,
      originKind: "file",
      originRef: null,
    },
  };
}

function findDuplicateIdentityKeys(pairs: ValidatedPair[]): string[] {
  const counts = new Map<string, number>();
  for (const pair of pairs) {
    const key = identityKey(pair.meta.source, pair.meta.id);
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
  validPairs: ValidatedPair[];
  author: string;
  hasFailures: boolean;
  hasAuthorGuardFailure: boolean;
}): FillPlan {
  const hiddenForeignAuthorIds = new Set<string>();
  for (const action of args.actions) {
    if (
      args.author &&
      isFillWriteAction(action) &&
      action.conversation.originKind === "file" &&
      action.conversation.author !== args.author
    ) {
      hiddenForeignAuthorIds.add(action.conversation.id);
    }
  }

  return {
    actions: args.actions,
    warnings: args.warnings,
    ignoredCount: args.ignoredCount,
    validCandidateCount: args.validPairs.length,
    hiddenForeignAuthorCount: hiddenForeignAuthorIds.size,
    allValidCandidatesMatchAuthor:
      args.validPairs.length > 0 &&
      args.author.length > 0 &&
      args.validPairs.every((pair) => pair.meta.author === args.author),
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
