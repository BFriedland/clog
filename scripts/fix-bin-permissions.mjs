import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const binTargets = [
  path.join(repoRoot, "dist", "index.js"),
  path.join(repoRoot, "dist", "mcp", "server.js"),
];

await Promise.all(
  binTargets.map(async (filePath) => {
    await fs.chmod(filePath, 0o755);
  }),
);
