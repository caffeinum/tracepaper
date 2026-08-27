/**
 * `tracepaper <verb>` — a thin command-line client over the same Store the MCP tools drive, for
 * agents whose client has no MCP. Every verb opens the shared SQLite db directly and writes as the
 * agent, exactly as the stdio server does: a CLI invocation is the agent acting locally, the same
 * trust level as an MCP process, so it bypasses the browser's human-only HTTP route (which stamps
 * every write "human" to stop a page forging the agent — see guardMutation in http.ts).
 *
 * Liveness: a canvas already open in a browser reconciles from the db every ~5s, so frames and
 * replies written here surface there within that window — the same lag the tunnel path has. The
 * write itself needs no running server; `serve` is only needed for a human to *view* the canvas.
 */

import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { loadConfig, type Config } from "./config.ts";
import { resolveRepo } from "./repo.ts";
import { Store } from "./store.ts";
import type { Comment } from "./types.ts";

/** The connection's own repo, resolved from cwd/env — the writer identity, like an stdio agent. */
function ownRepo(): string {
  return resolveRepo(process.env, process.cwd());
}

/** `--repo <x>` if given, else the CLI's own resolved repo — so a run is scoped like an agent. */
function repoFlag(flags: Flags): string {
  return typeof flags["repo"] === "string" ? flags["repo"] : ownRepo();
}

/** The verbs the CLI owns. Anything not here falls through to stdio / serve in index.ts. */
export const CLI_VERBS = new Set([
  "push",
  "comments",
  "reply",
  "resolve",
  "list",
  "get",
  "tidy",
  "delete",
  "help",
]);

type Flags = { _: string[]; [key: string]: string | boolean | string[] };

/** `--name x`, `--json`, `-` and bare positionals. `--k=v` and `--k v` both work; `--flag` is true. */
function parseFlags(argv: string[]): Flags {
  const flags: Flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) {
        flags[body] = argv[++i]!;
      } else {
        flags[body] = true;
      }
    } else {
      flags._.push(arg);
    }
  }
  return flags;
}

