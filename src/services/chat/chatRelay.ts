import type { BotConfig } from "../../config/load.js";
import type { GameApi } from "../../integrations/pokeverse/gameApi.js";
import { BridgeUnavailableError } from "../../integrations/pokeverse/bridgeClient.js";
import type { ChatEvent, GameEventEnvelope } from "../../integrations/pokeverse/protocol.js";
import type { ChannelDirectory } from "../../bot/ports.js";
import type { DeliveryQueue } from "../../utils/deliveryQueue.js";
import type { Logger } from "../../utils/logger.js";
import type { Metrics } from "../../utils/metrics.js";
import { KeyedRateLimiter, TokenBucket } from "../../utils/rateLimiter.js";
import { discordToGameAuthor, discordToGameText, formatGameChatForDiscord } from "./sanitize.js";

/** A Discord message, reduced to what the relay needs. */
export interface DiscordChatMessage {
  id: string;
  guildId: string | null;
  channelId: string;
  authorId: string;
  /** Display name (server nickname or global name). */
  authorName: string;
  isBot: boolean;
  isWebhook: boolean;
  /** System messages (joins, pins, boosts...). */
  isSystem: boolean;
  /** Message text with mentions already resolved to plain names (discord.js cleanContent). */
  content: string;
  attachmentCount: number;
}

export type DiscordRelayOutcome =
  | "sent"
  | "ignored"
  | "empty"
  | "rate_limited_user"
  | "rate_limited_global"
  | "game_offline"
  | "failed";

export interface ChatRelayOptions {
  config: BotConfig["chat"];
  guildId: string;
  game: GameApi;
  channels: ChannelDirectory;
  queue: DeliveryQueue;
  logger: Logger;
  metrics: Metrics;
  now?: () => number;
}

/**
 * Two-way relay between #game-chat and the game's public chat channel.
 *
 * Loop prevention: messages from bots and webhooks (including this bot's own
 * "[Game] ..." posts) are never sent to the game, and the game does not emit chat
 * events for messages the bridge writes into the channel.
 */
export class ChatRelay {
  private readonly userLimiter: KeyedRateLimiter;
  private readonly globalLimiter: TokenBucket;
  private readonly now: () => number;

  constructor(private readonly options: ChatRelayOptions) {
    this.now = options.now ?? Date.now;
    this.userLimiter = new KeyedRateLimiter(options.config.userMessages, options.config.userIntervalMs, this.now);
    this.globalLimiter = new TokenBucket(options.config.globalMessages, options.config.globalIntervalMs, this.now);
  }

  /** Discord -> game. */
  async handleDiscordMessage(message: DiscordChatMessage): Promise<DiscordRelayOutcome> {
    const { config, metrics } = this.options;
    const chatChannel = this.options.channels.get("gameChat");
    if (
      !config.enabled ||
      !chatChannel ||
      message.channelId !== chatChannel.id ||
      message.guildId !== this.options.guildId ||
      message.isBot ||
      message.isWebhook ||
      message.isSystem
    ) {
      return "ignored";
    }

    let text = discordToGameText(message.content, config.maxLength);
    if (text === "" && message.attachmentCount > 0) {
      text = "[attachment]";
    }
    if (text === "") {
      metrics.increment("chat.discord_empty");
      return "empty";
    }
    if (!this.userLimiter.tryTake(message.authorId)) {
      metrics.increment("chat.discord_rate_limited");
      return "rate_limited_user";
    }
    if (!this.globalLimiter.tryTake()) {
      metrics.increment("chat.discord_rate_limited");
      return "rate_limited_global";
    }
    if (!this.options.game.connected) {
      metrics.increment("chat.discord_game_offline");
      return "game_offline";
    }

    const author = discordToGameAuthor(message.authorName);
    try {
      await this.options.game.sendChat(author, text);
      metrics.increment("chat.discord_to_game");
      this.options.logger.debug("Relayed Discord chat to the game", { messageId: message.id, author });
      return "sent";
    } catch (error) {
      if (error instanceof BridgeUnavailableError) {
        metrics.increment("chat.discord_game_offline");
        return "game_offline";
      }
      metrics.increment("chat.discord_failed");
      this.options.logger.warn("Could not relay Discord chat to the game", { error });
      return "failed";
    }
  }

  /** Game -> Discord. Stale events (queued while the bot was away) are dropped, so history is never replayed. */
  handleGameChat(envelope: GameEventEnvelope<ChatEvent>): void {
    const { config, metrics, logger } = this.options;
    if (!config.enabled) {
      return;
    }
    const ageSeconds = this.now() / 1000 - envelope.time;
    if (ageSeconds > config.maxEventAgeSeconds) {
      metrics.increment("chat.game_stale");
      logger.debug("Dropping stale game chat", { id: envelope.id, ageSeconds: Math.round(ageSeconds) });
      return;
    }
    const content = formatGameChatForDiscord(envelope.event.author, envelope.event.text);
    this.options.queue.enqueue(`chat ${envelope.id}`, async () => {
      const channel = this.options.channels.get("gameChat");
      if (!channel) {
        metrics.increment("chat.game_no_channel");
        return;
      }
      await channel.send({ content, suppressEmbeds: true });
      metrics.increment("chat.game_to_discord");
    });
  }
}
