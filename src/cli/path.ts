import { Command } from "commander";

import { loadConfig } from "../config/index.js";
import { resolveConversationView } from "../conversations/view.js";
import {
  getScanWarningsForCommand,
  renderWarnings,
  resolveContentPath,
} from "./common.js";
import { scanLocalSources } from "./scan.js";

export function buildPathCommand(): Command {
  return new Command("path")
    .description("Print the file path")
    .argument("<id>")
    .action(async (id: string) => {
      const config = await loadConfig();
      const scanSnapshot = await scanLocalSources(config);
      renderWarnings(getScanWarningsForCommand(scanSnapshot));
      const conversation = await resolveConversationView(id, { scanSnapshot });
      process.stdout.write(`${resolveContentPath(conversation)}\n`);
    });
}
