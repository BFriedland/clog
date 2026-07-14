import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export interface AtomicWriteOptions {
  mode?: number;
}

export async function writeFileAtomic(
  filePath: string,
  data: Buffer | string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );

  try {
    await fs.writeFile(tempPath, data, { mode: options.mode });
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
