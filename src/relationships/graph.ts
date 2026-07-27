import type {
  ConversationRelationship,
  OriginKind,
} from "../models/conversation.js";

export interface ConversationIdentity {
  source: string;
  sourceId: string;
}

export interface RelatedConversationInput {
  id: string;
  source: string;
  sourceId: string;
  createdAt: string;
  sourceMtime: string | null;
  originKind: OriginKind;
  relationships: ConversationRelationship[];
}

export interface RelatedConversationRelationshipOverride
  extends ConversationIdentity {
  relationships: ConversationRelationship[];
  observationConflict?: boolean;
}

export type RelationshipCompleteness = "complete" | "incomplete" | "invalid";
export type ConversationLiveness = "live" | "superseded" | "unproven";
export type ConversationLivenessPolicy = "display" | "indexing";

export type RelationshipGraphWarning =
  | {
      code: "conversation_relationship_self_parent";
      conversation: ConversationIdentity;
    }
  | {
      code: "conversation_relationship_parent_conflict";
      conversation: ConversationIdentity;
      parents: ConversationIdentity[];
    }
  | {
      code: "conversation_relationship_cycle";
      conversations: ConversationIdentity[];
    }
  | {
      code: "conversation_relationship_observation_conflict";
      conversation: ConversationIdentity;
      parents: ConversationIdentity[];
    };

interface RelatedConversationMember<T extends RelatedConversationInput> {
  conversation: T;
  identity: ConversationIdentity;
  parent: ConversationIdentity | null;
  parentRelationship: ConversationRelationship | null;
  children: ConversationIdentity[];
}

export interface RelatedConversationGraph<T extends RelatedConversationInput> {
  root: ConversationIdentity;
  completeness: RelationshipCompleteness;
  members: RelatedConversationMember<T>[];
  externalParents: ConversationIdentity[];
  warnings: RelationshipGraphWarning[];
}

export interface RelatedConversationProjection<T extends RelatedConversationInput> {
  graph: RelatedConversationGraph<T>;
  visibleMembers: RelatedConversationMember<T>[];
  representative: RelatedConversationMember<T>;
  liveness: Map<string, ConversationLiveness>;
  liveEndpoints: RelatedConversationMember<T>[];
  branchCount: number;
  hasHiddenMembers: boolean;
}

interface NormalizedNode<T extends RelatedConversationInput> {
  conversation: T;
  identity: ConversationIdentity;
  parent: ConversationIdentity | null;
  parentRelationship: ConversationRelationship | null;
}

interface ProjectedChild<T extends RelatedConversationInput> {
  member: RelatedConversationMember<T>;
  forkCreatedAt: string;
}

export function conversationIdentityKey(
  identity: ConversationIdentity,
): string {
  return `${identity.source}\u0000${identity.sourceId}`;
}

function compareConversationIdentities(
  left: ConversationIdentity,
  right: ConversationIdentity,
): number {
  return (
    left.source.localeCompare(right.source) ||
    left.sourceId.localeCompare(right.sourceId)
  );
}

