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
(integer `326820285456`). **Administrator is not requested.**

| Permission | Why |
| --- | --- |
| View Channels | See the PokeVerse channels |
| Send Messages | Post chat, catches, spawns, announcements, status |
| Embed Links | Rich embeds |
| Attach Files | Pokemon artwork from the game client |
| Read Message History | Find and edit the status message |
| Manage Channels | Create the "PokeVerse Integration" and private "Admin Logs" categories and their channels |
| Manage Roles | Create the Verified Trainer, Ace Trainer and staff roles and give/remove them on link changes |
| Manage Nicknames | Set a linked member's server nickname to their main character |
| Create Public Threads | One thread per wild legendary in `#legendary-spawns` |
| Send Messages in Threads | Post the legendary's sightings and end in its thread, and report updates in their posts |
| Manage Threads | Report posts: set their status tags (moderated tags), rename and archive them |

Manage Channels is only needed for automatic setup. If you prefer, create the channels
yourself, assign them with `/pokeverse channel`, and remove the permission afterwards.
Manage Roles and Manage Nicknames are only needed with account linking (`LINKING_ENABLED`),
Manage Threads only with the report forums (`BUG_REPORTS_ENABLED`, `PLAYER_REPORTS_ENABLED`).
Optional: **View Audit Log** lets the bot name the staff member who changed a report's status
tag (otherwise the game shows "Discord staff").

An already invited bot keeps its old permissions: add Manage Roles, Manage Nicknames,
Create Public Threads, Send Messages in Threads and Manage Threads to the bot's role (**Server Settings > Roles > PokeVerse**) or open the new invite link.

Then run setup again (`/pokeverse setup`, or `setup` on the command line). For channels
that already exist it changes only two things, and reports them as "updated":

- a topic that is still an earlier default (for example `#legendary-spawns`' old
  "Legendary Pokemon sightings.") becomes the current one; a topic someone wrote is kept;
- permissions the bot needs in a channel, has server-wide, but the channel takes away are
  added to the bot's own member overwrite (needs Manage Roles). No other overwrite changes;
- a report forum gets back the status and category tags it is missing (by name; tags someone
  renamed count as missing, tags someone added are kept).

### Role order

Discord only lets a bot give roles that are **below its own highest role**, and only change
nicknames of members whose highest role is below it. After the first setup, drag the bot's
role (named after the bot, e.g. "PokeVerse") **above Verified Trainer, Ace Trainer and the
staff roles (Tutor, Senior Tutor, Gamemaster, Community Manager, God)** in **Server Settings >
Roles**. The bot also cannot change the nickname of a member whose highest role is above the
bot's, so keep any separate moderator roles in mind. `/pokeverse status` reports roles the bot cannot assign.
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
  #bug-reports          forum: one post per bug report   members comment, staff set tags
Admin Logs                                               private (activity log or player reports)
  #player-activity      staff-only login/logout/link log read-only, authorized viewers only
  #player-reports       forum: one post per player report authorized viewers only
```

`Admin Logs` and `#player-activity` are created with `@everyone` denied View Channel, the bot
allowed, and `ACTIVITY_LOG_VIEWER_ROLE_IDS` / `ACTIVITY_LOG_VIEWER_USER_IDS` allowed to view
(read-only). With both empty, `DISCORD_ADMIN_ROLE_IDS` / `DISCORD_ADMIN_USER_IDS` are used;
with those empty too, only the server owner and Administrator roles can see it. Before every
post the bot checks who can see the channel; if `@everyone` or any other role or member can,
nothing is posted until it is fixed. See [PRIVACY.md](PRIVACY.md).

With account linking enabled, setup also creates (or adopts by name) the roles **Verified
Trainer** and **Ace Trainer** (`VERIFIED_ROLE_NAME`, `PREMIUM_ROLE_NAME`) and the staff roles
**Tutor**, **Senior Tutor**, **Gamemaster**, **Community Manager** and **God**
(`STAFF_ROLE_NAMES`), all without any permissions. Give the staff roles Discord permissions
yourself if you want (for example Manage Messages for Gamemasters), but never Administrator:
the bot refuses to adopt or hand out a role with Administrator. You can rename, recolor or move them; the saved role IDs keep working.

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

## Report forums

Bug reports and player reports sent from the game's Reports window (Ctrl+Z, or "Report
player" on a player or a chat line) become forum posts:

- `#bug-reports` (public): members can read and comment, only the bot creates posts.
- `#player-reports` (in Admin Logs): private like `#player-activity`, checked before every
  post. Viewers get View Channel, Read Message History, Send Messages in Threads and Manage
  Threads in it, so they can answer in the posts and change the tags.

Each post is named `[#12] title` and its first message has the whole report: the reporter
(level, vocation, and their Discord account when linked), where they stood (and the area),
the Pokemon out, the client, and for player reports the reported player then, the reported
chat message and their last channel messages. A screenshot sent with the report is posted
below it. Status changes, notes, who took the report and merged reports are lines in the
post; a closed report's post is archived.

Tags: one status tag (Open, Confirmed, Planned, In progress, Fixed, Won't fix, Duplicate for
bugs; Open, Investigating, Action taken, No action, Duplicate for players) and one category
tag. The status tags are **moderated**: only members with Manage Threads can pick them. Picking
another status tag changes the report in the game (`REPORT_TAG_SYNC`), the reporter is told
in the game and the line in the post says who did it. Taking the status tag off, or a
change the game refuses, puts the tag back.

A linked reporter is pinged on their bug report's post and when its status changes
(`REPORT_MENTION_REPORTER`); player reports never ping anyone.

## Booster rewards

With `BOOSTER_REWARDS_ENABLED=true`, setup creates the read-only `#booster-rewards` channel.
The bot sees a boost through the server's boost system message (it needs View Channel in the
system messages channel, Server Settings → System Messages), the member's `/booster`, or the
periodic link resync. Discord only tells bots when the member's current unbroken boost
started, not how many boosts they have, so each member earns one reward stream. Removing or
transferring the last boost clears the start date and the streak starts again.

## Admin access

`/pokeverse` is hidden from members without **Manage Server** by default (server
settings > Integrations can change this). The bot also checks every call: if
`DISCORD_ADMIN_USER_IDS` or `DISCORD_ADMIN_ROLE_IDS` are set, only those users/roles may use
it; otherwise Manage Server is required.

## Bot messages and mentions

All bot messages are sent with mentions disabled (`allowed_mentions: { parse: [] }`).
The only exception is the linked reporter of a bug report, on their own post.
Relayed chat also has `@everyone`, `@here`, user, role and channel mentions neutralized and
Markdown escaped, so game players cannot ping Discord users.
