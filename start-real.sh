#!/bin/bash
# FamilyCFO one-click launcher: starts the app on your real data and opens it in the browser.
# Everything else (household members, bank logins, downloading data) is done in the app itself.
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# Stop any running FamilyCFO server (demo or a previous run).
for port in 5180 4310; do
  pids=$(lsof -ti tcp:$port 2>/dev/null)
  [ -n "$pids" ] && kill $pids 2>/dev/null
done
sleep 1

echo "=== FamilyCFO is starting. Keep this window open; close it to stop FamilyCFO. ==="
( for i in $(seq 1 60); do
    curl -s -o /dev/null http://127.0.0.1:5180 && { open http://127.0.0.1:5180; break; }
    sleep 1
  done ) &
npm run dev
