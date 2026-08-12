#!/usr/bin/env node
/**
 * Launcher, deliberately plain Node with no dependencies and no Bun APIs.
 *
 * The server itself needs Bun (bun:sqlite, Bun.serve). This file exists so that
 * `npx -y github:caffeinum/tracepaper` — the one-liner an MCP client config points at — behaves properly on a
 * machine without Bun: npm runs this under Node, and it either hands off to Bun or explains
 * exactly what is missing. Without it the shebang would resolve to a missing interpreter and
 * the user would get `env: bun: No such file or directory` from inside their MCP client, with
 * no indication of what to install.
 */
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const entry = join(dirname(dirname(fileURLToPath(import.meta.url))), "src", "index.ts");

function bunVersion() {
  const probe = spawnSync("bun", ["--version"], { encoding: "utf8", stdio: "pipe" });
  return probe.status === 0 ? probe.stdout.trim() : null;
}

if (bunVersion() === null) {
  process.stderr.write(
    [
      "tracepaper needs Bun, which is not on PATH.",
      "",
      "  curl -fsSL https://bun.sh/install | bash    # or: brew install oven-sh/bun/bun",
      "",
      "Then re-run this command. (The canvas uses bun:sqlite and Bun.serve; Node cannot run it yet.)",
      "",
    ].join("\n"),
  );
  process.exit(127);
}

// stdio is inherited wholesale: stdout carries the MCP transport and must pass through
// untouched, stderr carries logs, stdin carries the client's JSON-RPC.
const child = spawn("bun", ["run", entry, ...process.argv.slice(2)], { stdio: "inherit" });

child.on("error", (error) => {
  process.stderr.write(`tracepaper: failed to start bun: ${error.message}\n`);
  process.exit(1);
});

// Signals must reach the server so it can close its http listener and database.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
