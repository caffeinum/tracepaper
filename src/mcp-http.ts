/**
 * The MCP protocol over HTTP, so ONE tracepaper server can serve every agent instead of each agent
 * running its own ~56MB stdio MCP server. The heavy module graph (the MCP SDK + zod) is loaded once
 * here; per connection we create only a lightweight McpServer bound to the caller's canvas.
 *
 * Responses are plain JSON (`enableJsonResponse`), not SSE: tracepaper never pushes to the agent
 * (the protocol is pull-only), so there is nothing to stream, and a JSON reply keeps the SDK-free
 * stdio→HTTP bridge (src/bridge.ts) trivial — it relays the agent's own JSON-RPC line for line.
 *
 * Per-connection canvas ("repo") is resolved from the connection, never baked into a URL the human
 * edits per agent: the `x-tracepaper-repo` header wins, then a `?repo=` query, then the server's
 * default. The bridge sends the header (derived from each agent's own cwd/env), so one identical
 * config line scopes every agent correctly.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { tolerateAbsentToolArguments } from "./compat.ts";
import type { Bus } from "./events.ts";
import { createMcpServer } from "./mcp.ts";
import type { Store } from "./store.ts";

export const REPO_HEADER = "x-tracepaper-repo";

export type McpHttpDeps = {
  store: Store;
  bus: Bus;
  baseUrl: () => string;
  /** The canvas a connection that names none lands on. */
  defaultRepo: string;
};

export type McpHttpHandler = (request: Request, url: URL) => Promise<Response>;

/** The caller's canvas: explicit header wins, then query, then the server default. */
function repoFor(request: Request, url: URL, fallback: string): string {
  const header = request.headers.get(REPO_HEADER);
  if (header !== null && header !== "") return header;
  const query = url.searchParams.get("repo");
  if (query !== null && query !== "") return query;
  return fallback;
}

function badRequest(message: string): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
}

/**
 * A session (and a bound McpServer) per connection, tracked by the `mcp-session-id` header the
 * transport issues on initialize. The 56MB SDK graph is shared across all of them; each session
 * adds only its McpServer's tool registrations (~0.1MB, measured).
 */
export function createMcpHttpHandler(deps: McpHttpDeps): McpHttpHandler {
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

  return async (request, url) => {
    const sid = request.headers.get("mcp-session-id");
    const existing = sid === null ? undefined : sessions.get(sid);
    if (existing !== undefined) return existing.handleRequest(request);

    // No live session: only an initialize request may open one.
    if (request.method !== "POST") return badRequest("no MCP session for this request");
    const body: unknown = await request
      .clone()
      .json()
      .catch(() => null);
    if (!isInitializeRequest(body)) return badRequest("expected an initialize request (no session)");

    const repo = repoFor(request, url, deps.defaultRepo);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        sessions.set(id, transport);
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
    return transport.handleRequest(request);
  };
}
