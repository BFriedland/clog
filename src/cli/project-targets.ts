import { listConversations } from "../db/index.js";
import type { ConversationMeta } from "../models/conversation.js";
import {
  classifySavedDelta,
  isSavedReadyForResaveWithDelta,
} from "./common.js";

export async function collectBareSaveTargets(): Promise<ConversationMeta[]> {
  return collectSavedSaveTargets({ includeSourceChanges: false });
}

export async function collectProjectSaveTargets(): Promise<ConversationMeta[]> {
  const discovered = await listConversations({ states: ["discovered"], origin: "local" });
  const saveableSaved = await collectSavedSaveTargets({ includeSourceChanges: true });
  return [...discovered, ...saveableSaved];
}

export async function collectAllSaveTargets(): Promise<ConversationMeta[]> {
  const discovered = await listConversations({ states: ["discovered"], origin: "local" });
  const saveableSaved = await collectSavedSaveTargets({ includeSourceChanges: true });
  return [...discovered, ...saveableSaved];
}

async function collectSavedSaveTargets(options: {
  includeSourceChanges: boolean;
}): Promise<ConversationMeta[]> {
  const saved = await listConversations({ states: ["saved"], origin: "local" });
  const saveableSaved: ConversationMeta[] = [];
  for (const conversation of saved) {
    const delta = await classifySavedDelta(conversation);
    if (
      (options.includeSourceChanges && delta === "source_ahead") ||
      isSavedReadyForResaveWithDelta(conversation, delta)
    ) {
      saveableSaved.push(conversation);
    }
  }
  return saveableSaved;
}

export async function collectProjectDrainTargets(
  filteredConversations?: ConversationMeta[] | null,
): Promise<ConversationMeta[]> {
  return filteredConversations ?? (await listConversations());
}
