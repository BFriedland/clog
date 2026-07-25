import type { Message } from "../models/conversation.js";
import type { ClogWarning, ClogWarningCode } from "../models/warnings.js";
import type { Transcript } from "./adapter.js";

type JsonObject = Record<string, unknown>;

interface SourceRecord {
  index: number;
  raw: JsonObject;
}

interface GraphNode extends SourceRecord {
  type: "user" | "assistant" | "attachment" | "system";
  uuid: string;
  physicalParentUuid: string | null;
  logicalParentUuid: string | null;
}

interface ToolCall {
  assistantUuid: string;
  name: string;
  responseKey: string;
}

const GRAPH_TYPES = new Set(["user", "assistant", "attachment", "system"]);
const HIDDEN_USER_WRAPPER_BLOCKS = ["local-command-caveat"];
const LOCAL_COMMAND_WRAPPER_REGEX =
  /<(command-name|command-message|command-args|local-command-stdout|local-command-stderr)>([\s\S]*?)<\/\1>/g;
const ISO_TIMESTAMP_REGEX =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|([+-])(\d{2}):(\d{2}))$/;

const WARNING_MESSAGES: Record<
  Extract<
    ClogWarningCode,
    | "claude_transcript_leaf_order_fallback"
    | "claude_transcript_legacy_file_order"
    | "claude_transcript_malformed_graph_record"
    | "claude_transcript_missing_parent"
    | "claude_transcript_duplicate_uuid"
    | "claude_transcript_parent_cycle"
    | "claude_transcript_tool_result_mismatch"
    | "claude_transcript_compaction_history_missing"
  >,
  string
> = {
  claude_transcript_leaf_order_fallback:
    "Claude Code transcript leaf selection used source order because candidate timestamps were equal or unavailable.",
  claude_transcript_legacy_file_order:
    "Claude Code transcript lacks message ancestry; clog preserved visible records in source order.",
  claude_transcript_malformed_graph_record:
    "Claude Code transcript contains a graph record without a usable identity; clog excluded that record.",
  claude_transcript_missing_parent:
    "Claude Code transcript ancestry is incomplete; clog returned the coherent suffix after the missing parent.",
  claude_transcript_duplicate_uuid:
    "Claude Code transcript contains a duplicate message UUID; clog ignored later occurrences.",
  claude_transcript_parent_cycle:
    "Claude Code transcript contains cyclic message ancestry; clog excluded the cyclic component.",
  claude_transcript_tool_result_mismatch:
    "Claude Code tool-result provenance conflicts with its tool-use identifier; clog excluded the result.",
  claude_transcript_compaction_history_missing:
    "Claude Code compaction points outside the available source file; clog used the persisted compact summary as the available prefix.",
};

