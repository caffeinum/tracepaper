import { z } from "zod";
import { Database } from "bun:sqlite";
import { isCommentId, newCommentId, newFrameId } from "./ids.ts";
import {
  CommentSchema,
  CreateCommentInputSchema,
  CreateFrameInputSchema,
  FrameSchema,
  FrameSummarySchema,
  UpdateCommentPatchSchema,
  type Comment,
  type CommentFilter,
  type CreateCommentInput,
  type CreateFrameInput,
  type Frame,
  type FrameSummary,
  type UpdateCommentPatch,
} from "./types.ts";

/** Fields `push_html` may change on an existing frame. Anything omitted is left alone. */
export type UpdateFramePatch = {
  name?: string;
  width?: number;
  height?: number;
};

const FRAME_GAP = 120;
/** A row wraps past this world width — roughly three 1280px frames side by side. */
const ROW_MAX_WIDTH = 4400;
/** Marks an opaque feed position, so `since` can tell a cursor from a comment id. */
export const CURSOR_PREFIX = "cur_";
/**
 * How long a write waits for another process's lock before failing loudly.
 *
 * Every write also runs `.immediate()` — BEGIN IMMEDIATE. A deferred transaction takes the write
 * lock only when it first writes, so two processes that both begin, both read, then both try to
 * write deadlock and one gets SQLITE_BUSY straight away; this timeout cannot rescue that, because
 * backing off would mean discarding reads the transaction already made. Taking the lock up front
 * makes the second writer wait instead of fail.
 */
