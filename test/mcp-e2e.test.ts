/**
 * The MCP surface, proven from outside our own code: every test spawns
 * `bun src/index.ts` as a child process against a fresh temp-file db on an
 * ephemeral port, then drives it with the real SDK client over stdio.
 *
 * Nothing here reaches into src/ except for the result schemas, so a regression
 * in the transport, the tool registration, or the process lifecycle fails here.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  GetCommentsResultSchema,
  ListFramesResultSchema,
  PushHtmlResultSchema,
  type Comment,
  type GetCommentsResult,
  type ListFramesResult,
  type PushHtmlResult,
} from "../src/types.ts";

const ROOT = join(import.meta.dir, "..");
const ENTRY = join(ROOT, "src", "index.ts");
const TOOL_NAMES = [
  "delete_frame",
  "get_comments",
  "get_frame",
  "list_frames",
  "push_html",
  "reply_to_comment",
  "resolve_comment",
  "tidy_canvas",
];
const EXIT_TIMEOUT_MS = 5000;
/** Must exceed EXIT_TIMEOUT_MS, or bun's own timeout aborts the test before its cleanup runs. */
const LIFECYCLE_TEST_TIMEOUT_MS = 20_000;

type Session = {
  /** Base origin of the child's http server, e.g. http://127.0.0.1:53411 */
  base: string;
  dbPath: string;
  pid: number;
  listTools(): Promise<string[]>;
  call(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  pushHtml(args: Record<string, unknown>): Promise<PushHtmlResult>;
  getComments(args?: Record<string, unknown>): Promise<GetCommentsResult>;
  listFrames(): Promise<ListFramesResult>;
  /** The human half of the loop: a pin dropped on the canvas, posted over HTTP. */
  humanComment(frameId: string, x: number, y: number, text: string): Promise<Comment>;
  json(path: string): Promise<unknown>;
};

function textOf(result: CallToolResult): string {
  return result.content
    .map((block) => (block.type === "text" ? block.text : `<${block.type}>`))
    .join("\n");
}

function structured<T>(result: CallToolResult, schema: { parse(value: unknown): T }): T {
  if (result.isError === true) throw new Error(`tool call failed: ${textOf(result)}`);
  if (result.structuredContent === undefined) {
    throw new Error(`tool call returned no structuredContent: ${textOf(result)}`);
  }
  return schema.parse(result.structuredContent);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number): Promise<void> {
  const deadline = Date.now() + EXIT_TIMEOUT_MS;
  while (isAlive(pid)) {
    if (Date.now() > deadline) {
      process.kill(pid, "SIGKILL");
      throw new Error(`child process ${pid} outlived its client by ${EXIT_TIMEOUT_MS}ms`);
    }
    await Bun.sleep(20);
  }
}

/**
 * Boots a server, runs the body against it, then tears the child and its temp db down
 * whether the body passed or threw — so the file is repeatable with no manual cleanup.
 */
async function withServer(
  body: (session: Session) => Promise<void>,
  options: { dbPath?: string } = {},
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "tracepaper-e2e-"));
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const dbPath = options.dbPath === undefined ? join(dir, "tracepaper.db") : options.dbPath;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["run", ENTRY],
    cwd: ROOT,
    env: {
      ...getDefaultEnvironment(),
      HOME: home, // keeps the real ~/.tracepaper/server.json untouched
      TRACEPAPER_PORT: "0",
      TRACEPAPER_DB: dbPath,
      TRACEPAPER_HOST: "127.0.0.1",
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "tracepaper-e2e", version: "0.1.0" });

  let pid = -1;
  try {
    await client.connect(transport);
    const spawned = transport.pid;
    if (spawned === null) throw new Error("stdio transport spawned no child process");
    pid = spawned;

    const call = async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<CallToolResult> => (await client.callTool({ name, arguments: args })) as CallToolResult;

    const listFrames = async (): Promise<ListFramesResult> =>
      structured(await call("list_frames", {}), ListFramesResultSchema);

    // The client learns the port the same way an agent would: from a tool result.
    const base = new URL((await listFrames()).canvasUrl).origin;

    const session: Session = {
      base,
      dbPath,
      pid,
      call,
      listFrames,
      async listTools() {
        const { tools } = await client.listTools();
        return tools.map((tool) => tool.name).sort();
      },
      async pushHtml(args) {
        return structured(await call("push_html", args), PushHtmlResultSchema);
      },
      async getComments(args = {}) {
        return structured(await call("get_comments", args), GetCommentsResultSchema);
      },
      async humanComment(frameId, x, y, text) {
        const res = await fetch(`${base}/api/comments`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-tracepaper": "1" },
          body: JSON.stringify({ frameId, x, y, text }),
        });
        expect(res.status).toBe(201);
        return (await res.json()) as Comment;
      },
      async json(path) {
        const res = await fetch(`${base}${path}`);
        if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${await res.text()}`);
        return await res.json();
      },
    };

    await body(session);
  } finally {
    await client.close();
    if (pid > 0) await waitForExit(pid);
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- a ----------

test("listTools returns exactly the spec'd tools, each usable", async () => {
  await withServer(async (s) => {
    expect(await s.listTools()).toEqual(TOOL_NAMES);
  });
});

// ---------- b ----------

test("push_html creates a frame whose canvasUrl and raw html url are both live", async () => {
  await withServer(async (s) => {
    const pushed = await s.pushHtml({ html: "<h1>hello canvas</h1>", name: "Landing" });

    expect(pushed.frameId).toMatch(/^frm_[0-9a-f]{12}$/);
    expect(pushed.name).toBe("Landing");
    expect(pushed.version).toBe(1);
    expect(pushed.canvasUrl).toBe(`${s.base}/`);
    expect(pushed.url).toBe(`${s.base}/f/${pushed.frameId}`);
    expect(textOf(await s.call("list_frames", {}))).toContain(pushed.canvasUrl);

    // the url handed to the human actually serves the canvas app
    const canvas = await fetch(pushed.canvasUrl);
    expect(canvas.status).toBe(200);
    expect(canvas.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const canvasHtml = await canvas.text();
    expect(canvasHtml).toContain("/dist/canvas.js");
    expect((await fetch(`${s.base}/dist/canvas.js`)).status).toBe(200);

    // and the iframe src serves back exactly what was pushed
    const served = await fetch(pushed.url);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await served.text()).toContain("<h1>hello canvas</h1>");

    expect(await s.json("/api/health")).toMatchObject({ ok: true, frames: 1, comments: 0 });
    // the db is a real file on disk, not :memory:
    expect(existsSync(s.dbPath)).toBe(true);
  });
});

// ---------- c ----------

test("push_html with the same frameId updates in place, bumps version, adds no frame", async () => {
  await withServer(async (s) => {
    const first = await s.pushHtml({ html: "<p>v1</p>", name: "Versioned" });
    expect(first.version).toBe(1);
    expect((await s.listFrames()).frames.length).toBe(1);

    const second = await s.pushHtml({ frameId: first.frameId, html: "<p>v2</p>" });
    expect(second.frameId).toBe(first.frameId);
    expect(second.version).toBe(2);
    expect(second.name).toBe("Versioned"); // name survives an html-only update
    expect(second.url).toBe(first.url);

    const third = await s.pushHtml({ frameId: first.frameId, html: "<p>v3</p>", name: "Renamed" });
    expect(third.version).toBe(3);
    expect(third.name).toBe("Renamed");

    const frames = (await s.listFrames()).frames;
    expect(frames.length).toBe(1);
    const only = frames[0];
    if (only === undefined) throw new Error("the frame disappeared");
    expect(only.id).toBe(first.frameId);
    expect(only.version).toBe(3);
    expect(only).not.toHaveProperty("html");

    expect(await (await fetch(first.url)).text()).toContain("<p>v3</p>");
    expect(await s.json("/api/health")).toMatchObject({ frames: 1 });
  });
});

// ---------- d ----------

test("push_html with a bogus frameId is a tool error and creates nothing", async () => {
  await withServer(async (s) => {
    await s.pushHtml({ html: "<p>real</p>", name: "Real" });
    const before = (await s.listFrames()).frames.length;

    const result = await s.call("push_html", {
      frameId: "frm_000000000000",
      html: "<p>ghost</p>",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("unknown frame: frm_000000000000");

    expect((await s.listFrames()).frames.length).toBe(before);
    expect(await s.json("/api/health")).toMatchObject({ frames: before });
    expect((await fetch(`${s.base}/f/frm_000000000000`)).status).toBe(404);
  });
});

// ---------- e ----------

test("the product loop: a human pin posted over HTTP comes back through get_comments", async () => {
  await withServer(async (s) => {
    const frame = await s.pushHtml({ html: "<main>loop</main>", name: "Loop" });
    expect((await s.getComments({ frameId: frame.frameId })).comments).toEqual([]);

    const pinned = await s.humanComment(frame.frameId, 412, 233, "the heading is too tight");

    const read = await s.getComments({ frameId: frame.frameId });
    expect(read.comments.length).toBe(1);
    const seen = read.comments[0];
    if (seen === undefined) throw new Error("the human's comment never arrived");
    expect(seen.id).toBe(pinned.id);
    expect(seen.text).toBe("the heading is too tight");
    expect(seen.x).toBe(412);
    expect(seen.y).toBe(233);
    expect(seen.author).toBe("human");
    expect(seen.parentId).toBeNull();
    expect(seen.resolved).toBe(false);
    expect(seen.frameVersion).toBe(1);
    expect(read.cursor).toMatch(/^cur_\d+$/);

    // the human-readable half an agent actually reads
    expect(textOf(await s.call("get_comments", { frameId: frame.frameId }))).toContain(
      "the heading is too tight",
    );

    // a comment left on v2 records v2
    await s.pushHtml({ frameId: frame.frameId, html: "<main>loop v2</main>" });
    const onV2 = await s.humanComment(frame.frameId, 10, 20, "and now this");
    expect(onV2.frameVersion).toBe(2);
    expect(
      (await s.getComments({ frameId: frame.frameId })).comments.map((c) => c.frameVersion),
    ).toEqual([1, 2]);
  });
});

// ---------- f ----------

test("the cursor from get_comments returns only what is new on the next poll", async () => {
  await withServer(async (s) => {
    const frame = await s.pushHtml({ html: "<p>poll</p>", name: "Poll" });
    const beforeAnything = new Date().toISOString();
    const first = await s.humanComment(frame.frameId, 1, 1, "first note");

    const poll1 = await s.getComments({ frameId: frame.frameId });
    expect(poll1.comments.map((c) => c.id)).toEqual([first.id]);
    expect(poll1.cursor).toMatch(/^cur_\d+$/);

    // nothing new since the cursor
    const poll2 = await s.getComments({ frameId: frame.frameId, since: poll1.cursor });
    expect(poll2.comments).toEqual([]);
    // An empty page echoes the position back rather than resetting the agent to the feed start.
    expect(poll2.cursor).toBe(poll1.cursor);

    const second = await s.humanComment(frame.frameId, 2, 2, "second note");

    // the SAME cursor now yields exactly the new one
    const poll3 = await s.getComments({ frameId: frame.frameId, since: poll1.cursor });
    expect(poll3.comments.map((c) => c.id)).toEqual([second.id]);
    expect(poll3.comments.map((c) => c.text)).toEqual(["second note"]);
    expect(poll3.cursor).toMatch(/^cur_\d+$/);
    expect(poll3.cursor).not.toBe(poll1.cursor);

    // and the new cursor is caught up again
    expect((await s.getComments({ frameId: frame.frameId, since: poll3.cursor })).comments).toEqual(
      [],
    );

    // `since` also accepts an ISO timestamp, with the same strictly-after meaning
    const sinceStart = await s.getComments({ frameId: frame.frameId, since: beforeAnything });
    expect(sinceStart.comments.map((c) => c.id)).toEqual([first.id, second.id]);
    const sinceFirst = await s.getComments({ frameId: frame.frameId, since: first.createdAt });
    expect(sinceFirst.comments.map((c) => c.id)).not.toContain(first.id);
  });
});

// ---------- g ----------

test("reply_to_comment posts an agent reply into the human's thread", async () => {
  await withServer(async (s) => {
    const frame = await s.pushHtml({ html: "<p>thread</p>", name: "Thread" });
    const root = await s.humanComment(frame.frameId, 60, 90, "why is this blue?");

    const replied = await s.call("reply_to_comment", {
      commentId: root.id,
      text: "it inherits the link color — switching it to ink",
    });
    expect(replied.isError).toBeUndefined();
    expect(textOf(replied)).toContain(root.id);

    const thread = await s.getComments({ frameId: frame.frameId });
    expect(thread.comments.length).toBe(2);
    const reply = thread.comments.find((c) => c.parentId === root.id);
    if (reply === undefined) throw new Error("the agent reply is not in the thread");
    expect(reply.author).toBe("agent");
    expect(reply.text).toBe("it inherits the link color — switching it to ink");
    expect(reply.frameId).toBe(frame.frameId);
    expect(reply.x).toBe(root.x); // the reply pins to its parent
    expect(reply.y).toBe(root.y);

    // the human's browser sees the same thread over the REST route
    const listed = (await s.json(`/api/comments?frameId=${frame.frameId}`)) as {
      comments: Comment[];
    };
    expect(listed.comments.map((c) => c.id)).toEqual(thread.comments.map((c) => c.id));

    // only the agent's half, when asked for it
    const byAgent = await s.getComments({ frameId: frame.frameId, author: "agent" });
    expect(byAgent.comments.map((c) => c.id)).toEqual([reply.id]);

    // two comments on the frame, but only one piece of open feedback: the agent's own reply
    // is not something the human still owes an answer to, and the sidebar counts it the same way.
    expect(
      (await s.listFrames()).frames.map((f) => [f.commentCount, f.unresolvedCount]),
    ).toEqual([[2, 1]]);
  });
});

// ---------- h ----------

test("resolve_comment with a note resolves the root and posts the note as an agent reply", async () => {
  await withServer(async (s) => {
    const frame = await s.pushHtml({ html: "<p>resolve</p>", name: "Resolve" });
    const root = await s.humanComment(frame.frameId, 33, 44, "the CTA is buried");

    const resolved = await s.call("resolve_comment", {
      commentId: root.id,
      note: "moved it above the fold",
    });
    expect(resolved.isError).toBeUndefined();
    expect(textOf(resolved)).toContain(root.id);

    // the note is a real agent reply, not just prose in the tool output
    const all = await s.getComments({ frameId: frame.frameId, includeResolved: true });
    const note = all.comments.find((c) => c.parentId === root.id);
    if (note === undefined) throw new Error("resolve_comment's note was never posted as a reply");
    expect(note.author).toBe("agent");
    expect(note.text).toBe("moved it above the fold");

    const stored = all.comments.find((c) => c.id === root.id);
    if (stored === undefined) throw new Error("the resolved comment vanished entirely");
    expect(stored.resolved).toBe(true);

    // default poll no longer surfaces the resolved root
    const open = await s.getComments({ frameId: frame.frameId });
    expect(open.comments.map((c) => c.id)).not.toContain(root.id);
    expect(textOf(await s.call("get_comments", { frameId: frame.frameId }))).not.toContain(
      "the CTA is buried",
    );

    // ...but includeResolved does
    expect(all.comments.map((c) => c.id)).toContain(root.id);

    expect((await s.listFrames()).frames.map((f) => f.unresolvedCount)).toEqual([
      open.comments.length,
    ]);
  });
});

test("resolve_comment without a note resolves silently and adds no reply", async () => {
  await withServer(async (s) => {
    const frame = await s.pushHtml({ html: "<p>quiet</p>", name: "Quiet" });
    const root = await s.humanComment(frame.frameId, 5, 5, "typo");

    expect((await s.call("resolve_comment", { commentId: root.id })).isError).toBeUndefined();

    const all = await s.getComments({ frameId: frame.frameId, includeResolved: true });
    expect(all.comments.map((c) => c.id)).toEqual([root.id]);
    expect(all.comments.every((c) => c.resolved)).toBe(true);
    expect((await s.getComments({ frameId: frame.frameId })).comments).toEqual([]);
  });
});

// ---------- i ----------

test("delete_frame removes the frame and cascades its comments", async () => {
  await withServer(async (s) => {
    const kept = await s.pushHtml({ html: "<p>kept</p>", name: "Kept" });
    await s.humanComment(kept.frameId, 1, 1, "survivor");

    const doomed = await s.pushHtml({ html: "<p>doomed</p>", name: "Doomed" });
    const rootComment = await s.humanComment(doomed.frameId, 7, 7, "goes away");
    await s.call("reply_to_comment", { commentId: rootComment.id, text: "so does this" });
    expect(await s.json("/api/health")).toMatchObject({ frames: 2, comments: 3 });

    const deleted = await s.call("delete_frame", { frameId: doomed.frameId });
    expect(deleted.isError).toBeUndefined();
    expect(textOf(deleted)).toContain(doomed.frameId);

    // the frame is gone from every surface
    expect((await s.listFrames()).frames.map((f) => f.id)).toEqual([kept.frameId]);
    expect((await fetch(doomed.url)).status).toBe(404);
    expect((await fetch(`${s.base}/api/frames/${doomed.frameId}`)).status).toBe(404);

    // and its comments went with it, without touching the other frame's
    expect(await s.json("/api/health")).toMatchObject({ frames: 1, comments: 1 });
    const orphaned = await s.call("get_comments", { frameId: doomed.frameId });
    expect(orphaned.isError).toBe(true);
    expect(textOf(orphaned)).toContain(`unknown frame: ${doomed.frameId}`);
    expect((await s.getComments()).comments.map((c) => c.text)).toEqual(["survivor"]);

    const gone = await s.call("delete_frame", { frameId: doomed.frameId });
    expect(gone.isError).toBe(true);
    expect(textOf(gone)).toContain(`unknown frame: ${doomed.frameId}`);
  });
});

// ---------- lifecycle ----------

test("an unknown commentId is a loud error on every comment tool", async () => {
  await withServer(async (s) => {
    for (const [name, args] of [
      ["resolve_comment", { commentId: "cmt_000000000000" }],
      ["reply_to_comment", { commentId: "cmt_000000000000", text: "hi" }],
    ] as const) {
      const result = await s.call(name, args);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("unknown comment: cmt_000000000000");
    }

    const badSince = await s.call("get_comments", { since: "not-a-timestamp" });
    expect(badSince.isError).toBe(true);
    expect(textOf(badSince)).toContain("`since`");
  });
});

test("the child process and its port die with the client", async () => {
  let pid = -1;
  let base = "";
  await withServer(async (s) => {
    pid = s.pid;
    base = s.base;
    expect(isAlive(pid)).toBe(true);
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
  });

  expect(isAlive(pid)).toBe(false);
  expect(fetch(`${base}/api/health`)).rejects.toThrow();
}, LIFECYCLE_TEST_TIMEOUT_MS);

/**
 * SPEC's own topology: `serve` holds the human's canvas open while a separate agent
 * process speaks stdio, both on ~/.tracepaper/tracepaper.db. Without a busy_timeout SQLite
 * fails the second writer outright with "database is locked".
 */
test("two server processes share one db file without losing writes", async () => {
  const shared = mkdtempSync(join(tmpdir(), "tracepaper-shared-"));
  const dbPath = join(shared, "tracepaper.db");
  const each = 12;

  try {
    await withServer(async (a) => {
      await withServer(async (b) => {
        expect(a.base).not.toBe(b.base); // genuinely two processes

        const pushes: Promise<PushHtmlResult>[] = [];
        for (let i = 0; i < each; i++) {
          pushes.push(a.pushHtml({ html: `<p>a${i}</p>`, name: `A${i}` }));
          pushes.push(b.pushHtml({ html: `<p>b${i}</p>`, name: `B${i}` }));
        }
        const pushed = await Promise.all(pushes);
        expect(new Set(pushed.map((p) => p.frameId)).size).toBe(each * 2);

        // both processes, and both http servers, agree on every write
        expect((await a.listFrames()).frames.length).toBe(each * 2);
        expect((await b.listFrames()).frames.length).toBe(each * 2);
        expect(await a.json("/api/health")).toMatchObject({ frames: each * 2 });
        expect(await b.json("/api/health")).toMatchObject({ frames: each * 2 });

        // a comment written through one process is readable through the other
        const target = pushed[0];
        if (target === undefined) throw new Error("nothing was pushed");
        const note = await b.humanComment(target.frameId, 5, 5, "seen across processes");
        const seen = await a.getComments({ frameId: target.frameId });
        expect(seen.comments.map((c) => c.id)).toEqual([note.id]);
      }, { dbPath });
    }, { dbPath });
  } finally {
    rmSync(shared, { recursive: true, force: true });
  }
}, LIFECYCLE_TEST_TIMEOUT_MS);

/**
 * The SDK client masks a hung server: close() waits 2s on stdin EOF, then SIGTERMs.
 * A host that just closes the pipe would leak a process holding the port and the db,
 * so assert the exit happens on EOF alone — no signal is ever sent here.
 */
test("the server exits on stdin EOF alone, with no signal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tracepaper-eof-"));
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });

  const child = Bun.spawn([process.execPath, "run", ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: home,
      TRACEPAPER_PORT: "0",
      TRACEPAPER_DB: join(dir, "tracepaper.db"),
      TRACEPAPER_HOST: "127.0.0.1",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });

  try {
    // ~/.tracepaper/server.json is the documented discovery file; its arrival means fully booted.
    const serverJson = join(home, ".tracepaper", "server.json");
    const bootDeadline = Date.now() + EXIT_TIMEOUT_MS;
    while (!existsSync(serverJson)) {
      if (Date.now() > bootDeadline) throw new Error(`server never wrote ${serverJson}`);
      await Bun.sleep(20);
    }
    const record = (await Bun.file(serverJson).json()) as { url: string; pid: number };
    expect(record.pid).toBe(child.pid);
    expect((await fetch(`${record.url}/api/health`)).status).toBe(200);

    child.stdin.end();

    const exited = await Promise.race([
      child.exited,
      Bun.sleep(EXIT_TIMEOUT_MS).then(() => "timeout" as const),
    ]);
    if (exited === "timeout") {
      child.kill("SIGKILL");
      throw new Error("server ignored stdin EOF and had to be killed — it would leak the port");
    }
    expect(exited).toBe(0);
    expect(fetch(`${record.url}/api/health`)).rejects.toThrow();
  } finally {
    child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
}, LIFECYCLE_TEST_TIMEOUT_MS);

// ---------- i ----------

test("get_frame reads the current html back, so an update cannot silently discard it", async () => {
  await withServer(async (s) => {
    const original = "<main><h1>Pricing</h1><section>a lot of design</section></main>";
    const frame = await s.pushHtml({ html: original, name: "Pricing" });

    // The situation this exists for: a later session holds the frameId and nothing else.
    const read = await s.call("get_frame", { frameId: frame.frameId });
    expect(read.isError).toBeUndefined();
    expect(textOf(read)).toContain(original);

    const structuredFrame = read.structuredContent as { html: string; version: number };
    expect(structuredFrame.html).toBe(original);
    expect(structuredFrame.version).toBe(1);

    const missing = await s.call("get_frame", { frameId: "frm_000000000000" });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("list_frames");
  });
});

test("get_comments reports the frame a note sits on and whether it has gone stale", async () => {
  await withServer(async (s) => {
    const frame = await s.pushHtml({ html: "<p>v1</p>", name: "Stale", width: 800, height: 600 });
    await s.humanComment(frame.frameId, 100, 200, "move this up");

    const fresh = textOf(await s.call("get_comments", { frameId: frame.frameId }));
    expect(fresh).toContain('"Stale"');
    expect(fresh).toContain("800x600");
    expect(fresh).not.toContain("STALE");

    // The agent replaces the design the note was written about.
    await s.pushHtml({ frameId: frame.frameId, html: "<p>v2</p>" });
    const stale = textOf(await s.call("get_comments", { frameId: frame.frameId }));
    expect(stale).toContain("left on v1, frame is now v2 (STALE)");

    const structured = await s.getComments({ frameId: frame.frameId });
    expect(structured.frames.map((f) => [f.id, f.version])).toEqual([[frame.frameId, 2]]);
  });
});
