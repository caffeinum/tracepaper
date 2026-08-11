/**
 * paper-mcp canvas.
 *
 * World model: every frame lives at an absolute (x, y) in *world* px. One CSS
 * transform on #world — `translate(view.x, view.y) scale(view.scale)` with
 * transform-origin 0 0 — maps world px to stage px. Every conversion in this
 * file goes through screenToWorld / worldToScreen so pan and zoom can never
 * drift apart.
 */

const MIN_SCALE = 0.05;
const MAX_SCALE = 4;
const GRID = 24;

// ---------------------------------------------------------------- boundary

/** Frame fields the canvas needs. Comment counts are derived locally. */
type CanvasFrame = {
  id: string;
  name: string;
  width: number;
  height: number;
  x: number;
  y: number;
  version: number;
};

type CanvasComment = {
  id: string;
  frameId: string;
  x: number;
  y: number;
  text: string;
  author: "human" | "agent";
  parentId: string | null;
  resolved: boolean;
  createdAt: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function preview(value: unknown): string {
  return JSON.stringify(value).slice(0, 200);
}

function str(source: Record<string, unknown>, key: string, what: string): string {
  const value = source[key];
  if (typeof value !== "string") throw new Error(`${what}.${key} must be a string, got ${preview(value)}`);
  return value;
}

function num(source: Record<string, unknown>, key: string, what: string): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${what}.${key} must be a finite number, got ${preview(value)}`);
  }
  return value;
}

function bool(source: Record<string, unknown>, key: string, what: string): boolean {
  const value = source[key];
  if (typeof value !== "boolean") throw new Error(`${what}.${key} must be a boolean, got ${preview(value)}`);
  return value;
}

function toFrame(raw: unknown): CanvasFrame {
  if (!isRecord(raw)) throw new Error(`frame must be an object, got ${preview(raw)}`);
  return {
    id: str(raw, "id", "frame"),
    name: str(raw, "name", "frame"),
    width: num(raw, "width", "frame"),
    height: num(raw, "height", "frame"),
    x: num(raw, "x", "frame"),
    y: num(raw, "y", "frame"),
    version: num(raw, "version", "frame"),
  };
}

function toComment(raw: unknown): CanvasComment {
  if (!isRecord(raw)) throw new Error(`comment must be an object, got ${preview(raw)}`);
  const author = str(raw, "author", "comment");
  if (author !== "human" && author !== "agent") {
    throw new Error(`comment.author must be "human" or "agent", got ${preview(author)}`);
  }
  const parentId = raw["parentId"];
  if (parentId !== null && typeof parentId !== "string") {
    throw new Error(`comment.parentId must be a string or null, got ${preview(parentId)}`);
  }
  return {
    id: str(raw, "id", "comment"),
    frameId: str(raw, "frameId", "comment"),
    x: num(raw, "x", "comment"),
    y: num(raw, "y", "comment"),
    text: str(raw, "text", "comment"),
    author,
    parentId,
    resolved: bool(raw, "resolved", "comment"),
    createdAt: str(raw, "createdAt", "comment"),
  };
}

/** Accepts `[...]` or `{ <key>: [...] }`; anything else throws. */
function toList(payload: unknown, key: string): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (isRecord(payload)) {
    const nested = payload[key];
    if (Array.isArray(nested)) return nested;
  }
  throw new Error(`GET expected an array or { ${key}: [] }, got ${preview(payload)}`);
}

/** Accepts the entity directly or wrapped as `{ <key>: entity }`. */
function unwrap(payload: unknown, key: string): unknown {
  if (isRecord(payload) && isRecord(payload[key])) return payload[key];
  return payload;
}

function idOf(payload: unknown, key: string): string {
  const entity = unwrap(payload, key);
  if (!isRecord(entity)) throw new Error(`event payload must be an object, got ${preview(payload)}`);
  return str(entity, "id", key);
}

async function api(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, init);
  const text = await response.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`${path} returned non-JSON (${response.status}): ${text.slice(0, 200)}`);
    }
  }
  if (!response.ok) {
    const detail = isRecord(body) && typeof body["error"] === "string" ? body["error"] : `HTTP ${response.status}`;
    throw new Error(`${path}: ${detail}`);
  }
  return body;
}

function postJson(path: string, body: unknown): Promise<unknown> {
  return api(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patchJson(path: string, body: unknown): Promise<unknown> {
  return api(path, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------- dom refs

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id} in index.html`);
  return node as T;
}

