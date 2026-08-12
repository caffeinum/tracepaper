# tracepaper — spec

An MCP server that gives an AI agent a **canvas**. The agent pushes HTML frames onto
it; a human scrolls the canvas in a browser and leaves comments on the frames; the
agent reads those comments back through MCP. That round trip — *draw → comment →
read feedback* — is the whole product. Nothing else from paper.design is in scope.

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

stdout is owned by the MCP stdio transport. **Nothing** may `console.log` to
stdout — all logging goes to stderr.

## Configuration

| env | default | meaning |
| --- | --- | --- |
| `TRACEPAPER_PORT` | `4321` | HTTP port. If busy, pick the next free port and report the real one. |
| `TRACEPAPER_DB` | `~/.tracepaper/tracepaper.db` | SQLite file. `:memory:` supported for tests. |
| `TRACEPAPER_HOST` | `127.0.0.1` | bind address |

The resolved base URL is written to `~/.tracepaper/server.json` so tooling can find it.

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

Deleting a frame cascades to its comments.

## MCP tools

Names are flat and verb-first so they read well in a tool list.

### `push_html`
The one tool the agent draws with.

```
{ html: string, name?: string, frameId?: string,
  width?: number = 1280, height?: number = 900 }
```
- No `frameId` → creates a new frame, auto-positioned to the right of the last one.
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

Returns `{ comments: Comment[], cursor: string | null }` where `cursor` is the
newest returned comment's id, to pass back as `since` next poll.

### `list_frames`
`{}` → `{ frames: Array<Frame minus html, plus commentCount, unresolvedCount> , canvasUrl }`

### `resolve_comment`
`{ commentId: string, note?: string }` — marks resolved; if `note` is given, also
posts it as an agent reply so the human sees what was done.

### `reply_to_comment`
`{ commentId: string, text: string }` — agent posts a threaded reply, author
`"agent"`. This is how the agent talks back inside the canvas.

### `delete_frame`
`{ frameId: string }` — removes a frame and its comments.

## HTTP API

| method | path | purpose |
| --- | --- | --- |
| GET | `/` | canvas app |
| GET | `/api/frames` | frame list (no html) |
| GET | `/api/frames/:id` | frame incl. html |
| POST | `/api/frames` | create/update (same shape as `push_html`) |
| DELETE | `/api/frames/:id` | delete |
| GET | `/f/:id` | raw frame html, served as `text/html` for the iframe `src` |
| GET | `/api/comments?frameId=&since=&includeResolved=` | list |
| POST | `/api/comments` | `{frameId,x,y,text,parentId?,author?}` |
| PATCH | `/api/comments/:id` | `{resolved?, text?}` |
| DELETE | `/api/comments/:id` | delete |
| GET | `/api/events` | SSE: `frame.created` `frame.updated` `frame.deleted` `comment.created` `comment.updated` `comment.deleted` |
| GET | `/api/health` | `{ok:true, frames, comments}` |

All responses JSON, all errors `{error: string}` with a real status code. Bad input
fails loudly with the zod message — never a coerced default.

## Frame isolation

Frames render in `<iframe src="/f/:id" sandbox="allow-scripts allow-forms allow-popups">`
— no `allow-same-origin`, so pushed HTML cannot touch the canvas app or its storage.
Comment clicks are captured by a transparent overlay above each iframe, so pointer
events never need to reach into the frame.

## Canvas UI

Figma-ish, deliberately small:

- **Infinite canvas.** Trackpad two-finger scroll pans; `⌘`/`ctrl` + scroll zooms
  around the cursor; space-drag or middle-drag pans; `⌘0` resets, `⌘1` zooms to fit.
- **Frames** are cards with a title label above them, laid out left→right.
- **Comment mode** (`c`, or the toolbar pin button): the next click on a frame drops
  a numbered pin at that frame-local coordinate and opens a composer. `esc` cancels.
- **Pins** scale inversely with zoom so they stay legible. Click a pin to open its
  thread; reply, resolve, or delete from there.
- **Sidebar** lists every comment grouped by frame, with unresolved first. Clicking
  an entry pans the canvas to that pin.
- **Live.** SSE drives everything: an agent `push_html` reloads that one iframe in
  place without losing pan/zoom; a new agent reply appears in an open thread.
- **Empty state** tells the human the server is up and waiting for the agent.

## Testing

Non-negotiable: the MCP surface is tested **through a real MCP client**, not by
calling the handler functions directly.

1. `bun test` — unit tests on the store (ids, cascades, `since` cursor semantics,
   version bumps) and integration tests that boot the HTTP server on an ephemeral
   port against `:memory:` and exercise every route.
2. `test/mcp-e2e.test.ts` — spawns `bun src/index.ts` as a child process, speaks
   MCP over stdio with the SDK client, and runs the real loop:
   `push_html` → POST a comment as a human via HTTP → `get_comments` sees it →
   `reply_to_comment` → `resolve_comment` → `get_comments` no longer returns it.
3. `test/mcpt-loop.sh` — the same loop driven from outside by the `mcpt` CLI
   (`f/mcp-tools`), proving the server works for a client that is not our own code.

The loop must be runnable repeatedly with no manual cleanup: every test uses a
temp db and an ephemeral port.

## Non-goals

Auth, multi-user presence, design tokens, component sync, code export, persistence
beyond one machine, anything else paper.design does.
