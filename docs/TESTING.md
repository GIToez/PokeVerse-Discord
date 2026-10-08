# Testing

```bash
npm run check          # typecheck, lint, unit + integration tests, build
npm test               # unit + integration only
scripts/live-test.sh <game repo> <game server binary>    # against a real game server (Linux)
```

## Suites

| Suite | Files | Tests | Runs against |
| --- | --- | --- | --- |
| Unit | `tests/unit/*.test.ts` | 89 | Fakes for Discord channels, the guild and the game API |
| Integration | `tests/integration/*.test.ts` | 14 | The real bridge client and `GameIntegration` against a fake bridge server speaking the protocol over real TCP |
| Live | `tests/live/game.live.test.ts` | 11 | **A real PokeVerse game server** (PR #5 + bridge patches), real MariaDB, real game clients |
| Game-side | `scripts/discord-bridge-test.py` (game repo) | - | Real server and clients, protocol-level |

All of them run in CI (`.github/workflows/ci.yml`). The live job checks out the game at
`integrations/pokeverse-game/BASE_COMMIT`, applies the patch series, builds the server,
runs the game's own server test and then `scripts/live-test.sh`.

### Unit and integration coverage

- Config: profiles, validation messages, production confirmation, development refusing the
  production guild and non-loopback bridges, defaults per profile.
- Chat: formats, mention and Markdown neutralization, bots/webhooks/system/other channels
  ignored, attachments, length cut, per-user and global rate limits, game offline, stale
  events, no echo.
- Catches: every mode, rare species, `+N` only when present, shiny/legendary titles,
  duplicates, stale events.
- Spawns: routing (a shiny legendary posts once, to the configured channel), location modes,
  startup and source filters, duplicate IDs and repeated creatures.
- Announcements: GM/staff broadcasts, restart warnings and cancellation, manual posts.
- Status: one message edited in place, recreated when deleted, offline on disconnect,
  restart detection across bot restarts.
- Channel setup: create, adopt by name, keep saved IDs after renames, never delete, read-only
  overwrites only on new channels, missing-permission reports, reassignment, refuses another
  guild's state.
- Commands: lookups, not-found suggestions, offline game, rate limit, admin checks,
  `/pokeverse` subcommands.
- Bridge client: HMAC handshake, wrong secret, requests and timeouts, retrying while the
  game is down, idle connection drop, server restart (new `bootId`, also across bot
  restarts), malformed or unknown events.

### Live test (real game server)

`scripts/live-test.sh` starts a fresh MariaDB, creates the characters "Live Trainer" and
"Live Staff" (GM), enables the bridge with a random secret and starts the game server.
`tests/live/game_actor.py` logs real game clients in. The bot side is the real
`GameIntegration` with fake Discord channels, so every post is checked exactly.

| Live test | Checked |
| --- | --- |
| Status | `server.status` from the running server shown in the status embed |
| `/trainer` | Real character (level, achievement "The First!"); staff character hidden |
| `/pokemon` | Real Bulbasaur data from the game's definitions, artwork file from the client |
| Discord -> game | Game client receives `[Discord] Jim: ...` in Game-Chat |
| Game -> Discord | Player message posted as `[Game] Live Trainer: ...` |
| Failed catch | Real failed throw, nothing posted |
| Confirmed catch | Real catch, posted exactly once |
| Spawns | Real shiny and legendary spawns, routed correctly, boss cooldown |
| GM broadcast | `/b` from a GM, posted exactly once |
| Reconnect | Bridge connection replaced, bot reconnects and keeps working |
| Restart warning | `/shutdown 10` and `/shutdown stop` |

After the suite, the bundled `dist/bot.cjs check-bridge` is run with the right secret
(must succeed) and a wrong one (must fail).

## What was tested against real systems, and what was not

Tested for real:

- The game bridge and all game data (live test above, in CI on every push).
- The Discord API rejecting an invalid token: the bot prints "Discord rejected the bot
  token" and exits 1 (locally and on a clean Windows runner in CI).
- The Windows package on a clean `windows-latest` runner: contents, non-interactive
  `configure-discord-dev.ps1` with a fake game folder (writes `.env.development` and
  `config.local.lua`), `start-discord-dev.bat` error path.
- The Linux package: extraction and `start-discord.sh` refusing to run without
  `POKEVERSE_CONFIRM_PRODUCTION=yes`.
- The packaging secret scanner refusing `.env` files and token/secret values.

**Not tested against a real Discord server** (no bot token or test guild was available to the
automation): channel creation in a real guild, slash command registration and use, real
message delivery, embeds and attachments as rendered by Discord, Discord rate limits.
These paths are covered by unit tests with fakes that follow the discord.js API, but they
need a manual check:

1. Create a development application and guild ([DISCORD_CONFIGURATION.md](DISCORD_CONFIGURATION.md)).
2. Run `configure-discord-dev.bat` and `start-discord-dev.bat` with the local game server.
3. Check: the category and 7 channels appear; the status message appears; `/server`,
   `/trainer`, `/pokemon` (autocomplete and picture) work; chat goes both ways; a catch and
   a GM `/b` appear; restarting the game updates the status; `/pokeverse status` shows no
   missing permissions.

Also not tested: an interactive (non-CI) Windows desktop run, and
`download-discord-dev.ps1` against real Actions artifacts (it needs a GitHub token).
