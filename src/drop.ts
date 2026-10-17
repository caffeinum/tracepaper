import { createHash } from "node:crypto";
import { FRAME_ID_RE } from "./ids.ts";

/**
 * Cloudflare Drop, the no-account static publish. A temporary account is created with a
 * proof-of-work challenge, the frame HTML is deployed as a Worker, and the claim URL dies
 * at the timestamp Cloudflare returns. That timestamp is the expiry — never a guessed 60 minutes.
 *
 * `apiToken` authorizes the temporary account. It stays in the db and never leaves the process.
 * `claimUrl` is a bearer credential: anyone who opens it can take the account.
 */
const API = "https://api.cloudflare.com/client/v4";
const TERMS = "https://www.cloudflare.com/terms/";
const PRIVACY = "https://www.cloudflare.com/privacypolicy/";
const POW_MAX = 64_000_000;

export type DropFetch = (url: string, init?: RequestInit) => Promise<Response>;

export type DropAccount = {
  id: string;
  name: string;
  apiToken: string;
  claimUrl: string;
  /** When we created the account, ISO. */
  createdAt: string;
  /** When Cloudflare deletes it if unclaimed, ISO. The earlier of the two expiries they return. */
  expiresAt: string;
};

export type PublishedFrame = {
  url: string;
  scriptName: string;
  account: DropAccount;
  /** True when an existing unexpired account was reused, so the claim window did not reset. */
  reusedAccount: boolean;
};

type Challenge = {
  challengeToken: string;
  seed: string;
  k: number;
  g: number;
};

export function scriptNameFor(frameId: string): string {
  if (!FRAME_ID_RE.test(frameId)) {
    throw new Error(`frame id is not a tracepaper id: ${frameId}`);
  }
  // workers.dev hostnames reject underscores. frm_ + 12 hex → frm- + 12 hex.
  return `frm-${frameId.slice(4)}`;
}

export function shareExpiry(accountExpiresAt: string, claimExpiresAt: string): string {
  const account = Date.parse(accountExpiresAt);
  const claim = Date.parse(claimExpiresAt);
  if (Number.isNaN(account)) throw new Error(`account.expiresAt is not a date: ${accountExpiresAt}`);
  if (Number.isNaN(claim)) throw new Error(`claim.expiresAt is not a date: ${claimExpiresAt}`);
  return account <= claim ? accountExpiresAt : claimExpiresAt;
}

/** How a share reads to a human. createdAt is when this snapshot was published, not when the account was. */
export function describeShare(createdAt: string, expiresAt: string, now = Date.now()): string {
  const created = Date.parse(createdAt);
  const expires = Date.parse(expiresAt);
  if (Number.isNaN(created)) throw new Error(`share createdAt is not a date: ${createdAt}`);
  if (Number.isNaN(expires)) throw new Error(`share expiresAt is not a date: ${expiresAt}`);
  if (expires <= now) return `published ${createdAt}, expired ${expiresAt}`;
  const mins = Math.max(1, Math.ceil((expires - now) / 60_000));
  return `published ${createdAt}, expires ${expiresAt} (${mins}m left)`;
}

export async function solvePreviewChallenge(challenge: Challenge): Promise<{
  challengeToken: string;
  solution: { checkpoints: string };
}> {
  const seed = Buffer.from(challenge.seed, "base64url");
  if (seed.length !== 32) throw new Error(`proof-of-work seed must be 32 bytes, got ${seed.length}`);
  if (!Number.isInteger(challenge.k) || challenge.k <= 0) {
    throw new Error(`proof-of-work k must be a positive integer, got ${challenge.k}`);
  }
  if (!Number.isInteger(challenge.g) || challenge.g <= 0) {
    throw new Error(`proof-of-work g must be a positive integer, got ${challenge.g}`);
  }
  if (challenge.k * challenge.g > POW_MAX) {
    throw new Error(`proof-of-work k*g ${challenge.k * challenge.g} exceeds ${POW_MAX}`);
  }
  if (challenge.challengeToken === "") throw new Error("proof-of-work challengeToken is empty");

  const checkpoints: Buffer[] = [];
  let hash = createHash("sha256").update(seed).digest();
  checkpoints.push(hash);
  for (let segment = 0; segment < challenge.k; segment++) {
    for (let i = 0; i < challenge.g; i++) hash = createHash("sha256").update(hash).digest();
    checkpoints.push(hash);
    // The real challenge is millions of hashes. Yield so the canvas server keeps serving.
    if (segment % 32 === 31) await Bun.sleep(0);
  }
  return {
    challengeToken: challenge.challengeToken,
    solution: { checkpoints: Buffer.concat(checkpoints).toString("base64") },
  };
}