const app = el<HTMLDivElement>("app");
const stage = el<HTMLElement>("stage");
const viewport = el<HTMLDivElement>("viewport");
const world = el<HTMLDivElement>("world");
const layer = el<HTMLDivElement>("layer");
const toasts = el<HTMLDivElement>("toasts");
const emptyState = el<HTMLDivElement>("empty");
const commentList = el<HTMLDivElement>("comment-list");
const statFrames = el<HTMLSpanElement>("stat-frames");
const statOpen = el<HTMLSpanElement>("stat-open");
const conn = el<HTMLDivElement>("conn");
const toolComment = el<HTMLButtonElement>("tool-comment");
const toolZoomLevel = el<HTMLButtonElement>("tool-zoom-level");

// ---------------------------------------------------------------- state

const frames = new Map<string, CanvasFrame>();
const frameOrder: string[] = [];
const comments = new Map<string, CanvasComment>();

const view = { x: 0, y: 0, scale: 1 };

let mode: "idle" | "comment" = "idle";
let interactiveFrameId: string | null = null;
let spaceHeld = false;
let hasFitted = false;

function orderedFrames(): CanvasFrame[] {
  const list: CanvasFrame[] = [];
  for (const id of frameOrder) {
    const frame = frames.get(id);
    if (frame) list.push(frame);
  }
  return list;
}

function putFrame(frame: CanvasFrame): void {
  if (!frames.has(frame.id)) frameOrder.push(frame.id);
  frames.set(frame.id, frame);
}

function dropFrame(id: string): void {
  frames.delete(id);
  const at = frameOrder.indexOf(id);
  if (at >= 0) frameOrder.splice(at, 1);
  for (const comment of [...comments.values()]) {
    if (comment.frameId === id) comments.delete(comment.id);
  }
}

function dropComment(id: string): void {
  comments.delete(id);
  for (const comment of [...comments.values()]) {
    if (comment.parentId === id) comments.delete(comment.id);
  }
}

