/**
 * Every frame belongs to a repo — a scope / canvas. Each agent runs its own stdio process in its
 * own cwd and adopts the shared HTTP server, so the repo must be resolved HERE, in that process,
 * from its cwd and env — never in the shared server, which has no per-connection identity.
 *
 * Resolution order (see resolveRepo): an explicit `repo` tool argument (handled by the caller),
 * then TRACEPAPER_REPO / PAPER_MCP_REPO, then git auto-detect, then the cwd basename. It never
 * throws and never returns empty — the final fallback is "default".
 */

import { spawnSync } from "node:child_process";
import { basename } from "node:path";

/** The repo string every frame lands on when nothing else resolves one. */
export const DEFAULT_REPO = "default";

/** A repo string longer than this is truncated — it is an index key and a URL param, not prose. */
const MAX_REPO_LEN = 200;

/**
 * Normalizes a repo identifier to a stable `host/owner/repo` (or a bare name) key.
 *
 * Strips a scheme, the `git@host:` scp-like form, any `.git` suffix, a trailing slash, and
 * lowercases — so `git@github.com:caffeinum/tracepaper.git` and
 * `https://github.com/caffeinum/tracepaper` both collapse to `github.com/caffeinum/tracepaper`.
 * Returns "default" for anything that normalizes to empty.
 */
export function normalizeRepo(raw: string): string {
  let value = raw.trim();
  if (value === "") return DEFAULT_REPO;

  // scp-like: git@github.com:owner/repo(.git) → github.com/owner/repo
  value = value.replace(/^[^@/]+@([^:]+):/, "$1/");
  // scheme://[user[:pass]@]host/… → host/…
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  value = value.replace(/^[^@/]+@/, "");
  // trailing slashes, then a single .git suffix
  value = value.replace(/\/+$/, "");
  value = value.replace(/\.git$/i, "");
  value = value.replace(/\/+$/, "");
  value = value.toLowerCase();

  if (value.length > MAX_REPO_LEN) value = value.slice(0, MAX_REPO_LEN);
  return value === "" ? DEFAULT_REPO : value;
}

/** Reads `TRACEPAPER_REPO`, falling back to the pre-rename `PAPER_MCP_REPO`. */
function repoFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  for (const name of ["TRACEPAPER_REPO", "PAPER_MCP_REPO"]) {
    const value = env[name];
    if (value !== undefined && value.trim() !== "") return value;
  }
  return undefined;
}

/** Runs a git command in `cwd`, returning trimmed stdout or undefined if git is absent/fails. */
function git(args: string[], cwd: string): string | undefined {
  try {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 3000 });
    if (result.status !== 0 || typeof result.stdout !== "string") return undefined;
    const out = result.stdout.trim();
    return out === "" ? undefined : out;
  } catch {
    return undefined;
  }
}

/**
 * Resolves the repo for a connection from its env and cwd. Never throws, never returns empty.
 *
 * env `TRACEPAPER_REPO` / `PAPER_MCP_REPO` wins; otherwise auto-detect from git run in `cwd`
 * (remote origin url, then the worktree toplevel basename); otherwise the cwd basename. An
 * explicit per-call `repo` argument is applied by the caller and is not this function's concern.
 */
export function resolveRepo(env: NodeJS.ProcessEnv, cwd: string): string {
  const fromEnv = repoFromEnv(env);
  if (fromEnv !== undefined) return normalizeRepo(fromEnv);

  const origin = git(["remote", "get-url", "origin"], cwd);
  if (origin !== undefined) return normalizeRepo(origin);

  const top = git(["rev-parse", "--show-toplevel"], cwd);
  if (top !== undefined) return normalizeRepo(basename(top));

  return normalizeRepo(basename(cwd));
}
