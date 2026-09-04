import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome } from "../src/screenshot.ts";

describe("findChrome", () => {
  test("TRACEPAPER_CHROME pointing at an existing file is returned", () => {
    const dir = mkdtempSync(join(tmpdir(), "tracepaper-chrome-"));
    const fake = join(dir, "chrome");
    writeFileSync(fake, "#!/bin/sh\n");
    expect(findChrome({ TRACEPAPER_CHROME: fake } as NodeJS.ProcessEnv)).toBe(fake);
  });

  test("PAPER_MCP_CHROME is honoured as the legacy fallback", () => {
    const dir = mkdtempSync(join(tmpdir(), "tracepaper-chrome-"));
    const fake = join(dir, "chrome");
    writeFileSync(fake, "#!/bin/sh\n");
    expect(findChrome({ PAPER_MCP_CHROME: fake } as NodeJS.ProcessEnv)).toBe(fake);
  });

  test("a nonexistent override falls through rather than being returned", () => {
    const missing = join(tmpdir(), "tracepaper-does-not-exist-xyz", "chrome");
    // The override does not exist, so it must never be returned; findChrome falls through to the
    // other lookups (which may or may not find a real browser on this machine — either way, not
    // the bogus path). Asserting `!== missing` keeps the test green whether or not Chrome is here.
    const result = findChrome({ TRACEPAPER_CHROME: missing } as NodeJS.ProcessEnv);
    expect(result).not.toBe(missing);
  });
});
