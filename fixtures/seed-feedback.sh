#!/bin/sh
# seed a Pricing frame and two human comments the way a user would: `tracepaper push`,
# then pin the comments through the canvas's own http api, on a server started just for this.
# usage: seed-feedback.sh <db> <html>
set -eu
db="$1"; html="$2"
tp=./node_modules/.bin/tracepaper
export TRACEPAPER_DB="$db" TRACEPAPER_REPO=evals TRACEPAPER_PORT=0

frame=$("$tp" push "$html" --name Pricing --width 1100 --height 720 --json | sed -n 's/^    "id": "\(.*\)",$/\1/p' | head -n 1)
test -n "$frame" || { echo "seed: push printed no frame id" >&2; exit 1; }

url=$("$tp" up | sed -n 's/^  canvas: *\(http[^ ]*\).*/\1/p')
test -n "$url" || { echo "seed: tracepaper up printed no canvas url" >&2; exit 1; }
trap '"$tp" down >/dev/null' EXIT

pin() {
  curl -fsS -X POST "$url/api/comments" -H 'content-type: application/json' -H 'x-tracepaper: 1' \
    -d "{\"frameId\":\"$frame\",\"x\":$1,\"y\":$2,\"text\":\"$3\"}" >/dev/null
}
pin 200 640 "the trial button is buried at the bottom and grey. put it right under the headline and make it green"
pin 820 300 "drop the enterprise tier, we only sell two plans"
echo "seeded $frame in $db"
