/**
 * `tracepaper service install | uninstall | status` — the shared server as a launchd agent (macOS).
 *
 * Why: agents that connect over HTTP have no local fallback, so the shared server must outlive
 * crashes and reboots. launchd starts it at login (RunAtLoad) and restarts it if it dies
 * (KeepAlive); connected agents never notice because MCP sessions are rebuilt on the fly.
 *
 * Pinned by construction: the service runs the exact package directory `service install` was run
 * from (e.g. a versioned install like ~/.paw/mcp/tracepaper-0.10.4/node_modules/tracepaper). A
 * throwaway location (bunx/npx cache, temp dir) is refused — it can vanish under a running service.
 *
 * Strict port: the service binds exactly its port or exits (TRACEPAPER_STRICT_PORT=1), and launchd
 * retries every ThrottleInterval seconds. Without this a held :4321 would push it silently onto
 * :4322, where no agent would find it.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type Config } from "./config.ts";

export const DEFAULT_LABEL = "com.caffeinum.tracepaper";
/** Seconds launchd waits between restarts — also how often a strict-port start re-tries a held port. */
const THROTTLE_S = 10;
const START_DEADLINE_MS = 30_000;

export type PlistOptions = {
  label: string;
  bun: string;
  entry: string;
  port: number;
  dbPath: string;
  stateDir: string;
  logPath: string;
  home: string;
  path: string;
};

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The launchd property list for the shared server. Pure, so it can be tested without launchd. */
export function buildPlist(o: PlistOptions): string {
  const env: Record<string, string> = {
    TRACEPAPER_PORT: String(o.port),
    TRACEPAPER_DB: o.dbPath,
    TRACEPAPER_STRICT_PORT: "1",
    HOME: o.home,
    PATH: o.path,
  };
  const envXml = Object.entries(env)
    .map(([k, v]) => `      <key>${xml(k)}</key>\n      <string>${xml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xml(o.label)}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xml(o.bun)}</string>
      <string>run</string>
      <string>${xml(o.entry)}</string>
      <string>serve</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
    <key>WorkingDirectory</key>
    <string>${xml(o.stateDir)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>${THROTTLE_S}</integer>
    <key>StandardOutPath</key>
    <string>${xml(o.logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(o.logPath)}</string>
  </dict>
</plist>
`;
}

/**
 * Refuse a package root that can disappear: package-manager caches and temp dirs. Returns the
 * reason it is unsafe, or null when it is a stable, pinned location.
 */
export function ephemeralReason(root: string): string | null {
  const real = existsSync(root) ? realpathSync(root) : root;
  const temps = [tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"]
    .filter((t) => t !== "")
    .map((t) => (existsSync(t) ? realpathSync(t) : t));
  for (const t of temps) {
    if (real === t || real.startsWith(`${t}/`)) return `it lives in a temp dir (${t})`;
  }
  if (/\/_npx\//.test(real)) return "it lives in the npx cache (~/.npm/_npx), which npm prunes";
  if (/\/bunx-[^/]*\//.test(real) || /\/\.bun\/install\/cache\//.test(real)) {
    return "it lives in the bun/bunx cache, which bun prunes";
  }
  return null;
}

/** pid of whatever LISTENs on 127.0.0.1/any `port`, or null when the port is free. */
function portOwner(port: number): number | null {
  const r = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
  const first = r.stdout.trim().split("\n")[0];
  return first === undefined || first === "" ? null : Number(first);
}

function commandOf(pid: number): string {
  return spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
}

function uid(): number {
  if (typeof process.getuid !== "function") throw new Error("launchd service needs a POSIX uid (macOS)");
  return process.getuid();
}

type LaunchdState = { loaded: boolean; pid: number | null };

function launchdState(label: string): LaunchdState {
  const r = spawnSync("launchctl", ["print", `gui/${uid()}/${label}`], { encoding: "utf8" });
  if (r.status !== 0) return { loaded: false, pid: null };
  const m = /^\s*pid = (\d+)/m.exec(r.stdout);
  return { loaded: true, pid: m === null ? null : Number(m[1]) };
}

function launchctl(args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("launchctl", args, { encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}`.trim() };
}

type Health = { ok: boolean; mcp: boolean; version: string | null; frames: number };

async function health(port: number): Promise<Health | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const b = (await res.json()) as { ok?: unknown; mcp?: unknown; version?: unknown; frames?: unknown };
    return {
      ok: b.ok === true,
      mcp: b.mcp === true,
      version: typeof b.version === "string" ? b.version : null,
      frames: typeof b.frames === "number" ? b.frames : -1,
    };
  } catch {
    return null;
  }
}

type Paths = { label: string; plistPath: string; logPath: string };

/** The launchd-managed pid for the tracepaper service, if it is loaded and running. */
export function serviceLabel(): string {
  return process.env["TRACEPAPER_SERVICE_LABEL"] ?? DEFAULT_LABEL;
}

export function servicePid(): number | null {
  if (process.platform !== "darwin") return null;
  return launchdState(serviceLabel()).pid;
}

function paths(config: Config): Paths {
  // Overridable so tests can run a throwaway job beside the real one.
  const label = serviceLabel();
  return {
    label,
    plistPath: join(homedir(), "Library", "LaunchAgents", `${label}.plist`),
    logPath: resolve(config.stateDir, "service.log"),
  };
}

function packageRoot(): string {
  return fileURLToPath(new URL("..", import.meta.url));
}

function parseArgs(rest: string[]): { port?: number; db?: string } {
  const out: { port?: number; db?: string } = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    const next = rest[i + 1];
    if (a === "--port" && next !== undefined) {
      const n = Number(next);
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`--port must be 1..65535, got ${next}`);
      out.port = n;
      i++;
    } else if (a === "--db" && next !== undefined) {
      out.db = resolve(next);
      i++;
    } else {
      throw new Error(`unknown argument: ${a} (expected --port <n> / --db <path>)`);
    }
  }
  return out;
}

const say = (s: string): void => void process.stdout.write(`${s}\n`);
const fail = (s: string): number => {
  process.stderr.write(`[tracepaper service] ${s}\n`);
  return 1;
};

async function install(rest: string[]): Promise<number> {
  const config = loadConfig();
  const args = parseArgs(rest);
  const port = args.port ?? config.port;
  const dbPath = args.db ?? config.dbPath;
  const p = paths(config);

  const root = packageRoot();
  const why = ephemeralReason(root);
  if (why !== null) {
    return fail(
      `refusing to install from ${root}: ${why}.\n` +
        `Install a pinned copy first (e.g. \`bun add --cwd ~/.paw/mcp/tracepaper-<ver> tracepaper@<ver>\`)\n` +
        `and run \`service install\` from it, so the service keeps running that exact version.`,
    );
  }
  const entry = join(root, "src", "index.ts");
  if (!existsSync(entry)) return fail(`package entry missing: ${entry}`);

  const before = launchdState(p.label);
  const owner = portOwner(port);
  if (owner !== null && owner !== before.pid) {
    return fail(
      `port ${port} is held by pid ${owner} (${commandOf(owner).slice(0, 140)}).\n` +
        `The service binds :${port} strictly, so stop that process first (it is the cutover step), then re-run.`,
    );
  }

  mkdirSync(dirname(p.plistPath), { recursive: true });
  mkdirSync(config.stateDir, { recursive: true });
  writeFileSync(
    p.plistPath,
    buildPlist({
      label: p.label,
      bun: process.execPath,
      entry,
      port,
      dbPath,
      stateDir: config.stateDir,
      logPath: p.logPath,
      home: homedir(),
      path: process.env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    }),
  );

  // Re-install = replace: unload any previous copy, then load the new plist. bootout returns before
  // the job is actually gone, and bootstrapping over a half-unloaded label fails with
  // "Bootstrap failed: 5: Input/output error" — so wait for the unload to finish.
  if (before.loaded) {
    launchctl(["bootout", `gui/${uid()}/${p.label}`]);
    const gone = Date.now() + 15_000;
    while (launchdState(p.label).loaded) {
      if (Date.now() > gone) return fail(`previous ${p.label} did not unload within 15s`);
      await Bun.sleep(200);
    }
  }
  const boot = launchctl(["bootstrap", `gui/${uid()}`, p.plistPath]);
  if (!boot.ok) return fail(`launchctl bootstrap failed: ${boot.out}`);

  const until = Date.now() + START_DEADLINE_MS;
  while (Date.now() < until) {
    const st = launchdState(p.label);
    const h = await health(port);
    if (st.pid !== null && portOwner(port) === st.pid && h !== null && h.ok && h.mcp) {
      say(`installed ${p.label} (pid ${st.pid}, tracepaper ${h.version ?? "?"})`);
      say(`  canvas: http://127.0.0.1:${port}`);
      say(`  mcp:    http://127.0.0.1:${port}/mcp`);
      say(`  runs:   ${entry}`);
      say(`  db:     ${dbPath}`);
      say(`  plist:  ${p.plistPath}`);
      say(`  log:    ${p.logPath}`);
      say(`verify any time: tracepaper service status`);
      return 0;
    }
    await Bun.sleep(300);
  }
  return fail(`service did not come up on :${port} within ${START_DEADLINE_MS / 1000}s — see ${p.logPath}`);
}

async function uninstall(): Promise<number> {
  const config = loadConfig();
  const p = paths(config);
  const st = launchdState(p.label);
  if (st.loaded) {
    const out = launchctl(["bootout", `gui/${uid()}/${p.label}`]);
    if (!out.ok) return fail(`launchctl bootout failed: ${out.out}`);
  }
  rmSync(p.plistPath, { force: true });
  say(st.loaded ? `uninstalled ${p.label} (was pid ${st.pid ?? "?"})` : `${p.label} was not loaded; plist removed`);
  return 0;
}

/** Exit 0 only when launchd's job is the process LISTENing on the port and it answers healthy. */
async function status(): Promise<number> {
  const config = loadConfig();
  const p = paths(config);
  const installed = existsSync(p.plistPath);
  const plist = installed ? readFileSync(p.plistPath, "utf8") : "";
  const port = Number(/TRACEPAPER_PORT<\/key>\s*<string>(\d+)/.exec(plist)?.[1] ?? config.port);
  const entry = /<string>run<\/string>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? "(no plist)";
  const st = launchdState(p.label);
  const owner = portOwner(port);
  const h = await health(port);
  const owns = st.pid !== null && owner === st.pid;

  say(`service:    ${p.label} — ${installed ? "installed" : "NOT installed"}, ${st.loaded ? "loaded" : "not loaded"}`);
  say(`launchd pid: ${st.pid ?? "-"}`);
  say(`:${port} owner: ${owner === null ? "nobody" : `pid ${owner}${owns ? "" : ` (${commandOf(owner).slice(0, 100)})`}`}`);
  say(`owns :${port}: ${owns ? "YES" : "NO"}`);
  say(`health:     ${h === null ? "no answer" : `ok=${h.ok} mcp=${h.mcp} version=${h.version ?? "?"} frames=${h.frames}`}`);
  say(`runs:       ${entry}`);
  return owns && h !== null && h.ok && h.mcp ? 0 : 1;
}

export async function runService(rest: string[]): Promise<number> {
  const [sub, ...args] = rest;
  if (process.platform !== "darwin") return fail("`service` manages a launchd agent and needs macOS");
  if (sub === "install") return install(args);
  if (sub === "uninstall") return uninstall();
  if (sub === "status") return status();
  return fail(`usage: tracepaper service install [--port 4321] [--db <path>] | uninstall | status`);
}
