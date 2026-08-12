import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { Store } from "../src/store.ts";
import { COMMENT_ID_RE, FRAME_ID_RE } from "../src/ids.ts";
import type { Comment } from "../src/types.ts";

function store(): Store {
  return new Store(":memory:");
}

function seedFrame(s: Store, html = "<h1>hi</h1>") {
  return s.createFrame({ html });
}

function comment(s: Store, frameId: string, text: string): Comment {
  return s.createComment({ frameId, x: 10, y: 20, text });
}

describe("ids", () => {
  test("frames and comments use the spec id format", () => {
    const s = store();
    const frame = seedFrame(s);
    const c = comment(s, frame.id, "look here");
    expect(frame.id).toMatch(FRAME_ID_RE);
    expect(c.id).toMatch(COMMENT_ID_RE);
    expect(frame.id.slice(4)).toHaveLength(12);
  });

  test("ids are unique across many creates", () => {
    const s = store();
    const ids = new Set(Array.from({ length: 200 }, () => seedFrame(s).id));
    expect(ids.size).toBe(200);
  });
});

describe("frames", () => {
  test("first frame sits at the origin, later frames go to the right with a gap", () => {
    const s = store();
    const a = s.createFrame({ html: "<p>a</p>" });
    const b = s.createFrame({ html: "<p>b</p>" });
    const c = s.createFrame({ html: "<p>c</p>", width: 400 });

    expect(a.x).toBe(0);
    expect(a.y).toBe(0);
    expect(a.width).toBe(1280);
    expect(a.height).toBe(900);
    expect(b.x).toBe(a.x + a.width + 120);
    expect(b.y).toBe(0);
    expect(c.x).toBe(b.x + b.width + 120);
    expect(c.width).toBe(400);
  });

  test("unnamed frames get a slot label, named frames keep theirs", () => {
    const s = store();
    expect(s.createFrame({ html: "<p>a</p>" }).name).toBe("Frame 1");
    expect(s.createFrame({ html: "<p>b</p>", name: "Login" }).name).toBe("Login");
    expect(s.createFrame({ html: "<p>c</p>" }).name).toBe("Frame 3");
  });

  test("updateFrameHtml bumps version, replaces html, touches updatedAt", async () => {
    const s = store();
    const frame = s.createFrame({ html: "<p>v1</p>", name: "Home" });
    expect(frame.version).toBe(1);

    await Bun.sleep(2);
    const updated = s.updateFrameHtml(frame.id, "<p>v2</p>");
    expect(updated.version).toBe(2);
    expect(updated.html).toBe("<p>v2</p>");
    expect(updated.name).toBe("Home");
    expect(updated.createdAt).toBe(frame.createdAt);
    expect(updated.updatedAt > frame.updatedAt).toBe(true);

    const again = s.updateFrameHtml(frame.id, "<p>v3</p>", { name: "Home v3" });
    expect(again.version).toBe(3);
    expect(again.name).toBe("Home v3");
    expect(s.getFrame(frame.id)).toEqual(again);
  });

  test("updateFrameHtml on an unknown id throws instead of creating", () => {
    const s = store();
    expect(() => s.updateFrameHtml("frm_000000000000", "<p>x</p>")).toThrow(
      "unknown frame: frm_000000000000",
    );
    expect(s.counts().frames).toBe(0);
  });

  test("getFrame and deleteFrame throw on unknown ids", () => {
    const s = store();
    expect(() => s.getFrame("frm_deadbeef0000")).toThrow("unknown frame");
    expect(() => s.deleteFrame("frm_deadbeef0000")).toThrow("unknown frame");
  });

  test("listFrames omits html and reports comment counts", () => {
    const s = store();
    const a = s.createFrame({ html: "<p>a</p>", name: "A" });
    const b = s.createFrame({ html: "<p>b</p>", name: "B" });
    const first = comment(s, a.id, "one");
    comment(s, a.id, "two");
    comment(s, b.id, "three");
    s.updateComment(first.id, { resolved: true });

    const frames = s.listFrames();
    expect(frames.map((f) => f.name)).toEqual(["A", "B"]);
    expect(frames[0]).not.toHaveProperty("html");
    expect(frames[0]?.commentCount).toBe(2);
    expect(frames[0]?.unresolvedCount).toBe(1);
    expect(frames[1]?.commentCount).toBe(1);
    expect(frames[1]?.unresolvedCount).toBe(1);
  });

  test("deleting a frame cascades to its comments and leaves others alone", () => {
    const s = store();
    const a = seedFrame(s);
    const b = seedFrame(s);
    const doomed = comment(s, a.id, "goes away");
    const reply = s.createComment({
      frameId: a.id,
      x: 1,
      y: 2,
      text: "reply",
      parentId: doomed.id,
      author: "agent",
    });
    const survivor = comment(s, b.id, "stays");

    expect(s.counts()).toEqual({ frames: 2, comments: 3 });
    s.deleteFrame(a.id);

    expect(s.counts()).toEqual({ frames: 1, comments: 1 });
    expect(() => s.getComment(doomed.id)).toThrow("unknown comment");
    expect(() => s.getComment(reply.id)).toThrow("unknown comment");
    expect(s.getComment(survivor.id).id).toBe(survivor.id);
  });
});