export function buildRelatedConversationGraphs<T extends RelatedConversationInput>(
  conversations: readonly T[],
  relationshipOverrides: readonly RelatedConversationRelationshipOverride[] = [],
): RelatedConversationGraph<T>[] {
  const warnings: RelationshipGraphWarning[] = [];
  const nodes = normalizeNodes(
    conversations,
    buildRelationshipOverrideMap(relationshipOverrides),
    warnings,
  );
  const nodesByKey = new Map(
    nodes.map((node) => [conversationIdentityKey(node.identity), node] as const),
  );
  const adjacency = new Map<string, Set<string>>();
  const identities = new Map<string, ConversationIdentity>();

  for (const node of nodes) {
    const key = conversationIdentityKey(node.identity);
    identities.set(key, node.identity);
    ensureSet(adjacency, key);
    if (!node.parent) {
      continue;
    }

    const parentKey = conversationIdentityKey(node.parent);
    identities.set(parentKey, node.parent);
    ensureSet(adjacency, key).add(parentKey);
    ensureSet(adjacency, parentKey).add(key);
  }

  const cycles = detectCycles(nodes);
  warnings.push(...cycles);
  const invalidKeys = new Set<string>();
  for (const warning of warnings) {
    if (warning.code === "conversation_relationship_self_parent") {
      invalidKeys.add(conversationIdentityKey(warning.conversation));
    } else if (warning.code === "conversation_relationship_parent_conflict") {
      invalidKeys.add(conversationIdentityKey(warning.conversation));
    } else if (warning.code === "conversation_relationship_cycle") {
      for (const identity of warning.conversations) {
        invalidKeys.add(conversationIdentityKey(identity));
      }
    } else {
      invalidKeys.add(conversationIdentityKey(warning.conversation));
    }
  }

  const graphs: RelatedConversationGraph<T>[] = [];
  const visited = new Set<string>();
  const orderedKeys = [...adjacency.keys()].sort((left, right) =>
    compareConversationIdentities(identities.get(left)!, identities.get(right)!),
  );

  for (const startKey of orderedKeys) {
    if (visited.has(startKey)) {
      continue;
    }

    const componentKeys = collectComponent(startKey, adjacency, visited);
    const concreteNodes = componentKeys
      .map((key) => nodesByKey.get(key))
      .filter((node): node is NormalizedNode<T> => node != null)
      .sort((left, right) =>
        compareConversationIdentities(left.identity, right.identity),
      );
    if (concreteNodes.length === 0) {
      continue;
    }

    const externalParents = componentKeys
      .filter((key) => !nodesByKey.has(key))
      .map((key) => identities.get(key)!)
      .sort(compareConversationIdentities);
    const componentWarnings = warnings.filter((warning) =>
      warningTouchesComponent(warning, new Set(componentKeys)),
    );
    const componentInvalid = componentKeys.some((key) => invalidKeys.has(key));
    const root = selectRoot(concreteNodes, externalParents, componentInvalid);
    const childrenByParent = new Map<string, ConversationIdentity[]>();

    for (const node of concreteNodes) {
      if (!node.parent) {
        continue;
      }
      ensureArray(
        childrenByParent,
        conversationIdentityKey(node.parent),
      ).push(node.identity);
    }

    graphs.push({
      root,
      completeness: componentInvalid
        ? "invalid"
        : externalParents.length > 0
          ? "incomplete"
          : "complete",
      members: concreteNodes.map((node) => ({
        conversation: node.conversation,
        identity: node.identity,
        parent: node.parent,
        parentRelationship: node.parentRelationship,
        children: (childrenByParent.get(conversationIdentityKey(node.identity)) ?? [])
          .sort(compareConversationIdentities),
      })),
      externalParents,
      warnings: componentWarnings,
    });
  }

  return graphs.sort((left, right) =>
    compareConversationIdentities(left.root, right.root),
  );
}

export function projectRelatedConversationGraph<
  T extends RelatedConversationInput,
>(
  graph: RelatedConversationGraph<T>,
  visibleIdentityKeys: ReadonlySet<string>,
  options: {
    livenessPolicy?: ConversationLivenessPolicy;
  } = {},
): RelatedConversationProjection<T> | null {
  const visibleMembers = graph.members.filter((member) =>
    visibleIdentityKeys.has(conversationIdentityKey(member.identity)),
  );
  if (visibleMembers.length === 0) {
    return null;
  }

  const visibleKeys = new Set(
    visibleMembers.map((member) => conversationIdentityKey(member.identity)),
  );
  const membersByKey = new Map(
    graph.members.map((member) => [
      conversationIdentityKey(member.identity),
      member,
    ] as const),
  );
  const visibleChildren = new Map<string, ProjectedChild<T>[]>();
  for (const member of visibleMembers) {
    const memberKey = conversationIdentityKey(member.identity);
    for (const childIdentity of member.children) {
      const child = membersByKey.get(conversationIdentityKey(childIdentity));
      if (!child) {
        continue;
      }
      ensureArray(visibleChildren, memberKey).push(
        ...findProjectedChildren(
          child,
          child.conversation.createdAt,
          membersByKey,
          visibleKeys,
          new Set([memberKey]),
        ),
      );
    }
  }

  const liveness = new Map<string, ConversationLiveness>();
  for (const member of visibleMembers) {
    const memberKey = conversationIdentityKey(member.identity);
    const children = visibleChildren.get(memberKey) ?? [];
    liveness.set(
      memberKey,
      classifyLiveness(
        member.conversation,
        children.map((child) => child.forkCreatedAt),
        options.livenessPolicy ?? "display",
      ),
    );
  }

  const liveEndpoints = visibleMembers.filter(
    (member) =>
      liveness.get(conversationIdentityKey(member.identity)) === "live",
  );
  const representativePool =
    liveEndpoints.length > 0 ? liveEndpoints : visibleMembers;
  const representative = [...representativePool].sort(compareMembersByRecency)[0]!;

  return {
    graph,
    visibleMembers,
    representative,
    liveness,
    liveEndpoints,
    branchCount: liveEndpoints.length,
    hasHiddenMembers: visibleMembers.length < graph.members.length,
  };
}

