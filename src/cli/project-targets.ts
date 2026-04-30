import { listConversations } from "../db/index.js";
import type { ConversationMeta } from "../models/conversation.js";
import { isSavedReadyForResave } from "./common.js";

export async function collectProjectAddTargets(): Promise<ConversationMeta[]> {
  // Project-scoped add should behave like repeated `clog add <id>` for every
  // local conversation in the project, including staged and saved rows.
  return listConversations({ origin: "local" });
}

export async function collectBareSaveTargets(): Promise<ConversationMeta[]> {
  const staged = await listConversations({ states: ["staged"], origin: "local" });
  const saved = await listConversations({ states: ["saved"], origin: "local" });
  const readySaved: ConversationMeta[] = [];
  for (const conversation of saved) {
    if (await isSavedReadyForResave(conversation)) {
      readySaved.push(conversation);
    }
  }
  return [...staged, ...readySaved];
}

export async function collectProjectSaveTargets(): Promise<ConversationMeta[]> {
  const discovered = await listConversations({ states: ["discovered"], origin: "local" });
  return [...discovered, ...(await collectBareSaveTargets())];
}

export async function collectProjectResetTargets(): Promise<ConversationMeta[]> {
  return listConversations({
    states: ["staged"],
    origin: "local",
  });
}

export async function collectBareResetTargets(): Promise<ConversationMeta[]> {
  return collectProjectResetTargets();
}

export async function collectProjectUnsaveTargets(): Promise<ConversationMeta[]> {
  return listConversations({
    states: ["saved"],
    origin: "local",
  });
}

export async function collectBareUnsaveTargets(): Promise<ConversationMeta[]> {
  return collectProjectUnsaveTargets();
}

export async function collectProjectDrainTargets(
  filteredConversations?: ConversationMeta[] | null,
): Promise<ConversationMeta[]> {
  return filteredConversations ?? (await listConversations());
}
