/**
 * A tiny, SDK-free stdio↔HTTP bridge.
 *
 * Each agent still launches tracepaper with one identical command, but when a shared server is
 * already running (see `tracepaper up`) it does NOT spin up its own ~56MB MCP server — it relays
 * JSON-RPC between the client's stdio and the shared server's /mcp endpoint. The per-agent canvas
 * is resolved from THIS process's own cwd/env (resolveRepo) and sent as a header, so one identical
 * config line scopes every agent correctly, with no per-agent URL to edit.
 *
 * Deliberately imports no MCP SDK and no zod — that module graph is what costs ~56MB. A bridge is
 * just the Bun runtime + fetch + stdio (~10MB measured). The MCP stdio framing is newline-delimited
 * JSON, and tracepaper's server answers each POST with a single JSON message (never SSE), so the
 * relay is a line-for-line pass-through.
 */
import { resolveRepo } from "./repo.ts";

/** How long a bridge waits out a shared-server restart before giving up. */
const RESTART_GRACE_MS = 20_000;

export async function runBridge(serverUrl: string): Promise<void> {
  const repo = resolveRepo(process.env, process.cwd());
  const endpoint = `${serverUrl.replace(/\/+$/, "")}/mcp`;
  let sessionId: string | null = null;
  const log = (m: string): void => void process.stderr.write(`[tracepaper bridge] ${m}\n`);
  log(`canvas "${repo}" → shared server ${endpoint}`);

  // The client's own initialize, kept so a lost session can be re-established on its behalf.
  let initializeLine: string | null = null;

  const post = (body: string): Promise<Response> => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-tracepaper-repo": repo,
    };
    if (sessionId !== null) headers["mcp-session-id"] = sessionId;
    return fetch(endpoint, { method: "POST", headers, body });
  };

  /** POST, riding out a shared-server restart: retry connection errors for up to ~20s. */
  const postWithRetry = async (body: string): Promise<Response> => {
    const deadline = Date.now() + RESTART_GRACE_MS;
    let delay = 250;
    for (;;) {
      try {
        return await post(body);
      } catch (error) {
        if (Date.now() > deadline) {
          // Gone for good. Exit non-zero so the MCP client restarts us — and the next launch,
          // finding no live server, falls back to a self-contained stdio server.
          log(`shared server unreachable for ${RESTART_GRACE_MS / 1000}s (${String(error)}) — exiting`);
          process.exit(1);
        }
        await Bun.sleep(delay);
        delay = Math.min(delay * 2, 2000);
      }
    }
  };

  /** Open a fresh session by replaying the client's initialize (the reply is ours, not the client's). */
  const reinitialize = async (): Promise<void> => {
    if (initializeLine === null) throw new Error("lost the MCP session before the client initialized");
    sessionId = null;
    const init = await postWithRetry(initializeLine);
    const issued = init.headers.get("mcp-session-id");
    if (!init.ok || issued === null || issued === "") {
      throw new Error(`could not re-establish the MCP session (initialize answered ${init.status})`);
    }
    sessionId = issued;
    await init.text();
    await postWithRetry(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    log("re-established the MCP session after the shared server dropped it");
  };

  const forward = async (line: string): Promise<void> => {
    if (initializeLine === null && /"method"\s*:\s*"initialize"/.test(line)) initializeLine = line;

    let res = await postWithRetry(line);
    // A server that restarted without session resurrection answers our old session id with a 400.
    // Re-open a session transparently and retry, so the client never sees the restart.
    if (res.status === 400 && sessionId !== null && initializeLine !== line) {
      const text = await res.clone().text();
      if (/no MCP session|initialize request/i.test(text)) {
        await reinitialize();
        res = await postWithRetry(line);
      }
    }

    const issued = res.headers.get("mcp-session-id");
    if (issued !== null && issued !== "") sessionId = issued;

    // 202 = an accepted notification with no reply. Anything else carries a JSON-RPC message.
    if (res.status === 202) return;
    const text = await res.text();
    if (text.length === 0) return;
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  };

  // Serialize forwarding: the client waits for the initialize reply (which carries the session id)
  // before sending anything else, and a serial queue guarantees that id is set for every message
  // that follows.
  let queue: Promise<void> = Promise.resolve();
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line.length > 0) queue = queue.then(() => forward(line));
      nl = buffer.indexOf("\n");
    }
  });

  const shutdown = async (): Promise<void> => {
    if (sessionId !== null) {
      try {
        await fetch(endpoint, { method: "DELETE", headers: { "mcp-session-id": sessionId } });
      } catch {
        // best effort — the client is gone, the session will lapse on its own
      }
    }
    process.exit(0);
  };
  process.stdin.on("end", () => void shutdown());
  process.stdin.on("close", () => void shutdown());

  // Hold the process open; stdin close is the only exit.
  await new Promise<never>(() => {});
}
