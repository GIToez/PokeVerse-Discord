# Game-side changes (PokeVerse repository)

The bot needs a small, optional bridge inside the game server. Those changes belong to the
[PokeVerse](https://github.com/GIToez/PokeVerse) repository, on a feature branch with its
own pull request. The bot's automation could not push to that repository (HTTP 403,
no write access), so the exact commits are kept here as a patch series until a maintainer
applies them.

- Base commit: [`BASE_COMMIT`](BASE_COMMIT) (head of `cursor/phase1-foundation-structure-c8d5`,
  [PokeVerse PR #5](https://github.com/GIToez/PokeVerse/pull/5), when the patches were made).
- Suggested branch name: `cursor/discord-bridge-ef3d`.
- Nothing here changes gameplay. The bridge is disabled unless `config.local.lua` enables it.

| Patch | Content |
| --- | --- |
| `0001` | C++ bridge listener (`src/discordbridge.*`), event hooks in `game.cpp` (server state, global save warnings, client broadcasts), optional `config.local.lua` loading, bridge settings in `config.lua` (disabled) |
| `0002` | Lua hooks and read-only request handlers (`056-discordBridge.lua`, `013-json.lua`), chat/catch/spawn/broadcast/shutdown hooks, `discordbridge` globalevent |
| `0003` | Bridge test in the Linux server test (`scripts/discord-bridge-test.py`, test-only `/bridgetest` talkaction, JSON library test) |
| `0004` | Protocol and configuration documentation (`docs/discord-bridge.md`) |

## Applying

```bash
git clone https://github.com/GIToez/PokeVerse.git && cd PokeVerse
git lfs pull
git checkout -b cursor/discord-bridge-ef3d "$(cat /path/to/PokeVerse-Discord/integrations/pokeverse-game/BASE_COMMIT)"
git am --keep-cr /path/to/PokeVerse-Discord/integrations/pokeverse-game/patches/*.patch
git push -u origin cursor/discord-bridge-ef3d     # then open a PR against the phase 1 branch
```

`--keep-cr` is required: several patched files (`config.lua`, `043-fishing.lua`,
`036-headbutt.lua`) use CRLF line endings.

The patches also apply on newer commits of that branch as long as the touched files have not
changed. If `git am` stops, run `git am --show-current-patch=diff` and resolve as usual.

## Verifying

```bash
cmake -S core/server -B build/server -G Ninja -DCMAKE_BUILD_TYPE=Release && cmake --build build/server
scripts/test-server-linux.sh build/server/pokeverse-server      # game-side bridge test
/path/to/PokeVerse-Discord/scripts/live-test.sh . build/server/pokeverse-server   # bot against this server
```

The bot repository's CI runs both steps (job "Live test against the real game server").

## Pre-existing game issues found while testing (not fixed by these patches)

- `datalog_player_items` duplicate primary key error when a character logs out a second time.
  The tests use fresh characters that log in once.
- The SIGTERM/SIGINT handler can hang: it calls `Game::shutdown` inside a dispatcher task,
  which then joins the dispatcher from its own thread. Test scripts send SIGINT and fall back
  to SIGKILL after 30 seconds.
