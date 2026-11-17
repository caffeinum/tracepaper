import { describe, expect, test } from "bun:test";
import { loadConfig, takeHostFlag } from "../src/config.ts";

describe("bind host", () => {
  test("defaults to loopback and --host overrides it", () => {
    expect(loadConfig({}).host).toBe("127.0.0.1");
    expect(loadConfig({ TRACEPAPER_HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
    expect(takeHostFlag(["serve", "--host", "100.123.17.30"])).toEqual({
      argv: ["serve"],
      host: "100.123.17.30",
    });
  });

  test("rejects a URL", () => {
    expect(() => loadConfig({ TRACEPAPER_HOST: "http://0.0.0.0" })).toThrow(/not a URL/);
    expect(() => takeHostFlag(["serve", "--host"])).toThrow(/needs an IP/);
  });
});
