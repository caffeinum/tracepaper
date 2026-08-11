import { readFileSync, writeFileSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { tolerateAbsentToolArguments } from "./compat.ts";
import { loadConfig, type Config } from "./config.ts";
import { Bus } from "./events.ts";
import { startHttpServer, type HttpServer } from "./http.ts";
import { createMcpServer } from "./mcp.ts";
import { Store } from "./store.ts";

type Mode = "stdio" | "serve";

function parseMode(argv: string[]): Mode {
  const args = argv.filter((arg) => arg !== "");
  if (args.length === 0) return "stdio";
  const [first, ...rest] = args;
  if (rest.length > 0) throw new Error(`unexpected arguments: ${rest.join(" ")}`);
  if (first === "serve") return "serve";
  throw new Error(`unknown command: ${first} (expected no argument, or \`serve\`)`);
}

function writeServerJson(config: Config, http: HttpServer, mode: Mode): void {
  const record = {
    url: http.url,
    host: config.host,
    port: http.port,
    dbPath: config.dbPath,
    pid: process.pid,
    mode,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(config.serverJsonPath, `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * A canvas the human already has open owns this db. Starting a second HTTP server would bind a
 * different port with its own event bus, so agent pushes would never reach that open tab and
 * `push_html` would hand back a URL to a second, empty-looking canvas over the same data.
 * Returns the live server's URL if one is already serving this db.
 */
async function findLiveServer(config: Config): Promise<string | null> {
  let record: { url?: unknown; dbPath?: unknown };
  try {
    record = JSON.parse(readFileSync(config.serverJsonPath, "utf8")) as typeof record;
  } catch {
    return null; // no previous server, or an unreadable record — start our own
  }
  if (typeof record.url !== "string" || record.dbPath !== config.dbPath) return null;

  try {
    const response = await fetch(`${record.url}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok ? record.url : null;
  } catch {
    return null; // recorded server is gone
  }
}

async function main(): Promise<void> {
  const mode = parseMode(process.argv.slice(2));
  const config = loadConfig();
  const store = new Store(config.dbPath);
  const bus = new Bus();

  const live = mode === "stdio" ? await findLiveServer(config) : null;
  const http =
    live === null ? startHttpServer({ store, bus, port: config.port, host: config.host }) : null;

  if (http !== null) writeServerJson(config, http, mode);
  const canvasUrl = live ?? http?.url;
  if (canvasUrl === undefined) throw new Error("no canvas url: neither a live nor a new server");
  console.error(
    live === null
      ? `[paper-mcp] canvas at ${canvasUrl}  db=${config.dbPath}  mode=${mode}`
      : `[paper-mcp] joining the canvas already serving this db at ${canvasUrl}`,
  );

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[paper-mcp] ${signal} — shutting down`);
    http?.stop();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  if (mode === "serve") {
    // Nothing else to attach: hold the process open on the http server alone.
    return;
  }

  const server = createMcpServer({ store, bus, baseUrl: () => canvasUrl });
  await server.connect(tolerateAbsentToolArguments(new StdioServerTransport()));
  // The http server holds the process open, so a hung-up client must be shut down explicitly.
  // The SDK's stdio transport never watches stdin for EOF, so watch it here.
  server.server.onclose = () => shutdown("stdio transport closed");
  process.stdin.on("end", () => shutdown("stdin closed"));
  process.stdin.on("close", () => shutdown("stdin closed"));
  console.error("[paper-mcp] mcp stdio transport connected");
}

main().catch((error: unknown) => {
  console.error("[paper-mcp] fatal:", error);
  process.exit(1);
});
