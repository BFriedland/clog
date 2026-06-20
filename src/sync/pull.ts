import { matchesRemoteClogIgnoreRule, readClogIgnoreRules } from "../cli/clogignore.js";
import type { Config } from "../config/schema.js";
import {
  deleteConversationInDb,
  insertConversationInDb,
  listConversationsInDb,
  updateConversationInDb,
  withDb,
} from "../db/index.js";
import {
  planGitReconciliation,
  scanGitCheckoutPairs,
  type GitReconciliationPlan,
  type ReconcileAction,
} from "../interchange/reconcile.js";
import type { ClogWarning } from "../models/warnings.js";
import { tryDeleteConversationVectors } from "../search/coherence.js";
import { getRemoteRoot } from "./paths.js";

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
  const scan = await scanGitCheckoutPairs(getRemoteRoot(), config);
  const clogIgnoreRules = await readClogIgnoreRules();

  const plan = await withDb((db) => {
    const existingRows = listConversationsInDb(db);
    const planned = planGitReconciliation({
      scan,
      existingRows,
      remoteUrl,
      ignoreRules: clogIgnoreRules,
      matchesIgnoreRule: matchesRemoteClogIgnoreRule,
    });

    for (const action of planned.actions) {
      applyReconciliationAction(db, action);
    }

    return planned;
  });

  const cleanupFailures = await tryDeleteConversationVectors(plan.deletedRowIds);

  return buildStats(plan, cleanupFailures);
}

function applyReconciliationAction(
  db: Parameters<typeof insertConversationInDb>[0],
  action: ReconcileAction,
): void {
  if (action.kind === "insert") {
    insertConversationInDb(db, action.conversation);
    return;
  }

  if (action.kind === "update") {
    updateConversationInDb(db, action.conversation);
    return;
  }

  if (action.kind === "delete") {
    deleteConversationInDb(db, action.rowId);
  }
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
        action.reason !== "invalid_pair"
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