export function projectClaudeCodeTranscript(
  values: unknown[],
  filePath: string,
): Transcript {
  const records = values
    .map((value, index): SourceRecord | null => {
      const raw = asObject(value);
      return raw ? { index, raw } : null;
    })
    .filter((record): record is SourceRecord => record !== null);

  if (!hasModernGraphEdge(records)) {
    return projectLegacyTranscript(records, filePath);
  }

  const warnings: ClogWarning[] = [];
  const duplicateUuids = new Set<string>();
  const nodes = new Map<string, GraphNode>();

  for (const record of records) {
    const type = stringValue(record.raw.type);
    if (!type || !GRAPH_TYPES.has(type)) {
      continue;
    }

    const uuid = nonemptyString(record.raw.uuid);
    const parent = record.raw.parentUuid;
    const parentIsUsable =
      parent === undefined || parent === null || nonemptyString(parent) !== null;

    if (!uuid || !parentIsUsable) {
      warnings.push(makeWarning(
        "claude_transcript_malformed_graph_record",
        filePath,
        record,
        uuid,
      ));
      continue;
    }

    if (nodes.has(uuid)) {
      if (!duplicateUuids.has(uuid)) {
        duplicateUuids.add(uuid);
        warnings.push(makeWarning(
          "claude_transcript_duplicate_uuid",
          filePath,
          record,
          uuid,
        ));
      }
      continue;
    }

    nodes.set(uuid, {
      ...record,
      type: type as GraphNode["type"],
      uuid,
      physicalParentUuid: nonemptyString(parent),
      logicalParentUuid:
        type === "system" &&
        record.raw.subtype === "compact_boundary"
          ? nonemptyString(record.raw.logicalParentUuid)
          : null,
    });
  }

  normalizeProgressParents(records, nodes, warnings, filePath);

  const cyclicUuids = findCyclicUuids(nodes);
  for (const component of cyclicUuids.components) {
    const first = nodes.get(component[0]!);
    if (first) {
      warnings.push({
        ...makeWarning(
          "claude_transcript_parent_cycle",
          filePath,
          first,
          first.uuid,
        ),
        relatedUuids: component,
      });
    }
  }

  const children = buildChildren(nodes, cyclicUuids.members);
  const candidates = [...nodes.values()].filter(
    (node) =>
      !cyclicUuids.members.has(node.uuid) &&
      isConversationBearing(node) &&
      !hasConversationBearingDescendant(node, children),
  );

  if (candidates.length === 0) {
    return { messages: [], warnings };
  }

  candidates.sort(compareSourceOrder);
  const selectedLeaf = candidates.at(-1)!;
  const runnerUp = candidates.at(-2);
  if (runnerUp && timestampsNeedSourceOrder(selectedLeaf, runnerUp)) {
    warnings.push({
      ...makeWarning(
        "claude_transcript_leaf_order_fallback",
        filePath,
        selectedLeaf,
        selectedLeaf.uuid,
      ),
      relatedUuids: candidates
        .filter((candidate) => timestampsNeedSourceOrder(selectedLeaf, candidate))
        .map((candidate) => candidate.uuid),
    });
  }

  const activePath = reconstructActivePath(
    selectedLeaf,
    nodes,
    cyclicUuids.members,
    warnings,
    filePath,
  );
  const activeIndexes = new Set(activePath.map((node) => node.index));
  let composition = activePath.filter(
    (node) =>
      node.raw.isSidechain !== true &&
      !compactSummaryReplacedByLogicalHistory(
        node,
        nodes,
        cyclicUuids.members,
      ),
  );

  const activeResponseKeys = unique(
    composition
      .filter((node) => node.type === "assistant")
      .map(assistantResponseKey),
  );
  const activeResponseKeySet = new Set(activeResponseKeys);
  const compositionIndexes = new Set(composition.map((node) => node.index));
  const recoveredAssistants = new Map<string, GraphNode[]>();

  for (const node of nodes.values()) {
    if (
      node.type !== "assistant" ||
      node.raw.isSidechain === true ||
      cyclicUuids.members.has(node.uuid) ||
      compositionIndexes.has(node.index)
    ) {
      continue;
    }

    const responseKey = assistantResponseKey(node);
    if (!activeResponseKeySet.has(responseKey)) {
      continue;
    }
    const responseFragments = recoveredAssistants.get(responseKey) ?? [];
    responseFragments.push(node);
    recoveredAssistants.set(responseKey, responseFragments);
  }
  for (const responseFragments of recoveredAssistants.values()) {
    responseFragments.sort(compareSourceOrder);
  }
  composition = insertAfterLastAssistant(composition, recoveredAssistants);

  const toolCalls = collectToolCalls(composition);
  const acceptedToolResults = new Map<number, Set<number>>();
  const recoveredResults = new Map<string, GraphNode[]>();

  for (const node of nodes.values()) {
    if (
      node.type !== "user" ||
      node.raw.isSidechain === true ||
      cyclicUuids.members.has(node.uuid)
    ) {
      continue;
    }

    const blocks = messageContentBlocks(node);
    const active = activeIndexes.has(node.index);
    for (const [blockIndex, block] of blocks.entries()) {
      if (block.type !== "tool_result") {
        continue;
      }

      const toolUseId = nonemptyString(block.tool_use_id);
      const toolCall = toolUseId ? toolCalls.get(toolUseId) : undefined;
      const sourceAssistantUuid = nonemptyString(
        node.raw.sourceToolAssistantUUID,
      );

      if (
        toolCall &&
        sourceAssistantUuid &&
        sourceAssistantUuid !== toolCall.assistantUuid
      ) {
        warnings.push({
          ...makeWarning(
            "claude_transcript_tool_result_mismatch",
            filePath,
            node,
            node.uuid,
          ),
          sourceLocation: {
            recordIndex: node.index,
            uuid: node.uuid,
            relatedUuid: sourceAssistantUuid,
          },
        });
        continue;
      }

      if (active) {
        addAcceptedToolResult(acceptedToolResults, node.index, blockIndex);
        continue;
      }

      if (!toolCall) {
        continue;
      }

      const compatibleParent =
        sourceAssistantUuid === toolCall.assistantUuid ||
        (
          sourceAssistantUuid === null &&
          node.physicalParentUuid === toolCall.assistantUuid
        );
      if (!compatibleParent) {
        continue;
      }

      addAcceptedToolResult(acceptedToolResults, node.index, blockIndex);
      const recovered = recoveredResults.get(toolCall.responseKey) ?? [];
      if (!recovered.some((record) => record.index === node.index)) {
        recovered.push(node);
        recoveredResults.set(toolCall.responseKey, recovered);
      }
    }
  }

  for (const recovered of recoveredResults.values()) {
    recovered.sort(compareSourceOrder);
  }
  composition = insertAfterLastAssistant(composition, recoveredResults);

  const responseTimestamps = collectResponseTimestamps(composition);
  const messages: Message[] = [];

  for (const node of composition) {
    if (node.type === "assistant") {
      projectAssistantNode(
        node,
        responseTimestamps.get(assistantResponseKey(node)) ?? null,
        messages,
      );
    } else if (node.type === "user") {
      projectUserNode(
        node,
        toolCalls,
        acceptedToolResults.get(node.index),
        messages,
      );
    }
  }

  return { messages, warnings };
}

