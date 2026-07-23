#!/usr/bin/env node

import {
  installBrokenPipeHandler,
  runWithCliErrorHandling,
} from "./cli/prelude.js";
import { buildProgram } from "./cli/program.js";

async function main(): Promise<void> {
  await buildProgram().parseAsync(process.argv);
}

installBrokenPipeHandler();
await runWithCliErrorHandling(main);