function findProjectedChildren<T extends RelatedConversationInput>(
  member: RelatedConversationMember<T>,
  forkCreatedAt: string,
  membersByKey: ReadonlyMap<string, RelatedConversationMember<T>>,
  visibleKeys: ReadonlySet<string>,
  visited: Set<string>,
): ProjectedChild<T>[] {
  const memberKey = conversationIdentityKey(member.identity);
  if (visited.has(memberKey)) {
    return [];
  }
  visited.add(memberKey);

  if (visibleKeys.has(memberKey)) {
    return [{ member, forkCreatedAt }];
  }

  return member.children.flatMap((childIdentity) => {
    const child = membersByKey.get(conversationIdentityKey(childIdentity));
    return child
      ? findProjectedChildren(
          child,
          forkCreatedAt,
          membersByKey,
          visibleKeys,
          new Set(visited),
        )
      : [];
  });
}

export function projectRelatedConversationGraphs<
  T extends RelatedConversationInput,
>(
  graphs: readonly RelatedConversationGraph<T>[],
  visibleConversations: readonly T[],
  options: {
    livenessPolicy?: ConversationLivenessPolicy;
  } = {},
): RelatedConversationProjection<T>[] {
  const visibleKeys = new Set(
    visibleConversations.map((conversation) =>
      conversationIdentityKey(conversation),
    ),
  );
  return graphs
    .map((graph) =>
      projectRelatedConversationGraph(graph, visibleKeys, options),
    )
    .filter(
      (projection): projection is RelatedConversationProjection<T> =>
        projection != null,
    );
}

function normalizeNodes<T extends RelatedConversationInput>(
  conversations: readonly T[],
  relationshipOverrides: ReadonlyMap<
    string,
    RelatedConversationRelationshipOverride
  >,
  warnings: RelationshipGraphWarning[],
): NormalizedNode<T>[] {
  const grouped = new Map<string, T[]>();
  for (const conversation of conversations) {
    ensureArray(grouped, conversationIdentityKey(conversation)).push(conversation);
  }

  const normalized: NormalizedNode<T>[] = [];
  for (const entries of grouped.values()) {
    const ordered = [...entries].sort(
      (left, right) =>
        left.id.localeCompare(right.id) ||
        stableGraphInputKey(left).localeCompare(stableGraphInputKey(right)),
    );
    const conversation = ordered[0]!;
    const identity = identityFor(conversation);
    const relationshipOverride = relationshipOverrides.get(
      conversationIdentityKey(identity),
    );
    const relationships =
      relationshipOverride?.relationships ??
      ordered.flatMap((entry) => entry.relationships);
    const distinctParents = uniqueParents(relationships);
    const confirmedParents = distinctParents.filter((candidate) =>
      relationships.some(
        (relationship) =>
          relationship.evidence === "source" &&
          sameIdentity(relationship.parent, candidate),
      ),
    );
    const eligibleParents =
      confirmedParents.length > 0 ? confirmedParents : distinctParents;

    let parent: ConversationIdentity | null = null;
    let parentRelationship: ConversationRelationship | null = null;
    if (relationshipOverride?.observationConflict) {
      warnings.push({
        code: "conversation_relationship_observation_conflict",
        conversation: identity,
        parents: eligibleParents.sort(compareConversationIdentities),
      });
    } else if (eligibleParents.length > 1) {
      warnings.push({
        code: "conversation_relationship_parent_conflict",
        conversation: identity,
        parents: eligibleParents.sort(compareConversationIdentities),
      });
    } else if (eligibleParents.length === 1) {
      const candidate = eligibleParents[0]!;
      if (sameIdentity(identity, candidate)) {
        warnings.push({
          code: "conversation_relationship_self_parent",
          conversation: identity,
        });
      } else {
        parent = candidate;
        parentRelationship = selectParentRelationship(
          relationships,
          candidate,
        );
      }
    }

    normalized.push({
      conversation,
      identity,
      parent,
      parentRelationship,
    });
  }

  return normalized.sort((left, right) =>
    compareConversationIdentities(left.identity, right.identity),
  );
}

