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

export async function runBridge(serverUrl: string): Promise<void> {
  const repo = resolveRepo(process.env, process.cwd());
  const endpoint = `${serverUrl.replace(/\/+$/, "")}/mcp`;
  let sessionId: string | null = null;
  const log = (m: string): void => void process.stderr.write(`[tracepaper bridge] ${m}\n`);
  log(`canvas "${repo}" → shared server ${endpoint}`);

  const forward = async (line: string): Promise<void> => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-tracepaper-repo": repo,
    };
    if (sessionId !== null) headers["mcp-session-id"] = sessionId;

    let res: Response;
    try {
      res = await fetch(endpoint, { method: "POST", headers, body: line });
    } catch (error) {
      // The shared server vanished mid-session. Exit non-zero so the MCP client restarts us — and
      // the next launch, finding no live server, falls back to a self-contained stdio server.
      log(`shared server unreachable (${String(error)}) — exiting for a clean restart`);
      process.exit(1);
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
