# Game integration

## Phase 2 audit (October 10, 2026)

Audit made before the Phase 2 work (account linking, character management, admin activity
logs). Game facts refer to [PokeVerse](https://github.com/GIToez/PokeVerse) `main` at
`49abf2b`.

### Repositories and branches

- **PokeVerse-Discord** `main` contains the Phase 1 bot ([PR #1](https://github.com/GIToez/PokeVerse-Discord/pull/1), merged).
  Phase 2 is developed on `cursor/phase2-account-linking-ef3d`.
- **PokeVerse** `main` contains Phase 1 ([PR #5](https://github.com/GIToez/PokeVerse/pull/5)),
  the Discord bridge (patches 0001-0004, applied through
  [PR #6](https://github.com/GIToez/PokeVerse/pull/6)) and the OVH live server
  ([PR #7](https://github.com/GIToez/PokeVerse/pull/7)). Open: client PRs #8 and #9 (no
  server changes relevant here). The bot's automation still has no write access to the game
  repository, so game-side Phase 2 changes are again shipped as a patch series in
  `integrations/pokeverse-game/` (branch name `cursor/discord-phase2-ef3d`).
- **Production coupling**: the game repository's "Live server" workflow builds the
  production bot from PokeVerse-Discord `main` and deploys it to OVH (by hand, or on pushes
  to game `main` when `LIVE_AUTO_DEPLOY=true`). Its `pokeverse-ctl` writes only
  `DISCORD_TOKEN`, `DISCORD_APPLICATION_ID`, `DISCORD_GUILD_ID`, the admin IDs and the
  bridge settings into `.env.production`. Every new bot setting therefore needs a safe
  default, and merging the bot to `main` means it reaches production at the next deploy.

### Bot architecture (existing)

- discord.js 14, guild-scoped slash commands registered on every start
  (`src/commands/definitions.ts`, `BotApp.start`), routed by `CommandRouter`.
- `GameIntegration` holds all services behind port interfaces (`ChannelSink`,
  `ChannelDirectory`, `GuildPort`), so services are tested without Discord.
- Channel setup (`src/setup/`) creates or adopts channels, persists IDs in
  `data/state.<profile>.json` and never deletes or re-permissions anything. The bot has no
  role management yet and does not request Manage Roles or Manage Nicknames.
- Bridge client: NDJSON over TCP, HMAC handshake, reconnect with backoff, `bootId`
  restart detection, zod-validated events, unknown event kinds ignored.

### Accounts and characters (game database)

- `accounts`: `id` INT AUTO_INCREMENT primary key, `name` (the login name, half of the
  credentials), `password` (hash), `premdays`, `lastday`, `group_id`, plus PokeVerse columns.
  There is no Discord or external identity column.
- `players`: `id` INT AUTO_INCREMENT, `account_id` (foreign key to `accounts.id`,
  `ON DELETE CASCADE`), `name`, `world_id`, `level`, `vocation`, `group_id`, `lastlogin`,
  `lastlogout`, `lastip`, `online`, `deleted` (soft delete; unique key `(name, deleted)`).
  Characters belong to exactly one account through `account_id`.
- **Creation order**: there is **no creation timestamp**. Characters are created by the
  server's account service (`src/protocolaccount.cpp`, client "create character") through
  the `pokeverse_add_character` procedure, or by the `pokeverse_create_character` helper;
  both insert without an explicit `id`, so `players.id` (InnoDB AUTO_INCREMENT, persistent in
  MariaDB 10.2.4+) increases in creation order. Exceptions would be rows inserted with an
  explicit `id` by hand or imported from another database. Phase 2 therefore uses
  "lowest `players.id` among the account's non-deleted characters of this world" as the
  documented, deterministic first-character rule and tells the player which character was
  chosen and how to change it.
- Character deletion: `IOLoginData::deleteCharacter` sets `deleted = 1`. There is no rename
  feature in the game.
- Premium: `accounts.premdays > 0` (`65535` = unlimited, never decremented). Days are
  subtracted by `IOLoginData::removePremium` (on login and at startup with
  `removePremiumOnInit`). `freePremium` (config, `false`) and the group flag
  `IsAlwaysPremium` make everyone or staff premium in game; Phase 2's "Ace Trainer" role uses
  the account's real premium days only.
- Schema changes are idempotent SQL: `core/server/schemas/pokeverse-extensions.sql`
  (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`) is re-applied by the Windows
  "Setup Database.bat" and by `pokeverse-ctl` on every live install. There are no numbered
  migrations; new tables follow this convention.

### Sessions, login and logout (game server)

- Successful world entry: `Player::onPlacedCreature` runs the Lua `onLogin` scripts; if any
  returns false the player is kicked. A login is only real after that call succeeded.
- Lua `onLogout(cid, forceLogout)` can return false to **cancel** a logout, so it is not a
  reliable "player left" signal. The reliable point is `Game::removeCreature` for a player.
- Disconnect causes visible in the source:
  - client logout request (`ProtocolGame::parseLogout`, packet `0x14`);
  - connection lost with `disconnectAtExit = true` (default): `Player::onThink` removes the
    player when the client is gone;
  - ping timeout (`lastPong` older than 60 s / 600 s): `Player::onThink`;
  - GM `/kick`: `doRemoveCreature` from `talkactions/scripts/kick.lua`;
  - death: `Player::onDeath` paths remove and kick the player;
  - server shutdown or close: `Game::setGameState` kicks every player.
  Other removals (scripts calling `doRemoveCreature`, a second login of the same character)
  carry no reliable reason.
- IP address: `Player::getIP()` (IPv4, from the connection, falls back to `lastIP`), Lua
  `getPlayerIp(cid)`; `players.lastip` stores the last one. Client type:
  `Player::getOperatingSystem()` (`CLIENTOS_WINDOWS`, `CLIENTOS_OTCLIENT_*`, ...) and
  `getClientVersion()`.
- There are no session IDs. Session identity in Phase 2: `<bootId>-s<counter>`, created in
  C++ when the login succeeded and closed in `Game::removeCreature`.
- Server restarts: the bridge `bootId` changes; sessions of the old boot that were not
  closed by a logout event are closed by the bot as "server restarted".
- Bot disconnects: the game queues events (up to 2000) while no bot is connected, so a bot
  restart does not lose or invent logouts; the bot never infers a logout from its own
  connection state.

### In-game commands

Talkactions use both `/` and `!` prefixes (`!frags`, `!uptime`, `!pos`, `/online`, ...).
`!discord` and `/discord` are unused. Talkaction text that a script handles is not shown to
other players, and `doPlayerSendTextMessage` is private to the player.

### Bridge (existing)

Protocol version 1 (`docs/discord-bridge.md`), C++ listener in `src/discordbridge.*` with
OpenSSL (`HMAC`, `RAND_bytes` already linked), Lua handlers in
`data/lib/ps/systems/056-discordBridge.lua`, JSON library `013-json.lua`. Requests run on
the dispatcher thread, so request handlers are naturally serialized.

## Phase 1 repository audit (October 2026)

### PokeVerse-Discord (this repository)

`main` contained only a one-line `README.md`. Everything in this repository was written for
this bot on branch `cursor/discord-bot-ef3d`
([PR #1](https://github.com/GIToez/PokeVerse-Discord/pull/1)).

### PokeVerse (game)

[GIToez/PokeVerse](https://github.com/GIToez/PokeVerse) `main` contains only the initial
commit. All game code lives in open pull requests, in two separate lineages:

| PR | Branch | Base | Content |
| --- | --- | --- | --- |
| [#1](https://github.com/GIToez/PokeVerse/pull/1) | `cursor/import-pokejornadas-base-489e` | `main` | PokeJornadas import, `server/` layout |
| [#2](https://github.com/GIToez/PokeVerse/pull/2) | `cursor/phase2-verify-build-test` | #1 | Buildable baseline of that import |
| [#3](https://github.com/GIToez/PokeVerse/pull/3) | `cursor/phase3-redemption-489e` | #2 | Redemption client engine, cross-platform builds |
| [#4](https://github.com/GIToez/PokeVerse/pull/4) | `cursor/ci-dev-packages-489e` | #3 | CI packages and releases |
| [#5](https://github.com/GIToez/PokeVerse/pull/5) | `cursor/phase1-foundation-structure-c8d5` | `main` | **Phase 1 foundation**: PSoul-based sources in `core/`, Windows dev package (server, MariaDB, client), Linux build and server test in CI |

The bot targets **PR #5**: it is the newest lineage, it is the one with the Windows localhost
development package the bot's development profile is built for, and its CI already starts
a real server with real clients, which the bridge test extends. The PR #1-#4 lineage has a
different layout and engine; the bridge would need to be ported if that lineage is chosen
instead (the Lua hooks depend on PSoul functions such as `catchPokemon` and `onMonsterSpawn`).

Facts taken from the PR #5 code and used by the bot:

- Public chat is channel 7, "Game-Chat[EN-US]" (`data/XML/channels.xml`).
- Character sex values: `0` female, `1` male, `2` unknown.
- Ball names come from the game's `ballsNames` table (for example `ultra`).
- Shiny species are separate species named `Shiny <Name>`.
- The "+N" boost value of a caught Pokemon is always 0 at catch time; the bot shows `+N`
  only when it is greater than 0.
- There is no legendary flag in the Pokemon data. The bridge uses an audited list (below).
  Legendaries are not in the map spawn data; they appear only through quest scripts.
- Pokedex pictures: `core/client-legacy/data/images/pictures/<dex>.png` in the repository,
  `client-legacy-windows\data\images\pictures` in the Windows package.
- The Windows package keeps the server in `server-windows\` with `config.lua` there.

## Game-side changes

Four commits on top of PR #5, kept as a patch series in
[integrations/pokeverse-game](../integrations/pokeverse-game/README.md) because the bot's
automation has no write access to the game repository (push returned HTTP 403). They are
meant for a separate branch `cursor/discord-bridge-ef3d` and a PR against the phase 1
branch. The full protocol reference is `docs/discord-bridge.md` in that series.

Summary:

- **C++** (`src/discordbridge.*`): TCP listener on its own thread. Game code only appends to
  bounded in-memory queues, so the game never blocks on the bot. Hooks in `Game::setGameState`
  (server state), `Game::prepareGlobalSave` (restart warnings) and
  `Game::playerBroadcastMessage` (client broadcasts). Optional `config.local.lua`.
- **Lua** (`056-discordBridge.lua`): chat (`onTalkChannel`), catch (after the ball was
  created in all three catch functions), spawn (`onMonsterSpawn`, `doCreateMonster`,
  fishing, headbutt; shiny and legendary only), `/b`, `/bc` and `/shutdown` hooks, and the
  read-only request handlers. Every hook is wrapped in `pcall` and does nothing while the
  bridge is disabled.
- **Tests**: `scripts/discord-bridge-test.py` in the game's Linux server test.
- **Disabled by default.** `config.lua` only gets the settings with `discordBridgeEnabled = false`.

### Security properties

- Listens on `127.0.0.1` only. A non-loopback address requires `discordBridgeAllowRemote = true`.
  Never expose the port publicly; use an SSH tunnel or private network if the bot runs elsewhere.
- Shared-secret authentication: the server sends a random nonce; the bot answers with
  `HMAC-SHA256(secret, nonce)`. Secrets under 16 characters keep the bridge disabled.
- The secret lives only in the ignored `config.local.lua` and the bot's `.env` file.
- The only write operation is `chat.send`, which displays a message in channel 7.
  Lookups are read-only and run inside the game; the bot has no database access.
- Staff characters are hidden from `/trainer`.

## Protocol (version 1)

Newline-delimited JSON over TCP (default port 7199).

```
server -> {"type":"hello","protocol":1,"nonce":"..."}
bot    -> {"type":"auth","hmac":"..."}
server -> {"type":"welcome","protocol":1,"bootId":"...","serverName":"PokeVerse","queued":N}
server -> {"type":"event","id":"<bootId>-<seq>","time":...,"event":{"kind":"catch",...}}
bot    -> {"type":"request","requestId":"1","method":"trainer.lookup","params":{"name":"Ash"}}
server -> {"type":"response","requestId":"1","ok":true,"result":{...}}
```

| Event kind | Bot feature |
| --- | --- |
| `chat` | `#game-chat` as `[Game] Name: text` |
| `catch` | `#pokemon-catches` (filtered by catch mode) |
| `spawn` | `#shiny-spawns` / `#legendary-spawns` |
| `broadcast` | `#game-announcements` |
| `restart_warning` | `#game-announcements` |
| `server_state` | `#server-status` message |

| Request | Used by |
| --- | --- |
| `chat.send` | Discord -> game chat |
| `trainer.lookup` | `/trainer` |
| `pokemon.lookup`, `pokemon.search` | `/pokemon` and its autocomplete |
| `server.status` | `/server`, `#server-status`, `check-bridge` |
| `bridge.config` | Chat length limits, legendary list |

The bot validates every message with zod schemas (`src/integrations/pokeverse/protocol.ts`)
and ignores unknown event kinds, so the game can add events without breaking older bots.

### Delivery guarantees

- Events are queued in the game while no bot is connected (default 2000, oldest dropped) and
  delivered on connect. Delivery is at most once; nothing survives a game restart.
- The bot de-duplicates by event ID and drops stale events (chat older than 30 s, spawns
  older than 5 min, catches older than 10 min by default), so a reconnect after a long
  outage does not flood Discord with old chat.
- Discord delivery uses bounded per-feature queues with retry on rate limits; a full queue
  drops the oldest item and counts it in `/pokeverse status`.
- One bot connection at a time; a new authenticated connection replaces the old one.
- The bot reconnects with backoff (1 s up to 30 s) and detects game restarts by `bootId`.

## Feature behaviour

### Chat

- Discord -> game: only `#game-chat`, only human members (no bots, webhooks or system
  messages). Shown in game as `[Discord] <display name>: <text>`. Attachments-only messages
  become `[attachment]`. Long text is cut to `CHAT_MAX_LENGTH`. Per-user and global rate
  limits; the bot reacts with ⏳ when a message was rate limited and ⚠️ when the game is
  offline.
- Game -> Discord: `[Game] <name>: <text>` with mentions neutralized, Markdown escaped and
  link previews suppressed.
- No loops: messages the bot writes into the game channel do not trigger `onTalkChannel`,
  and the bot ignores its own Discord messages.

### Catches

Only confirmed catches (the ball was created). Failed throws produce no event at all. The
embed shows trainer, Pokemon (with `+N` only when present), level, sex, ball, and the
artwork. Shiny and legendary catches are highlighted. Modes: `all`, `rare_only`,
`shiny_legendary_only`, `off` (`/pokeverse catches`).

### Spawns

- Shiny -> `#shiny-spawns`, legendary -> `#legendary-spawns`, a shiny legendary goes to
  exactly one channel (`SPAWN_SHINY_LEGENDARY_ROUTE`, default legendary).
- Location: `none`, `town` (nearest town, default) or `coordinates`.
- Monsters placed during server startup are not announced unless `SPAWN_ANNOUNCE_STARTUP=true`.
- Quest bosses that recreate themselves are reported at most once per 5 minutes per species.

### Legendary list

`Articuno, Zapdos, Moltres, Mewtwo, Mew, Raikou, Entei, Suicune, Lugia, Ho-Oh, Celebi,
Regirock, Regice, Registeel, Latias, Latios, Kyogre, Groudon, Rayquaza, Jirachi, Deoxys`,
the boss variants `Boss Articuno, Frozen Boss Articuno, Boss Zapdos, Boss Moltres, Final Mewtwo`,
and all `Shiny` variants. It is `CONFIG.legendary` in `056-discordBridge.lua`.

### Announcements and status

- GM `/b` and client broadcasts, `/bc` (staff) and `/shutdown` / global save warnings
  (including "cancelled") go to `#game-announcements`. Automatic tips are not forwarded.
- `#server-status` has one message that the bot edits: online/offline, players, uptime,
  last restart. It is recreated if someone deletes it. Offline is shown when the bridge
  disconnects.

## Known pre-existing game issues

Found while testing, present in PR #5 without the bridge, not fixed here:

- Logging out a character a second time logs a `datalog_player_items` duplicate primary
  key error.
- SIGINT/SIGTERM can hang the server: the handler joins the dispatcher from its own
  thread. Test scripts fall back to SIGKILL.
