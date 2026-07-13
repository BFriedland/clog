import fs from "node:fs/promises";

import { Command } from "commander";

import { loadConfig } from "../config/index.js";
import type { Config } from "../config/schema.js";
import { listConversationsInDb, withDb } from "../db/index.js";
import {
  isFillWriteAction,
  planFill,
  type FillAction,
  type FillCandidate,
  type FillMode,
  type FillPlan,
} from "../interchange/fill.js";
import { scanPairs, validatePair, type ValidatedPair } from "../interchange/pairs.js";
import type { ClogWarning } from "../models/warnings.js";
import { ClogError } from "../utils/errors.js";
import {
  getImportConversationPath,
  getRawConversationPath,
} from "../utils/paths.js";
import { nowIso } from "../utils/time.js";
import { matchesRemoteClogIgnoreRule, readClogIgnoreRules } from "./clogignore.js";
import { applyFillWriteAction } from "./fill-executor.js";
import {
  assertReadableFillDirectory,
  createPreparedDirectoryInput,
  protectFillInputError,
  type PreparedFillInput,
} from "./fill-input.js";

interface FillOptions {
  own?: boolean;
  dryRun?: boolean;
  allowPartial?: boolean;
  showAllErrors?: boolean;
}

interface FillStats {
  newCount: number;
  updatedCount: number;
  unchangedCount: number;
  skippedCount: number;
}

type FillSkipAction = Extract<FillAction, { kind: "skip" }>;

interface UnsupportedSourceGroup {
  source: string;
  actions: FillSkipAction[];
}

export function buildFillCommand(): Command {
  return new Command("fill")
    .description("Import conversation pair files")
    .argument("<dir>", "Directory containing conversation pair files")
    .option("--own", "Restore pairs authored by the configured user as editable local rows")
    .option("--dry-run", "Plan the import without writing managed files or database rows")
    .option("--allow-partial", "Skip failure-class candidates and import valid candidates")
    .option("--show-all-errors", "Show every pair-level fill error instead of summarizing")
    .action(async (dir: string, options: FillOptions) => {
      await runFillCommand(dir, options);
    });
}

export async function runFillCommand(
  inputDir: string,
  options: FillOptions = {},
): Promise<void> {
  const input = createPreparedDirectoryInput(inputDir);
  const config = await loadConfig();
  const mode: FillMode = options.own ? "own" : "file";
  const author = config.author.trim();

  if (mode === "own" && author.length === 0) {
    throw new ClogError("clog fill --own requires a configured author. Run 'clog config set author <name>' first.");
  }

  try {
    await assertReadableFillDirectory(input);
    await runPreparedFillCommand(input, options, config, mode, author);
  } catch (error) {
    throw protectFillInputError(input, error);
  }
}

