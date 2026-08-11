import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

type JsonRpcMessage = {
  method?: unknown;
  params?: { arguments?: unknown };
};

/**
 * JSON-RPC lets a client omit `arguments` entirely on a `tools/call` with nothing to pass, and
 * real clients do — the `mcpt` CLI (f/mcp-tools) sends no `arguments` key at all. The SDK feeds
 * that `undefined` straight into the tool's zod object, which rejects it, so a no-argument tool
 * like `list_frames` is unreachable from those clients. Absent arguments and empty arguments mean
 * the same thing, so normalize at the protocol boundary rather than loosening every tool schema.
 *
 * Wraps the transport's `onmessage` so the fix applies to whatever handler the SDK installs.
 */
export function tolerateAbsentToolArguments(transport: Transport): Transport {
  let downstream: Transport["onmessage"];

  const wrapped: NonNullable<Transport["onmessage"]> = (message, extra) => {
    const candidate = message as JsonRpcMessage;
    if (
      candidate.method === "tools/call" &&
      typeof candidate.params === "object" &&
      candidate.params !== null &&
      candidate.params.arguments === undefined
    ) {
      candidate.params.arguments = {};
    }
    downstream?.(message, extra);
  };

  Object.defineProperty(transport, "onmessage", {
    configurable: true,
    get: () => (downstream === undefined ? undefined : wrapped),
    set: (handler: Transport["onmessage"]) => {
      downstream = handler;
    },
  });

  return transport;
}
