import { describe, expect, test } from "bun:test";
import { publishedCanvasHtml } from "../src/page.ts";

const page = `<!doctype html><html><head></head><body>
    <script type="module" src="/dist/canvas.js"></script>
  </body></html>`;

describe("publishedCanvasHtml", () => {
  test("points the shared canvas at one slug and marks the page read-only", () => {
    const html = publishedCanvasHtml(page, "evals-ui");
    expect(html).toContain('window.__TRACEPAPER_PUBLIC__={"slug":"evals-ui"}');
    expect(html).toContain('document.documentElement.dataset.public="1"');
    expect(html).toContain('src="/dist/canvas.js"');
  });

  test("refuses a page that is not the canvas", () => {
    expect(() => publishedCanvasHtml("<html></html>", "evals-ui")).toThrow(/canvas.js/);
  });
});