function hasModernGraphEdge(records: SourceRecord[]): boolean {
  return records.some((record) => {
    const type = stringValue(record.raw.type);
    if (!type || !GRAPH_TYPES.has(type) || !nonemptyString(record.raw.uuid)) {
      return false;
    }
    if (nonemptyString(record.raw.parentUuid)) {
      return true;
    }
    return (
      type === "system" &&
      record.raw.subtype === "compact_boundary" &&
      nonemptyString(record.raw.logicalParentUuid) !== null
    );
  });
}

function projectLegacyTranscript(
  records: SourceRecord[],
  filePath: string,
): Transcript {
  const projectable = records.filter((record) => {
    const type = record.raw.type;
    return (
      (type === "user" || type === "assistant") &&
      record.raw.isSidechain !== true &&
      asObject(record.raw.message) !== null
    );
  });
  const warnings =
    projectable.length >= 2
      ? [makeWarning(
          "claude_transcript_legacy_file_order",
          filePath,
          projectable[0]!,
          nonemptyString(projectable[0]!.raw.uuid),
        )]
      : [];
  const messages: Message[] = [];
  const toolCalls = new Map<string, ToolCall>();

  for (let index = 0; index < projectable.length; index += 1) {
    const record = projectable[index]!;
    if (record.raw.type === "user") {
      projectLegacyUser(record, toolCalls, messages);
      continue;
    }

    const run = [record];
    const messageId = assistantMessageId(record);
    while (
      messageId &&
      projectable[index + 1]?.raw.type === "assistant" &&
      projectable[index + 1]?.index === projectable[index]!.index + 1 &&
      assistantMessageId(projectable[index + 1]!) === messageId
    ) {
      index += 1;
      run.push(projectable[index]!);
    }

    const timestamp = earliestTimestamp(run);
    for (const fragment of run) {
      projectAssistantRecord(
        fragment,
        timestamp,
        messages,
        toolCalls,
        `legacy:${fragment.index}`,
      );
    }
  }

  return { messages, warnings };
}

