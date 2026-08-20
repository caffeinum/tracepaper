import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toFramePayload, type Bus } from "./events.ts";
import type { Store } from "./store.ts";
import {
  GetCommentsResultSchema,
  ListFramesResultSchema,
  PushHtmlResultSchema,
  GetFrameResultSchema,
  deleteFrameShape,
  getCommentsShape,
  getFrameShape,
  listFramesShape,
  pushHtmlShape,
  replyToCommentShape,
  resolveCommentShape,
  type Comment,
  type FrameSummary,
  type GetCommentsResult,
  type GetFrameResult,
  type ListFramesResult,
  type PushHtmlResult,
} from "./types.ts";

export const SERVER_NAME = "tracepaper";
export const SERVER_VERSION = "0.3.2";

export type McpServerDeps = {
  store: Store;
  /** Every mutation is broadcast so the human's open canvas updates live. */
  bus: Bus;
  /** Lazy — the http server picks its real port at boot, after this server is built. */
  baseUrl: () => string;
};

const PUSH_HTML_DESCRIPTION = [
  "Draw on the shared canvas the human is watching.",
  "Push a full HTML document (or fragment) as a frame; it appears in the human's open browser within",
  "a few seconds, no reload needed. push_html REPLACES the frame's whole document — there is no",
  "partial update, so call get_frame first if you did not author the current HTML this session.",
  "Omit frameId to add a new frame; it is auto-placed beside the last one and wraps onto a new row",
  "so the canvas stays readable instead of growing into one endless strip. Pass frameId to replace",
  "that frame's HTML in place — the version bumps and existing comments survive. An unknown frameId",
  "is an error, never a silent create.",
  "",
  "LAYOUT: you can place frames yourself with x/y (world px) instead of accepting auto-placement,",
  "and you should whenever the arrangement carries meaning. Put variants of one thing side by side",
  "on a shared y so they read as a row and can be compared; start an unrelated topic on a new row",
  "by stepping y down past the tallest frame above it (add ~120px of gutter). Reserve auto-placement",
  "for one-off frames. list_frames returns every frame's x, y, width and height, so read it first",
  "when you are placing something relative to existing work.",
  "",
  "The loop: after pushing, tell the human to open the returned canvasUrl. They scroll the canvas,",
  "click anywhere on a frame to drop a pin, and type feedback there. Read that feedback back with",
  "get_comments — poll it with the cursor it returns. Answer with reply_to_comment, and close the",
  "loop with resolve_comment once you have acted on a note.",
].join("\n");

const GET_COMMENTS_DESCRIPTION = [
  "Read the human's feedback left on the canvas. This is the other half of push_html.",
  "Returns comments oldest-first plus an opaque `cursor` — pass it back as `since` next call to get",
  "only what is new. Keep the cursor, not a timestamp: `since` accepts an ISO timestamp too, but",
  "that matches only comments CREATED after it, so a comment the human edited or re-opened never",
  "comes back.",
  "",
  "Cadence: humans take minutes, not seconds. After push_html, hand over canvasUrl and stop. Poll",
  "about every 30s, and after a few empty polls say you are waiting and yield the turn rather than",
  "spinning.",
  "",
  'Pass author: "human" while polling for feedback — otherwise your own reply_to_comment notes come',
  "back under the very cursor you were just handed and read exactly like new human feedback.",
  "Resolved comments are excluded unless includeResolved is true.",
  "An empty list means nothing is new SINCE THE CURSOR — not that nothing is outstanding. The",
  "header tells you how many threads are still unresolved.",
].join("\n");

const LIST_FRAMES_DESCRIPTION = [
  "List every frame on the canvas with its size, position, version, and comment counts",
  "(html omitted). Use it to find the frameId to update with push_html, or to see which frames",
  "still have unresolved feedback. Also returns canvasUrl to hand to the human.",
].join("\n");

const RESOLVE_COMMENT_DESCRIPTION = [
  "Mark a comment as done so it drops out of get_comments and the human's unresolved list.",
  "Pass `note` to also post it as an agent reply in that thread — the human then sees what you",
  "changed instead of a note that silently disappears. Resolving a thread resolves its replies",
  "too, so your own note does not come back as fresh feedback.",
].join("\n");

const REPLY_TO_COMMENT_DESCRIPTION = [
  "Post a threaded reply on a comment as the agent. This is how you talk back inside the canvas:",
  "ask a clarifying question, or say what you are about to change. The reply appears in the",
  "human's open thread. Use resolve_comment when the note is actually handled.",
  "Your reply is itself unresolved, so it comes back on your next unfiltered poll — replying to an",
  'already-resolved comment re-opens that conversation. Poll with author: "human" to avoid reading',
  "your own replies as new feedback.",
].join("\n");

const GET_FRAME_DESCRIPTION = [
  "Read a frame's current HTML back, plus its name, size and version.",
  "Call this before push_html on a frame you did not author in this session — after a compaction,",
  "or in a new session. push_html REPLACES the whole document, so pushing without reading first",
  "silently discards whatever is already there.",
].join("\n");

