import { DurableObject } from "cloudflare:workers";
import { bearerMatches, parsePublish, parseSlug, PublishError, type PublishBody, type PublishFrame } from "./validate.ts";

interface Env {
  CANVAS: DurableObjectNamespace<Canvas>;
  REGISTRY: DurableObjectNamespace<Registry>;
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

function requirePublish(request: Request, env: Env): Response | null {
  if (env.PUBLISH_TOKEN === undefined || env.PUBLISH_TOKEN === "") {
    return textError(501, "PUBLISH_TOKEN is not set. writes are refused until wrangler secret put PUBLISH_TOKEN.");
  }
  if (!bearerMatches(request.headers.get("authorization"), env.PUBLISH_TOKEN)) {
    return textError(401, "missing or wrong bearer token");
  }
  return null;
}

function viewerHtml(slug: string): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${slug}</title>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: #f4f1ea; color: #1c1915; font: 14px/1.4 ui-sans-serif, system-ui, sans-serif; }
  #stage { position: fixed; inset: 0; overflow: hidden; touch-action: none; cursor: grab; background-color: #f4f1ea; background-image: linear-gradient(90deg, #e4ddd2 1px, transparent 1px), linear-gradient(#e4ddd2 1px, transparent 1px); }
  #stage.is-panning { cursor: grabbing; }
  #bar { position: absolute; z-index: 2; top: 10px; left: 10px; display: flex; gap: 12px; align-items: baseline; padding: 6px 10px; background: #f4f1eacc; border-radius: 8px; }
  #world { position: absolute; top: 0; left: 0; width: 0; height: 0; transform-origin: 0 0; }
  .frame { position: absolute; background: white; box-shadow: 0 1px 0 rgba(0,0,0,.08); }
  iframe { border: 0; width: 100%; height: 100%; background: white; pointer-events: none; }
  .text { display: flex; align-items: center; padding: 0 8px; background: transparent; }
  .section { border: 1px dashed #8a8175; background: transparent; }
  .section span { position: absolute; top: -18px; left: 0; font-size: 12px; color: #6d645b; }
</style>
<div id="stage">
  <div id="bar"><strong id="title"></strong><span id="meta"></span></div>
  <div id="world"></div>
</div>
<script>
const slug = ${JSON.stringify(slug)};
const stage = document.getElementById("stage");
const world = document.getElementById("world");
const title = document.getElementById("title");
const meta = document.getElementById("meta");
const view = { x: 40, y: 48, scale: 1 };
let version = 0;
let frames = [];

function paint() {
  world.style.transform = "translate(" + view.x + "px," + view.y + "px) scale(" + view.scale + ")";
  let cell = 48 * view.scale;
  while (cell < 16) cell *= 4;
  while (cell > 160) cell /= 4;
  const origin = Math.round(view.x) + "px " + Math.round(view.y) + "px";
  stage.style.backgroundSize = cell + "px " + cell + "px, " + cell + "px " + cell + "px";
  stage.style.backgroundPosition = origin + ", " + origin;
  meta.textContent = frames.length + " frames · v" + version + " · " + Math.round(view.scale * 100) + "%";
}

function fit() {
  if (frames.length === 0) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const frame of frames) {
    minX = Math.min(minX, frame.x);
    minY = Math.min(minY, frame.y);
    maxX = Math.max(maxX, frame.x + frame.width);
    maxY = Math.max(maxY, frame.y + frame.height);
  }
  const pad = 80;
  const scale = Math.min(
    (stage.clientWidth - pad * 2) / Math.max(1, maxX - minX),
    (stage.clientHeight - pad * 2) / Math.max(1, maxY - minY),
    1,
  );
  view.scale = Math.max(0.08, scale);
  view.x = stage.clientWidth / 2 - ((minX + maxX) / 2) * view.scale;
  view.y = stage.clientHeight / 2 - ((minY + maxY) / 2) * view.scale;
  paint();
}

function place(canvas) {
  title.textContent = canvas.name;
  version = canvas.version;
  frames = canvas.frames;
  world.replaceChildren();
  for (const frame of frames) {
    const box = document.createElement("div");
    box.className = "frame " + frame.kind;
    box.style.left = frame.x + "px";
    box.style.top = frame.y + "px";
    box.style.width = frame.width + "px";
    box.style.height = frame.height + "px";
    if (frame.kind === "html") {
      const iframe = document.createElement("iframe");
      iframe.setAttribute("sandbox", "allow-scripts allow-forms");
      iframe.referrerPolicy = "no-referrer";
      iframe.src = "/c/" + slug + "/f/" + frame.id + "?v=" + frame.version;
      box.append(iframe);
    } else if (frame.kind === "text") {
      box.classList.add("text");
      box.style.fontSize = (frame.fontSize || 32) + "px";
      box.textContent = frame.name;
    } else {
      const label = document.createElement("span");
      label.textContent = frame.name;
      box.append(label);
    }
    world.append(box);
  }
  fit();
}

stage.addEventListener("wheel", (event) => {
  event.preventDefault();
  if (event.ctrlKey || event.metaKey) {
    const next = Math.min(2.5, Math.max(0.08, view.scale * Math.exp(-event.deltaY * 0.01)));
    const rect = stage.getBoundingClientRect();
    const ax = event.clientX - rect.left;
    const ay = event.clientY - rect.top;
    const wx = (ax - view.x) / view.scale;
    const wy = (ay - view.y) / view.scale;
    view.scale = next;
    view.x = ax - wx * next;
    view.y = ay - wy * next;
  } else {
    view.x -= event.deltaX;
    view.y -= event.deltaY;
  }
  paint();
}, { passive: false });

let drag = null;
stage.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  drag = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y };
  stage.classList.add("is-panning");
  stage.setPointerCapture(event.pointerId);
});
stage.addEventListener("pointermove", (event) => {
  if (drag === null) return;
  view.x = drag.vx + event.clientX - drag.x;
  view.y = drag.vy + event.clientY - drag.y;
  paint();
});
stage.addEventListener("pointerup", () => {
  drag = null;
  stage.classList.remove("is-panning");
});
window.addEventListener("keydown", (event) => {
  if (event.key === "0") fit();
});

async function load() {
  const res = await fetch("/api/canvases/" + slug);
  if (!res.ok) {
    title.textContent = slug;
    meta.textContent = res.status + " " + (await res.text());
    return;
  }
  place(await res.json());
}

function live() {
  const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/c/" + slug + "/live");
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.version !== version) load();
  };
  ws.onclose = () => setTimeout(live, 2000);
}
load();
live();
</script>
`;
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

  if (parts[0] === "api" && parts[1] === "canvases" && parts.length === 3) {
    const slug = parseSlug(parts[2] ?? "");
    if (request.method === "GET") {
      const canvas = await canvasStub(env, slug).read();
      if (canvas === null) return textError(404, `unknown canvas: ${slug}`);
      return json(canvas);
    }
    if (request.method === "PUT") {
      const denied = requirePublish(request, env);
      if (denied !== null) return denied;
      const body = parsePublish(await request.text());
      const saved = await canvasStub(env, slug).snapshot(slug, body);
      await registryStub(env).upsert({
        id: slug,
        name: body.name,
        updatedAt: saved.updatedAt,
        frameCount: body.frames.length,
      });
      return json({ id: slug, name: body.name, version: saved.version, frames: body.frames.length });
    }
    if (request.method === "DELETE") {
      const denied = requirePublish(request, env);
      if (denied !== null) return denied;
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
      return new Response(viewerHtml(slug), { headers: APP_HEADERS });
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