function normalizeProgressParents(
  records: SourceRecord[],
  nodes: Map<string, GraphNode>,
  warnings: ClogWarning[],
  filePath: string,
): void {
  const progress = new Map<string, SourceRecord>();
  for (const record of records) {
    if (record.raw.type !== "progress") {
      continue;
    }
    const uuid = nonemptyString(record.raw.uuid);
    if (uuid && !progress.has(uuid)) {
      progress.set(uuid, record);
    }
  }

  const cache = new Map<string, string | null>();
  const warnedCycles = new Set<string>();
  const warnedMissing = new Set<string>();

  const resolve = (uuid: string): string | null => {
    if (cache.has(uuid)) {
      return cache.get(uuid) ?? null;
    }

    const visited: string[] = [];
    let current: string | null = uuid;
    while (current && progress.has(current)) {
      if (visited.includes(current)) {
        const cycle = visited.slice(visited.indexOf(current));
        const key = [...cycle].sort().join("\0");
        if (!warnedCycles.has(key)) {
          warnedCycles.add(key);
          const source = progress.get(current)!;
          warnings.push({
            ...makeWarning(
              "claude_transcript_parent_cycle",
              filePath,
              source,
              current,
            ),
            relatedUuids: cycle,
          });
        }
        for (const item of visited) cache.set(item, null);
        return null;
      }

      visited.push(current);
      const parent = progress.get(current)!.raw.parentUuid;
      if (parent === null || parent === undefined) {
        current = null;
        break;
      }
      const parentUuid = nonemptyString(parent);
      if (!parentUuid) {
        current = null;
        break;
      }
      current = parentUuid;
    }

    if (current && !nodes.has(current)) {
      const key = visited.at(-1) ?? uuid;
      if (!warnedMissing.has(key)) {
        warnedMissing.add(key);
        const source = progress.get(key) ?? progress.get(uuid)!;
        warnings.push({
          ...makeWarning(
            "claude_transcript_missing_parent",
            filePath,
            source,
            key,
          ),
          sourceLocation: {
            recordIndex: source.index,
            uuid: key,
            relatedUuid: current,
          },
        });
      }
      current = null;
    }

    for (const item of visited) cache.set(item, current);
    return current;
  };

  for (const node of nodes.values()) {
    if (node.physicalParentUuid && progress.has(node.physicalParentUuid)) {
      node.physicalParentUuid = resolve(node.physicalParentUuid);
    }
  }
}

function findCyclicUuids(nodes: Map<string, GraphNode>): {
  members: Set<string>;
  components: string[][];
} {
  const visited = new Set<string>();
  const finishOrder: string[] = [];
  const reverseEdges = new Map<string, string[]>();

  for (const node of nodes.values()) {
    for (const parent of graphParents(node, nodes)) {
      const children = reverseEdges.get(parent.uuid) ?? [];
      children.push(node.uuid);
      reverseEdges.set(parent.uuid, children);
    }
  }

  for (const uuid of nodes.keys()) {
    if (visited.has(uuid)) {
      continue;
    }

    const stack = [{
      uuid,
      parents: graphParents(nodes.get(uuid)!, nodes).map((parent) => parent.uuid),
      nextParentIndex: 0,
    }];
    visited.add(uuid);

    while (stack.length > 0) {
      const frame = stack.at(-1)!;
      const parentUuid = frame.parents[frame.nextParentIndex];
      if (parentUuid !== undefined) {
        frame.nextParentIndex += 1;
        if (!visited.has(parentUuid)) {
          visited.add(parentUuid);
          stack.push({
            uuid: parentUuid,
            parents: graphParents(nodes.get(parentUuid)!, nodes).map(
              (parent) => parent.uuid,
            ),
            nextParentIndex: 0,
          });
        }
        continue;
      }

      finishOrder.push(frame.uuid);
      stack.pop();
    }
  }

  const assigned = new Set<string>();
  const components: string[][] = [];

  for (
    let finishIndex = finishOrder.length - 1;
    finishIndex >= 0;
    finishIndex -= 1
  ) {
    const uuid = finishOrder[finishIndex]!;
    if (assigned.has(uuid)) {
      continue;
    }

    const component: string[] = [];
    const stack = [uuid];
    assigned.add(uuid);
    while (stack.length > 0) {
      const member = stack.pop()!;
      component.push(member);
      for (const childUuid of reverseEdges.get(member) ?? []) {
        if (!assigned.has(childUuid)) {
          assigned.add(childUuid);
          stack.push(childUuid);
        }
      }
    }

    const selfLoop =
      component.length === 1 &&
      graphParents(nodes.get(component[0]!)!, nodes).some(
        (parent) => parent.uuid === component[0],
      );
    if (component.length > 1 || selfLoop) {
      components.push(component.sort((left, right) =>
        nodes.get(left)!.index - nodes.get(right)!.index
      ));
    }
  }

  return {
    members: new Set(components.flat()),
    components: components.sort(
      (left, right) => nodes.get(left[0]!)!.index - nodes.get(right[0]!)!.index,
    ),
  };
}

