import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";

export async function pathExists(pathToCheck: string): Promise<boolean> {
  try {
    await fs.access(pathToCheck);
    return true;
  } catch {
    return false;
  }
}

export async function isReadableDirectory(pathToCheck: string): Promise<boolean> {
  try {
    const stat = await fs.stat(pathToCheck);
    if (!stat.isDirectory()) {
      return false;
    }
    await fs.access(pathToCheck, fsConstants.R_OK | fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}
