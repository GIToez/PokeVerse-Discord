import type { ChannelDirectory } from "../../bot/ports.js";
import type { BotConfig } from "../../config/load.js";
import { BridgeUnavailableError } from "../../integrations/pokeverse/bridgeClient.js";
import type { StaffChatApi } from "../../integrations/pokeverse/gameApi.js";
import { FEATURES, type GameEventEnvelope, type StaffChatEvent, type StaffRoom } from "../../integrations/pokeverse/protocol.js";
import type { DeliveryQueue } from "../../utils/deliveryQueue.js";
import type { Logger } from "../../utils/logger.js";
import type { Metrics } from "../../utils/metrics.js";
import { KeyedRateLimiter } from "../../utils/rateLimiter.js";
import type { ChannelPurpose } from "../../utils/stateStore.js";
import type { PrivacyCheck } from "../activity/privacy.js";
import type { DiscordChatMessage, DiscordRelayOutcome } from "./chatRelay.js";
import { discordToGameAuthor, discordToGameText, formatGameChatForDiscord } from "./sanitize.js";

/** In-game Counselor (Tutor and up) and Staff (Gamemaster and up) channel -> Discord staff room. */
export const STAFF_ROOM_CHANNELS: Record<StaffRoom, ChannelPurpose> = {
  tutors: "staffTutors",
  gamemasters: "staffGamemasters",
};

export interface StaffChatRelayOptions {
  enabled: boolean;
  config: BotConfig["chat"];
  guildId: string;
  api: StaffChatApi;
  channels: ChannelDirectory;
  /** Whether only the room's staff roles (and the bot admins) can see the channel; undefined when unknown. */
  privacy: (purpose: ChannelPurpose, channelId: string) => PrivacyCheck | undefined;
  queue: DeliveryQueue;
  logger: Logger;
  metrics: Metrics;
  now?: () => number;
}

/**
 * Two-way relay between the staff rooms and the in-game staff channels. Nothing goes either way
 * while a room can be seen by anyone outside its staff roles, so staff talk never leaks and
 * non-staff can never write into a staff channel.
 */
export class StaffChatRelay {
  private readonly userLimiter: KeyedRateLimiter;
  private readonly now: () => number;

  constructor(private readonly options: StaffChatRelayOptions) {
    this.now = options.now ?? Date.now;
    this.userLimiter = new KeyedRateLimiter(options.config.userMessages, options.config.userIntervalMs, this.now);
  }

  private get available(): boolean {
    return this.options.enabled && this.options.api.hasFeature(FEATURES.staffChat);
  }

  private isPrivate(purpose: ChannelPurpose, channelId: string): boolean {
    const check = this.options.privacy(purpose, channelId);
    if (check?.private) {
      return true;
    }
    this.options.metrics.increment("staff_chat.not_private");
    this.options.logger.warn("A staff room is not private; staff chat is paused until it is fixed (run /pokeverse setup)", {
      channel: purpose,
      problems: check?.problems ?? ["the channel was not found"],
    });
    return false;
  }

  /** Discord -> game. */
  async handleDiscordMessage(message: DiscordChatMessage): Promise<DiscordRelayOutcome> {
    const { metrics, config } = this.options;
    const room = (Object.keys(STAFF_ROOM_CHANNELS) as StaffRoom[])
      .find((key) => this.options.channels.get(STAFF_ROOM_CHANNELS[key])?.id === message.channelId);
    if (!room || !this.options.enabled || message.guildId !== this.options.guildId || message.isBot || message.isWebhook || message.isSystem) {
      return "ignored";
    }
    let text = discordToGameText(message.content, config.maxLength);
    if (text === "" && message.attachmentCount > 0) {
      text = "[attachment]";
    }
    if (text === "") {
      return "empty";
    }
    if (!this.isPrivate(STAFF_ROOM_CHANNELS[room], message.channelId)) {
      return "failed";
    }
    if (!this.userLimiter.tryTake(message.authorId)) {
      metrics.increment("staff_chat.discord_rate_limited");
      return "rate_limited_user";
    }
    if (!this.options.api.connected || !this.options.api.hasFeature(FEATURES.staffChat)) {
      metrics.increment("staff_chat.discord_game_offline");
      return "game_offline";
    }
    const author = discordToGameAuthor(message.authorName);
    try {
      await this.options.api.send(room, author, text);
      metrics.increment(`staff_chat.discord_to_game.${room}`);
      return "sent";
    } catch (error) {
      if (error instanceof BridgeUnavailableError) {
        metrics.increment("staff_chat.discord_game_offline");
        return "game_offline";
      }
      metrics.increment("staff_chat.discord_failed");
      this.options.logger.warn("Could not relay a staff room message to the game", { room, error });
      return "failed";
    }
  }

  /** Game -> Discord. Stale lines (queued while the bot was away) are dropped. */
  handleGameChat(envelope: GameEventEnvelope<StaffChatEvent>): void {
    const { metrics, config } = this.options;
    if (!this.available) {
      return;
    }
    if (this.now() / 1000 - envelope.time > config.maxEventAgeSeconds) {
      metrics.increment("staff_chat.game_stale");
      return;
    }
    const purpose = STAFF_ROOM_CHANNELS[envelope.event.room];
    const content = formatGameChatForDiscord(envelope.event.author, envelope.event.text);
    this.options.queue.enqueue(`staff chat ${envelope.id}`, async () => {
      const channel = this.options.channels.get(purpose);
      if (!channel) {
        metrics.increment("staff_chat.no_channel");
        return;
      }
      if (!this.isPrivate(purpose, channel.id)) {
        return;
      }
      await channel.send({ content, suppressEmbeds: true });
      metrics.increment(`staff_chat.game_to_discord.${envelope.event.room}`);
    });
  }
}
