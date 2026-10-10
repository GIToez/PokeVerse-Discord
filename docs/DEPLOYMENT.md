# Deployment (production)

Nothing in this repository deploys automatically or connects to production. CI only builds
the packages. A production deployment is a manual, deliberate step by a server
administrator.

## Development and production are separate

| | Development | Production |
| --- | --- | --- |
| Discord application / token | Development bot | Separate production bot |
| Discord server | Development guild | Production guild |
| Config file | `.env.development` | `.env.production` |
| Selection | default, or `--profile development` | `--profile production` (the Linux start script) |
| Extra guard | Refuses `PRODUCTION_GUILD_ID` and non-loopback bridges | Requires `POKEVERSE_CONFIRM_PRODUCTION=yes` |
| State file | `data/state.development.json` | `data/state.production.json` |
| Automatic channel setup | on | off (`setup` once, explicitly) |
| Catch mode default | `all` | `rare_only` |
| Logs | pretty | JSON |
| Package | `PokeVerse-Discord-Dev-Windows` | `PokeVerse-Discord-Linux-Production` |

The profile in the file must match the selected profile; the bot never falls back from one
file to the other. Packages never contain `.env` files, `config.local.lua`, state files or
any token: the packaging script fails if it finds one.

## Requirements

- Linux x64 server where the game server runs (the bridge listens on `127.0.0.1`).
- The game server built with the bridge patches
  ([integrations/pokeverse-game](../integrations/pokeverse-game/README.md)).
- A production Discord application set up as in
  [DISCORD_CONFIGURATION.md](DISCORD_CONFIGURATION.md), invited to the production server.
- Outbound HTTPS/WebSocket access to Discord. No inbound ports.

## Install

1. Download the `PokeVerse-Discord-Linux-Production` artifact of a reviewed commit and
   extract it to `/opt/pokeverse-discord`. Node.js is included (`node/bin/node`).
2. Create a dedicated user and give it the folder:

   ```bash
   sudo useradd --system --home /opt/pokeverse-discord pokeverse
   sudo mkdir -p /opt/pokeverse-discord/data /opt/pokeverse-discord/logs
   sudo chown -R pokeverse:pokeverse /opt/pokeverse-discord
   ```

3. Configure:

   ```bash
   cd /opt/pokeverse-discord
   sudo -u pokeverse cp .env.production.example .env.production
   sudo chmod 600 .env.production
   ```

   Set `DISCORD_TOKEN`, `DISCORD_APPLICATION_ID`, `DISCORD_GUILD_ID`, admin IDs,
   `BRIDGE_SECRET`, `POKEMON_ARTWORK_DIR` and `POKEVERSE_CONFIRM_PRODUCTION=yes`.

4. Game side: in `config.local.lua` next to the server's `config.lua` (mode 600, owned by
   the game user):

   ```lua
   discordBridgeEnabled = true
   discordBridgeSecret = "<same value as BRIDGE_SECRET>"
   ```

   Restart the game server in a maintenance window.

5. Verify and create the channels once:

   ```bash
   sudo -u pokeverse ./start-discord.sh check-config
   sudo -u pokeverse ./start-discord.sh check-bridge
   sudo -u pokeverse ./start-discord.sh invite        # if the bot is not in the server yet
   sudo -u pokeverse ./start-discord.sh setup
   ```

6. Run it as a service with the reviewed `pokeverse-discord.service.example`
   (hardened: `NoNewPrivileges`, `ProtectSystem=strict`, write access only to `data/` and
   `logs/`):

   ```bash
   sudo cp pokeverse-discord.service.example /etc/systemd/system/pokeverse-discord.service
   sudo systemctl daemon-reload && sudo systemctl enable --now pokeverse-discord
   journalctl -u pokeverse-discord -f
   ```

## Operations

- **Updating**: stop the service, replace `bot/`, `node/` and the scripts, keep
  `.env.production`, `data/` and `logs/`, start the service.
- **Game restarts** do not need a bot restart; the bot reconnects and updates the status.
- **Bot restarts** do not affect the game; events during the outage are queued by the game
  (up to `discordBridgeQueueSize`) and stale ones are dropped.
