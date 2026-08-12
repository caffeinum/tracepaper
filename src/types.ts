import { z } from "zod";
import { COMMENT_ID_RE, FRAME_ID_RE } from "./ids.ts";

export const DEFAULT_FRAME_WIDTH = 1280;
export const DEFAULT_FRAME_HEIGHT = 900;

/**
 * Size ceilings. Unbounded html filled the db (100MB push → 147MB on disk) and an unbounded
 * comment came back through get_comments verbatim, which is an agent's whole context window.
 */
export const MAX_HTML_BYTES = 5_000_000;
export const MAX_COMMENT_CHARS = 16_000;

// ---------- data model ----------

export const AuthorSchema = z.enum(["human", "agent"]);
export type Author = z.infer<typeof AuthorSchema>;

export const FrameSchema = z.object({
  id: z.string().regex(FRAME_ID_RE),
  name: z.string(),
  html: z.string(),
  width: z.number(),
  height: z.number(),
  x: z.number(),
  y: z.number(),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Frame = z.infer<typeof FrameSchema>;

export const FrameSummarySchema = FrameSchema.omit({ html: true }).extend({
  commentCount: z.number().int(),
  unresolvedCount: z.number().int(),
});
export type FrameSummary = z.infer<typeof FrameSummarySchema>;

export const CommentSchema = z.object({
  id: z.string().regex(COMMENT_ID_RE),
  frameId: z.string().regex(FRAME_ID_RE),
  x: z.number(),
  y: z.number(),
  text: z.string(),
  author: AuthorSchema,
  parentId: z.string().regex(COMMENT_ID_RE).nullable(),
  resolved: z.boolean(),
  frameVersion: z.number().int(),
  createdAt: z.string(),
});
export type Comment = z.infer<typeof CommentSchema>;

// ---------- store inputs ----------

export const htmlField = z
  .string()
  .min(1, "html must not be empty — push the document you want the human to look at")
  .max(MAX_HTML_BYTES, `html must be at most ${MAX_HTML_BYTES} bytes`);

export const CreateFrameInputSchema = z.object({
  html: htmlField,
  name: z.string().min(1).optional(),
  width: z.number().positive().default(DEFAULT_FRAME_WIDTH),
  height: z.number().positive().default(DEFAULT_FRAME_HEIGHT),
  x: z.number().optional(),
  y: z.number().optional(),
});
export type CreateFrameInput = z.input<typeof CreateFrameInputSchema>;

export const CreateCommentInputSchema = z.object({
  frameId: z.string(),
  x: z.number(),
  y: z.number(),
  text: z.string().min(1).max(MAX_COMMENT_CHARS),
  parentId: z.string().nullable().optional(),
  author: AuthorSchema.default("human"),
});
export type CreateCommentInput = z.input<typeof CreateCommentInputSchema>;

export const UpdateCommentPatchSchema = z.object({
  resolved: z.boolean().optional(),
  text: z.string().min(1).optional(),
});
export type UpdateCommentPatch = z.infer<typeof UpdateCommentPatchSchema>;

export const CommentFilterSchema = z.object({
  frameId: z.string().optional(),
  since: z.string().optional(),
  includeResolved: z.boolean().optional(),
  author: AuthorSchema.optional(),
});
export type CommentFilter = z.infer<typeof CommentFilterSchema>;

// ---------- MCP tool inputs ----------
// Raw shapes are what `McpServer.registerTool({ inputSchema })` wants.

export const pushHtmlShape = {
  html: htmlField.describe("Full HTML document or fragment, served verbatim."),
  name: z.string().min(1).optional().describe("Human label shown above the frame."),
  frameId: z.string().optional().describe("Existing frame to replace in place. Omit to create a new frame."),
  width: z.number().positive().optional().describe(`Frame width in css px (default ${DEFAULT_FRAME_WIDTH}). Resizes the frame when passed with frameId.`),
  height: z.number().positive().optional().describe(`Frame height in css px (default ${DEFAULT_FRAME_HEIGHT}). Resizes the frame when passed with frameId.`),
  x: z.number().optional().describe("Canvas position in world px. Omit to auto-place. Use it to group related frames: a variant belongs beside its original, a new topic starts a new row."),
  y: z.number().optional().describe("Canvas position in world px. Frames on the same y read as one row; step y down by the row's height plus ~120 to start a new row."),
};
export const PushHtmlInputSchema = z.object(pushHtmlShape);
export type PushHtmlInput = z.infer<typeof PushHtmlInputSchema>;

export const getCommentsShape = {
  frameId: z.string().optional(),
  since: z.string().optional().describe("ISO timestamp or comment id; returns everything strictly after it."),
  includeResolved: z.boolean().default(false),
  author: AuthorSchema.optional(),
};
export const GetCommentsInputSchema = z.object(getCommentsShape);
export type GetCommentsInput = z.infer<typeof GetCommentsInputSchema>;

export const listFramesShape = {};
export const ListFramesInputSchema = z.object(listFramesShape);
export type ListFramesInput = z.infer<typeof ListFramesInputSchema>;

export const resolveCommentShape = {
  commentId: z.string(),
  note: z.string().min(1).optional().describe("Posted as an agent reply so the human sees what was done."),
};
export const ResolveCommentInputSchema = z.object(resolveCommentShape);
export type ResolveCommentInput = z.infer<typeof ResolveCommentInputSchema>;

export const replyToCommentShape = {
  commentId: z.string(),
  text: z.string().min(1),
};
export const ReplyToCommentInputSchema = z.object(replyToCommentShape);
export type ReplyToCommentInput = z.infer<typeof ReplyToCommentInputSchema>;

export const getFrameShape = {
  frameId: z.string(),
};
export const GetFrameInputSchema = z.object(getFrameShape);
export type GetFrameInput = z.infer<typeof GetFrameInputSchema>;

export const deleteFrameShape = {
  frameId: z.string(),
};
export const DeleteFrameInputSchema = z.object(deleteFrameShape);
export type DeleteFrameInput = z.infer<typeof DeleteFrameInputSchema>;

// ---------- MCP tool results ----------

export const PushHtmlResultSchema = z.object({
  frameId: z.string(),
  name: z.string(),
  version: z.number().int(),
  url: z.string(),
  canvasUrl: z.string(),
});
export type PushHtmlResult = z.infer<typeof PushHtmlResultSchema>;

export const GetFrameResultSchema = FrameSchema.extend({
  url: z.string(),
  canvasUrl: z.string(),
});
export type GetFrameResult = z.infer<typeof GetFrameResultSchema>;

export const GetCommentsResultSchema = z.object({
  comments: z.array(CommentSchema),
  cursor: z.string().nullable(),
  /** Frames the returned comments sit on, so a coordinate and a staleness check need no second call. */
  frames: z.array(FrameSummarySchema.pick({ id: true, name: true, width: true, height: true, version: true })),
});
export type GetCommentsResult = z.infer<typeof GetCommentsResultSchema>;

export const ListFramesResultSchema = z.object({
  frames: z.array(FrameSummarySchema),
  canvasUrl: z.string(),
});
export type ListFramesResult = z.infer<typeof ListFramesResultSchema>;

// ---------- HTTP request bodies ----------

/** POST /api/frames — same shape as push_html. */
export const CreateOrUpdateFrameBodySchema = PushHtmlInputSchema;
export type CreateOrUpdateFrameBody = z.infer<typeof CreateOrUpdateFrameBodySchema>;

/**
 * POST /api/comments — the browser's route, so `author` is NOT accepted here. It is always
 * "human". Agent-authored comments come from the MCP tools, which are the only caller that can
 * legitimately claim authorship; letting a request pick made "human" a value that agent-written
 * HTML could forge straight into the agent's own feedback stream.
 */
export const CreateCommentBodySchema = z
  .object({
    frameId: z.string(),
    x: z.number(),
    y: z.number(),
    text: z.string().min(1).max(MAX_COMMENT_CHARS, `comment text must be at most ${MAX_COMMENT_CHARS} characters`),
    parentId: z.string().nullable().optional(),
  })
  // strict, so an attempt to set `author` is a loud 400 rather than a silently dropped key.
  .strict();
export type CreateCommentBody = z.infer<typeof CreateCommentBodySchema>;

/** PATCH /api/comments/:id */
export const UpdateCommentBodySchema = z
  .object({
    resolved: z.boolean().optional(),
    text: z.string().min(1).optional(),
  })
  .refine((patch) => patch.resolved !== undefined || patch.text !== undefined, {
    message: "patch must set at least one of `resolved` or `text`",
  });
export type UpdateCommentBody = z.infer<typeof UpdateCommentBodySchema>;

/** GET /api/comments?frameId=&since=&includeResolved=&author= — values arrive as strings. */
const queryBool = z
  .enum(["true", "false", "1", "0"])
  .transform((value) => value === "true" || value === "1");

export const ListCommentsQuerySchema = z.object({
  frameId: z.string().optional(),
  since: z.string().optional(),
  includeResolved: queryBool.optional(),
  author: AuthorSchema.optional(),
});
export type ListCommentsQuery = z.infer<typeof ListCommentsQuerySchema>;

// ---------- SSE ----------

export const SSE_EVENT_NAMES = [
  "frame.created",
  "frame.updated",
  "frame.deleted",
  "comment.created",
  "comment.updated",
  "comment.deleted",
] as const;

export const SseEventNameSchema = z.enum(SSE_EVENT_NAMES);
export type SseEventName = z.infer<typeof SseEventNameSchema>;

export const HealthSchema = z.object({
  ok: z.literal(true),
  frames: z.number().int(),
  comments: z.number().int(),
});
export type Health = z.infer<typeof HealthSchema>;
