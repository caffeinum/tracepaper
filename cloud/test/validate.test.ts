import { describe, expect, test } from "bun:test";
import { bearerMatches, parsePublish, parseSlug } from "../src/validate.ts";

const frame = {
  id: "frm_0123456789ab",
  name: "Shot",
  html: "<h1>hi</h1>",
  width: 800,
  height: 600,
  x: 0,
  y: 0,
  kind: "html",
  fontSize: null,
};

describe("parseSlug", () => {
  test("accepts a lowercase slug", () => {
    expect(parseSlug("evals-onboarding")).toBe("evals-onboarding");
  });

  test("rejects uppercase and slashes", () => {
    expect(() => parseSlug("Evals")).toThrow(/bad canvas id/);
    expect(() => parseSlug("a/b")).toThrow(/bad canvas id/);
  });
});

describe("parsePublish", () => {
  test("accepts a snapshot", () => {
    const body = parsePublish(JSON.stringify({ name: "Evals", frames: [frame] }));
    expect(body.frames[0]?.id).toBe(frame.id);
  });

  test("rejects an empty html frame", () => {
    expect(() => parsePublish(JSON.stringify({ name: "Evals", frames: [{ ...frame, html: "" }] }))).toThrow(
      /must not be empty/,
    );
  });

  test("rejects a missing kind instead of guessing", () => {
    const { kind: _kind, ...rest } = frame;
    expect(() => parsePublish(JSON.stringify({ name: "Evals", frames: [rest] }))).toThrow(/kind/);
  });

  test("rejects a duplicate id", () => {
    expect(() => parsePublish(JSON.stringify({ name: "Evals", frames: [frame, frame] }))).toThrow(/duplicate/);
  });
});

describe("bearerMatches", () => {
  test("matches only the exact bearer token", () => {
    expect(bearerMatches("Bearer secret", "secret")).toBe(true);
    expect(bearerMatches("Bearer secret!", "secret")).toBe(false);
    expect(bearerMatches("secret", "secret")).toBe(false);
    expect(bearerMatches(null, "secret")).toBe(false);
  });
});
