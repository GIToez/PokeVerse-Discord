#!/usr/bin/env bash
# Live test: the bot against a REAL PokeVerse game server (Linux).
#
# Starts a throwaway MariaDB on 127.0.0.1:3307 and a game server with the Discord bridge
# enabled in a temporary folder, creates fresh test characters, then runs tests/live with
# real game clients (tests/live/game_actor.py). Discord itself is replaced by in-memory
# channels; see docs/TESTING.md for what that does and does not cover.
#
# Usage: scripts/live-test.sh <PokeVerse game repo> <pokeverse-server binary>
# Needs: mariadb server/client, python3, the game built from a branch with the Discord bridge.
set -euo pipefail

bot_root="$(cd "$(dirname "$0")/.." && pwd)"
game_repo="$(realpath "$1")"
binary="$(realpath "$2")"
work="$(mktemp -d)"
db="mariadb --no-defaults --protocol=tcp -h127.0.0.1 -P3307"
server_pid=""
db_pid=""

cleanup() {
  if [ -n "$server_pid" ]; then
    # SIGINT, then SIGKILL: the game's own signal shutdown can hang (pre-existing issue).
    kill -INT "$server_pid" 2>/dev/null || true
    for _ in $(seq 30); do kill -0 "$server_pid" 2>/dev/null || break; sleep 1; done
    kill -9 "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  [ -n "$db_pid" ] && kill "$db_pid" 2>/dev/null && wait "$db_pid" 2>/dev/null || true
  if [ "${KEEP_WORK:-0}" != 1 ]; then rm -rf "$work"; else echo "Work directory kept: $work"; fi
}
trap cleanup EXIT

if $db -uroot -e "SELECT 1" >/dev/null 2>&1; then
  echo "Something is already listening on 127.0.0.1:3307; stop it first." >&2
  exit 1
fi
grep -q "discordBridgeEnabled" "$game_repo/core/server/config.lua" || {
  echo "This game checkout has no Discord bridge (see integrations/pokeverse-game/)." >&2
  exit 1
}

echo "=== MariaDB"
mariadb-install-db --no-defaults --datadir="$work/db" --auth-root-authentication-method=normal >"$work/db-install.log" 2>&1
mariadbd --no-defaults --datadir="$work/db" --port=3307 --bind-address=127.0.0.1 \
  --socket="$work/db.sock" --log-error="$work/db-error.log" --pid-file="$work/db.pid" &
db_pid=$!
for _ in $(seq 60); do $db -uroot -e "SELECT 1" >/dev/null 2>&1 && break; sleep 1; done
$db -uroot < "$game_repo/core/database/00-create-database.sql"
$db -upokeverse -ppokeverse pokeverse < "$game_repo/core/server/schemas/mysql.sql"
for f in "$game_repo/core/server/schemas/pokeverse-extensions.sql" "$game_repo/core/database/20-world-defaults.sql" \
         "$game_repo/core/database/30-account-tools.sql" "$game_repo/core/database/40-dev-seed.sql"; do
  $db -upokeverse -ppokeverse pokeverse < "$f"
done
# Fresh characters that log in once per run.
$db -upokeverse -ppokeverse pokeverse -e "
  CALL pokeverse_create_account('livetrainer', 'secret'); CALL pokeverse_create_character('livetrainer', 'Live Trainer', 0);
  CALL pokeverse_create_account('livestaff', 'secret'); CALL pokeverse_create_character('livestaff', 'Live Staff', 0);
  CALL pokeverse_set_group('Live Staff', 6);"

echo "=== Game server"
mkdir -p "$work/server/logs/server" "$work/server/logs/chat" "$work/server/logs/bots"
cp -r "$game_repo/core/server/data" "$game_repo/core/server/config.lua" "$game_repo/core/server/pt_br.loc" "$work/server/"
cp "$binary" "$work/server/"
secret="live-$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
printf 'discordBridgeEnabled = true\ndiscordBridgeSecret = "%s"\n' "$secret" > "$work/server/config.local.lua"
cp "$game_repo/scripts/testing/discord-bridge-test-talkaction.lua" "$work/server/data/talkactions/scripts/bridgetest.lua"
sed -i 's#</talkactions>#\t<talkaction words="/bridgetest" event="script" value="bridgetest.lua"/>\n</talkactions>#' \
  "$work/server/data/talkactions/talkactions.xml"
(cd "$work/server" && exec "./$(basename "$binary")" >"$work/server.log" 2>&1) &
server_pid=$!
for _ in $(seq 180); do
  grep -q "server Online!" "$work/server.log" 2>/dev/null && break
  kill -0 "$server_pid" 2>/dev/null || { tail -50 "$work/server.log"; echo "FAIL: server exited"; exit 1; }
  sleep 1
done
grep -q "Discord bridge listening on 127.0.0.1:7199" "$work/server.log" || { tail -50 "$work/server.log"; echo "FAIL: bridge not listening"; exit 1; }

echo "=== Live tests"
status=0
(cd "$bot_root" && PV_GAME_REPO="$game_repo" PV_LIVE_BRIDGE_PORT=7199 PV_LIVE_SECRET="$secret" \
  PV_LIVE_ARTWORK="$game_repo/core/client-legacy/data/images/pictures" \
  npx vitest run --config vitest.live.config.ts) || status=$?

echo "=== Bundled CLI against the real bridge"
(cd "$bot_root" && node scripts/build.mjs >/dev/null)
cfg="$work/botcfg"
mkdir -p "$cfg"
printf 'POKEVERSE_PROFILE=development\nDISCORD_TOKEN=not-used-by-check-bridge\nDISCORD_GUILD_ID=100000000000000001\nBRIDGE_SECRET=%s\nLOG_LEVEL=error\n' "$secret" > "$cfg/.env.development"
node "$bot_root/dist/bot.cjs" check-bridge --config-dir "$cfg" || status=1
sed -i 's/^BRIDGE_SECRET=.*/BRIDGE_SECRET=wrong-secret-0123456789/' "$cfg/.env.development"
if node "$bot_root/dist/bot.cjs" check-bridge --config-dir "$cfg" 2>"$work/wrong.txt"; then
  echo "FAIL: wrong secret accepted"; status=1
else
  grep -q "rejected BRIDGE_SECRET" "$work/wrong.txt" && echo "Wrong secret rejected as expected." || { cat "$work/wrong.txt"; status=1; }
fi

echo "=== Server log (bridge lines and errors)"
grep -iE "discord|bridge" "$work/server.log" | tail -20 || true
grep -E "^\[Error|MYSQL ERROR|Lua Script Error" "$work/server.log" | sort | uniq -c | sort -rn | head -20 || true
exit "$status"
