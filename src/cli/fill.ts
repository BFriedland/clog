import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { Command } from "commander";

import { loadConfig } from "../config/index.js";
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
  normalizeUserPath,
} from "../utils/paths.js";
import { nowIso } from "../utils/time.js";
import { matchesRemoteClogIgnoreRule, readClogIgnoreRules } from "./clogignore.js";
import { applyFillWriteAction } from "./fill-executor.js";

interface FillOptions {
  own?: boolean;
  dryRun?: boolean;
  allowPartial?: boolean;
}

interface FillStats {
  newCount: number;
  updatedCount: number;
  unchangedCount: number;
  skippedCount: number;
}

export function buildFillCommand(): Command {
  return new Command("fill")
    .description("Import conversation pair files")
    .argument("<dir>", "Directory containing conversation pair files")
    .option("--own", "Restore pairs authored by the configured user as editable local rows")
    .option("--dry-run", "Plan the import without writing managed files or database rows")
    .option("--allow-partial", "Skip failure-class candidates and import valid candidates")
    .action(async (dir: string, options: FillOptions) => {
      await runFillCommand(dir, options);
    });
}

export async function runFillCommand(
  inputDir: string,
  options: FillOptions = {},
): Promise<void> {
  const config = await loadConfig();
  const mode: FillMode = options.own ? "own" : "file";
  const author = config.author.trim();

  if (mode === "own" && author.length === 0) {
    throw new ClogError("clog fill --own requires a configured author. Run 'clog config set author <name>' first.");
  }

  const rootDir = await assertReadableDirectory(inputDir);
  const scannedPairs = await scanPairs(rootDir);
  if (scannedPairs.length === 0) {
    throw new ClogError(`No conversation pairs found in ${inputDir}.`);
  }

  const candidates: FillCandidate[] = [];
  for (const scannedPair of scannedPairs) {
    const validation = await validatePair(scannedPair, config);
    if (validation.kind === "valid") {
      candidates.push(validation);
    } else {
      candidates.push({
        kind: "invalid" as const,
        scannedPair,
        warning: validation.warning,
      });
    }
  }

  const ignoreRules = await readClogIgnoreRules();
  const importTime = nowIso();
  const dryRun = options.dryRun === true;
  const allowPartial = options.allowPartial === true;

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
      const written = await applyFillWriteAction(db, action);
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

  renderFillMessages(execution.plan);
  if (execution.abortedBeforeWrites) {
    process.stderr.write(`${formatFillAbortMessage(execution.plan, dryRun)}\n`);
    if (execution.plan.hasFailures) {
      process.exitCode = 1;
    }
    return;
  }
  renderFillSummary({
    stats: execution.stats,
    inputDir,
    dryRun,
  });
  renderFillGuidance({
    plan: execution.plan,
    configAuthor: author,
    mode,
    dryRun,
    searchConfigured: config.search != null,
    staleIndexCount: execution.staleIndexCount,
  });

  if (execution.plan.hasFailures) {
    process.exitCode = 1;
  }
}

function formatFillAbortMessage(plan: FillPlan, dryRun: boolean): string {
  if (plan.hasAuthorGuardFailure) {
    return dryRun
      ? "Dry run: fill --own found pairs by another author; no conversations would be imported. Fix the pairs above or run clog fill without --own to import them as read-only rows."
      : "error: fill --own found pairs by another author; no conversations were imported. Fix the pairs above or run clog fill without --own to import them as read-only rows.";
  }

  return dryRun
    ? "Dry run: fill found errors in the input directory; no conversations would be imported. Fix the errors above, or use --allow-partial to import the valid pairs."
    : "error: fill found errors in the input directory; no conversations were imported. Fix the errors above, or use --allow-partial to import the valid pairs.";
}

async function assertReadableDirectory(inputDir: string): Promise<string> {
  const rootDir = normalizeUserPath(inputDir);
  let stat;
  try {
    stat = await fs.stat(rootDir);
  } catch (error) {
    throw new ClogError(
      `Fill directory is not readable: ${inputDir} (${(error as Error).message})`,
    );
  }

  if (!stat.isDirectory()) {
    throw new ClogError(`Fill path is not a directory: ${inputDir}`);
  }

  try {
    await fs.access(rootDir, fsConstants.R_OK);
  } catch (error) {
    throw new ClogError(
      `Fill directory is not readable: ${inputDir} (${(error as Error).message})`,
    );
  }

  return rootDir;
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

function renderFillMessages(plan: FillPlan): void {
  for (const warning of plan.warnings) {
    process.stderr.write(`warning: ${warning.message}${formatWarningDetails(warning)}\n`);
  }

  for (const action of plan.actions) {
    if (action.kind !== "skip") {
      continue;
    }
    if (
      action.reason === "ignored" ||
      action.reason === "invalid_pair" ||
      action.reason === "duplicate_identity"
    ) {
      continue;
    }
    process.stderr.write(`${action.failure ? "error" : "notice"}: ${action.message}\n`);
  }

  if (plan.ignoredCount > 0) {
    process.stderr.write(
      `notice: ${plan.ignoredCount} conversation pair${plan.ignoredCount === 1 ? "" : "s"} skipped by clogignore.\n`,
    );
  }
}

function renderFillSummary(args: {
  stats: FillStats;
  inputDir: string;
  dryRun: boolean;
}): void {
  const { stats, inputDir, dryRun } = args;
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
    `${verb} ${total} conversation pair${total === 1 ? "" : "s"} from ${formatSummaryDir(inputDir)}${note}\n`,
  );
}

function renderFillGuidance(args: {
  plan: FillPlan;
  configAuthor: string;
  mode: FillMode;
  dryRun: boolean;
  searchConfigured: boolean;
  staleIndexCount: number;
}): void {
  const { plan, configAuthor, mode, dryRun, searchConfigured, staleIndexCount } = args;

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
      "hint: All importable pairs are authored by the configured user. Use 'clog fill <dir> --own' to restore editable local rows.\n",
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

function formatSummaryDir(inputDir: string): string {
  return inputDir.endsWith(path.sep) ? inputDir : `${inputDir}${path.sep}`;
}
