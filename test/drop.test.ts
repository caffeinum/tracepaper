import { describe, expect, test } from "bun:test";
import { describeShare, publishFrame, scriptNameFor, shareExpiry, solvePreviewChallenge, type DropFetch } from "../src/drop.ts";
import { newFrameId } from "../src/ids.ts";
import { shareText } from "../src/share.ts";
import { Store } from "../src/store.ts";

describe("drop expiry", () => {
  test("script names are hostname-safe", () => {
    expect(scriptNameFor("frm_a4001f1de7d4")).toBe("frm-a4001f1de7d4");
    expect(() => scriptNameFor("nope")).toThrow(/not a tracepaper id/);
  });

  test("expiry is the earlier timestamp, and a missing one throws", () => {
    expect(shareExpiry("2026-10-16T21:00:00.000Z", "2026-10-16T20:30:00.000Z")).toBe(
      "2026-10-16T20:30:00.000Z",
    );
    expect(() => shareExpiry("not-a-date", "2026-10-16T20:30:00.000Z")).toThrow(/account.expiresAt/);
  });

  test("the human-readable line names both the publish time and the expiry", () => {
    const created = "2026-10-16T20:00:00.000Z";
    const expires = "2026-10-16T21:00:00.000Z";
    const now = Date.parse("2026-10-16T20:10:00.000Z");
    expect(describeShare(created, expires, now)).toBe(
      `published ${created}, expires ${expires} (50m left)`,
    );
    expect(describeShare(created, expires, Date.parse(expires))).toContain("expired");
  });

  test("the proof-of-work chain is deterministic for a tiny challenge", async () => {
    const seed = Buffer.alloc(32, 7).toString("base64url");
    const solved = await solvePreviewChallenge({ challengeToken: "tok", seed, k: 1, g: 1 });
    expect(solved.challengeToken).toBe("tok");
    const again = await solvePreviewChallenge({ challengeToken: "tok", seed, k: 1, g: 1 });
    expect(solved.solution.checkpoints).toBe(again.solution.checkpoints);
    await expect(solvePreviewChallenge({ challengeToken: "tok", seed: "aa", k: 1, g: 1 })).rejects.toThrow(
      /32 bytes/,
    );
  });
});

describe("frame shares", () => {
  test("a share remembers when it was created and when it expires, and hides the claim after", () => {
    const store = new Store(":memory:");
    const frame = store.createFrame({ html: "<p>hi</p>", name: "Hi", repo: "demo" });
    const createdAt = new Date(Date.now() - 60_000).toISOString();
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    store.saveDropAccount({
      id: "acct",
      name: "preview",
      apiToken: "secret-token",
      claimUrl: "https://dash.cloudflare.com/claim-preview?claimToken=secret",
      createdAt,
      expiresAt,
    });
    const share = store.saveFrameShare({
      frameId: frame.id,
      frameVersion: frame.version,
      url: "https://frm-abc.preview.workers.dev",
      accountId: "acct",
      createdAt,
      expiresAt,
    });
    expect(share.createdAt).toBe(createdAt);
    expect(share.expiresAt).toBe(expiresAt);
    expect(share.claimUrl).toContain("claimToken");
    expect(JSON.stringify(share)).not.toContain("secret-token");
    expect(shareText(share)).toContain(createdAt);
    expect(shareText(share)).toContain(expiresAt);

    store.wipeExpiredDropSecrets(new Date(Date.parse(expiresAt) + 1000).toISOString());
    const later = store.listFrameShares("demo");
    expect(later).toHaveLength(1);
    expect(later[0]?.claimUrl).toBe("");
    expect(later[0]?.expiresAt).toBe(expiresAt);
    expect(later[0]?.createdAt).toBe(createdAt);
    expect(store.liveDropAccount(new Date(Date.parse(expiresAt) + 1000).toISOString())).toBeNull();
  });

  test("ids are the spec shape", () => {
    expect(newFrameId()).toMatch(/^frm_[0-9a-f]{12}$/);
  });
});

describe("publishFrame", () => {
  test("the live url comes from the temporary account, not a guessed host", async () => {
    const calls: string[] = [];
    const fetchImpl: DropFetch = async (input, init) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify({ success: true, result: body }), { status });
      if (url.endsWith("/provisioning/previews/challenge")) {
        return json({
          challengeToken: "tok",
          seed: Buffer.alloc(32, 3).toString("base64url"),
          k: 1,
          g: 1,
        });
      }
      if (url.endsWith("/provisioning/previews")) {
        return json({
          account: {
            id: "acct_1",
            name: "preview-name",
            apiToken: "tok-secret",
            expiresAt: "2099-01-01T00:00:00.000Z",
          },
          claim: {
            url: "https://dash.cloudflare.com/claim-preview?claimToken=abc",
            expiresAt: "2099-01-01T00:00:00.000Z",
          },
        });
      }
      if (url.endsWith("/workers/subdomain") && (init?.method ?? "GET") === "GET") {
        return json({ subdomain: "preview-name" });
      }
      if (url.includes("/workers/scripts/frm-a4001f1de7d4")) return json({ id: "frm-a4001f1de7d4" });
      throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    };
    const published = await publishFrame({
      html: "<h1>hi</h1>",
      scriptName: "frm-a4001f1de7d4",
      fetchImpl,
      now: new Date("2098-12-31T00:00:00.000Z"),
    });
    expect(published.url).toBe("https://frm-a4001f1de7d4.preview-name.workers.dev");
    expect(published.account.createdAt).toBe("2098-12-31T00:00:00.000Z");
    expect(published.account.expiresAt).toBe("2099-01-01T00:00:00.000Z");
    expect(calls.some((call) => call.startsWith("PUT "))).toBe(true);
  });
});
