#!/bin/bash
set -euo pipefail

FONT_PATH="$1"
OUT_PATH="$2"
FONT_FAMILY="$3"
BUILDER="$(dirname "$0")/build-ttyd-index.mjs"

ttyd -p 7681 -i 127.0.0.1 echo >/dev/null 2>&1 &
TTYD_PID=$!
trap 'kill "$TTYD_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 50); do
  if curl -fsS http://127.0.0.1:7681/ -o /tmp/ttyd-index.html; then
    break
  fi
  sleep 0.2
done

test -s /tmp/ttyd-index.html
node "$BUILDER" /tmp/ttyd-index.html "$FONT_PATH" "$OUT_PATH" "$FONT_FAMILY"
