PokeVerse Discord bot - Linux production package
=================================================

Built by CI for the future production server. Nothing deploys it automatically.

1. Extract to /opt/pokeverse-discord (owned by a dedicated user, e.g. "pokeverse").
2. cp .env.production.example .env.production && chmod 600 .env.production
   Fill in the PRODUCTION bot token, guild ID, POKEVERSE_CONFIRM_PRODUCTION=yes and the
   bridge secret (same value as discordBridgeSecret in the game's config.local.lua).
3. ./start-discord.sh check-config
4. ./start-discord.sh check-bridge      (game server must be running)
5. ./start-discord.sh setup             (creates the Discord channels once)
6. Run it with systemd: see pokeverse-discord.service.example.

Files
-----
start-discord.sh                     Start script (production profile)
pokeverse-discord.service.example    Example systemd unit
bot/bot.cjs                          The bot
node/bin/node, node/LICENSE          Official Node.js runtime and its license
THIRD_PARTY_LICENSES.txt             Licenses of the bundled libraries

Full documentation: docs/DEPLOYMENT.md in the repository.