function graphParents(
  node: GraphNode,
  nodes: Map<string, GraphNode>,
): GraphNode[] {
  const uuids = unique([
    node.physicalParentUuid,
    node.logicalParentUuid,
  ].filter((uuid): uuid is string => uuid !== null));
  return uuids
    .map((uuid) => nodes.get(uuid))
    .filter((parent): parent is GraphNode => parent !== undefined);
}

function isConversationBearing(node: GraphNode): boolean {
  if (node.raw.isSidechain === true) {
    return false;
  }

  const message = asObject(node.raw.message);
  if (node.type === "assistant") {
    return message !== null;
  }
  if (
    node.type !== "user" ||
    !message ||
    node.raw.isMeta === true ||
    node.raw.isCompactSummary === true
  ) {
    return false;
  }

  const content = message.content;
  if (typeof content === "string") {
    return (
      normalizeVisibleUserText(content) !== "" &&
      !isEntireLocalCommandWrapper(content)
    );
  }
  if (!Array.isArray(content)) {
    return false;
  }

  return content.some((value) => {
    const block = asObject(value);
    if (!block) return false;
    if (
      block.type === "image" ||
      block.type === "document" ||
      block.type === "tool_result"
    ) {
      return true;
    }
    return block.type === "text" && typeof block.text === "string" &&
      normalizeVisibleUserText(block.text) !== "";
  });
}

function hasConversationBearingDescendant(
  node: GraphNode,
  children: Map<string, GraphNode[]>,
): boolean {
  const pending = [...(children.get(node.uuid) ?? [])];
  const visited = new Set<string>();

  while (pending.length > 0) {
    const child = pending.pop()!;
    if (visited.has(child.uuid)) continue;
    visited.add(child.uuid);
    if (isConversationBearing(child)) return true;
    pending.push(...(children.get(child.uuid) ?? []));
  }
  return false;
}

function buildChildren(
  nodes: Map<string, GraphNode>,
  cyclicUuids: Set<string>,
): Map<string, GraphNode[]> {
  const children = new Map<string, GraphNode[]>();
  for (const node of nodes.values()) {
    if (cyclicUuids.has(node.uuid)) continue;
    for (const parent of graphParents(node, nodes)) {
      if (cyclicUuids.has(parent.uuid)) continue;
      const existing = children.get(parent.uuid) ?? [];
      existing.push(node);
      children.set(parent.uuid, existing);
    }
  }
  return children;
}

function reconstructActivePath(
  leaf: GraphNode,
  nodes: Map<string, GraphNode>,
  cyclicUuids: Set<string>,
  warnings: ClogWarning[],
  filePath: string,
): GraphNode[] {
  const reversed: GraphNode[] = [];
  const visited = new Set<string>();
  let current: GraphNode | undefined = leaf;

  while (current && !visited.has(current.uuid)) {
    visited.add(current.uuid);
    reversed.push(current);

    if (isCompactBoundary(current) && current.logicalParentUuid) {
      const logicalParent = usableLogicalParent(current, nodes, cyclicUuids);
      if (logicalParent) {
        current = logicalParent;
        continue;
      }

      warnings.push({
        ...makeWarning(
          "claude_transcript_compaction_history_missing",
          filePath,
          current,
          current.uuid,
        ),
        sourceLocation: {
          recordIndex: current.index,
          uuid: current.uuid,
          relatedUuid: current.logicalParentUuid,
        },
      });
    }

    if (!current.physicalParentUuid) {
      current = undefined;
      continue;
    }

    const physicalParent = nodes.get(current.physicalParentUuid);
    if (!physicalParent || cyclicUuids.has(physicalParent.uuid)) {
      warnings.push({
        ...makeWarning(
          "claude_transcript_missing_parent",
          filePath,
          current,
          current.uuid,
        ),
        sourceLocation: {
          recordIndex: current.index,
          uuid: current.uuid,
          relatedUuid: current.physicalParentUuid,
        },
      });
      current = undefined;
      continue;
    }
    current = physicalParent;
  }

  return reversed.reverse();
}