describe("comments", () => {
  test("stamps the frame version at the time of the comment", () => {
    const s = store();
    const frame = seedFrame(s);
    const onV1 = comment(s, frame.id, "on v1");
    s.updateFrameHtml(frame.id, "<p>v2</p>");
    const onV2 = comment(s, frame.id, "on v2");

    expect(onV1.frameVersion).toBe(1);
    expect(onV2.frameVersion).toBe(2);
  });

  test("defaults author to human and parentId to null", () => {
    const s = store();
    const frame = seedFrame(s);
    const c = comment(s, frame.id, "hello");
    expect(c.author).toBe("human");
    expect(c.parentId).toBe(null);
    expect(c.resolved).toBe(false);
  });

  test("threading requires a real parent in the same frame", () => {
    const s = store();
    const a = seedFrame(s);
    const b = seedFrame(s);
    const root = comment(s, a.id, "root");

    const reply = s.createComment({
      frameId: a.id,
      x: 0,
      y: 0,
      text: "reply",
      parentId: root.id,
      author: "agent",
    });
    expect(reply.parentId).toBe(root.id);

    expect(() =>
      s.createComment({ frameId: a.id, x: 0, y: 0, text: "x", parentId: "cmt_000000000000" }),
    ).toThrow("unknown comment");
    expect(() =>
      s.createComment({ frameId: b.id, x: 0, y: 0, text: "x", parentId: root.id }),
    ).toThrow("belongs to frame");
  });

  test("createComment on an unknown frame throws", () => {
    const s = store();
    expect(() => s.createComment({ frameId: "frm_000000000000", x: 0, y: 0, text: "x" })).toThrow(
      "unknown frame",
    );
  });

  test("updateComment patches, throws on unknown id and empty patch", () => {
    const s = store();
    const frame = seedFrame(s);
    const c = comment(s, frame.id, "typo");

    const [edited] = s.updateComment(c.id, { text: "fixed" });
    expect(edited?.text).toBe("fixed");
    expect(edited?.resolved).toBe(false);

    // A patch that names only `resolved` must leave the text alone.
    const [resolved] = s.updateComment(c.id, { resolved: true });
    expect(resolved?.resolved).toBe(true);
    expect(resolved?.text).toBe("fixed");
    expect(s.getComment(c.id)).toEqual(resolved!);

    expect(() => s.updateComment("cmt_000000000000", { resolved: true })).toThrow(
      "unknown comment",
    );
    expect(() => s.updateComment(c.id, {})).toThrow("empty patch");
  });

  test("deleteComment removes it and throws when unknown", () => {
    const s = store();
    const frame = seedFrame(s);
    const c = comment(s, frame.id, "bye");
    s.deleteComment(c.id);
    expect(s.counts().comments).toBe(0);
    expect(() => s.deleteComment(c.id)).toThrow("unknown comment");
  });
});

