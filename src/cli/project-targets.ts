import { listConversations } from "../db/index.js";
import {
  attachCurrentSourceCandidate,
  findScanCandidateForConversation,
  listConversationView,
  type LocalScanSnapshot,
} from "../conversations/view.js";
import type { ConversationMeta } from "../models/conversation.js";
import { classifySavedDelta } from "./common.js";

export async function collectBareSaveTargets(): Promise<ConversationMeta[]> {
  return collectSavedSaveTargets({
    includeSourceChanges: false,
    ignoreLiveSource: true,
  });
}

export async function collectProjectSaveTargets(
  scanSnapshot: LocalScanSnapshot,
): Promise<ConversationMeta[]> {
  const unsaved = await listConversationView(
    { states: ["unsaved"], origin: "local" },
    scanSnapshot,
  );
  const saveableSaved = await collectSavedSaveTargets({
    includeSourceChanges: true,
    scanSnapshot,
  });
  return [...unsaved, ...saveableSaved];
}

export async function collectAllSaveTargets(
  scanSnapshot: LocalScanSnapshot,
): Promise<ConversationMeta[]> {
  const unsaved = await listConversationView(
    { states: ["unsaved"], origin: "local" },
    scanSnapshot,
  );
  const saveableSaved = await collectSavedSaveTargets({
    includeSourceChanges: true,
    scanSnapshot,
  });
  return [...unsaved, ...saveableSaved];
}

async function collectSavedSaveTargets(options: {
  includeSourceChanges: boolean;
  scanSnapshot?: LocalScanSnapshot;
  ignoreLiveSource?: boolean;
}): Promise<ConversationMeta[]> {
  const saved = await listConversations({ origin: "local" });
  const saveableSaved: ConversationMeta[] = [];
  for (const conversation of saved) {
    const liveCandidate = options.ignoreLiveSource
      ? null
      : options.scanSnapshot
        ? findScanCandidateForConversation(conversation, options.scanSnapshot)
        : undefined;
    const delta = await classifySavedDelta(conversation, liveCandidate);
    if (
      (options.includeSourceChanges && delta === "source_ahead") ||
      delta === "ready"
    ) {
      saveableSaved.push(
        options.scanSnapshot
          ? attachCurrentSourceCandidate(conversation, options.scanSnapshot)
          : conversation,
      );
    }
  }
  return saveableSaved;
}

export async function collectProjectDrainTargets(
  filteredConversations?: ConversationMeta[] | null,
  scanSnapshot?: LocalScanSnapshot,
): Promise<ConversationMeta[]> {
  return filteredConversations ?? (await listConversationView(
    { states: ["saved", "unsaved"] },
    scanSnapshot,
  ));
}
