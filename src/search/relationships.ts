import {
  classifyInstalledRelationshipInspectionVersion,
  classifyInstalledTranscriptProjectionVersion,
} from "../adapters/registry.js";
import type { ConversationMeta } from "../models/conversation.js";
import {
  buildRelatedConversationGraphs,
  conversationIdentityKey,
  projectRelatedConversationGraph,
  type ConversationIdentity,
  type RelationshipCompleteness,
} from "../relationships/graph.js";
import type { IndexedConversationHit } from "./indexer.js";

export interface RelatedConversationSearchHit
  extends IndexedConversationHit {
  knownRootIdentity: ConversationIdentity;
  endpointCount: number;
  relationshipCompleteness: RelationshipCompleteness;
  snippetBranchId: string;
}

export function hasCurrentSearchContracts(
  conversation: ConversationMeta,
): boolean {
  return (
    classifyInstalledRelationshipInspectionVersion(
      conversation.source,
      conversation.relationshipInspection.version,
    ) === "current" &&
    classifyInstalledTranscriptProjectionVersion(
      conversation.source,
      conversation.transcriptProjectionVersion,
    ) === "current"
  );
}

export function selectIndexEligibleConversations(
  conversations: readonly ConversationMeta[],
  options: {
    indexAllBranches?: boolean;
  } = {},
): ConversationMeta[] {
  const current = conversations.filter(
    (conversation) =>
      conversation.state === "saved" &&
      hasCurrentSearchContracts(conversation),
  );
  if (options.indexAllBranches) {
    return current;
  }

  const eligibleIds = new Set<string>();
  for (const graph of buildRelatedConversationGraphs(current)) {
    if (graph.completeness === "invalid") {
      for (const branch of graph.branches) {
        eligibleIds.add(branch.conversation.id);
      }
      continue;
    }

    const projection = projectRelatedConversationGraph(
      graph,
      new Set(graph.branches.map((branch) =>
        conversationIdentityKey(branch.identity))),
      { branchStatusPolicy: "indexing" },
    );
    if (!projection) {
      continue;
    }

    for (const branch of projection.visibleBranches) {
      const branchStatus = projection.branchStatuses.get(
        conversationIdentityKey(branch.identity),
      );
      if (branchStatus !== "superseded") {
        eligibleIds.add(branch.conversation.id);
      }
    }
  }

  return current.filter((conversation) => eligibleIds.has(conversation.id));
}

export function collapseRelatedConversationSearchHits(
  graphUniverse: readonly ConversationMeta[],
  hits: readonly IndexedConversationHit[],
  options: {
    allBranches?: boolean;
  } = {},
): RelatedConversationSearchHit[] {
  const hitsByConversationId = new Map(
    hits.map((hit) => [hit.conversationId, hit] as const),
  );
  const resultByConversationId = new Map<string, RelatedConversationSearchHit>();

  for (const graph of buildRelatedConversationGraphs(
    graphUniverse.filter(hasCurrentSearchContracts),
  )) {
    const projection = projectRelatedConversationGraph(
      graph,
      new Set(
        graph.branches.map((branch) => conversationIdentityKey(branch.identity)),
      ),
    );
    const matchingHits = graph.branches
      .map((branch) => hitsByConversationId.get(branch.conversation.id))
      .filter((hit): hit is IndexedConversationHit => hit != null)
      .sort((left, right) =>
        right.score - left.score ||
        left.conversationId.localeCompare(right.conversationId),
      );
    if (matchingHits.length === 0) {
      continue;
    }

    const returnedHits =
      options.allBranches || graph.completeness === "invalid"
        ? matchingHits
        : [matchingHits[0]!];
    for (const hit of returnedHits) {
      resultByConversationId.set(hit.conversationId, {
        ...hit,
        knownRootIdentity: graph.root,
        endpointCount: projection?.endpointCount ?? graph.branches.length,
        relationshipCompleteness: graph.completeness,
        snippetBranchId: hit.conversationId,
      });
    }
  }

  return hits
    .map((hit) => resultByConversationId.get(hit.conversationId))
    .filter(
      (hit): hit is RelatedConversationSearchHit => hit != null,
    );
}