function buildRelationshipOverrideMap(
  overrides: readonly RelatedConversationRelationshipOverride[],
): Map<string, RelatedConversationRelationshipOverride> {
  const grouped = new Map<string, RelatedConversationRelationshipOverride[]>();
  for (const override of overrides) {
    ensureArray(grouped, conversationIdentityKey(override)).push(override);
  }

  return new Map(
    [...grouped.entries()].map(([key, entries]) => {
      const ordered = [...entries].sort((left, right) =>
        stableGraphInputKey(left).localeCompare(stableGraphInputKey(right)),
      );
      return [
        key,
        {
          source: ordered[0]!.source,
          sourceId: ordered[0]!.sourceId,
          relationships: ordered.flatMap((entry) => entry.relationships),
          observationConflict: ordered.some(
            (entry) => entry.observationConflict === true,
          ),
        },
      ];
    }),
  );
}

function uniqueParents(
  relationships: readonly ConversationRelationship[],
): ConversationIdentity[] {
  const parents = new Map<string, ConversationIdentity>();
  for (const relationship of relationships) {
    parents.set(
      conversationIdentityKey(relationship.parent),
      relationship.parent,
    );
  }
  return [...parents.values()];
}

function selectParentRelationship(
  relationships: readonly ConversationRelationship[],
  parent: ConversationIdentity,
): ConversationRelationship {
  return [...relationships]
    .filter((relationship) => sameIdentity(relationship.parent, parent))
    .sort(
      (left, right) =>
        relationshipEvidencePriority(left.evidence) -
          relationshipEvidencePriority(right.evidence) ||
        stableGraphInputKey(left).localeCompare(stableGraphInputKey(right)),
    )[0]!;
}

function relationshipEvidencePriority(
  evidence: ConversationRelationship["evidence"],
): number {
  return evidence === "source" ? 0 : 1;
}

function detectCycles<T extends RelatedConversationInput>(
  nodes: readonly NormalizedNode<T>[],
): RelationshipGraphWarning[] {
  const nodesByKey = new Map(
    nodes.map((node) => [conversationIdentityKey(node.identity), node] as const),
  );
  const state = new Map<string, "visiting" | "visited">();
  const warnings: RelationshipGraphWarning[] = [];
  const recordedCycles = new Set<string>();

  for (const node of nodes) {
    const path: string[] = [];
    const pathIndexes = new Map<string, number>();
    let current: NormalizedNode<T> | undefined = node;

    while (current) {
      const key = conversationIdentityKey(current.identity);
      if (state.get(key) === "visited") {
        break;
      }
      const cycleStart = pathIndexes.get(key);
      if (cycleStart != null) {
        const cycleKeys = path.slice(cycleStart);
        const identities = cycleKeys
          .map((cycleKey) => nodesByKey.get(cycleKey)!.identity)
          .sort(compareConversationIdentities);
        const signature = identities.map(conversationIdentityKey).join("\u0001");
        if (!recordedCycles.has(signature)) {
          recordedCycles.add(signature);
          warnings.push({
            code: "conversation_relationship_cycle",
            conversations: identities,
          });
        }
        break;
      }

      pathIndexes.set(key, path.length);
      path.push(key);
      state.set(key, "visiting");
      current = current.parent
        ? nodesByKey.get(conversationIdentityKey(current.parent))
        : undefined;
    }

    for (const key of path) {
      state.set(key, "visited");
    }
  }

  return warnings;
}