function rootComments(frameId: string): CanvasComment[] {
  return [...comments.values()]
    .filter((c) => c.frameId === frameId && c.parentId === null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

function repliesTo(rootId: string): CanvasComment[] {
  return [...comments.values()]
    .filter((c) => c.parentId === rootId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

function pinNumbers(frameId: string): Map<string, number> {
  const numbers = new Map<string, number>();
  rootComments(frameId).forEach((comment, index) => numbers.set(comment.id, index + 1));
  return numbers;
}

// ---------------------------------------------------------------- transform

type Point = { x: number; y: number };

function stagePoint(event: { clientX: number; clientY: number }): Point {
  const rect = viewport.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function screenToWorld(point: Point): Point {
  return { x: (point.x - view.x) / view.scale, y: (point.y - view.y) / view.scale };
}

function worldToScreen(wx: number, wy: number): Point {
  return { x: wx * view.scale + view.x, y: wy * view.scale + view.y };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function applyView(): void {
  world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  world.style.setProperty("--inv", String(1 / view.scale));

  let cell = GRID * view.scale;
  while (cell < 14) cell *= 4;
  while (cell > 96) cell /= 4;
  viewport.style.backgroundSize = `${cell}px ${cell}px`;
  viewport.style.backgroundPosition = `${view.x}px ${view.y}px`;

  toolZoomLevel.textContent = `${Math.round(view.scale * 100)}%`;
  positionPanel();
}

/** Zoom about a stage-space anchor so the world point under it stays put. */
function zoomAt(anchor: Point, factor: number): void {
  const next = clamp(view.scale * factor, MIN_SCALE, MAX_SCALE);
  if (next === view.scale) return;
  const before = screenToWorld(anchor);
  view.scale = next;
  view.x = anchor.x - before.x * next;
  view.y = anchor.y - before.y * next;
  applyView();
}

function stageSize(): { width: number; height: number } {
  const rect = viewport.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}

function resetZoom(): void {
  const { width, height } = stageSize();
  zoomAt({ x: width / 2, y: height / 2 }, 1 / view.scale);
}

function zoomToFit(): void {
  const list = orderedFrames();
  const { width, height } = stageSize();
  if (list.length === 0) {
    view.scale = 1;
    view.x = width / 2;
    view.y = height / 2;
    applyView();
    return;
  }
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const frame of list) {
    left = Math.min(left, frame.x);
    top = Math.min(top, frame.y);
    right = Math.max(right, frame.x + frame.width);
    bottom = Math.max(bottom, frame.y + frame.height);
  }
  const pad = 72;
  const scale = clamp(
    Math.min((width - pad * 2) / (right - left), (height - pad * 2) / (bottom - top)),
    MIN_SCALE,
    1.5,
  );
  view.scale = scale;
  view.x = width / 2 - ((left + right) / 2) * scale;
  view.y = height / 2 - ((top + bottom) / 2) * scale;
  applyView();
}

let tween = 0;

function panTo(worldX: number, worldY: number, scale: number): void {
  const { width, height } = stageSize();
  const from = { ...view };
  const to = {
    scale,
    x: width / 2 - worldX * scale,
    y: height / 2 - worldY * scale,
  };
  const start = performance.now();
  const duration = 320;
  cancelAnimationFrame(tween);
  const step = (now: number): void => {
    const t = clamp((now - start) / duration, 0, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    view.scale = from.scale + (to.scale - from.scale) * eased;
    view.x = from.x + (to.x - from.x) * eased;
    view.y = from.y + (to.y - from.y) * eased;
    applyView();
    if (t < 1) tween = requestAnimationFrame(step);
  };
  tween = requestAnimationFrame(step);
}

// ---------------------------------------------------------------- toasts

function toast(message: string, kind: "info" | "error"): void {
  const node = document.createElement("div");
  node.className = kind === "error" ? "toast is-error" : "toast";
  node.textContent = message;
  toasts.appendChild(node);
  setTimeout(() => node.remove(), kind === "error" ? 7000 : 2600);
}

function fail(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error("[canvas]", error);
  toast(message, "error");
}

// ---------------------------------------------------------------- frames

type FrameNode = {
  root: HTMLDivElement;
  name: HTMLSpanElement;
  dims: HTMLSpanElement;
  body: HTMLDivElement;
  iframe: HTMLIFrameElement;
  pins: HTMLDivElement;
  version: number;
};

const frameNodes = new Map<string, FrameNode>();

function buildFrame(frame: CanvasFrame): FrameNode {
  const root = document.createElement("div");
  root.className = "frame";
  root.dataset["frameId"] = frame.id;

  const label = document.createElement("div");
  label.className = "frame-label";
  const name = document.createElement("span");
  name.className = "frame-name";
  const dims = document.createElement("span");
  dims.className = "frame-dims";
  const kill = document.createElement("button");
  kill.className = "frame-kill";
  kill.type = "button";
  kill.title = "Delete frame";
  kill.textContent = "✕";
  kill.addEventListener("click", () => {
    if (!window.confirm(`Delete "${frame.name}" and its comments?`)) return;
    api(`/api/frames/${frame.id}`, { method: "DELETE" })
      .then(() => {
        dropFrame(frame.id);
        closePanel();
        renderAll();
      })
      .catch(fail);
  });
  label.append(name, dims, kill);

  const body = document.createElement("div");
  body.className = "frame-body";

  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts allow-forms allow-popups");
  iframe.setAttribute("loading", "eager");
  iframe.title = frame.name;

  const catcher = document.createElement("div");
  catcher.className = "frame-catch";
  catcher.addEventListener("click", (event) => {
    if (mode !== "comment") return;
    const current = frames.get(frame.id);
    if (!current) throw new Error(`click on a frame that is no longer in state: ${frame.id}`);
    const point = screenToWorld(stagePoint(event));
    openComposer(current.id, point.x - current.x, point.y - current.y);
    setMode("idle");
  });
  catcher.addEventListener("dblclick", () => {
    if (mode === "comment") return;
    setInteractive(frame.id);
  });

  const pins = document.createElement("div");
  pins.className = "pins";

  const hint = document.createElement("div");
  hint.className = "frame-hint";
  hint.textContent = "interactive — esc to leave";

  body.append(iframe, catcher, pins);
  root.append(label, body, hint);
  return { root, name, dims, body, iframe, pins, version: -1 };
}

function renderFrames(): void {
  const seen = new Set<string>();
  for (const frame of orderedFrames()) {
    seen.add(frame.id);
    let node = frameNodes.get(frame.id);
    if (!node) {
      node = buildFrame(frame);
      frameNodes.set(frame.id, node);
      world.appendChild(node.root);
    }
    node.root.style.transform = `translate(${frame.x}px, ${frame.y}px)`;
    node.body.style.width = `${frame.width}px`;
    node.body.style.height = `${frame.height}px`;
    node.name.textContent = frame.name;
    node.dims.textContent = `${Math.round(frame.width)} × ${Math.round(frame.height)}`;
    node.root.classList.toggle("is-interactive", interactiveFrameId === frame.id);
    if (node.version !== frame.version) {
      node.version = frame.version;
      node.iframe.src = `/f/${frame.id}?v=${frame.version}`;
    }
  }
  for (const [id, node] of [...frameNodes]) {
    if (seen.has(id)) continue;
    node.root.remove();
    frameNodes.delete(id);
  }
  emptyState.hidden = frames.size > 0;
}

// ---------------------------------------------------------------- pins

let ghost: { frameId: string; x: number; y: number } | null = null;
let openThreadId: string | null = null;

function makePin(frameLocalX: number, frameLocalY: number): HTMLDivElement {
  const anchor = document.createElement("div");
  anchor.className = "pin-anchor";
  anchor.style.left = `${frameLocalX}px`;
  anchor.style.top = `${frameLocalY}px`;
  return anchor;
}

function renderPins(): void {
  for (const frame of orderedFrames()) {
    const node = frameNodes.get(frame.id);
    if (!node) continue;
    node.pins.replaceChildren();
    const numbers = pinNumbers(frame.id);
    for (const comment of rootComments(frame.id)) {
      const number = numbers.get(comment.id);
      if (number === undefined) throw new Error(`no pin number for ${comment.id}`);
      const anchor = makePin(comment.x, comment.y);
      const pin = document.createElement("button");
      pin.type = "button";
      pin.className = "pin";
      pin.classList.toggle("is-resolved", comment.resolved);
      pin.classList.toggle("is-open", openThreadId === comment.id);
      pin.textContent = String(number);
      pin.title = comment.text;
      const replyCount = repliesTo(comment.id).length;
      if (replyCount > 0) {
        const badge = document.createElement("span");
        badge.className = "pin-replies";
        badge.textContent = String(replyCount);
        pin.appendChild(badge);
      }
      pin.addEventListener("click", (event) => {
        event.stopPropagation();
        openThread(comment.id);
      });
      anchor.appendChild(pin);
      node.pins.appendChild(anchor);
    }
    if (ghost && ghost.frameId === frame.id) {
      const anchor = makePin(ghost.x, ghost.y);
      const pin = document.createElement("div");
      pin.className = "pin is-ghost";
      pin.textContent = String(rootComments(frame.id).length + 1);
      anchor.appendChild(pin);
      node.pins.appendChild(anchor);
    }
  }
}

// ---------------------------------------------------------------- panel

type Panel = {
  root: HTMLDivElement;
  frameId: string;
  localX: number;
  localY: number;
  refresh: (() => void) | null;
};

let panel: Panel | null = null;

function closePanel(): void {
  if (panel) panel.root.remove();
  panel = null;
  ghost = null;
  openThreadId = null;
  renderPins();
  renderSidebar();
}

function positionPanel(): void {
  if (!panel) return;
  const frame = frames.get(panel.frameId);
  if (!frame) {
    closePanel();
    return;
  }
  const anchor = worldToScreen(frame.x + panel.localX, frame.y + panel.localY);
  const { width, height } = stageSize();
  const w = panel.root.offsetWidth;
  const h = panel.root.offsetHeight;
  panel.root.style.left = `${clamp(anchor.x + 22, 12, Math.max(12, width - w - 12))}px`;
  panel.root.style.top = `${clamp(anchor.y - 10, 12, Math.max(12, height - h - 12))}px`;
}

function composerBox(placeholder: string, submit: (text: string) => void): {
  wrap: HTMLDivElement;
  input: HTMLTextAreaElement;
} {
  const wrap = document.createElement("div");
  wrap.className = "panel-foot";
  const input = document.createElement("textarea");
  input.className = "composer";
  input.placeholder = placeholder;
  input.rows = 3;
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit(input.value);
    }
  });
  wrap.appendChild(input);
  return { wrap, input };
}

function openComposer(frameId: string, localX: number, localY: number): void {
  const frame = frames.get(frameId);
  if (!frame) throw new Error(`unknown frame: ${frameId}`);
  closePanel();

  const x = clamp(localX, 0, frame.width);
  const y = clamp(localY, 0, frame.height);
  ghost = { frameId, x, y };

  const root = document.createElement("div");
  root.className = "panel";

  const send = (text: string): void => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    postJson("/api/comments", { frameId, x, y, text: trimmed, author: "human" })
      .then((payload) => {
        const created = toComment(unwrap(payload, "comment"));
        comments.set(created.id, created);
        closePanel();
        renderAll();
      })
      .catch(fail);
  };

  const { wrap, input } = composerBox("Leave a comment for the agent…", send);
  const actions = document.createElement("div");
  actions.className = "panel-actions";
  const hint = document.createElement("span");
  hint.className = "hint";
  hint.textContent = "⏎ post · ⇧⏎ newline";
  const spacer = document.createElement("span");
  spacer.className = "spacer";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn quiet";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => closePanel());
  const post = document.createElement("button");
  post.type = "button";
  post.className = "btn primary";
  post.textContent = "Comment";
  post.addEventListener("click", () => send(input.value));
  actions.append(hint, spacer, cancel, post);
  wrap.appendChild(actions);
  root.appendChild(wrap);

  layer.appendChild(root);
  panel = { root, frameId, localX: x, localY: y, refresh: null };
  positionPanel();
  renderPins();
  input.focus();
}

function messageNode(comment: CanvasComment, isReply: boolean): HTMLDivElement {
  const node = document.createElement("div");
  node.className = "msg";
  if (isReply) node.classList.add("is-reply");
  if (comment.author === "agent") node.classList.add("from-agent");
  if (comment.resolved) node.classList.add("is-resolved");

  const head = document.createElement("div");
  head.className = "msg-head";
  const who = document.createElement("span");
  who.className = "msg-who";
  who.textContent = comment.author === "agent" ? "agent" : "you";
  const when = document.createElement("span");
  when.textContent = timeAgo(comment.createdAt);
  head.append(who, when);
  if (comment.resolved && !isReply) {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = "resolved";
    head.appendChild(tag);
  }

  const text = document.createElement("div");
  text.className = "msg-text";
  text.textContent = comment.text;

  node.append(head, text);
  return node;
}

function openThread(rootId: string): void {
  const rootComment = comments.get(rootId);
  if (!rootComment) throw new Error(`unknown comment: ${rootId}`);
  const frame = frames.get(rootComment.frameId);
  if (!frame) throw new Error(`comment ${rootId} points at unknown frame ${rootComment.frameId}`);
  closePanel();
  openThreadId = rootId;

  const root = document.createElement("div");
  root.className = "panel";

  const scroll = document.createElement("div");
  scroll.className = "panel-scroll";

  const sendReply = (text: string): void => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    postJson("/api/comments", {
      frameId: rootComment.frameId,
      x: rootComment.x,
      y: rootComment.y,
      text: trimmed,
      parentId: rootId,
      author: "human",
    })
      .then((payload) => {
        const created = toComment(unwrap(payload, "comment"));
        comments.set(created.id, created);
        input.value = "";
        renderAll();
      })
      .catch(fail);
  };

  const { wrap, input } = composerBox("Reply…", sendReply);

  const actions = document.createElement("div");
  actions.className = "panel-actions";
  const resolve = document.createElement("button");
  resolve.type = "button";
  resolve.className = "btn";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "btn quiet danger";
  remove.textContent = "Delete";
  remove.addEventListener("click", () => {
    api(`/api/comments/${rootId}`, { method: "DELETE" })
      .then(() => {
        dropComment(rootId);
        closePanel();
        renderAll();
      })
      .catch(fail);
  });
  const spacer = document.createElement("span");
  spacer.className = "spacer";
  const reply = document.createElement("button");
  reply.type = "button";
  reply.className = "btn primary";
  reply.textContent = "Reply";
  reply.addEventListener("click", () => sendReply(input.value));
  actions.append(resolve, remove, spacer, reply);
  wrap.appendChild(actions);

  resolve.addEventListener("click", () => {
    const current = comments.get(rootId);
    if (!current) throw new Error(`unknown comment: ${rootId}`);
    patchJson(`/api/comments/${rootId}`, { resolved: !current.resolved })
      .then((payload) => {
        const updated = toComment(unwrap(payload, "comment"));
        comments.set(updated.id, updated);
        renderAll();
      })
      .catch(fail);
  });

  const refresh = (): void => {
    const current = comments.get(rootId);
    if (!current) {
      closePanel();
      return;
    }
    scroll.replaceChildren(messageNode(current, false));
    for (const child of repliesTo(rootId)) scroll.appendChild(messageNode(child, true));
    resolve.textContent = current.resolved ? "Reopen" : "Resolve";
    positionPanel();
  };

  root.append(scroll, wrap);
  layer.appendChild(root);
  panel = { root, frameId: rootComment.frameId, localX: rootComment.x, localY: rootComment.y, refresh };
  refresh();
  positionPanel();
  renderPins();
  renderSidebar();
}

// ---------------------------------------------------------------- sidebar

function timeAgo(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) throw new Error(`comment.createdAt is not a parseable date: ${iso}`);
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function renderSidebar(): void {
  commentList.replaceChildren();
  let open = 0;
  let total = 0;

  for (const frame of orderedFrames()) {
    const roots = rootComments(frame.id);
    const numbers = pinNumbers(frame.id);
    total += roots.length;
    const unresolved = roots.filter((c) => !c.resolved);
    open += unresolved.length;
    if (roots.length === 0) continue;

    const head = document.createElement("div");
    head.className = "group-head";
    const label = document.createElement("b");
    label.textContent = frame.name;
    const count = document.createElement("span");
    count.textContent = `${unresolved.length}/${roots.length}`;
    head.append(label, count);
    commentList.appendChild(head);

    const ordered = [...unresolved, ...roots.filter((c) => c.resolved)];
    for (const comment of ordered) {
      const number = numbers.get(comment.id);
      if (number === undefined) throw new Error(`no pin number for ${comment.id}`);
      const entry = document.createElement("button");
      entry.type = "button";
      entry.className = "entry";
      entry.classList.toggle("is-resolved", comment.resolved);
      entry.classList.toggle("is-active", openThreadId === comment.id);

      const badge = document.createElement("span");
      badge.className = "entry-num";
      badge.textContent = String(number);

      const body = document.createElement("div");
      body.className = "entry-body";
      const text = document.createElement("div");
      text.className = "entry-text";
      text.textContent = comment.text;
      const meta = document.createElement("div");
      meta.className = "entry-meta";
      meta.append(document.createTextNode(timeAgo(comment.createdAt)));

      const replies = repliesTo(comment.id);
      if (replies.length > 0) {
        const tag = document.createElement("span");
        tag.className = "tag";
        tag.textContent = `${replies.length} ${replies.length === 1 ? "reply" : "replies"}`;
        meta.appendChild(tag);
      }
      if (replies.some((r) => r.author === "agent") || comment.author === "agent") {
        const tag = document.createElement("span");
        tag.className = "tag agent";
        tag.textContent = "agent";
        meta.appendChild(tag);
      }

      body.append(text, meta);
      entry.append(badge, body);
      entry.addEventListener("click", () => {
        const target = frames.get(comment.frameId);
        if (!target) throw new Error(`unknown frame: ${comment.frameId}`);
        panTo(target.x + comment.x, target.y + comment.y, Math.max(view.scale, 0.7));
        openThread(comment.id);
      });
      commentList.appendChild(entry);
    }
  }

  if (total === 0) {
    const note = document.createElement("div");
    note.className = "sidebar-empty";
    note.textContent =
      frames.size === 0
        ? "No frames yet. Comments show up here once an agent pushes one."
        : "No comments yet. Press c, then click a frame.";
    commentList.appendChild(note);
  }

  statFrames.textContent = `${frames.size} ${frames.size === 1 ? "frame" : "frames"}`;
  statOpen.textContent = `${open} open`;
}

function renderAll(): void {
  renderFrames();
  renderPins();
  renderSidebar();
  if (panel && panel.refresh) panel.refresh();
  positionPanel();
}

// ---------------------------------------------------------------- modes

function setMode(next: "idle" | "comment"): void {
  mode = next;
  stage.dataset["mode"] = next;
  toolComment.setAttribute("aria-pressed", String(next === "comment"));
  updateCursor();
}

function setInteractive(frameId: string | null): void {
  interactiveFrameId = frameId;
  for (const [id, node] of frameNodes) node.root.classList.toggle("is-interactive", id === frameId);
}

function updateCursor(): void {
  if (mode === "comment") {
    stage.dataset["cursor"] = "comment";
    return;
  }
  stage.dataset["cursor"] = panning ? "grabbing" : "grab";
}

// ---------------------------------------------------------------- gestures

let panning = false;
let panPointer = -1;
let panStart = { x: 0, y: 0, viewX: 0, viewY: 0 };

const IGNORE_PAN = ".panel, .toolbar, .sidebar, .empty-card, .pin, .frame-kill";

stage.addEventListener("pointerdown", (event) => {
  const target = event.target;
  if (target instanceof Element && target.closest(IGNORE_PAN)) return;
  const frameEl = target instanceof Element ? target.closest(".frame-catch")?.closest(".frame") : null;
  const onFrame = frameEl instanceof HTMLElement;
  const middle = event.button === 1;
  const left = event.button === 0;
  if (!middle && !left) return;
  if (left && mode === "comment" && onFrame) return;
  if (left && !spaceHeld && onFrame && frameEl.dataset["frameId"] === interactiveFrameId) return;

  panning = true;
  panPointer = event.pointerId;
  panStart = { x: event.clientX, y: event.clientY, viewX: view.x, viewY: view.y };
  stage.setPointerCapture(event.pointerId);
  updateCursor();
  event.preventDefault();
});

stage.addEventListener("pointermove", (event) => {
  if (!panning || event.pointerId !== panPointer) return;
  view.x = panStart.viewX + (event.clientX - panStart.x);
  view.y = panStart.viewY + (event.clientY - panStart.y);
  applyView();
});

function endPan(event: PointerEvent): void {
  if (!panning || event.pointerId !== panPointer) return;
  panning = false;
  panPointer = -1;
  if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
  updateCursor();
}

stage.addEventListener("pointerup", endPan);
stage.addEventListener("pointercancel", endPan);

viewport.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    // A trackpad pinch arrives as a wheel event with ctrlKey set.
    if (event.ctrlKey || event.metaKey) {
      zoomAt(stagePoint(event), clamp(Math.exp(-event.deltaY * 0.01), 0.5, 2));
      return;
    }
    view.x -= event.deltaX;
    view.y -= event.deltaY;
    applyView();
  },
  { passive: false },
);

