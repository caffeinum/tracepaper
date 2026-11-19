import { DurableObject } from "cloudflare:workers";
import { handleMcp } from "./mcp.ts";
import { publishedCanvasHtml } from "./page.ts";
import { bearerMatches, parsePublish, parseSlug, PublishError, type PublishBody, type PublishFrame } from "./validate.ts";

interface Env {
  CANVAS: DurableObjectNamespace<Canvas>;
  REGISTRY: DurableObjectNamespace<Registry>;
  /** The local canvas files (web/). The published page is that UI, not a second viewer. */
  ASSETS: Fetcher;
  /** Set with `wrangler secret put PUBLISH_TOKEN`. Writes refuse when it is missing. */
  PUBLISH_TOKEN?: string;
}

const FRAME_ID_RE = /^frm_[0-9a-f]{12}$/;
const REVISIONS_KEPT = 8;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function textError(status: number, message: string): Response {
  return json({ error: message }, status);
}

export class Registry extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS canvases (id TEXT PRIMARY KEY, name TEXT NOT NULL, updated_at INTEGER NOT NULL, frame_count INTEGER NOT NULL)",
    );
  }

  upsert(row: { id: string; name: string; updatedAt: number; frameCount: number }): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO canvases (id, name, updated_at, frame_count) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at, frame_count = excluded.frame_count`,
      row.id,
      row.name,
      row.updatedAt,
      row.frameCount,
    );
  }

  bind(keyHash: string, canvasId: string): void {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS keys (key_hash TEXT PRIMARY KEY, canvas_id TEXT NOT NULL)",
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO keys (key_hash, canvas_id) VALUES (?, ?) ON CONFLICT(key_hash) DO UPDATE SET canvas_id = excluded.canvas_id",
      keyHash,
      canvasId,
    );
  }

  canvasForKey(keyHash: string): string | null {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS keys (key_hash TEXT PRIMARY KEY, canvas_id TEXT NOT NULL)",
    );
    const row = this.ctx.storage.sql
      .exec<{ canvas_id: string }>("SELECT canvas_id FROM keys WHERE key_hash = ?", keyHash)
      .toArray()[0];
    return row === undefined ? null : row.canvas_id;
  }

  saveSession(id: string, canvasId: string, editKey: string): void {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, canvas_id TEXT NOT NULL, edit_key TEXT NOT NULL)",
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO sessions (id, canvas_id, edit_key) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET canvas_id = excluded.canvas_id, edit_key = excluded.edit_key",
      id,
      canvasId,
      editKey,
    );
  }

  loadSession(id: string): { canvasId: string; editKey: string } | null {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, canvas_id TEXT NOT NULL, edit_key TEXT NOT NULL)",
    );
    const row = this.ctx.storage.sql
      .exec<{ canvas_id: string; edit_key: string }>("SELECT canvas_id, edit_key FROM sessions WHERE id = ?", id)
      .toArray()[0];
    return row === undefined ? null : { canvasId: row.canvas_id, editKey: row.edit_key };
  }

  remove(id: string): boolean {
    return this.ctx.storage.sql.exec("DELETE FROM canvases WHERE id = ?", id).rowsWritten > 0;
  }

  list(): Array<{ id: string; name: string; updatedAt: number; frameCount: number }> {
    return this.ctx.storage.sql
      .exec<{ id: string; name: string; updated_at: number; frame_count: number }>(
        "SELECT id, name, updated_at, frame_count FROM canvases ORDER BY updated_at DESC",
      )
      .toArray()
      .map((row) => ({
        id: row.id,
        name: row.name,
        updatedAt: row.updated_at,
        frameCount: row.frame_count,
      }));
  }
}

export class Canvas extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS meta (id TEXT PRIMARY KEY, name TEXT NOT NULL, version INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
    );
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS frames (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        html TEXT NOT NULL,
        width REAL NOT NULL,
        height REAL NOT NULL,
        x REAL NOT NULL,
        y REAL NOT NULL,
        kind TEXT NOT NULL,
        font_size REAL,
        version INTEGER NOT NULL
      )`,
    );
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS revisions (
        frame_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        html TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (frame_id, version)
      )`,
    );
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        frame_id TEXT NOT NULL,
        x REAL NOT NULL,
        y REAL NOT NULL,
        text TEXT NOT NULL,
        author TEXT NOT NULL,
        parent_id TEXT,
        resolved INTEGER NOT NULL,
        frame_version INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    );
  }

  snapshot(slug: string, body: PublishBody): { version: number; updatedAt: number } {
    const now = Date.now();
    const version = this.ctx.storage.transactionSync(() => {
      const current = this.ctx.storage.sql
        .exec<{ version: number }>("SELECT version FROM meta WHERE id = ?", slug)
        .toArray()[0];
      const version = (current?.version ?? 0) + 1;
      const previous = this.ctx.storage.sql
        .exec<{ id: string; html: string; version: number }>("SELECT id, html, version FROM frames")
        .toArray();
      const incoming = new Set(body.frames.map((frame) => frame.id));
      for (const row of previous) {
        if (!incoming.has(row.id)) {
          this.ctx.storage.sql.exec("DELETE FROM frames WHERE id = ?", row.id);
          continue;
        }
        const next = body.frames.find((frame) => frame.id === row.id);
        if (next !== undefined && next.html !== row.html) {
          this.ctx.storage.sql.exec(
            "INSERT INTO revisions (frame_id, version, html, at) VALUES (?, ?, ?, ?) ON CONFLICT(frame_id, version) DO UPDATE SET html = excluded.html, at = excluded.at",
            row.id,
            row.version,
            row.html,
            now,
          );
          const kept = this.ctx.storage.sql
            .exec<{ version: number }>(
              "SELECT version FROM revisions WHERE frame_id = ? ORDER BY version DESC LIMIT ?",
              row.id,
              REVISIONS_KEPT,
            )
            .toArray()
            .map((rev) => rev.version);
          const stale = this.ctx.storage.sql
            .exec<{ version: number }>("SELECT version FROM revisions WHERE frame_id = ?", row.id)
            .toArray()
            .filter((rev) => !kept.includes(rev.version));
          for (const rev of stale) {
            this.ctx.storage.sql.exec("DELETE FROM revisions WHERE frame_id = ? AND version = ?", row.id, rev.version);
          }
        }
      }
      for (const frame of body.frames) this.writeFrame(frame, version);
      this.ctx.storage.sql.exec(
        "INSERT INTO meta (id, name, version, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, version = excluded.version, updated_at = excluded.updated_at",
        slug,
        body.name,
        version,
        now,
      );
      return version;
    });
    const message = JSON.stringify({ type: "updated", version });
    for (const socket of this.ctx.getWebSockets()) socket.send(message);
    return { version, updatedAt: now };
  }

  ensure(slug: string, name: string): void {
    if (this.read() !== null) return;
    this.ctx.storage.sql.exec(
      "INSERT INTO meta (id, name, version, updated_at) VALUES (?, ?, 0, ?)",
      slug,
      name,
      Date.now(),
    );
  }

  upsertFrame(slug: string, frame: PublishFrame): { version: number } {
    const saved = this.ctx.storage.transactionSync(() => {
      this.ensure(slug, slug);
      const current = this.ctx.storage.sql
        .exec<{ version: number; name: string }>("SELECT version, name FROM meta WHERE id = ?", slug)
        .toArray()[0];
      const version = (current?.version ?? 0) + 1;
      this.writeFrame(frame, version);
      this.ctx.storage.sql.exec(
        "INSERT INTO meta (id, name, version, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at",
        slug,
        current?.name ?? slug,
        version,
        Date.now(),
      );
      return version;
    });
    const message = JSON.stringify({ type: "updated", version: saved });
    for (const socket of this.ctx.getWebSockets()) socket.send(message);
    return { version: saved };
  }

  private writeFrame(frame: PublishFrame, version: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO frames (id, name, html, width, height, x, y, kind, font_size, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, html = excluded.html, width = excluded.width, height = excluded.height,
         x = excluded.x, y = excluded.y, kind = excluded.kind, font_size = excluded.font_size, version = excluded.version`,
      frame.id,
      frame.name,
      frame.html,
      frame.width,
      frame.height,
      frame.x,
      frame.y,
      frame.kind,
      frame.fontSize,
      version,
    );
  }

  read(): {
    id: string;
    name: string;
    version: number;
    updatedAt: number;
    frames: Array<Omit<PublishFrame, "html"> & { version: number }>;
  } | null {
    const meta = this.ctx.storage.sql
      .exec<{ id: string; name: string; version: number; updated_at: number }>(
        "SELECT id, name, version, updated_at FROM meta",
      )
      .toArray()[0];
    if (meta === undefined) return null;
    const frames = this.ctx.storage.sql
      .exec<{
        id: string;
        name: string;
        width: number;
        height: number;
        x: number;
        y: number;
        kind: PublishFrame["kind"];
        font_size: number | null;
        version: number;
      }>("SELECT id, name, width, height, x, y, kind, font_size, version FROM frames ORDER BY id")
      .toArray()
      .map((row) => ({
        id: row.id,
        name: row.name,
        width: row.width,
        height: row.height,
        x: row.x,
        y: row.y,
        kind: row.kind,
        fontSize: row.font_size,
        version: row.version,
      }));
    return { id: meta.id, name: meta.name, version: meta.version, updatedAt: meta.updated_at, frames };
  }

  raw(frameId: string): { html: string; version: number } | null {
    const row = this.ctx.storage.sql
      .exec<{ html: string; version: number; kind: string }>(
        "SELECT html, version, kind FROM frames WHERE id = ?",
        frameId,
      )
      .toArray()[0];
    if (row === undefined || row.kind !== "html") return null;
    return { html: row.html, version: row.version };
  }

  htmlOf(frameId: string): string | null {
    const row = this.ctx.storage.sql
      .exec<{ html: string }>("SELECT html FROM frames WHERE id = ?", frameId)
      .toArray()[0];
    return row === undefined ? null : row.html;
  }

  clear(): boolean {
    const had = this.read() !== null;
    this.ctx.storage.sql.exec("DELETE FROM frames");
    this.ctx.storage.sql.exec("DELETE FROM revisions");
    this.ctx.storage.sql.exec("DELETE FROM comments");
    this.ctx.storage.sql.exec("DELETE FROM meta");
    return had;
  }

  override async fetch(request: Request): Promise<Response> {
    const upgrade = request.headers.get("upgrade");
    if (upgrade !== null && upgrade.toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      if (client === undefined || server === undefined) return textError(500, "websocket pair was empty");
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    return textError(404, "canvas object has no such route");
  }
}