describe("listComments filtering", () => {
  test("excludes resolved by default, includes them on request", () => {
    const s = store();
    const frame = seedFrame(s);
    const open = comment(s, frame.id, "open");
    const done = comment(s, frame.id, "done");
    s.updateComment(done.id, { resolved: true });

    expect(s.listComments({}).map((c) => c.id)).toEqual([open.id]);
    expect(s.listComments({ includeResolved: true }).map((c) => c.id)).toEqual([open.id, done.id]);
  });

  test("filters by frame and author", () => {
    const s = store();
    const a = seedFrame(s);
    const b = seedFrame(s);
    const human = comment(s, a.id, "human note");
    const agent = s.createComment({
      frameId: a.id,
      x: 0,
      y: 0,
      text: "agent reply",
      parentId: human.id,
      author: "agent",
    });
    const other = comment(s, b.id, "other frame");

    expect(s.listComments({ frameId: a.id }).map((c) => c.id)).toEqual([human.id, agent.id]);
    expect(s.listComments({ frameId: b.id }).map((c) => c.id)).toEqual([other.id]);
    expect(s.listComments({ author: "agent" }).map((c) => c.id)).toEqual([agent.id]);
    expect(() => s.listComments({ frameId: "frm_000000000000" })).toThrow("unknown frame");
  });

  test("returns newest-last", () => {
    const s = store();
    const frame = seedFrame(s);
    const ids = Array.from({ length: 5 }, (_, i) => comment(s, frame.id, `c${i}`).id);
    expect(s.listComments({ frameId: frame.id }).map((c) => c.id)).toEqual(ids);
  });
});

describe("`since` cursor", () => {
  test("accepts an ISO timestamp and returns strictly-after comments", async () => {
    const s = store();
    const frame = seedFrame(s);
    const first = comment(s, frame.id, "first");
    await Bun.sleep(5);
    const second = comment(s, frame.id, "second");

    expect(s.listComments({ since: first.createdAt }).map((c) => c.id)).toEqual([second.id]);
    expect(s.listComments({ since: second.createdAt })).toEqual([]);
    expect(s.listComments({ since: new Date(0).toISOString() }).map((c) => c.id)).toEqual([
      first.id,
      second.id,
    ]);
  });

  test("accepts a comment id and never drops or repeats same-millisecond comments", () => {
    const s = store();
    const frame = seedFrame(s);
    const created = Array.from({ length: 40 }, (_, i) => comment(s, frame.id, `c${i}`));
    const sameMs = new Set(created.map((c) => c.createdAt)).size < created.length;
    expect(sameMs).toBe(true); // the tight loop must actually collide, or this proves nothing

    for (let i = 0; i < created.length; i++) {
      const cursor = created[i];
      if (cursor === undefined) throw new Error(`missing seeded comment at ${i}`);
      const after = s.listComments({ since: cursor.id });
      expect(after.map((c) => c.id)).toEqual(created.slice(i + 1).map((c) => c.id));
    }
  });

  test("incremental polling with the returned cursor sees every comment exactly once", () => {
    const s = store();
    const frame = seedFrame(s);
    const expected: string[] = [];
    const seen: string[] = [];
    let cursor: string | undefined = undefined;

    for (let round = 0; round < 6; round++) {
      for (let i = 0; i < 7; i++) expected.push(comment(s, frame.id, `r${round}-${i}`).id);
      const batch: Comment[] = s.listComments({ frameId: frame.id, since: cursor });
      for (const c of batch) seen.push(c.id);
      const newest = batch.at(-1);
      if (newest !== undefined) cursor = newest.id;
    }

    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(seen.length);
  });

  test("an unknown comment id in `since` throws", () => {
    const s = store();
    const frame = seedFrame(s);
    comment(s, frame.id, "x");
    expect(() => s.listComments({ since: "cmt_000000000000" })).toThrow(
      "unknown comment id in `since`",
    );
  });

  test("garbage in `since` throws", () => {
    const s = store();
    expect(() => s.listComments({ since: "yesterday-ish" })).toThrow("must be an ISO timestamp");
  });
});

describe("counts", () => {
  test("reports live totals", () => {
    const s = store();
    expect(s.counts()).toEqual({ frames: 0, comments: 0 });
    const frame = seedFrame(s);
    comment(s, frame.id, "a");
    comment(s, frame.id, "b");
    expect(s.counts()).toEqual({ frames: 1, comments: 2 });
  });
});

