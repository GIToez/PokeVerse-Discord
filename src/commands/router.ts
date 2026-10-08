import type { BotConfig } from "../config/load.js";
import type { GuildPort, OutgoingMessage } from "../bot/ports.js";
import { BridgeRequestError, BridgeUnavailableError } from "../integrations/pokeverse/bridgeClient.js";
import type { GameApi } from "../integrations/pokeverse/gameApi.js";
import { ANNOUNCEMENT_CATEGORIES, type AnnouncementCategory, type Announcer } from "../services/announcements/announcer.js";
import { COLORS } from "../services/embeds.js";
import type { ArtworkResolver } from "../services/pokemon/artwork.js";
import { lookupPokemon, type PokemonAutocomplete } from "../services/pokemon/pokemonLookup.js";
import type { StatusService } from "../services/status/statusService.js";
import { lookupTrainer } from "../services/trainers/trainerLookup.js";
import { formatSetupReport, type ChannelSetup } from "../setup/channelSetup.js";
import type { Logger } from "../utils/logger.js";
import type { Metrics } from "../utils/metrics.js";
import { KeyedRateLimiter } from "../utils/rateLimiter.js";
import { CATCH_MODES, CHANNEL_PURPOSES, type CatchMode, type ChannelPurpose, type StateStore } from "../utils/stateStore.js";

export interface CommandUser {
  id: string;
  displayName: string;
  roleIds: string[];
  /** Has the Manage Server permission. */
  manageGuild: boolean;
}

export interface CommandInput {
  commandName: string;
  subcommand?: string | undefined;
  options: Record<string, string | undefined>;
  user: CommandUser;
  guildId: string | null;
}

export interface CommandResponse {
  ephemeral: boolean;
  message: OutgoingMessage;
}

export interface CommandRouterOptions {
  config: BotConfig;
  game: GameApi;
  artwork: ArtworkResolver;
  autocomplete: PokemonAutocomplete;
  status: StatusService;
  setup: ChannelSetup;
  announcer: Announcer;
  store: StateStore;
  guild: () => GuildPort | undefined;
  /** Called after catch mode or channel assignments change. */
  onSettingsChanged?: () => void;
  queueSizes: () => Record<string, number>;
  logger: Logger;
  metrics: Metrics;
}

const OFFLINE_TEXT = "The PokeVerse game server is offline right now. Please try again later.";

function reply(text: string, ephemeral = true, color?: number): CommandResponse {
  return color === undefined
    ? { ephemeral, message: { content: text } }
    : { ephemeral, message: { embeds: [{ description: text, color }] } };
}

/**
 * Slash command logic, independent of discord.js. Lookups are read-only bridge
 * requests; nothing here touches the game database directly.
 */
export class CommandRouter {
  private readonly lookupLimiter = new KeyedRateLimiter(5, 10_000);

  constructor(private readonly options: CommandRouterOptions) {}

  isAdmin(user: CommandUser): boolean {
    const { adminUserIds, adminRoleIds } = this.options.config.discord;
    if (adminUserIds.includes(user.id) || user.roleIds.some((role) => adminRoleIds.includes(role))) {
      return true;
    }
    return adminUserIds.length === 0 && adminRoleIds.length === 0 && user.manageGuild;
  }

  async handle(input: CommandInput): Promise<CommandResponse> {
    if (input.guildId !== this.options.config.discord.guildId) {
      return reply("This bot only works in its configured server.");
    }
    this.options.metrics.increment(`commands.${input.commandName}`);
    try {
      switch (input.commandName) {
        case "trainer":
          return await this.trainer(input);
        case "pokemon":
          return await this.pokemon(input);
        case "server":
          return await this.server();
        case "pokeverse":
          return await this.admin(input);
        default:
          return reply("Unknown command.");
      }
    } catch (error) {
      if (error instanceof BridgeUnavailableError) {
        return reply(OFFLINE_TEXT);
      }
      if (error instanceof BridgeRequestError && error.code === "invalid_params") {
        return reply("That name is not valid.");
      }
      this.options.metrics.increment("commands.errors");
      this.options.logger.error("Command failed", { command: input.commandName, error });
      return reply("Something went wrong. The error was logged.");
    }
  }

  async autocomplete(commandName: string, optionName: string, value: string): Promise<Array<{ name: string; value: string }>> {
    if (commandName !== "pokemon" || optionName !== "name") {
      return [];
    }
    try {
      const names = await this.options.autocomplete.suggest(value);
      return names.map((name) => ({ name, value: name }));
    } catch {
      return [];
    }
  }

  private allowLookup(user: CommandUser): boolean {
    if (this.lookupLimiter.tryTake(user.id)) {
      return true;
    }
    this.options.metrics.increment("commands.rate_limited");
    return false;
  }

  private async trainer(input: CommandInput): Promise<CommandResponse> {
    if (!this.allowLookup(input.user)) {
      return reply("You are using lookups too quickly. Please wait a few seconds.");
    }
    if (!this.options.game.connected) {
      return reply(OFFLINE_TEXT);
    }
    const result = await lookupTrainer(this.options.game, input.options.name ?? "");
    switch (result.kind) {
      case "invalid_name":
        return reply("Trainer names contain only letters, spaces, apostrophes and dashes (2-30 characters).");
      case "not_found":
        return reply(`No trainer named "${result.name}" was found.`, true, COLORS.neutral);
      case "found":
        return { ephemeral: false, message: result.message };
    }
  }