function registryStub(env: Env): DurableObjectStub<Registry> {
  return env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
}

function canvasStub(env: Env, slug: string): DurableObjectStub<Canvas> {
  return env.CANVAS.get(env.CANVAS.idFromName(slug));
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function newCanvasId(): string {
  return `c${randomHex(8)}`;
}

function newEditKey(): string {
  return `k${randomHex(16)}`;
}

function newFrameId(): string {
  return `frm_${randomHex(6)}`;
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const EDIT_KEY_RE = /^k[0-9a-f]{32}$/;

async function canvasIdForKey(env: Env, editKey: string): Promise<string | null> {
  if (!EDIT_KEY_RE.test(editKey)) return null;
  return registryStub(env).canvasForKey(await sha256(editKey));
}

async function mintCanvas(env: Env, origin: string, name = "canvas"): Promise<{
  canvasId: string;
  editKey: string;
  sessionId: string;
  viewUrl: string;
  mcpUrl: string;
}> {
  const canvasId = newCanvasId();
  const editKey = newEditKey();
  const sessionId = `s${randomHex(16)}`;
  await canvasStub(env, canvasId).ensure(canvasId, name);
  const registry = registryStub(env);
  await registry.bind(await sha256(editKey), canvasId);
  await registry.upsert({ id: canvasId, name, updatedAt: Date.now(), frameCount: 0 });
  await registry.saveSession(sessionId, canvasId, editKey);
  return {
    canvasId,
    editKey,
    sessionId,
    viewUrl: `${origin}/c/${canvasId}`,
    mcpUrl: `${origin}/mcp/${editKey}`,
  };
}

function withSession(response: Response, sessionId: string): Response {
  const headers = new Headers(response.headers);
  headers.set("mcp-session-id", sessionId);
  return new Response(response.body, { status: response.status, headers });
}

async function handleColdMcp(request: Request, env: Env, origin: string): Promise<Response> {
  const header = request.headers.get("mcp-session-id");
  if (header !== null && header !== "") {
    const saved = await registryStub(env).loadSession(header);
    if (saved === null) return textError(401, "unknown mcp session. connect to /mcp again to get a new anonymous canvas.");
    const response = await handleMcp(
      request,
      canvasStub(env, saved.canvasId),
      saved.canvasId,
      `${origin}/c/${saved.canvasId}`,
      `${origin}/mcp/${saved.editKey}`,
    );
    return withSession(response, header);
  }
  const minted = await mintCanvas(env, origin);
  const response = await handleMcp(
    request,
    canvasStub(env, minted.canvasId),
    minted.canvasId,
    minted.viewUrl,
    minted.mcpUrl,
  );
  return withSession(response, minted.sessionId);
}

function bearerKey(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null || !header.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length);
}

function publicUrls(request: Request, id: string, editKey: string): { url: string; mcp: string } {
  const origin = new URL(request.url).origin;
  return {
    url: `${origin}/c/${id}`,
    mcp: `${origin}/mcp/${editKey}`,
  };
}

const STATIC_PATHS = new Set(["/style.css", "/dist/canvas.js", "/icon.svg"]);

async function staticAsset(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== "GET" || !STATIC_PATHS.has(url.pathname)) return null;
  return env.ASSETS.fetch(request);
}

