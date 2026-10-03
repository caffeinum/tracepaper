import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Bus } from "../src/events.ts";
import { startHttpServer, type HttpServer } from "../src/http.ts";
import { createMcpHttpHandler, CWD_HEADER, type McpHttpHandler } from "../src/mcp-http.ts";
import { resolveRepo } from "../src/repo.ts";
import { Store } from "../src/store.ts";

const webDir = mkdtempSync(join(tmpdir(), "tracepaper-mcp-web-"));
mkdirSync(join(webDir, "dist"));
writeFileSync(join(webDir, "index.html"), "<!doctype html><title>canvas</title>");
writeFileSync(join(webDir, "style.css"), ":root{}");
writeFileSync(join(webDir, "dist", "canvas.js"), "export const canvas = 1;");

let store: Store;
let bus: Bus;
let server: HttpServer;
let noMcp: HttpServer;
let base: string;

beforeAll(() => {
  store = new Store(":memory:");
  bus = new Bus();
  server = startHttpServer({
    store,
    bus,
    port: 0,
    host: "127.0.0.1",
    webDir,
    mcpDefaultRepo: "default",
  });
  base = server.url;
  // A second server WITHOUT the MCP endpoint, to prove the capability flag and the 501.
  noMcp = startHttpServer({ store, bus, port: 0, host: "127.0.0.1", webDir });
});

afterAll(() => {
  server.stop();
  noMcp.stop();
  store.close();
  rmSync(webDir, { recursive: true, force: true });
});

describe("MCP over HTTP", () => {
  test("health advertises the mcp capability only when the endpoint is mounted", async () => {
    const on = await (await fetch(`${base}/api/health`)).json();
    expect(on.mcp).toBe(true);
    const off = await (await fetch(`${noMcp.url}/api/health`)).json();
    expect(off.mcp).toBe(false);
  });

  test("a server without the endpoint answers /mcp with 501", async () => {
    const res = await fetch(`${noMcp.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(501);
  });

  // The exact wire the SDK-free bridge relies on: initialize returns JSON + a session id, and a
  // follow-up tool call on that session is scoped to the repo named at initialize.
  test("bridge wire: initialize issues a JSON session, header scopes the canvas", async () => {
    const init = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-tracepaper-repo": "wire-canvas",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
      }),
    });
    expect(init.headers.get("content-type")).toContain("application/json");
    const sid = init.headers.get("mcp-session-id");
    expect(sid).toBeTruthy();
    const initBody = await init.json();
    expect(initBody.result.serverInfo.name).toBe("tracepaper");

    const initialized = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": sid! },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(initialized.status).toBe(202);

    const call = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": sid! },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_frames", arguments: {} } }),
    });
    const body = await call.json();
    expect(body.result.content[0].text).toContain('wire-canvas');
  });

  // Clients like mcpt omit `arguments` entirely on a no-arg call; the endpoint must tolerate it
  // (same as the stdio path) or list_frames is unreachable over HTTP / the bridge.
  test("bridge wire: tools/call with no arguments field is tolerated", async () => {
    const init = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
      }),
    });
    const sid = init.headers.get("mcp-session-id")!;
    const call = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": sid },
      // NB: no `arguments` key at all
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_frames" } }),
    });
    const body = await call.json();
    expect(body.error).toBeUndefined();
    expect(body.result.isError).toBeFalsy();
  });

  // A restart loses the in-memory session map. A live bridge's next call carries a session id the
  // new process never issued; it must be resurrected (scoped by the header), not answered with 400.
  test("a stale session id after a server restart is resurrected, not rejected", async () => {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    const init = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...headers, "x-tracepaper-repo": "survivor" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
      }),
    });
    const sid = init.headers.get("mcp-session-id")!;

    // "restart": a brand-new server process over the same data, with an empty session map
    const restarted = startHttpServer({ store, bus, port: 0, host: "127.0.0.1", webDir, mcpDefaultRepo: "default" });
    try {
      const call = await fetch(`${restarted.url}/mcp`, {
        method: "POST",
        headers: { ...headers, "mcp-session-id": sid, "x-tracepaper-repo": "survivor" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_frames", arguments: {} } }),
      });
      expect(call.status).toBe(200);
      const body = await call.json();
      expect(body.error).toBeUndefined();
      expect(body.result.content[0].text).toContain("survivor");

      // and the revived session keeps working for the next call too
      const again = await fetch(`${restarted.url}/mcp`, {
        method: "POST",
        headers: { ...headers, "mcp-session-id": sid },
        body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
      });
      expect((await again.json()).result.tools.length).toBeGreaterThan(0);
    } finally {
      restarted.stop();
    }
  });

  test("a full MCP HTTP client shares the server; two clients get independent canvases", async () => {
    const connect = async (repo: string): Promise<Client> => {
      const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp?repo=${repo}`));
      const client = new Client({ name: `c-${repo}`, version: "1" });
      await client.connect(transport);
      return client;
    };
    const a = await connect("canvas-a");
    const b = await connect("canvas-b");

    const tools = await a.listTools();
    expect(tools.tools.length).toBeGreaterThan(0);

    const ra = (await a.callTool({ name: "list_frames", arguments: {} })) as { content: { text: string }[] };
    const rb = (await b.callTool({ name: "list_frames", arguments: {} })) as { content: { text: string }[] };
    expect(ra.content[0]?.text).toContain("canvas-a");
    expect(rb.content[0]?.text).toContain("canvas-b");

    await a.close();
    await b.close();
  });
});