function num(flags: Flags, key: string): number | undefined {
  const raw = flags[key];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${key} must be a number, got ${String(raw)}`);
  return value;
}

/** The url a human would open, if a server is already serving this db. Read-only probe. */
async function liveCanvasUrl(config: Config): Promise<string | null> {
  let record: { url?: unknown; dbPath?: unknown };
  try {
    record = JSON.parse(readFileSync(config.serverJsonPath, "utf8")) as typeof record;
  } catch {
    return null;
  }
  if (typeof record.url !== "string" || record.dbPath !== config.dbPath) return null;
  try {
    const response = await fetch(`${record.url}/api/health`, { signal: AbortSignal.timeout(1500) });
    return response.ok ? record.url : null;
  } catch {
    return null;
  }
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function readSource(flags: Flags): string {
  if (typeof flags["html"] === "string") return flags["html"];
  const path = flags._[0];
  if (path === undefined) throw new Error("push needs a file path, `-` for stdin, or --html <string>");
  if (path === "-") return readFileSync(0, "utf8");
  return readFileSync(path, "utf8");
}

function nameFor(flags: Flags): string | undefined {
  if (typeof flags["name"] === "string") return flags["name"];
  const path = flags._[0];
  if (path === undefined || path === "-") return undefined;
  return basename(path, extname(path));
}

const AGE_UNITS: [number, string][] = [
  [86400_000, "d"],
  [3600_000, "h"],
  [60_000, "m"],
];

function ageOf(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  for (const [unit, label] of AGE_UNITS) {
    if (ms >= unit) return `${Math.floor(ms / unit)}${label} ago`;
  }
  return "just now";
}

function printComment(comment: Comment, indent: string): void {
  const tags = [comment.author, comment.resolved ? "resolved" : null].filter(Boolean).join(" · ");
  out(`${indent}${comment.id}  [${tags}] ${ageOf(comment.createdAt)}`);
  for (const raw of comment.text.split("\n")) out(`${indent}  ${raw}`);
}

/** Dispatch a CLI verb. Assumes verb is in CLI_VERBS. Returns a process exit code. */
export async function runCli(verb: string, rest: string[]): Promise<number> {
  if (verb === "help") {
    printHelp();
    return 0;
  }

  const flags = parseFlags(rest);
  const json = flags["json"] === true;
  const config = loadConfig();
  const store = new Store(config.dbPath);
  try {
    switch (verb) {
      case "push": {
        const html = readSource(flags);
        const frameId = typeof flags["frame"] === "string" ? flags["frame"] : undefined;
        const name = nameFor(flags);
        const width = num(flags, "width");
        const height = num(flags, "height");
        // createdBy is always the writer's own repo, even when --repo targets another canvas.
        const own = ownRepo();
        const repo = typeof flags["repo"] === "string" ? flags["repo"] : own;
        const frame =
          frameId === undefined
            ? store.createFrame({ html, name, width, height, x: num(flags, "x"), y: num(flags, "y"), repo, createdBy: own })
            : store.updateFrameHtml(frameId, html, { name, width, height });
        const canvas = await liveCanvasUrl(config);
        if (json) {
          out(JSON.stringify({ frame, canvasUrl: canvas === null ? null : `${canvas}/` }, null, 2));
        } else {
          out(`${frame.id}  ${frame.width}×${frame.height} @ (${frame.x}, ${frame.y})`);
          out(
            canvas === null
              ? "canvas: not running — start it with `tracepaper serve` to view (the frame is saved)"
              : `canvas: ${canvas}/  ·  frame: ${canvas}/f/${frame.id}`,
          );
        }
        return 0;
      }

      case "comments": {
        const since = typeof flags["since"] === "string" ? flags["since"] : undefined;
        const frameId = typeof flags["frame"] === "string" ? flags["frame"] : undefined;
        const authorRaw = flags["author"];
        const author = authorRaw === "human" || authorRaw === "agent" ? authorRaw : undefined;
        const includeResolved = flags["resolved"] === true;
        const comments = store.listComments({ frameId, since, includeResolved, author, repo: repoFlag(flags) });
        const cursor = store.nextCursor(comments, since);
        if (json) {
          out(JSON.stringify({ comments, cursor }, null, 2));
          return 0;
        }
        if (comments.length === 0) {
          out(since === undefined ? "no comments yet." : "nothing new since that cursor.");
        } else {
          const roots = comments.filter((c) => c.parentId === null);
          const repliesOf = (id: string): Comment[] => comments.filter((c) => c.parentId === id);
          for (const root of roots) {
            printComment(root, "");
            for (const reply of repliesOf(root.id)) printComment(reply, "    ");
          }
          // Orphan replies whose parent is outside this page still deserve to print.
          const shown = new Set(comments.filter((c) => c.parentId === null).map((c) => c.id));
          for (const c of comments) {
            if (c.parentId !== null && !shown.has(c.parentId)) printComment(c, "    ");
          }
        }
        if (cursor !== null) out(`\ncursor: ${cursor}  (pass --since ${cursor} next time)`);
        return 0;
      }

      case "reply": {
        const commentId = flags._[0];
        const text = flags._.slice(1).join(" ") || (typeof flags["text"] === "string" ? flags["text"] : "");
        if (commentId === undefined || text.length === 0) {
          throw new Error("usage: tracepaper reply <commentId> <text…>");
        }
        const target = store.getComment(commentId);
        const reply = store.createComment({
          frameId: target.frameId,
          x: target.x,
          y: target.y,
          text,
          parentId: target.id,
          author: "agent",
        });
        out(json ? JSON.stringify(reply, null, 2) : `${reply.id}  replied to ${target.id} on ${target.frameId}`);
        return 0;
      }

      case "resolve": {
        const commentId = flags._[0];
        if (commentId === undefined) throw new Error("usage: tracepaper resolve <commentId> [--note <text>]");
        const target = store.getComment(commentId);
        if (typeof flags["note"] === "string") {
          store.createComment({
            frameId: target.frameId,
            x: target.x,
            y: target.y,
            text: flags["note"],
            parentId: target.id,
            author: "agent",
          });
        }
        const changed = store.updateComment(commentId, { resolved: true });
        out(json ? JSON.stringify(changed, null, 2) : `resolved ${commentId} (${changed.length} thread row(s) updated)`);
        return 0;
      }

      case "list": {
        const frames = store.listFrames(repoFlag(flags));
        const canvas = await liveCanvasUrl(config);
        if (json) {
          out(JSON.stringify({ frames, canvasUrl: canvas === null ? null : `${canvas}/` }, null, 2));
          return 0;
        }
        if (frames.length === 0) {
          out("canvas is empty. push a frame with `tracepaper push <file>`.");
        } else {
          for (const f of frames) {
            const open = f.unresolvedCount > 0 ? `  ${f.unresolvedCount} open` : "";
            out(`${f.id}  ${f.width}×${f.height} @ (${f.x}, ${f.y})  v${f.version}  ${f.name}${open}`);
          }
        }
        if (canvas !== null) out(`\ncanvas: ${canvas}/`);
        return 0;
      }

      case "get": {
        const frameId = flags._[0];
        if (frameId === undefined) throw new Error("usage: tracepaper get <frameId>");
        const frame = store.getFrame(frameId);
        out(json ? JSON.stringify(frame, null, 2) : frame.html);
        return 0;
      }

      case "tidy": {
        const frames = store.tidyFrames(repoFlag(flags));
        out(json ? JSON.stringify({ frames }, null, 2) : `re-packed ${frames.length} frame(s).`);
        return 0;
      }

      case "delete": {
        const frameId = flags._[0];
        if (frameId === undefined) throw new Error("usage: tracepaper delete <frameId>");
        store.getFrame(frameId); // throw a clear error before claiming success on an unknown id
        store.deleteFrame(frameId);
        out(json ? JSON.stringify({ deleted: frameId }, null, 2) : `deleted ${frameId} and its comments.`);
        return 0;
      }

      default:
        throw new Error(`unhandled cli verb: ${verb}`);
    }
  } catch (error) {
    // A CLI reports failure as a clean one-line message and a non-zero exit, not a stack trace.
    process.stderr.write(`tracepaper: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    store.close();
  }
}

