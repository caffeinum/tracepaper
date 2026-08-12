import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

export const DEFAULT_PORT = 4321;
export const DEFAULT_HOST = "127.0.0.1";
export const STATE_DIR_NAME = ".tracepaper";
export const DB_FILE_NAME = "tracepaper.db";
export const MEMORY_DB = ":memory:";

/** Where this project kept its state before it was renamed from paper-mcp. */
const LEGACY_STATE_DIR_NAME = ".paper-mcp";
const LEGACY_DB_FILE_NAME = "paper.db";

export type Config = {
  port: number;
  host: string;
  dbPath: string;
  stateDir: string;
  serverJsonPath: string;
};

export function expandHome(path: string): string {
  const home = homedir();
  if (home === "") throw new Error("cannot expand `~`: os.homedir() is empty");
  if (path === "~") return home;
  if (path.startsWith("~/")) return resolve(home, path.slice(2));
  return path;
}

function parsePort(raw: string, name: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${name} must be an integer in 0..65535, got: ${raw}`);
  }
  return port;
}

function resolveDbPath(raw: string): string {
  if (raw === MEMORY_DB) return raw;
  const expanded = expandHome(raw);
  const absolute = isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
  mkdirSync(dirname(absolute), { recursive: true });
  return absolute;
}

/**
 * Reads `TRACEPAPER_*`, falling back to the pre-rename `PAPER_MCP_*` so an existing MCP client
 * config keeps working. Returns the name that actually supplied the value for error messages.
 */
function fromEnv(
  env: NodeJS.ProcessEnv,
  suffix: string,
): { value: string; name: string } | undefined {
  for (const name of [`TRACEPAPER_${suffix}`, `PAPER_MCP_${suffix}`]) {
    const value = env[name];
    if (value !== undefined) return { value, name };
  }
  return undefined;
}

/**
 * Frames created before the rename live in `~/.paper-mcp/paper.db`. Adopting that file when the
 * new one does not exist yet means an existing canvas survives the rename; creating a fresh
 * empty db beside it would look like every frame had been deleted.
 */
function defaultDbPath(): string {
  const current = resolve(expandHome("~"), STATE_DIR_NAME, DB_FILE_NAME);
  if (existsSync(current)) return current;

  const legacy = resolve(expandHome("~"), LEGACY_STATE_DIR_NAME, LEGACY_DB_FILE_NAME);
  if (existsSync(legacy)) {
    console.error(`[tracepaper] using the pre-rename database at ${legacy}`);
    return legacy;
  }
  return current;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const stateDir = resolve(expandHome("~"), STATE_DIR_NAME);
  const rawPort = fromEnv(env, "PORT");
  const rawHost = fromEnv(env, "HOST");
  const rawDb = fromEnv(env, "DB");

  if (rawHost !== undefined && rawHost.value.trim() === "") {
    throw new Error(`${rawHost.name} is set but empty`);
  }
  if (rawDb !== undefined && rawDb.value.trim() === "") {
    throw new Error(`${rawDb.name} is set but empty`);
  }

  const dbPath = rawDb === undefined ? defaultDbPath() : resolveDbPath(rawDb.value);
  mkdirSync(stateDir, { recursive: true });

  return {
    port: rawPort === undefined ? DEFAULT_PORT : parsePort(rawPort.value, rawPort.name),
    host: rawHost === undefined ? DEFAULT_HOST : rawHost.value,
    dbPath,
    stateDir,
    serverJsonPath: resolve(stateDir, "server.json"),
  };
}