async function canvasPage(request: Request, env: Env, slug: string): Promise<Response> {
  const file = await env.ASSETS.fetch(new Request(new URL("/index.html", request.url)));
  if (!file.ok) return textError(500, "canvas ui is missing from the worker assets. run bun run build:web before deploy.");
  const html = publishedCanvasHtml(await file.text(), slug);
  return new Response(html, { headers: CANVAS_HEADERS });
}
function listHtml(canvases: Array<{ id: string; name: string; frameCount: number }>): string {
  const items = canvases
    .map(
      (canvas) =>
        `<li><a href="/c/${canvas.id}">${canvas.name.replace(/[&<>]/g, (ch) => (ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : "&gt;"))}</a> <span>${canvas.frameCount}</span></li>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>tracepaper</title>
<style>
  body { margin: 40px auto; max-width: 36rem; background: #f4f1ea; color: #1c1915; font: 16px/1.45 ui-sans-serif, system-ui, sans-serif; }
  a { color: inherit; }
  li { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #d9d2c5; }
  span { color: #6d645b; }
</style>
<h1>canvases</h1>
${items.length > 0 ? `<ul>${items}</ul>` : "<p>nothing published.</p>"}
`;
}

const CANVAS_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy":
    "frame-ancestors 'none'; default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'self'; img-src 'self' data:; font-src 'self' data:",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
};

