import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ChannelSetup, formatSetupReport } from "../../src/setup/channelSetup.js";
import { CATEGORY_NAME, CHANNEL_DEFINITIONS } from "../../src/setup/channels.js";
import { inviteUrl, requiredPermissionBits } from "../../src/setup/invite.js";
import { silentLogger } from "../../src/utils/logger.js";
import { StateStore } from "../../src/utils/stateStore.js";
import { BOT_USER, DEV_GUILD, EVERYONE, FakeGuild, tempDir } from "../helpers/fakes.js";

const EXPECTED_NAMES = ["game-chat", "pokemon-catches", "shiny-spawns", "legendary-spawns", "game-announcements", "server-status", "bot-commands"];

function setup(file = join(tempDir(), "state.json")) {
  const store = new StateStore(file, "development");
  return { file, store, setup: new ChannelSetup(store, silentLogger) };
}

describe("channel setup", () => {
  it("creates the category and all channels in an empty guild", async () => {
    const guild = new FakeGuild();
    const { setup: channelSetup, store } = setup();
    const report = await channelSetup.run(guild);
    expect(report.ok).toBe(true);
    expect(report.categoryAction).toBe("created");
    const category = guild.created[0]!;
    expect(category).toMatchObject({ name: CATEGORY_NAME, kind: "category" });
    const texts = guild.created.filter((channel) => channel.kind === "text");
    expect(texts.map((channel) => channel.name)).toEqual(EXPECTED_NAMES);
    expect(texts.every((channel) => channel.parentId === category.id)).toBe(true);
    for (const definition of CHANNEL_DEFINITIONS.filter((item) => item.group === "main")) {
      expect(store.getChannelId(definition.purpose)).toBeDefined();
    }
    expect(store.get().guildId).toBe(DEV_GUILD);
  });

  it("uses least-privilege overwrites: read-only feeds, writable chat", async () => {
    const guild = new FakeGuild();
    await setup().setup.run(guild);
    const byName = new Map(guild.created.map((channel) => [channel.name, channel]));
    const catches = byName.get("pokemon-catches")!;
    expect(catches.overwrites).toContainEqual({ id: EVERYONE, type: "role", allow: [], deny: ["SendMessages"] });
    expect(catches.overwrites).toContainEqual(expect.objectContaining({ id: BOT_USER, type: "member", deny: [] }));
    const chat = byName.get("game-chat")!;
    expect(chat.overwrites.some((overwrite) => overwrite.id === EVERYONE)).toBe(false);
    const all = guild.created.flatMap((channel) => channel.overwrites.flatMap((overwrite) => [...overwrite.allow, ...overwrite.deny]));
    expect(all).not.toContain("Administrator");
  });

  it("is idempotent: a second run creates nothing", async () => {
    const guild = new FakeGuild();
    const { file } = setup();
    await new ChannelSetup(new StateStore(file, "development"), silentLogger).run(guild);
    const count = guild.channels.length;
    // A fresh process with the persisted state.
    const report = await new ChannelSetup(new StateStore(file, "development"), silentLogger).run(guild);
    expect(guild.channels).toHaveLength(count);
    expect(report.categoryAction).toBe("kept");
    expect(report.channels.every((channel) => channel.action === "kept")).toBe(true);
  });

  it("adopts existing channels by name instead of creating duplicates (lost state file)", async () => {
    const guild = new FakeGuild();
    const category = guild.add({ id: "500000000000000001", name: "pokeverse integration", kind: "category", parentId: null });
    guild.add({ id: "500000000000000002", name: "game-chat", kind: "text", parentId: category.id });
    guild.add({ id: "500000000000000003", name: "server-status", kind: "text", parentId: category.id });
    // Same name outside the category is not ours and is left alone.
    guild.add({ id: "500000000000000004", name: "bot-commands", kind: "text", parentId: null });
    const { setup: channelSetup, store } = setup();
    const report = await channelSetup.run(guild);
    expect(report.categoryAction).toBe("adopted");
    expect(store.getChannelId("gameChat")).toBe("500000000000000002");
    expect(store.getChannelId("serverStatus")).toBe("500000000000000003");
    expect(store.getChannelId("botCommands")).not.toBe("500000000000000004");
    expect(guild.created.map((channel) => channel.name)).toEqual(["pokemon-catches", "shiny-spawns", "legendary-spawns", "game-announcements", "bot-commands"]);
  });

  it("preserves admin changes: renamed or moved channels stay assigned", async () => {
    const guild = new FakeGuild();
    const { setup: channelSetup, store } = setup();
    await channelSetup.run(guild);
    const chatId = store.getChannelId("gameChat")!;
    const chat = guild.channels.find((channel) => channel.id === chatId)!;
    chat.name = "talk-to-the-game";
    chat.parentId = null;
    const report = await channelSetup.run(guild);
    expect(store.getChannelId("gameChat")).toBe(chatId);
    expect(report.channels.find((channel) => channel.purpose === "gameChat")!.action).toBe("kept");
    expect(guild.channels.filter((channel) => channel.name === "game-chat")).toHaveLength(0);
  });

  it("recreates only a channel that an admin deleted", async () => {
    const guild = new FakeGuild();
    const { setup: channelSetup, store } = setup();
    await channelSetup.run(guild);
    const deletedId = store.getChannelId("shinySpawns")!;
    guild.channels.splice(guild.channels.findIndex((channel) => channel.id === deletedId), 1);
    const before = guild.created.length;
    const report = await channelSetup.run(guild);
    expect(guild.created.length - before).toBe(1);
    expect(guild.created.at(-1)!.name).toBe("shiny-spawns");
    expect(report.channels.find((channel) => channel.purpose === "shinySpawns")!.action).toBe("created");
  });

  it("reports missing Manage Channels and per-channel permissions without failing", async () => {
    const guild = new FakeGuild();
    guild.permissions = ["ViewChannel", "SendMessages", "EmbedLinks", "ReadMessageHistory"];
    const report = await setup().setup.run(guild);
    expect(report.ok).toBe(false);
    expect(report.missingGuildPermissions).toEqual(["AttachFiles", "ManageChannels"]);
    expect(report.channels.every((channel) => channel.action === "failed")).toBe(true);
    expect(guild.created).toHaveLength(0);
    expect(formatSetupReport(report)).toContain("Missing server permissions: AttachFiles, ManageChannels");

    const partial = new FakeGuild();
    const { setup: channelSetup, store } = setup();
    await channelSetup.run(partial);
    partial.channelPermissions.set(store.getChannelId("catches")!, ["ViewChannel"]);
    const inspect = await channelSetup.inspect(partial);
    expect(inspect.ok).toBe(false);
    expect(inspect.channels.find((channel) => channel.purpose === "catches")!.missingPermissions).toEqual([
      "SendMessages",
      "EmbedLinks",
      "ReadMessageHistory",
      "AttachFiles",
    ]);
  });

  it("survives creation errors and never runs twice concurrently", async () => {
    const guild = new FakeGuild();
    guild.failCreate = true;
    const report = await setup().setup.run(guild);
    expect(report.categoryAction).toBe("failed");

    const ok = new FakeGuild();
    const { setup: channelSetup } = setup();
    const [a, b] = await Promise.all([channelSetup.run(ok), channelSetup.run(ok)]);
    expect(a).toBe(b);
    expect(ok.created).toHaveLength(8);
  });

  it("refuses a state file from another guild", async () => {
    const { setup: channelSetup, store } = setup();
    store.update((state) => {
      state.guildId = "100000000000000777";
    });
    await expect(channelSetup.run(new FakeGuild())).rejects.toThrow(/belongs to guild/);
  });

  it("reassigns a feature to an existing text channel", async () => {
    const guild = new FakeGuild();
    const { setup: channelSetup, store } = setup();
    await channelSetup.run(guild);
    store.update((state) => {
      state.statusMessageId = "old";
    });
    guild.add({ id: "600000000000000001", name: "status", kind: "text", parentId: null });
    guild.add({ id: "600000000000000002", name: "voice", kind: "other", parentId: null });
    expect((await channelSetup.assign(guild, "serverStatus", "600000000000000001")).action).toBe("kept");
    expect(store.getChannelId("serverStatus")).toBe("600000000000000001");
    expect(store.get().statusMessageId).toBeUndefined();
    expect((await channelSetup.assign(guild, "serverStatus", "600000000000000002")).action).toBe("failed");
    expect((await channelSetup.assign(guild, "serverStatus", "699999999999999999")).action).toBe("failed");
  });
});

describe("invite link", () => {
  it("requests only the needed permissions and never Administrator", () => {
    const bits = requiredPermissionBits();
    expect(bits & 0x8n).toBe(0n);
    // View Channel, Send Messages, Embed Links, Attach Files, Read Message History, Manage Channels,
    // Manage Roles, Manage Nicknames
    expect(bits).toBe(0x400n | 0x800n | 0x4000n | 0x8000n | 0x10000n | 0x10n | 0x10000000n | 0x8000000n);
    const url = new URL(inviteUrl("123456789012345678", DEV_GUILD));
    expect(url.searchParams.get("scope")).toBe("bot applications.commands");
    expect(url.searchParams.get("permissions")).toBe(bits.toString());
    expect(url.searchParams.get("guild_id")).toBe(DEV_GUILD);
  });
});
