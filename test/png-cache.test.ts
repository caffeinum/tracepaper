import { describe, expect, test } from "bun:test";
import { MAX_CONCURRENT_RENDERS, renderCached } from "../src/screenshot.ts";

/**
 * The render-through cache is tested with an injected fake render fn, never a real Chrome, so the
 * suite stays green in CI where no browser is installed. Each test uses distinct frame ids so the
 * process-wide cache from other tests can't interfere.
 */

const bytes = (n: number): Uint8Array => new Uint8Array([n]);

describe("renderCached", () => {
  test("same id+version renders once, then serves from cache", async () => {
    let calls = 0;
    const render = async (): Promise<Uint8Array> => {
      calls++;
      return bytes(calls);
    };
    const first = await renderCached("frm_once000000", 1, render);
    const second = await renderCached("frm_once000000", 1, render);
    expect(calls).toBe(1);
    expect(second).toBe(first);
  });

  test("a version change re-renders and overwrites the entry", async () => {
    let calls = 0;
    const render = async (): Promise<Uint8Array> => {
      calls++;
      return bytes(calls);
    };
    const v1 = await renderCached("frm_ver0000000", 1, render);
    const v2 = await renderCached("frm_ver0000000", 2, render);
    expect(calls).toBe(2);
    expect(v1).not.toBe(v2);
    // The new version is now cached; the old is gone.
    await renderCached("frm_ver0000000", 2, render);
    expect(calls).toBe(2);
  });

  test("60 concurrent requests for the same id+version render once (in-flight de-dupe)", async () => {
    let calls = 0;
    const render = async (): Promise<Uint8Array> => {
      calls++;
      await Bun.sleep(10);
      return bytes(1);
    };
    await Promise.all(Array.from({ length: 60 }, () => renderCached("frm_dedupe0000", 7, render)));
    expect(calls).toBe(1);
  });

  test("concurrent renders of distinct frames never exceed the cap", async () => {
    let active = 0;
    let peak = 0;
    const render = async (): Promise<Uint8Array> => {
      active++;
      peak = Math.max(peak, active);
      await Bun.sleep(15);
      active--;
      return bytes(1);
    };
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => renderCached(`frm_conc${i.toString().padStart(6, "0")}`, 1, render)),
    );
    expect(peak).toBeLessThanOrEqual(MAX_CONCURRENT_RENDERS);
    expect(peak).toBeGreaterThan(1); // the cap actually engaged
  });

  test("a failed render caches nothing and rejects the sharers", async () => {
    let calls = 0;
    const render = async (): Promise<Uint8Array> => {
      calls++;
      throw new Error("boom");
    };
    await expect(renderCached("frm_fail000000", 1, render)).rejects.toThrow("boom");
    // Nothing cached, so a retry renders again rather than serving a stale/empty entry.
    await expect(renderCached("frm_fail000000", 1, render)).rejects.toThrow("boom");
    expect(calls).toBe(2);
  });
});
