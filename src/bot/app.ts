import { Client, Events, GatewayIntentBits, type Guild } from "discord.js";
import { buildCommandDefinitions } from "../commands/definitions.js";
import type { BotConfig } from "../config/load.js";
import { createInteractionHandler } from "../events/interactionCreate.js";
import { createMessageHandler } from "../events/messageCreate.js";
import { formatSetupReport } from "../setup/channelSetup.js";
import { inviteUrl } from "../setup/invite.js";
import type { Logger } from "../utils/logger.js";
import { Metrics } from "../utils/metrics.js";
import { StateStore } from "../utils/stateStore.js";
import { DiscordChannelDirectory, DiscordGuildPort } from "./discordAdapter.js";
import { GameIntegration } from "./integration.js";

export class StartupError extends Error {
  constructor(message: string, readonly hints: string[] = []) {
    super(message);
    this.name = "StartupError";
  }
}

export const GATEWAY_INTENTS = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent];
/** Privileged; only requested with DISCORD_MEMBERS_INTENT=true (instant role restore on rejoin). */
export const MEMBERS_INTENT = GatewayIntentBits.GuildMembers;
/** Channel setup only needs guild data, so it works before Message Content is enabled. */
export const SETUP_GATEWAY_INTENTS = [GatewayIntentBits.Guilds];

/** Explains the usual login failures in plain words. */
export function explainLoginError(error: unknown, config: BotConfig): StartupError {
  const message = (error as Error)?.message ?? String(error);
  if (/disallowed intents/i.test(message)) {
    return new StartupError("Discord refused a privileged intent.", [
      "Developer Portal > your application > Bot > Privileged Gateway Intents: enable MESSAGE CONTENT INTENT and save.",
      ...(config.linking.membersIntent
        ? ["DISCORD_MEMBERS_INTENT=true also needs SERVER MEMBERS INTENT there (or set DISCORD_MEMBERS_INTENT=false)."]
        : []),
    ]);
  }
  if (/invalid token|TokenInvalid|401/i.test(message)) {
    return new StartupError("Discord rejected the bot token.", [
      `Reset the token in the Developer Portal (Bot > Reset Token) and update DISCORD_TOKEN in ${config.envFile}.`,
    ]);
  }
  return new StartupError(`Could not connect to Discord: ${message}`, ["Check the internet connection and try again."]);
}

export class BotApp {
  readonly metrics = new Metrics();
  readonly store: StateStore;
  readonly client: Client;
  readonly integration: GameIntegration;
  private guild: DiscordGuildPort | undefined;

  constructor(
    private readonly config: BotConfig,
    private readonly logger: Logger,
    private readonly options: { setupOnly?: boolean } = {},
  ) {
    this.store = new StateStore(config.stateFile, config.profile);
    const intents = options.setupOnly
      ? SETUP_GATEWAY_INTENTS
      : [...GATEWAY_INTENTS, ...(config.linking.enabled && config.linking.membersIntent ? [MEMBERS_INTENT] : [])];
    this.client = new Client({ intents, allowedMentions: { parse: [] } });
    this.integration = new GameIntegration({
      config,
      store: this.store,
      channels: new DiscordChannelDirectory(this.client, this.store, config.discord.guildId),
      guild: () => this.guild,
      logger,
      metrics: this.metrics,
    });
  }

  /** Logs in, checks the guild, registers commands, runs setup (if enabled) and starts the bridge. */
  async start(): Promise<void> {
    const { config, logger, client, options } = this;
    client.on(Events.Error, (error) => logger.error("Discord client error", { error }));
    client.on(Events.Warn, (message) => logger.warn("Discord warning", { message }));
    client.on(Events.ShardDisconnect, (event) => logger.warn("Disconnected from Discord", { code: event.code }));
    client.on(Events.ShardResume, () => logger.info("Reconnected to Discord"));

    const ready = new Promise<void>((resolve) => client.once(Events.ClientReady, () => resolve()));
    try {
      await client.login(config.discord.token);
    } catch (error) {
      throw explainLoginError(error, config);
    }
    await ready;
    logger.info("Logged in to Discord", { user: client.user?.tag, profile: config.profile });

    const applicationId = client.application?.id ?? config.discord.applicationId;
    if (config.discord.applicationId && applicationId !== config.discord.applicationId) {
      throw new StartupError("DISCORD_APPLICATION_ID does not match the bot token.", [
        "The token belongs to a different application. Use the development bot's token and ID together.",
      ]);
    }

    let guild: Guild;
    try {
      guild = await client.guilds.fetch(config.discord.guildId);
    } catch {
      throw new StartupError(`The bot is not a member of guild ${config.discord.guildId}.`, [
        applicationId ? `Invite it with: ${inviteUrl(applicationId, config.discord.guildId)}` : "Invite the bot to the guild first.",
      ]);
    }
    await guild.members.fetchMe();
    this.guild = new DiscordGuildPort(guild);
    logger.info("Using guild", { guild: guild.name, id: guild.id });

    await guild.commands.set(buildCommandDefinitions({ linking: config.linking.enabled }));
    logger.info("Slash commands registered for the guild");

    if (config.autoSetup || options.setupOnly) {
      const report = await this.integration.setup.run(this.guild);
      for (const line of formatSetupReport(report).split("\n")) {
        logger.info(line);
      }
    } else {
      const report = await this.integration.setup.inspect(this.guild);
      if (!report.ok) {
        logger.warn("Channels are not fully configured. Run /pokeverse setup or the setup command.");
      }
    }
    if (options.setupOnly) {
      return;
    }

    client.on(Events.MessageCreate, createMessageHandler(this.integration.chat, logger.child({ component: "chat" })));
    client.on(Events.InteractionCreate, createInteractionHandler(this.integration.commands, logger.child({ component: "commands" })));
    client.on(Events.GuildMemberAdd, (member) => {
      if (member.guild.id === config.discord.guildId && !member.user.bot) {
        this.integration.onMemberJoin(member.id);
      }
    });
    this.integration.start();
    logger.info("PokeVerse Discord bot is running");
  }

  async stop(): Promise<void> {
    await this.integration.stop();
    await this.client.destroy();
  }
}
