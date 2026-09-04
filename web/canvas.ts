/**
 * tracepaper canvas.
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
  /** The canvas/scope this frame belongs to; used by the repo switcher and SSE filtering. */
  repo: string;
  /** Who pushed the frame, shown as attribution in the "All canvases" view. Null when unknown. */
  createdBy: string | null;
  /** "html" (iframe), "text" (title block) or "section" (outlined region). */
  kind: "html" | "text" | "section";
  /** World-px font size; only used by kind "text". Null otherwise. */
  fontSize: number | null;
};

/** One canvas the switcher can offer, with its frame count. */
type RepoInfo = { repo: string; frameCount: number };

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

function strOrNull(source: Record<string, unknown>, key: string, what: string): string | null {
  const value = source[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error(`${what}.${key} must be a string or null, got ${preview(value)}`);
  return value;
}

function numOrNull(source: Record<string, unknown>, key: string, what: string): number | null {
  const value = source[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${what}.${key} must be a finite number or null, got ${preview(value)}`);
  }
  return value;
}

function toFrame(raw: unknown): CanvasFrame {
  if (!isRecord(raw)) throw new Error(`frame must be an object, got ${preview(raw)}`);
  const kind = str(raw, "kind", "frame");
  if (kind !== "html" && kind !== "text" && kind !== "section") {
    throw new Error(`frame.kind must be "html", "text" or "section", got ${preview(kind)}`);
  }
  return {
    id: str(raw, "id", "frame"),
    name: str(raw, "name", "frame"),
    width: num(raw, "width", "frame"),
    height: num(raw, "height", "frame"),
    x: num(raw, "x", "frame"),
    y: num(raw, "y", "frame"),
    version: num(raw, "version", "frame"),
    repo: str(raw, "repo", "frame"),
    createdBy: strOrNull(raw, "createdBy", "frame"),
    kind,
    fontSize: numOrNull(raw, "fontSize", "frame"),
  };
}

function toRepo(raw: unknown): RepoInfo {
  if (!isRecord(raw)) throw new Error(`repo must be an object, got ${preview(raw)}`);
  return { repo: str(raw, "repo", "repo"), frameCount: num(raw, "frameCount", "repo") };
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

/**
 * The server refuses any write without this header — a cross-document request cannot set one,
 * which is what stops a sandboxed frame (or any page the human is visiting) from posting
 * comments as the human. See guardMutation in src/http.ts.
 */
const WRITE_HEADERS = { "content-type": "application/json", "x-tracepaper": "1" };

function postJson(path: string, body: unknown): Promise<unknown> {
  return api(path, { method: "POST", headers: WRITE_HEADERS, body: JSON.stringify(body) });
}

function patchJson(path: string, body: unknown): Promise<unknown> {
  return api(path, { method: "PATCH", headers: WRITE_HEADERS, body: JSON.stringify(body) });
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
const statOpen = el<HTMLSpanElement>("stat-open");
const toolSelect = el<HTMLButtonElement>("tool-select");
const toolPan = el<HTMLButtonElement>("tool-pan");
const toolComment = el<HTMLButtonElement>("tool-comment");
const toolComments = el<HTMLButtonElement>("tool-comments");
const commentsBadge = el<HTMLSpanElement>("tool-comments-badge");
const sidebar = el<HTMLElement>("sidebar");
const sidebarClose = el<HTMLButtonElement>("sidebar-close");
const toolZoomLevel = el<HTMLButtonElement>("tool-zoom-level");
const toolShare = el<HTMLButtonElement>("tool-share");
const toolShareLabel = el<HTMLSpanElement>("tool-share-label");
const sharePanel = el<HTMLElement>("share");
const shareBody = el<HTMLDivElement>("share-body");
const shareClose = el<HTMLButtonElement>("share-close");
const themeToggle = el<HTMLButtonElement>("theme-toggle");
const repoSwitcher = el<HTMLSelectElement>("repo-switcher");

// ---------------------------------------------------------------- state

const frames = new Map<string, CanvasFrame>();
const frameOrder: string[] = [];
const comments = new Map<string, CanvasComment>();

/**
 * Where each frame's content is scrolled, in content px, as reported by the frame's bridge
 * (see ESCAPE_BRIDGE in src/http.ts). Comment x/y are stored as CONTENT coords, so a pin renders
 * at frame-local `(x − scroll.x, y − scroll.y)`. A frame that has never reported defaults to
 * {0,0}: existing comments were placed at scroll 0, so their stored coords already ARE content
 * coords and render exactly where they always have — no migration needed.
 */
const frameScroll = new Map<string, Point>();

function frameScrollOf(frameId: string): Point {
  return frameScroll.get(frameId) ?? { x: 0, y: 0 };
}

const view = { x: 0, y: 0, scale: 1 };

/**
 * The active tool. "select" is the default (click to pick a frame, drag empty space to pan);
 * "pan" is the hand tool (drag anywhere pans); "comment" drops pins. Holding space is a temporary
 * pan from any tool. Escape returns to select.
 */
type Tool = "select" | "pan" | "comment";
let tool: Tool = "select";
let interactiveFrameId: string | null = null;
let selectedFrameId: string | null = null;
let spaceHeld = false;
let hasFitted = false;
/**
 * The canvas currently in view. null means "All canvases" — every repo's frames unfiltered.
 * It rides in the URL query (?repo=…) so a canvas is linkable, and every data fetch and SSE
 * update is scoped through it so a filtered view stays filtered.
 */
let currentRepo: string | null = null;
// ⌘0 alternates between framing the selection and the whole canvas; this holds which comes next.
let cmd0FitsAll = false;

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
  frameScroll.delete(id);
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
  const major = cell * 4;
  // Four blueprint layers (minor-V, minor-H, major-V, major-H) share one origin so the grid stays
  // registered to the world under pan and zoom.
  const origin = `${view.x}px ${view.y}px`;
  viewport.style.backgroundSize = `${cell}px ${cell}px, ${cell}px ${cell}px, ${major}px ${major}px, ${major}px ${major}px`;
  viewport.style.backgroundPosition = `${origin}, ${origin}, ${origin}, ${origin}`;

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

type Box = { left: number; top: number; right: number; bottom: number };

function boundsOf(list: CanvasFrame[]): Box | null {
  if (list.length === 0) return null;
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const frame of list) {
    left = Math.min(left, frame.x);
    top = Math.min(top, frame.y);
    right = Math.max(right, frame.x + frame.width);
    bottom = Math.max(bottom, frame.y + frame.height);
  }
  return { left, top, right, bottom };
}

/** Frames a world-space box in the viewport. `max` caps the zoom so one small frame does not balloon. */
function fitBox(box: Box, max = 1.5, animate = false): void {
  const { width, height } = stageSize();
  const pad = 72;
  const scale = clamp(
    Math.min((width - pad * 2) / (box.right - box.left), (height - pad * 2) / (box.bottom - box.top)),
    MIN_SCALE,
    max,
  );
  const cx = (box.left + box.right) / 2;
  const cy = (box.top + box.bottom) / 2;
  if (animate) {
    panTo(cx, cy, scale);
    return;
  }
  view.scale = scale;
  view.x = width / 2 - cx * scale;
  view.y = height / 2 - cy * scale;
  applyView();
}

function zoomToFit(): void {
  const box = boundsOf(orderedFrames());
  if (box === null) {
    const { width, height } = stageSize();
    view.scale = 1;
    view.x = width / 2;
    view.y = height / 2;
    applyView();
    return;
  }
  fitBox(box);
}

/** Fills the viewport with one frame — what you want when you step into it to actually use it. */
function fitFrame(frameId: string, animate = true): void {
  const frame = frames.get(frameId);
  if (!frame) throw new Error(`cannot fit unknown frame: ${frameId}`);
  fitBox(
    { left: frame.x, top: frame.y, right: frame.x + frame.width, bottom: frame.y + frame.height },
    2,
    animate,
  );
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

// ---- hand-drawn frame outlines --------------------------------------------
// Each frame wears a wobbly outline drawn as a real SVG <path> — the wobble is baked into the
// coordinates (rough.js style: two overlapping jittered strokes), not a filter, so it renders the
// same everywhere and reads clearly at any zoom. A paper-filled pass behind the iframe covers any
// grid that would otherwise show through the ragged edge; the stroke passes sit on top.

const SVG_NS = "http://www.w3.org/2000/svg";
// Padding around the body so an outward wobble peak has room in the SVG viewBox.
const SKETCH_PAD = 8;
// Calm amplitude — the user rejected rougher edges.
const SKETCH_AMP = 2;

/** Deterministic PRNG so a given seed always draws the same wobble. */
function sketchRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/** A closed path tracing a w×h rectangle, each perimeter sample nudged by ±amp. */
function roughRectPath(w: number, h: number, amp: number, seed: number): string {
  const r = sketchRng(seed);
  const j = (): number => (r() * 2 - 1) * amp;
  const pts: Array<[number, number]> = [];
  const step = 26;
  for (let x = 0; x <= w; x += step) pts.push([x + j(), j()]);
  for (let y = step; y <= h; y += step) pts.push([w + j(), y + j()]);
  for (let x = w - step; x >= 0; x -= step) pts.push([x + j(), h + j()]);
  for (let y = h - step; y >= step; y -= step) pts.push([j(), y + j()]);
  return "M" + pts.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" L ") + " Z";
}

/** Stable 32-bit hash of a frame id, so a frame's wobble never reshuffles between renders. */
function hashId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function makeSvg(cls: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", cls);
  return svg;
}

function makePath(): SVGPathElement {
  return document.createElementNS(SVG_NS, "path");
}

/** The hand-drawn outline layers, shared by html frames and sections. */
type SketchParts = {
  sketchSeed: number;
  sketchFill: SVGSVGElement;
  sketch: SVGSVGElement;
  sketchFillPath: SVGPathElement;
  sketchInk1: SVGPathElement;
  sketchInk2: SVGPathElement;
  sketchW: number;
  sketchH: number;
};

/** Builds the two SVG passes (paper fill behind, ink edge on top) for a wobbly outline. */
function buildSketch(seed: number): SketchParts {
  const sketchFill = makeSvg("frame-sketch-fill");
  const sketchFillPath = makePath();
  sketchFill.appendChild(sketchFillPath);

  const sketch = makeSvg("frame-sketch");
  const sketchInk1 = makePath();
  sketchInk1.setAttribute("class", "ink-1");
  const sketchInk2 = makePath();
  sketchInk2.setAttribute("class", "ink-2");
  sketch.append(sketchInk1, sketchInk2);

  return { sketchSeed: seed, sketchFill, sketch, sketchFillPath, sketchInk1, sketchInk2, sketchW: -1, sketchH: -1 };
}

/** (Re)draw an outline for its current size and return the fill path `d` (used to clip the iframe).
 *  Seed is derived from the id, so the shape is stable across redraws and only changes with size. */
function paintSketch(parts: SketchParts, w: number, h: number): string {
  const seed = parts.sketchSeed;
  const p1 = roughRectPath(w, h, SKETCH_AMP, seed);
  const p2 = roughRectPath(w, h, SKETCH_AMP, seed + 101);
  const vw = w + SKETCH_PAD * 2;
  const vh = h + SKETCH_PAD * 2;
  const viewBox = `${-SKETCH_PAD} ${-SKETCH_PAD} ${vw} ${vh}`;
  for (const svg of [parts.sketchFill, parts.sketch]) {
    svg.setAttribute("width", String(vw));
    svg.setAttribute("height", String(vh));
    svg.setAttribute("viewBox", viewBox);
  }
  // Behind the body: paper (html) / faint tint (section) fills the wobbly interior.
  parts.sketchFillPath.setAttribute("d", p1);
  // On top: the visible hand-drawn edge — one firm pass plus a fainter overlapping pass.
  parts.sketchInk1.setAttribute("d", p1);
  parts.sketchInk2.setAttribute("d", p2);
  parts.sketchW = w;
  parts.sketchH = h;
  return p1;
}

/** An iframe frame (kind "html") — the original card with sketch outline, label, pins and comments. */
type HtmlFrameNode = SketchParts & {
  kind: "html";
  root: HTMLDivElement;
  name: HTMLSpanElement;
  dims: HTMLSpanElement;
  by: HTMLSpanElement;
  body: HTMLDivElement;
  iframe: HTMLIFrameElement;
  pins: HTMLDivElement;
  version: number;
};

/** A title/label block (kind "text") — bare handwritten text drawn on the world, no box or chrome. */
type TextFrameNode = {
  kind: "text";
  root: HTMLDivElement;
  text: HTMLDivElement;
};

/** A named outlined region (kind "section") — a hand-drawn box behind frames, with a label. */
type SectionFrameNode = SketchParts & {
  kind: "section";
  root: HTMLDivElement;
  body: HTMLDivElement;
  label: HTMLSpanElement;
};

type FrameNode = HtmlFrameNode | TextFrameNode | SectionFrameNode;

const frameNodes = new Map<string, FrameNode>();

function buildFrame(frame: CanvasFrame): FrameNode {
  if (frame.kind === "text") return buildTextFrame(frame);
  if (frame.kind === "section") return buildSectionFrame(frame);
  return buildHtmlFrame(frame);
}

function buildHtmlFrame(frame: CanvasFrame): HtmlFrameNode {
  const root = document.createElement("div");
  root.className = "frame";
  root.dataset["frameId"] = frame.id;

  const label = document.createElement("div");
  label.className = "frame-label";
  const name = document.createElement("span");
  name.className = "frame-name";
  const dims = document.createElement("span");
  dims.className = "frame-dims";
  // Attribution — who pushed the frame. Only shown in the "All canvases" view; see renderFrames.
  const by = document.createElement("span");
  by.className = "frame-by";
  by.hidden = true;
  makeDraggable(name, frame.id);
  const kill = document.createElement("button");
  kill.className = "frame-kill";
  kill.type = "button";
  kill.title = "Delete frame";
  kill.textContent = "✕";
  kill.addEventListener("click", () => requestDeleteFrame(frame.id));
  label.append(name, dims, by, kill);

  const body = document.createElement("div");
  body.className = "frame-body";

  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts allow-forms allow-popups");
  iframe.setAttribute("loading", "eager");
  iframe.title = frame.name;

  const catcher = document.createElement("div");
  catcher.className = "frame-catch";
  catcher.addEventListener("click", (event) => {
    if (tool !== "comment") return;
    const current = frames.get(frame.id);
    if (!current) throw new Error(`click on a frame that is no longer in state: ${frame.id}`);
    const point = screenToWorld(stagePoint(event));
    // The click is a frame-local position; add the frame's current scroll so the pin is stored
    // against the CONTENT under the cursor, not the frame window.
    const scroll = frameScrollOf(current.id);
    openComposer(current.id, point.x - current.x + scroll.x, point.y - current.y + scroll.y);
    setTool("select");
  });
  catcher.addEventListener("click", () => {
    // Only the select tool picks frames; the pan tool leaves selection alone, comment drops a pin.
    if (tool !== "select") return;
    setSelected(frame.id);
  });
  catcher.addEventListener("dblclick", () => {
    if (tool !== "select") return;
    setInteractive(frame.id);
  });

  // Two SVG passes for the hand-drawn edge. The fill pass sits behind the iframe (paper backing so
  // the ragged edge shows no grid); the ink pass sits above it. Stroke colour comes from CSS
  // (--sketch-ink) so selection/interactive state can recolour it to the accent.
  const parts = buildSketch(hashId(frame.id));

  const pins = document.createElement("div");
  pins.className = "pins";

  // Clickable, not just a label: once you click inside the frame the focus is in a sandboxed
  // iframe of another origin, so `esc` never reaches this page. Without a button here the only
  // way out is clicking the canvas, which is not discoverable.
  const hint = document.createElement("button");
  hint.type = "button";
  hint.className = "frame-hint";
  hint.textContent = "interactive — click here or press esc to leave";
  hint.addEventListener("click", () => setInteractive(null));

  // sketchFill behind the iframe (paper), sketch (ink) above it; catcher and pins keep their order
  // above so clicks and pins stay on top. The sketch SVGs are pointer-events:none via CSS.
  body.append(parts.sketchFill, iframe, parts.sketch, catcher, pins);
  root.append(label, body, hint);
  const node: HtmlFrameNode = { kind: "html", root, name, dims, by, body, iframe, pins, version: -1, ...parts };
  // Clip the iframe to the wobbly outline so its straight edges never poke past the drawn line.
  const p1 = paintSketch(node, frame.width, frame.height);
  node.iframe.style.clipPath = `path('${p1}')`;
  return node;
}

function buildTextFrame(frame: CanvasFrame): TextFrameNode {
  const root = document.createElement("div");
  root.className = "frame frame-text";
  root.dataset["frameId"] = frame.id;

  const text = document.createElement("div");
  text.className = "text-block";
  // The whole block is the drag handle: pointerdown selects it and a drag moves it (makeDraggable).
  makeDraggable(text, frame.id);

  root.appendChild(text);
  return { kind: "text", root, text };
}

function buildSectionFrame(frame: CanvasFrame): SectionFrameNode {
  const root = document.createElement("div");
  root.className = "frame frame-section";
  root.dataset["frameId"] = frame.id;

  const body = document.createElement("div");
  body.className = "section-body";
  // The interior is click-through so frames inside the region stay interactive; see CSS.

  const parts = buildSketch(hashId(frame.id));
  body.append(parts.sketchFill, parts.sketch);

  const label = document.createElement("span");
  label.className = "section-label";
  // The label is the only interactive part: it selects and drags the section.
  makeDraggable(label, frame.id);

  root.append(body, label);
  const node: SectionFrameNode = { kind: "section", root, body, label, ...parts };
  paintSketch(node, frame.width, frame.height);
  return node;
}

function renderFrames(): void {
  const seen = new Set<string>();
  for (const frame of orderedFrames()) {
    seen.add(frame.id);
    let node = frameNodes.get(frame.id);
    // Kind never changes for an existing frame, but rebuild defensively if it somehow does.
    if (node && node.kind !== frame.kind) {
      node.root.remove();
      frameNodes.delete(frame.id);
      node = undefined;
    }
    if (!node) {
      node = buildFrame(frame);
      frameNodes.set(frame.id, node);
      world.appendChild(node.root);
    }
    node.root.style.transform = `translate(${frame.x}px, ${frame.y}px)`;

    if (node.kind === "text") {
      node.text.textContent = frame.name;
      // fontSize is world px: the text lives inside #world, so it scales with zoom like frames.
      node.text.style.fontSize = `${frame.fontSize ?? 32}px`;
      continue;
    }
    if (node.kind === "section") {
      node.body.style.width = `${frame.width}px`;
      node.body.style.height = `${frame.height}px`;
      if (node.sketchW !== frame.width || node.sketchH !== frame.height) {
        paintSketch(node, frame.width, frame.height);
      }
      node.label.textContent = frame.name;
      continue;
    }

    node.body.style.width = `${frame.width}px`;
    node.body.style.height = `${frame.height}px`;
    // The wobbly outline is baked for a specific size, so redraw it only when the size changes.
    if (node.sketchW !== frame.width || node.sketchH !== frame.height) {
      const p1 = paintSketch(node, frame.width, frame.height);
      node.iframe.style.clipPath = `path('${p1}')`;
    }
    node.name.textContent = frame.name;
    node.dims.textContent = `${Math.round(frame.width)} × ${Math.round(frame.height)}`;
    // Attribution is redundant once you have filtered to one canvas, so it only shows in All view.
    const showBy = currentRepo === null && frame.createdBy !== null;
    node.by.textContent = showBy ? (frame.createdBy ?? "") : "";
    node.by.hidden = !showBy;
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

/**
 * Drag a frame's title to move the frame. The title is the handle rather than the frame body
 * because the body is an iframe the human may want to click into — and because the label is
 * the one part of a frame that is unambiguously chrome.
 *
 * The move is applied to the DOM as you drag and written once on release, so a drag is one
 * request rather than one per pointer event.
 */
function makeDraggable(handle: HTMLElement, frameId: string): void {
  handle.classList.add("is-handle");
  handle.addEventListener("pointerdown", (event) => {
    // Dragging a title moves the frame only with the select tool; otherwise let the press fall
    // through to the stage so the pan/hand tool (or held space) pans instead.
    if (event.button !== 0 || tool !== "select" || spaceHeld) return;
    const frame = frames.get(frameId);
    if (!frame) throw new Error(`drag started on an unknown frame: ${frameId}`);
    event.preventDefault();
    event.stopPropagation(); // the stage would otherwise start panning

    const node = frameNodes.get(frameId);
    if (!node) throw new Error(`drag started on a frame with no node: ${frameId}`);
    setSelected(frameId);

    const startWorld = screenToWorld(stagePoint(event));
    const origin = { x: frame.x, y: frame.y };
    let next = origin;
    handle.setPointerCapture(event.pointerId);

    const onMove = (move: PointerEvent): void => {
      const world = screenToWorld(stagePoint(move));
      next = {
        x: Math.round(origin.x + (world.x - startWorld.x)),
        y: Math.round(origin.y + (world.y - startWorld.y)),
      };
      node.root.style.transform = `translate(${next.x}px, ${next.y}px)`;
    };

    const onUp = (): void => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      if (next.x === origin.x && next.y === origin.y) return;

      // Optimistic locally, then persisted; a failure snaps back rather than lying.
      putFrame({ ...frame, x: next.x, y: next.y });
      renderAll();
      patchJson(`/api/frames/${frameId}`, next).catch((error: unknown) => {
        putFrame({ ...frame, x: origin.x, y: origin.y });
        renderAll();
        fail(error instanceof Error ? error : new Error(String(error)));
      });
    };

    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  });
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

// A few px of slack so a pin sitting exactly on the frame edge is not clipped away.
const PIN_MARGIN = 6;

/** A frame-local point is visible when it lands within the frame window (plus a small margin). */
function localVisible(frame: CanvasFrame, localX: number, localY: number): boolean {
  return (
    localX >= -PIN_MARGIN &&
    localY >= -PIN_MARGIN &&
    localX <= frame.width + PIN_MARGIN &&
    localY <= frame.height + PIN_MARGIN
  );
}

function renderPins(): void {
  for (const frame of orderedFrames()) {
    const node = frameNodes.get(frame.id);
    // Only html frames carry pins/comments; text and section blocks have none.
    if (!node || node.kind !== "html") continue;
    node.pins.replaceChildren();
    // Pins are stored in content coords; render them at frame-local = content − scroll so they
    // ride the content as it scrolls, and hide the ones that have scrolled out of the window.
    const scroll = frameScrollOf(frame.id);
    const numbers = pinNumbers(frame.id);
    for (const comment of rootComments(frame.id)) {
      const number = numbers.get(comment.id);
      if (number === undefined) throw new Error(`no pin number for ${comment.id}`);
      const localX = comment.x - scroll.x;
      const localY = comment.y - scroll.y;
      const anchor = makePin(localX, localY);
      anchor.hidden = !localVisible(frame, localX, localY);
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
      const anchor = makePin(ghost.x - scroll.x, ghost.y - scroll.y);
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
  // panel.localX/localY are content coords (they anchor on a comment/ghost pin), so subtract the
  // frame's scroll to get the frame-local point before mapping through the world transform. If the
  // anchor has scrolled out of the window the panel just clamps to the viewport edge below.
  const scroll = frameScrollOf(panel.frameId);
  const anchor = worldToScreen(frame.x + panel.localX - scroll.x, frame.y + panel.localY - scroll.y);
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

function openComposer(frameId: string, contentX: number, contentY: number): void {
  const frame = frames.get(frameId);
  if (!frame) throw new Error(`unknown frame: ${frameId}`);
  closePanel();

  // contentX/contentY are content coords. The click lands inside the frame window, so clamp to the
  // content span the window currently shows — [scroll, scroll + size] — not to [0, size].
  const scroll = frameScrollOf(frameId);
  const x = clamp(contentX, scroll.x, scroll.x + frame.width);
  const y = clamp(contentY, scroll.y, scroll.y + frame.height);
  ghost = { frameId, x, y };

  const root = document.createElement("div");
  root.className = "panel";

  const send = (text: string): void => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    // `author` is not sent: this route is the browser's, so the server stamps "human" itself.
    postJson("/api/comments", { frameId, x, y, text: trimmed })
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
    api(`/api/comments/${rootId}`, { method: "DELETE", headers: WRITE_HEADERS })
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
        // comment.x/y are content coords; pan to where the pin currently sits (content − scroll).
        const scroll = frameScrollOf(comment.frameId);
        panTo(target.x + comment.x - scroll.x, target.y + comment.y - scroll.y, Math.max(view.scale, 0.7));
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

  statOpen.textContent = `${open} open`;

  // The list is closed by default, so the badge is the only thing telling you there is
  // feedback waiting behind it.
  commentsBadge.textContent = String(open);
  commentsBadge.hidden = open === 0;
}

// `HTMLElement.hidden` is boolean | "until-found", so the open state is tracked here rather
// than read back off the DOM.
let commentListOpen = false;

function setCommentList(open: boolean): void {
  commentListOpen = open;
  sidebar.hidden = !open;
  toolComments.setAttribute("aria-pressed", String(open));
}

function toggleCommentList(): void {
  setCommentList(!commentListOpen);
}

function renderAll(): void {
  renderFrames();
  renderPins();
  renderSidebar();
  if (panel && panel.refresh) panel.refresh();
  positionPanel();
}

// ---------------------------------------------------------------- modes

function setTool(next: Tool): void {
  tool = next;
  stage.dataset["tool"] = next;
  toolSelect.setAttribute("aria-pressed", String(next === "select"));
  toolPan.setAttribute("aria-pressed", String(next === "pan"));
  toolComment.setAttribute("aria-pressed", String(next === "comment"));
  updateCursor();
}

function setInteractive(frameId: string | null): void {
  interactiveFrameId = frameId;
  for (const [id, node] of frameNodes) node.root.classList.toggle("is-interactive", id === frameId);
  // Stepping into a frame means you want to use the page, so give it the whole viewport.
  if (frameId !== null) {
    setSelected(frameId);
    fitFrame(frameId);
  }
}

function setSelected(frameId: string | null): void {
  const changed = frameId !== selectedFrameId;
  selectedFrameId = frameId;
  // A new selection restarts the ⌘0 toggle at "fit this frame", so the first press after picking
  // a frame always frames it rather than pulling back to the whole canvas.
  if (changed) cmd0FitsAll = false;
  for (const [id, node] of frameNodes) node.root.classList.toggle("is-selected", id === frameId);
  writeFrameHash(frameId);
}

/**
 * The address bar follows the selection, so "copy the URL" is the share gesture and needs no
 * button. replaceState rather than a hash assignment: selecting frames should not fill up the
 * back button with canvas states.
 */
function writeFrameHash(frameId: string | null): void {
  const next = frameId === null ? "" : `#frame=${frameId}`;
  if (window.location.hash === next) return;
  history.replaceState(null, "", `${window.location.pathname}${window.location.search}${next}`);
}

/**
 * `#frame=frm_…` is a VIEW HINT, not a permission boundary — it opens the canvas zoomed to one
 * frame, and everything else is still there to scroll to. Anyone with the link sees the whole
 * canvas either way.
 */
function frameFromHash(): string | null {
  const match = /^#frame=(frm_[0-9a-f]{12})$/.exec(window.location.hash);
  return match === null ? null : match[1] ?? null;
}

/** Returns true when a hinted frame existed and was framed, so the caller can skip zoom-to-fit. */
function applyFrameHash(animate = false): boolean {
  const wanted = frameFromHash();
  if (wanted === null || !frames.has(wanted)) return false;
  setSelected(wanted);
  fitFrame(wanted, animate);
  return true;
}

// ---------------------------------------------------------------- repo switcher

/** The canvas named in the URL query, or null for "All canvases". */
function repoFromQuery(): string | null {
  const value = new URLSearchParams(window.location.search).get("repo");
  return value === null || value === "" ? null : value;
}

/**
 * The address bar carries the current canvas as `?repo=…`, so a filtered view is linkable.
 * replaceState (not a navigation) and the existing `#frame=` hash is preserved untouched — repo
 * is the query, frame is the hash, and the two never clobber each other.
 */
function writeRepoQuery(repo: string | null): void {
  const search = repo === null ? "" : `?repo=${encodeURIComponent(repo)}`;
  history.replaceState(null, "", `${window.location.pathname}${search}${window.location.hash}`);
}

/** Rebuilds the switcher's options, preserving the current selection even if its repo is now empty. */
function renderRepoSwitcher(repos: RepoInfo[]): void {
  const selected = currentRepo;
  repoSwitcher.replaceChildren();

  const all = document.createElement("option");
  all.value = "";
  all.textContent = "All canvases";
  repoSwitcher.appendChild(all);

  for (const info of repos) {
    const option = document.createElement("option");
    option.value = info.repo;
    option.textContent = `${info.repo} · ${info.frameCount}`;
    repoSwitcher.appendChild(option);
  }
  // Keep the current selection selectable even when its canvas has just gone empty (0 frames drop
  // it from listRepos), so the view does not silently snap back to "All".
  if (selected !== null && !repos.some((info) => info.repo === selected)) {
    const option = document.createElement("option");
    option.value = selected;
    option.textContent = `${selected} · 0`;
    repoSwitcher.appendChild(option);
  }
  repoSwitcher.value = selected ?? "";
}

/**
 * Switch canvases: reset the selection/interaction that belonged to the old canvas, point the URL
 * at the new one, then refetch + re-render + re-fit so the view lands on the newly chosen canvas.
 */
async function setRepo(next: string | null): Promise<void> {
  if (next === currentRepo) return;
  currentRepo = next;
  setSelected(null);
  setInteractive(null);
  closePanel();
  writeRepoQuery(next);
  hasFitted = false; // loadAll re-fits the fresh canvas
  await loadAll();
}

repoSwitcher.addEventListener("change", () => {
  const value = repoSwitcher.value;
  void setRepo(value === "" ? null : value).catch(fail);
});

function updateCursor(): void {
  // Space (or the pan tool) means a hand; a live drag shows the closed hand. Otherwise the tool
  // decides: comment shows the pin, select shows the default arrow.
  if (spaceHeld || tool === "pan") {
    stage.dataset["cursor"] = panning ? "grabbing" : "grab";
    return;
  }
  if (panning) {
    stage.dataset["cursor"] = "grabbing";
    return;
  }
  stage.dataset["cursor"] = tool === "comment" ? "comment" : "select";
}

// ---------------------------------------------------------------- gestures

let panning = false;
let panPointer = -1;
let panStart = { x: 0, y: 0, viewX: 0, viewY: 0 };

const IGNORE_PAN = ".panel, .toolbar, .sidebar, .empty-card, .pin, .frame-kill";

/**
 * A press is only a pan once it has actually moved. Capturing the pointer on pointerdown
 * retargets every later pointer and mouse event to the stage, so `click` and `dblclick` never
 * reach the element under the cursor — which silently broke double-click-to-interact on a
 * frame. Waiting for real movement keeps the gesture and lets a stationary press stay a click.
 */
const PAN_THRESHOLD_PX = 4;
let pendingPan = false;

stage.addEventListener("pointerdown", (event) => {
  const target = event.target;
  if (target instanceof Element && target.closest(IGNORE_PAN)) return;
  const frameEl = target instanceof Element ? target.closest(".frame-catch")?.closest(".frame") : null;
  const onFrame = frameEl instanceof HTMLElement;
  const middle = event.button === 1;
  const left = event.button === 0;
  if (!middle && !left) return;
  // The pan tool and held space pan over anything, including frames. Otherwise a left press on a
  // frame belongs to that frame: comment mode drops a pin, and an interactive frame keeps its own
  // pointer events. A middle drag always pans.
  const panOverride = middle || tool === "pan" || spaceHeld;
  if (!panOverride) {
    if (left && tool === "comment" && onFrame) return;
    if (left && onFrame && frameEl.dataset["frameId"] === interactiveFrameId) return;
  }

  pendingPan = true;
  panPointer = event.pointerId;
  panStart = { x: event.clientX, y: event.clientY, viewX: view.x, viewY: view.y };
  // A pan gesture (hand tool, held space, or middle-drag) has no click semantics to protect, so
  // suppress the default — otherwise the drag starts a text selection that highlights frame
  // content as you pan. A select-tool drag is left alone so click-to-select still works.
  if (panOverride) event.preventDefault();
});

stage.addEventListener("pointermove", (event) => {
  if (event.pointerId !== panPointer) return;

  if (pendingPan && !panning) {
    const moved = Math.hypot(event.clientX - panStart.x, event.clientY - panStart.y);
    if (moved < PAN_THRESHOLD_PX) return;
    panning = true;
    stage.setPointerCapture(event.pointerId);
    updateCursor();
  }
  if (!panning) return;

  view.x = panStart.viewX + (event.clientX - panStart.x);
  view.y = panStart.viewY + (event.clientY - panStart.y);
  applyView();
});

function endPan(event: PointerEvent): void {
  if (event.pointerId !== panPointer) return;
  pendingPan = false;
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

// A trackpad pinch (ctrl+wheel) must zoom the CANVAS, never the browser page — even when the
// pointer is over the toolbar, the chip, or the sidebar rather than the viewport. Caught at the
// window in the capture phase so it beats every other handler and the page can never zoom out from
// under the canvas (which blows up the grid and constant-size labels and pushes the toolbar off).
window.addEventListener(
  "wheel",
  (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    event.stopPropagation();
    zoomAt(stagePoint(event), clamp(Math.exp(-event.deltaY * 0.01), 0.5, 2));
  },
  { passive: false, capture: true },
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
  // Only the select tool clears the selection on an empty click — panning or commenting should
  // leave the current selection (and its ⌘0 framing) intact.
  if (tool === "select" && !spaceHeld && !(frameEl instanceof HTMLElement)) setSelected(null);
});

function typingInField(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement;
}

/** Delete a frame and its comments, after a confirm. Shared by the ✕ button and the delete keys. */
function requestDeleteFrame(frameId: string): void {
  const frame = frames.get(frameId);
  if (!frame) return;
  if (!window.confirm(`Delete "${frame.name}" and its comments?`)) return;
  api(`/api/frames/${frameId}`, { method: "DELETE", headers: WRITE_HEADERS })
    .then(() => {
      dropFrame(frameId);
      if (selectedFrameId === frameId) setSelected(null);
      if (interactiveFrameId === frameId) setInteractive(null);
      closePanel();
      renderAll();
    })
    .catch(fail);
}

function zoomAtCenter(factor: number): void {
  const { width, height } = stageSize();
  zoomAt({ x: width / 2, y: height / 2 }, factor);
}

window.addEventListener("keydown", (event) => {
  // ⌘+ / ⌘- zoom the CANVAS, not the browser page — otherwise the page zoom blows up the grid and
  // labels and hides the toolbar. (⌘0 below is the canvas fit toggle, so it already blocks the
  // browser's reset-zoom; with page zoom fully intercepted here, there is nothing to reset.)
  if ((event.metaKey || event.ctrlKey) && (event.key === "=" || event.key === "+")) {
    event.preventDefault();
    zoomAtCenter(1.25);
    return;
  }
  if ((event.metaKey || event.ctrlKey) && (event.key === "-" || event.key === "_")) {
    event.preventDefault();
    zoomAtCenter(0.8);
    return;
  }
  // ⌘0 toggles between the selected frame and the whole canvas. With nothing selected there is
  // nothing to toggle against, so it just fits everything.
  if ((event.metaKey || event.ctrlKey) && event.key === "0") {
    event.preventDefault();
    if (selectedFrameId === null) {
      zoomToFit();
      return;
    }
    if (cmd0FitsAll) zoomToFit();
    else fitFrame(selectedFrameId);
    cmd0FitsAll = !cmd0FitsAll;
    return;
  }
  if (event.key === "Escape") {
    if (panel) closePanel();
    else if (commentListOpen) setCommentList(false);
    else if (interactiveFrameId !== null) setInteractive(null);
    else if (tool !== "select") setTool("select");
    else if (selectedFrameId !== null) setSelected(null);
    return;
  }
  if (typingInField() || event.metaKey || event.ctrlKey || event.altKey) return;
  // Figma-style zoom shortcuts on the number row. Matched by physical key (event.code) since
  // shift turns the digits into symbols. ⇧1 fit all · ⇧2 fit selection · ⇧0 reset to 100%.
  if (event.shiftKey && event.code === "Digit1") {
    event.preventDefault();
    zoomToFit();
    return;
  }
  if (event.shiftKey && event.code === "Digit2") {
    event.preventDefault();
    if (selectedFrameId !== null) fitFrame(selectedFrameId);
    else zoomToFit();
    return;
  }
  if (event.shiftKey && event.code === "Digit0") {
    event.preventDefault();
    resetZoom();
    return;
  }
  // Tools: V select · S/H hand (pan) · C comment.
  if (event.key === "v" || event.key === "V") {
    event.preventDefault();
    setTool("select");
    return;
  }
  if (event.key === "s" || event.key === "S" || event.key === "h" || event.key === "H") {
    event.preventDefault();
    setInteractive(null);
    setTool("pan");
    return;
  }
  if (event.key === "c" || event.key === "C") {
    event.preventDefault();
    setInteractive(null);
    setTool(tool === "comment" ? "select" : "comment");
    return;
  }
  if (event.key === "Backspace" || event.key === "Delete") {
    if (selectedFrameId === null) return;
    event.preventDefault();
    requestDeleteFrame(selectedFrameId);
    return;
  }
  if (event.key === "+" || event.key === "=") {
    event.preventDefault();
    zoomAtCenter(1.25);
    return;
  }
  if (event.key === "-" || event.key === "_") {
    event.preventDefault();
    zoomAtCenter(0.8);
    return;
  }
  if (event.key === "f" || event.key === "F") {
    event.preventDefault();
    if (selectedFrameId !== null) fitFrame(selectedFrameId);
    else zoomToFit();
    return;
  }
  if (event.key === "t" || event.key === "T") {
    event.preventDefault();
    toggleCommentList();
    return;
  }
  if (event.key === " ") {
    event.preventDefault();
    if (!spaceHeld) {
      spaceHeld = true;
      updateCursor();
    }
  }
});

window.addEventListener("keyup", (event) => {
  if (event.key === " ") {
    spaceHeld = false;
    updateCursor();
  }
});

window.addEventListener("blur", () => {
  spaceHeld = false;
  updateCursor();
});

window.addEventListener("resize", () => positionPanel());

toolSelect.addEventListener("click", () => setTool("select"));
toolPan.addEventListener("click", () => {
  setInteractive(null);
  setTool("pan");
});
toolComment.addEventListener("click", () => {
  setInteractive(null);
  setTool(tool === "comment" ? "select" : "comment");
});
toolComments.addEventListener("click", () => toggleCommentList());
sidebarClose.addEventListener("click", () => setCommentList(false));
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

// ---------------------------------------------------------------- theme

/**
 * Three states, cycled by the chip button: "system" follows prefers-color-scheme (the default),
 * "light" and "dark" force it. The choice rides in localStorage; the CSS reacts to data-theme on
 * <html> (absent = system). See the dark-palette selectors in style.css.
 */
type Theme = "system" | "light" | "dark";
const THEME_KEY = "tracepaper-theme";
const THEME_ORDER: Theme[] = ["system", "light", "dark"];
const THEME_ICON: Record<Theme, string> = {
  // system: half-filled disc · light: sun · dark: moon
  system: `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3a7 7 0 0 0 0 14V3Z" fill="currentColor"/><circle cx="10" cy="10" r="6.5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>`,
  light: `<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="3.4" fill="currentColor"/><g stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4"/></g></svg>`,
  dark: `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M14 11.5A5.5 5.5 0 0 1 8.5 6c0-1 .27-1.94.74-2.75A6 6 0 1 0 16.75 10.76 5.48 5.48 0 0 1 14 11.5Z" fill="currentColor"/></svg>`,
};

function readTheme(): Theme {
  const stored = localStorage.getItem(THEME_KEY);
  return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
}

function applyTheme(theme: Theme): void {
  if (theme === "system") delete document.documentElement.dataset["theme"];
  else document.documentElement.dataset["theme"] = theme;
  themeToggle.innerHTML = THEME_ICON[theme];
  themeToggle.title = `Theme: ${theme}`;
}

let currentTheme = readTheme();
applyTheme(currentTheme);
themeToggle.addEventListener("click", () => {
  currentTheme = THEME_ORDER[(THEME_ORDER.indexOf(currentTheme) + 1) % THEME_ORDER.length]!;
  if (currentTheme === "system") localStorage.removeItem(THEME_KEY);
  else localStorage.setItem(THEME_KEY, currentTheme);
  applyTheme(currentTheme);
});

// ---------------------------------------------------------------- empty state

const MCP_CONFIG = `{
  "mcpServers": {
    "tracepaper": {
      "command": "bunx",
      "args": ["github:caffeinum/tracepaper"]
    }
  }
}`;

el<HTMLPreElement>("config-snippet").textContent = MCP_CONFIG;
el<HTMLElement>("cli-snippet").textContent = "claude mcp add tracepaper -- bunx github:caffeinum/tracepaper";
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
  // Scope both frames and comments to the selected canvas so pins match the visible frames; null
  // fetches everything unfiltered. The repo list is always fetched whole — the switcher offers
  // every canvas regardless of which one is in view.
  const scope = currentRepo === null ? "" : `&repo=${encodeURIComponent(currentRepo)}`;
  const [framePayload, commentPayload, repoPayload] = await Promise.all([
    api(currentRepo === null ? "/api/frames" : `/api/frames?repo=${encodeURIComponent(currentRepo)}`),
    api(`/api/comments?includeResolved=true${scope}`),
    api("/api/repos"),
  ]);
  frames.clear();
  frameOrder.length = 0;
  comments.clear();
  for (const raw of toList(framePayload, "frames")) putFrame(toFrame(raw));
  for (const raw of toList(commentPayload, "comments")) {
    const comment = toComment(raw);
    comments.set(comment.id, comment);
  }
  renderRepoSwitcher(toList(repoPayload, "repos").map(toRepo));
  renderAll();
  if (!hasFitted && frames.size > 0) {
    hasFitted = true;
    if (!applyFrameHash()) zoomToFit();
  }
}

function setConn(_state: "connecting" | "live" | "down"): void {
  // Connection state is no longer surfaced in the chrome — the canvas either has the frames or it
  // doesn't, and a blinking status dot only added noise. Kept as a no-op so the EventSource
  // lifecycle wiring below stays untouched.
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
  // A backgrounded tab skips the interval entirely, so without this it comes back showing
  // whatever it had when you left — for as long as you were away.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) loadAll().catch(fail);
  });
}