function collectComponent(
  startKey: string,
  adjacency: ReadonlyMap<string, Set<string>>,
  visited: Set<string>,
): string[] {
  const component: string[] = [];
  const pending = [startKey];
  while (pending.length > 0) {
    const key = pending.pop()!;
    if (visited.has(key)) {
      continue;
    }
    visited.add(key);
    component.push(key);
    for (const neighbor of adjacency.get(key) ?? []) {
      if (!visited.has(neighbor)) {
        pending.push(neighbor);
      }
    }
  }
  return component;
}

function selectRoot<T extends RelatedConversationInput>(
  nodes: readonly NormalizedNode<T>[],
  externalParents: readonly ConversationIdentity[],
  invalid: boolean,
): ConversationIdentity {
  if (externalParents.length > 0) {
    return externalParents[0]!;
  }
  if (!invalid) {
    const root = nodes.find((node) => node.parent == null);
    if (root) {
      return root.identity;
    }
  }
  return nodes.map((node) => node.identity).sort(compareConversationIdentities)[0]!;
}

function classifyLiveness(
  parent: RelatedConversationInput,
  childForkCreatedAt: readonly string[],
  policy: ConversationLivenessPolicy,
): ConversationLiveness {
  if (childForkCreatedAt.length === 0) {
    return "live";
  }

  const parentActivity =
    policy === "indexing"
      ? parseOptionalTimestamp(parent.sourceMtime)
      : effectiveActivityTime(parent);
  const childForkTimes = childForkCreatedAt.map(parseTimestamp);
  if (
    parentActivity == null ||
    childForkTimes.some((timestamp) => timestamp == null)
  ) {
    return "unproven";
  }

  return parentActivity > Math.max(...childForkTimes as number[])
    ? "live"
    : "superseded";
}

function parseOptionalTimestamp(value: string | null): number | null {
  return value == null ? null : parseTimestamp(value);
}

function compareMembersByRecency<T extends RelatedConversationInput>(
  left: RelatedConversationMember<T>,
  right: RelatedConversationMember<T>,
): number {
  const leftTime = effectiveActivityTime(left.conversation);
  const rightTime = effectiveActivityTime(right.conversation);
  if (leftTime != null && rightTime != null) {
    if (leftTime !== rightTime) {
      return rightTime - leftTime;
    }
    return compareConversationIdentities(left.identity, right.identity);
  }
  if (leftTime != null || rightTime != null) {
    return leftTime != null ? -1 : 1;
  }
  return compareConversationIdentities(left.identity, right.identity);
}

function effectiveActivityTime(
  conversation: RelatedConversationInput,
): number | null {
  if (
    conversation.originKind === "local" &&
    conversation.sourceMtime != null
  ) {
    return parseTimestamp(conversation.sourceMtime);
  }
  return parseTimestamp(conversation.createdAt);
}

function parseTimestamp(value: string): number | null {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function identityFor(
  conversation: Pick<RelatedConversationInput, "source" | "sourceId">,
): ConversationIdentity {
  return {
    source: conversation.source,
    sourceId: conversation.sourceId,
  };
}

function sameIdentity(
  left: ConversationIdentity,
  right: ConversationIdentity,
): boolean {
  return left.source === right.source && left.sourceId === right.sourceId;
}

function warningTouchesComponent(
  warning: RelationshipGraphWarning,
  componentKeys: ReadonlySet<string>,
): boolean {
  if (warning.code === "conversation_relationship_cycle") {
    return warning.conversations.some((identity) =>
      componentKeys.has(conversationIdentityKey(identity)),
    );
  }
  return componentKeys.has(conversationIdentityKey(warning.conversation));
}

function stableGraphInputKey(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableGraphInputKey).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableGraphInputKey(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function ensureSet<K>(
  map: Map<K, Set<K>>,
  key: K,
): Set<K> {
  const existing = map.get(key);
  if (existing) {
    return existing;
  }
  const created = new Set<K>();
  map.set(key, created);
  return created;
}

function ensureArray<K, V>(
  map: Map<K, V[]>,
  key: K,
): V[] {
  const existing = map.get(key);
  if (existing) {
    return existing;
  }
  const created: V[] = [];
  map.set(key, created);
  return created;
}