async function runPreparedFillCommand(
  input: PreparedFillInput,
  options: FillOptions,
  config: Config,
  mode: FillMode,
  author: string,
): Promise<void> {
  const scannedPairs = await scanPairs(input.physicalRoot, { diagnostics: input });
  if (scannedPairs.length === 0) {
    throw new ClogError(`No conversation pairs found in ${input.suppliedPath}.`);
  }

  const candidates: FillCandidate[] = [];
  for (const scannedPair of scannedPairs) {
    const validation = await validatePair(scannedPair, config, input);
    if (validation.kind === "valid") {
      candidates.push(validation);
    } else {
      candidates.push({
        kind: "invalid" as const,
        scannedPair,
        warning: validation.warning,
        diagnosticPath: input.formatPairPath(scannedPair.normalizedRelativePath),
      });
    }
  }

  const ignoreRules = await readClogIgnoreRules();
  const importTime = nowIso();
  const dryRun = options.dryRun === true;
  const allowPartial = options.allowPartial === true;
  const showAllErrors = options.showAllErrors === true;

  const execution = await withDb(async (db) => {
    let plan = planFill({
      candidates,
      existingRows: listConversationsInDb(db),
      mode,
      author,
      importTime,
      ignoreRules,
      matchesIgnoreRule: matchesRemoteClogIgnoreRule,
      getManagedPath: getManagedPath,
      formatDiagnosticPath: (physicalPath) => input.formatPath(physicalPath),
    });
    plan = await promoteMissingManagedCopies(plan);

    const abortsBeforeWrites =
      plan.hasAuthorGuardFailure || (plan.hasFailures && !allowPartial);
    if (dryRun || abortsBeforeWrites) {
      return {
        plan,
        stats: abortsBeforeWrites ? summarizeAbortedPlan(plan) : summarizePlannedActions(plan),
        abortedBeforeWrites: abortsBeforeWrites,
        staleIndexCount: 0,
      };
    }

    let staleIndexCount = 0;
    for (const action of plan.actions) {
      if (!isFillWriteAction(action)) {
        continue;
      }
      const written = await applyFillWriteAction(db, action, input);
      if (written.indexedAt == null) {
        staleIndexCount += 1;
      }
    }

    return {
      plan,
      stats: summarizePlannedActions(plan),
      abortedBeforeWrites: false,
      staleIndexCount,
    };
  });

  renderFillMessages(execution.plan, { allowPartial, showAllErrors });
  if (execution.abortedBeforeWrites) {
    process.stderr.write(
      `${formatFillAbortMessage(execution.plan, dryRun, showAllErrors, input)}\n`,
    );
    if (execution.plan.hasFailures) {
      process.exitCode = 1;
    }
    return;
  }
  renderFillSummary({
    stats: execution.stats,
    input,
    dryRun,
  });
  renderFillGuidance({
    plan: execution.plan,
    configAuthor: author,
    mode,
    dryRun,
    searchConfigured: config.search != null,
    staleIndexCount: execution.staleIndexCount,
    input,
  });

  if (execution.plan.hasFailures) {
    process.exitCode = 1;
  }
}

function formatFillAbortMessage(
  plan: FillPlan,
  dryRun: boolean,
  showAllErrors: boolean,
  input: PreparedFillInput,
): string {
  const shouldMentionShowAll = shouldSuggestShowAllErrors(plan, showAllErrors);
  if (plan.hasAuthorGuardFailure) {
    const base = dryRun
      ? "Dry run: fill --own found pairs by another author; no conversations would be imported."
      : "error: fill --own found pairs by another author; no conversations were imported.";
    const detailGuidance = shouldMentionShowAll
      ? "Re-run with --show-all-errors to see each pair error"
      : "Fix the pair errors";
    return `${base} ${detailGuidance}, or run clog fill without --own to import them as read-only rows.`;
  }

  const base = dryRun
    ? `Dry run: fill found errors in the ${input.inputDescription}; no conversations would be imported.`
    : `error: fill found errors in the ${input.inputDescription}; no conversations were imported.`;

  if (shouldMentionShowAll) {
    return `${base} Re-run with --show-all-errors to see each pair error, or use --allow-partial to import the valid pairs.`;
  }

  const collapsedPairErrorCount = countBlockedPairs(getCollapsedPairErrorActions(plan));
  const unsupportedSourceCount = getUnsupportedSourceGroups(plan).length;
  const hasUnsupportedSources = unsupportedSourceCount > 0;
  const adapterGuidance =
    unsupportedSourceCount === 1
      ? "use a clog build with an adapter for the unsupported source"
      : "use a clog build with adapters for the unsupported sources";
  if (hasUnsupportedSources && collapsedPairErrorCount === 0) {
    return `${base} ${capitalize(adapterGuidance)}, or use --allow-partial to import the valid pairs.`;
  }
  if (hasUnsupportedSources) {
    return `${base} Fix the ${input.inputDescription}, ${adapterGuidance}, or use --allow-partial to import the valid pairs.`;
  }

  return `${base} Fix the ${input.inputDescription}, or use --allow-partial to import the valid pairs.`;
}

function getManagedPath(pair: ValidatedPair, mode: FillMode): string {
  if (mode === "own") {
    return getRawConversationPath(pair.meta.source, pair.meta.id);
  }

  return getImportConversationPath(pair.meta.source, pair.meta.id);
}