const BUSY_TIMEOUT_MS = 5000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS frames (
  id        TEXT PRIMARY KEY,
  name      TEXT    NOT NULL,
  html      TEXT    NOT NULL,
  width     REAL    NOT NULL,
  height    REAL    NOT NULL,
  x         REAL    NOT NULL,
  y         REAL    NOT NULL,
  version   INTEGER NOT NULL,
  repo      TEXT    NOT NULL DEFAULT 'default',
  createdBy TEXT,
  -- 'html' (iframe frame), 'text' (title block) or 'section' (outlined region). See CreateFrameInput.
  kind      TEXT    NOT NULL DEFAULT 'html',
  -- world-px font size, only used by kind 'text'; null otherwise.
  fontSize  REAL,
  createdAt TEXT    NOT NULL,
  updatedAt TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS comments (
  seq          INTEGER PRIMARY KEY,
  updatedSeq   INTEGER NOT NULL,
  id           TEXT    NOT NULL UNIQUE,
  frameId      TEXT    NOT NULL REFERENCES frames(id) ON DELETE CASCADE,
  x            REAL    NOT NULL,
  y            REAL    NOT NULL,
  text         TEXT    NOT NULL,
  author       TEXT    NOT NULL,
  parentId     TEXT             REFERENCES comments(id) ON DELETE CASCADE,
  resolved     INTEGER NOT NULL,
  frameVersion INTEGER NOT NULL,
  createdAt    TEXT    NOT NULL,
  deletedAt    TEXT
);

CREATE TABLE IF NOT EXISTS counters (
  name  TEXT    PRIMARY KEY,
  value INTEGER NOT NULL
);

`;

// Indexes are created after migrate(): CREATE TABLE IF NOT EXISTS is a no-op on a db written by
// an older build, so a column this indexes may not exist until the ALTER has run.
const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_comments_frameId    ON comments(frameId);
CREATE INDEX IF NOT EXISTS idx_comments_createdAt  ON comments(createdAt);
CREATE INDEX IF NOT EXISTS idx_comments_updatedSeq ON comments(updatedSeq);
CREATE INDEX IF NOT EXISTS idx_frames_repo         ON frames(repo);
`;

type FrameRow = {
  id: string;
  name: string;
  html: string;
  width: number;
  height: number;
  x: number;
  y: number;
  version: number;
  repo: string;
  createdBy: string | null;
  kind: string;
  fontSize: number | null;
  createdAt: string;
  updatedAt: string;
};

type FrameSummaryRow = Omit<FrameRow, "html"> & {
  commentCount: number;
  unresolvedCount: number;
};

type CommentRow = {
  seq: number;
  updatedSeq: number;
  id: string;
  frameId: string;
  x: number;
  y: number;
  text: string;
  author: string;
  parentId: string | null;
  resolved: number;
  frameVersion: number;
  createdAt: string;
  deletedAt: string | null;
};

/** Columns the data model exposes; seq/updatedSeq/deletedAt are internal bookkeeping. */
const COMMENT_COLUMNS =
  "id, frameId, x, y, text, author, parentId, resolved, frameVersion, createdAt";

type Box = { x: number; y: number; width: number; height: number };

function overlaps(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

/**
 * Finds a spot that overlaps nothing already on the canvas.
 *
 * The previous version tracked only "the last row" and its tallest frame, which quietly breaks
 * the moment the canvas stops being append-only: resize a frame, or place one explicitly with
 * x/y, and later auto-placements are computed against stale row geometry and land on top of
 * existing work. Checking every frame is O(n) per placement on a canvas of tens of frames —
 * far cheaper than a human untangling a pile of overlapping mockups.
 *
 * Shelf packing: walk candidate rows top-down, slide right past whatever is in the way, and drop
 * to the next row when the shelf is full.
 */
function findFreeSlot(boxes: Box[], width: number, height: number): { x: number; y: number } {
  const rows = [0, ...boxes.map((b) => b.y + b.height + FRAME_GAP)].sort((a, b) => a - b);
  const seen = new Set<number>();

  for (const y of rows) {
    if (seen.has(y)) continue;
    seen.add(y);

    let x = 0;
    // A frame wider than the shelf still has to land somewhere, so only wrap when the row has
    // something in it already — otherwise an oversized frame would skip every row forever.
    while (x === 0 || x + width <= ROW_MAX_WIDTH) {
      const candidate = { x, y, width, height };
      const blocking = boxes.filter((b) => overlaps(candidate, b));
      if (blocking.length === 0) return { x, y };
      const nextX = Math.max(...blocking.map((b) => b.x + b.width)) + FRAME_GAP;
      if (nextX <= x) break; // cannot make progress; try the next row
      x = nextX;
    }
  }

  // Every shelf is occupied: start a fresh one below everything.
  const floor = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: 0, y: floor + FRAME_GAP };
}

function nowIso(): string {
  return new Date().toISOString();
}

function toComment(row: CommentRow): Comment {
  return CommentSchema.parse({ ...row, resolved: row.resolved === 1 });
}

export class Store {
  readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA foreign_keys = ON");
    // `serve` (the human's canvas) and a stdio agent are separate processes on one db file,
    // so a writer must wait for the lock instead of failing the call outright.
    this.db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA);
    this.migrate();
    this.db.exec(INDEXES);
  }

  /**
   * Brings a db written by an older build up to the current schema. Columns are added
   * rather than recreated so an existing canvas keeps its frames and comments.
   */
  private migrate(): void {
    const frameColumns = new Set(
      (this.db.query("PRAGMA table_info(frames)").all() as { name: string }[]).map((c) => c.name),
    );
    // Pre-repo frames land on 'default'; a NOT NULL DEFAULT backfills the existing rows in place.
    if (!frameColumns.has("repo")) {
      this.db.exec("ALTER TABLE frames ADD COLUMN repo TEXT NOT NULL DEFAULT 'default'");
    }
    if (!frameColumns.has("createdBy")) {
      this.db.exec("ALTER TABLE frames ADD COLUMN createdBy TEXT");
    }
    // Pre-kind frames were all iframe frames; a NOT NULL DEFAULT backfills them to 'html' in place.
    if (!frameColumns.has("kind")) {
      this.db.exec("ALTER TABLE frames ADD COLUMN kind TEXT NOT NULL DEFAULT 'html'");
    }
    if (!frameColumns.has("fontSize")) {
      this.db.exec("ALTER TABLE frames ADD COLUMN fontSize REAL");
    }

    const columns = new Set(
      (this.db.query("PRAGMA table_info(comments)").all() as { name: string }[]).map((c) => c.name),
    );
    if (!columns.has("updatedSeq")) {
      this.db.exec("ALTER TABLE comments ADD COLUMN updatedSeq INTEGER NOT NULL DEFAULT 0");
      this.db.exec("UPDATE comments SET updatedSeq = seq WHERE updatedSeq = 0");
    }
    if (!columns.has("deletedAt")) {
      this.db.exec("ALTER TABLE comments ADD COLUMN deletedAt TEXT");
    }

    const seeded = this.db.query("SELECT value FROM counters WHERE name = 'comment_tick'").get();
    if (seeded === null) {
      const row = this.db
        .query("SELECT COALESCE(MAX(MAX(seq), MAX(updatedSeq)), 0) AS tick FROM comments")
        .get() as { tick: number };
      this.db
        .query("INSERT INTO counters (name, value) VALUES ('comment_tick', $tick)")
        .run({ $tick: row.tick });
    }
  }

  /**
   * One monotonic counter feeds both `seq` (creation) and `updatedSeq` (last mutation), so
   * the two stay comparable and a cursor can ride `updatedSeq` alone. Any mutation — resolve,
   * reopen, edit — lifts a comment above every cursor handed out before it, which is what
   * makes a re-opened thread reach an agent that is polling with `since`.
   */
  private nextTick(): number {
    const row = this.db
      .query("UPDATE counters SET value = value + 1 WHERE name = 'comment_tick' RETURNING value")
      .get() as { value: number } | null;
    if (row === null) throw new Error("comment_tick counter is missing from the database");
    return row.value;
  }

  close(): void {
    this.db.close();
  }

  // ---------- frames ----------

  createFrame(input: CreateFrameInput): Frame {
    const { html, name, width, height, x, y, repo, createdBy, kind, fontSize } =
      CreateFrameInputSchema.parse(input);
    // The layout slot and the slot name are both read-then-written. Two processes on one db
    // otherwise pick the same x and the same "Frame N", stacking one frame invisibly on another.
    return this.db
      .transaction(() =>
        this.insertFrame({ html, name, width, height, x, y, repo, createdBy, kind, fontSize }),
      )
      .immediate();
  }

  private insertFrame(input: {
    html: string;
    name: string | undefined;
    width: number;
    height: number;
    x?: number | undefined;
    y?: number | undefined;
    repo: string;
    createdBy?: string | undefined;
    kind: "html" | "text" | "section";
    fontSize?: number | undefined;
  }): Frame {
    const { html, name, width, height, repo, kind } = input;
    const at = nowIso();
    // Auto-placement only considers frames in the same repo, so canvases lay out independently.
    const auto = this.nextFramePosition(width, height, repo);
    const frame: Frame = {
      id: newFrameId(),
      name: name === undefined ? this.nextFrameName(repo) : name,
      html,
      width,
      height,
      x: input.x === undefined ? auto.x : input.x,
      y: input.y === undefined ? auto.y : input.y,
      version: 1,
      repo,
      createdBy: input.createdBy ?? null,
      kind,
      fontSize: input.fontSize ?? null,
      createdAt: at,
      updatedAt: at,
    };

    this.db
      .query(
        `INSERT INTO frames (id, name, html, width, height, x, y, version, repo, createdBy, kind, fontSize, createdAt, updatedAt)
         VALUES ($id, $name, $html, $width, $height, $x, $y, $version, $repo, $createdBy, $kind, $fontSize, $createdAt, $updatedAt)`,
      )
      .run({
        $id: frame.id,
        $name: frame.name,
        $html: frame.html,
        $width: frame.width,
        $height: frame.height,
        $x: frame.x,
        $y: frame.y,
        $version: frame.version,
        $repo: frame.repo,
        $createdBy: frame.createdBy,
        $kind: frame.kind,
        $fontSize: frame.fontSize,
        $createdAt: frame.createdAt,
        $updatedAt: frame.updatedAt,
      });

    return frame;
  }

  updateFrameHtml(frameId: string, html: string, patch: UpdateFramePatch = {}): Frame {
    return this.db.transaction(() => {
      this.getFrame(frameId); // throws on an unknown id before anything is written
      // `version = version + 1` in SQL, and only the named columns written, so two concurrent
      // pushes to one frame cannot both read version v and both write v+1, losing one html.
      const row = this.db
        .query(
          `UPDATE frames
              SET html      = $html,
                  name      = COALESCE($name, name),
                  width     = COALESCE($width, width),
                  height    = COALESCE($height, height),
                  version   = version + 1,
                  updatedAt = $updatedAt
            WHERE id = $id
        RETURNING *`,
        )
        .get({
          $html: html,
          $name: patch.name ?? null,
          $width: patch.width ?? null,
          $height: patch.height ?? null,
          $updatedAt: nowIso(),
          $id: frameId,
        }) as FrameRow | null;
      if (row === null) throw new Error(`unknown frame: ${frameId} — call list_frames for the current frame ids, or omit frameId to create a new frame.`);
      return FrameSchema.parse(row);
    }).immediate();
  }

  getFrame(id: string): Frame {
    const row = this.db.query("SELECT * FROM frames WHERE id = ?").get(id) as FrameRow | null;
    if (row === null) throw new Error(`unknown frame: ${id} — call list_frames for the current frame ids, or omit frameId to create a new frame.`);
    return FrameSchema.parse(row);
  }

  hasFrame(id: string): boolean {
    return this.db.query("SELECT 1 FROM frames WHERE id = ?").get(id) !== null;
  }

  /** All frames, or — when `repo` is given — only those on that canvas. */
  listFrames(repo?: string): FrameSummary[] {
    const rows = this.db
      .query(
        `SELECT f.id, f.name, f.width, f.height, f.x, f.y, f.version, f.repo, f.createdBy,
                f.kind, f.fontSize, f.createdAt, f.updatedAt,
                (SELECT COUNT(*) FROM comments c
                  WHERE c.frameId = f.id AND c.deletedAt IS NULL) AS commentCount,
                -- Only thread roots count as open feedback, so this matches the number the
                -- human sees in the sidebar instead of also counting the agent's own replies.
                (SELECT COUNT(*) FROM comments c
                  WHERE c.frameId = f.id AND c.deletedAt IS NULL
                    AND c.resolved = 0 AND c.parentId IS NULL) AS unresolvedCount
         FROM frames f
         ${repo === undefined ? "" : "WHERE f.repo = $repo"}
         ORDER BY f.x ASC, f.createdAt ASC`,
      )
      .all(repo === undefined ? {} : { $repo: repo }) as FrameSummaryRow[];
    return rows.map((row) => FrameSummarySchema.parse(row));
  }

  /** Every repo/canvas on this db, with its frame count and most-recent frame update. */
  listRepos(): { repo: string; frameCount: number; updatedAt: string | null }[] {
    return this.db
      .query(
        `SELECT repo, COUNT(*) AS frameCount, MAX(updatedAt) AS updatedAt
           FROM frames
          GROUP BY repo
          ORDER BY updatedAt DESC`,
      )
      .all() as { repo: string; frameCount: number; updatedAt: string | null }[];
  }

  /** Open comment threads — unresolved, top-level, not deleted — i.e. human feedback not yet closed.
   *  Scoped to a repo when given. Drives the "you have unread comments" nudge on tool results. */
  countOpenComments(repo?: string): number {
    const row = this.db
      .query(
        `SELECT COUNT(*) AS n FROM comments c
           JOIN frames f ON f.id = c.frameId
          WHERE c.resolved = 0 AND c.parentId IS NULL AND c.deletedAt IS NULL
                ${repo === undefined ? "" : "AND f.repo = $repo"}`,
      )
      .get(repo === undefined ? {} : { $repo: repo }) as { n: number };
    return row.n;
  }

  deleteFrame(id: string): void {
    const changes = this.db.query("DELETE FROM frames WHERE id = ?").run(id).changes;
    if (changes === 0) throw new Error(`unknown frame: ${id} — call list_frames for the current frame ids, or omit frameId to create a new frame.`);
  }

  // ---------- comments ----------

  createComment(input: CreateCommentInput): Comment {
    const parsed = CreateCommentInputSchema.parse(input);
    // The tick and the INSERT must land together. Apart, a reader can poll between them, take a
    // cursor above the reserved tick, and never see the row when it finally commits — measured
    // at 125 permanently invisible comments out of 1200 across three writers.
    return this.db.transaction(() => this.insertComment(parsed)).immediate();
  }

  private insertComment(parsed: z.output<typeof CreateCommentInputSchema>): Comment {
    const { frameId, x, y, text, parentId, author } = parsed;
    const frame = this.getFrame(frameId);
    const parent = parentId === undefined || parentId === null ? null : this.getComment(parentId);
    if (parent !== null && parent.frameId !== frameId) {
      throw new Error(
        `parent comment ${parent.id} belongs to frame ${parent.frameId}, not ${frameId}`,
      );
    }

    // Threads are exactly one level deep: the canvas renders roots as pins and their direct
    // replies inside the thread, so a reply-to-a-reply would render nowhere. Replying to a
    // reply joins its thread instead of nesting under it.
    const comment: Comment = {
      id: newCommentId(),
      frameId,
      x,
      y,
      text,
      author,
      parentId: parent === null ? null : (parent.parentId ?? parent.id),
      resolved: false,
      frameVersion: frame.version,
      createdAt: nowIso(),
    };

    const tick = this.nextTick();
    this.db
      .query(
        `INSERT INTO comments (seq, updatedSeq, id, frameId, x, y, text, author, parentId, resolved, frameVersion, createdAt)
         VALUES ($seq, $seq, $id, $frameId, $x, $y, $text, $author, $parentId, $resolved, $frameVersion, $createdAt)`,
      )
      .run({
        $seq: tick,
        $id: comment.id,
        $frameId: comment.frameId,
        $x: comment.x,
        $y: comment.y,
        $text: comment.text,
        $author: comment.author,
        $parentId: comment.parentId,
        $resolved: 0,
        $frameVersion: comment.frameVersion,
        $createdAt: comment.createdAt,
      });

    return comment;
  }

  getComment(id: string): Comment {
    const row = this.db
      .query(`SELECT ${COMMENT_COLUMNS} FROM comments WHERE id = ? AND deletedAt IS NULL`)
      .get(id) as CommentRow | null;
    if (row === null) throw new Error(`unknown comment: ${id} — call get_comments with includeResolved: true for the current comment ids.`);
    return toComment(row);
  }

  listComments(filter: CommentFilter = {}): Comment[] {
    const where: string[] = [];
    const params: Record<string, string | number> = {};

    if (filter.frameId !== undefined) {
      if (!this.hasFrame(filter.frameId)) throw new Error(`unknown frame: ${filter.frameId}`);
      where.push("c.frameId = $frameId");
      params.$frameId = filter.frameId;
    }
    if (filter.author !== undefined) {
      where.push("c.author = $author");
      params.$author = filter.author;
    }
    if (filter.includeResolved !== true) {
      where.push("c.resolved = 0");
    }
    if (filter.repo !== undefined) {
      // Scope to comments whose frame is on this canvas — the join is the only place the repo lives.
      where.push("f.repo = $repo");
      params.$repo = filter.repo;
    }
    if (filter.since !== undefined) {
      const since = this.resolveSince(filter.since);
      if (since.kind === "seq") {
        where.push("c.updatedSeq > $sinceSeq");
        params.$sinceSeq = since.value;
      } else {
        where.push("c.createdAt > $sinceAt");
        params.$sinceAt = since.value;
      }
    }
    where.push("c.deletedAt IS NULL");

    const columns = COMMENT_COLUMNS.split(", ")
      .map((col) => `c.${col}`)
      .join(", ");
    const rows = this.db
      .query(
        `SELECT ${columns} FROM comments c
         JOIN frames f ON f.id = c.frameId
         WHERE ${where.join(" AND ")} ORDER BY c.updatedSeq ASC`,
      )
      .all(params) as CommentRow[];
    return rows.map(toComment);
  }

  /** Returns every comment the patch changed: the target first, then any replies it cascaded to. */
  updateComment(id: string, patch: UpdateCommentPatch): Comment[] {
    const { resolved, text } = UpdateCommentPatchSchema.parse(patch);
    if (resolved === undefined && text === undefined) {
      throw new Error(`updateComment(${id}) called with an empty patch`);
    }
    return this.db.transaction(() => {
      const existing = this.getComment(id);
      // Only the columns the patch names are written. Writing both from one stale read let a
      // concurrent resolve put back the text as it was several edits ago, losing human edits.
      this.db
        .query(
          `UPDATE comments
              SET resolved   = COALESCE($resolved, resolved),
                  text       = COALESCE($text, text),
                  updatedSeq = $tick
            WHERE id = $id`,
        )
        .run({
          $resolved: resolved === undefined ? null : resolved ? 1 : 0,
          $text: text === undefined ? null : text,
          $id: id,
          $tick: this.nextTick(),
        });

      // Resolving a thread resolves its replies too, otherwise the agent's own reply stays
      // open forever and every poll keeps reporting feedback that nobody is waiting on.
      const cascaded: Comment[] =
        resolved === undefined || existing.parentId !== null
          ? []
          : this.cascadeResolve(id, resolved);

      return [this.getComment(id), ...cascaded];
    }).immediate();
  }

  private cascadeResolve(rootId: string, resolved: boolean): Comment[] {
    const rows = this.db
      .query(
        `UPDATE comments SET resolved = $resolved, updatedSeq = $tick
          WHERE parentId = $id AND deletedAt IS NULL AND resolved != $resolved
        RETURNING ${COMMENT_COLUMNS}`,
      )
      .all({ $resolved: resolved ? 1 : 0, $id: rootId, $tick: this.nextTick() }) as CommentRow[];
    return rows.map(toComment);
  }

  /**
   * Soft delete: the row stays so a cursor pointing at it still resolves. An agent whose
   * `since` names a comment the human has since deleted keeps polling instead of erroring
   * out on every retry with no way back.
   */
  deleteComment(id: string): void {
    this.getComment(id);
    const at = nowIso();
    this.db
      .query(
        "UPDATE comments SET deletedAt = $at, updatedSeq = $tick WHERE (id = $id OR parentId = $id) AND deletedAt IS NULL",
      )
      .run({ $at: at, $id: id, $tick: this.nextTick() });
  }

  counts(): { frames: number; comments: number } {
    const frames = this.db.query("SELECT COUNT(*) AS n FROM frames").get() as { n: number };
    const comments = this.db
      .query("SELECT COUNT(*) AS n FROM comments WHERE deletedAt IS NULL")
      .get() as { n: number };
    return { frames: frames.n, comments: comments.n };
  }

  // ---------- internals ----------

  /**
   * `since` is an ISO timestamp or a comment id. Both collapse to a seq threshold so
   * "strictly after" stays exact even when several comments share a millisecond.
   */
  /**
   * The cursor a read hands back. It is an opaque snapshot of *where the feed was*, not a
   * pointer at a row: a comment id would be re-resolved through that row's live `updatedSeq`,
   * so resolving or editing the cursor comment would drag the boundary forward over everything
   * the human wrote in between — those comments then never come back, on any later poll.
   */
  /**
   * The cursor to hand back for a read. An empty page must not reset the caller to null — that
   * would send the next poll back to the beginning of the feed — so the position it was already
   * at is echoed instead.
   */
  nextCursor(comments: Comment[], since: string | undefined): string | null {
    const advanced = this.cursorOf(comments);
    if (advanced !== null) return advanced;
    return since !== undefined && since.startsWith(CURSOR_PREFIX) ? since : null;
  }

  cursorOf(comments: Comment[]): string | null {
    if (comments.length === 0) return null;
    const ids = comments.map((c) => c.id);
    const row = this.db
      .query(
        `SELECT MAX(updatedSeq) AS seq FROM comments WHERE id IN (${ids.map(() => "?").join(",")})`,
      )
      .get(...ids) as { seq: number | null };
    if (row.seq === null) throw new Error("cursorOf: none of the returned comments exist");
    return `${CURSOR_PREFIX}${row.seq}`;
  }

  private resolveSince(since: string): { kind: "seq" | "time"; value: string | number } {
    if (since.startsWith(CURSOR_PREFIX)) {
      const seq = Number(since.slice(CURSOR_PREFIX.length));
      if (!Number.isInteger(seq) || seq < 0) throw new Error(`malformed cursor in \`since\`: ${since}`);
      return { kind: "seq", value: seq };
    }
    if (isCommentId(since)) {
      // Deliberately not filtered on deletedAt — a cursor must survive its comment's deletion.
      const row = this.db.query("SELECT updatedSeq FROM comments WHERE id = ?").get(since) as
        | { updatedSeq: number }
        | null;
      if (row === null) throw new Error(`unknown comment id in \`since\`: ${since} — that cursor is from a different canvas. Call get_comments with no \`since\` and use the cursor it returns.`);
      return { kind: "seq", value: row.updatedSeq };
    }

    const at = new Date(since);
    if (Number.isNaN(at.getTime())) {
      throw new Error(`\`since\` must be an ISO timestamp or a comment id, got: ${since}`);
    }
    // A timestamp is compared against createdAt directly rather than collapsed to a seq
    // threshold. Deriving a threshold from a max-over-timestamps steps past comments that share
    // the boundary millisecond, and a writer that computes createdAt and then waits on the lock
    // can land an earlier createdAt at a later tick — either one silently loses a comment.
    // Comparing timestamps keeps the meaning exactly "created after this instant".
    return { kind: "time", value: at.toISOString() };
  }

  /**
   * Auto-layout wraps into rows instead of marching right forever. An unbounded strip means
   * every new frame is further from the last, so a canvas with a handful of frames can only be
   * read by panning sideways and zoom-to-fit shrinks everything to nothing.
   */
  /** Moves a frame. Position is the only thing the canvas lets a human change directly. */
  moveFrame(frameId: string, x: number, y: number): Frame {
    const row = this.db
      .query("UPDATE frames SET x = $x, y = $y WHERE id = $id RETURNING *")
      .get({ $x: x, $y: y, $id: frameId }) as FrameRow | null;
    if (row === null) {
      throw new Error(
        `unknown frame: ${frameId} — call list_frames for the current frame ids, or omit frameId to create a new frame.`,
      );
    }
    return FrameSchema.parse(row);
  }

  /**
   * Re-packs every frame from scratch, biggest first, preserving nothing but the frames
   * themselves. For a canvas that already overlaps — because it was built before placement
   * became collision-aware, or because an agent placed frames by hand badly.
   */
  tidyFrames(repo: string): FrameSummary[] {
    return this.db
      .transaction(() => {
        const frames = this.db
          .query(
            "SELECT id, width, height FROM frames WHERE repo = $repo ORDER BY height DESC, width DESC, createdAt ASC",
          )
          .all({ $repo: repo }) as { id: string; width: number; height: number }[];

        const placed: Box[] = [];
        const update = this.db.query("UPDATE frames SET x = $x, y = $y WHERE id = $id");
        for (const frame of frames) {
          const at =
            placed.length === 0 ? { x: 0, y: 0 } : findFreeSlot(placed, frame.width, frame.height);
          placed.push({ x: at.x, y: at.y, width: frame.width, height: frame.height });
          update.run({ $x: at.x, $y: at.y, $id: frame.id });
        }
        return this.listFrames(repo);
      })
      .immediate();
  }

  private nextFramePosition(width: number, height: number, repo: string): { x: number; y: number } {
    // Only frames on the same canvas are considered, so two repos both place from the origin.
    const boxes = this.db
      .query("SELECT x, y, width, height FROM frames WHERE repo = $repo")
      .all({ $repo: repo }) as Box[];
    if (boxes.length === 0) return { x: 0, y: 0 };
    return findFreeSlot(boxes, width, height);
  }

  /** Frame.name is required by the data model; push_html's is optional, so unnamed frames get a slot label. */
  private nextFrameName(repo: string): string {
    const row = this.db
      .query("SELECT COUNT(*) AS n FROM frames WHERE repo = $repo")
      .get({ $repo: repo }) as { n: number };
    return `Frame ${row.n + 1}`;
  }
}
