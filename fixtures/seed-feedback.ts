import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const [dbPath, htmlPath, repo] = process.argv.slice(2);
if (!dbPath || !htmlPath || !repo) throw new Error("usage: bun seed-feedback.ts <db> <html> <repo>");

const { Store } = await import(resolve("node_modules/tracepaper/src/store.ts"));
const store = new Store(dbPath);
const frame = store.createFrame({
  html: readFileSync(htmlPath, "utf8"),
  name: "Pricing",
  width: 1100,
  height: 720,
  repo,
  createdBy: repo,
});
store.createComment({
  frameId: frame.id,
  x: 200,
  y: 640,
  text: "the trial button is buried at the bottom and grey. put it right under the headline and make it green",
});
store.createComment({
  frameId: frame.id,
  x: 820,
  y: 300,
  text: "drop the enterprise tier, we only sell two plans",
});
store.close();
console.log(`seeded ${frame.id} in ${dbPath}`);
