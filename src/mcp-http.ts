/**
 * The MCP protocol over HTTP, so ONE tracepaper server can serve every agent instead of each agent
 * running its own ~56MB stdio MCP server. The heavy module graph (the MCP SDK + zod) is loaded once
 * here; per connection we create only a lightweight McpServer bound to the caller's canvas.
 *
 * Responses are plain JSON (`enableJsonResponse`), not SSE: tracepaper never pushes to the agent
 * (the protocol is pull-only), so there is nothing to stream, and a JSON reply keeps the SDK-free
 * stdio→HTTP bridge (src/bridge.ts) trivial — it relays the agent's own JSON-RPC line for line.
 *
 * Per-connection canvas ("repo") comes from the connection, never from a URL a human edits per
 * agent. In priority order:
 *   1. `x-tracepaper-repo: <canvas>`  — an explicit canvas name (the bridge sends this)
 *   2. `?repo=<canvas>`               — same, for clients that can only set a URL
 *   3. `x-tracepaper-cwd: <abs path>` — the agent's working directory; the server derives the
 *      canvas from it exactly as a stdio server would from its own cwd (git remote → toplevel →
 *      folder name). Lets a direct HTTP client be configured with just its folder.
 *   4. the server's default canvas
 */
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest, LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { tolerateAbsentToolArguments } from "./compat.ts";
import type { Bus } from "./events.ts";
import { createMcpServer } from "./mcp.ts";
import { resolveRepo } from "./repo.ts";
import type { Store } from "./store.ts";

export const REPO_HEADER = "x-tracepaper-repo";
export const CWD_HEADER = "x-tracepaper-cwd";

/** A session nobody has touched for this long is closed; a later call simply resurrects it. */
const DEFAULT_IDLE_MS = 30 * 60 * 1000;
const DEFAULT_SWEEP_MS = 5 * 60 * 1000;

export type McpHttpDeps = {
  store: Store;
  bus: Bus;
  baseUrl: () => string;
  /** The canvas a connection that names none lands on. */
  defaultRepo: string;
  /** Close sessions idle longer than this (ms). Tests shorten it. */
  idleMs?: number;
  /** How often to look for idle sessions (ms). */
  sweepMs?: number;
};

export type McpHttpHandler = ((request: Request, url: URL) => Promise<Response>) & {
  /** Live sessions held in memory — for tests and diagnostics. */
  activeSessions(): number;
};

/** A request that names its canvas in a way we refuse — answered with a 400, never guessed around. */
class BadCanvas extends Error {}

/** The caller's canvas, in the priority order documented at the top of this file. */
function repoFor(request: Request, url: URL, fallback: string): string {
  const header = request.headers.get(REPO_HEADER);
  if (header !== null && header !== "") return header;

  const query = url.searchParams.get("repo");
  if (query !== null && query !== "") return query;

  const cwd = request.headers.get(CWD_HEADER);
  if (cwd !== null && cwd !== "") {
    if (!isAbsolute(cwd)) throw new BadCanvas(`${CWD_HEADER} must be an absolute path, got "${cwd}"`);
    let isDir = false;
    try {
      isDir = statSync(cwd).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) throw new BadCanvas(`${CWD_HEADER} is not an existing directory: ${cwd}`);
    // Empty env on purpose: the SERVER's own TRACEPAPER_REPO must not decide the agent's canvas.
    return resolveRepo({}, cwd);
  }

  return fallback;
}

function badRequest(message: string): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
}

type Session = { transport: WebStandardStreamableHTTPServerTransport; lastSeen: number };

/**
 * A session (and a bound McpServer) per connection, tracked by the `mcp-session-id` header the
 * transport issues on initialize. The 56MB SDK graph is shared across all of them; each session
 * adds only its McpServer's tool registrations.
 */