const APP_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy":
    "frame-ancestors 'none'; default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-src 'self'; img-src 'self' data:",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
};

const FRAME_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy":
    "sandbox allow-scripts allow-forms; default-src 'none'; img-src data: blob: https:; media-src data: blob: https:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'; base-uri 'none'; frame-ancestors 'self'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
};

async function route(request: Request, env: Env): Promise<Response> {
  const asset = await staticAsset(request, env);
  if (asset !== null) return asset;

  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter((part) => part.length > 0);

  if (request.method === "GET" && parts.length === 0) {
    const canvases = await registryStub(env).list();
    return new Response(listHtml(canvases), { headers: APP_HEADERS });
  }

  if (parts[0] === "api" && parts[1] === "health" && parts.length === 2 && request.method === "GET") {
    return json({ ok: true, service: "tracepaper" });
  }

  if (parts[0] === "api" && parts[1] === "canvases" && parts.length === 2 && request.method === "GET") {
    return json({ canvases: await registryStub(env).list() });
  }

  if (parts[0] === "mcp" && parts.length === 2) {
    const editKey = parts[1] ?? "";
    const canvasId = await canvasIdForKey(env, editKey);
    if (canvasId === null) return textError(401, "unknown edit key");
    const origin = url.origin;
    return handleMcp(request, canvasStub(env, canvasId), canvasId, `${origin}/c/${canvasId}`, `${origin}/mcp/${editKey}`);
  }

  if (parts[0] === "mcp" && parts.length === 1) {
    return handleColdMcp(request, env, url.origin);
  }

  if (parts[0] === "api" && parts[1] === "canvases" && parts.length === 2 && request.method === "POST") {
    const raw = await request.text();
    let name = "canvas";
    if (raw.trim() !== "") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return textError(400, "create body is not json");
      }
      if (parsed !== null && typeof parsed === "object" && "name" in parsed && typeof parsed.name === "string" && parsed.name.trim() !== "") {
        name = parsed.name;
      }
    }
    const id = newCanvasId();
    const editKey = newEditKey();
    await canvasStub(env, id).ensure(id, name);
    await registryStub(env).bind(await sha256(editKey), id);
    await registryStub(env).upsert({ id, name, updatedAt: Date.now(), frameCount: 0 });
    return json({ id, editKey, ...publicUrls(request, id, editKey) }, 201);
  }

  if (parts[0] === "api" && parts[1] === "canvases" && parts.length === 3) {
    const slug = parseSlug(parts[2] ?? "");
    if (request.method === "GET") {
      const canvas = await canvasStub(env, slug).read();
      if (canvas === null) return textError(404, `unknown canvas: ${slug}`);
      return json(canvas);
    }
    if (request.method === "POST" || request.method === "PUT") {
      const editKey = bearerKey(request);
      if (editKey === null) return textError(401, "missing edit key");
      const owner = await canvasIdForKey(env, editKey);
      if (owner !== slug) return textError(401, "edit key does not own this canvas");
      const body = parsePublish(await request.text());
      const saved = await canvasStub(env, slug).snapshot(slug, body);
      await registryStub(env).upsert({
        id: slug,
        name: body.name,
        updatedAt: saved.updatedAt,
        frameCount: body.frames.length,
      });
      return json({ id: slug, name: body.name, version: saved.version, frames: body.frames.length, ...publicUrls(request, slug, editKey) });
    }
    if (request.method === "DELETE") {
      const editKey = bearerKey(request);
      if (editKey === null) return textError(401, "missing edit key");
      const owner = await canvasIdForKey(env, editKey);
      if (owner !== slug) return textError(401, "edit key does not own this canvas");
      const had = await canvasStub(env, slug).clear();
      await registryStub(env).remove(slug);
      if (!had) return textError(404, `unknown canvas: ${slug}`);
      return json({ id: slug, deleted: true });
    }
  }

  if (parts[0] === "c" && parts.length >= 2) {
    const slug = parseSlug(parts[1] ?? "");
    if (parts.length === 2 && request.method === "GET") {
      const canvas = await canvasStub(env, slug).read();
      if (canvas === null) return textError(404, `unknown canvas: ${slug}`);
      return canvasPage(request, env, slug);
    }
    if (parts[2] === "f" && parts.length === 4 && request.method === "GET") {
      const frameId = parts[3] ?? "";
      if (!FRAME_ID_RE.test(frameId)) return textError(400, `bad frame id: ${frameId}`);
      const frame = await canvasStub(env, slug).raw(frameId);
      if (frame === null) return textError(404, `unknown frame: ${frameId}`);
      return new Response(frame.html, { headers: FRAME_HEADERS });
    }
    if (parts[2] === "live" && parts.length === 3 && request.method === "GET") {
      return canvasStub(env, slug).fetch(request);
    }
  }

  return textError(404, `no route ${request.method} ${url.pathname}`);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = error instanceof PublishError ? 400 : 500;
      return textError(status, message);
    }
  },
};
