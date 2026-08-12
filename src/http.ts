import { existsSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { toFramePayload, type Bus, type BusEvent } from "./events.ts";
import type { Store } from "./store.ts";
import {
  CreateCommentBodySchema,
  CreateOrUpdateFrameBodySchema,
  HealthSchema,
  ListCommentsQuerySchema,
  UpdateCommentBodySchema,
  type Comment,
} from "./types.ts";

const MAX_PORT_ATTEMPTS = 50;
const SSE_RETRY_MS = 3000;
const SSE_HEARTBEAT_MS = 15_000;
/** Bun's 10s default kills idle SSE streams before the heartbeat fires. 0 disables it. */
const SSE_IDLE_TIMEOUT_S = 0;

const DEFAULT_WEB_DIR = resolve(fileURLToPath(new URL("../web", import.meta.url)));

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

export type HttpServerOptions = {
  store: Store;
  bus: Bus;
  port: number;
  host: string;
  /** Canvas app root. Defaults to the repo's `web/` directory, resolved from this module. */
  webDir?: string;
};

export type HttpServer = {
  url: string;
  port: number;
  stop(): void;
};

export function startHttpServer(options: HttpServerOptions): HttpServer {
  const { store, bus, port, host } = options;
  const webDir = options.webDir === undefined ? DEFAULT_WEB_DIR : resolve(options.webDir);
  assertCanvasBuilt(webDir);
  const closeStream = new Set<() => void>();

  const handler = (request: Request): Response | Promise<Response> =>
    route({ request, store, bus, webDir, closeStream });

  const server = listen(handler, port, host);
  const bound = server.port;
  if (bound === undefined) throw new Error(`Bun.serve bound no TCP port on ${host}`);
  const url = `http://${host}:${bound}`;

  return {
    url,
    port: bound,
    stop() {
      for (const close of [...closeStream]) close();
      closeStream.clear();
      server.stop(true);
    },
  };
}

/** A canvas that cannot render is not worth booting quietly. */
function assertCanvasBuilt(webDir: string): void {
  for (const relative of ["index.html", join("dist", "canvas.js")]) {
    if (!existsSync(join(webDir, relative))) {
      throw new Error(
        `canvas asset is missing: ${join(webDir, relative)} — run \`bun run build:web\``,
      );
    }
  }
}

type BunServer = {
  port?: number | undefined;
  stop(closeActiveConnections?: boolean): void;
};

function listen(
  fetch: (request: Request) => Response | Promise<Response>,
  port: number,
  hostname: string,
): BunServer {
  if (port === 0) return Bun.serve({ port: 0, hostname, idleTimeout: SSE_IDLE_TIMEOUT_S, fetch });

  const errors: string[] = [];
  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
    const candidate = port + attempt;
    try {
      return Bun.serve({ port: candidate, hostname, idleTimeout: SSE_IDLE_TIMEOUT_S, fetch });
    } catch (error) {
      errors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(
    `no free port in ${port}..${port + MAX_PORT_ATTEMPTS - 1} on ${hostname}\n${errors.join("\n")}`,
  );
}

// ---------- routing ----------

type Context = {
  request: Request;
  store: Store;
  bus: Bus;
  webDir: string;
  closeStream: Set<() => void>;
};

const MUTATING = new Set(["POST", "PATCH", "DELETE"]);

/**
 * A JSON body sent as text/plain is a CORS-*simple* request: no preflight, and the browser
 * delivers it even though it will refuse to show the response. Reads are already protected by
 * the same-origin policy; writes were not. Two ways in: any page the human happens to be
 * visiting, and — the sharp one — the sandboxed frame itself, whose HTML an agent wrote from
 * possibly-hostile input. Since `author` decides whether a comment reads as the human, that let
 * pushed HTML put words in the human's mouth and feed them to the agent as instructions.
 *
 * A custom request header cannot be set by a simple request, so requiring one on every mutation
 * proves the caller is our own fetch and not a cross-document write.
 */
const CANVAS_HEADER = "x-paper-mcp";

function guardMutation(request: Request, method: string): Response | null {
  if (!MUTATING.has(method)) return null;
  if (request.headers.get(CANVAS_HEADER) !== null) return null;
  return json(
    { error: `writes require the ${CANVAS_HEADER} header (cross-origin write refused)` },
    403,
  );
}

async function route(ctx: Context): Promise<Response> {
  const { request } = ctx;
  const url = new URL(request.url);
  const method = request.method;

  const refused = guardMutation(request, method);
  if (refused !== null) return refused;

  let path: string;
  try {
    // Outside the main try: a malformed percent-escape throws URIError, which would otherwise
    // escape as Bun's HTML error page instead of this server's `{error}` JSON contract.
    path = decodeURIComponent(url.pathname);
  } catch {
    return json({ error: `malformed percent-encoding in path: ${url.pathname}` }, 400);
  }

  try {
    if (path === "/api/health" && method === "GET") return handleHealth(ctx);
    if (path === "/api/events" && method === "GET") return handleEvents(ctx);

    if (path === "/api/frames") {
      if (method === "GET") return handleListFrames(ctx);
      if (method === "POST") return await handleCreateOrUpdateFrame(ctx);
      return methodNotAllowed(method, path);
    }

    const frameId = matchPrefix(path, "/api/frames/");
    if (frameId !== null) {
      if (method === "GET") return handleGetFrame(ctx, frameId);
      if (method === "DELETE") return handleDeleteFrame(ctx, frameId);
      return methodNotAllowed(method, path);
    }

    const rawFrameId = matchPrefix(path, "/f/");
    if (rawFrameId !== null) {
      if (method === "GET") return handleFrameHtml(ctx, rawFrameId);
      return methodNotAllowed(method, path);
    }

    if (path === "/api/comments") {
      if (method === "GET") return handleListComments(ctx, url);
      if (method === "POST") return await handleCreateComment(ctx);
      return methodNotAllowed(method, path);
    }

    const commentId = matchPrefix(path, "/api/comments/");
    if (commentId !== null) {
      if (method === "PATCH") return await handleUpdateComment(ctx, commentId);
      if (method === "DELETE") return handleDeleteComment(ctx, commentId);
      return methodNotAllowed(method, path);
    }

    if (method === "GET") return await handleStatic(ctx, path);
    return methodNotAllowed(method, path);
  } catch (error) {
    return errorResponse(error, `${method} ${path}`);
  }
}

function matchPrefix(path: string, prefix: string): string | null {
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  if (rest.length === 0 || rest.includes("/")) return null;
  return rest;
}

// ---------- handlers ----------

function handleHealth(ctx: Context): Response {
  const { frames, comments } = ctx.store.counts();
  return json(HealthSchema.parse({ ok: true, frames, comments }));
}

function handleListFrames(ctx: Context): Response {
  return json({ frames: ctx.store.listFrames() });
}

function handleGetFrame(ctx: Context, id: string): Response {
  return json(ctx.store.getFrame(id));
}

async function handleCreateOrUpdateFrame(ctx: Context): Promise<Response> {
  const body = await readJson(ctx.request);
  if (body instanceof Response) return body;

  const parsed = CreateOrUpdateFrameBodySchema.safeParse(body);
  if (!parsed.success) return badRequest(z.prettifyError(parsed.error));
  const { html, name, frameId, width, height } = parsed.data;

  if (frameId !== undefined) {
    const frame = ctx.store.updateFrameHtml(frameId, html, { name, width, height });
    ctx.bus.emit({ type: "frame.updated", frame: toFramePayload(frame) });
    return json(frame);
  }

  const frame = ctx.store.createFrame({ html, name, width, height });
  ctx.bus.emit({ type: "frame.created", frame: toFramePayload(frame) });
  return json(frame, 201);
}

function handleDeleteFrame(ctx: Context, id: string): Response {
  const frame = ctx.store.getFrame(id);
  ctx.store.deleteFrame(id);
  ctx.bus.emit({ type: "frame.deleted", frame: toFramePayload(frame) });
  return json({ ok: true, id });
}

function handleFrameHtml(ctx: Context, id: string): Response {
  const frame = ctx.store.getFrame(id);
  return new Response(asDocument(frame.html), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      // The iframe's sandbox attribute only applies when this document is framed BY the canvas.
      // Opened directly in a tab it would otherwise be an ordinary same-origin page, and this
      // HTML was written by an agent that may have been fed hostile input — it could then read
      // every frame over /api and write the canvas origin's storage. The CSP carries the same
      // sandbox with the response, so it holds however the document is loaded.
      "content-security-policy": "sandbox allow-scripts allow-forms allow-popups",
      "x-content-type-options": "nosniff",
    },
  });
}

