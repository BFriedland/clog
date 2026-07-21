import type { Database } from "sql.js";

import {
  type ConversationMeta,
  type SavedConversationMeta,
  savedConversationMetaSchema,
  serializeSummaryExtraction,
} from "../models/conversation.js";

const CONVERSATION_UPDATE_SET_SQL = `
  source_id = ?,
  source = ?,
  title = ?,
  summary = ?,
  summary_kind = ?,
  summary_extraction = ?,
  author = ?,
  project_name = ?,
  project_path = ?,
  tags_json = ?,
  slug = ?,
  created_at = ?,
  discovered_at = ?,
  modified_at = ?,
  saved_at = ?,
  saved_message_count = ?,
  save_version = ?,
  source_path = ?,
  file_path = ?,
  source_mtime = ?,
  indexed_at = ?,
  origin_kind = ?,
  origin_ref = ?
`;

export function unsafeInsertConversationInDb(
  db: Database,
  conversation: ConversationMeta,
): void {
  const saved = savedConversationMetaSchema.parse(conversation);
  db.run(
    `
      INSERT INTO conversations (
        id,
        source_id,
        source,
        title,
        summary,
        summary_kind,
        summary_extraction,
        author,
        project_name,
        project_path,
        tags_json,
        slug,
        created_at,
        discovered_at,
        modified_at,
        saved_at,
        saved_message_count,
        save_version,
        source_path,
        file_path,
        source_mtime,
        indexed_at,
        origin_kind,
        origin_ref
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    conversationToParams(saved),
  );
}

export function unsafeUpdateConversationInDb(
  db: Database,
  conversation: ConversationMeta,
): void {
  const saved = savedConversationMetaSchema.parse(conversation);
  db.run(
    `
      UPDATE conversations
      SET ${CONVERSATION_UPDATE_SET_SQL}
      WHERE id = ?
    `,
    [...conversationUpdateParams(saved), saved.id],
  );
}

export function unsafeUpdateLocalConversationInDb(
  db: Database,
  conversation: ConversationMeta,
): number {
  const saved = savedConversationMetaSchema.parse(conversation);
  db.run(
    `
      UPDATE conversations
      SET ${CONVERSATION_UPDATE_SET_SQL}
      WHERE id = ?
        AND origin_kind = 'local'
        AND origin_ref IS NULL
    `,
    [...conversationUpdateParams(saved), saved.id],
  );

  return db.getRowsModified();
}

export function unsafeDeleteConversationInDb(db: Database, id: string): void {
  db.run("DELETE FROM conversations WHERE id = ?", [id]);
}

function conversationToParams(conversation: SavedConversationMeta): unknown[] {
  return [
    conversation.id,
    conversation.sourceId,
    conversation.source,
    conversation.title,
    conversation.summary,
    normalizeSummaryKind(conversation),
    serializeSummaryExtraction(conversation.summaryExtraction),
    conversation.author,
    conversation.projectName,
    conversation.projectPath,
    JSON.stringify(conversation.tags),
    conversation.slug,
    conversation.createdAt,
    conversation.discoveredAt,
    conversation.modifiedAt,
    conversation.savedAt,
    conversation.savedMessageCount,
    conversation.saveVersion,
    conversation.sourcePath,
    conversation.filePath,
    conversation.sourceMtime,
    conversation.indexedAt,
    conversation.originKind,
    conversation.originRef,
  ];
}

function conversationUpdateParams(conversation: SavedConversationMeta): unknown[] {
  return [
    conversation.sourceId,
    conversation.source,
    conversation.title,
    conversation.summary,
    normalizeSummaryKind(conversation),
    serializeSummaryExtraction(conversation.summaryExtraction),
    conversation.author,
    conversation.projectName,
    conversation.projectPath,
    JSON.stringify(conversation.tags),
    conversation.slug,
    conversation.createdAt,
    conversation.discoveredAt,
    conversation.modifiedAt,
    conversation.savedAt,
    conversation.savedMessageCount,
    conversation.saveVersion,
    conversation.sourcePath,
    conversation.filePath,
    conversation.sourceMtime,
    conversation.indexedAt,
    conversation.originKind,
    conversation.originRef,
  ];
}

function normalizeSummaryKind(
  conversation: Pick<ConversationMeta, "summary" | "summaryKind">,
): ConversationMeta["summaryKind"] {
  if (conversation.summaryKind) {
    return conversation.summaryKind;
  }
  return conversation.summary.trim() ? "curated" : "none";
}
