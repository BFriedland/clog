import { listConversations } from "../db/index.js";
import type { ConversationMeta } from "../models/conversation.js";
import { isPublishedReadyForRepublish } from "./common.js";

export async function collectProjectAddTargets(): Promise<ConversationMeta[]> {
  // Project-scoped add should behave like repeated `clog add <id>` for every
  // local conversation in the project, including staged and published rows.
  return listConversations({ origin: "local" });
}

export async function collectBarePublishTargets(): Promise<ConversationMeta[]> {
  const staged = await listConversations({ states: ["staged"], origin: "local" });
  const published = await listConversations({ states: ["published"], origin: "local" });
  const readyPublished: ConversationMeta[] = [];
  for (const conversation of published) {
    if (await isPublishedReadyForRepublish(conversation)) {
      readyPublished.push(conversation);
    }
  }
  return [...staged, ...readyPublished];
}

export async function collectProjectPublishTargets(): Promise<ConversationMeta[]> {
  const discovered = await listConversations({ states: ["discovered"], origin: "local" });
  return [...discovered, ...(await collectBarePublishTargets())];
}

export async function collectProjectResetTargets(): Promise<ConversationMeta[]> {
  return listConversations({
    states: ["staged"],
    origin: "local",
  });
}

export async function collectProjectUnpublishTargets(): Promise<ConversationMeta[]> {
  return listConversations({
    states: ["published"],
    origin: "local",
  });
}

export async function collectProjectDrainTargets(
  filteredConversations?: ConversationMeta[] | null,
): Promise<ConversationMeta[]> {
  return filteredConversations ?? (await listConversations());
}