function handleListComments(ctx: Context, url: URL): Response {
  const parsed = ListCommentsQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return badRequest(z.prettifyError(parsed.error));

  const comments = ctx.store.listComments(parsed.data);
  return json({ comments, cursor: ctx.store.nextCursor(comments, parsed.data.since) });
}

async function handleCreateComment(ctx: Context): Promise<Response> {
  const body = await readJson(ctx.request);
  if (body instanceof Response) return body;

  const parsed = CreateCommentBodySchema.safeParse(body);
  if (!parsed.success) return badRequest(z.prettifyError(parsed.error));

  const comment = ctx.store.createComment(parsed.data);
  ctx.bus.emit({ type: "comment.created", comment });
  return json(comment, 201);
}

async function handleUpdateComment(ctx: Context, id: string): Promise<Response> {
  const body = await readJson(ctx.request);
  if (body instanceof Response) return body;

  const parsed = UpdateCommentBodySchema.safeParse(body);
  if (!parsed.success) return badRequest(z.prettifyError(parsed.error));

  // One event per changed row: resolving a thread also flips its replies, and an SSE-only
  // client would otherwise keep showing them open inside a resolved thread.
  const changed = ctx.store.updateComment(id, parsed.data);
  for (const comment of changed) ctx.bus.emit({ type: "comment.updated", comment });
  const [target] = changed;
  if (target === undefined) throw new Error(`updateComment(${id}) changed nothing`);
  return json(target);
}

