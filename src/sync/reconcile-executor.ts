import type { Database } from "sql.js";

import { requireGitConversationForRemote } from "../conversations/write-guards.js";
import { getConversationByIdInDb } from "../db/index.js";
import {
  unsafeDeleteConversationInDb,
  unsafeInsertConversationInDb,
  unsafeUpdateConversationInDb,
} from "../db/unsafe-conversations.js";
import type { ReconcileAction } from "../interchange/reconcile.js";
import { ClogError } from "../utils/errors.js";

export function applyGitReconciliationActionInDb(
  db: Database,
  remoteUrl: string,
  action: ReconcileAction,
): void {
  if (action.kind === "insert") {
    requireGitConversationForRemote(action.conversation, remoteUrl, "git reconciliation");
    unsafeInsertConversationInDb(db, action.conversation);
    return;
  }

  if (action.kind === "update") {
    requireGitConversationForRemote(action.conversation, remoteUrl, "git reconciliation");
    const current = getConversationByIdInDb(db, action.conversation.id);
    if (!current) {
      throw new ClogError(`Conversation "${action.conversation.id}" not found.`);
    }
    requireGitConversationForRemote(current, remoteUrl, "git reconciliation");
    unsafeUpdateConversationInDb(db, action.conversation);
    return;
  }

  if (action.kind === "delete") {
    const current = getConversationByIdInDb(db, action.rowId);
    if (!current) {
      return;
    }
    requireGitConversationForRemote(current, remoteUrl, "git reconciliation");
    unsafeDeleteConversationInDb(db, action.rowId);
  }
}
