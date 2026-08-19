# tracepaper — spec

An MCP server that gives an AI agent a **canvas**. The agent pushes HTML frames onto
it; a human scrolls the canvas in a browser and leaves comments on the frames; the
agent reads those comments back through MCP. That round trip — *draw → comment →
read feedback* — is the whole product. Nothing from the commercial design-canvas tools beyond that is in scope.

## Stack

- **Bun** + **TypeScript** (`strict: true`), `zod` for every boundary schema.
- `@modelcontextprotocol/sdk` for the MCP server (stdio transport).
- `Bun.serve` for the canvas web app + REST + SSE.
- `bun:sqlite` for persistence.
- No frontend framework. Plain TS compiled with `bun build` into `web/dist`.

## Processes

One process. `bun run src/index.ts` starts:

1. the HTTP server (canvas UI + API), and
2. the MCP stdio server on the same process.

`bun run src/index.ts serve` starts **only** the HTTP server (for tests / for a
human who wants the canvas open without an agent attached).

If a live server already owns this db, a starting stdio process joins it instead of
binding a second port — otherwise `push_html` would hand back the URL of a second,
empty-looking canvas over the same data.

stdout is owned by the MCP stdio transport. **Nothing** may `console.log` to
stdout — all logging goes to stderr.

## Configuration

| env | default | meaning |
| --- | --- | --- |
| `TRACEPAPER_PORT` | `4321` | HTTP port. If busy, pick the next free port and report the real one. |
| `TRACEPAPER_DB` | `~/.tracepaper/tracepaper.db` | SQLite file. `:memory:` supported for tests. |
| `TRACEPAPER_HOST` | `127.0.0.1` | bind address |

The resolved base URL is written to `~/.tracepaper/server.json` so tooling can find it.
The pre-rename `PAPER_MCP_*` names are still read as a fallback, and if
`~/.tracepaper/tracepaper.db` does not exist but `~/.paper-mcp/paper.db` does, the older
file is adopted — a rename must not make an existing canvas look emptied.

## Data model

```ts
Frame {
  id: string          // "frm_" + 12 hex
  name: string        // human label above the frame on canvas
  html: string        // full document or fragment; served verbatim
  width: number       // css px, default 1280
  height: number      // css px, default 900
  x: number           // canvas position, auto-assigned on create
  y: number
  version: number     // bumped on every html update
  createdAt: string   // ISO
  updatedAt: string   // ISO
}

Comment {
  id: string          // "cmt_" + 12 hex
  // seq / updatedSeq / deletedAt are internal: one monotonic counter drives both
  // creation and mutation order so a cursor rides updatedSeq, and deletes are soft so
  // a cursor outlives the comment it names.
  frameId: string
  x: number           // px in frame-local coordinates (0..width)
  y: number           // px in frame-local coordinates (0..height)
  text: string
  author: string      // "human" for canvas comments, "agent" for MCP replies
  parentId: string | null   // reply threading; root comments have null
  resolved: boolean
  frameVersion: number      // frame version the comment was left on
  createdAt: string
}
```

Deleting a frame cascades to its comments. Threads are exactly one level deep: a reply
to a reply joins its thread rather than nesting, because the canvas renders roots as
pins and only their direct replies inside — a grandchild would render nowhere at all.
Resolving a thread resolves its replies, so the agent's own note does not come back on
the next poll as unanswered feedback.

## MCP tools

Names are flat and verb-first so they read well in a tool list.

### `push_html`
The one tool the agent draws with.

```
{ html: string, name?: string, frameId?: string,
  width?: number = 1280, height?: number = 900 }
```
- No `frameId` → creates a new frame. Auto-placement fills a row and wraps to the next
  once the row passes ~4400 world px, so a canvas does not become one endless strip.
  `x`/`y` override it for deliberate grouping.
- With `frameId` → replaces that frame's html in place, bumps `version`. Comments
  survive (they are anchored to the frame, not the DOM).
