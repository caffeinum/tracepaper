#!/bin/sh
# stop every canvas server a run started: `tracepaper up` daemons, `serve &`, bunx/npx launches
for f in "$FIREGOAT_HOME/.tracepaper/tracepaper.pid"; do
  [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null
done
pkill -f "$FIREGOAT_WORKDIR" 2>/dev/null
pkill -f "$FIREGOAT_HOME" 2>/dev/null
exit 0
