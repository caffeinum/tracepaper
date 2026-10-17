import { describeShare, publishFrame, scriptNameFor, type DropFetch } from "./drop.ts";
import type { FrameShareRow, Store } from "./store.ts";

/**
 * Publish one frame's HTML as a Cloudflare Drop preview and remember when that preview dies.
 * The account token is stored. The returned row never includes it.
 */
export async function shareFrame(store: Store, frameId: string, fetchImpl?: DropFetch): Promise<FrameShareRow> {
  const frame = store.getFrame(frameId);
  if (frame.kind !== "html") {
    throw new Error(`only an html frame can be published, ${frame.id} is ${frame.kind}`);
  }
  const scriptName = scriptNameFor(frame.id);
  const existing = store.liveDropAccount();
  let published;
  try {
    published = await publishFrame({ html: frame.html, scriptName, fetchImpl, account: existing });
  } catch (error) {
    if (existing === null || !isAuthFailure(error)) throw error;
    published = await publishFrame({ html: frame.html, scriptName, fetchImpl, account: null });
  }
  if (!published.reusedAccount) store.saveDropAccount(published.account);
  return store.saveFrameShare({
    frameId: frame.id,
    frameVersion: frame.version,
    url: published.url,
    accountId: published.account.id,
    createdAt: new Date().toISOString(),
    expiresAt: published.account.expiresAt,
  });
}

function isAuthFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\(401\)|\(403\)/.test(message);
}

export function shareText(share: FrameShareRow): string {
  const claim =
    share.claimUrl === ""
      ? "claim window closed"
      : `claim: ${share.claimUrl}\nAnyone with the claim link can take the Cloudflare account. Give it only to the human.`;
  return [
    `Shared ${share.frameId} v${share.frameVersion}`,
    `live: ${share.url}`,
    claim,
    describeShare(share.createdAt, share.expiresAt),
  ].join("\n");
}
