# Commands

## Slash commands

All commands work only in the configured server (`DISCORD_GUILD_ID`). Errors, "not found"
and rate-limit replies are only visible to the person who used the command; results are
public.

### `/trainer name:<character>`

Public profile from the game: level, class, guild, online state, Pokemon caught (total,
unique, shiny), duel wins/losses, players defeated, tournaments won and achievements
(count plus up to 5 recent, never secret ones).

- Only existing, non-deleted characters of this world. Staff characters are reported as
  "not found".
- Names: letters, spaces, apostrophes and dashes, 2-30 characters.
- The game answers from live data for online characters and from the database for offline
  ones. The bot never queries the database itself.

### `/pokemon name:<species>`

Species data from the game's own Pokemon definitions: Pokedex number, generation, types,
base stats, description, evolutions, moves with levels, abilities, special abilities,
and whether it is shiny, legendary and catchable. Artwork is the game client's picture
`<dex>.png` from `POKEMON_ARTWORK_DIR` (omitted when the folder is not configured).

- Autocomplete suggests up to 25 names from the game (prefix matches first).
- `Shiny Bulbasaur` works too. Unknown names get "Did you mean" suggestions.

`/trainer` and `/pokemon` share a limit of 5 lookups per user per 10 seconds.

### `/server`

Current status: online/offline, players online, uptime, last restart. The same data is
kept up to date in the `#server-status` message.

### `/pokeverse` (admins)

Visible to members with **Manage Server** by default; see
[DISCORD_CONFIGURATION.md](DISCORD_CONFIGURATION.md#admin-access). Replies are private.

| Subcommand | Effect |
| --- | --- |
| `setup` | Create missing channels, adopt existing ones by name, report missing permissions. Never deletes or changes existing channels. |
| `status` | Profile, bridge connection, catch mode, chat and spawn settings, queue sizes, channel/permission report, counters. |
| `channel purpose:<feature> channel:<#channel>` | Use an existing text channel for a feature (stored in the state file). |
| `catches mode:<mode>` | `all`, `rare_only` (shiny, legendary and `CATCH_RARE_SPECIES`), `shiny_legendary_only`, `off`. Stored in the state file and takes effect immediately. |
| `announce category:<news|event|maintenance> text:<text> [title]` | Post an announcement in `#game-announcements` with your display name. |

## CLI

```
node dist/bot.cjs <command> [--profile development|production] [--config-dir <folder>]
```

The packages wrap this: `start-discord-dev.bat` (Windows, development) and
`start-discord.sh` (Linux, production).

| Command | Effect |
| --- | --- |
| `start` (default) | Run the bot. |
| `setup` | Log in, create or repair the channels, exit. |
| `check-config` | Validate the `.env` file without connecting anywhere. Never prints secrets. |
| `check-bridge` | Connect to the game bridge, authenticate, print the server status. |
| `register-commands` | Register the slash commands in the configured guild. `start` does this too. |
| `invite` | Print the invite link with the minimum permissions. |
| `help` | Usage. |

Exit codes: `0` success, `1` runtime error (for example Discord rejected the token, bridge
unreachable for `check-bridge`), `2` configuration error.

## In-game

Nothing new for players. Messages in **Game-Chat** are relayed to `#game-chat` and Discord
messages appear there as `[Discord] Name: text`. GM `/b` broadcasts and `/shutdown`
warnings are posted to `#game-announcements`.
