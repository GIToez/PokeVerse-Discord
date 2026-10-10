# Discord configuration

Use **two separate applications**: one for development, one for production. Each has its
own token and is invited only to its own server. The development profile refuses to run in
the production server when `PRODUCTION_GUILD_ID` is set.

## Developer Portal

1. Open <https://discord.com/developers/applications> and click **New Application**
   (for example "PokeVerse Dev").
2. **General Information**: copy the **Application ID** (`DISCORD_APPLICATION_ID`).
3. **Bot**:
   - Click **Reset Token** and copy the token (`DISCORD_TOKEN`). It is shown once. Never
     commit it or post it anywhere; reset it immediately if it leaks.
   - Turn **Public Bot** off, so only you can invite it.
   - Under **Privileged Gateway Intents**, enable **Message Content Intent** and save.
     Leave Presence off. **Server Members** is optional: enable it only together with
     `DISCORD_MEMBERS_INTENT=true` (see below).
4. **Installation** (optional): no install link is needed; the bot prints its own invite link.

### Intents

| Intent | Privileged | Why |
| --- | --- | --- |
| `Guilds` | no | Channels, roles, slash commands |
| `GuildMessages` | no | Receive messages in `#game-chat` |
| `MessageContent` | **yes** | Read the text of `#game-chat` messages to relay them into the game |
| `GuildMembers` | **yes**, optional | Only with `DISCORD_MEMBERS_INTENT=true`: give roles and nickname back immediately when a linked member leaves and rejoins. Without it, the periodic resync (`LINK_RESYNC_MINUTES`, default 15) or `/sync` does it. |

Without Message Content (or Server Members when `DISCORD_MEMBERS_INTENT=true`) the login
fails with "Used disallowed intents"; the bot explains this and exits. Bots in fewer than
100 servers can enable them without verification.

## Invite link

```bash
node dist/bot.cjs invite          # or: configure-discord-dev.bat prints it
```

The link uses the scopes `bot applications.commands` and exactly these permissions
(integer `402770960`). **Administrator is not requested.**

| Permission | Why |
| --- | --- |
| View Channels | See the PokeVerse channels |
| Send Messages | Post chat, catches, spawns, announcements, status |
| Embed Links | Rich embeds |
| Attach Files | Pokemon artwork from the game client |
| Read Message History | Find and edit the status message |
| Manage Channels | Create the "PokeVerse Integration" and private "Admin Logs" categories and their channels |
| Manage Roles | Create the Verified Trainer and Ace Trainer roles and give/remove them on link changes |
| Manage Nicknames | Set a linked member's server nickname to their main character |

Manage Channels is only needed for automatic setup. If you prefer, create the channels
yourself, assign them with `/pokeverse channel`, and remove the permission afterwards.
Manage Roles and Manage Nicknames are only needed with account linking (`LINKING_ENABLED`).

An already invited bot keeps its old permissions: add Manage Roles and Manage Nicknames to
the bot's role (**Server Settings > Roles > PokeVerse**) or open the new invite link.

### Role order

Discord only lets a bot give roles that are **below its own highest role**, and only change
nicknames of members whose highest role is below it. After the first setup, drag the bot's
role (named after the bot, e.g. "PokeVerse") **above Verified Trainer and Ace Trainer**
in **Server Settings > Roles**. `/pokeverse status` reports roles the bot cannot assign.
The server owner's nickname can never be changed by a bot; the bot reports this instead of
failing.

### Do not give the bot Administrator

The bot never needs it. Administrator also makes the bot (and any role that has it) see every
channel, including `#player-activity`; `/pokeverse setup` and `status` list such roles. If
you gave Administrator while testing, remove it and grant the permissions above instead.

## Server IDs

Discord: **User Settings > Advanced > Developer Mode** on. Then right-click the server icon
> **Copy Server ID** (`DISCORD_GUILD_ID`), right-click your name > **Copy User ID**
(`DISCORD_ADMIN_USER_IDS`), right-click a role > **Copy Role ID** (`DISCORD_ADMIN_ROLE_IDS`).

Slash commands are registered as **guild commands** in `DISCORD_GUILD_ID` only, so they
appear immediately and only there.

## Channels

On startup in development (`AUTO_SETUP=true`), or with `node dist/bot.cjs setup` /
`/pokeverse setup`, the bot ensures this layout:

```
PokeVerse Integration
  #game-chat            two-way chat                     members can write
  #pokemon-catches      catch announcements              read-only
  #shiny-spawns         shiny spawn alerts               read-only
  #legendary-spawns     legendary spawn alerts           read-only
  #game-announcements   news, GM broadcasts, restarts    read-only
  #server-status        one live status message          read-only
  #bot-commands         /trainer, /pokemon, /server      members can write
Admin Logs                                               private (activity log enabled)
  #player-activity      staff-only login/logout log      read-only, authorized viewers only
```

`Admin Logs` and `#player-activity` are created with `@everyone` denied View Channel, the bot
allowed, and `ACTIVITY_LOG_VIEWER_ROLE_IDS` / `ACTIVITY_LOG_VIEWER_USER_IDS` allowed to view
(read-only). With both empty, `DISCORD_ADMIN_ROLE_IDS` / `DISCORD_ADMIN_USER_IDS` are used;
with those empty too, only the server owner and Administrator roles can see it. Before every
post the bot checks who can see the channel; if `@everyone` or any other role or member can,
nothing is posted until it is fixed. See [PRIVACY.md](PRIVACY.md).

With account linking enabled, setup also creates (or adopts by name) the roles **Verified
Trainer** and **Ace Trainer** (`VERIFIED_ROLE_NAME`, `PREMIUM_ROLE_NAME`) without any
permissions. You can rename, recolor or move them; the saved role IDs keep working.

Rules:

- **Nothing is ever deleted**, renamed, moved or re-permissioned by the bot. Admin changes
  (names, topics, positions, permissions) are kept.
- Channel IDs are stored in `data/state.<profile>.json` immediately after each step, so a
  renamed channel stays assigned.
- Lookup order per purpose: saved ID, then a channel with the expected name in the
  category (adopted), then a new channel.
- "Read-only" means a new channel gets a `@everyone` deny for Send Messages and a member
  allow for the bot. Existing channels are not changed.
- `/pokeverse channel purpose:<feature> channel:<#channel>` assigns any text channel and
  warns about permissions the bot is missing there.
- A state file that belongs to another guild is refused, so development and production
  state cannot get mixed up.

## Admin access

`/pokeverse` is hidden from members without **Manage Server** by default (server
settings > Integrations can change this). The bot also checks every call: if
`DISCORD_ADMIN_USER_IDS` or `DISCORD_ADMIN_ROLE_IDS` are set, only those users/roles may use
it; otherwise Manage Server is required.

## Bot messages and mentions

All bot messages are sent with mentions disabled (`allowed_mentions: { parse: [] }`).
Relayed chat also has `@everyone`, `@here`, user, role and channel mentions neutralized and
Markdown escaped, so game players cannot ping Discord users.
