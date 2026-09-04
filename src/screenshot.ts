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