const TIDY_CANVAS_DESCRIPTION = [
  "Re-pack every frame into clean rows, largest first, so nothing overlaps.",
  "Use it when frames are sitting on top of each other — usually because they were placed by",
  "hand with x/y, or resized after placement. It moves frames only; html, comments and pins are",
  "untouched. Positions are not recoverable afterwards, so do not run it on a canvas whose",
  "layout the human arranged deliberately without asking them first.",
].join("\n");

const DELETE_FRAME_DESCRIPTION = [
  "Remove a frame from the canvas along with every comment on it. Irreversible.",
].join("\n");

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: message }], isError: true };
}

function structuredResult(text: string, structuredContent: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent };
}

function describeComment(comment: Comment, frame: FrameSummary | undefined): string {
  const thread = comment.parentId === null ? "" : ` (reply to ${comment.parentId})`;
  const where =
    frame === undefined
      ? `on ${comment.frameId}`
      : `on ${comment.frameId} "${frame.name}" @ (${Math.round(comment.x)},${Math.round(comment.y)}) of ${frame.width}x${frame.height}`;
  // A coordinate means nothing without the frame size, and a note left on v1 of a frame now at
  // v3 was written about a design the agent has already replaced.
  const age =
    frame === undefined || frame.version === comment.frameVersion
      ? `v${comment.frameVersion}`
      : `left on v${comment.frameVersion}, frame is now v${frame.version} (STALE)`;
  return `- ${comment.id}${thread} [${comment.author}] ${where} — ${age}: ${comment.text}`;
}

