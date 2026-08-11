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
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  id           TEXT    NOT NULL UNIQUE,
  frameId      TEXT    NOT NULL REFERENCES frames(id) ON DELETE CASCADE,
  x            REAL    NOT NULL,
  y            REAL    NOT NULL,
  text         TEXT    NOT NULL,
  author       TEXT    NOT NULL,
  parentId     TEXT             REFERENCES comments(id) ON DELETE CASCADE,
  resolved     INTEGER NOT NULL,
  frameVersion INTEGER NOT NULL,
  createdAt    TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_comments_frameId   ON comments(frameId);
CREATE INDEX IF NOT EXISTS idx_comments_createdAt ON comments(createdAt);
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
};

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

  updateFrameHtml(frameId: string, html: string, name?: string): Frame {
    const existing = this.getFrame(frameId);
    const next: Frame = {
      ...existing,
      html,
      name: name === undefined ? existing.name : name,
      version: existing.version + 1,
      updatedAt: nowIso(),
    };

    this.db
      .query(
        `UPDATE frames SET html = $html, name = $name, version = $version, updatedAt = $updatedAt
         WHERE id = $id`,
      )
      .run({
        $html: next.html,
        $name: next.name,
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
                (SELECT COUNT(*) FROM comments c WHERE c.frameId = f.id) AS commentCount,
                (SELECT COUNT(*) FROM comments c WHERE c.frameId = f.id AND c.resolved = 0) AS unresolvedCount
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

    const comment: Comment = {
      id: newCommentId(),
      frameId,
      x,
      y,
      text,
      author,
      parentId: parent === null ? null : parent.id,
      resolved: false,
      frameVersion: frame.version,
      createdAt: nowIso(),
    };

    this.db
      .query(
        `INSERT INTO comments (id, frameId, x, y, text, author, parentId, resolved, frameVersion, createdAt)
         VALUES ($id, $frameId, $x, $y, $text, $author, $parentId, $resolved, $frameVersion, $createdAt)`,
      )
      .run({
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
    const row = this.db.query("SELECT * FROM comments WHERE id = ?").get(id) as CommentRow | null;
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
      where.push("seq > $sinceSeq");
      params.$sinceSeq = this.resolveSinceSeq(filter.since);
    }

    const clause = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
    const rows = this.db
      .query(`SELECT * FROM comments ${clause} ORDER BY seq ASC`)
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
      .query("UPDATE comments SET resolved = $resolved, text = $text WHERE id = $id")
      .run({ $resolved: next.resolved ? 1 : 0, $text: next.text, $id: id });

    return next;
  }

  deleteComment(id: string): void {
    const changes = this.db.query("DELETE FROM comments WHERE id = ?").run(id).changes;
    if (changes === 0) throw new Error(`unknown comment: ${id}`);
  }

  counts(): { frames: number; comments: number } {
    const frames = this.db.query("SELECT COUNT(*) AS n FROM frames").get() as { n: number };
    const comments = this.db.query("SELECT COUNT(*) AS n FROM comments").get() as { n: number };
    return { frames: frames.n, comments: comments.n };
  }

  // ---------- internals ----------

  /**
   * `since` is an ISO timestamp or a comment id. Both collapse to a seq threshold so
   * "strictly after" stays exact even when several comments share a millisecond.
   */
  private resolveSinceSeq(since: string): number {
    if (isCommentId(since)) {
      const row = this.db.query("SELECT seq FROM comments WHERE id = ?").get(since) as
        | { seq: number }
        | null;
      if (row === null) throw new Error(`unknown comment id in \`since\`: ${since}`);
      return row.seq;
    }

    const at = new Date(since);
    if (Number.isNaN(at.getTime())) {
      throw new Error(`\`since\` must be an ISO timestamp or a comment id, got: ${since}`);
    }
    const row = this.db
      .query("SELECT MAX(seq) AS seq FROM comments WHERE createdAt <= ?")
      .get(at.toISOString()) as { seq: number | null };
    return row.seq === null ? 0 : row.seq;
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
