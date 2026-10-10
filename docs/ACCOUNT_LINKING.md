# Account linking

Players link their Discord account to their PokeVerse game account. Linked members get the
**Verified Trainer** role, **Ace Trainer** while the account has premium time, and their
server nickname set to their main character.

The game server owns the links (table `discord_account_links`). The bot never reads the game
database; it asks the game over the bridge, always for one Discord user at a time.

## How a player links

1. In the game: `!discord link`. The game shows a code like `K7QM-3XPD` (chat and popup).
2. In Discord: `/link code:K7QM-3XPD`. Case, spaces and the dash do not matter.
3. The bot replies privately, gives Verified Trainer (and Ace Trainer with premium time) and
   sets the server nickname to the main character.

The player never types their game password into Discord, and the bot never asks for it.

## Rules

- One game account per Discord user and one Discord user per game account.
  - `/link` on an already linked Discord user: refused ("use /unlink first").
  - `!discord link` on an already linked game account: refused. To move the link to another
    Discord user, unlink first (in game or with `/unlink`), which proves ownership.
- Codes: random (operating system CSPRNG, 40 bits, Crockford base32 without look-alike
  characters), stored by the game only as SHA-256 hashes, valid **10 minutes**
  (`discordBridgeLinkCodeLifetime`), usable **once**. A new code replaces the previous one of
  that account. Redeeming checks and consumes the code in one step, so two attempts cannot
  both succeed.
- Brute-force protection:
  - Bot: 5 `/link` attempts per Discord user per 10 minutes.
  - Game: 5 wrong codes per Discord user within 15 minutes lock that user out until the
    15 minutes are over; across all users, at most 50 wrong codes per 10 minutes (then
    everyone waits). With 2^40 possible codes valid for 10 minutes, guessing a live code is
    not practical.
  - Game: one new code per account every 30 seconds, at most 5 per hour.
- Codes are kept only in the game server's memory: a game restart invalidates them (players
  simply request a new one).
- Discord user IDs are stored and sent as strings (`VARCHAR(20)`), never as numbers, so no
  precision is lost for IDs above 2^53.
- Codes are never logged, by the bot or by the game.

## Main character

- The main character is the account's **first-created character** on this world (lowest
  character id, not deleted), unless the player picks another one with `/main`.
- `/main` autocompletes only the player's own characters; the game rejects any other name.
- If the main character is deleted, the game falls back to the first-created remaining
  character and the bot updates the nickname.
- The game has no character rename feature, so there is nothing to sync for renames.

## Roles and nickname

- Only the Verified Trainer and Ace Trainer roles are ever added or removed. Every other role
  is left alone. The bot never changes the global Discord username, only the server nickname.
- Nickname: the main character's name (cut to 32 characters, the Discord limit). Set when
  linking, on `/main`, `/sync` and when a linked member rejoins. Automatic syncs change it only
  when the main character changed, so a nickname a member picked later is kept. Unlinking
  removes the nickname only if it is still the one the bot set. `NICKNAME_SYNC=false` turns
  nicknames off.
- Ace Trainer: given while the game account has premium days (`accounts.premdays > 0`;
  65535 means unlimited). The game reduces premium days daily, so the periodic resync
  (`LINK_RESYNC_MINUTES`, default every 15 minutes) removes the role when premium ends.
  `PREMIUM_ROLE_ENABLED=false` turns it off.
- When Discord refuses a change (role above the bot, server owner, missing permission), the
  link stays and the member and staff get an explanation in `/account`, `/sync` and the log.
  See [Role order](DISCORD_CONFIGURATION.md#role-order).

## When the bot syncs

| Trigger | What happens |
| --- | --- |
| `/link`, `/main`, `/sync` | Immediate sync, nickname written. |
| `/unlink`, `!discord unlink`, `/pokeverse unlink` | Roles removed, bot-set nickname reset. |
| Character created or deleted in the game account manager | The game sends `account_characters`; the bot re-reads the link (main fallback). |
| Bot connects to the game (start, reconnect) and every `LINK_RESYNC_MINUTES` | Every link is re-checked, page by page; members whose link disappeared are cleaned up. |
| A linked member rejoins the server | Roles and nickname restored: immediately with `DISCORD_MEMBERS_INTENT=true`, otherwise at the next resync or `/sync`. |

Syncs are idempotent (they only call Discord for real differences), queued one at a time
(Discord rate limits are handled by discord.js), and a failed sync never removes the link.

## Recovery

| Situation | What to do |
| --- | --- |
| Player lost access to their Discord account | Log in to the game and type `!discord unlink`, then `!discord unlink confirm`. Then link the new Discord account with `!discord link` and `/link`. Logging in to the game is the ownership proof. |
| Player lost access to the game account | Recover the game account first (game staff), then as above. The Discord side cannot move a link. |
| Staff need to remove a link (abuse, support case, deleted Discord account) | `/pokeverse unlink user_id:<Discord user ID>`. Admin-only, logged with the admin's ID. The player can link again with a new code. |
| Roles or nickname look wrong | The member runs `/sync`; staff can check `/pokeverse status` (role order, permissions). |

There is no way to link or move an account from Discord alone: every new link needs a code
that only someone logged in to the game account can see.

## Configuration

| Setting (bot `.env`) | Default | Meaning |
| --- | --- | --- |
| `LINKING_ENABLED` | `true` | Register the account commands and sync roles. |
| `VERIFIED_ROLE_NAME` | `Verified Trainer` | Name used when the role is created or adopted. |
| `PREMIUM_ROLE_ENABLED` / `PREMIUM_ROLE_NAME` | `true` / `Ace Trainer` | Premium role. |
| `NICKNAME_SYNC` | `true` | Set the server nickname to the main character. |
| `LINK_RESYNC_MINUTES` | `15` | Periodic re-check of all links; `0` turns it off. |
| `DISCORD_MEMBERS_INTENT` | `false` | Restore roles immediately on rejoin (needs the Server Members intent in the Developer Portal). |

| Setting (game `config.local.lua`) | Default | Meaning |
| --- | --- | --- |
| `discordBridgeAccountLinking` | `true` | `!discord` commands and the link requests. Off: the bot reports linking as unavailable. |
| `discordBridgeLinkCodeLifetime` | `600` | Code lifetime in seconds. |

The bot needs **Manage Roles** and **Manage Nicknames** for linking; see
[DISCORD_CONFIGURATION.md](DISCORD_CONFIGURATION.md#invite-link).