stage.addEventListener("pointerdown", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest(".panel") !== null || target.closest(".pin") !== null) return;
  if (panel) closePanel();
  const frameEl = target.closest(".frame");
  if (interactiveFrameId !== null && (!(frameEl instanceof HTMLElement) || frameEl.dataset["frameId"] !== interactiveFrameId)) {
    setInteractive(null);
  }
});

function typingInField(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement;
}

window.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "0") {
    event.preventDefault();
    resetZoom();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key === "1") {
    event.preventDefault();
    zoomToFit();
    return;
  }
  if (event.key === "Escape") {
    if (panel) closePanel();
    else if (mode === "comment") setMode("idle");
    else if (interactiveFrameId !== null) setInteractive(null);
    return;
  }
  if (typingInField() || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === "c" || event.key === "C") {
    event.preventDefault();
    setInteractive(null);
    setMode(mode === "comment" ? "idle" : "comment");
    return;
  }
  if (event.key === "b" || event.key === "B") {
    event.preventDefault();
    app.dataset["sidebar"] = app.dataset["sidebar"] === "hidden" ? "shown" : "hidden";
    return;
  }
  if (event.key === " ") {
    spaceHeld = true;
    event.preventDefault();
  }
});

window.addEventListener("keyup", (event) => {
  if (event.key === " ") spaceHeld = false;
});