/**
 * The other end of the escape bridge served with each frame. The frame's origin is opaque, so
 * `event.origin` is the useless string "null" — identity is established by matching the source
 * window against a frame iframe we created, which nothing outside the canvas can forge.
 */
function listenForFrameEscape(): void {
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!isRecord(data)) return;
    const kind = data["__tracepaper"];
    if (kind !== "escape" && kind !== "scroll") return;

    // Identity by source window, same as escape: the frame's origin is the opaque string "null",
    // so event.origin is useless; matching event.source against an iframe we created is the only
    // thing nothing outside the canvas can forge. A message from no known frame is ignored.
    const id = frameForSource(event.source);
    if (id === null) return;

    if (kind === "escape") {
      if (interactiveFrameId === id) setInteractive(null);
      return;
    }

    // scroll: record the frame's content scroll and re-place just this frame's pins (and, if it
    // owns the open thread/composer, that panel too) so they track the content under it.
    // Frame content is arbitrary HTML that can postMessage anything, so a malformed scroll report
    // is ignored, not thrown on — only our own bridge sends well-formed ones.
    const x = data["x"];
    const y = data["y"];
    if (typeof x !== "number" || !Number.isFinite(x) || typeof y !== "number" || !Number.isFinite(y)) return;
    const previous = frameScrollOf(id);
    if (previous.x === x && previous.y === y) return;
    frameScroll.set(id, { x, y });
    renderPins();
    if (panel && panel.frameId === id) positionPanel();
  });
}

