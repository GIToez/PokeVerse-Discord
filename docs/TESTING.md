# Testing

```bash
npm run check          # typecheck, lint, unit + integration tests, build
npm test               # unit + integration only
scripts/live-test.sh <game repo> <game server binary>    # against a real game server (Linux)
```

## Suites

| Suite | Files | Tests | Runs against |
| --- | --- | --- | --- |
| Unit | `tests/unit/*.test.ts` | 152 | Fakes for Discord channels, the guild (roles, members, overwrites) and the game API |
| Integration | `tests/integration/*.test.ts` | 22 | The real bridge client and `GameIntegration` against a fake bridge server speaking the protocol over real TCP |
| Live | `tests/live/game.live.test.ts` | 16 | **A real PokeVerse game server** (`main` + Phase 2 patches), real MariaDB, real game clients |
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
  restarts), malformed or unknown events, the welcome `features` list (missing = none).
- Activity log (`tests/unit/activity.test.ts`): IP masking modes, private/loopback/CGNAT
  ranges, GeoIP lookups in a real MaxMind-format database written by
  `tests/helpers/mmdb.ts` (no network), geo disabled, privacy check (nothing posted when
  `#player-activity` is visible to `@everyone` or an unlisted role), duplicate logins and
  logouts, logout reason only when sent, reconciliation after a game restart and after
  missed logouts, a bot disconnect not ending sessions, retention deleting records and
  messages, store size limit, no IP or account id in the session file, link and unlink posts
  (each source, roles, sync problems, privacy check, retention across a bot restart).
- Account linking (`tests/unit/linking.test.ts`, `commands.test.ts`): `/link` code
  normalization and every game error code, `/unlink` buttons (confirm, cancel, other user,
  expiry), `/account` and `/characters` ephemeral, `/main` autocomplete and ownership,
  `/sync`, admin `/pokeverse unlink`, Verified Trainer and Ace Trainer added and removed
  while other roles stay, role hierarchy and missing permission reports, nickname set from
  the main and never for the server owner, resync paging, a failed Discord call keeping the
  link, rejoin and `account_link` / `account_characters` events.
- Channel setup: the private Admin Logs category and `#player-activity` overwrites, roles
  created once, never re-permissioning an adopted channel.

### Live test (real game server)

`scripts/live-test.sh` starts a fresh MariaDB, creates the characters "Live Trainer" and
"Live Staff" (GM), plus the account `livelink` with "Live Linker" (first character),
"Live Second" and 5 premium days, enables the bridge with a random secret and starts the
game server.
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
| Player activity | Real logins in the private channel: character, level, account reference, IP (loopback, "No location"), client "OTClient (Windows), protocol 312", session id, online count |
| Link | Code from a real `!discord link`, redeemed with `/link`; Verified Trainer and Ace Trainer added, nickname set to "Live Linker" |
| Link post | "Account linked" in `#player-activity` with the real main character, 2 characters, "Yes (5 days left)" and both roles given |
| `/account`, `/characters`, `/main` | Real account data ("Yes (5 days left)" premium), switching the main to "Live Second" renames the member |
| Logout | Real logout posted with reason "Logged out" |
| In-game unlink | `!discord unlink confirm` removes both roles and the nickname; "Account unlinked" posted with how and the roles removed |
| Reconnect | Bridge connection replaced, bot reconnects and keeps working, no false "Session ended" |
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

Tested in a real Discord development server (bot without Administrator, Message Content
not yet enabled): `setup` logged in, registered the 4 slash commands, created the category
and all 7 channels with topics, `@everyone` Send Messages denied on the 5 read-only channels
and a member allow for the bot; a second `setup` run created nothing.

Then the bot (`start`, Message Content enabled) ran against a real game server started by a
copy of `scripts/live-test.sh`, with real game clients, and every post was read back
through the Discord API:

- `#server-status`: one message, Offline before the game started, then Online with
  "2 / 100" players and uptime.
- `#pokemon-catches`: a real catch (`Rattata caught!`, trainer, level, sex, Ultra ball,
  artwork attachment).
- `#shiny-spawns` / `#legendary-spawns`: Shiny Rattata and Mewtwo, each in its own channel,
  "near Pewter", artwork attached.
- `#game-announcements`: a GM `/b` broadcast, once.
- `#game-chat`: `[Game] Live Staff: ... @everyone` with the mention defused
  (`mention_everyone: false`) and link previews suppressed. A level 5 character could not
  write in Game-Chat at all: the game requires level 10 for that channel, so nothing reaches
  the bridge.

With a human Discord user in the same session:

- Discord -> game chat: a message in `#game-chat` was relayed by the bot and received by a
  real game client in Game-Chat as `[Discord] <server display name>: ...`.
- `/server`, `/trainer` and `/pokemon` were used by the server owner and worked.

### Phase 2 in the real Discord development server

The real bot process ran against a real game server (Phase 2 patches) in the development
guild. Checked through the Discord API:

- `setup` created the Admin Logs category and `#player-activity` with `@everyone` denied
  View Channel and an allow for the bot only, created the Verified Trainer and Ace Trainer
  roles, and registered all 10 slash commands.
- Real logins and logouts of game clients were posted in `#player-activity`, with the
  reasons "Logged out" and "Connection lost".
- A link stored in the game database for the server owner was picked up by the startup
  resync: the owner got Verified Trainer and Ace Trainer. The nickname was reported as not
  manageable, which is correct (Discord does not let bots rename the server owner).
- `!discord unlink confirm` in game removed both roles through the `account_link` event.
- The first run found two bugs that fakes had hidden, both fixed with tests: a bot role with
  Administrator was reported as missing Manage Roles, and a stale member cache made an
  in-game unlink do nothing.

Not checked in real Discord: `/link`, `/unlink` buttons, `/account`, `/characters`, `/main`
and `/sync` typed by a real user (they need someone to click; the live test runs them
against real game data with in-memory Discord), and setting the nickname of a member who
is not the server owner.

Not tested against a real Discord server: Discord's own rate limits under load.
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
