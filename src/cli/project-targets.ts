import { listConversations } from "../db/index.js";
import type { ConversationMeta } from "../models/conversation.js";
import {
  classifySavedDelta,
  isSavedReadyForResave,
  isSavedReadyForResaveWithDelta,
} from "./common.js";

export async function collectBareSaveTargets(): Promise<ConversationMeta[]> {
  const saved = await listConversations({ states: ["saved"], origin: "local" });
  const readySaved: ConversationMeta[] = [];
  for (const conversation of saved) {
    if (await isSavedReadyForResave(conversation)) {
      readySaved.push(conversation);
    }
  }
  return readySaved;
}

export async function collectProjectSaveTargets(): Promise<ConversationMeta[]> {
  const discovered = await listConversations({ states: ["discovered"], origin: "local" });
  const saved = await listConversations({ states: ["saved"], origin: "local" });
  return [...discovered, ...saved];
}

export async function collectAllSaveTargets(): Promise<ConversationMeta[]> {
  const discovered = await listConversations({ states: ["discovered"], origin: "local" });
  const saved = await listConversations({ states: ["saved"], origin: "local" });
  const saveableSaved: ConversationMeta[] = [];
  for (const conversation of saved) {
    const delta = await classifySavedDelta(conversation);
    if (delta === "source_ahead" || isSavedReadyForResaveWithDelta(conversation, delta)) {
      saveableSaved.push(conversation);
    }
  }
  return [...discovered, ...saveableSaved];
}

export async function collectProjectDrainTargets(
  filteredConversations?: ConversationMeta[] | null,
): Promise<ConversationMeta[]> {
  return filteredConversations ?? (await listConversations());
}
