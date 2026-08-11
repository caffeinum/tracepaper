const ID_BYTES = 6;

export const FRAME_ID_RE = /^frm_[0-9a-f]{12}$/;
export const COMMENT_ID_RE = /^cmt_[0-9a-f]{12}$/;

function hex12(): string {
  const bytes = new Uint8Array(ID_BYTES);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function newFrameId(): string {
  return `frm_${hex12()}`;
}

export function newCommentId(): string {
  return `cmt_${hex12()}`;
}

export function isCommentId(value: string): boolean {
  return COMMENT_ID_RE.test(value);
}