window.addEventListener("blur", () => {
  spaceHeld = false;
});

window.addEventListener("resize", () => positionPanel());

toolComment.addEventListener("click", () => {
  setInteractive(null);
  setMode(mode === "comment" ? "idle" : "comment");
});
el<HTMLButtonElement>("tool-zoom-in").addEventListener("click", () => {
  const { width, height } = stageSize();
  zoomAt({ x: width / 2, y: height / 2 }, 1.25);
});
el<HTMLButtonElement>("tool-zoom-out").addEventListener("click", () => {
  const { width, height } = stageSize();
  zoomAt({ x: width / 2, y: height / 2 }, 0.8);
});
toolZoomLevel.addEventListener("click", () => resetZoom());
el<HTMLButtonElement>("tool-fit").addEventListener("click", () => zoomToFit());

// ---------------------------------------------------------------- empty state

const MCP_CONFIG = `{
  "mcpServers": {
    "paper-mcp": {
      "command": "bunx",
      "args": ["paper-mcp"]
    }
  }
}`;

el<HTMLPreElement>("config-snippet").textContent = MCP_CONFIG;
el<HTMLElement>("cli-snippet").textContent = "claude mcp add paper-mcp -- bunx paper-mcp";
el<HTMLButtonElement>("copy-config").addEventListener("click", (event) => {
  const button = event.currentTarget;
  navigator.clipboard
    .writeText(MCP_CONFIG)
    .then(() => {
      if (button instanceof HTMLButtonElement) {
        button.textContent = "Copied";
        setTimeout(() => (button.textContent = "Copy"), 1400);
      }
    })
    .catch(fail);
});

