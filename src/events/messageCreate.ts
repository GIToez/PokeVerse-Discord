import { MessageType, type Message } from "discord.js";
import type { DiscordChatMessage, DiscordRelayOutcome } from "../services/chat/chatRelay.js";
import type { Logger } from "../utils/logger.js";

export function toChatMessage(message: Message): DiscordChatMessage {
  return {
    id: message.id,
    guildId: message.guildId,
    channelId: message.channelId,
    authorId: message.author.id,
    authorName: message.member?.displayName ?? message.author.displayName ?? message.author.username,
    isBot: message.author.bot,
    isWebhook: message.webhookId !== null,
    isSystem: message.system || (message.type !== MessageType.Default && message.type !== MessageType.Reply),
    content: message.cleanContent,
    attachmentCount: message.attachments.size,
  };
}

const FEEDBACK: Partial<Record<string, string>> = {
  rate_limited_user: "\u23F3",
  rate_limited_global: "\u23F3",
  game_offline: "\u26A0\uFE0F",
};

interface DiscordRelay {
  handleDiscordMessage(message: DiscordChatMessage): Promise<DiscordRelayOutcome>;
}

/** #game-chat and the staff rooms -> game. Feedback reactions are best effort (only with Add Reactions). */
export function createMessageHandler(relays: DiscordRelay[], logger: Logger) {
  return async (message: Message): Promise<void> => {
    try {
      const chat = toChatMessage(message);
      let outcome: DiscordRelayOutcome = "ignored";
      for (const relay of relays) {
        outcome = await relay.handleDiscordMessage(chat);
        if (outcome !== "ignored") {
          break;
        }
      }
      const reaction = FEEDBACK[outcome];
      if (reaction) {
        await message.react(reaction).catch(() => undefined);
      }
    } catch (error) {
      logger.error("Message handler failed", { error });
    }
  };
}
