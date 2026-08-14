import { spawn, type ChildProcess } from "node:child_process";

/**
 * A public URL for the canvas, on demand, by running `cloudflared` as a child process.
 *
 * This is deliberately the quick-tunnel flavour: no account, no config, no DNS. The cost is
 * that the hostname is random and dies with the tunnel, which is the right trade for "show
 * someone this canvas for ten minutes" and the wrong one for anything permanent.
 */
export type TunnelState =
  | { status: "off" }
  | { status: "starting" }
  | { status: "on"; url: string }
  | { status: "error"; message: string };

const BINARY = "cloudflared";
/** Quick tunnels usually print their hostname in 5-15s; past this something is wrong. */
const START_TIMEOUT_MS = 45_000;
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

/**
 * A read-only view of a tunnel owned by *another* process. When an MCP client starts a stdio
 * server against a db a `serve` process already owns, that process owns the tunnel too — so the
 * agent must ask it rather than keep its own idea, or clicking Share in the browser would leave
 * every tool still handing out a localhost URL.
 */
export class RemoteTunnelView {
  private url: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly ownerUrl: string,
    private readonly pollMs = 5000,
  ) {}

  start(): void {
    if (this.timer !== null) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  publicUrl(): string | null {
    return this.url;
  }

  private async poll(): Promise<void> {
    try {
      const response = await fetch(`${this.ownerUrl}/api/share`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) return;
      const state = (await response.json()) as { status?: unknown; url?: unknown };
      this.url = state.status === "on" && typeof state.url === "string" ? state.url : null;
    } catch {
      // The owner may have exited; keep the last answer rather than thrashing the URL.
    }
  }
}

export class Tunnel {
  private child: ChildProcess | null = null;
  private state: TunnelState = { status: "off" };
  private starting: Promise<TunnelState> | null = null;

  constructor(private readonly localUrl: string) {}

  current(): TunnelState {
    return this.state;
  }

  /** Idempotent: a second call while one is starting joins the first rather than spawning again. */
  async start(): Promise<TunnelState> {
    if (this.state.status === "on") return this.state;
    if (this.starting !== null) return this.starting;

    this.state = { status: "starting" };
    this.starting = this.spawnTunnel().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private spawnTunnel(): Promise<TunnelState> {
    return new Promise<TunnelState>((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(BINARY, ["tunnel", "--url", this.localUrl], {
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        resolve(this.fail(`could not start ${BINARY}: ${String(error)}`));
        return;
      }
      this.child = child;

      let settled = false;
      const settle = (next: TunnelState): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.state = next;
        resolve(next);
      };

      const timer = setTimeout(() => {
        this.stop();
        settle({
          status: "error",
          message: `${BINARY} did not report a URL within ${START_TIMEOUT_MS / 1000}s`,
        });
      }, START_TIMEOUT_MS);

      // cloudflared prints the hostname to stderr, not stdout.
      const scan = (chunk: Buffer): void => {
        const found = URL_RE.exec(chunk.toString());
        if (found !== null) settle({ status: "on", url: found[0] });
      };
      child.stdout?.on("data", scan);
      child.stderr?.on("data", scan);

      child.on("error", (error) => {
        const hint =
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? `${BINARY} is not installed — brew install cloudflared (or see developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads)`
            : `${BINARY} failed: ${error.message}`;
        settle(this.fail(hint));
      });

      child.on("exit", (code) => {
        this.child = null;
        if (!settled) {
          settle(this.fail(`${BINARY} exited with code ${code ?? "null"} before reporting a URL`));
          return;
        }
        // Exited after it was up: the share link is dead, so say so rather than keep showing it.
        if (this.state.status === "on") this.state = { status: "off" };
      });
    });
  }

  private fail(message: string): TunnelState {
    this.state = { status: "error", message };
    return this.state;
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    this.state = { status: "off" };
    if (child !== null && child.exitCode === null) child.kill("SIGTERM");
  }
}