function handleDeleteComment(ctx: Context, id: string): Response {
  const comment = ctx.store.getComment(id);
  ctx.store.deleteComment(id);
  ctx.bus.emit({ type: "comment.deleted", comment });
  return json({ ok: true, id });
}

function handleEvents(ctx: Context): Response {
  const { bus, closeStream } = ctx;
  const encoder = new TextEncoder();

  let teardown = (): void => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const write = (chunk: string): void => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch (error) {
          console.error("[sse] write failed, dropping subscriber:", error);
          teardown();
        }
      };

      write(`retry: ${SSE_RETRY_MS}\n\n`);
      write(": connected\n\n");

      const unsubscribe = bus.subscribe((event: BusEvent) => {
        write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      });
      const heartbeat = setInterval(() => write(": ping\n\n"), SSE_HEARTBEAT_MS);

      teardown = () => {
        if (!open) return;
        open = false;
        unsubscribe();
        clearInterval(heartbeat);
        closeStream.delete(teardown);
        try {
          controller.close();
        } catch {
          // already closed by the client
        }
      };
      closeStream.add(teardown);
    },
    cancel() {
      teardown();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

async function handleStatic(ctx: Context, path: string): Promise<Response> {
  const relative = path === "/" ? "index.html" : path.replace(/^\/+/, "");
  if (relative.includes("\0")) return fail(400, `bad path: ${path}`);

  const target = resolve(ctx.webDir, relative);
  if (target !== ctx.webDir && !target.startsWith(ctx.webDir + sep)) {
    return fail(403, `path escapes the web directory: ${path}`);
  }

  const file = Bun.file(target);
  if (!(await file.exists())) {
    if (relative === "index.html") {
      return fail(500, `canvas app is missing: ${target} (run \`bun run build:web\`)`);
    }
    return fail(404, `not found: ${path}`);
  }

  const type = CONTENT_TYPES[extname(target).toLowerCase()];
  const headers: Record<string, string> = { "cache-control": "no-store" };
  if (type !== undefined) headers["content-type"] = type;
  return new Response(file, { headers });
}

// ---------- helpers ----------

/** Fragments get a minimal wrapper so links escape the sandboxed iframe; documents pass through. */
function asDocument(html: string): string {
  if (/<html[\s>]/i.test(html)) return html;
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><base target="_blank"></head>
<body>${html}</body>
</html>`;
}

/** Returns the parsed body, or a 400 Response the caller must return as-is. */
async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch (error) {
    return badRequest(`invalid JSON body: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function fail(status: number, message: string): Response {
  return json({ error: message }, status);
}

function badRequest(message: string): Response {
  return fail(400, message);
}

function methodNotAllowed(method: string, path: string): Response {
  return fail(405, `${method} is not allowed on ${path}`);
}

function errorResponse(error: unknown, where: string): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (/^unknown (frame|comment)/.test(message)) return fail(404, message);
  if (message.startsWith("`since`")) return badRequest(message);
  if (/^parent comment /.test(message)) return badRequest(message);
  console.error(`[http] ${where} failed:`, error);
  return fail(500, message);
}
