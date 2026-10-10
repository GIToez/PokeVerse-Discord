# PokeVerse-Discord

Discord companion bot for the [PokeVerse](https://github.com/GIToez/PokeVerse) game server.

The bot runs as a separate process next to the game server and talks to it over a small,
authenticated, local-only bridge. The game never waits for the bot: if the bot is stopped or
Discord is down, gameplay is not affected.

## Features

| Feature | Where |
| --- | --- |
| Two-way chat between `#game-chat` and the in-game Game-Chat channel (`[Discord] Jim: hi` / `[Game] RedTrainer: hi`) | `#game-chat` |
| Confirmed catch announcements, modes `all`, `rare_only`, `shiny_legendary_only`, `off` | `#pokemon-catches` |
| Shiny and legendary spawn alerts (a shiny legendary is announced once) | `#shiny-spawns`, `#legendary-spawns` |
| GM broadcasts, restart/global save warnings, manual announcements | `#game-announcements` |
| One live status message (online/offline, players, uptime, restarts) | `#server-status` |
| `/trainer`, `/pokemon` (autocomplete and artwork from the game), `/server` | anywhere, `#bot-commands` suggested |
| `/pokeverse setup | status | channel | catches | announce | unlink` for admins | anywhere |
| Automatic creation of the "PokeVerse Integration" category and channels; never deletes anything | on startup (development) or `setup` |
| Private staff log of logins and logouts (character, level, account, IP, approximate location, client, session, reason), posted only while the channel is verified private, deleted after 30 days | `Admin Logs` / `#player-activity` |
| Account linking with a one-time code from `!discord link` in game: `/link`, `/unlink`, `/account`, `/characters`, `/main`, `/sync` (all private) | anywhere |
| **Verified Trainer** role for linked members, **Ace Trainer** while the game account has premium time, server nickname = main character | automatic |

Out of scope for this version: GTS, trading, marketplace, purchases, catching or battling
through Discord.

## Quick start

- **Windows development (local game server)**: download the `PokeVerse-Discord-Dev-Windows`
  artifact, run `configure-discord-dev.bat`, then `start-discord-dev.bat`. Node.js is
  included. See [docs/SETUP.md](docs/SETUP.md).
- **From source**: Node.js 22+, then

  ```bash
  npm ci
  cp .env.development.example .env.development   # fill in the values
  npm run build
  node dist/bot.cjs check-config
  node dist/bot.cjs start
  ```

The game server needs the bridge patches from
[integrations/pokeverse-game](integrations/pokeverse-game/README.md) and a
`config.local.lua` that enables the bridge.

## Documentation

| Document | Content |
| --- | --- |
| [docs/SETUP.md](docs/SETUP.md) | Development setup on Windows and from source |
| [docs/DISCORD_CONFIGURATION.md](docs/DISCORD_CONFIGURATION.md) | Developer Portal, intents, invite, permissions, channels |
| [docs/COMMANDS.md](docs/COMMANDS.md) | Slash commands and CLI commands |
| [docs/GAME_INTEGRATION.md](docs/GAME_INTEGRATION.md) | Repository audit, bridge protocol, game data mapping |
| [docs/ACCOUNT_LINKING.md](docs/ACCOUNT_LINKING.md) | How linking works, roles, nicknames, security and account recovery |
| [docs/PRIVACY.md](docs/PRIVACY.md) | What the activity log records, IP handling, GeoIP, retention and deletion |
| [docs/TESTING.md](docs/TESTING.md) | Test suites and what was tested against real systems |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Production package, systemd, separation from development |

## Development

```bash
npm run check        # typecheck, lint, unit + integration tests, build
npm run package:windows
npm run package:linux
```

Layout:

```
src/
  bot/        discord.js wiring (BotApp), Discord adapters, GameIntegration (no Discord)
  commands/   slash command definitions and the command router
  config/     .env loading and validation (zod)
  events/     messageCreate / interactionCreate handlers
  integrations/pokeverse/  game bridge client (NDJSON over TCP, HMAC auth, reconnect) and typed game API
  services/   chat, catches, spawns, announcements, status, trainer and Pokemon lookups,
              activity log (privacy check, IP masking, GeoIP, retention), account linking
  setup/      channel definitions, channel setup, invite link
  utils/      logger, rate limits, delivery queue, state store
tests/        unit, integration (fake bridge server) and live (real game server) tests
scripts/      build, packaging, Windows and Linux start scripts, live test
integrations/ game-side patch series for the PokeVerse repository
```
