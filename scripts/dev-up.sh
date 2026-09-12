#!/usr/bin/env bash
#
# Bring the local stack up if it is not already.
#
# The dev container reclaims background processes: Postgres and `next dev` both
# vanish mid-session, and a test run against a dead server fails in ways that
# look exactly like a code regression - a whole suite red, including specs the
# change never touched. Run this before any suite and read the two lines it
# prints before believing a failure.
set -u

pg_isready -q || service postgresql start >/dev/null 2>&1
for _ in $(seq 1 15); do pg_isready -q && break; sleep 1; done

if ! curl -sf -o /dev/null http://localhost:3000/; then
  (cd "$(dirname "$0")/.." && nohup npm run dev > /tmp/velto-dev.log 2>&1 &)
  for _ in $(seq 1 60); do
    curl -sf -o /dev/null http://localhost:3000/ && break
    sleep 1
  done
fi

pg_isready | tail -1
curl -s -o /dev/null -w "app: %{http_code}\n" http://localhost:3000/
