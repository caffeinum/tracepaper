import type { PublishFrame } from "./validate.ts";

export interface McpCanvas {
  read(): {
    id: string;
    name: string;
    version: number;
    frames: Array<Omit<PublishFrame, "html"> & { version: number }>;
  } | null;
  htmlOf(frameId: string): string | null;
  upsertFrame(slug: string, frame: PublishFrame): { version: number };
}

const TOOLS = [
  {
    name: "push_html",
    description: "Add or replace one HTML frame on this canvas. Omit frameId to add. Pass frameId to replace that frame.",
    inputSchema: {
      type: "object",
      properties: {
        html: { type: "string" },
        name: { type: "string" },
        frameId: { type: "string" },
        width: { type: "number" },
        height: { type: "number" },
        x: { type: "number" },
        y: { type: "number" },
      },
      required: ["html"],
    },
  },
  {
    name: "list_frames",
    description: "List frames on this canvas. Does not include HTML.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_frame",
    description: "Read one frame, including its HTML.",
    inputSchema: {
      type: "object",
      properties: { frameId: { type: "string" } },
      required: ["frameId"],
    },
  },
  {
    name: "publish",
    description: "Put HTML on this canvas and return the public view link. Omit frameId to add a frame. The link cannot edit.",
    inputSchema: {
      type: "object",
      properties: {
        html: { type: "string" },
        name: { type: "string" },
        frameId: { type: "string" },
        width: { type: "number" },
        height: { type: "number" },
        x: { type: "number" },
        y: { type: "number" },
      },
      required: ["html"],
    },
  },
  {
    name: "share",
    description: "Put HTML on this canvas and return the public view link. The link cannot edit.",
    inputSchema: { type: "object", properties: {} },
  },
];

function rpc(id: unknown, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, result });
}

function rpcError(id: unknown, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id, error: { code: -32000, message } });
}

function toolText(text: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text }] };
}

export async function handleMcp(
  request: Request,
  canvas: McpCanvas,
  canvasId: string,
  viewUrl: string,
  mcpUrl: string,
): Promise<Response> {
  if (request.method === "GET") {
    return Response.json({ ok: true, mcp: "POST json-rpc to this url" });
  }
  if (request.method !== "POST") {
    return Response.json({ error: "mcp expects POST" }, { status: 405 });
  }
  const body = (await request.json()) as { id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
  const id = body.id ?? null;
  if (body.method === "initialize") {
    return rpc(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "tracepaper", version: "0.1.0" },
      instructions: [
        "Anonymous canvas. No login.",
        `Public view link, cannot edit: ${viewUrl}`,
        `To keep this canvas, reconnect at ${mcpUrl}`,
        "Call publish with html to put a frame on the canvas and get the public link.",
      ].join("\n"),
    });
  }
  if (body.method === "notifications/initialized" || body.method === "ping") {
    return rpc(id, {});
  }
  if (body.method === "tools/list") return rpc(id, { tools: TOOLS });
  if (body.method !== "tools/call") return rpcError(id, `unsupported method: ${body.method ?? ""}`);

  const name = body.params?.name;
  const args = body.params?.arguments ?? {};
  const current = await canvas.read();
  if (current === null) return rpcError(id, `unknown canvas: ${canvasId}`);

  if (name === "list_frames") {
    return rpc(id, toolText(JSON.stringify({ canvasUrl: viewUrl, frames: current.frames })));
  }
  if (name === "share" || name === "publish" && args.html === undefined) {
    return rpc(id, toolText(viewUrl));
  }
  if (name === "get_frame") {
    const frameId = args.frameId;
    if (typeof frameId !== "string") return rpcError(id, "frameId is required");
    const html = await canvas.htmlOf(frameId);
    if (html === null) return rpcError(id, `unknown frame: ${frameId}`);
    const meta = current.frames.find((frame) => frame.id === frameId);
    return rpc(id, toolText(JSON.stringify({ ...meta, html })));
  }
  if (name === "push_html" || name === "publish") {
    if (typeof args.html !== "string" || args.html.length === 0) return rpcError(id, "html is required");
    const frameId = typeof args.frameId === "string" ? args.frameId : `frm_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    if (!/^frm_[0-9a-f]{12}$/.test(frameId)) return rpcError(id, `bad frame id: ${frameId}`);
    const existing = current.frames.find((frame) => frame.id === frameId);
    const width = typeof args.width === "number" ? args.width : existing?.width ?? 1280;
    const height = typeof args.height === "number" ? args.height : existing?.height ?? 900;
    const x = typeof args.x === "number" ? args.x : existing?.x ?? current.frames.length * 80;
    const y = typeof args.y === "number" ? args.y : existing?.y ?? 0;
    const saved = await canvas.upsertFrame(canvasId, {
      id: frameId,
      name: typeof args.name === "string" ? args.name : existing?.name ?? "Frame",
      html: args.html,
      width,
      height,
      x,
      y,
      kind: "html",
      fontSize: null,
    });
    return rpc(id, toolText(JSON.stringify({ id: frameId, version: saved.version, canvasUrl: viewUrl, mcpUrl })));
  }
  return rpcError(id, `unknown tool: ${name ?? ""}`);
}
