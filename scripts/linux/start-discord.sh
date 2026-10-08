#!/bin/sh
# Starts the PokeVerse Discord bot with the PRODUCTION profile.
# Usage: ./start-discord.sh [start|setup|check-config|check-bridge|invite]
set -eu
here=$(cd "$(dirname "$0")" && pwd)
cd "$here"

node="$here/node/bin/node"
if [ ! -x "$node" ]; then
  node=$(command -v node || true)
fi
if [ -z "$node" ]; then
  echo "Node.js not found (expected $here/node/bin/node)." >&2
  exit 1
fi

if [ ! -f "$here/.env.production" ]; then
  echo "Missing $here/.env.production. Copy .env.production.example and fill it in." >&2
  exit 2
fi

command=${1:-start}
exec "$node" --enable-source-maps "$here/bot/bot.cjs" "$command" --profile production --config-dir "$here"
