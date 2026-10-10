# Game-side changes (PokeVerse repository)

The bot needs a small, optional bridge inside the game server. Those changes belong to the
[PokeVerse](https://github.com/GIToez/PokeVerse) repository, on a feature branch with its
own pull request. The bot's automation cannot push to that repository (HTTP 403, no write
access), so the exact commits are kept here as a patch series until a maintainer applies them.

The Phase 1 bridge is already on the game's `main` branch. This series is Phase 2 only.

- Base commit: [`BASE_COMMIT`](BASE_COMMIT) (`49abf2b`, the game's `main` when the patches were made).
- Suggested branch name: `cursor/discord-phase2-ef3d`, with a pull request against `main`.
- Nothing here changes gameplay. Player session events and account linking are only active
  while the bridge is enabled in `config.local.lua` (it is disabled by default); each has its
  own switch (see `docs/discord-bridge.md` in the patches).
- Database: one new table, `discord_account_links`, added to `schemas/pokeverse-extensions.sql`
  with `CREATE TABLE IF NOT EXISTS` (the file's existing convention). No existing table changes.

| Patch | Content |
| --- | --- |
| `0001` | C++: `player_login`/`player_logout` admin events with session ids, client type, IP and the logout reasons the server actually knows (`discordbridgesessions.cpp`, hooks in `game.cpp`, `player.cpp`, `protocolgame.cpp`); one-time link codes (CSPRNG, stored as SHA-256 hashes, 10-minute expiry, rate limits and lockout) in `discordbridge.cpp`; `account_characters` events from the account service (`protocolaccount.cpp`); Lua functions in `luascript.cpp`; new settings in `config.lua` |
| `0002` | Lua: link request handlers (`058-discordAccounts.lua`: redeem, account, characters, main, unlink, list, admin sessions), the `!discord` talkaction (link, status, unlink with confirmation), `kick` reasons from `/kick` and `/masskick`, the `discord_account_links` table |
| `0003` | Tests: `scripts/discord-bridge-test.py --link-test` and `scripts/test-server-linux.sh` (sessions, reconnects, logout reasons, linking errors, expiry, lockout, main fallback after a character delete, in-game unlink) |
| `0004` | Documentation: `docs/discord-bridge.md` (new events, requests, error codes, authorization, account linking, compatibility) |

## Applying

```bash
git clone https://github.com/GIToez/PokeVerse.git && cd PokeVerse
git lfs pull
git checkout -b cursor/discord-phase2-ef3d "$(cat /path/to/PokeVerse-Discord/integrations/pokeverse-game/BASE_COMMIT)"
git am --keep-cr /path/to/PokeVerse-Discord/integrations/pokeverse-game/patches/*.patch
git push -u origin cursor/discord-phase2-ef3d     # then open a PR against main
```

On Windows, use Git Bash for the same commands. `--keep-cr` is required: several patched
files (`player.cpp`, `luascript.cpp`, `luascript.h`, `config.lua`) use CRLF line endings.

The patches also apply on newer commits of `main` as long as the touched lines have not
changed. If `git am` stops, run `git am --show-current-patch=diff` and resolve as usual.

## Upgrading a server

1. The table is created by the normal schema step: `pokeverse-ctl` (live server) and
   `Setup Database.bat` (Windows package) already run `10-pokeverse-extensions.sql` on every
   install/upgrade. By hand: `mysql -u <user> -p <database> < core/server/schemas/pokeverse-extensions.sql`
   (safe to run again; it only creates what is missing).
2. Build and deploy the server as usual.
3. Optional settings in `config.local.lua` (defaults shown):

   ```lua
   discordBridgePlayerSessions = true   -- login/logout events for #player-activity
   discordBridgeSessionIps = true       -- include the player's IP (only shown in the private channel)
   discordBridgeAccountLinking = true   -- !discord link and the /link commands
   discordBridgeLinkCodeLifetime = 600  -- seconds
   ```

Rollback: deploy the previous build. The table can stay (nothing else reads it) or be dropped
with `DROP TABLE discord_account_links;`, which removes every link.

## Compatibility

The bridge protocol stays at version 1. The game announces new capabilities in the `welcome`
message (`features: ["playerSessions", "accountLinking"]`):

- New bot, old game: the bot sees no features, makes no linking or session requests and says
  "Account linking is not available on the game server yet". Everything from Phase 1 keeps working.
- Old bot, new game: the old bot ignores the unknown events and never sends the new requests.

## Verifying

```bash
cmake -S core/server -B build/server -G Ninja -DCMAKE_BUILD_TYPE=Release && cmake --build build/server
scripts/test-server-linux.sh build/server/pokeverse-server      # game-side bridge test (73 checks)
/path/to/PokeVerse-Discord/scripts/live-test.sh . build/server/pokeverse-server   # bot against this server
```

The bot repository's CI runs both steps (job "Live test against the real game server").

## Pre-existing game issues found while testing (not fixed by these patches)

- Phase 1 found a `datalog_player_items` duplicate primary key error when a character logs out
  a second time, and a SIGTERM/SIGINT handler that can hang (it joins the dispatcher from its
  own thread). The test scripts send SIGINT and fall back to SIGKILL after 30 seconds.
- `[Error - Npc interface]` appears once in the server log at startup.
