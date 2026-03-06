import path from "node:path";
import { getRemoteDir } from "../config/index.js";
import type { ConversationMeta } from "../models/conversation.js";

export function resolveContentPath(conv: ConversationMeta): string {
  if (conv.origin) {
    return path.join(getRemoteDir(), conv.author, `${conv.id}.jsonl`);
  }
  if (conv.state === "discovered") {
    return conv.sourcePath;
  }
  return conv.filePath || conv.sourcePath;
}
