import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * "Screenshot a frame → PNG" using a *system-installed* Chrome in headless mode. Like the Share
 * feature shells out to a system `cloudflared`, this shells out to a system Chrome rather than
 * bundling a browser — so it works when one is present and fails loudly when it is not.
 */

const CLAMP_MIN = 1;
const CLAMP_MAX = 4000;
/** A frame document at /f/:id is static (no SSE), so `--screenshot` terminates; this only guards a hang. */
const RENDER_TIMEOUT_MS = 15_000;

/** macOS app-bundle binaries, checked with existsSync. */
const MAC_BUNDLES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
];

/** Names looked up on PATH via Bun.which. */
const PATH_NAMES = [
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
  "chrome",
  "microsoft-edge",
];

/** Common absolute Linux install paths. */
const LINUX_PATHS = [
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

/**
 * Locate a Chrome/Chromium binary without throwing. Order: explicit env override, macOS app
 * bundles, PATH lookups, then common Linux paths. Returns the first that exists, else null.
 */
export function findChrome(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const name of ["TRACEPAPER_CHROME", "PAPER_MCP_CHROME"]) {
    const value = env[name];
    if (value !== undefined && value !== "" && existsSync(value)) return value;
  }

  for (const bundle of MAC_BUNDLES) {
    if (existsSync(bundle)) return bundle;
  }

  for (const name of PATH_NAMES) {
    const found = Bun.which(name);
    if (found !== null) return found;
  }

  for (const path of LINUX_PATHS) {
    if (existsSync(path)) return path;
  }

  return null;
}

function clampDim(value: number): number {
  return Math.min(CLAMP_MAX, Math.max(CLAMP_MIN, Math.round(value)));
}

export type RenderPngOptions = {
  chrome: string;
  url: string;
  width: number;
  height: number;
};

/** The first eight bytes of every PNG file. */
export const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Render `url` to PNG bytes with a headless Chrome. The frame document is static, so headless
 * `--screenshot` exits on its own; the timeout only guards against a wedged process.
 */
export async function renderPng(opts: RenderPngOptions): Promise<Uint8Array> {
  const width = clampDim(opts.width);
  const height = clampDim(opts.height);

  const dir = mkdtempSync(join(tmpdir(), "tracepaper-shot-"));
  const shot = join(dir, "shot.png");
  const profile = join(dir, "profile");

  const args = [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--force-device-scale-factor=2",
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    "--virtual-time-budget=6000",
    `--screenshot=${shot}`,
    opts.url,
  ];

  try {
    const proc = Bun.spawn([opts.chrome, ...args], { stdout: "pipe", stderr: "pipe" });

    // `--headless=new` reliably WRITES the screenshot but does not always EXIT (a known macOS hang),
    // so we do not wait for exit: we poll for the finished file and return the moment it is stable,
    // killing Chrome either way. The hard deadline bounds the whole thing.
    const deadline = Date.now() + RENDER_TIMEOUT_MS;
    let exited = false;
    void proc.exited.then(() => {
      exited = true;
    });

    let lastSize = -1;
    let stableFor = 0;
    while (Date.now() < deadline) {
      if (existsSync(shot)) {
        const size = readFileSync(shot).length;
        // Wait for the size to hold steady across two polls so we never read a half-written file.
        if (size > 0 && size === lastSize) {
          stableFor++;
          if (stableFor >= 1) break;
        } else {
          stableFor = 0;
        }
        lastSize = size;
      }
      // If Chrome exited on its own without a file, it failed — stop waiting and report below.
      if (exited && !existsSync(shot)) break;
      await Bun.sleep(150);
    }

    const exitCode = proc.exitCode;
    proc.kill();

    if (!existsSync(shot)) {
      if (exitCode !== null && exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`chrome exited with code ${exitCode}: ${stderr.slice(0, 500)}`);
      }
      throw new Error(`chrome produced no screenshot within ${RENDER_TIMEOUT_MS}ms`);
    }

    const bytes = new Uint8Array(readFileSync(shot));
    if (bytes.length === 0) throw new Error("chrome produced an empty screenshot");
    return bytes;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Render-through cache
//
// Rendering a PNG spawns a headless Chrome — far too costly to do on every
// request when a mobile board fires one thumbnail fetch per frame on load. So:
//   - cache the finished bytes per frame, keyed by id, overwritten when the
//     frame's version changes (an edited frame re-renders, nothing stale);
//   - de-dupe in-flight renders of the same id+version so 60 parallel requests
//     for one frame spawn a single Chrome, not sixty;
//   - cap concurrent renders with a small semaphore so a burst of distinct
//     thumbnails cannot fork a Chrome per frame at once.
// In-memory only — the canvas re-fetches on reload, so a cold cache costs one
// render, not correctness.

type CacheEntry = { version: number; bytes: Uint8Array };

const pngCache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<Uint8Array>>();

/** Most Chromes we let render at once; further requests await a slot. */
export const MAX_CONCURRENT_RENDERS = 3;
let activeRenders = 0;
const renderQueue: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (activeRenders < MAX_CONCURRENT_RENDERS) {
    activeRenders++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => renderQueue.push(resolve));
}

function releaseSlot(): void {
  const next = renderQueue.shift();
  // Hand the slot straight to the next waiter (count unchanged) or free it.
  if (next !== undefined) next();
  else activeRenders--;
}

export type RenderFn = () => Promise<Uint8Array>;

/**
 * Return cached PNG bytes for `frameId` at `version`, else render once through
 * `render`, store, and return. Concurrent callers for the same id+version share
 * one render; overall concurrency is capped by the semaphore above. A failed
 * render caches nothing and rejects every sharer.
 */
export async function renderCached(
  frameId: string,
  version: number,
  render: RenderFn,
): Promise<Uint8Array> {
  const cached = pngCache.get(frameId);
  if (cached !== undefined && cached.version === version) return cached.bytes;

  const key = `${frameId}@${version}`;
  const existing = inFlight.get(key);
  if (existing !== undefined) return existing;

  const promise = (async () => {
    await acquireSlot();
    try {
      const bytes = await render();
      pngCache.set(frameId, { version, bytes });
      return bytes;
    } finally {
      releaseSlot();
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, promise);
  return promise;
}
