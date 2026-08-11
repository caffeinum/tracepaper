# v2 — channels

**Question: does MCP have channels?** No feature by that name. But as of spec revision
`2026-07-28` the protocol grew the pieces that add up to one, and the shape of the answer
changed enough that the obvious approach (long-poll) is now the *worst* of the options
rather than the best.

## What the protocol actually offers

### `subscriptions/listen` — the long-lived server→client stream

A real push channel, and now the standard one. The client opens it with a notification
filter; the server pushes until the client cancels. It **replaces** `resources/subscribe`
and the HTTP GET endpoint.

```
-> subscriptions/listen { notifications: { resourceSubscriptions: ["paper://frames/frm_abc/comments"] } }
<- notifications/subscriptions/acknowledged   (first message, carries subscriptionId)
<- notifications/resources/updated { uri: "paper://frames/frm_abc/comments" }
```

Constraint worth designing around: the filter is a closed set
(`toolsListChanged`, `promptsListChanged`, `resourcesListChanged`, `resourceSubscriptions`).
You cannot push an arbitrary payload — you push *"resource X changed"* and the client
refetches. So paper-mcp exposes comments as a resource per frame, and a human comment
becomes an `updated` notification the agent's client resolves by reading it.

On stdio, subscriptions do not survive a reconnect: the client **MUST** re-send
`subscriptions/listen`. The server holds no state across reconnections.

### Tasks extension — the durable bidirectional session

This is the closest thing to what "channel" means here, and it is what the extension was
designed for. `push_html` returns a `CreateTaskResult` with a durable `taskId` instead of
blocking. The task sits in `working` while the human looks at the canvas. When a comment
lands, the task moves to `input_required` with the comment in `inputRequests`; the agent
answers via `tasks/update`; the task goes back to `working`. Repeat until the agent
closes it.

That is a genuine back-and-forth session over a durable handle — it survives client
restarts, and `notifications/tasks` (delivered over `subscriptions/listen`) removes the
polling. Status lifecycle: `working` / `input_required` / `completed` / `failed` /
`cancelled`.

### MRTR (`InputRequiredResult`) — one-shot mid-call input

The server answers a `tools/call` with `resultType: "input_required"`, carrying
`inputRequests` and an opaque `requestState`; the client gathers the input and **retries
the original call** with `inputResponses` + the echoed `requestState`. Note it terminates
the first request — it is a retry loop, not a held connection, and it is deliberately
stateless server-side.

Good for "block until the human approves this frame." Wrong for "stay open while we work
together." Also: `requestState` is attacker-controlled input and must be integrity-
protected (HMAC/AEAD) with a TTL and a principal binding if it influences anything.

### Long-poll — the fallback, not the plan

The Tasks spec argues against it directly: blocking ties up a connection, and client and
intermediary timeouts make it impractical beyond a few seconds. Keep `await_comments`
with a short timeout as a compatibility path for clients that support neither extension,
and stop treating it as the primary design.

## Correction to the earlier version of this file

An earlier draft recommended **sampling** as the way for the server to push a comment
into the agent's loop. That was wrong on two counts:

1. **Sampling is deprecated** as of `2026-07-28` (SEP-2577), alongside Roots and Logging.
   Migration path is "integrate directly with LLM provider APIs." Do not build on it.
2. **Unsolicited server-initiated requests no longer exist.** MRTR replaced them, and the
   spec calls this out as a breaking change: servers **MUST** deliver `sampling/createMessage`,
   `elicitation/create` and `roots/list` inside an `InputRequiredResult`, in response to a
   client request. A server cannot spontaneously poke an idle client at all — which is
   exactly why Tasks + `subscriptions/listen` are the answer instead.

(The Logging deprecation — "log to stderr for stdio transports" — happens to be the rule
v1 already follows.)

## Build order

1. **Tasks.** `push_html` optionally returns a task; comments drive `input_required`.
   Gate on the client declaring `io.modelcontextprotocol/tasks` — never return a task to a
   client that did not opt in.
2. **Resources + `subscriptions/listen`.** `paper://frames/{id}/comments`, notification on
   change. Cheap once the event bus exists; removes polling for clients that support it.
3. **`await_comments` long-poll.** Compatibility floor for everything else.

## SDK reality check

Installed: `@modelcontextprotocol/sdk` **1.30.0**. Its `LATEST_PROTOCOL_VERSION` is
`2025-11-25`, so it does not negotiate `2026-07-28` yet — but it already ships
`subscriptions/listen` and `tasks/*` support, including an
`examples/server/simpleTaskInteractive.js` that is close to the exact interaction we want.
So v2 is buildable today; v1's plain tools are unaffected by the revision either way.

Re-check the SDK's `LATEST_PROTOCOL_VERSION` before starting v2 — if it has moved to
`2026-07-28`, MRTR is live and server-initiated requests are gone for real.

## Open questions

- Does the human need a deliberate "send to agent" button, or is every comment an implicit
  ping? A button is honest about the fact that some comments are notes-to-self.
- Multiple agents on one canvas: does a comment go to whoever pushed the frame, or to
  everyone listening? Frame ownership probably has to become a real field.
- Backpressure: eight comments in ten seconds should wake the agent once with eight, not
  eight times. Debounce on the bus.
- A task held open across a long human review has a TTL. What happens when it lapses
  mid-session — silently re-arm, or surface it?
