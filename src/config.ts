import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

export const DEFAULT_PORT = 4321;
export const DEFAULT_HOST = "127.0.0.1";
export const STATE_DIR_NAME = ".paper-mcp";
export const MEMORY_DB = ":memory:";

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

function parsePort(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PAPER_MCP_PORT must be an integer in 0..65535, got: ${raw}`);
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const stateDir = resolve(expandHome("~"), STATE_DIR_NAME);
  const rawPort = env.PAPER_MCP_PORT;
  const rawHost = env.PAPER_MCP_HOST;
  const rawDb = env.PAPER_MCP_DB;

  if (rawHost !== undefined && rawHost.trim() === "") {
    throw new Error("PAPER_MCP_HOST is set but empty");
  }
  if (rawDb !== undefined && rawDb.trim() === "") {
    throw new Error("PAPER_MCP_DB is set but empty");
  }

  const dbPath = resolveDbPath(rawDb === undefined ? `~/${STATE_DIR_NAME}/paper.db` : rawDb);

  mkdirSync(stateDir, { recursive: true });

  return {
    port: rawPort === undefined ? DEFAULT_PORT : parsePort(rawPort),
    host: rawHost === undefined ? DEFAULT_HOST : rawHost,
    dbPath,
    stateDir,
    serverJsonPath: resolve(stateDir, "server.json"),
  };
}
