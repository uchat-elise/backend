#!/usr/bin/env sh
set -eu

PORT="${API_PORT:-3000}"

if [ -z "${SUPABASE_URL:-}" ] || [ -z "${SUPABASE_KEY:-}" ]; then
  printf '%s\n' '[startup] Missing SUPABASE_URL or SUPABASE_KEY.' >&2
  exit 1
fi

if ! command -v lsof >/dev/null 2>&1; then
  printf '%s\n' '[startup] lsof is required to clean the API port.' >&2
  exit 1
fi

pids="$(lsof -ti TCP:"$PORT" 2>/dev/null || true)"
if [ -n "$pids" ]; then
  printf '[startup] Stopping processes on port %s: %s\n' "$PORT" "$pids" >&2
  # shellcheck disable=SC2086
  kill -9 $pids 2>/dev/null || true
fi

remaining="$(lsof -ti TCP:"$PORT" 2>/dev/null || true)"
if [ -n "$remaining" ]; then
  printf '[startup] Port %s is still in use by: %s\n' "$PORT" "$remaining" >&2
  exit 1
fi

printf '[startup] Port %s is clean. Starting Uchat backend.\n' "$PORT"
exec npm run start:server
