import { describe, expect, it } from "vitest";
import { ChatRelay, type DiscordChatMessage } from "../../src/services/chat/chatRelay.js";
import { DeliveryQueue } from "../../src/utils/deliveryQueue.js";
import { silentLogger } from "../../src/utils/logger.js";
import { Metrics } from "../../src/utils/metrics.js";
import { DEV_GUILD, FakeChannels, FakeGame, envelope, makeConfig } from "../helpers/fakes.js";

function setup(overrides: Record<string, string> = {}) {
  const config = makeConfig(overrides);
  const channels = new FakeChannels();
  const game = new FakeGame();
  const metrics = new Metrics();
  let now = 1_700_000_000_000;
  const queue = new DeliveryQueue({ name: "chat", maxSize: 50, maxAttempts: 2, retryDelayMs: 1, logger: silentLogger, metrics, sleep: async () => {} });
  const relay = new ChatRelay({ config: config.chat, guildId: DEV_GUILD, game, channels, queue, logger: silentLogger, metrics, now: () => now });
  const chatChannel = channels.channel("gameChat");
  let id = 0;
  const message = (patch: Partial<DiscordChatMessage> = {}): DiscordChatMessage => ({
    id: String(++id),
    guildId: DEV_GUILD,
    channelId: chatChannel.id,
    authorId: "500000000000000001",
    authorName: "Jim",
    isBot: false,
    isWebhook: false,
    isSystem: false,
    content: "hello game",
    attachmentCount: 0,
    ...patch,
  });
  return { relay, game, channels, chatChannel, queue, metrics, message, advance: (ms: number) => (now += ms), nowSeconds: () => Math.floor(now / 1000) };
}

describe("chat relay: Discord -> game", () => {
  it("sends the cleaned text with the Discord display name", async () => {
    const { relay, game, message } = setup();
    expect(await relay.handleDiscordMessage(message({ content: "**hi** there https://x.y" }))).toBe("sent");
    // The game shows it as "[Discord] Jim: hi there [link]" (prefix added by the game).
    expect(game.chats).toEqual([{ author: "Jim", text: "hi there [link]" }]);
  });

  it("ignores bots (including itself), webhooks, system messages, other channels and other guilds", async () => {
    const { relay, game, message } = setup();
    for (const patch of [
      { isBot: true },
      { isWebhook: true },
      { isSystem: true },
      { channelId: "999999999999999999" },
      { guildId: "888888888888888888" },
      { guildId: null },
    ]) {
      expect(await relay.handleDiscordMessage(message(patch))).toBe("ignored");
    }
    expect(game.chats).toEqual([]);
  });

  it("does not loop: its own [Game] posts are bot messages and are ignored", async () => {
    const { relay, game, chatChannel, queue, message, nowSeconds } = setup();
    relay.handleGameChat(envelope({ kind: "chat", channelId: 7, author: "RedTrainer", text: "hey" }, { time: nowSeconds() }));
    await queue.idle();
    const posted = chatChannel.contents()[0]!;
    expect(posted).toBe("[Game] RedTrainer: hey");
    expect(await relay.handleDiscordMessage(message({ content: posted, isBot: true }))).toBe("ignored");
    expect(game.chats).toHaveLength(0);
  });

  it("enforces the length limit", async () => {
    const { relay, game, message } = setup({ CHAT_MAX_LENGTH: "20" });
    await relay.handleDiscordMessage(message({ content: "a".repeat(100) }));
    expect(game.chats[0]!.text).toHaveLength(20);
  });

  it("rate limits per user and globally", async () => {
    const { relay, message, advance, metrics } = setup({
      CHAT_USER_MESSAGES: "2",
      CHAT_USER_INTERVAL_SECONDS: "10",
      CHAT_GLOBAL_MESSAGES: "3",
      CHAT_GLOBAL_INTERVAL_SECONDS: "10",
    });
    expect(await relay.handleDiscordMessage(message())).toBe("sent");
    expect(await relay.handleDiscordMessage(message())).toBe("sent");
    expect(await relay.handleDiscordMessage(message())).toBe("rate_limited_user");
    expect(await relay.handleDiscordMessage(message({ authorId: "500000000000000002" }))).toBe("sent");
    expect(await relay.handleDiscordMessage(message({ authorId: "500000000000000003" }))).toBe("rate_limited_global");
    advance(10_000);
    expect(await relay.handleDiscordMessage(message())).toBe("sent");
    expect(metrics.get("chat.discord_rate_limited")).toBe(2);
  });

  it("handles empty messages, attachments and an offline game", async () => {
    const { relay, game, message } = setup();
    expect(await relay.handleDiscordMessage(message({ content: "\u{1F600}" }))).toBe("empty");
    expect(await relay.handleDiscordMessage(message({ content: "", attachmentCount: 1 }))).toBe("sent");
    expect(game.chats.at(-1)!.text).toBe("[attachment]");
    game.connected = false;
    expect(await relay.handleDiscordMessage(message())).toBe("game_offline");
  });

  it("can be disabled", async () => {
    const { relay, message } = setup({ CHAT_ENABLED: "false" });
    expect(await relay.handleDiscordMessage(message())).toBe("ignored");
  });
});

describe("chat relay: game -> Discord", () => {
  it('posts "[Game] Author: text" without pings or link previews', async () => {
    const { relay, chatChannel, queue, nowSeconds } = setup();
    relay.handleGameChat(envelope({ kind: "chat", channelId: 7, author: "RedTrainer", text: "@everyone look <@&123456789012345678>" }, { time: nowSeconds() }));
    await queue.idle();
    const sent = chatChannel.sent[0]!.message;
    expect(sent.content).toMatch(/^\[Game\] RedTrainer: @\u200beveryone look/);
    expect(sent.content).not.toContain("<@&1");
    expect(sent.suppressEmbeds).toBe(true);
  });

  it("does not replay history: stale events are dropped", async () => {
    const { relay, chatChannel, queue, nowSeconds, metrics } = setup();
    relay.handleGameChat(envelope({ kind: "chat", channelId: 7, author: "Old", text: "from before" }, { time: nowSeconds() - 120 }));
    await queue.idle();
    expect(chatChannel.sent).toHaveLength(0);
    expect(metrics.get("chat.game_stale")).toBe(1);
  });

  it("does not crash when the channel is missing", async () => {
    const config = makeConfig();
    const metrics = new Metrics();
    const queue = new DeliveryQueue({ name: "chat", maxSize: 5, maxAttempts: 1, retryDelayMs: 1, logger: silentLogger, metrics });
    const relay = new ChatRelay({ config: config.chat, guildId: DEV_GUILD, game: new FakeGame(), channels: new FakeChannels([]), queue, logger: silentLogger, metrics });
    relay.handleGameChat(envelope({ kind: "chat", channelId: 7, author: "A", text: "b" }));
    await queue.idle();
    expect(metrics.get("chat.game_no_channel")).toBe(1);
  });
});
