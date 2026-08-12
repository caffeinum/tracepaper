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
    const { html, name, width, height, x, y } = CreateFrameInputSchema.parse(input);
    // The layout slot and the slot name are both read-then-written. Two processes on one db
    // otherwise pick the same x and the same "Frame N", stacking one frame invisibly on another.
    return this.db
      .transaction(() => this.insertFrame({ html, name, width, height, x, y }))
      .immediate();
  }

  private insertFrame(input: {
    html: string;
    name: string | undefined;
    width: number;
    height: number;
    x?: number | undefined;
    y?: number | undefined;
  }): Frame {
    const { html, name, width, height } = input;
    const at = nowIso();
    const auto = this.nextFramePosition(width);
    const frame: Frame = {
      id: newFrameId(),
      name: name === undefined ? this.nextFrameName() : name,
      html,
      width,
      height,
      x: input.x === undefined ? auto.x : input.x,
      y: input.y === undefined ? auto.y : input.y,
      version: 1,
      createdAt: at,
      updatedAt: at,
    };

    this.db
      .query(
        `INSERT INTO frames (id, name, html, width, height, x, y, version, createdAt, updatedAt)
         VALUES ($id, $name, $html, $width, $height, $x, $y, $version, $createdAt, $updatedAt)`,
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

  listFrames(): FrameSummary[] {
    const rows = this.db
      .query(
        `SELECT f.id, f.name, f.width, f.height, f.x, f.y, f.version, f.createdAt, f.updatedAt,
                (SELECT COUNT(*) FROM comments c
                  WHERE c.frameId = f.id AND c.deletedAt IS NULL) AS commentCount,
                -- Only thread roots count as open feedback, so this matches the number the
                -- human sees in the sidebar instead of also counting the agent's own replies.
                (SELECT COUNT(*) FROM comments c
                  WHERE c.frameId = f.id AND c.deletedAt IS NULL
                    AND c.resolved = 0 AND c.parentId IS NULL) AS unresolvedCount
         FROM frames f
         ORDER BY f.x ASC, f.createdAt ASC`,
      )
      .all() as FrameSummaryRow[];
    return rows.map((row) => FrameSummarySchema.parse(row));
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
      where.push("frameId = $frameId");
      params.$frameId = filter.frameId;
    }
    if (filter.author !== undefined) {
      where.push("author = $author");
      params.$author = filter.author;
    }
    if (filter.includeResolved !== true) {
      where.push("resolved = 0");
    }
    if (filter.since !== undefined) {
      const since = this.resolveSince(filter.since);
      if (since.kind === "seq") {
        where.push("updatedSeq > $sinceSeq");
        params.$sinceSeq = since.value;
      } else {
        where.push("createdAt > $sinceAt");
        params.$sinceAt = since.value;
      }
    }
    where.push("deletedAt IS NULL");

    const rows = this.db
      .query(`SELECT ${COMMENT_COLUMNS} FROM comments WHERE ${where.join(" AND ")} ORDER BY updatedSeq ASC`)
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
  private nextFramePosition(width: number): { x: number; y: number } {
    const last = this.db.query("SELECT MAX(y) AS y FROM frames").get() as { y: number | null };
    if (last.y === null) return { x: 0, y: 0 };

    const row = this.db
      .query("SELECT MAX(x + width) AS right, MAX(height) AS tallest FROM frames WHERE y = $y")
      .get({ $y: last.y }) as { right: number | null; tallest: number | null };
    if (row.right === null || row.tallest === null) return { x: 0, y: last.y };

    const nextX = row.right + FRAME_GAP;
    if (nextX + width <= ROW_MAX_WIDTH) return { x: nextX, y: last.y };
    return { x: 0, y: last.y + row.tallest + FRAME_GAP };
  }

  /** Frame.name is required by the data model; push_html's is optional, so unnamed frames get a slot label. */
  private nextFrameName(): string {
    const row = this.db.query("SELECT COUNT(*) AS n FROM frames").get() as { n: number };
    return `Frame ${row.n + 1}`;
  }
}
