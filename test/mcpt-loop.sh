#!/usr/bin/env bash
# The push -> comment -> read -> reply -> resolve loop, driven by a client that is NOT our code:
# the `mcpt` CLI (github.com/f/mcp-tools). Run it from anywhere: `bash test/mcpt-loop.sh`.
#
# Topology: mcpt spawns a fresh stdio server per invocation, so the db must be a shared temp
# FILE (never :memory:) and the human's browser side is one long-lived `serve` process on a
# pinned port. Every process points at the same db; that cross-process handoff is the point.
#
# NOTE: `mcpt` exits 0 even when a tool returns isError, so every call is checked explicitly.
set -euo pipefail

if ! command -v mcpt >/dev/null 2>&1; then
  echo "mcpt is not installed — brew install f/mcptools/mcp (see github.com/f/mcp-tools)" >&2
  exit 127
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/paper-mcp-mcpt.XXXXXX")"
export HOME="$WORK/home"          # keeps the real ~/.paper-mcp/server.json untouched
export PAPER_MCP_DB="$WORK/paper.db"
export PAPER_MCP_HOST=127.0.0.1
mkdir -p "$HOME"

SERVE_PID=""
cleanup() {
  if [ -n "$SERVE_PID" ]; then kill "$SERVE_PID" 2>/dev/null || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
step() { echo "--- $*"; }

contains() { case "$2" in *"$1"*) return 0 ;; *) return 1 ;; esac; }
want()  { if ! contains "$1" "$2"; then fail "$3 — expected to find '$1' in:
$2"; fi; }
avoid() { if contains "$1" "$2"; then fail "$3 — did not expect '$1' in:
$2"; fi; }
equal() { if [ "$1" != "$2" ]; then fail "$3 — expected '$2', got '$1'"; fi; }

# Reads one dotted key out of a JSON document on stdin. Used for curl responses.
json() { KEY="$1" bun -e '
  const doc = JSON.parse(await Bun.stdin.text());
  let value = doc;
  for (const key of process.env.KEY.split(".")) value = value?.[key];
  if (value === undefined) { console.error("no such key: " + process.env.KEY); process.exit(1); }
  console.log(typeof value === "object" ? JSON.stringify(value) : String(value));
'; }

# Calls a tool through mcpt and prints its text content, asserting isError matches MODE.
run_tool() {
  local tool="$1" params="$2" raw
  raw="$(PAPER_MCP_PORT=0 mcpt call "$tool" --params "$params" --format json \
      bun run "$ROOT/src/index.ts" 2>"$WORK/mcpt.err")" \
    || { echo "FAIL: mcpt call $tool crashed: $(cat "$WORK/mcpt.err")" >&2; return 1; }
  printf '%s' "$raw" | TOOL="$tool" bun -e '
    const raw = await Bun.stdin.text();
    let result;
    try { result = JSON.parse(raw); }
    catch { console.error(`${process.env.TOOL}: mcpt returned non-JSON: ${raw}`); process.exit(1); }
    const text = (result.content ?? []).map((block) => block.text ?? "").join("\n");
    const failed = result.isError === true;
    const wantFailure = process.env.MODE === "error";
    if (failed !== wantFailure) {
      console.error(wantFailure
        ? `${process.env.TOOL}: expected a tool error, got success: ${text}`
        : `${process.env.TOOL}: tool reported isError: ${text}`);
      process.exit(1);
    }
    if (text.trim() === "") { console.error(`${process.env.TOOL}: empty result`); process.exit(1); }
    console.log(text);
  '
}
mcp()     { MODE=ok    run_tool "$1" "$2"; }
mcp_err() { MODE=error run_tool "$1" "$2"; }

health() { curl -fsS "$BASE/api/health" | json "$1"; }

# ---------- the human's browser side: one long-lived server on a pinned port ----------

PORT="$(bun -e 'const s=Bun.serve({port:0,fetch:()=>new Response("")});console.log(s.port);s.stop(true)')"
PAPER_MCP_PORT="$PORT" bun run "$ROOT/src/index.ts" serve >/dev/null 2>"$WORK/serve.log" &
SERVE_PID=$!
BASE="http://127.0.0.1:$PORT"

for _ in $(seq 1 100); do
  if curl -fsS "$BASE/api/health" >/dev/null 2>&1; then break; fi
  sleep 0.1
done
curl -fsS "$BASE/api/health" >/dev/null || fail "http server never came up (see $WORK/serve.log)"
[ -f "$PAPER_MCP_DB" ] || fail "the shared db file was never created at $PAPER_MCP_DB"

# ---------- the loop ----------

step "tools — all seven are advertised to an outside client"
TOOLS="$(PAPER_MCP_PORT=0 mcpt tools --format json bun run "$ROOT/src/index.ts")"
for tool in push_html get_comments get_frame list_frames resolve_comment reply_to_comment delete_frame; do
  want "\"$tool\"" "$TOOLS" "tool $tool missing from mcpt tools"
done

step "list_frames with no arguments — mcpt omits the \`arguments\` key entirely"
# Not reachable from our own SDK-based e2e: that client always sends `arguments: {}`, so a server
# that rejects an absent key looks fine there and is unusable from here.
NO_ARGS="$(mcp list_frames '{}')"
want "$BASE" "$NO_ARGS" "list_frames is unreachable when the client sends no arguments"

step "push_html — a frame the browser can render"
PUSHED="$(mcp push_html '{"html":"<h1>mcpt drew this</h1>","name":"Mcpt"}')"
FRAME="$(printf '%s' "$PUSHED" | grep -o 'frm_[0-9a-f]\{12\}' | head -1)"
[ -n "$FRAME" ] || fail "no frameId in push_html output: $PUSHED"
want "v1" "$PUSHED" "push_html did not report version 1"
SERVED="$(curl -fsS "$BASE/f/$FRAME")"
want "<h1>mcpt drew this</h1>" "$SERVED" "GET /f/$FRAME did not serve the pushed html"
equal "$(health frames)" "1" "the long-lived server does not see the frame mcpt pushed"

step "get_frame — the current html is readable back before an update replaces it"
GOT="$(mcp get_frame "{\"frameId\":\"$FRAME\"}")"
want "<h1>mcpt drew this</h1>" "$GOT" "get_frame did not return the frame's current html"

step "push_html again with the same frameId — updates in place, no second frame"
UPDATED="$(mcp push_html "{\"frameId\":\"$FRAME\",\"html\":\"<h1>revised</h1>\"}")"
want "v2" "$UPDATED" "push_html did not bump the version"
want "$FRAME" "$UPDATED" "push_html returned a different frame"
want "<h1>revised</h1>" "$(curl -fsS "$BASE/f/$FRAME")" "/f/$FRAME still serves the old html"
equal "$(health frames)" "1" "push_html with a frameId created an extra frame"

step "push_html with a bogus frameId — a loud error, never a silent create"
GHOST="$(mcp_err push_html '{"frameId":"frm_000000000000","html":"<p>ghost</p>"}')"
want "unknown frame: frm_000000000000" "$GHOST" "wrong error message"
equal "$(health frames)" "1" "a bogus frameId created a frame anyway"

step "human comment — posted over HTTP exactly as the browser does"
# The x-paper-mcp header is what the canvas sends; without it the server refuses the write,
# which is what stops a page the human is visiting — or agent-written HTML — posting as them.
POSTED="$(curl -fsS -X POST "$BASE/api/comments" -H 'content-type: application/json' -H 'x-paper-mcp: 1' \
  -d "{\"frameId\":\"$FRAME\",\"x\":412,\"y\":233,\"text\":\"tighten the header\"}")"

step "a write without that header is refused, so hostile frame html cannot speak as the human"
DRIVEBY="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/comments" \
  -H 'content-type: text/plain' \
  -d "{\"frameId\":\"$FRAME\",\"x\":1,\"y\":1,\"text\":\"drive-by\"}")"
equal "$DRIVEBY" "403" "a cross-document simple POST was accepted"
COMMENT="$(printf '%s' "$POSTED" | json id)"
want "cmt_" "$COMMENT" "no commentId in POST /api/comments output: $POSTED"
equal "$(printf '%s' "$POSTED" | json author)" "human" "a canvas comment is not authored by the human"

step "get_comments — the agent reads the human's note back through mcpt"
SEEN="$(mcp get_comments "{\"frameId\":\"$FRAME\"}")"
want "$COMMENT" "$SEEN" "get_comments did not return $COMMENT"
want "tighten the header" "$SEEN" "the comment text did not round-trip through mcpt"
want "(412,233)" "$SEEN" "the pin coordinates did not round-trip"

step 'cursor — polling with `since` returns only what is new'
# The cursor is an opaque feed position handed back in the result text, NOT a comment id: an id
# is re-resolved through that row's live state, so resolving it would skip whatever the human
# wrote in between and lose those comments permanently.
CURSOR="$(printf '%s' "$SEEN" | grep -o 'cur_[0-9]\{1,\}' | head -1)"
[ -n "$CURSOR" ] || fail "get_comments did not hand back a cur_ cursor: $SEEN"
CAUGHT_UP="$(mcp get_comments "{\"frameId\":\"$FRAME\",\"since\":\"$CURSOR\"}")"
want "Nothing new since that cursor" "$CAUGHT_UP" "the cursor returned stale comments"
curl -fsS -X POST "$BASE/api/comments" -H 'content-type: application/json' -H 'x-paper-mcp: 1' \
  -d "{\"frameId\":\"$FRAME\",\"x\":10,\"y\":20,\"text\":\"and fix the footer\"}" >/dev/null
FRESH="$(mcp get_comments "{\"frameId\":\"$FRAME\",\"since\":\"$CURSOR\"}")"
want "and fix the footer" "$FRESH" "the cursor did not surface the new comment"
avoid "tighten the header" "$FRESH" "the cursor re-returned an already-seen comment"

step "the cursor survives the agent resolving what it already read"
# The regression that shipped once: resolving the comment a cursor names dragged the boundary
# past everything written since, and those comments never came back on any later poll.
LATER="$(curl -fsS -X POST "$BASE/api/comments" -H 'content-type: application/json' -H 'x-paper-mcp: 1' \
  -d "{\"frameId\":\"$FRAME\",\"x\":5,\"y\":5,\"text\":\"typed while you worked\"}" | json id)"
mcp resolve_comment "{\"commentId\":\"$COMMENT\"}" >/dev/null
STILL="$(mcp get_comments "{\"frameId\":\"$FRAME\",\"since\":\"$CURSOR\"}")"
want "typed while you worked" "$STILL" "resolving a read comment made newer human notes invisible"
mcp_err get_comments "{\"since\":\"cur_nope\"}" >/dev/null

step "reply_to_comment — the agent talks back inside the thread"
REPLIED="$(mcp reply_to_comment "{\"commentId\":\"$COMMENT\",\"text\":\"tightened it to 1.2\"}")"
want "$COMMENT" "$REPLIED" "the reply did not name its parent"
THREAD="$(mcp get_comments "{\"frameId\":\"$FRAME\"}")"
want "tightened it to 1.2" "$THREAD" "the agent reply is not in the thread"
want "(reply to $COMMENT)" "$THREAD" "the agent reply is not threaded under the human's note"

step "resolve_comment — resolves the root and posts the note as an agent reply"
RESOLVED="$(mcp resolve_comment "{\"commentId\":\"$COMMENT\",\"note\":\"shipped in v2\"}")"
want "$COMMENT" "$RESOLVED" "resolve_comment did not name the comment"
AFTER="$(mcp get_comments "{\"frameId\":\"$FRAME\"}")"
# A returned comment is listed as `- <id> `; a reply only *mentions* its parent as `(reply to <id>)`.
avoid "- $COMMENT " "$AFTER" "the resolved comment is still returned by default"
avoid "tighten the header" "$AFTER" "the resolved comment's text is still returned"
# Resolving closes the whole thread, replies included — otherwise the agent's own note stays
# open forever and every later poll reports it as feedback still waiting on someone.
avoid "shipped in v2" "$AFTER" "the agent's own note is still open after resolving the thread"
WITH_RESOLVED="$(mcp get_comments "{\"frameId\":\"$FRAME\",\"includeResolved\":true}")"
want "- $COMMENT " "$WITH_RESOLVED" "includeResolved does not bring the resolved comment back"
want "shipped in v2" "$WITH_RESOLVED" "resolve_comment's note was never posted as an agent reply"

step "delete_frame — removes the frame and cascades its comments"
DELETED="$(mcp delete_frame "{\"frameId\":\"$FRAME\"}")"
want "$FRAME" "$DELETED" "delete_frame did not name the frame"
equal "$(health frames)" "0" "the frame survived delete_frame"
equal "$(health comments)" "0" "delete_frame did not cascade to its comments"
equal "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/f/$FRAME")" "404" "/f/$FRAME still serves html"
GONE="$(mcp_err get_comments "{\"frameId\":\"$FRAME\"}")"
want "unknown frame: $FRAME" "$GONE" "get_comments on a deleted frame is not an error"

step "the long-lived server is still healthy after all of that"
kill -0 "$SERVE_PID" 2>/dev/null || fail "the serve process died mid-loop (see $WORK/serve.log)"

echo "OK — the loop works through mcpt"