async function promoteMissingManagedCopies(plan: FillPlan): Promise<FillPlan> {
  const actions: FillAction[] = [];
  let changed = false;

  for (const action of plan.actions) {
    if (action.kind === "unchanged" && !(await fileExists(action.managedPath))) {
      changed = true;
      actions.push({
        kind: "update",
        pair: action.pair,
        rowId: action.owner.id,
        managedPath: action.managedPath,
        copyContent: true,
        conversation: action.owner,
      });
      continue;
    }

    actions.push(action);
  }

  return changed ? { ...plan, actions } : plan;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function summarizePlannedActions(plan: FillPlan): FillStats {
  const stats: FillStats = {
    newCount: 0,
    updatedCount: 0,
    unchangedCount: 0,
    skippedCount: 0,
  };

  for (const action of plan.actions) {
    if (action.kind === "insert") {
      stats.newCount += 1;
    } else if (action.kind === "update" || action.kind === "restore_unsaved") {
      stats.updatedCount += 1;
    } else if (action.kind === "unchanged") {
      stats.unchangedCount += 1;
    } else if (action.kind === "skip") {
      stats.skippedCount += action.count ?? 1;
    }
  }

  return stats;
}

function summarizeAbortedPlan(plan: FillPlan): FillStats {
  const planned = summarizePlannedActions(plan);
  return {
    newCount: 0,
    updatedCount: 0,
    unchangedCount: 0,
    skippedCount: planned.skippedCount,
  };
}

function renderFillMessages(
  plan: FillPlan,
  options: { allowPartial: boolean; showAllErrors: boolean },
): void {
  const collapsedPairErrorActions = getCollapsedPairErrorActions(plan);
  const collapsedPairErrorCount = countBlockedPairs(collapsedPairErrorActions);

  if (options.showAllErrors || collapsedPairErrorCount === 1) {
    for (const action of collapsedPairErrorActions) {
      process.stderr.write(`error: ${formatPairErrorDetail(action)}\n`);
    }
  } else if (collapsedPairErrorCount > 1) {
    process.stderr.write(
      `error: ${collapsedPairErrorCount} input pairs could not be imported. Re-run with --show-all-errors to list each pair.\n`,
    );
  }

  renderUnsupportedSourceGroups(
    getUnsupportedSourceGroups(plan),
    options.allowPartial,
    options.showAllErrors,
  );

  for (const action of plan.actions) {
    if (action.kind !== "skip") {
      continue;
    }
    if (action.reason === "ignored" || action.failure) {
      continue;
    }
    process.stderr.write(`notice: ${action.message}\n`);
  }

  if (plan.ignoredCount > 0) {
    process.stderr.write(
      `notice: ${plan.ignoredCount} conversation pair${plan.ignoredCount === 1 ? "" : "s"} skipped by clogignore.\n`,
    );
  }
}

function getCollapsedPairErrorActions(plan: FillPlan): FillSkipAction[] {
  return plan.actions.filter(
    (action): action is FillSkipAction =>
      action.kind === "skip" &&
      action.failure &&
      !isUnsupportedSourceAction(action),
  );
}

function getUnsupportedSourceGroups(plan: FillPlan): UnsupportedSourceGroup[] {
  const groups = new Map<string, UnsupportedSourceGroup>();

  for (const action of plan.actions) {
    if (action.kind !== "skip" || !isUnsupportedSourceAction(action)) {
      continue;
    }

    const source = getUnsupportedSource(action);
    const existing = groups.get(source);
    if (existing) {
      existing.actions.push(action);
    } else {
      groups.set(source, { source, actions: [action] });
    }
  }

  return [...groups.values()];
}

function renderUnsupportedSourceGroups(
  groups: UnsupportedSourceGroup[],
  allowPartial: boolean,
  showAllErrors: boolean,
): void {
  for (const group of groups) {
    const count = countBlockedPairs(group.actions);
    const guidance = allowPartial
      ? `Use a clog build with an adapter for that source to import ${count === 1 ? "that pair" : "those pairs"}.`
      : "Use a clog build with an adapter for that source, or re-run with --allow-partial to import the rest.";
    process.stderr.write(
      `error: ${count} ${count === 1 ? "pair uses" : "pairs use"} source "${group.source}", which this clog build cannot read. ${guidance}\n`,
    );

    if (!showAllErrors) {
      continue;
    }

    for (const action of group.actions) {
      process.stderr.write(`    ${formatUnsupportedSourcePairPath(action)}\n`);
    }
  }
}

function isUnsupportedSourceAction(action: FillSkipAction): boolean {
  return (
    action.reason === "invalid_pair" &&
    action.warning?.code === "unsupported_source"
  );
}

function getUnsupportedSource(action: FillSkipAction): string {
  return (
    action.warning?.source ??
    action.warning?.pair?.source ??
    "unknown"
  );
}

function countBlockedPairs(actions: FillSkipAction[]): number {
  return actions.reduce((count, action) => count + (action.count ?? 1), 0);
}

function formatPairErrorDetail(action: FillSkipAction): string {
  if (action.warning) {
    return `${action.warning.message}${formatWarningDetails(action.warning)}`;
  }

  return action.message;
}

function formatUnsupportedSourcePairPath(action: FillSkipAction): string {
  return (
    action.diagnosticPath ??
    action.scannedPair?.normalizedRelativePath ??
    action.warning?.pair?.id ??
    action.warning?.path ??
    action.message
  );
}

function shouldSuggestShowAllErrors(
  plan: FillPlan,
  showAllErrors: boolean,
): boolean {
  return (
    !showAllErrors &&
    countBlockedPairs(getCollapsedPairErrorActions(plan)) > 1
  );
}

function capitalize(text: string): string {
  return `${text.slice(0, 1).toUpperCase()}${text.slice(1)}`;
}

function renderFillSummary(args: {
  stats: FillStats;
  input: PreparedFillInput;
  dryRun: boolean;
}): void {
  const { stats, input, dryRun } = args;
  const total =
    stats.newCount + stats.updatedCount + stats.unchangedCount + stats.skippedCount;
  const changedParts = [];
  if (stats.newCount > 0) changedParts.push(`${stats.newCount} new`);
  if (stats.updatedCount > 0) changedParts.push(`${stats.updatedCount} updated`);
  if (stats.unchangedCount > 0) changedParts.push(`${stats.unchangedCount} unchanged`);
  const skippedPart = stats.skippedCount > 0 ? `${stats.skippedCount} skipped` : "";
  const noteText =
    changedParts.length > 0 && skippedPart
      ? `${changedParts.join(", ")}; ${skippedPart}`
      : changedParts.length > 0
        ? changedParts.join(", ")
        : skippedPart;
  const note = noteText ? ` (${noteText})` : "";
  const verb = dryRun ? "Dry run: would process" : "Processed";

  process.stderr.write(
    `${verb} ${total} conversation pair${total === 1 ? "" : "s"} from ${input.formatSummaryPath()}${note}\n`,
  );
}

function renderFillGuidance(args: {
  plan: FillPlan;
  configAuthor: string;
  mode: FillMode;
  dryRun: boolean;
  searchConfigured: boolean;
  staleIndexCount: number;
  input: PreparedFillInput;
}): void {
  const {
    plan,
    configAuthor,
    mode,
    dryRun,
    searchConfigured,
    staleIndexCount,
    input,
  } = args;

  if (mode === "file" && plan.hiddenForeignAuthorCount > 0) {
    const verb = dryRun ? "would be" : plan.hiddenForeignAuthorCount === 1 ? "is" : "are";
    process.stderr.write(
      `hint: ${plan.hiddenForeignAuthorCount} imported conversation${plan.hiddenForeignAuthorCount === 1 ? "" : "s"} ${verb} authored by someone else and hidden from the default list. Use 'clog list --all' to include them.\n`,
    );
  }

  if (
    mode === "file" &&
    configAuthor.length > 0 &&
    plan.allValidCandidatesMatchAuthor
  ) {
    process.stderr.write(
      `hint: All importable pairs from ${input.suppliedPath} are authored by the configured user. Re-run this fill with --own to restore editable local rows.\n`,
    );
  }

  if (!dryRun && searchConfigured && staleIndexCount > 0) {
    process.stderr.write(
      `hint: ${staleIndexCount} filled conversation${staleIndexCount === 1 ? "" : "s"} need search indexing. Run 'clog index' to index them.\n`,
    );
  }
}

function formatWarningDetails(warning: ClogWarning): string {
  const details = [
    warning.path ? `path=${warning.path}` : null,
    warning.paths ? `paths=${warning.paths.join(", ")}` : null,
    warning.guidance ? `hint: ${warning.guidance}` : null,
  ].filter(Boolean);

  return details.length > 0 ? ` (${details.join("; ")})` : "";
}
