PokeVerse Discord bot - Windows development package
====================================================

This package runs the bot against your LOCAL game server (127.0.0.1) with the
DEVELOPMENT profile. It contains its own Node.js runtime; nothing needs to be installed.

First start
-----------
1. Start the local game server (game package: "Start Server.bat").
2. Double-click configure-discord-dev.bat and answer the questions:
     - development bot token (Developer Portal > Bot > Reset Token)
     - development server ID
   It writes .env.development here and config.local.lua next to the game's
   config.lua with a new random bridge secret. Restart the game server afterwards.
3. Invite the bot with the link the script prints.
4. Double-click start-discord-dev.bat. On the first start the bot creates the
   "PokeVerse Integration" category and its channels.

Updating
--------
Run download-discord-dev.bat inside this folder. It keeps .env.development, data\ and logs\.

Files
-----
start-discord-dev.bat        Start the bot (runs the configuration first if needed)
configure-discord-dev.bat    One-time configuration (safe to run again)
download-discord-dev.bat     Download the latest build from GitHub Actions
bot\bot.cjs                  The bot
node\node.exe, node\LICENSE  Official Node.js runtime and its license
THIRD_PARTY_LICENSES.txt     Licenses of the libraries inside bot\bot.cjs
.env.development.example     All settings with explanations
data\, logs\                 Created at runtime (channel IDs, logs)

Never share .env.development: it contains the bot token.
Full documentation: https://github.com/GIToez/PokeVerse-Discord/tree/main/docs
