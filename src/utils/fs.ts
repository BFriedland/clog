import fs from "node:fs/promises";

export async function pathExists(pathToCheck: string): Promise<boolean> {
  try {
    await fs.access(pathToCheck);
    return true;
  } catch {
    return false;
  }
}
