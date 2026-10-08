# Setup (development)

Development uses its **own** Discord application, its own Discord server ("guild") and the
local game server on `127.0.0.1`. It never touches production. Production is described in
[DEPLOYMENT.md](DEPLOYMENT.md).

## 1. Prepare Discord

Follow [DISCORD_CONFIGURATION.md](DISCORD_CONFIGURATION.md):

1. Create a development application and bot, copy the token and the Application ID.
2. Enable the **Message Content** privileged intent.
3. Turn on Developer Mode in Discord and copy the development server ID.

## 2. Prepare the game server

The bridge is part of the game server, see
[integrations/pokeverse-game](../integrations/pokeverse-game/README.md). With a game build
that contains it, the bridge is still off until `config.local.lua` (next to `config.lua`)
enables it. On Windows the configure script below writes that file for you.

## 3a. Windows development package (recommended)

1. Download the `PokeVerse-Discord-Dev-Windows` artifact from the latest successful
   [CI run](https://github.com/GIToez/PokeVerse-Discord/actions/workflows/ci.yml) and extract
   it, for example to `C:\PokeVerse\discord`. Node.js is included.
2. Double-click `configure-discord-dev.bat`. It asks for:
   - the development bot token (input is hidden),
   - the Application ID and the development server ID,
   - optionally your Discord user ID (admin) and the production server ID (development will
     then refuse to run there),
   - the game folder (it looks for `config.lua` in the folder, `server-windows\` and
     `server\`).

   It then
   - generates a random bridge secret,
   - writes `.env.development` (here) and `config.local.lua` (next to the game's
     `config.lua`), readable only by your Windows user,
   - finds the client's Pokemon pictures for `/pokemon` artwork,
   - validates the configuration and prints the invite link.
3. Restart the game server so it loads `config.local.lua`. Its console shows
   `>> Discord bridge listening on 127.0.0.1:7199`.
4. Open the invite link and add the bot to the development server.
5. Double-click `start-discord-dev.bat`. On first start the bot creates the
   "PokeVerse Integration" category with its channels and posts the status message.

Non-interactive configuration (for scripts):

```powershell
$env:POKEVERSE_DISCORD_TOKEN = "<token>"
.\configure-discord-dev.ps1 -NonInteractive -ApplicationId 123... -GuildId 456... -GameDir C:\PokeVerse
```

Updating: run `download-discord-dev.bat` in the bot folder. It needs a GitHub token with
`actions:read` for the repository, downloads the newest successful build of the selected
branch and keeps `.env.development`, `data\` and `logs\`.

## 3b. From source (any OS)

```bash
npm ci
cp .env.development.example .env.development
# fill in DISCORD_TOKEN, DISCORD_APPLICATION_ID, DISCORD_GUILD_ID, BRIDGE_SECRET,
# POKEMON_ARTWORK_DIR=<game>/core/client-legacy/data/images/pictures
npm run build
node dist/bot.cjs check-config
node dist/bot.cjs invite
node dist/bot.cjs check-bridge     # game server must be running
node dist/bot.cjs start
```

Game side, `core/server/config.local.lua`:

```lua
discordBridgeEnabled = true
discordBridgeSecret = "<same value as BRIDGE_SECRET>"
```

Generate a secret with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

## Files the bot writes

| File | Content |
| --- | --- |
| `data/state.development.json` | Guild ID, channel IDs, status message ID, catch mode, last boot ID. Delete a channel ID here (or use `/pokeverse channel`) to change assignments. |
| `logs/bot-development.log` | Log file (if `LOG_FILE` is set) |

## Troubleshooting

| Message | Fix |
| --- | --- |
| `Discord rejected the bot token` | Reset the token in the Developer Portal and run the configure script again. |
| `Used disallowed intents` | Enable Message Content in Developer Portal > Bot > Privileged Gateway Intents. |
| `The bot is not a member of guild ...` | Use the printed invite link. |
| `The game server is not reachable yet` | Start the game server; check `config.local.lua`. The bot keeps retrying. |
| `auth_failed` | `BRIDGE_SECRET` and `discordBridgeSecret` differ. |
| `DISCORD_GUILD_ID is the production guild` | Development must use the development server. |
| Channel setup reports missing permissions | Give the bot role Manage Channels (or create the channels yourself and use `/pokeverse channel`). |