- **Rotating the bridge secret**: change it in both files, restart the game and the bot.
- **Rotating the Discord token**: reset it in the Developer Portal, update `.env.production`,
  restart the bot.
- **Bot on another machine**: keep the bridge on `127.0.0.1` and use an SSH tunnel; only if
  that is impossible, use a private network with `discordBridgeAllowRemote = true` /
  `BRIDGE_ALLOW_REMOTE=true` and a firewall. Never expose port 7199 to the internet.
- **Monitoring**: `/pokeverse status` shows the bridge connection, queue sizes, dropped
  messages, missing permissions, the activity log settings and whether `#player-activity`
  is private.

## Player activity and account linking (Phase 2)

New settings, all optional, with these defaults when they are not in `.env.production`
(the game's `pokeverse-ctl` does not write them):

| Key | Default | Meaning |
| --- | --- | --- |
| `ACTIVITY_LOG_ENABLED` | `true` | Private Admin Logs category with `#player-activity` |
| `ACTIVITY_LOG_VIEWER_ROLE_IDS` / `_USER_IDS` | empty = the admin IDs | Who can see the channel |
| `ACTIVITY_LOG_IP` | `full` | `full`, `masked` or `hidden` |
| `ACTIVITY_RETENTION_DAYS` | `30` | Records and posted messages are deleted afterwards |
| `ACTIVITY_FILE` | `data/activity.production.json` | Session records (no IPs, no account ids) |
| `GEOIP_DATABASE` | empty (off) | Local MaxMind-format database, see [PRIVACY.md](PRIVACY.md) |
| `LINKING_ENABLED` | `true` | `/link` and the account commands |
| `VERIFIED_ROLE_NAME` | `Verified Trainer` | Role for linked members |
| `PREMIUM_ROLE_ENABLED` / `PREMIUM_ROLE_NAME` | `true` / `Ace Trainer` | Role while the account has premium time |
| `NICKNAME_SYNC` | `true` | Server nickname = main character |
| `LINK_RESYNC_MINUTES` | `15` | Periodic check of all links (premium expiry, in-game unlinks) |
| `DISCORD_MEMBERS_INTENT` | `false` | Instant role restore on rejoin; needs Server Members Intent in the Developer Portal |

Steps for an existing production install:

1. Game: build and deploy the Phase 2 patches. The `discord_account_links` table is created
   by the existing `pokeverse-extensions.sql` step (`CREATE TABLE IF NOT EXISTS`); no
   other table changes. The new `config.lua` settings default to on but do nothing while
   `discordBridgeEnabled = false`. Set `discordBridgeSessionIps = false` to never send IPs.
2. Discord: give the bot role **Manage Roles** and **Manage Nicknames** (the `invite`
   command prints the new URL), and move the bot role **above** Verified Trainer and Ace
   Trainer. Do not give it Administrator.
3. Bot: production has `AUTO_SETUP=false`, so run `./start-discord.sh setup` once after the
   update. It creates Admin Logs, `#player-activity` (private to the viewer IDs) and the two
   roles, and changes nothing else. Until then no activity is posted and the account
   commands report that the roles are not set up.
4. Check `/pokeverse status`: `#player-activity` must be reported as private. If anyone else
   can see it, the bot posts nothing there.

Either side can be updated first: a Phase 1 game simply has no activity or linking, and a
Phase 1 bot ignores the new events (see [GAME_INTEGRATION.md](GAME_INTEGRATION.md#compatibility)).

**Merging this repository's `main` updates production**: the game's "Live server" workflow
builds the production bot from PokeVerse-Discord `main` at its next deploy. Merge only when
the game side and the Discord role steps above are ready.

Recovery and retention procedures (lost Discord account, wrong link, removing a player's
data) are in [ACCOUNT_LINKING.md](ACCOUNT_LINKING.md) and [PRIVACY.md](PRIVACY.md).

## Before the first production deployment

- Merge the game Phase 2 patches into the game repository (review first).
- Run the manual Discord checklist in [TESTING.md](TESTING.md) in the development guild.
- Review the legendary list and the default catch mode for the production community.
- Decide on log retention for `logs/bot-production.log` (the bot does not rotate it; use
  logrotate with `copytruncate`).
