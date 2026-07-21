import type { ConversationMeta } from "../models/conversation.js";
import { ClogError } from "../utils/errors.js";

export type LocalConversation<T extends ConversationMeta = ConversationMeta> = T & {
  originKind: "local";
  originRef: null;
};

export type GitConversation = ConversationMeta & {
  originKind: "git";
  originRef: string;
};

export type FileConversation = ConversationMeta & {
  originKind: "file";
  originRef: null;
};

// A row is writable by local user commands only when both provenance columns
// say it is local: origin_kind = 'local' and origin_ref IS NULL.
export function isLocallyWritable(
  conversation: Pick<ConversationMeta, "originKind" | "originRef">,
): boolean {
  return conversation.originKind === "local" && conversation.originRef === null;
}

export function requireLocalConversation<T extends ConversationMeta>(
  conversation: T,
  action: string,
): LocalConversation<T> {
  if (!isLocallyWritable(conversation)) {
    throwImportedReadOnlyError(conversation, action);
  }

  return conversation as LocalConversation<T>;
}

export function requireGitConversationForRemote(
  conversation: ConversationMeta,
  remoteUrl: string,
  action: string,
): GitConversation {
  if (conversation.originKind !== "git" || conversation.originRef !== remoteUrl) {
    throw new ClogError(
      `${action} cannot modify conversation ${conversation.id.slice(0, 8)} - it is not owned by the configured git remote.`,
    );
  }

  return conversation as GitConversation;
}

export function requireFileConversation(
  conversation: ConversationMeta,
  action: string,
): FileConversation {
  if (conversation.originKind !== "file" || conversation.originRef !== null) {
    throw new ClogError(
      `${action} cannot modify conversation ${conversation.id.slice(0, 8)} - it is not a managed file import.`,
    );
  }

  return conversation as FileConversation;
}

export function throwImportedReadOnlyError(
  conversation: Pick<ConversationMeta, "id">,
  action: string,
): never {
  throw new ClogError(
    `${action} cannot modify conversation ${conversation.id.slice(0, 8)} - imported conversations are read-only. Edit it on the original author's machine or remove the imported copy.`,
  );
}