/** The id of the frame whose iframe raised this message, or null when the source is not one of ours. */
function frameForSource(source: MessageEventSource | null): string | null {
  for (const [id, node] of frameNodes) {
    if (node.kind === "html" && node.iframe.contentWindow === source) return id;
  }
  return null;
}

// ---------------------------------------------------------------- sharing

type ShareState =
  | { status: "off" }
  | { status: "starting" }
  | { status: "unavailable" }
  | { status: "on"; url: string }
  | { status: "error"; message: string };

function renderShare(state: ShareState): void {
  shareBody.replaceChildren();
  toolShareLabel.textContent = state.status === "on" ? "Shared" : "Share";
  toolShare.classList.toggle("is-on", state.status === "on");

  const note = (text: string, warn = false): HTMLParagraphElement => {
    const p = document.createElement("p");
    p.className = warn ? "share-note share-warn" : "share-note";
    p.textContent = text;
    return p;
  };

  if (state.status === "unavailable") {
    shareBody.append(note("Sharing is not available in this mode."));
    return;
  }
  if (state.status === "starting") {
    shareBody.append(note("Opening a tunnel… this usually takes about ten seconds."));
    return;
  }
  if (state.status === "error") {
    shareBody.append(note(state.message, true));
    return;
  }
  if (state.status === "off") {
    const start = document.createElement("button");
    start.className = "ghost-btn";
    start.type = "button";
    start.textContent = "Create public link";
    start.addEventListener("click", () => void setShare("start"));
    shareBody.append(
      note("Publishes this canvas on a temporary public URL so anyone you send it to can view and comment."),
      start,
    );
    return;
  }

  const row = document.createElement("div");
  row.className = "share-url";
  const field = document.createElement("input");
  field.readOnly = true;
  field.value = state.url;
  field.addEventListener("focus", () => field.select());
  const copy = document.createElement("button");
  copy.className = "ghost-btn";
  copy.type = "button";
  copy.textContent = "Copy";
  copy.addEventListener("click", () => {
    void navigator.clipboard.writeText(state.url).then(() => {
      copy.textContent = "Copied";
      setTimeout(() => (copy.textContent = "Copy"), 1200);
    });
  });
  const stop = document.createElement("button");
  stop.className = "ghost-btn";
  stop.type = "button";
  stop.textContent = "Stop sharing";
  stop.addEventListener("click", () => void setShare("stop"));
  row.append(field, copy);

  shareBody.append(
    row,
    // Said plainly, because none of it is guessable from a URL box.
    note(
      "Anyone with this link can view every frame and post comments — there is no sign-in. " +
        "The link dies when this server stops, and a new one is issued each time you share.",
      true,
    ),
    note("Updates reach visitors within a few seconds rather than instantly: the tunnel does not carry the live event stream."),
    stop,
  );
}

