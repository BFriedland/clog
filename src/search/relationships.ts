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
  memberCount: number;
  branchCount: number;
  relationshipCompleteness: RelationshipCompleteness;
  snippetConversationId: string;
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
      for (const member of graph.members) {
        eligibleIds.add(member.conversation.id);
      }
      continue;
    }

    const projection = projectRelatedConversationGraph(
      graph,
      new Set(graph.members.map((member) =>
        conversationIdentityKey(member.identity))),
      { livenessPolicy: "indexing" },
    );
    if (!projection) {
      continue;
    }

    for (const member of projection.visibleMembers) {
      const liveness = projection.liveness.get(
        conversationIdentityKey(member.identity),
      );
      if (liveness !== "superseded") {
        eligibleIds.add(member.conversation.id);
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
        graph.members.map((member) => conversationIdentityKey(member.identity)),
      ),
    );
    const matchingHits = graph.members
      .map((member) => hitsByConversationId.get(member.conversation.id))
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
        memberCount: graph.members.length,
        branchCount: projection?.branchCount ?? graph.members.length,
        relationshipCompleteness: graph.completeness,
        snippetConversationId: hit.conversationId,
      });
    }
  }

  return hits
    .map((hit) => resultByConversationId.get(hit.conversationId))
    .filter(
      (hit): hit is RelatedConversationSearchHit => hit != null,
    );
}
