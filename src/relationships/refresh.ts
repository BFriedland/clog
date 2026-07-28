import {
  classifyAdapterVersion,
} from "../adapters/adapter.js";
import {
  getRelationshipInspectionRefreshAdapters,
} from "../adapters/registry.js";
import type { Config } from "../config/schema.js";
import {
  listConversationsWithNoncurrentRelationshipInspection,
  listConversationsWithUnknownRelationshipInspection,
  replaceRelationshipInspectionIfVersionMatches,
} from "../db/index.js";
import type {
  RelationshipInspection,
  SavedConversationMeta,
} from "../models/conversation.js";
import type { ClogWarning } from "../models/warnings.js";

/**
 * Recomputes versioned relationship metadata derived from saved content.
 *
 * This is durable adapter maintenance, not a one-time data migration. An
 * adapter relationship-inspection version increase makes older rows eligible
 * again, while rows already stamped with the current version require no
 * content-file read.
 */
export async function refreshSavedRelationshipInspections(
  config: Config,
): Promise<ClogWarning[]> {
  const adapters = getRelationshipInspectionRefreshAdapters(config);
  const warnings: ClogWarning[] = [];

  for (const adapter of adapters) {
    const rows =
      await listConversationsWithNoncurrentRelationshipInspection(
        adapter.name,
        adapter.relationshipInspectionVersion,
      );

    for (const conversation of rows) {
      const classification = classifyAdapterVersion(
        conversation.relationshipInspection.version,
        adapter.relationshipInspectionVersion,
      );
      if (classification === "current") {
        continue;
      }
      if (classification === "version_skew") {
        warnings.push(
          versionSkewWarning(
            conversation,
            adapter.relationshipInspectionVersion,
          ),
        );
        continue;
      }

      let inspection: RelationshipInspection;
      try {
        if (!conversation.filePath) {
          throw new Error("saved content path is missing");
        }
        const inspectionWarnings: ClogWarning[] = [];
        inspection = await adapter.inspectRelationships(
          conversation.filePath,
          { onWarning: (warning) => inspectionWarnings.push(warning) },
        );
        if (inspection.status !== "unknown") {
          warnings.push(...inspectionWarnings);
        }
      } catch {
        warnings.push(
          relationshipInspectionRefreshFailureWarning(conversation),
        );
        continue;
      }

      const replacement =
        await replaceRelationshipInspectionIfVersionMatches(
          conversation.id,
          conversation.relationshipInspection.version,
          inspection,
        );
      if (!replacement.replaced) {
        const currentClassification = classifyAdapterVersion(
          replacement.conversation.relationshipInspection.version,
          adapter.relationshipInspectionVersion,
        );
        if (currentClassification === "version_skew") {
          warnings.push(
            versionSkewWarning(
              replacement.conversation,
              adapter.relationshipInspectionVersion,
            ),
          );
        } else if (currentClassification === "refreshable") {
          warnings.push(
            relationshipInspectionRefreshFailureWarning(
              replacement.conversation,
            ),
          );
        }
      }
    }
  }

  return warnings;
}

export async function listSavedRelationshipInspectionWarnings(
  config: Config,
): Promise<ClogWarning[]> {
  const adapters = getRelationshipInspectionRefreshAdapters(config);
  const warnings: ClogWarning[] = [];

  for (const adapter of adapters) {
    const conversations =
      await listConversationsWithUnknownRelationshipInspection(
        adapter.name,
        adapter.relationshipInspectionVersion,
      );
    warnings.push(
      ...conversations.map((conversation) =>
        unknownInspectionWarning(conversation)
      ),
    );
  }

  return warnings;
}

function versionSkewWarning(
  conversation: SavedConversationMeta,
  inspectionVersion: number,
): ClogWarning {
  const storedVersion =
    conversation.relationshipInspection.version ?? "unknown";
  return {
    code: "adapter_version_skew",
    message:
      `A saved conversation uses relationship inspection version ${storedVersion}, which is newer than this clog build's version ${inspectionVersion}.`,
    source: conversation.source,
    path: conversation.filePath ?? undefined,
    guidance: "Upgrade clog before reinspecting this conversation.",
  };
}

function relationshipInspectionRefreshFailureWarning(
  conversation: SavedConversationMeta,
): ClogWarning {
  return {
    code: "relationship_inspection_refresh_failed",
    message:
      "Clog could not refresh a saved conversation's branch history.",
    source: conversation.source,
    path: conversation.filePath ?? undefined,
    guidance:
      'Check that the conversation\'s content file exists and is readable, then run "clog status" again. If the file cannot be restored, remove the conversation from clog with "clog remove <id>".',
  };
}

function unknownInspectionWarning(
  conversation: SavedConversationMeta,
): ClogWarning {
  const diagnostic =
    conversation.relationshipInspection.diagnostic ?? "unknown";
  return {
    code: "relationship_inspection_unknown",
    message:
      "Clog could not determine a saved conversation's branch history.",
    source: conversation.source,
    diagnostic,
    path: conversation.filePath ?? undefined,
    guidance:
      "Review or restore the conversation's content file before relying on its branch history.",
  };
}
