import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { StaffChatApi } from "../../src/integrations/pokeverse/gameApi.js";
import { FEATURES, gameEventSchema, type StaffRoom } from "../../src/integrations/pokeverse/protocol.js";
import type { PrivacyCheck } from "../../src/services/activity/privacy.js";
import type { DiscordChatMessage } from "../../src/services/chat/chatRelay.js";
import { StaffChatRelay } from "../../src/services/chat/staffChatRelay.js";
import { ChannelSetup, formatSetupReport } from "../../src/setup/channelSetup.js";
import { STAFF_CATEGORY_NAME } from "../../src/setup/channels.js";
import { DeliveryQueue } from "../../src/utils/deliveryQueue.js";
import { silentLogger } from "../../src/utils/logger.js";
import { Metrics } from "../../src/utils/metrics.js";
import { StateStore, type ChannelPurpose } from "../../src/utils/stateStore.js";
import { BOT_USER, DEV_GUILD, EVERYONE, FakeChannels, FakeGuild, envelope, makeConfig, tempDir } from "../helpers/fakes.js";

const STAFF = [
  { key: "staff:2" as const, name: "Tutor" },
  { key: "staff:3" as const, name: "Senior Tutor" },
  { key: "staff:4" as const, name: "Gamemaster" },
  { key: "staff:5" as const, name: "Community Manager" },
  { key: "staff:6" as const, name: "God" },
];

function rooms(options: { staffRooms?: boolean; roles?: typeof STAFF } = {}) {
  const file = join(tempDir(), "state.json");
  const store = new StateStore(file, "development");
  const channelSetup = new ChannelSetup(store, silentLogger, {
    linking: { enabled: true, roles: [{ key: "verified", name: "Verified Trainer" }, ...(options.roles ?? STAFF)] },
    staffRooms: options.staffRooms ?? true,
  });
  const guild = new FakeGuild();
  guild.permissions = [...guild.permissions, "ManageRoles", "ManageNicknames"];
  return { file, store, channelSetup, guild };
}

const roleId = (guild: FakeGuild, name: string) => guild.roles.find((role) => role.name === name)!.id;

describe("staff rooms", () => {
  it("creates a private category with #tutor-room (Tutor and up) and #gm-room (Gamemaster and up)", async () => {
    const { channelSetup, guild, store } = rooms();
    const report = await channelSetup.run(guild);
    expect(report.ok).toBe(true);
    expect(report.staffCategoryAction).toBe("created");
    const category = guild.created.find((channel) => channel.name === STAFF_CATEGORY_NAME)!;
    expect(category.overwrites).toEqual([
      { id: EVERYONE, type: "role", allow: [], deny: ["ViewChannel"] },
      { id: BOT_USER, type: "member", allow: ["ViewChannel", "SendMessages", "EmbedLinks", "ReadMessageHistory"], deny: [] },
    ]);
    const tutor = guild.created.find((channel) => channel.name === "tutor-room")!;
    const gm = guild.created.find((channel) => channel.name === "gm-room")!;
    expect(tutor.parentId).toBe(category.id);
    expect(gm.parentId).toBe(category.id);
    const allowed = (channel: typeof tutor) =>
      channel.overwrites.filter((item) => item.type === "role" && item.allow.includes("ViewChannel")).map((item) => guild.roles.find((role) => role.id === item.id)?.name);
    expect(allowed(tutor)).toEqual(["Tutor", "Senior Tutor", "Gamemaster", "Community Manager", "God"]);
    expect(allowed(gm)).toEqual(["Gamemaster", "Community Manager", "God"]);
    expect(gm.overwrites[0]).toEqual({ id: EVERYONE, type: "role", allow: [], deny: ["ViewChannel"] });
    expect(store.getChannelId("staffTutors")).toBe(tutor.id);
    expect(store.get().staffCategoryId).toBe(category.id);

    const text = formatSetupReport(report);
    expect(text).toContain(`Private category "${STAFF_CATEGORY_NAME}": created`);
    expect(text).toContain("(private: Gamemaster, Community Manager, God)");
  });

  it("reports a Tutor who can see #gm-room, and opens a room to a staff role that was locked out", async () => {
    const first = rooms();
    await first.channelSetup.run(first.guild);
    const gm = first.guild.channels.find((channel) => channel.name === "gm-room")!;
    gm.overwrites.push({ id: roleId(first.guild, "Tutor"), type: "role", allow: ["ViewChannel"], deny: [] });
    gm.overwrites = gm.overwrites.filter((item) => item.id !== roleId(first.guild, "God"));

    const report = await first.channelSetup.run(first.guild);
    const room = report.channels.find((channel) => channel.purpose === "staffGamemasters")!;
    expect(room.updated).toEqual(["opened to God"]);
    expect(room.privacyProblems).toEqual(['role "Tutor" can see the channel but is not an authorized viewer']);
    expect(report.ok).toBe(false);
    expect(formatSetupReport(report)).toContain("NOT PRIVATE");
    expect(first.guild.channelUpdates).toContain(`allow role ${roleId(first.guild, "God")} ${gm.id} ViewChannel,SendMessages,ReadMessageHistory,EmbedLinks,AttachFiles,AddReactions,CreatePublicThreads,SendMessagesInThreads`);
  });

  it("only sets up the rooms with staff roles and the switch on", async () => {
    for (const options of [{ staffRooms: false }, { roles: [] }]) {
      const { channelSetup, guild } = rooms(options);
      const report = await channelSetup.run(guild);
      expect(report.channels.some((channel) => channel.purpose.startsWith("staff"))).toBe(false);
      expect(guild.created.some((channel) => channel.name === STAFF_CATEGORY_NAME)).toBe(false);
    }
  });
});

