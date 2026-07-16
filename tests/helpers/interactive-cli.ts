Object.defineProperty(process.stdin, "isTTY", {
  configurable: true,
  value: true,
});

await import("../../src/index.js");