export function createMcpHttpHandler(deps: McpHttpDeps): McpHttpHandler {
  const sessions = new Map<string, Session>();
  const resurrecting = new Map<string, Promise<WebStandardStreamableHTTPServerTransport>>();
  const idleMs = deps.idleMs ?? DEFAULT_IDLE_MS;

  /** A fresh transport + McpServer for one connection. `fixedId` pins the session id (resurrection). */
  const openSession = async (
    repo: string,
    fixedId?: string,
  ): Promise<WebStandardStreamableHTTPServerTransport> => {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => fixedId ?? crypto.randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, lastSeen: Date.now() });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId !== undefined) sessions.delete(transport.sessionId);
    };
    const server = createMcpServer({
      store: deps.store,
      bus: deps.bus,
      baseUrl: deps.baseUrl,
      defaultRepo: repo,
    });
    // Same tolerance as the stdio path: a client may omit `arguments` on a no-arg tools/call
    // (mcpt does), which the tool's zod object would otherwise reject.
    await server.connect(tolerateAbsentToolArguments(transport));
    return transport;
  };

  /**
   * Sessions live in memory, so a server restart (or an idle eviction) would strand a connected
   * agent: its next call carries a session id this process no longer holds, and a plain 400 leaves
   * its tracepaper tools dead until the agent restarts. tracepaper sessions hold no state beyond the
   * canvas, and the canvas rides on every request (bridge header / ?repo= / cwd header), so rebuild
   * the session under the SAME id: drive a synthetic initialize + initialized through it, then serve
   * the real request. A restart or eviction becomes invisible.
   */
  const resurrect = (
    sid: string,
    repo: string,
    request: Request,
    url: URL,
  ): Promise<WebStandardStreamableHTTPServerTransport> => {
    const pending = resurrecting.get(sid);
    if (pending !== undefined) return pending;

    const revived = (async () => {
      const transport = await openSession(repo, sid);
      const protocolVersion = request.headers.get("mcp-protocol-version") ?? LATEST_PROTOCOL_VERSION;
      const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
      const init = await transport.handleRequest(
        new Request(url, {
          method: "POST",
          headers,
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "tracepaper-resurrect",
            method: "initialize",
            params: { protocolVersion, capabilities: {}, clientInfo: { name: "tracepaper-resurrect", version: "0" } },
          }),
        }),
      );
      if (!init.ok) throw new Error(`session resurrection failed: initialize answered ${init.status}`);
      await transport.handleRequest(
        new Request(url, {
          method: "POST",
          headers: { ...headers, "mcp-session-id": sid },
          body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        }),
      );
      console.error(`[tracepaper] resurrected MCP session ${sid.slice(0, 8)}… on canvas "${repo}"`);
      return transport;
    })().finally(() => resurrecting.delete(sid));
    resurrecting.set(sid, revived);
    return revived;
  };

  // A direct HTTP client (e.g. Claude Code) may never DELETE its session when it exits, so sessions
  // would pile up as agents cycle. Close the idle ones; resurrection makes this lossless.
  const sweeper = setInterval(() => {
    const cutoff = Date.now() - idleMs;
    for (const [sid, session] of sessions) {
      if (session.lastSeen < cutoff) {
        sessions.delete(sid);
        void session.transport.close();
      }
    }
  }, deps.sweepMs ?? DEFAULT_SWEEP_MS);
  sweeper.unref?.();

  const handle = async (request: Request, url: URL): Promise<Response> => {
    const sid = request.headers.get("mcp-session-id");
    const existing = sid === null ? undefined : sessions.get(sid);
    if (existing !== undefined) {
      existing.lastSeen = Date.now();
      return existing.transport.handleRequest(request);
    }

    if (request.method !== "POST") return badRequest("no MCP session for this request");
    const body: unknown = await request
      .clone()
      .json()
      .catch(() => null);

    let repo: string;
    try {
      repo = repoFor(request, url, deps.defaultRepo);
    } catch (error) {
      if (error instanceof BadCanvas) return badRequest(error.message);
      throw error;
    }

    // A session id we do not hold, on a non-initialize call: the server restarted (or evicted it)
    // under a live client. Rebuild the session instead of failing the call.
    if (sid !== null && !isInitializeRequest(body)) {
      const revived = await resurrect(sid, repo, request, url);
      return revived.handleRequest(request);
    }

    // No session: only an initialize request may open one.
    if (!isInitializeRequest(body)) return badRequest("expected an initialize request (no session)");
    const transport = await openSession(repo);
    return transport.handleRequest(request);
  };

  return Object.assign(handle, { activeSessions: () => sessions.size });
}