// ---------------------------------------------------------------- data + sse

async function loadAll(): Promise<void> {
  const [framePayload, commentPayload] = await Promise.all([
    api("/api/frames"),
    api("/api/comments?includeResolved=true"),
  ]);
  frames.clear();
  frameOrder.length = 0;
  comments.clear();
  for (const raw of toList(framePayload, "frames")) putFrame(toFrame(raw));
  for (const raw of toList(commentPayload, "comments")) {
    const comment = toComment(raw);
    comments.set(comment.id, comment);
  }
  renderAll();
  if (!hasFitted && frames.size > 0) {
    hasFitted = true;
    zoomToFit();
  }
}

function setConn(state: "connecting" | "live" | "down"): void {
  conn.dataset["state"] = state;
  const label = conn.querySelector(".conn-label");
  if (label) label.textContent = state === "live" ? "live" : state === "down" ? "reconnecting" : "connecting";
}

/**
 * SSE is the fast path, but the event bus lives in one process while the db is shared, so a write
 * made by an agent attached to a *different* process never reaches this stream. A slow refetch
 * makes the canvas self-heal in that topology instead of sitting silently stale forever.
 */
const RECONCILE_MS = 5000;

function reconcile(): void {
  setInterval(() => {
    if (document.hidden) return;
    loadAll().catch(fail);
  }, RECONCILE_MS);
}

