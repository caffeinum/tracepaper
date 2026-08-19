import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";

// The CLI opens the db loadConfig() resolves from the environment. Point HOME and the db at a temp
// dir so a run never touches the real ~/.tracepaper, and each test starts from an empty canvas.
const home = mkdtempSync(join(tmpdir(), "tracepaper-cli-home-"));
const savedHome = process.env["HOME"];
const savedDb = process.env["TRACEPAPER_DB"];

beforeAll(() => {
  process.env["HOME"] = home;
});

afterAll(() => {
  if (savedHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = savedHome;
  if (savedDb === undefined) delete process.env["TRACEPAPER_DB"];
  else process.env["TRACEPAPER_DB"] = savedDb;
  rmSync(home, { recursive: true, force: true });
});

let out: string;
let err: string;
let restore: () => void;

beforeEach(() => {
  process.env["TRACEPAPER_DB"] = join(mkdtempSync(join(tmpdir(), "tracepaper-cli-db-")), "t.db");
  out = "";
  err = "";
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk: string) => ((out += chunk), true);
  process.stderr.write = (chunk: string) => ((err += chunk), true);
  restore = () => {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  };
});

afterEach(() => restore());

/** Run a verb, restore stdio so an assertion failure still prints, return the exit code. */
async function cli(verb: string, ...rest: string[]): Promise<number> {
  const code = await runCli(verb, rest);
  return code;
}

function frameFile(html: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "tracepaper-cli-html-")), "f.html");
  writeFileSync(path, html);
  return path;
}

describe("tracepaper cli", () => {
  test("push creates a frame and reports it saved with no server", async () => {
    const code = await cli("push", frameFile("<h1>hi</h1>"), "--name", "one", "--width", "300", "--height", "200");
    restore();
    expect(code).toBe(0);
    expect(out).toMatch(/frm_[0-9a-f]+\s+300×200/);
    expect(out).toContain("not running");
  });

  test("push --json round-trips through list and get", async () => {
    await cli("push", frameFile("<p>body</p>"), "--name", "solo", "--json");
    const pushed = JSON.parse(out) as { frame: { id: string; html: string } };
    expect(pushed.frame.html).toBe("<p>body</p>");

    out = "";
    await cli("get", pushed.frame.id);
    restore();
    expect(out.trim()).toBe("<p>body</p>");
  });

  test("comments → reply → resolve threads and cascades", async () => {
    // Seed a frame, then a human comment written straight to the same db.
    await cli("push", frameFile("<h1>x</h1>"), "--name", "f", "--json");
    const { frame } = JSON.parse(out) as { frame: { id: string } };
    const { Store } = await import("../src/store.ts");
    const seed = new Store(process.env["TRACEPAPER_DB"]!);
    const human = seed.createComment({ frameId: frame.id, x: 1, y: 2, text: "fix this", author: "human" });
    seed.close();

    out = "";
    expect(await cli("comments")).toBe(0);
    expect(out).toContain(human.id);
    expect(out).toContain("[human]");
    expect(out).toMatch(/cursor: cur_\d+/);

    out = "";
    expect(await cli("reply", human.id, "on", "it")).toBe(0);
    expect(out).toMatch(/replied to/);

    out = "";
    expect(await cli("resolve", human.id, "--note", "closed")).toBe(0);

    out = "";
    await cli("comments", "--resolved");
    restore();
    expect(out).toContain("[human · resolved]");
    expect(out).toContain("[agent · resolved]");
    expect(out).toContain("on it");
    expect(out).toContain("closed");
  });

  test("unknown frame fails loudly with exit 1 and no stack", async () => {
    const code = await cli("get", "frm_missing");
    restore();
    expect(code).toBe(1);
    expect(err).toContain("tracepaper: unknown frame");
    expect(err).not.toContain("at ");
    expect(out).toBe("");
  });

  test("delete removes a frame", async () => {
    await cli("push", frameFile("<i>bye</i>"), "--name", "gone", "--json");
    const { frame } = JSON.parse(out) as { frame: { id: string } };
    out = "";
    expect(await cli("delete", frame.id)).toBe(0);
    out = "";
    await cli("list");
    restore();
    expect(out).toContain("canvas is empty");
  });
});