async function setShare(action: "start" | "stop" | "read"): Promise<void> {
  if (action === "start") renderShare({ status: "starting" });
  const method = action === "start" ? "POST" : action === "stop" ? "DELETE" : "GET";
  const init: RequestInit = action === "read" ? {} : { method, headers: WRITE_HEADERS };
  const payload = await api("/api/share", init).catch((error: unknown) => {
    renderShare({ status: "error", message: error instanceof Error ? error.message : String(error) });
    return null;
  });
  if (payload === null) return;
  renderShare(payload as ShareState);
}

toolShare.addEventListener("click", () => {
  const opening = sharePanel.hidden;
  sharePanel.hidden = !opening;
  if (opening) void setShare("read");
});
shareClose.addEventListener("click", () => (sharePanel.hidden = true));

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

  // A filtered view stays filtered: frames on another canvas are dropped rather than rendered.
  // (The 5s reconcile refetches with the same scope, so nothing leaks in through that path either.)
  handle("frame.created", (payload) => {
    const frame = toFrame(unwrap(payload, "frame"));
    if (currentRepo !== null && frame.repo !== currentRepo) return;
    putFrame(frame);
    renderAll();
    if (!hasFitted) {
      hasFitted = true;
      zoomToFit();
    }
  });

  handle("frame.updated", (payload) => {
    const frame = toFrame(unwrap(payload, "frame"));
    if (currentRepo !== null && frame.repo !== currentRepo) return;
    putFrame(frame);
    renderAll();
  });

  handle("frame.deleted", (payload) => {
    dropFrame(idOf(payload, "frame"));
    if (panel && !frames.has(panel.frameId)) closePanel();
    renderAll();
  });

  // Comments carry no repo, so a filtered view keys off its frame: a comment on a frame that is
  // not in view belongs to another canvas and is ignored.
  handle("comment.created", (payload) => {
    const comment = toComment(unwrap(payload, "comment"));
    if (currentRepo !== null && !frames.has(comment.frameId)) return;
    comments.set(comment.id, comment);
    renderAll();
  });

  handle("comment.updated", (payload) => {
    const comment = toComment(unwrap(payload, "comment"));
    if (currentRepo !== null && !frames.has(comment.frameId)) return;
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

setTool("select");
applyView();
renderSidebar();
// Reflect the canvas named in the URL before the first fetch, so a shared ?repo= link loads scoped.
currentRepo = repoFromQuery();
repoSwitcher.value = currentRepo ?? "";
zoomToFit();
loadAll().catch(fail);
window.addEventListener("hashchange", () => {
  applyFrameHash(true);
});

subscribe();
reconcile();
void setShare("read");
listenForFrameEscape();