function subscribe(): void {
  const source = new EventSource("/api/events");
  let wasDown = false;

  source.addEventListener("open", () => {
    setConn("live");
    if (wasDown) {
      wasDown = false;
      loadAll().catch(fail);
    }
  });

  source.addEventListener("error", () => {
    wasDown = true;
    setConn("down");
  });

  const handle = (name: string, run: (payload: unknown) => void) => {
    source.addEventListener(name, (event) => {
      const message = event as MessageEvent<string>;
      try {
        run(JSON.parse(message.data));
      } catch (error) {
        fail(new Error(`SSE ${name}: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  };

  handle("frame.created", (payload) => {
    putFrame(toFrame(unwrap(payload, "frame")));
    renderAll();
    if (!hasFitted) {
      hasFitted = true;
      zoomToFit();
    }
  });

  handle("frame.updated", (payload) => {
    putFrame(toFrame(unwrap(payload, "frame")));
    renderAll();
  });

  handle("frame.deleted", (payload) => {
    dropFrame(idOf(payload, "frame"));
    if (panel && !frames.has(panel.frameId)) closePanel();
    renderAll();
  });

  handle("comment.created", (payload) => {
    const comment = toComment(unwrap(payload, "comment"));
    comments.set(comment.id, comment);
    renderAll();
  });

  handle("comment.updated", (payload) => {
    const comment = toComment(unwrap(payload, "comment"));
    comments.set(comment.id, comment);
    renderAll();
  });

  handle("comment.deleted", (payload) => {
    const id = idOf(payload, "comment");
    if (openThreadId === id) closePanel();
    dropComment(id);
    renderAll();
  });
}

window.addEventListener("error", (event) => {
  console.error("[canvas] uncaught", event.error);
});

setMode("idle");
applyView();
renderSidebar();
zoomToFit();
loadAll().catch(fail);
subscribe();
reconcile();
