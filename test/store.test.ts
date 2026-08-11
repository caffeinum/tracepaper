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

    const again = s.updateFrameHtml(frame.id, "<p>v3</p>", "Home v3");
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

    const edited = s.updateComment(c.id, { text: "fixed" });
    expect(edited.text).toBe("fixed");
    expect(edited.resolved).toBe(false);

    const resolved = s.updateComment(c.id, { resolved: true });
    expect(resolved.resolved).toBe(true);
    expect(resolved.text).toBe("fixed");
    expect(s.getComment(c.id)).toEqual(resolved);

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