function compactSummaryReplacedByLogicalHistory(
  node: GraphNode,
  nodes: Map<string, GraphNode>,
  cyclicUuids: Set<string>,
): boolean {
  if (node.raw.isCompactSummary !== true || !node.physicalParentUuid) {
    return false;
  }
  const boundary = nodes.get(node.physicalParentUuid);
  return Boolean(
    boundary && usableLogicalParent(boundary, nodes, cyclicUuids),
  );
}

function usableLogicalParent(
  boundary: GraphNode,
  nodes: Map<string, GraphNode>,
  cyclicUuids: Set<string>,
): GraphNode | null {
  if (
    !isCompactBoundary(boundary) ||
    !boundary.logicalParentUuid ||
    cyclicUuids.has(boundary.uuid)
  ) {
    return null;
  }

  const logicalParent = nodes.get(boundary.logicalParentUuid);
  return logicalParent && !cyclicUuids.has(logicalParent.uuid)
    ? logicalParent
    : null;
}

function collectToolCalls(composition: GraphNode[]): Map<string, ToolCall> {
  const result = new Map<string, ToolCall>();
  for (const node of composition) {
    if (node.type !== "assistant") continue;
    for (const block of messageContentBlocks(node)) {
      if (
        block.type === "tool_use" &&
        nonemptyString(block.id) &&
        typeof block.name === "string"
      ) {
        const id = nonemptyString(block.id)!;
        if (!result.has(id)) {
          result.set(id, {
            assistantUuid: node.uuid,
            name: block.name,
            responseKey: assistantResponseKey(node),
          });
        }
      }
    }
  }
  return result;
}

function collectResponseTimestamps(
  composition: GraphNode[],
): Map<string, string | null> {
  const groups = new Map<string, GraphNode[]>();
  for (const node of composition) {
    if (node.type !== "assistant") continue;
    const key = assistantResponseKey(node);
    const group = groups.get(key) ?? [];
    group.push(node);
    groups.set(key, group);
  }
  return new Map(
    [...groups.entries()].map(([key, group]) => [key, earliestTimestamp(group)]),
  );
}

function projectAssistantNode(
  node: GraphNode,
  timestamp: string | null,
  messages: Message[],
): void {
  projectAssistantRecord(node, timestamp, messages);
}

function projectAssistantRecord(
  record: SourceRecord,
  timestamp: string | null,
  messages: Message[],
  toolCalls?: Map<string, ToolCall>,
  responseKey = `record:${record.index}`,
): void {
  for (const block of messageContentBlocks(record)) {
    if (block.type === "thinking") {
      continue;
    }
    if (block.type === "text" && typeof block.text === "string") {
      messages.push({
        role: "assistant",
        content: block.text,
        timestamp,
      });
      continue;
    }
    if (
      block.type === "tool_use" &&
      typeof block.name === "string"
    ) {
      const toolInput = block.input;
      messages.push({
        role: "tool_use",
        content: `${block.name}: ${summarizeToolInput(toolInput)}`,
        timestamp,
        toolName: block.name,
        toolInput,
      });
      const id = nonemptyString(block.id);
      if (id && toolCalls) {
        toolCalls.set(id, {
          assistantUuid: nonemptyString(record.raw.uuid) ?? `record-${record.index}`,
          name: block.name,
          responseKey,
        });
      }
    }
  }
}

function projectUserNode(
  node: GraphNode,
  toolCalls: Map<string, ToolCall>,
  acceptedToolResults: Set<number> | undefined,
  messages: Message[],
): void {
  projectUserRecord(
    node,
    toolCalls,
    acceptedToolResults,
    messages,
    normalizeTimestamp(node.raw.timestamp),
  );
}

