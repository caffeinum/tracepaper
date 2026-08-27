import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DEFAULT_REPO, normalizeRepo, resolveRepo } from "../src/repo.ts";

describe("normalizeRepo", () => {
  test("scp-like and https git urls collapse to the same host/owner/repo", () => {
    expect(normalizeRepo("git@github.com:caffeinum/tracepaper.git")).toBe(
      "github.com/caffeinum/tracepaper",
    );
    expect(normalizeRepo("https://github.com/caffeinum/tracepaper")).toBe(
      "github.com/caffeinum/tracepaper",
    );
    expect(normalizeRepo("https://github.com/caffeinum/tracepaper.git")).toBe(
      "github.com/caffeinum/tracepaper",
    );
    expect(normalizeRepo("https://github.com/caffeinum/tracepaper/")).toBe(
      "github.com/caffeinum/tracepaper",
    );
  });

  test("strips a userinfo prefix and lowercases", () => {
    expect(normalizeRepo("https://user@github.com/Caffeinum/TracePaper.git")).toBe(
      "github.com/caffeinum/tracepaper",
    );
    expect(normalizeRepo("ssh://git@gitlab.com/group/sub/proj.git")).toBe(
      "gitlab.com/group/sub/proj",
    );
  });

  test("a bare name passes through, empty falls back to default", () => {
    expect(normalizeRepo("my-project")).toBe("my-project");
    expect(normalizeRepo("")).toBe(DEFAULT_REPO);
    expect(normalizeRepo("   ")).toBe(DEFAULT_REPO);
    expect(normalizeRepo(".git")).toBe(DEFAULT_REPO);
  });

  test("caps absurd lengths", () => {
    const long = "a".repeat(500);
    expect(normalizeRepo(long).length).toBeLessThanOrEqual(200);
  });
});

describe("resolveRepo precedence", () => {
  test("TRACEPAPER_REPO wins and is normalized", () => {
    const repo = resolveRepo(
      { TRACEPAPER_REPO: "git@github.com:Acme/Widgets.git" },
      "/tmp/whatever",
    );
    expect(repo).toBe("github.com/acme/widgets");
  });

  test("PAPER_MCP_REPO is the fallback when TRACEPAPER_REPO is absent", () => {
    expect(resolveRepo({ PAPER_MCP_REPO: "legacy-canvas" }, "/tmp/x")).toBe("legacy-canvas");
    // TRACEPAPER_REPO takes priority over the legacy name.
    expect(
      resolveRepo({ TRACEPAPER_REPO: "new", PAPER_MCP_REPO: "old" }, "/tmp/x"),
    ).toBe("new");
  });

  test("an empty env var is ignored, not treated as a repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "tracepaper-repo-empty-"));
    try {
      // No git here, empty env → falls through to the cwd basename.
      expect(resolveRepo({ TRACEPAPER_REPO: "" }, dir)).toBe(normalizeRepo(basename(dir)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("with no env and no git, falls back to the cwd basename", () => {
    const dir = mkdtempSync(join(tmpdir(), "tracepaper-repo-nogit-"));
    try {
      expect(resolveRepo({}, dir)).toBe(normalizeRepo(basename(dir)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("auto-detects and normalizes a git remote origin from the cwd", () => {
    const dir = mkdtempSync(join(tmpdir(), "tracepaper-repo-git-"));
    try {
      const run = (...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
      const init = run("init", "-q");
      if (init.status !== 0) return; // git not installed in this environment — skip
      run("remote", "add", "origin", "git@github.com:Caffeinum/TracePaper.git");
      expect(resolveRepo({}, dir)).toBe("github.com/caffeinum/tracepaper");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