function printHelp(): void {
  out(
    [
      "tracepaper — an agent canvas. Run with no argument for the MCP stdio server.",
      "",
      "Canvas (for humans to watch):",
      "  tracepaper serve                 run the canvas server and hold it open",
      "",
      "CLI (for agents without MCP — writes go straight to the shared db as the agent):",
      "  tracepaper push <file>           draw a frame from an HTML file (`-` for stdin, or --html <str>)",
      "      --name --width --height --x --y   frame metadata; omit x/y to auto-place",
      "      --frame <id>                 update an existing frame instead of creating one",
      "      --repo <x>                   which repo/canvas to draw on (default: git remote / cwd)",
      "  tracepaper list                  list frames, sizes, positions, open-comment counts (--repo <x>)",
      "  tracepaper get <frameId>         print a frame's current HTML",
      "  tracepaper comments              read human feedback (--since <cursor> --frame <id> --resolved --repo <x>)",
      "  tracepaper reply <id> <text…>    reply to a comment thread",
      "  tracepaper resolve <id>          resolve a thread (--note <text> to reply and resolve)",
      "  tracepaper tidy                  re-pack frames so none overlap",
      "  tracepaper delete <frameId>      remove a frame and its comments",
      "",
      "Add --json to any read/write for machine-readable output.",
      "A frame is saved even with no server running; `serve` is only needed to view the canvas.",
    ].join("\n"),
  );
}
