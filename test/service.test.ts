import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/events.ts";
import { startHttpServer } from "../src/http.ts";
import { buildPlist, ephemeralReason } from "../src/service.ts";
import { Store } from "../src/store.ts";

const base = {
  label: "com.example.tracepaper",
  bun: "/opt/bun/bin/bun",
  entry: "/opt/tp/node_modules/tracepaper/src/index.ts",
  port: 4321,
  dbPath: "/Users/x/.paper-mcp/paper.db",
  stateDir: "/Users/x/.tracepaper",
  logPath: "/Users/x/.tracepaper/service.log",
  home: "/Users/x",
  path: "/usr/bin:/bin",
};

describe("service plist", () => {
  test("runs `serve` from the pinned entry, kept alive, strict on its port", () => {
    const xml = buildPlist(base);
    expect(xml).toContain("<string>com.example.tracepaper</string>");
    expect(xml).toMatch(/<string>\/opt\/bun\/bin\/bun<\/string>\s*<string>run<\/string>\s*<string>\/opt\/tp\/node_modules\/tracepaper\/src\/index.ts<\/string>\s*<string>serve<\/string>/);
    expect(xml).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(xml).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(xml).toMatch(/<key>TRACEPAPER_STRICT_PORT<\/key>\s*<string>1<\/string>/);
    expect(xml).toMatch(/<key>TRACEPAPER_PORT<\/key>\s*<string>4321<\/string>/);
    expect(xml).toMatch(/<key>TRACEPAPER_DB<\/key>\s*<string>\/Users\/x\/.paper-mcp\/paper.db<\/string>/);
  });

  test("escapes XML in paths", () => {
    const xml = buildPlist({ ...base, dbPath: "/a&b/<c>.db" });
    expect(xml).toContain("/a&amp;b/&lt;c&gt;.db");
    expect(xml).not.toContain("/a&b/");
  });

  test.if(process.platform === "darwin")("is a valid property list (plutil -lint)", () => {
    const dir = mkdtempSync(join(tmpdir(), "tp-plist-"));
    try {
      const file = join(dir, "t.plist");
      writeFileSync(file, buildPlist({ ...base, dbPath: "/a&b/<c>.db" }));
      const r = spawnSync("plutil", ["-lint", file], { encoding: "utf8" });
      expect(r.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("service refuses a package root that can vanish", () => {
  test("temp dirs are refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "tp-root-"));
    try {
      expect(ephemeralReason(dir)).toContain("temp dir");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("npx and bunx caches are refused", () => {
    expect(ephemeralReason(join(homedir(), ".npm", "_npx", "abc", "node_modules", "tracepaper"))).toContain("npx cache");
    expect(ephemeralReason("/Users/x/.bun/install/cache/tracepaper@1.0.0")).toContain("bun");
  });

  test("a stable install (like this checkout) is accepted", () => {
    expect(ephemeralReason(process.cwd())).toBeNull();
  });
});

describe("strict port", () => {
  const webDir = mkdtempSync(join(tmpdir(), "tp-strict-web-"));
  mkdirSync(join(webDir, "dist"));
  writeFileSync(join(webDir, "index.html"), "<title>c</title>");
  writeFileSync(join(webDir, "dist", "canvas.js"), "export {}");

  test("a held port fails a strict bind instead of drifting to the next one", () => {
    const holder = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const store = new Store(":memory:");
    try {
      expect(() =>
        startHttpServer({ store, bus: new Bus(), port: holder.port!, host: "127.0.0.1", webDir, strictPort: true }),
      ).toThrow(/strict port/);

      // negative control: without strict it still falls back, so the test above is testing strictness
      const loose = startHttpServer({ store, bus: new Bus(), port: holder.port!, host: "127.0.0.1", webDir });
      expect(loose.port).not.toBe(holder.port);
      loose.stop();
    } finally {
      holder.stop(true);
      store.close();
    }
  });
});
