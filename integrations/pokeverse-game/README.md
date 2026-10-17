# Game-side changes (PokeVerse repository)

The bot needs a small, optional bridge inside the game server. Those changes belong to the
[PokeVerse](https://github.com/GIToez/PokeVerse) repository, on a feature branch with its
own pull request. The bot's automation cannot push to that repository (HTTP 403, no write
access), so the exact commits are kept here as a patch series until a maintainer applies them.

The Phase 1 bridge and the Phase 2 series (player sessions, account linking) are already on
the game's `main` branch. This series adds the staff groups for the bot's staff roles.

- Base commit: [`BASE_COMMIT`](BASE_COMMIT) (`22f845b`, the game's `main` when the patch was made).
- Suggested branch name: `cursor/discord-staff-groups-ef3d`, with a pull request against `main`.
- Nothing here changes gameplay, the database schema or any setting. It only adds a field to
  the bridge's link results.

| Patch | Content |
| --- | --- |
| `0001` | Lua (`061-discordAccounts.lua`): `groupIds` in `link.redeem`, `link.account` and `link.list`, the distinct groups of the account's characters (`players.group_id`, the live group for online characters). `accounts.group_id` is not used because `pokeverse_set_group` never lowers it. Test: Link Alpha becomes a Tutor in `scripts/test-server-linux.sh`, and `scripts/discord-bridge-test.py` checks `groupIds` after linking and after a character is deleted. Docs: `docs/discord-bridge.md` (link summary). |

## Applying

```bash
git clone https://github.com/GIToez/PokeVerse.git && cd PokeVerse
git lfs pull
git checkout -b cursor/discord-staff-groups-ef3d "$(cat /path/to/PokeVerse-Discord/integrations/pokeverse-game/BASE_COMMIT)"
git am --keep-cr /path/to/PokeVerse-Discord/integrations/pokeverse-game/patches/*.patch
git push -u origin cursor/discord-staff-groups-ef3d     # then open a PR against main
```

On Windows, use Git Bash for the same commands. `--keep-cr` keeps CRLF line endings in files
that use them.

The patch also applies on newer commits of `main` as long as the touched lines have not
changed. If `git am` stops, run `git am --show-current-patch=diff` and resolve as usual.

## Upgrading a server

Build and deploy the server as usual; there is nothing else to do. Rollback: deploy the
previous build.

## Compatibility

The bridge protocol stays at version 1.

- New bot, old game: the link results have no `groupIds`; the bot leaves staff roles alone
  (it neither gives nor removes them). Everything else keeps working.
- Old bot, new game: the old bot ignores the extra field.

## Verifying

```bash
cmake -S core/server -B build/server -G Ninja -DCMAKE_BUILD_TYPE=Release && cmake --build build/server
scripts/test-server-linux.sh build/server/pokeverse-server      # game-side server and bridge test
/path/to/PokeVerse-Discord/scripts/live-test.sh . build/server/pokeverse-server   # bot against this server
```

The bot repository's CI runs both steps (job "Live test against the real game server").

## Pre-existing game issues found while testing (not fixed by these patches)

- Phase 1 found a `datalog_player_items` duplicate primary key error when a character logs out
  a second time, and a SIGTERM/SIGINT handler that can hang (it joins the dispatcher from its
  own thread). The test scripts send SIGINT and fall back to SIGKILL after 30 seconds.
- `[Error - Npc interface]` appears once in the server log at startup.
- On a machine where `c++` is clang without libstdc++, CMake's compiler check fails; build
  with `CC=gcc CXX=g++`.
