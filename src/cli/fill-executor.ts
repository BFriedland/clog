import fs from "node:fs/promises";

import type { Database } from "sql.js";

import {
  requireFileConversation,
  requireLocalConversation,
} from "../conversations/write-guards.js";
import { getConversationByIdInDb } from "../db/index.js";
import {
  unsafeInsertConversationInDb,
  unsafeUpdateConversationInDb,
} from "../db/unsafe-conversations.js";
import type { FillWriteAction } from "../interchange/fill.js";
import type { ConversationMeta } from "../models/conversation.js";
import { writeFileAtomic } from "../utils/atomic-write.js";
import { ClogError } from "../utils/errors.js";

export async function applyFillWriteAction(
  db: Database,
  action: FillWriteAction,
): Promise<ConversationMeta> {
  const writeKind = action.kind === "insert" ? "insert" : "update";

  validateFillWriteTargetInDb(db, writeKind, action.conversation);
  await ensureManagedContent(action);
  const sourceMtime = (await fs.stat(action.managedPath)).mtime.toISOString();
  const conversation = {
    ...action.conversation,
    sourceMtime,
  };

  if (conversation.originKind === "file") {
    applyFileImportWriteInDb(db, writeKind, conversation);
    return conversation;
  }

  if (conversation.originKind === "local") {
    applyLocalFillWriteInDb(db, writeKind, conversation);
    return conversation;
  }

  throw new ClogError(
    `clog fill cannot write conversation ${conversation.id.slice(0, 8)} because git rows are owned by sync.`,
  );
}

function validateFillWriteTargetInDb(
  db: Database,
  kind: "insert" | "update",
  conversation: ConversationMeta,
): void {
  if (conversation.originKind === "file") {
    const fileConversation = requireFileConversation(conversation, "clog fill");
    if (kind === "update") {
      const current = getConversationByIdInDb(db, fileConversation.id);
      if (!current) {
        throw new ClogError(`Conversation "${fileConversation.id}" not found.`);
      }
      requireFileConversation(current, "clog fill");
    }
    return;
  }

  if (conversation.originKind === "local") {
    const localConversation = requireLocalConversation(conversation, "clog fill --own");
    if (kind === "update") {
      const current = getConversationByIdInDb(db, localConversation.id);
      if (!current) {
        throw new ClogError(`Conversation "${localConversation.id}" not found.`);
      }
      requireLocalConversation(current, "clog fill --own");
    }
    return;
  }

  throw new ClogError(
    `clog fill cannot write conversation ${conversation.id.slice(0, 8)} because git rows are owned by sync.`,
  );
}

function applyFileImportWriteInDb(
  db: Database,
  kind: "insert" | "update",
  conversation: ConversationMeta,
): void {
  const fileConversation = requireFileConversation(conversation, "clog fill");
  if (kind === "insert") {
    unsafeInsertConversationInDb(db, fileConversation);
    return;
  }

  const current = getConversationByIdInDb(db, fileConversation.id);
  if (!current) {
    throw new ClogError(`Conversation "${fileConversation.id}" not found.`);
  }
  requireFileConversation(current, "clog fill");
  unsafeUpdateConversationInDb(db, fileConversation);
}

function applyLocalFillWriteInDb(
  db: Database,
  kind: "insert" | "update",
  conversation: ConversationMeta,
): void {
  const localConversation = requireLocalConversation(conversation, "clog fill --own");
  if (kind === "insert") {
    unsafeInsertConversationInDb(db, localConversation);
    return;
  }

  const current = getConversationByIdInDb(db, localConversation.id);
  if (!current) {
    throw new ClogError(`Conversation "${localConversation.id}" not found.`);
  }
  requireLocalConversation(current, "clog fill --own");
  unsafeUpdateConversationInDb(db, localConversation);
}

async function ensureManagedContent(action: FillWriteAction): Promise<void> {
  if (!action.copyContent && (await fileExists(action.managedPath))) {
    return;
  }

  const content = await fs.readFile(action.pair.jsonlPath);
  await writeFileAtomic(action.managedPath, content);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
