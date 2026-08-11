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
/** How long a write waits for another process's lock before failing loudly. */
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
    const { html, name, width, height } = CreateFrameInputSchema.parse(input);
    const id = newFrameId();
    const at = nowIso();
    const frame: Frame = {
      id,
      name: name === undefined ? this.nextFrameName() : name,
      html,
      width,
      height,
      x: this.nextFrameX(),
      y: 0,
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
    const existing = this.getFrame(frameId);
    const next: Frame = {
      ...existing,
      html,
      name: patch.name === undefined ? existing.name : patch.name,
      width: patch.width === undefined ? existing.width : patch.width,
      height: patch.height === undefined ? existing.height : patch.height,
      version: existing.version + 1,
      updatedAt: nowIso(),
    };

    this.db
      .query(
        `UPDATE frames SET html = $html, name = $name, width = $width, height = $height,
                           version = $version, updatedAt = $updatedAt
         WHERE id = $id`,
      )
      .run({
        $html: next.html,
        $name: next.name,
        $width: next.width,
        $height: next.height,
        $version: next.version,
        $updatedAt: next.updatedAt,
        $id: next.id,
      });

    return next;
  }

  getFrame(id: string): Frame {
    const row = this.db.query("SELECT * FROM frames WHERE id = ?").get(id) as FrameRow | null;
    if (row === null) throw new Error(`unknown frame: ${id}`);
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
    if (changes === 0) throw new Error(`unknown frame: ${id}`);
  }

  // ---------- comments ----------

  createComment(input: CreateCommentInput): Comment {
    const { frameId, x, y, text, parentId, author } = CreateCommentInputSchema.parse(input);
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
    if (row === null) throw new Error(`unknown comment: ${id}`);
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

  updateComment(id: string, patch: UpdateCommentPatch): Comment {
    const existing = this.getComment(id);
    const { resolved, text } = UpdateCommentPatchSchema.parse(patch);
    if (resolved === undefined && text === undefined) {
      throw new Error(`updateComment(${id}) called with an empty patch`);
    }

    const next: Comment = {
      ...existing,
      resolved: resolved === undefined ? existing.resolved : resolved,
      text: text === undefined ? existing.text : text,
    };

    this.db
      .query(
        "UPDATE comments SET resolved = $resolved, text = $text, updatedSeq = $tick WHERE id = $id",
      )
      .run({ $resolved: next.resolved ? 1 : 0, $text: next.text, $id: id, $tick: this.nextTick() });

    // Resolving a thread resolves its replies too, otherwise the agent's own reply stays
    // open forever and every poll keeps reporting feedback that nobody is waiting on.
    if (resolved !== undefined && existing.parentId === null) {
      this.db
        .query(
          "UPDATE comments SET resolved = $resolved, updatedSeq = $tick WHERE parentId = $id AND deletedAt IS NULL",
        )
        .run({ $resolved: next.resolved ? 1 : 0, $id: id, $tick: this.nextTick() });
    }

    return next;
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
  private resolveSince(since: string): { kind: "seq" | "time"; value: string | number } {
    if (isCommentId(since)) {
      // Deliberately not filtered on deletedAt — a cursor must survive its comment's deletion.
      const row = this.db.query("SELECT updatedSeq FROM comments WHERE id = ?").get(since) as
        | { updatedSeq: number }
        | null;
      if (row === null) throw new Error(`unknown comment id in \`since\`: ${since}`);
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

  private nextFrameX(): number {
    const row = this.db.query("SELECT MAX(x + width) AS right FROM frames").get() as {
      right: number | null;
    };
    return row.right === null ? 0 : row.right + FRAME_GAP;
  }

  /** Frame.name is required by the data model; push_html's is optional, so unnamed frames get a slot label. */
  private nextFrameName(): string {
    const row = this.db.query("SELECT COUNT(*) AS n FROM frames").get() as { n: number };
    return `Frame ${row.n + 1}`;
  }
}
