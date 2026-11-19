/** The published page is the local canvas, told which slug to read. One injection, so a UI
 * change in web/ is the public page on the next deploy. */
export function publishedCanvasHtml(indexHtml: string, slug: string): string {
  const marker = '<script type="module" src="/dist/canvas.js"></script>';
  if (!indexHtml.includes(marker)) throw new Error("canvas page is missing /dist/canvas.js");
  const boot = `<script>window.__TRACEPAPER_PUBLIC__=${JSON.stringify({ slug })};document.documentElement.dataset.public="1"</script>`;
  return indexHtml.replace(marker, `${boot}\n    ${marker}`);
}
