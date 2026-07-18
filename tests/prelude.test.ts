import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const expectPath = "/usr/bin/expect";
const lessPath = "/usr/bin/less";
const itWithMacOsPty = process.platform === "darwin" &&
  existsSync(expectPath) &&
  existsSync(lessPath)
  ? it
  : it.skip;

describe("CLI prelude", () => {
  itWithMacOsPty("keeps canonical input and echo enabled after a pager closes stdout", async () => {
    const producerPath = path.join(
      process.cwd(),
      "tests/helpers/broken-pipe-producer.ts",
    );
    const shellCommand = [
      "( sleep 1; exec",
      JSON.stringify(process.execPath),
      "--import tsx",
      JSON.stringify(producerPath),
      `) | ${lessPath}`,
      '; printf "\\n__CLOG_STTY__\\n"',
      "; stty -a",
      '; printf "__CLOG_DONE__\\n"',
    ].join(" ");
    const expectScript = `
      set timeout 15
      spawn -noecho /bin/sh -c {${shellCommand}}
      expect "hello world"
      send -- "q"
      expect {
        "__CLOG_DONE__" {}
        timeout { exit 124 }
      }
      expect eof
    `;

    const { stdout } = await execFileAsync(expectPath, ["-c", expectScript], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TERM: "xterm-256color",
      },
    });
    const terminalState = stdout
      .split("__CLOG_STTY__")[1]
      ?.split("__CLOG_DONE__")[0];

    expect(terminalState).toBeDefined();
    expect(terminalState).toMatch(/(?:^|\s)icanon(?:\s|$)/);
    expect(terminalState).toMatch(/(?:^|\s)echo(?:\s|$)/);
    expect(terminalState).not.toMatch(/(?:^|\s)-icanon(?:\s|$)/);
    expect(terminalState).not.toMatch(/(?:^|\s)-echo(?:\s|$)/);
  });
});