describe("persistence", () => {
  test("survives reopening a file-backed db", () => {
    const path = `${import.meta.dir}/../.tmp-store-test-${Date.now()}.db`;
    const first = new Store(path);
    const frame = first.createFrame({ html: "<p>persisted</p>", name: "Kept" });
    comment(first, frame.id, "still here");
    first.close();

    const second = new Store(path);
    expect(second.getFrame(frame.id).name).toBe("Kept");
    expect(second.listComments({ frameId: frame.id })).toHaveLength(1);
    second.close();

    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
  });
});

// Regressions for the review findings — each of these shipped broken once.
describe("threads", () => {
  test("replying to a reply joins the thread instead of nesting under it", () => {
    const s = store();
    const frame = seedFrame(s);
    const root = comment(s, frame.id, "why is this blue?");
    const humanReply = s.createComment({
      frameId: frame.id,
      x: root.x,
      y: root.y,
      text: "and the padding is off",
      parentId: root.id,
    });
    // The agent naturally replies to the newest message, which is itself a reply. A grandchild
    // would render nowhere: the canvas draws roots as pins and only direct replies inside them.
    const agentReply = s.createComment({
      frameId: frame.id,
      x: root.x,
      y: root.y,
      text: "switching it to ink and tightening the padding",
      parentId: humanReply.id,
      author: "agent",
    });

    expect(agentReply.parentId).toBe(root.id);
    const inThread = s.listComments({ frameId: frame.id }).filter((c) => c.parentId === root.id);
    expect(inThread.map((c) => c.id)).toEqual([humanReply.id, agentReply.id]);
    s.close();
  });

  test("resolving a thread resolves its replies, so the poll goes quiet", () => {
    const s = store();
    const frame = seedFrame(s);
    const root = comment(s, frame.id, "too small");
    s.createComment({
      frameId: frame.id,
      x: root.x,
      y: root.y,
      text: "bumped to 16px",
      parentId: root.id,
      author: "agent",
    });

    s.updateComment(root.id, { resolved: true });
    expect(s.listComments()).toHaveLength(0);
    expect(s.listComments({ includeResolved: true })).toHaveLength(2);
    s.close();
  });

  test("unresolvedCount counts open threads, not the agent's own replies", () => {
    const s = store();
    const frame = seedFrame(s);
    const root = comment(s, frame.id, "open question");
    s.createComment({
      frameId: frame.id,
      x: root.x,
      y: root.y,
      text: "on it",
      parentId: root.id,
      author: "agent",
    });

    const [summary] = s.listFrames();
    if (summary === undefined) throw new Error("no frame summary");
    expect([summary.commentCount, summary.unresolvedCount]).toEqual([2, 1]);

    s.updateComment(root.id, { resolved: true });
    const [afterResolve] = s.listFrames();
    if (afterResolve === undefined) throw new Error("no frame summary");
    expect(afterResolve.unresolvedCount).toBe(0);
    s.close();
  });
});