// ---------- driven directly (no HTTP server): canvas from cwd, idle eviction ----------


const JSON_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const INIT = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
});
const LIST_FRAMES = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_frames", arguments: {} } });

async function call(handler: McpHttpHandler, body: string, headers: Record<string, string>): Promise<Response> {
  const url = new URL("http://127.0.0.1/mcp");
  return handler(new Request(url, { method: "POST", headers: { ...JSON_HEADERS, ...headers }, body }), url);
}

describe("MCP over HTTP — canvas from the client's cwd", () => {
  const handler = (): McpHttpHandler =>
    createMcpHttpHandler({ store, bus, baseUrl: () => "http://127.0.0.1", defaultRepo: "default" });

  test("x-tracepaper-cwd resolves the canvas the same way a stdio server would from that cwd", async () => {
    const cwd = process.cwd();
    const h = handler();
    const init = await call(h, INIT, { [CWD_HEADER]: cwd });
    expect(init.status).toBe(200);
    const sid = init.headers.get("mcp-session-id")!;
    const res = await call(h, LIST_FRAMES, { "mcp-session-id": sid });
    const text: string = (await res.json()).result.content[0].text;
    expect(text).toContain(`"${resolveRepo({}, cwd)}"`);
  });

  test("an explicit x-tracepaper-repo beats the cwd", async () => {
    const h = handler();
    const init = await call(h, INIT, { [CWD_HEADER]: process.cwd(), "x-tracepaper-repo": "named-wins" });
    const sid = init.headers.get("mcp-session-id")!;
    const res = await call(h, LIST_FRAMES, { "mcp-session-id": sid });
    expect((await res.json()).result.content[0].text).toContain('"named-wins"');
  });

  test("a relative or missing cwd is a loud 400, never a silent default canvas", async () => {
    const rel = await call(handler(), INIT, { [CWD_HEADER]: "some/relative/dir" });
    expect(rel.status).toBe(400);
    expect((await rel.json()).error.message).toContain("absolute path");

    const missing = await call(handler(), INIT, { [CWD_HEADER]: "/definitely/not/a/real/dir/xyz" });
    expect(missing.status).toBe(400);
    expect((await missing.json()).error.message).toContain("not an existing directory");
  });
});

describe("MCP over HTTP — idle sessions", () => {
  test("idle sessions are evicted, and a later call on the evicted id still works", async () => {
    const h = createMcpHttpHandler({
      store,
      bus,
      baseUrl: () => "http://127.0.0.1",
      defaultRepo: "default",
      idleMs: 40,
      sweepMs: 15,
    });
    const init = await call(h, INIT, { "x-tracepaper-repo": "idle-canvas" });
    const sid = init.headers.get("mcp-session-id")!;
    expect(h.activeSessions()).toBe(1);

    await Bun.sleep(150);
    expect(h.activeSessions()).toBe(0);

    const res = await call(h, LIST_FRAMES, { "mcp-session-id": sid, "x-tracepaper-repo": "idle-canvas" });
    expect(res.status).toBe(200);
    expect((await res.json()).result.content[0].text).toContain('"idle-canvas"');
    expect(h.activeSessions()).toBe(1);
  });
});