class FakeStaffChatApi implements StaffChatApi {
  connected = true;
  features = new Set<string>([FEATURES.staffChat]);
  readonly sent: Array<{ room: StaffRoom; author: string; text: string }> = [];
  hasFeature(feature: string): boolean {
    return this.features.has(feature);
  }
  async send(room: StaffRoom, author: string, text: string): Promise<{ delivered: number; text: string }> {
    this.sent.push({ room, author, text });
    return { delivered: 1, text };
  }
}

function relay() {
  const config = makeConfig();
  const channels = new FakeChannels(["gameChat", "staffTutors", "staffGamemasters"]);
  const metrics = new Metrics();
  const api = new FakeStaffChatApi();
  const privacy = new Map<ChannelPurpose, PrivacyCheck>();
  const queue = new DeliveryQueue({ name: "chat", maxSize: 10, maxAttempts: 1, retryDelayMs: 1, logger: silentLogger, metrics });
  const staffChat = new StaffChatRelay({
    enabled: true,
    config: config.chat,
    guildId: DEV_GUILD,
    api,
    channels,
    privacy: (purpose) => privacy.get(purpose) ?? { private: true, problems: [], administratorRoles: [] },
    queue,
    logger: silentLogger,
    metrics,
  });
  return { staffChat, api, channels, privacy, queue, metrics };
}

function message(channelId: string, overrides: Partial<DiscordChatMessage> = {}): DiscordChatMessage {
  return {
    id: "1", guildId: DEV_GUILD, channelId, authorId: "700000000000000001", authorName: "GM Oak",
    isBot: false, isWebhook: false, isSystem: false, content: "Raid at 8?", attachmentCount: 0, ...overrides,
  };
}

const LEAKY: PrivacyCheck = { private: false, problems: ["@everyone can see the channel"], administratorRoles: [] };

describe("staff chat", () => {
  it("parses the game's staff_chat event", () => {
    expect(gameEventSchema.parse({ kind: "staff_chat", scope: "admin", room: "gamemasters", channelId: 2, author: "GM Oak", text: "hi" }))
      .toMatchObject({ kind: "staff_chat", room: "gamemasters" });
    expect(() => gameEventSchema.parse({ kind: "staff_chat", scope: "admin", room: "everyone", author: "x", text: "y" })).toThrow();
  });

  it("posts Counselor lines in #tutor-room and Staff lines in #gm-room, never in #game-chat", async () => {
    const { staffChat, channels, queue } = relay();
    staffChat.handleGameChat(envelope({ kind: "staff_chat", scope: "admin", room: "tutors", channelId: 4, author: "Tutor Amy", text: "Anyone free?" }));
    staffChat.handleGameChat(envelope({ kind: "staff_chat", scope: "admin", room: "gamemasters", channelId: 2, author: "GM Oak", text: "Ban appeal" }));
    await queue.idle();
    expect(channels.channel("staffTutors").contents()).toEqual([expect.stringContaining("Tutor Amy")]);
    expect(channels.channel("staffTutors").contents()[0]).toContain("Anyone free?");
    expect(channels.channel("staffGamemasters").contents()[0]).toContain("Ban appeal");
    expect(channels.channel("gameChat").sent).toHaveLength(0);
  });

  it("sends each room to its in-game channel", async () => {
    const { staffChat, api, channels } = relay();
    expect(await staffChat.handleDiscordMessage(message(channels.channel("staffTutors").id))).toBe("sent");
    expect(await staffChat.handleDiscordMessage(message(channels.channel("staffGamemasters").id, { content: "On it" }))).toBe("sent");
    expect(api.sent).toEqual([{ room: "tutors", author: "GM Oak", text: "Raid at 8?" }, { room: "gamemasters", author: "GM Oak", text: "On it" }]);
    expect(await staffChat.handleDiscordMessage(message(channels.channel("gameChat").id))).toBe("ignored");
    expect(await staffChat.handleDiscordMessage(message(channels.channel("staffTutors").id, { isBot: true }))).toBe("ignored");
  });

  it("pauses both ways while a room isn't private", async () => {
    const { staffChat, api, channels, privacy, queue, metrics } = relay();
    privacy.set("staffGamemasters", LEAKY);
    expect(await staffChat.handleDiscordMessage(message(channels.channel("staffGamemasters").id))).toBe("failed");
    staffChat.handleGameChat(envelope({ kind: "staff_chat", scope: "admin", room: "gamemasters", author: "GM Oak", text: "secret" }));
    await queue.idle();
    expect(api.sent).toHaveLength(0);
    expect(channels.channel("staffGamemasters").sent).toHaveLength(0);
    expect(metrics.get("staff_chat.not_private")).toBe(2);
  });

  it("does nothing with a game that has no staff chat", async () => {
    const { staffChat, api, channels, queue } = relay();
    api.features.clear();
    expect(await staffChat.handleDiscordMessage(message(channels.channel("staffTutors").id))).toBe("game_offline");
    staffChat.handleGameChat(envelope({ kind: "staff_chat", scope: "admin", room: "tutors", author: "x", text: "y" }));
    await queue.idle();
    expect(api.sent).toHaveLength(0);
    expect(channels.channel("staffTutors").sent).toHaveLength(0);
  });
});
