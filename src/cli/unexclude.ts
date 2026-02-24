import { removeExcluded } from "./excluded.js";

export async function unexcludeCommand(ids: string[]): Promise<void> {
  for (const id of ids) {
    await removeExcluded("claude-code", id);
  }

  console.log(
    `Removed ${ids.length} exclusion(s). Conversations will be rediscovered on next scan.`
  );
}
