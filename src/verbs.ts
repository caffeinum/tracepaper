/**
 * The CLI verb names, in their own dependency-free module so `index.ts` can decide how to dispatch
 * WITHOUT importing cli.ts (which pulls in the Store and zod). Keeping this list light matters: the
 * stdio→HTTP bridge path must not load a heavy module graph, and index.ts is its entry.
 */
export const CLI_VERBS = new Set([
  "push",
  "comments",
  "reply",
  "resolve",
  "list",
  "get",
  "tidy",
  "delete",
  "help",
]);