export function createMcpServer({ store, bus, baseUrl }: McpServerDeps): McpServer {
  const canvasUrl = (): string => `${baseUrl()}/`;
  const frameUrl = (frameId: string): string => `${baseUrl()}/f/${frameId}`;

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: [
        "tracepaper is a shared canvas between you and a human.",
        "push_html draws a frame; the human opens canvasUrl in a browser, pins comments onto the",
        "frames, and you read those comments back with get_comments (poll it with the returned",
        "cursor). reply_to_comment and resolve_comment close the loop.",
      ].join(" "),
    },
  );

  server.registerTool(
    "push_html",
    {
      title: "Push HTML to the canvas",
      description: PUSH_HTML_DESCRIPTION,
      inputSchema: pushHtmlShape,
      outputSchema: PushHtmlResultSchema,
    },
    ({ html, name, frameId, width, height, x, y }) => {
      try {
        const frame =
          frameId === undefined
            ? store.createFrame({ html, name, width, height, x, y })
            : store.updateFrameHtml(frameId, html, { name, width, height });
        bus.emit({
          type: frameId === undefined ? "frame.created" : "frame.updated",
          frame: toFramePayload(frame),
        });

        const result: PushHtmlResult = {
          frameId: frame.id,
          name: frame.name,
          version: frame.version,
          url: frameUrl(frame.id),
          canvasUrl: canvasUrl(),
        };

        const action = frameId === undefined ? "Created" : "Updated";
        return structuredResult(
          [
            `${action} frame ${frame.id} "${frame.name}" (v${frame.version}, ${frame.width}x${frame.height}) at (${frame.x},${frame.y}).`,
            `Ask the human to open the canvas at ${result.canvasUrl} and leave comments on the frame.`,
            `Then poll get_comments (frameId: "${frame.id}") to read what they wrote.`,
            `Raw frame html: ${result.url}`,
          ].join("\n"),
          result,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_comments",
    {
      title: "Read canvas comments",
      description: GET_COMMENTS_DESCRIPTION,
      inputSchema: getCommentsShape,
      outputSchema: GetCommentsResultSchema,
    },
    ({ frameId, since, includeResolved, author }) => {
      try {
        const comments = store.listComments({ frameId, since, includeResolved, author });
        const touched = new Set(comments.map((c) => c.frameId));
        const byId = new Map(store.listFrames().filter((f) => touched.has(f.id)).map((f) => [f.id, f]));
        const result: GetCommentsResult = {
          comments,
          cursor: store.nextCursor(comments, since),
          frames: [...byId.values()].map(({ id, name, width, height, version }) => ({
            id,
            name,
            width,
            height,
            version,
          })),
        };

        const mine = comments.filter((c) => c.author === "agent").length;
        const open = store
          .listComments({ frameId })
          .filter((c) => c.parentId === null && c.author === "human").length;

        // An empty page does not mean "nothing to do" — it means nothing is new since the
        // cursor. Saying so, with the open count, is what stops an agent reading it as "done".
        const header =
          comments.length === 0
            ? since === undefined
              ? `No comments yet. Ask the human to open ${canvasUrl()} and mark up the frame, then poll again.`
              : `Nothing new since that cursor. ${open} thread(s) from the human are still unresolved — call get_comments without \`since\` to re-read them. If that is 0, the human has not written anything new: wait ~30s and poll again.`
            : `${comments.length} comment(s)${mine === 0 ? "" : ` (${mine} your own replies)`}, oldest first. Pass since: "${result.cursor}" next poll. Canvas: ${canvasUrl()}`;

        return structuredResult(
          [header, ...comments.map((c) => describeComment(c, byId.get(c.frameId)))].join("\n"),
          result,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "list_frames",
    {
      title: "List canvas frames",
      description: LIST_FRAMES_DESCRIPTION,
      inputSchema: listFramesShape,
      outputSchema: ListFramesResultSchema,
    },
    () => {
      try {
        const result: ListFramesResult = { frames: store.listFrames(), canvasUrl: canvasUrl() };
        const lines = result.frames.map(
          (frame) =>
            `- ${frame.id} "${frame.name}" v${frame.version} ${frame.width}x${frame.height} @ (${frame.x},${frame.y}) — ${frame.commentCount} comment(s), ${frame.unresolvedCount} unresolved`,
        );
        const header =
          result.frames.length === 0
            ? `Canvas is empty. Push a frame with push_html; the human watches it at ${result.canvasUrl}`
            : `${result.frames.length} frame(s) on the canvas at ${result.canvasUrl}`;
        return structuredResult([header, ...lines].join("\n"), result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "resolve_comment",
    {
      title: "Resolve a comment",
      description: RESOLVE_COMMENT_DESCRIPTION,
      inputSchema: resolveCommentShape,
    },
    ({ commentId, note }) => {
      try {
        const target = store.getComment(commentId);
        const reply =
          note === undefined
            ? null
            : store.createComment({
                frameId: target.frameId,
                x: target.x,
                y: target.y,
                text: note,
                parentId: target.id,
                author: "agent",
              });
        if (reply !== null) bus.emit({ type: "comment.created", comment: reply });
        const changed = store.updateComment(commentId, { resolved: true });
        for (const comment of changed) bus.emit({ type: "comment.updated", comment });
        const resolved = changed[0];
        if (resolved === undefined) throw new Error(`resolve_comment(${commentId}) changed nothing`);

        return textResult(
          [
            `Resolved ${resolved.id} on frame ${resolved.frameId}.`,
            reply === null ? null : `Posted agent reply ${reply.id}: ${reply.text}`,
          ]
            .filter((line) => line !== null)
            .join("\n"),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "reply_to_comment",
    {
      title: "Reply to a comment",
      description: REPLY_TO_COMMENT_DESCRIPTION,
      inputSchema: replyToCommentShape,
    },
    ({ commentId, text }) => {
      try {
        const target = store.getComment(commentId);
        const reply = store.createComment({
          frameId: target.frameId,
          x: target.x,
          y: target.y,
          text,
          parentId: target.id,
          author: "agent",
        });
        bus.emit({ type: "comment.created", comment: reply });
        return textResult(
          `Replied ${reply.id} to ${target.id} on frame ${target.frameId}. The human sees it live at ${canvasUrl()}`,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_frame",
    {
      title: "Read a frame's current HTML",
      description: GET_FRAME_DESCRIPTION,
      inputSchema: getFrameShape,
      outputSchema: GetFrameResultSchema,
    },
    ({ frameId }) => {
      try {
        const frame = store.getFrame(frameId);
        const result: GetFrameResult = {
          ...frame,
          url: frameUrl(frame.id),
          canvasUrl: canvasUrl(),
        };
        return structuredResult(
          [
            `${frame.id} "${frame.name}" v${frame.version}, ${frame.width}x${frame.height}.`,
            "Current HTML follows. push_html with this frameId replaces all of it.",
            "",
            frame.html,
          ].join("\n"),
          result,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "tidy_canvas",
    {
      title: "Re-pack frames so none overlap",
      description: TIDY_CANVAS_DESCRIPTION,
      inputSchema: {},
      outputSchema: ListFramesResultSchema,
    },
    () => {
      try {
        const frames = store.tidyFrames();
        for (const frame of frames) {
          bus.emit({ type: "frame.updated", frame: toFramePayload({ ...frame, html: "" }) });
        }
        const result: ListFramesResult = { frames, canvasUrl: canvasUrl() };
        return structuredResult(
          [
            `Re-packed ${frames.length} frame(s); nothing overlaps now.`,
            ...frames.map((f) => `- ${f.id} "${f.name}" ${f.width}x${f.height} @ (${f.x},${f.y})`),
          ].join("\n"),
          result,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "delete_frame",
    {
      title: "Delete a frame",
      description: DELETE_FRAME_DESCRIPTION,
      inputSchema: deleteFrameShape,
    },
    ({ frameId }) => {
      try {
        const frame = store.getFrame(frameId);
        store.deleteFrame(frameId);
        bus.emit({ type: "frame.deleted", frame: toFramePayload(frame) });
        return textResult(`Deleted frame ${frame.id} "${frame.name}" and its comments.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}
