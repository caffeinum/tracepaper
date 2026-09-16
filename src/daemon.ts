/**
 * `tracepaper up | down | status` — the shared server as a background daemon.
 *
 * `up` is idempotent: if a server is already serving this db with MCP enabled it just prints the
 * URLs and exits 0, so every agent's launch (or a human running it twice) is safe. Otherwise it
 * spawns `tracepaper serve` detached (stdio → a log file, survives the terminal), records the pid,
 * and waits for the canvas to answer before returning.
 *
 * No launchd required for this path; a launchd/systemd unit can wrap `tracepaper serve` later for
 * boot-time start.
 */
import { openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.ts";

type ServerRecord = { url?: unknown; dbPath?: unknown; pid?: unknown; mcp?: unknown };
type HealthNow = { url: string; pid: number | null; mcp: boolean } | null;

const pidPath = (config: Config): string => resolve(config.stateDir, "tracepaper.pid");
const logPath = (config: Config): string => resolve(config.stateDir, "tracepaper.log");
const serveEntry = (): string => fileURLToPath(new URL("./index.ts", import.meta.url));

function readRecord(config: Config): ServerRecord | null {
  try {
    return JSON.parse(readFileSync(config.serverJsonPath, "utf8")) as ServerRecord;
  } catch {
    return null;
  }
}

/** The server currently serving THIS db, if one answers /api/health; null otherwise. */
async function probe(config: Config): Promise<HealthNow> {
  const record = readRecord(config);
  if (record === null || typeof record.url !== "string" || record.dbPath !== config.dbPath) {
    return null;
  }
  try {
    const res = await fetch(`${record.url}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const body = (await res.json()) as { mcp?: unknown };
    return {
      url: record.url,
      pid: typeof record.pid === "number" ? record.pid : null,
      mcp: body.mcp === true,
    };
  } catch {
    return null;
  }
}

function mcpUrl(canvasUrl: string): string {
  return `${canvasUrl.replace(/\/+$/, "")}/mcp`;
}

async function waitForHealth(config: Config, deadlineMs: number): Promise<HealthNow> {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    const now = await probe(config);
    if (now !== null) return now;
    await Bun.sleep(250);
  }
  return null;
}

/** Start the shared server if it is not already up. Prints the canvas + MCP URLs. */
export async function up(config: Config): Promise<number> {
  const already = await probe(config);
  if (already !== null) {
    if (!already.mcp) {
      process.stderr.write(
        `[tracepaper] a server is already serving this db at ${already.url} but WITHOUT /mcp.\n` +
          `Run \`tracepaper down\` and \`tracepaper up\` to get the shared MCP endpoint.\n`,
      );
      return 1;
    }
    process.stdout.write(`already up\n  canvas: ${already.url}\n  mcp:    ${mcpUrl(already.url)}\n`);
    return 0;
  }

  const log = openSync(logPath(config), "a");
  const child = Bun.spawn(["bun", "run", serveEntry(), "serve"], {
    env: process.env,
    stdin: "ignore",
    stdout: log,
    stderr: log,
  });
  child.unref();
  writeFileSync(pidPath(config), `${child.pid}\n`);

  const now = await waitForHealth(config, 20_000);
  if (now === null) {
    process.stderr.write(
      `[tracepaper] server did not answer within 20s — see ${logPath(config)}\n`,
    );
    return 1;
  }
  process.stdout.write(`up (pid ${child.pid})\n  canvas: ${now.url}\n  mcp:    ${mcpUrl(now.url)}\n`);
  return 0;
}

/** Stop the shared server (SIGTERM), waiting for it to actually go. */
export async function down(config: Config): Promise<number> {
  const now = await probe(config);
  let pid = now?.pid ?? null;
  if (pid === null) {
    try {
      pid = Number(readFileSync(pidPath(config), "utf8").trim()) || null;
    } catch {
      pid = null;
    }
  }
  if (pid === null) {
    process.stdout.write("not running\n");
    rmSync(pidPath(config), { force: true });
    return 0;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    process.stdout.write("not running (stale pid)\n");
    rmSync(pidPath(config), { force: true });
    return 0;
  }

  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    if ((await probe(config)) === null) break;
    await Bun.sleep(200);
  }
  rmSync(pidPath(config), { force: true });
  process.stdout.write(`stopped (pid ${pid})\n`);
  return 0;
}

/** Report whether the shared server is up, and its URLs. */
export async function status(config: Config): Promise<number> {
  const now = await probe(config);
  if (now === null) {
    process.stdout.write("stopped\n");
    return 1;
  }
  process.stdout.write(
    `running${now.pid !== null ? ` (pid ${now.pid})` : ""}\n` +
      `  canvas: ${now.url}\n` +
      `  mcp:    ${now.mcp ? mcpUrl(now.url) : "(not enabled on this server)"}\n`,
  );
  return 0;
}
