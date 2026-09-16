/**
 * Fallback for a mixed deployment: a server is already serving this db but is an older build with no
 * /mcp endpoint. It owns the port, so we cannot start our own HTTP server — we run a self-contained
 * stdio MCP server that shares the db directly (exactly what every joining agent did before the
 * shared-server model). Once every server speaks /mcp this path is never taken, and agents bridge.
 *
 * Heavy by necessity (it IS an MCP server), but only reached in this transitional case.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { tolerateAbsentToolArguments } from "./compat.ts";
import type { Config } from "./config.ts";
import { Bus } from "./events.ts";
import { createMcpServer } from "./mcp.ts";
import { resolveRepo } from "./repo.ts";
import { Store } from "./store.ts";
import { RemoteTunnelView } from "./tunnel.ts";

export async function runBridgeless(config: Config, liveUrl: string): Promise<void> {
  const store = new Store(config.dbPath);
  const bus = new Bus();
  const remoteShare = new RemoteTunnelView(liveUrl);
  remoteShare.start();

  const canvasUrl = (): string => remoteShare.publicUrl() ?? liveUrl;
  const defaultRepo = resolveRepo(process.env, process.cwd());
  console.error(`[tracepaper] joining legacy server ${liveUrl}; canvas "${defaultRepo}"`);

  const server = createMcpServer({ store, bus, baseUrl: canvasUrl, defaultRepo });

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    remoteShare.stop();
    store.close();
    process.exit(0);
  };
  await server.connect(tolerateAbsentToolArguments(new StdioServerTransport()));
  server.server.onclose = shutdown;
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
