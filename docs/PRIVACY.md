# Privacy: player activity log

The bot can post a staff-only log of logins, logouts and account links to `#player-activity` in the private
`Admin Logs` category. This page lists what is recorded, where, for how long, and how to turn
each part off.

## What is posted

| Embed | Fields |
| --- | --- |
| Login | Character, level, account number (`#42`, the game's internal id, never the account name), time, IP address (see below), approximate location (with a GeoIP database), players online, client type and protocol, session id |
| Logout | Character, level, time, session length, reason, players online, session id |
| Session ended | Posted instead of a logout the bot never received: "the game server restarted" or "the character was no longer online" |
| Account linked | Discord user (mention and id), time, main character and level, number of characters, premium, roles given, Discord sync problems |
| Account unlinked | Discord user, time, how (`/unlink`, `!discord unlink` in game, or staff `/pokeverse unlink` and who ran it), roles removed, Discord sync problems |

Link posts never contain an IP address, an account number or the account name: the game does
not send them with links. An in-game unlink while the bot is offline is queued by the game and
posted when the bot reconnects (lost if the game restarts first); the bot's next resync fixes the
member's roles either way.

Logout reasons are only the ones the game server actually knows: logged out, connection lost,
timed out, kicked by staff (`/kick`, `/masskick`), died, server shutdown, server closed to
players. When the game does not know the reason, the field is left out; the bot never guesses.

The bot's own disconnects from the game are not logouts: sessions stay open while the bot
reconnects. A reconnecting player whose character was still in the world keeps the same
session (no extra login/logout).

## Who can see it

- `Admin Logs` and `#player-activity` are created with `@everyone` denied, and only the bot and
  `ACTIVITY_LOG_VIEWER_ROLE_IDS` / `ACTIVITY_LOG_VIEWER_USER_IDS` allowed (defaults: the admin
  lists, `DISCORD_ADMIN_ROLE_IDS` / `DISCORD_ADMIN_USER_IDS`). Viewers cannot write there.
- **Before every post** the bot computes who can see the channel. If `@everyone`, any role
  that is not an authorized viewer, or any member overwrite for someone else can see it, the
  post is dropped (counted in `/pokeverse status`, and logged once a minute without any
  player data) until the channel is private again.
- Discord always shows every channel to the server owner and to roles with **Administrator**.
  Setup and status list those roles; avoid giving Administrator to roles that should not see
  player data.

## IP addresses

- The game sends the IP only in `player_login`, only over the local authenticated bridge, and
  only when `discordBridgeSessionIps = true` (game `config.local.lua`).
- The bot puts it **only** into `#player-activity`, as configured by `ACTIVITY_LOG_IP`:
  `full` (default), `masked` (`203.0.x.x`) or `hidden` (no IP field). Use `masked` when the
  viewers include people who should not see full addresses.
- The IP never appears in public channels, slash command replies (`/account` shows none), the
  bot's log files, its state or activity files, or error messages.
- No third-party lookup service is ever contacted.

## Approximate location (GeoIP)

Off unless `GEOIP_DATABASE` points to a local MaxMind-format (`.mmdb`) database. Lookups run
in the bot process; the address never leaves the machine.

- Free options: **MaxMind GeoLite2 City or Country** (free account and license agreement
  required; download it yourself and keep it updated) or **DB-IP IP to City Lite** (CC BY 4.0,
  attribution required). The bot does not ship or download a database.
- Private, loopback, carrier-grade NAT, link-local and reserved addresses show
  "No location (private network)" and similar; no lookup is made.
- Locations are approximate (often only the country or the provider's city), and wrong for
  VPNs, mobile networks and proxies. Free databases do not flag VPNs. If a database marks an
  address as anonymous proxy, VPN, Tor exit or hosting provider (commercial GeoIP2 Anonymous
  IP data, for example), the embed says so.
- An unreadable database is logged at startup and locations are turned off; the bot keeps
  running.

## Retention

- `ACTIVITY_RETENTION_DAYS` (default **30**, 1-3650). Every hour the bot deletes the
  `#player-activity` messages and records of sessions whose last activity is older than that.
  The embed footer states the period.
- The bot keeps a small record per session in `ACTIVITY_FILE` (default
  `data/activity.<profile>.json`, mode 600 on Linux): session id, server run id, character,
  level, login/logout times and the ids of the posted messages, so it can avoid duplicates,
  close sessions after a restart and delete expired messages. For link posts it keeps only the
  message id and the time. **No IP address and no account number** are stored. At most 20,000
  sessions and 20,000 link posts are kept; older ones are dropped and their messages deleted.
- Messages in a channel that was reassigned or deleted cannot be deleted by the bot; remove
  them by hand.
- Discord's own copies, the game server's logs and database are outside the bot's control.

## Turning things off

| Goal | Setting |
| --- | --- |
| No activity log at all | Bot: `ACTIVITY_LOG_ENABLED=false` (the channel is not created). Game: `discordBridgePlayerSessions = false` (no session events leave the game). |
| No IP addresses | Game: `discordBridgeSessionIps = false`, or bot: `ACTIVITY_LOG_IP=hidden` |
| Masked IP addresses | Bot: `ACTIVITY_LOG_IP=masked` |
| No locations | Bot: leave `GEOIP_DATABASE` empty (default) |
| Shorter retention | Bot: `ACTIVITY_RETENTION_DAYS=7` (for example) |
| Remove everything now | Delete the `#player-activity` channel and `ACTIVITY_FILE`. |

## Account linking data

The game stores the link (`discord_account_links`: account id, Discord user id, main character,
timestamps). The bot's state file keeps, per linked member, only the nickname it last set, so it
does not overwrite a nickname the member chose later. See [ACCOUNT_LINKING.md](ACCOUNT_LINKING.md).
