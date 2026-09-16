import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type Config } from "./config.ts";
import type { HttpServer } from "./http.ts";
import { CLI_VERBS } from "./verbs.ts";

// Heavy modules (the MCP SDK, zod, the canvas server) are imported DYNAMICALLY inside the paths that
// need them. This keeps the top-level module graph light so the stdio→HTTP bridge path — the common
// case once a shared server is up — stays ~10MB instead of loading the ~56MB SDK graph it never uses.

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

type LiveServer = { url: string; mcp: boolean };

/**
 * A canvas the human already has open owns this db. Starting a second HTTP server would bind a
 * different port with its own event bus, so agent pushes would never reach that open tab. Returns
 * the live server (and whether it speaks MCP over HTTP) if one is already serving this db.
 */
async function findLiveServer(config: Config): Promise<LiveServer | null> {
  let record: { url?: unknown; dbPath?: unknown };
  try {
    record = JSON.parse(readFileSync(config.serverJsonPath, "utf8")) as typeof record;
  } catch {
    return null; // no previous server, or an unreadable record — start our own
  }
  if (typeof record.url !== "string" || record.dbPath !== config.dbPath) return null;

  try {
    const response = await fetch(`${record.url}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return null;
    // `mcp` tells a joining agent it can bridge to this server instead of running its own MCP server.
    const body = (await response.json()) as { mcp?: unknown };
    return { url: record.url, mcp: body.mcp === true };
  } catch {
    return null; // recorded server is gone
  }
}

/**
 * The canvas app is a compiled bundle, and an MCP client launches `src/index.ts` directly — it never
 * runs `bun run build:web`. Building it on first boot means a fresh clone works as soon as it is
 * wired into a client, instead of serving a 500 to the human's first visit.
 */
async function ensureCanvasBundle(): Promise<void> {
  const entry = fileURLToPath(new URL("../web/canvas.ts", import.meta.url));
  const outdir = fileURLToPath(new URL("../web/dist/", import.meta.url));
  if (existsSync(join(outdir, "canvas.js"))) return;

  console.error("[tracepaper] building the canvas bundle (first run)…");
  const built = await Bun.build({ entrypoints: [entry], outdir, target: "browser", minify: true });
  if (!built.success) {
    throw new Error(`canvas bundle failed to build:\n${built.logs.map(String).join("\n")}`);
  }
}

/**
 * Serve the canvas + MCP-over-HTTP, or (stdio) run a self-contained MCP server. Only reached when
 * there is no shared server to bridge to, so it is fine to pull in the heavy graph here.
 */
async function runServer(mode: Mode, config: Config): Promise<void> {
  const { Bus } = await import("./events.ts");
  const { startHttpServer } = await import("./http.ts");
  const { Store } = await import("./store.ts");
  const { Tunnel } = await import("./tunnel.ts");

  await ensureCanvasBundle();
  const store = new Store(config.dbPath);
  const bus = new Bus();
  const tunnel = new Tunnel();
  const http = startHttpServer({
    store,
    bus,
    port: config.port,
    host: config.host,
    tunnel,
    // Expose MCP over HTTP so every other agent can share this one server (see `tracepaper up`).
    // Agents scope themselves via the x-tracepaper-repo header (the bridge) or a ?repo= query; a
    // connection that names neither lands on "default".
    mcpDefaultRepo: "default",
  });
  // Point the tunnel at the port the server ACTUALLY bound (listen() may fall back off a conflict),
  // not the requested one — otherwise Share forwards to a dead socket and every visitor gets a 502.
  tunnel.setTarget(http.url);
  writeServerJson(config, http, mode);

  const canvasUrl = (): string => {
    const own = tunnel.current();
    return own.status === "on" ? own.url : http.url;
  };
  console.error(`[tracepaper] canvas at ${http.url}  db=${config.dbPath}  mode=${mode}`);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[tracepaper] ${signal} — shutting down`);
    tunnel.stop();
    http.stop();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  // Ignore SIGHUP so a `tracepaper up` daemon survives the terminal that launched it closing.
  process.on("SIGHUP", () => {});

  if (mode === "serve") return; // held open by the http server alone

  // stdio with no shared server to bridge to: be a self-contained MCP server (the stranger's first
  // `npx tracepaper` run, and the fallback if the shared server is down).
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { tolerateAbsentToolArguments } = await import("./compat.ts");
  const { createMcpServer } = await import("./mcp.ts");
  const { resolveRepo } = await import("./repo.ts");

  const defaultRepo = resolveRepo(process.env, process.cwd());
  console.error(`[tracepaper] this connection's canvas: ${defaultRepo}`);
  const server = createMcpServer({ store, bus, baseUrl: canvasUrl, defaultRepo });
  await server.connect(tolerateAbsentToolArguments(new StdioServerTransport()));
  server.server.onclose = () => shutdown("stdio transport closed");
  process.stdin.on("end", () => shutdown("stdin closed"));
  process.stdin.on("close", () => shutdown("stdin closed"));
  console.error("[tracepaper] mcp stdio transport connected");
}

async function main(): Promise<void> {
  const [verb, ...rest] = process.argv.slice(2);
  const normalized = verb === "--help" || verb === "-h" ? "help" : verb;

  // CLI verbs are one-shot clients over the shared db — imported lazily so the server/bridge paths
  // never pay for them.
  if (normalized !== undefined && CLI_VERBS.has(normalized)) {
    const { runCli } = await import("./cli.ts");
    process.exit(await runCli(normalized, rest));
  }

  // Daemon control for the shared server. Manages a `serve` process; never opens the db itself.
  if (normalized === "up" || normalized === "down" || normalized === "status") {
    if (rest.length > 0) throw new Error(`\`${normalized}\` takes no arguments`);
    const daemon = await import("./daemon.ts");
    const run = normalized === "up" ? daemon.up : normalized === "down" ? daemon.down : daemon.status;
    process.exit(await run(loadConfig()));
  }

  const mode = parseMode(process.argv.slice(2));
  const config = loadConfig();

  // The common case once `tracepaper up` is running: a shared server already speaks MCP over HTTP,
  // so bridge to it instead of loading our own ~56MB MCP server. The bridge imports no SDK.
  if (mode === "stdio") {
    const live = await findLiveServer(config);
    if (live !== null && live.mcp) {
      const { runBridge } = await import("./bridge.ts");
      await runBridge(live.url);
      return;
    }
    // A live server without /mcp (older build) still owns the db+port, so we cannot start our own.
    // Fall through only when there is truly no server: runServer will bind and self-serve.
    if (live !== null && !live.mcp) {
      const { runBridgeless } = await import("./legacy-join.ts");
      await runBridgeless(config, live.url);
      return;
    }
  }

  await runServer(mode, config);
}

main().catch((error: unknown) => {
  console.error("[tracepaper] fatal:", error);
  process.exit(1);
});
