import type { Database } from "sql.js";

import {
  type ConversationMeta,
  type RelationshipInspection,
  type SavedConversationMeta,
  relationshipInspectionSchema,
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
  origin_ref = ?,
  relationship_status = ?,
  relationship_inspection_version = ?,
  relationship_diagnostic = ?,
  transcript_projection_version = ?
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
        origin_ref,
        relationship_status,
        relationship_inspection_version,
        relationship_diagnostic,
        transcript_projection_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    conversationToParams(saved),
  );
  replaceConversationRelationshipsInDb(db, saved.id, saved.relationships);
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
  replaceConversationRelationshipsInDb(db, saved.id, saved.relationships);
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

  const rowsModified = db.getRowsModified();
  if (rowsModified === 1) {
    replaceConversationRelationshipsInDb(db, saved.id, saved.relationships);
  }
  return rowsModified;
}

export function unsafeDeleteConversationInDb(db: Database, id: string): void {
  db.run("DELETE FROM conversations WHERE id = ?", [id]);
}

export function unsafeReplaceRelationshipInspectionInDb(
  db: Database,
  id: string,
  inspection: RelationshipInspection,
): number {
  const validated = relationshipInspectionSchema.parse(inspection);
  db.run(
    `
      UPDATE conversations
      SET
        relationship_status = ?,
        relationship_inspection_version = ?,
        relationship_diagnostic = ?
      WHERE id = ?
    `,
    [
      validated.status,
      validated.version,
      validated.diagnostic,
      id,
    ],
  );
  const rowsModified = db.getRowsModified();
  if (rowsModified === 1) {
    replaceConversationRelationshipsInDb(db, id, validated.relationships);
  }
  return rowsModified;
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
    conversation.relationshipInspection.status,
    conversation.relationshipInspection.version,
    conversation.relationshipInspection.diagnostic,
    conversation.transcriptProjectionVersion,
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
    conversation.relationshipInspection.status,
    conversation.relationshipInspection.version,
    conversation.relationshipInspection.diagnostic,
    conversation.transcriptProjectionVersion,
  ];
}

function replaceConversationRelationshipsInDb(
  db: Database,
  childId: string,
  relationships: SavedConversationMeta["relationships"],
): void {
  db.run("DELETE FROM conversation_relationships WHERE child_id = ?", [childId]);
  for (const relationship of relationships) {
    db.run(
      `
        INSERT INTO conversation_relationships (
          child_id,
          relationship_kind,
          parent_source,
          parent_source_id,
          evidence_kind,
          branch_point_json
        ) VALUES (?, ?, ?, ?, ?, ?)
      `,
      [
        childId,
        relationship.kind,
        relationship.parent.source,
        relationship.parent.sourceId,
        relationship.evidence,
        relationship.branchPoint == null
          ? null
          : JSON.stringify(relationship.branchPoint),
      ],
    );
  }
}

function normalizeSummaryKind(
  conversation: Pick<ConversationMeta, "summary" | "summaryKind">,
): ConversationMeta["summaryKind"] {
  if (conversation.summaryKind) {
    return conversation.summaryKind;
  }
  return conversation.summary.trim() ? "curated" : "none";
}