- Unknown `frameId` → **error**, not a silent create.

Returns `{ frameId, name, version, url, canvasUrl }` plus a human-readable line
telling the agent to ask the user to look at `canvasUrl`.

### `get_comments`
The one tool the agent listens with.

```
{ frameId?: string, since?: string, includeResolved?: boolean = false,
  author?: "human" | "agent" }
```
- `since` is an ISO timestamp **or** a comment id — everything strictly after it.
- Default excludes resolved comments and returns newest-last.

Returns `{ comments, cursor, frames }`. `cursor` is an **opaque feed position**
(`cur_<n>`), not a comment id — an id gets re-resolved through that row's live state,
so resolving or editing the comment a cursor names would drag the boundary past
everything written in between and lose it permanently. An empty page echoes the
incoming cursor back rather than returning null, which would reset the caller to the
start of the feed. `frames` carries each touched frame's name, size and current
version so a coordinate is usable and staleness is visible without a second call.

An ISO timestamp is also accepted, but it compares `createdAt` only: a comment the
human later edited or re-opened never comes back through it. Prefer the cursor.

### `list_frames`
`{}` → `{ frames: Array<Frame minus html, plus commentCount, unresolvedCount> , canvasUrl }`

### `resolve_comment`
`{ commentId: string, note?: string }` — marks resolved; if `note` is given, also
posts it as an agent reply so the human sees what was done.

### `reply_to_comment`
`{ commentId: string, text: string }` — agent posts a threaded reply, author
`"agent"`. This is how the agent talks back inside the canvas.

### `get_frame`
`{ frameId: string }` → the frame's current html, name, size and version. `push_html`
replaces a frame's whole document, so an agent that did not author the current html
this session must read it back first or it silently discards the design.

### `delete_frame`
`{ frameId: string }` — removes a frame and its comments.

## HTTP API

| method | path | purpose |
| --- | --- | --- |
| GET | `/` | canvas app |
| GET | `/api/frames` | frame list (no html) |
| GET | `/api/frames/:id` | frame incl. html |
| POST | `/api/frames` | create/update (same shape as `push_html`) |
| PATCH | `/api/frames/:id` | `{x, y}` — move a frame; the one edit the canvas itself makes |
| DELETE | `/api/frames/:id` | delete |
| GET | `/f/:id` | frame html, served as `text/html` for the iframe `src`, with the escape bridge appended |
| GET | `/api/comments?frameId=&since=&includeResolved=` | list |
| POST | `/api/comments` | `{frameId,x,y,text,parentId?}` — strict; `author` is **not** accepted |
| PATCH | `/api/comments/:id` | `{resolved?, text?}` |
| DELETE | `/api/comments/:id` | delete |
| GET | `/api/events` | SSE: `frame.created` `frame.updated` `frame.deleted` `comment.created` `comment.updated` `comment.deleted` |
| GET | `/api/health` | `{ok:true, frames, comments}` |

All responses JSON, all errors `{error: string}` with a real status code. Bad input
fails loudly with the zod message — never a coerced default.

**Writes require an `x-tracepaper` header.** A JSON body sent as `text/plain` is a
CORS-*simple* request, so without this any page the human visits — and, worse, the
sandboxed frame itself, whose html an agent wrote from possibly-hostile input — could
POST comments. Since `author` decides whether a comment reads as the human, that was a
path for pushed html to issue instructions to the agent in the human's name. A custom
header cannot be set by a simple request, and the browser route cannot claim authorship
at all: the server stamps `"human"` itself.

`html` is capped at 5MB and comment text at 16KB. Every write runs in one
`BEGIN IMMEDIATE` transaction — deferred transactions deadlock two processes on one db,
and a tick allocated outside the insert lets a reader take a cursor past a row that has
not committed yet.

## Frame isolation

