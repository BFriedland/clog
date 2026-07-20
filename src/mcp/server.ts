#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { getScanWarningsForCommand, renderWarnings } from "../cli/common.js";
import { scanLocalSources } from "../cli/scan.js";
import { loadConfig } from "../config/index.js";
import { createMcpServer } from "./create-server.js";

export async function startMcpServer(): Promise<void> {
  const config = await loadConfig();
  if (config.autoScan) {
    const scanResult = await scanLocalSources(config);
    renderWarnings(getScanWarningsForCommand(scanResult));
  }

  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

await startMcpServer();
