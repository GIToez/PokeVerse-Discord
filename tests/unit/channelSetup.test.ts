import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ChannelSetup, formatSetupReport } from "../../src/setup/channelSetup.js";
import { ADMIN_CATEGORY_NAME, CATEGORY_NAME, CHANNEL_DEFINITIONS } from "../../src/setup/channels.js";
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

describe("private admin logs and linking roles", () => {
  const VIEWER_ROLE = "800000000000000001";
  const ADMIN_USER = "800000000000000002";

  function phase2(file = join(tempDir(), "state.json")) {
    const store = new StateStore(file, "development");
    const channelSetup = new ChannelSetup(store, silentLogger, {
      activity: { enabled: true, viewerRoleIds: [VIEWER_ROLE], viewerUserIds: [] },
      adminRoleIds: [],
      adminUserIds: [ADMIN_USER],
      linking: { enabled: true, roles: [{ key: "verified", name: "Verified Trainer" }, { key: "premium", name: "Ace Trainer" }] },
    });
    const guild = new FakeGuild();
    guild.permissions = [...guild.permissions, "ManageRoles", "ManageNicknames"];
    guild.addRoleInfo({ id: VIEWER_ROLE, name: "Staff" });
    return { store, channelSetup, guild };
  }

  it("creates a private Admin Logs category with #player-activity and the roles", async () => {
    const { store, channelSetup, guild } = phase2();
    const report = await channelSetup.run(guild);
    expect(report.ok).toBe(true);
    expect(report.adminCategoryAction).toBe("created");
    const admin = guild.created.find((channel) => channel.name === ADMIN_CATEGORY_NAME)!;
    const activity = guild.created.find((channel) => channel.name === "player-activity")!;
    expect(activity.parentId).toBe(admin.id);
    for (const channel of [admin, activity]) {
      expect(channel.overwrites).toEqual([
        { id: EVERYONE, type: "role", allow: [], deny: ["ViewChannel"] },
        { id: BOT_USER, type: "member", allow: ["ViewChannel", "SendMessages", "EmbedLinks", "ReadMessageHistory"], deny: [] },
        { id: VIEWER_ROLE, type: "role", allow: ["ViewChannel", "ReadMessageHistory"], deny: ["SendMessages"] },
        { id: ADMIN_USER, type: "member", allow: ["ViewChannel", "ReadMessageHistory"], deny: ["SendMessages"] },
      ]);
    }
    expect(report.channels.find((channel) => channel.purpose === "playerActivity")!.privacyProblems).toEqual([]);
    expect(report.roles.map((role) => [role.name, role.action])).toEqual([["Verified Trainer", "created"], ["Ace Trainer", "created"]]);
    expect(store.get().roles.verified).toBeDefined();
    expect(store.get().roles.premium).toBeDefined();
    const text = formatSetupReport(report);
    expect(text).toContain(`Private category "${ADMIN_CATEGORY_NAME}": created`);
    expect(text).toContain(`<#${activity.id}>: created (private)`);

    const again = await channelSetup.run(guild);
    expect(again.roles.every((role) => role.action === "kept")).toBe(true);
    expect(guild.roles).toHaveLength(3);
  });

  it("reports an adopted channel that is not private and Administrator roles", async () => {
    const { channelSetup, guild } = phase2();
    const category = guild.add({ id: "500000000000000101", name: "admin logs", kind: "category", parentId: null });
    guild.add({ id: "500000000000000102", name: "player-activity", kind: "text", parentId: category.id });
    guild.addRoleInfo({ name: "Owner", administrator: true });
    const report = await channelSetup.run(guild);
    expect(report.ok).toBe(false);
    const channel = report.channels.find((item) => item.purpose === "playerActivity")!;
    expect(channel.action).toBe("adopted");
    expect(channel.privacyProblems).toEqual(["@everyone can see the channel"]);
    expect(channel.administratorRoles).toEqual(["Owner"]);
    const text = formatSetupReport(report);
    expect(text).toContain("NOT PRIVATE, nothing is posted until fixed: @everyone can see the channel");
    expect(text).toContain("Roles with Administrator always see it: Owner");
  });

  it("adopts roles by name and flags roles above the bot", async () => {
    const { channelSetup, guild, store } = phase2();
    const existing = guild.addRoleInfo({ name: "verified trainer", assignable: false });
    guild.addRoleInfo({ name: "Ace Trainer", managed: true });
    const report = await channelSetup.run(guild);
    const verified = report.roles.find((role) => role.key === "verified")!;
    expect(verified).toMatchObject({ action: "adopted", roleId: existing.id, assignable: false });
    expect(report.roles.find((role) => role.key === "premium")!.action).toBe("created");
    expect(store.get().roles.verified).toBe(existing.id);
    expect(report.ok).toBe(false);
    expect(formatSetupReport(report)).toContain("move the bot's role above it");
  });

  it("needs Manage Roles and Manage Nicknames only when linking is enabled", async () => {
    const { channelSetup, guild } = phase2();
    guild.permissions = guild.permissions.filter((permission) => permission !== "ManageRoles" && permission !== "ManageNicknames");
    const report = await channelSetup.run(guild);
    expect(report.missingGuildPermissions).toEqual(["ManageRoles", "ManageNicknames"]);
    expect(report.roles.every((role) => role.action === "failed" && role.error === "Missing Manage Roles permission.")).toBe(true);
    const plain = await setup().setup.run(new FakeGuild());
    expect(plain.missingGuildPermissions).toEqual([]);
    expect(plain.roles).toEqual([]);
    expect(plain.channels.some((channel) => channel.purpose === "playerActivity")).toBe(false);
  });
});