  private async pokemon(input: CommandInput): Promise<CommandResponse> {
    if (!this.allowLookup(input.user)) {
      return reply("You are using lookups too quickly. Please wait a few seconds.");
    }
    if (!this.options.game.connected) {
      return reply(OFFLINE_TEXT);
    }
    const result = await lookupPokemon(this.options.game, this.options.artwork, input.options.name ?? "");
    switch (result.kind) {
      case "invalid_name":
        return reply("Please enter a valid Pokemon name.");
      case "not_found": {
        const hint = result.suggestions.length > 0 ? ` Did you mean: ${result.suggestions.join(", ")}?` : "";
        return reply(`No Pokemon named "${result.name}" exists in PokeVerse.${hint}`, true, COLORS.neutral);
      }
      case "found":
        return { ephemeral: false, message: result.message };
    }
  }

  private async server(): Promise<CommandResponse> {
    await this.options.status.refresh();
    return { ephemeral: false, message: { embeds: [this.options.status.embed()] } };
  }

  private async admin(input: CommandInput): Promise<CommandResponse> {
    if (!this.isAdmin(input.user)) {
      this.options.logger.warn("Admin command denied", { user: input.user.id, subcommand: input.subcommand });
      return reply("You are not allowed to use this command.");
    }
    const guild = this.options.guild();
    switch (input.subcommand) {
      case "setup": {
        if (!guild) {
          return reply("The server is not available yet. Try again in a moment.");
        }
        const report = await this.options.setup.run(guild);
        this.options.onSettingsChanged?.();
        return reply(formatSetupReport(report), true, report.ok ? COLORS.success : COLORS.warning);
      }
      case "status":
        return this.diagnostics(guild);
      case "channel": {
        const purpose = input.options.purpose;
        const channelId = input.options.channel;
        if (!guild || !purpose || !channelId || !(CHANNEL_PURPOSES as readonly string[]).includes(purpose)) {
          return reply("Choose a feature and a text channel.");
        }
        const result = await this.options.setup.assign(guild, purpose as ChannelPurpose, channelId);
        if (result.action === "failed") {
          return reply(result.error ?? "That channel cannot be used.");
        }
        this.options.onSettingsChanged?.();
        const missing = result.missingPermissions.length > 0
          ? ` The bot is missing these permissions there: ${result.missingPermissions.join(", ")}.`
          : "";
        return reply(`${purpose} now uses <#${channelId}>.${missing}`, true, missing ? COLORS.warning : COLORS.success);
      }
      case "catches": {
        const mode = input.options.mode;
        if (!mode || !(CATCH_MODES as readonly string[]).includes(mode)) {
          return reply("Unknown catch mode.");
        }
        this.options.store.update((state) => {
          state.catchMode = mode as CatchMode;
        });
        this.options.onSettingsChanged?.();
        this.options.logger.info("Catch announcement mode changed", { mode, by: input.user.id });
        return reply(`Catch announcements: ${mode}.`, true, COLORS.success);
      }
      case "announce": {
        const category = input.options.category;
        const text = input.options.text?.trim();
        if (!category || !(ANNOUNCEMENT_CATEGORIES as readonly string[]).includes(category) || !text) {
          return reply("Choose a category and enter the announcement text.");
        }
        await this.options.announcer.announce(category as AnnouncementCategory, input.options.title?.trim() || undefined, text, input.user.displayName);
        this.options.logger.info("Manual announcement posted", { category, by: input.user.id });
        return reply("Announcement posted.", true, COLORS.success);
      }
      default:
        return reply("Unknown subcommand.");
    }
  }

  private async diagnostics(guild: GuildPort | undefined): Promise<CommandResponse> {
    const { config, store, game } = this.options;
    const state = store.get();
    const lines = [
      `Profile: **${config.profile}**`,
      `Game bridge: **${game.connected ? "connected" : "disconnected"}** (${config.bridge.host}:${config.bridge.port})`,
      `Catch announcements: **${state.catchMode ?? config.catches.mode}**`,
      `Chat relay: **${config.chat.enabled ? "on" : "off"}**`,
      `Spawn alerts: shiny **${config.spawns.shinyEnabled ? "on" : "off"}**, legendary **${config.spawns.legendaryEnabled ? "on" : "off"}**, location **${config.spawns.locationMode}**`,
      `Delivery queues: ${Object.entries(this.options.queueSizes()).map(([name, size]) => `${name} ${size}`).join(", ")}`,
    ];
    if (guild) {
      const report = await this.options.setup.inspect(guild);
      lines.push("", formatSetupReport(report));
    }
    const metrics = this.options.metrics.snapshot();
    const interesting = Object.entries(metrics)
      .filter(([name]) => /announced|to_game|to_discord|dropped|failed|rate_limited|disconnects|restarts/.test(name))
      .map(([name, value]) => `${name}=${value}`);
    if (interesting.length > 0) {
      lines.push("", `Counters: ${interesting.join(", ")}`);
    }
    return reply(lines.join("\n").slice(0, 4000), true, COLORS.info);
  }
}