Frames render in `<iframe src="/f/:id" sandbox="allow-scripts allow-forms allow-popups">`
— no `allow-same-origin`, so pushed HTML cannot touch the canvas app or its storage.
Comment clicks are captured by a transparent overlay above each iframe, so pointer
events never need to reach into the frame.

One small script is appended to every served frame — the **escape bridge**. Because the frame is
a cross-origin sandbox, once focus is inside it every keystroke belongs to that document and the
canvas never sees `esc`. postMessage is the one channel a sandboxed frame still has to its
parent, so the frame reports the keypress and the canvas leaves interactive mode. The canvas
establishes identity by matching `event.source` against a frame iframe it created — the frame's
`event.origin` is the useless string `"null"`.

`/f/:id` also sends `Content-Security-Policy: sandbox …` and `X-Content-Type-Options:
nosniff`. The iframe attribute only binds when the canvas frames the document; opened
directly as a tab it would otherwise be an ordinary same-origin page able to read every
frame over `/api` and write the origin's storage. The CSP travels with the response, so
the sandbox holds however the document is loaded.

## Canvas UI

Figma-ish, deliberately small:

- **Infinite canvas.** Trackpad two-finger scroll pans; `⌘`/`ctrl` + scroll zooms
  around the cursor; space-drag or middle-drag pans; `⌘0` resets, `⌘1` zooms to fit.
- **Frames** are cards with a title label above them, laid out left→right.
- **Comment mode** (`c`, or the toolbar pin button): the next click on a frame drops
  a numbered pin at that frame-local coordinate and opens a composer. `esc` cancels.
- **Pins** scale inversely with zoom so they stay legible. Click a pin to open its
  thread; reply, resolve, or delete from there.
- **Chrome floats** over a full-bleed canvas; nothing holds a permanent column. `t`
  opens the comment list on the right — closed by default, with a toolbar badge for
  open threads. Clicking an entry pans the canvas to that pin.
- **Live.** SSE carries every mutation: an agent `push_html` reloads that one iframe in
  place without losing pan/zoom; a new agent reply appears in an open thread. A slow
  reconcile backs it up, because the bus is per-process while the db is shared — an
  agent attached to a *different* process writes to a bus this canvas is not on. The
  canvas also refetches on `visibilitychange`, since a backgrounded tab skips the timer.
- **Empty state** tells the human the server is up and waiting for the agent.
- **`#frame=<id>`** in the URL opens the canvas zoomed to that frame, and the hash follows the
  selection so the address bar is always a shareable deep link. It is a view hint only: no route
  is scoped by it, and every frame remains reachable.

## Testing

Non-negotiable: the MCP surface is tested **through a real MCP client**, not by
calling the handler functions directly.

1. `bun test` — unit tests on the store (ids, cascades, cursor durability under
   resolve/edit/reopen/delete, transactional writes, size caps) and integration tests
   that boot the HTTP server on an ephemeral port against `:memory:` and exercise every
   route, including the write guard and the refusal to forge `author`.
2. `test/mcp-e2e.test.ts` — spawns `bun src/index.ts` as a child process, speaks
   MCP over stdio with the SDK client, and runs the real loop:
   `push_html` → POST a comment as a human via HTTP → `get_comments` sees it →
   `reply_to_comment` → `resolve_comment` → `get_comments` no longer returns it.
3. `test/mcpt-loop.sh` — the same loop driven from outside by the `mcpt` CLI
   (`f/mcptools`), proving the server works for a client that is not our own code.
   This is not redundant with (2): `mcpt` omits the JSON-RPC `arguments` key entirely
   when a tool takes none, which made every no-argument tool unreachable — invisible to
   an SDK client, which always sends `arguments: {}`. See `src/compat.ts`.

The loop must be runnable repeatedly with no manual cleanup: every test uses a
temp db and an ephemeral port.

## Non-goals

Auth, multi-user presence, design tokens, component sync, code export, persistence
beyond one machine, and everything else a full design tool does.
