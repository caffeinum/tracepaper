import { z } from "zod";
import { COMMENT_ID_RE, FRAME_ID_RE } from "./ids.ts";

export const DEFAULT_FRAME_WIDTH = 1280;
export const DEFAULT_FRAME_HEIGHT = 900;

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

export const CreateFrameInputSchema = z.object({
  html: z.string(),
  name: z.string().min(1).optional(),
  width: z.number().positive().default(DEFAULT_FRAME_WIDTH),
  height: z.number().positive().default(DEFAULT_FRAME_HEIGHT),
});
export type CreateFrameInput = z.input<typeof CreateFrameInputSchema>;

export const CreateCommentInputSchema = z.object({
  frameId: z.string(),
  x: z.number(),
  y: z.number(),
  text: z.string().min(1),
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
  html: z.string().describe("Full HTML document or fragment, served verbatim."),
  name: z.string().min(1).optional().describe("Human label shown above the frame."),
  frameId: z.string().optional().describe("Existing frame to replace in place. Omit to create a new frame."),
  width: z.number().positive().default(DEFAULT_FRAME_WIDTH),
  height: z.number().positive().default(DEFAULT_FRAME_HEIGHT),
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

export const GetCommentsResultSchema = z.object({
  comments: z.array(CommentSchema),
  cursor: z.string().nullable(),
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

/** POST /api/comments */
export const CreateCommentBodySchema = z.object({
  frameId: z.string(),
  x: z.number(),
  y: z.number(),
  text: z.string().min(1),
  parentId: z.string().nullable().optional(),
  author: AuthorSchema.default("human"),
});
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
