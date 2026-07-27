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
export type BranchStatus = "endpoint" | "superseded" | "unproven";
export type BranchStatusPolicy = "display" | "indexing";

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

interface RelatedConversationBranch<T extends RelatedConversationInput> {
  conversation: T;
  identity: ConversationIdentity;
  parent: ConversationIdentity | null;
  parentRelationship: ConversationRelationship | null;
  children: ConversationIdentity[];
}

export interface RelatedConversationGraph<T extends RelatedConversationInput> {
  root: ConversationIdentity;
  completeness: RelationshipCompleteness;
  branches: RelatedConversationBranch<T>[];
  externalParents: ConversationIdentity[];
  warnings: RelationshipGraphWarning[];
}

export interface RelatedConversationProjection<T extends RelatedConversationInput> {
  graph: RelatedConversationGraph<T>;
  visibleBranches: RelatedConversationBranch<T>[];
  representativeBranch: RelatedConversationBranch<T>;
  branchStatuses: Map<string, BranchStatus>;
  endpoints: RelatedConversationBranch<T>[];
  endpointCount: number;
  hasHiddenBranches: boolean;
}

interface NormalizedNode<T extends RelatedConversationInput> {
  conversation: T;
  identity: ConversationIdentity;
  parent: ConversationIdentity | null;
  parentRelationship: ConversationRelationship | null;
}

interface ProjectedChild<T extends RelatedConversationInput> {
  branch: RelatedConversationBranch<T>;
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
      branches: concreteNodes.map((node) => ({
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
    branchStatusPolicy?: BranchStatusPolicy;
  } = {},
): RelatedConversationProjection<T> | null {
  const visibleBranches = graph.branches.filter((branch) =>
    visibleIdentityKeys.has(conversationIdentityKey(branch.identity)),
  );
  if (visibleBranches.length === 0) {
    return null;
  }

  const visibleKeys = new Set(
    visibleBranches.map((branch) => conversationIdentityKey(branch.identity)),
  );
  const branchesByKey = new Map(
    graph.branches.map((branch) => [
      conversationIdentityKey(branch.identity),
      branch,
    ] as const),
  );
  const visibleChildren = new Map<string, ProjectedChild<T>[]>();
  for (const branch of visibleBranches) {
    const branchKey = conversationIdentityKey(branch.identity);
    for (const childIdentity of branch.children) {
      const child = branchesByKey.get(conversationIdentityKey(childIdentity));
      if (!child) {
        continue;
      }
      ensureArray(visibleChildren, branchKey).push(
        ...findProjectedChildren(
          child,
          child.conversation.createdAt,
          branchesByKey,
          visibleKeys,
          new Set([branchKey]),
        ),
      );
    }
  }

  const branchStatuses = new Map<string, BranchStatus>();
  for (const branch of visibleBranches) {
    const branchKey = conversationIdentityKey(branch.identity);
    const children = visibleChildren.get(branchKey) ?? [];
    branchStatuses.set(
      branchKey,
      classifyBranchStatus(
        branch.conversation,
        children.map((child) => child.forkCreatedAt),
        options.branchStatusPolicy ?? "display",
      ),
    );
  }

  const endpoints = visibleBranches.filter(
    (branch) =>
      branchStatuses.get(conversationIdentityKey(branch.identity)) === "endpoint",
  );
  const representativePool =
    endpoints.length > 0 ? endpoints : visibleBranches;
  const representativeBranch =
    [...representativePool].sort(compareBranchesByRecency)[0]!;

  return {
    graph,
    visibleBranches,
    representativeBranch,
    branchStatuses,
    endpoints,
    endpointCount: endpoints.length,
    hasHiddenBranches: visibleBranches.length < graph.branches.length,
  };
}

function findProjectedChildren<T extends RelatedConversationInput>(
  branch: RelatedConversationBranch<T>,
  forkCreatedAt: string,
  branchesByKey: ReadonlyMap<string, RelatedConversationBranch<T>>,
  visibleKeys: ReadonlySet<string>,
  visited: Set<string>,
): ProjectedChild<T>[] {
  const branchKey = conversationIdentityKey(branch.identity);
  if (visited.has(branchKey)) {
    return [];
  }
  visited.add(branchKey);

  if (visibleKeys.has(branchKey)) {
    return [{ branch, forkCreatedAt }];
  }

  return branch.children.flatMap((childIdentity) => {
    const child = branchesByKey.get(conversationIdentityKey(childIdentity));
    return child
      ? findProjectedChildren(
          child,
          forkCreatedAt,
          branchesByKey,
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
    branchStatusPolicy?: BranchStatusPolicy;
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

function classifyBranchStatus(
  parent: RelatedConversationInput,
  childForkCreatedAt: readonly string[],
  policy: BranchStatusPolicy,
): BranchStatus {
  if (childForkCreatedAt.length === 0) {
    return "endpoint";
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
    ? "endpoint"
    : "superseded";
}

function parseOptionalTimestamp(value: string | null): number | null {
  return value == null ? null : parseTimestamp(value);
}

function compareBranchesByRecency<T extends RelatedConversationInput>(
  left: RelatedConversationBranch<T>,
  right: RelatedConversationBranch<T>,
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
