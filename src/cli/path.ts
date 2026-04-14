import { Command } from "commander";

import { resolveConversationOrFail, resolveContentPath } from "./common.js";

export function buildPathCommand(): Command {
  return new Command("path")
    .description("Print the file path")
    .argument("<id>")
    .action(async (id: string) => {
      const conversation = await resolveConversationOrFail(id);
      process.stdout.write(`${resolveContentPath(conversation)}\n`);
    });
}
