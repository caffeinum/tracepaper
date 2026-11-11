/** Pure publish checks. No workers runtime, so the bun tests can run them. */

export class PublishError extends Error {}

export const MAX_HTML_BYTES = 5_000_000;
export const MAX_PUBLISH_BYTES = 20_000_000;
export const MAX_FRAMES = 200;
export const MAX_NAME = 200;
export const MAX_DIM = 8192;

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const FRAME_ID_RE = /^frm_[0-9a-f]{12}$/;

export type FrameKind = "html" | "text" | "section";

export interface PublishFrame {
  id: string;
  name: string;
  html: string;
  width: number;
  height: number;
  x: number;
  y: number;
  kind: FrameKind;
  fontSize: number | null;
}

export interface PublishBody {
  name: string;
  frames: PublishFrame[];
}

export function parseSlug(raw: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new PublishError(`bad canvas id: ${raw}`);
  }
  if (!SLUG_RE.test(decoded)) {
    throw new PublishError(
      `bad canvas id "${decoded}". use a lowercase slug: letters, digits, hyphens, 1–63 chars, must start with a letter or digit`,
    );
  }
  return decoded;
}

function finite(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PublishError(`${field} must be a finite number`);
  }
  return value;
}

function parseFrame(value: unknown, index: number): PublishFrame {
  if (value === null || typeof value !== "object") {
    throw new PublishError(`frames[${index}] must be an object`);
  }
  const row = value as Record<string, unknown>;
  const where = `frames[${index}]`;
  if (typeof row.id !== "string" || !FRAME_ID_RE.test(row.id)) {
    throw new PublishError(`${where}.id must be a frame id (frm_ + 12 hex)`);
  }
  if (typeof row.name !== "string") throw new PublishError(`${where}.name must be a string`);
  if (row.name.length > MAX_NAME) throw new PublishError(`${where}.name is longer than ${MAX_NAME}`);
  if (typeof row.html !== "string") throw new PublishError(`${where}.html must be a string`);
  if (row.html.length > MAX_HTML_BYTES) {
    throw new PublishError(`${where}.html is longer than ${MAX_HTML_BYTES} bytes`);
  }
  const kind = row.kind;
  if (kind !== "html" && kind !== "text" && kind !== "section") {
    throw new PublishError(`${where}.kind must be html, text, or section`);
  }
  if (kind === "html" && row.html.length === 0) {
    throw new PublishError(`${where}.html must not be empty for an html frame`);
  }
  const width = finite(row.width, `${where}.width`);
  const height = finite(row.height, `${where}.height`);
  if (width <= 0 || height <= 0 || width > MAX_DIM || height > MAX_DIM) {
    throw new PublishError(`${where} width and height must be within 1–${MAX_DIM}`);
  }
  const x = finite(row.x, `${where}.x`);
  const y = finite(row.y, `${where}.y`);
  let fontSize: number | null;
  if (row.fontSize === null) fontSize = null;
  else fontSize = finite(row.fontSize, `${where}.fontSize`);
  if (kind === "text" && (fontSize === null || fontSize <= 0)) {
    throw new PublishError(`${where}.fontSize must be a positive number for a text frame`);
  }
  return { id: row.id, name: row.name, html: row.html, width, height, x, y, kind, fontSize };
}

export function parsePublish(raw: string): PublishBody {
  if (raw.length > MAX_PUBLISH_BYTES) {
    throw new PublishError(`publish body is longer than ${MAX_PUBLISH_BYTES} bytes`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new PublishError("publish body is not json");
  }
  if (json === null || typeof json !== "object") throw new PublishError("publish body must be an object");
  const body = json as Record<string, unknown>;
  if (typeof body.name !== "string" || body.name.trim() === "") {
    throw new PublishError("name must be a non-empty string");
  }
  if (body.name.length > MAX_NAME) throw new PublishError(`name is longer than ${MAX_NAME}`);
  if (!Array.isArray(body.frames)) throw new PublishError("frames must be an array");
  if (body.frames.length > MAX_FRAMES) throw new PublishError(`frames must be at most ${MAX_FRAMES}`);
  const frames = body.frames.map(parseFrame);
  const seen = new Set<string>();
  for (const frame of frames) {
    if (seen.has(frame.id)) throw new PublishError(`duplicate frame id ${frame.id}`);
    seen.add(frame.id);
  }
  let htmlBytes = 0;
  for (const frame of frames) htmlBytes += frame.html.length;
  if (htmlBytes > MAX_PUBLISH_BYTES) {
    throw new PublishError(`frame html totals more than ${MAX_PUBLISH_BYTES} bytes`);
  }
  return { name: body.name, frames };
}

/** Constant-time compare. A length mismatch still returns false; it does not throw. */
export function bearerMatches(header: string | null, token: string): boolean {
  if (header === null) return false;
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const got = header.slice(prefix.length);
  if (got.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}