function projectLegacyUser(
  record: SourceRecord,
  toolCalls: Map<string, ToolCall>,
  messages: Message[],
): void {
  const blocks = messageContentBlocks(record);
  projectUserRecord(
    record,
    toolCalls,
    new Set(
      blocks
        .map((block, index) => block.type === "tool_result" ? index : -1)
        .filter((index) => index >= 0),
    ),
    messages,
    normalizeTimestamp(record.raw.timestamp),
  );
}

function projectUserRecord(
  record: SourceRecord,
  toolCalls: Map<string, ToolCall>,
  acceptedToolResults: Set<number> | undefined,
  messages: Message[],
  timestamp: string | null,
): void {
  const message = asObject(record.raw.message);
  if (!message) return;
  const content = message.content;
  if (typeof content === "string") {
    const visible = normalizeVisibleUserText(content);
    if (visible) {
      messages.push({ role: "user", content: visible, timestamp });
    }
    return;
  }
  if (!Array.isArray(content)) return;

  let textRun: string[] = [];
  const flushText = (): void => {
    const visible = normalizeVisibleUserText(textRun.join("\n"));
    if (visible) {
      messages.push({ role: "user", content: visible, timestamp });
    }
    textRun = [];
  };

  for (const [blockIndex, value] of content.entries()) {
    const block = asObject(value);
    if (!block) continue;
    if (block.type === "text" && typeof block.text === "string") {
      textRun.push(block.text);
      continue;
    }
    if (block.type !== "tool_result") {
      continue;
    }

    flushText();
    if (!acceptedToolResults?.has(blockIndex)) {
      continue;
    }
    const toolUseId = nonemptyString(block.tool_use_id);
    const toolName = toolUseId
      ? toolCalls.get(toolUseId)?.name ?? "tool"
      : "tool";
    messages.push({
      role: "tool_result",
      content: `${toolName}: ${block.is_error === true ? "error" : "ok"}`,
      timestamp,
      toolName,
    });
  }
  flushText();
}

function addAcceptedToolResult(
  accepted: Map<number, Set<number>>,
  recordIndex: number,
  blockIndex: number,
): void {
  const blockIndexes = accepted.get(recordIndex) ?? new Set<number>();
  blockIndexes.add(blockIndex);
  accepted.set(recordIndex, blockIndexes);
}

function assistantResponseKey(record: SourceRecord): string {
  const messageId = assistantMessageId(record);
  return messageId
    ? `message:${messageId}`
    : `record:${nonemptyString(record.raw.uuid) ?? record.index}`;
}

function assistantMessageId(record: SourceRecord): string | null {
  return nonemptyString(asObject(record.raw.message)?.id);
}

function messageContentBlocks(record: SourceRecord): JsonObject[] {
  const content = asObject(record.raw.message)?.content;
  return Array.isArray(content)
    ? content
        .map(asObject)
        .filter((block): block is JsonObject => block !== null)
    : [];
}

function insertAfterLastAssistant(
  composition: GraphNode[],
  recoveredByResponse: Map<string, GraphNode[]>,
): GraphNode[] {
  if (recoveredByResponse.size === 0) {
    return composition;
  }

  const lastAssistantIndexes = new Map<string, number>();
  for (const [index, node] of composition.entries()) {
    if (node.type !== "assistant") {
      continue;
    }
    const responseKey = assistantResponseKey(node);
    if (recoveredByResponse.has(responseKey)) {
      lastAssistantIndexes.set(responseKey, index);
    }
  }

  const includedIndexes = new Set(composition.map((node) => node.index));
  const result: GraphNode[] = [];
  for (const [index, node] of composition.entries()) {
    result.push(node);
    if (node.type !== "assistant") {
      continue;
    }

    const responseKey = assistantResponseKey(node);
    if (lastAssistantIndexes.get(responseKey) !== index) {
      continue;
    }
    for (const recovered of recoveredByResponse.get(responseKey) ?? []) {
      if (!includedIndexes.has(recovered.index)) {
        result.push(recovered);
        includedIndexes.add(recovered.index);
      }
    }
  }
  return result;
}