describe("cursor durability", () => {
  test("a cursor whose comment the human deleted keeps working", () => {
    const s = store();
    const frame = seedFrame(s);
    const first = comment(s, frame.id, "first");
    s.deleteComment(first.id);

    // The agent is still holding `first.id` from an earlier poll. It must not be stranded.
    expect(s.listComments({ since: first.id })).toHaveLength(0);
    const second = comment(s, frame.id, "second");
    expect(s.listComments({ since: first.id }).map((c) => c.id)).toEqual([second.id]);
    s.close();
  });

  test("deleting a comment hides it and its replies from every read", () => {
    const s = store();
    const frame = seedFrame(s);
    const root = comment(s, frame.id, "root");
    s.createComment({ frameId: frame.id, x: 1, y: 2, text: "reply", parentId: root.id });

    s.deleteComment(root.id);
    expect(s.listComments({ includeResolved: true })).toHaveLength(0);
    expect(s.counts().comments).toBe(0);
    expect(() => s.getComment(root.id)).toThrow(/unknown comment/);
    s.close();
  });

  test("reopening a resolved comment re-delivers it to a cursor past it", () => {
    const s = store();
    const frame = seedFrame(s);
    const a = comment(s, frame.id, "a");
    const b = comment(s, frame.id, "b");
    s.updateComment(a.id, { resolved: true });

    // Agent polls, ends up holding b as its cursor.
    expect(s.listComments().map((c) => c.id)).toEqual([b.id]);
    // Human re-raises a. Cursor rides updatedSeq, so the reopen lands after b.
    s.updateComment(a.id, { resolved: false });
    expect(s.listComments({ since: b.id }).map((c) => c.id)).toEqual([a.id]);
    s.close();
  });

  test("an ISO `since` means strictly-after-that-instant, and the id cursor is the exact one", async () => {
    const s = store();
    const frame = seedFrame(s);
    const first = comment(s, frame.id, "first");
    const second = comment(s, frame.id, "second");
    // Force the millisecond collision two quick writes produce in practice.
    s.db.query("UPDATE comments SET createdAt = ? WHERE id = ?").run(first.createdAt, second.id);

    // A timestamp cannot separate two comments inside one millisecond — neither is "after" it.
    // What matters is that the answer is consistent and never claims to have delivered them.
    expect(s.listComments({ since: first.createdAt })).toHaveLength(0);
    // The id cursor — the one get_comments hands back — separates them exactly.
    expect(s.listComments({ since: first.id }).map((c) => c.id)).toEqual([second.id]);

    await Bun.sleep(2); // a genuinely later millisecond, not another collision
    const later = comment(s, frame.id, "later");
    expect(s.listComments({ since: first.createdAt }).map((c) => c.id)).toEqual([later.id]);
    s.close();
  });
});

describe("frame resizing", () => {
  test("push_html can resize a frame in place instead of silently keeping the old size", () => {
    const s = store();
    const frame = s.createFrame({ html: "<p>desktop</p>", width: 1280, height: 900 });
    const mobile = s.updateFrameHtml(frame.id, "<p>mobile</p>", { width: 390, height: 844 });

    expect([mobile.width, mobile.height]).toEqual([390, 844]);
    expect(s.getFrame(frame.id).width).toBe(390);
    // Omitted dimensions leave the frame alone.
    const same = s.updateFrameHtml(frame.id, "<p>again</p>");
    expect([same.width, same.height]).toEqual([390, 844]);
    s.close();
  });
});

describe("cursor is a feed position, not a row pointer", () => {
  test("mutating the cursor comment cannot skip past what the human wrote meanwhile", () => {
    const s = store();
    const frame = seedFrame(s);
    const c1 = comment(s, frame.id, "first");
    const c2 = comment(s, frame.id, "second");

    // Agent polls and keeps the cursor it was handed.
    const seen = s.listComments({ frameId: frame.id });
    expect(seen.map((c) => c.id)).toEqual([c1.id, c2.id]);
    const cursor = s.cursorOf(seen);
    if (cursor === null) throw new Error("expected a cursor");

    // Human types while the agent works.
    const c3 = comment(s, frame.id, "and the footer is wrong");

    // Agent closes out what it had. Resolving c2 bumps its updatedSeq above c3 — with an
    // id-based cursor this is exactly where c3 became permanently invisible.
    s.updateComment(c1.id, { resolved: true });
    s.updateComment(c2.id, { resolved: true });

    expect(s.listComments({ frameId: frame.id, since: cursor }).map((c) => c.id)).toEqual([c3.id]);
    s.close();
  });

  test("a cursor survives deleting, editing and reopening the comments it covered", () => {
    const s = store();
    const frame = seedFrame(s);
    const a = comment(s, frame.id, "a");
    const cursor = s.cursorOf(s.listComments({ frameId: frame.id }));
    if (cursor === null) throw new Error("expected a cursor");

    s.updateComment(a.id, { resolved: true });
    s.updateComment(a.id, { resolved: false }); // human re-raises it
    expect(s.listComments({ frameId: frame.id, since: cursor }).map((c) => c.id)).toEqual([a.id]);

    const b = comment(s, frame.id, "b");
    const cursor2 = s.cursorOf(s.listComments({ frameId: frame.id, since: cursor }));
    if (cursor2 === null) throw new Error("expected a second cursor");
    s.deleteComment(b.id); // the comment the cursor covered is gone
    const c = comment(s, frame.id, "c");
    expect(s.listComments({ frameId: frame.id, since: cursor2 }).map((c) => c.id)).toEqual([c.id]);
    s.close();
  });

  test("a malformed cursor fails loudly instead of silently returning everything", () => {
    const s = store();
    expect(() => s.listComments({ since: "cur_nope" })).toThrow(/malformed cursor/);
    s.close();
  });
});

