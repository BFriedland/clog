import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export interface TestEnv {
  clogHome: string;
  dbPath: string;
  rawDir: string;
  cleanup: () => Promise<void>;
}

export async function createTestEnv(): Promise<TestEnv> {
  const clogHome = await mkdtemp(path.join(tmpdir(), "clog-test-"));
  const oldHome = process.env.CLOG_HOME;

  process.env.CLOG_HOME = clogHome;

  return {
    clogHome,
    dbPath: path.join(clogHome, "clog.db"),
    rawDir: path.join(clogHome, "raw"),
    cleanup: async () => {
      if (oldHome !== undefined) {
        process.env.CLOG_HOME = oldHome;
      } else {
        delete process.env.CLOG_HOME;
      }
      await rm(clogHome, { recursive: true, force: true });
    },
  };
}