function requireString(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== "string" || value === "") {
    throw new Error(`Cloudflare ${where} is missing ${key}`);
  }
  return value;
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Cloudflare ${where} is not an object`);
  }
  return value as Record<string, unknown>;
}

async function readApi(response: Response, where: string): Promise<Record<string, unknown>> {
  const text = await response.text();
  let body: unknown;
  try {
    body = text === "" ? {} : JSON.parse(text);
  } catch {
    throw new Error(`Cloudflare ${where} returned non-JSON (${response.status}): ${text.slice(0, 200)}`);
  }
  const record = asRecord(body, where);
  if (record["success"] === false || !response.ok) {
    const errors = record["errors"];
    const detail = Array.isArray(errors) ? JSON.stringify(errors) : text.slice(0, 300);
    throw new Error(`Cloudflare ${where} failed (${response.status}): ${detail}`);
  }
  return record;
}

function resultOf(body: Record<string, unknown>, where: string): Record<string, unknown> {
  return asRecord(body["result"], `${where} result`);
}

export async function createDropAccount(fetchImpl: DropFetch, now = new Date()): Promise<DropAccount> {
  const challengeRes = await fetchImpl(`${API}/provisioning/previews/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const challengeBody = resultOf(await readApi(challengeRes, "challenge"), "challenge");
  const solved = await solvePreviewChallenge({
    challengeToken: requireString(challengeBody, "challengeToken", "challenge"),
    seed: requireString(challengeBody, "seed", "challenge"),
    k: challengeBody["k"] as number,
    g: challengeBody["g"] as number,
  });
  const created = await fetchImpl(`${API}/provisioning/previews`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      termsOfService: TERMS,
      privacyPolicy: PRIVACY,
      acceptTermsOfService: "yes",
      challengeToken: solved.challengeToken,
      solution: solved.solution,
    }),
  });
  const preview = resultOf(await readApi(created, "temporary account"), "temporary account");
  const account = asRecord(preview["account"], "account");
  const claim = asRecord(preview["claim"], "claim");
  const accountExpiresAt = requireString(account, "expiresAt", "account");
  const claimExpiresAt = requireString(claim, "expiresAt", "claim");
  return {
    id: requireString(account, "id", "account"),
    name: requireString(account, "name", "account"),
    apiToken: requireString(account, "apiToken", "account"),
    claimUrl: requireString(claim, "url", "claim"),
    createdAt: now.toISOString(),
    expiresAt: shareExpiry(accountExpiresAt, claimExpiresAt),
  };
}

function workerSource(html: string): string {
  return `export default { fetch() { return new Response(${JSON.stringify(html)}, { headers: { "content-type": "text/html; charset=utf-8" } }); } };\n`;
}

async function workersDevHost(fetchImpl: DropFetch, account: DropAccount): Promise<string> {
  const auth = { authorization: `Bearer ${account.apiToken}` };
  const got = await fetchImpl(`${API}/accounts/${account.id}/workers/subdomain`, { headers: auth });
  if (got.ok) {
    const body = resultOf(await readApi(got, "subdomain"), "subdomain");
    const name = requireString(body, "subdomain", "subdomain");
    return name.endsWith(".workers.dev") ? name : `${name}.workers.dev`;
  }
  // 10007 is "no subdomain yet". Anything else is a real failure — readApi throws.
  const missing = await got.text();
  if (!missing.includes("10007")) {
    throw new Error(`Cloudflare subdomain lookup failed (${got.status}): ${missing.slice(0, 300)}`);
  }
  const wanted = account.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(wanted)) {
    throw new Error(`temporary account name is not a workers.dev subdomain: ${account.name}`);
  }
  const registered = await fetchImpl(`${API}/accounts/${account.id}/workers/subdomain`, {
    method: "PUT",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ subdomain: wanted }),
  });
  const body = resultOf(await readApi(registered, "register subdomain"), "register subdomain");
  const name = requireString(body, "subdomain", "register subdomain");
  return name.endsWith(".workers.dev") ? name : `${name}.workers.dev`;
}

export async function deployFrameHtml(
  fetchImpl: DropFetch,
  account: DropAccount,
  scriptName: string,
  html: string,
  now = new Date(),
): Promise<string> {
  const form = new FormData();
  const metadata = {
    main_module: "worker.mjs",
    compatibility_date: now.toISOString().slice(0, 10),
  };
  form.set("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }), "metadata.json");
  form.set(
    "worker.mjs",
    new Blob([workerSource(html)], { type: "application/javascript+module" }),
    "worker.mjs",
  );
  const uploaded = await fetchImpl(`${API}/accounts/${account.id}/workers/scripts/${scriptName}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${account.apiToken}` },
    body: form,
  });
  await readApi(uploaded, `upload ${scriptName}`);

  const enabled = await fetchImpl(`${API}/accounts/${account.id}/workers/scripts/${scriptName}/subdomain`, {
    method: "POST",
    headers: { authorization: `Bearer ${account.apiToken}`, "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  await readApi(enabled, `enable ${scriptName} on workers.dev`);

  const host = await workersDevHost(fetchImpl, account);
  return `https://${scriptName}.${host}`;
}

export async function publishFrame(opts: {
  html: string;
  scriptName: string;
  fetchImpl?: DropFetch;
  now?: Date;
  account?: DropAccount | null;
}): Promise<PublishedFrame> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? new Date();
  const existing = opts.account ?? null;
  if (existing !== null && Date.parse(existing.expiresAt) > now.getTime()) {
    const url = await deployFrameHtml(fetchImpl, existing, opts.scriptName, opts.html, now);
    return { url, scriptName: opts.scriptName, account: existing, reusedAccount: true };
  }
  const account = await createDropAccount(fetchImpl, now);
  const url = await deployFrameHtml(fetchImpl, account, opts.scriptName, opts.html, now);
  return { url, scriptName: opts.scriptName, account, reusedAccount: false };
}