describe("concurrent writers", () => {
  test("a patch that names only resolved does not write back stale text", () => {
    const s = store();
    const frame = seedFrame(s);
    const c = comment(s, frame.id, "v1");

    s.updateComment(c.id, { text: "v2" });
    s.updateComment(c.id, { resolved: true });
    // Writing both columns from one stale read is how a concurrent resolve ate human edits.
    expect(s.getComment(c.id).text).toBe("v2");
    s.close();
  });

  test("updateComment reports every row it changed, replies included", () => {
    const s = store();
    const frame = seedFrame(s);
    const root = comment(s, frame.id, "root");
    const reply = s.createComment({
      frameId: frame.id,
      x: 1,
      y: 2,
      text: "on it",
      parentId: root.id,
      author: "agent",
    });

    // The canvas listens to these events; a reply left out stays visibly open in a closed thread.
    const changed = s.updateComment(root.id, { resolved: true });
    expect(changed.map((c) => c.id).sort()).toEqual([root.id, reply.id].sort());
    expect(changed.every((c) => c.resolved)).toBe(true);
    s.close();
  });

  test("frame html updates bump the version in SQL, never from a stale read", () => {
    const s = store();
    const frame = s.createFrame({ html: "<p>1</p>" });
    const a = s.updateFrameHtml(frame.id, "<p>2</p>");
    const b = s.updateFrameHtml(frame.id, "<p>3</p>");
    expect([a.version, b.version]).toEqual([2, 3]);
    expect(s.getFrame(frame.id).html).toBe("<p>3</p>");
    s.close();
  });
});

describe("size limits", () => {
  test("oversized html and comment text are refused", () => {
    const s = store();
    const frame = seedFrame(s);
    expect(() => s.createFrame({ html: "x".repeat(5_000_001) })).toThrow();
    expect(() => s.createComment({ frameId: frame.id, x: 0, y: 0, text: "x".repeat(16_001) })).toThrow();
    expect(() => s.createFrame({ html: "" })).toThrow(/must not be empty/);
    s.close();
  });
});

describe("frame layout", () => {
  test("auto-placement wraps onto a new row instead of one endless strip", () => {
    const s = store();
    // 1280-wide frames: three fit in a row, the fourth must wrap.
    const a = s.createFrame({ html: "<p>a</p>" });
    const b = s.createFrame({ html: "<p>b</p>" });
    const c = s.createFrame({ html: "<p>c</p>" });
    const d = s.createFrame({ html: "<p>d</p>" });

    expect([a.x, a.y]).toEqual([0, 0]);
    expect(b.y).toBe(0);
    expect(c.y).toBe(0);
    expect(b.x).toBeGreaterThan(a.x);
    expect(c.x).toBeGreaterThan(b.x);

    expect(d.x).toBe(0);
    expect(d.y).toBeGreaterThan(0);
    expect(d.y).toBe(a.height + 120);
    s.close();
  });

  test("an explicit x/y is honoured exactly, and later frames continue from that row", () => {
    const s = store();
    const placed = s.createFrame({ html: "<p>placed</p>", x: 640, y: 2000, width: 400 });
    expect([placed.x, placed.y]).toEqual([640, 2000]);

    const next = s.createFrame({ html: "<p>next</p>", width: 400 });
    expect(next.y).toBe(2000);
    expect(next.x).toBe(640 + 400 + 120);
    s.close();
  });

  test("a frame wider than the row budget still lands rather than looping", () => {
    const s = store();
    s.createFrame({ html: "<p>a</p>" });
    const huge = s.createFrame({ html: "<p>huge</p>", width: 9000 });
    expect(huge.x).toBe(0);
    expect(huge.y).toBeGreaterThan(0);
    s.close();
  });
});
