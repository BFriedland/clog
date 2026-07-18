import { installBrokenPipeHandler } from "../../src/cli/prelude.js";

installBrokenPipeHandler();

setInterval(() => {
  process.stdout.write("hello world\n".repeat(1_000));
}, 10);
