import { writeFileSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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

async function main(): Promise<void> {
  const mode = parseMode(process.argv.slice(2));
  const config = loadConfig();
  const store = new Store(config.dbPath);
  const bus = new Bus();
  const http = startHttpServer({ store, bus, port: config.port, host: config.host });

  writeServerJson(config, http, mode);
  console.error(`[paper-mcp] canvas at ${http.url}  db=${config.dbPath}  mode=${mode}`);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[paper-mcp] ${signal} — shutting down`);
    http.stop();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  if (mode === "serve") {
    // Nothing else to attach: hold the process open on the http server alone.
    return;
  }

  const server = createMcpServer({ store, bus, baseUrl: () => http.url });
  await server.connect(new StdioServerTransport());
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