function compareSourceOrder(left: SourceRecord, right: SourceRecord): number {
  const leftTime = timestampMillis(left.raw.timestamp);
  const rightTime = timestampMillis(right.raw.timestamp);
  if (leftTime !== null && rightTime === null) return 1;
  if (leftTime === null && rightTime !== null) return -1;
  if (leftTime !== null && rightTime !== null && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return left.index - right.index;
}

function timestampsNeedSourceOrder(
  left: SourceRecord,
  right: SourceRecord,
): boolean {
  const leftTime = timestampMillis(left.raw.timestamp);
  const rightTime = timestampMillis(right.raw.timestamp);
  return (
    (leftTime === null && rightTime === null) ||
    (leftTime !== null && rightTime !== null && leftTime === rightTime)
  );
}

function earliestTimestamp(records: SourceRecord[]): string | null {
  let earliest: { millis: number; value: string } | null = null;
  for (const record of records) {
    const value = normalizeTimestamp(record.raw.timestamp);
    const millis = timestampMillis(value);
    if (value && millis !== null && (!earliest || millis < earliest.millis)) {
      earliest = { millis, value };
    }
  }
  return earliest?.value ?? null;
}

function normalizeTimestamp(value: unknown): string | null {
  return typeof value === "string" && timestampMillis(value) !== null
    ? value
    : null;
}

function timestampMillis(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const match = ISO_TIMESTAMP_REGEX.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leapYear =
      year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leapYear ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isCompactBoundary(node: GraphNode): boolean {
  return node.type === "system" && node.raw.subtype === "compact_boundary";
}

function isEntireLocalCommandWrapper(text: string): boolean {
  const stripped = stripHiddenUserWrappers(text);
  const wrappers = [...stripped.matchAll(LOCAL_COMMAND_WRAPPER_REGEX)];
  if (wrappers.length === 0) return false;
  return (
    wrappers.map((match) => match[0]).join("").replace(/\s+/g, "") ===
    stripped.replace(/\s+/g, "")
  );
}

function normalizeVisibleUserText(text: string): string {
  const stripped = stripHiddenUserWrappers(text);
  if (!stripped) return "";

  const wrappers = [...stripped.matchAll(LOCAL_COMMAND_WRAPPER_REGEX)];
  if (
    wrappers.length === 0 ||
    wrappers.map((match) => match[0]).join("").replace(/\s+/g, "") !==
      stripped.replace(/\s+/g, "")
  ) {
    return stripped;
  }

  const values = new Map<string, string>();
  for (const [, name, value] of wrappers) {
    values.set(name, decodeWrapperText(value.trim()));
  }

  const stdout = values.get("local-command-stdout");
  const stderr = values.get("local-command-stderr");
  if (stdout != null || stderr != null) {
    return [stdout, stderr].filter(Boolean).join("\n").trim();
  }

  const commandName = values.get("command-name");
  const commandMessage = values.get("command-message");
  const commandArgs = values.get("command-args");
  const baseCommand = commandName?.trim() || commandMessage?.trim() || "";
  const args = commandArgs?.trim() ?? "";
  return `${baseCommand}${args ? ` ${args}` : ""}`.trim();
}

function stripHiddenUserWrappers(text: string): string {
  let remaining = text.trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const wrapper of HIDDEN_USER_WRAPPER_BLOCKS) {
      const withoutWrapper = remaining.replace(
        new RegExp(`^<${wrapper}>[\\s\\S]*?<\\/${wrapper}>\\s*`),
        "",
      );
      if (withoutWrapper !== remaining) {
        remaining = withoutWrapper.trimStart();
        changed = true;
      }
    }
  }
  return remaining.trim();
}

function decodeWrapperText(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function summarizeToolInput(input: unknown): string {
  const json = input == null ? "{}" : JSON.stringify(input) ?? "{}";
  return json.length <= 120 ? json : `${json.slice(0, 117)}...`;
}

function makeWarning(
  code: keyof typeof WARNING_MESSAGES,
  filePath: string,
  record: SourceRecord,
  uuid: string | null,
): ClogWarning {
  return {
    code,
    message: WARNING_MESSAGES[code],
    source: "claude-code",
    path: filePath,
    sourceLocation: {
      recordIndex: record.index,
      ...(uuid ? { uuid } : {}),
    },
  };
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function nonemptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
