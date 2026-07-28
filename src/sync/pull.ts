import { matchesRemoteClogIgnoreRule, readClogIgnoreRules } from "../cli/clogignore.js";
import { scanLocalSources } from "../cli/scan.js";
import { getScanWarningsForCommand } from "../cli/common.js";
import type { Config } from "../config/schema.js";
import {
  listConversationsInDb,
  withDb,
} from "../db/index.js";
import {
  planGitReconciliation,
  scanGitCheckoutConversationFiles,
  type GitReconciliationPlan,
} from "../interchange/reconcile.js";
import type { ClogWarning } from "../models/warnings.js";
import { tryDeleteConversationVectors } from "../search/coherence.js";
import { getRemoteRoot } from "./paths.js";
import { applyGitReconciliationActionInDb } from "./reconcile-executor.js";

export interface PullStats {
  inserted: number;
  updated: number;
  deleted: number;
  skipped: number;
  ignored: number;
  warnings: ClogWarning[];
  notices: string[];
  cleanupFailures: string[];
}

export async function reconcileRemote(
  config: Config,
  remoteUrl: string,
): Promise<PullStats> {
  const scan = await scanGitCheckoutConversationFiles(getRemoteRoot(), config);
  const localScan = await scanLocalSources(config);
  const clogIgnoreRules = await readClogIgnoreRules();

  const plan = await withDb((db) => {
    const existingRows = listConversationsInDb(db);
    const planned = planGitReconciliation({
      scan,
      existingRows,
      localCandidates: localScan.candidates,
      incompleteSources: localScan.sourceStatuses
        .filter((status) => !status.complete)
        .map((status) => status.source),
      localWarnings: getScanWarningsForCommand(localScan),
      remoteUrl,
      ignoreRules: clogIgnoreRules,
      matchesIgnoreRule: matchesRemoteClogIgnoreRule,
    });

    for (const action of planned.actions) {
      applyGitReconciliationActionInDb(db, remoteUrl, action);
    }

    return planned;
  }, { mode: "write" });

  const cleanupFailures = await tryDeleteConversationVectors(plan.deletedRowIds);

  return buildStats(plan, cleanupFailures);
}

function buildStats(
  plan: GitReconciliationPlan,
  cleanupFailures: string[],
): PullStats {
  let inserted = 0;
  let updated = 0;
  let deleted = 0;
  let skipped = 0;
  const notices: string[] = [];

  for (const action of plan.actions) {
    if (action.kind === "insert") {
      inserted += 1;
    } else if (action.kind === "update") {
      updated += 1;
    } else if (action.kind === "delete") {
      deleted += 1;
    } else {
      skipped += 1;
      if (
        action.reason !== "ignored" &&
        action.reason !== "invalid_files"
      ) {
        notices.push(action.message);
      }
    }
  }

  return {
    inserted,
    updated,
    deleted,
    skipped,
    ignored: plan.ignoredCount,
    warnings: plan.warnings,
    notices,
    cleanupFailures,
  };
}
