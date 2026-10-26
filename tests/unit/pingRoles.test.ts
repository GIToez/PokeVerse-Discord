import { describe, expect, it } from "vitest";
import { buildCommandDefinitions } from "../../src/commands/definitions.js";
import { PingCommands } from "../../src/commands/pingCommands.js";
import { CommandRouter, isPrivateCommand } from "../../src/commands/router.js";
import type { LegendaryEvent, SpawnEvent } from "../../src/integrations/pokeverse/protocol.js";
import type { AnnouncementApi } from "../../src/integrations/pokeverse/gameApi.js";
import { Announcer } from "../../src/services/announcements/announcer.js";
import { CalendarSync } from "../../src/services/calendar/calendarSync.js";
import { LegendaryEncounters } from "../../src/services/legendaries/legendaryEncounters.js";
import { PingRoles } from "../../src/services/pings/pingRoles.js";
import { ArtworkResolver } from "../../src/services/pokemon/artwork.js";
import { PokemonAutocomplete } from "../../src/services/pokemon/pokemonLookup.js";
import { SpawnAnnouncer } from "../../src/services/spawns/spawnAnnouncer.js";
import { StatusService } from "../../src/services/status/statusService.js";
import { ChannelSetup } from "../../src/setup/channelSetup.js";
import { DeliveryQueue } from "../../src/utils/deliveryQueue.js";
import { silentLogger } from "../../src/utils/logger.js";
import { Metrics } from "../../src/utils/metrics.js";
import { ALL_PERMISSIONS, DEV_GUILD, FakeChannels, FakeGame, FakeGuild, envelope, makeConfig, makeStore } from "../helpers/fakes.js";

const MEMBER = "300000000000000001";
const OTHER = "300000000000000002";

async function setup(overrides: Record<string, string> = {}) {
  const config = makeConfig(overrides);
  const store = makeStore(config);
  const guild = new FakeGuild();
  guild.permissions = [...ALL_PERMISSIONS, "ManageRoles", "MentionEveryone"];
  const verified = guild.addRoleInfo({ name: "Verified Trainer" });
  guild.addMember(MEMBER, { roleIds: [verified.id] });
  const metrics = new Metrics();
  const pings = new PingRoles({ roles: config.pings.roles, store, guild: () => guild, logger: silentLogger, metrics });
  const channelSetup = new ChannelSetup(store, silentLogger, {
    linking: { enabled: config.linking.enabled, roles: [{ key: "verified", name: config.linking.verifiedRoleName }] },
    pingRoles: config.pings.roles.map(({ kind, name }) => ({ key: `ping:${kind}` as const, name })),
  });
  const report = await channelSetup.run(guild);
  const role = (name: string) => guild.roles.find((item) => item.name === name)!;
  return { config, store, guild, metrics, pings, report, role, verified, channelSetup };
}

describe("ping roles: config and setup", () => {
  it("defaults to six ping roles and no ANNOUNCE_PINGS role", () => {
    const config = makeConfig();
    expect(config.pings.roles).toEqual([
      { kind: "event", name: "Event Pings" },
      { kind: "tournament", name: "Tournament Pings" },
      { kind: "shiny", name: "Shiny Pings" },
      { kind: "legendary", name: "Legendary Pings" },
      { kind: "news", name: "News Pings" },
      { kind: "server", name: "Server Pings" },
    ]);
    expect(config.announcements.pings).toEqual({});
    expect(makeConfig({ PING_ROLES_ENABLED: "false" }).pings.roles).toEqual([]);
    expect(makeConfig({ PING_ROLE_NAMES: "shiny=Shiny Hunters" }).pings.roles).toEqual([{ kind: "shiny", name: "Shiny Hunters" }]);
  });

  it("rejects unknown kinds, duplicates, everyone and linking role names", () => {
    expect(() => makeConfig({ PING_ROLE_NAMES: "raids=Raid Pings" })).toThrow();
    expect(() => makeConfig({ PING_ROLE_NAMES: "shiny=A,shiny=B" })).toThrow();
    expect(() => makeConfig({ PING_ROLE_NAMES: "shiny=Pings,news=pings" })).toThrow();
    expect(() => makeConfig({ PING_ROLE_NAMES: "news=@everyone" })).toThrow();
    expect(() => makeConfig({ PING_ROLE_NAMES: "event=Verified Trainer" })).toThrow(/Invalid configuration/);
    expect(() => makeConfig({ PING_ROLE_NAMES: "event=gamemaster" })).toThrow();
    expect(makeConfig({ PING_ROLE_NAMES: "event=Gamemaster", STAFF_ROLES_ENABLED: "false" }).pings.roles).toHaveLength(1);
  });

  it("creates the ping roles (not mentionable) and saves them, even without account linking", async () => {
    const { report, store, guild } = await setup({ LINKING_ENABLED: "false" });
    const keys = ["ping:event", "ping:tournament", "ping:shiny", "ping:legendary", "ping:news", "ping:server"];
    expect(report.roles.map((role) => role.key)).toEqual(keys);
    expect(report.roles.every((role) => role.action === "created")).toBe(true);
    expect(report.roles.map((role) => role.name)).toContain("Server Pings");
    expect(Object.keys(store.get().roles)).toEqual(keys);
    expect(guild.roles.some((role) => role.name === "Verified Trainer" && store.get().roles.verified === role.id)).toBe(false);
  });

  it("needs Manage Roles and Mention Everyone for the ping roles", async () => {
    const { channelSetup, guild } = await setup({ LINKING_ENABLED: "false" });
    guild.permissions = [...ALL_PERMISSIONS];
    expect((await channelSetup.inspect(guild)).missingGuildPermissions).toEqual(expect.arrayContaining(["ManageRoles", "MentionEveryone"]));
  });
});

describe("ping roles: pings", () => {
  it("pings the ping role instead of the ANNOUNCE_PINGS role, for every event and an hour before a tournament", async () => {
    const { config, guild, pings, role } = await setup({ ANNOUNCE_PINGS: "event=verified" });
    const channels = new FakeChannels();
    const metrics = new Metrics();
    const queue = new DeliveryQueue({ name: "a", maxSize: 10, maxAttempts: 1, retryDelayMs: 1, logger: silentLogger, metrics });
    const announcer = new Announcer({
      broadcasts: true, categories: config.announcements.categories, pings: config.announcements.pings, pingRoles: pings,
      staffPings: true, guild: () => guild, maxEventAgeSeconds: 600, channels, queue, logger: silentLogger, metrics,
    });
    announcer.handleAnnouncement(envelope({
      kind: "announcement", category: "event", title: "Weekend Event has started", text: "Double EXP",
      calendar: { key: "weekend:1", id: "weekend", state: "started", type: "server" },
    }));
    announcer.handleAnnouncement(envelope({ kind: "announcement", category: "event", title: "Experience event started", text: "2x" }));
    announcer.handleAnnouncement(envelope({ kind: "announcement", category: "news", title: "Patch notes", text: "New map" }));
    announcer.handleAnnouncement(envelope({ kind: "announcement", category: "staff", text: "Hi", ping: "Shiny Pings" }));
    announcer.handleAnnouncement(envelope({ kind: "announcement", category: "event", title: "Kanto Tournament", text: "Starts in 1 hour (level 50-100). Sign up with Joey at the PvP area." }));
    announcer.handleAnnouncement(envelope({ kind: "announcement", category: "event", title: "Kanto Tournament", text: "Ash won the tournament!" }));
    await queue.idle();
    const sent = channels.channel("announcements").sent.map((item) => item.message);
    const event = `<@&${role("Event Pings").id}>`;
    expect(sent.map((message) => message.content)).toEqual([
      event, event, `<@&${role("News Pings").id}>`, `<@&${role("Shiny Pings").id}>`, `<@&${role("Tournament Pings").id}>`, undefined,
    ]);
    expect(sent[0]!.mentionRoleIds).toEqual([role("Event Pings").id]);
  });

  it("falls back to ANNOUNCE_PINGS for a kind left out of PING_ROLE_NAMES", async () => {
    const { pings, verified } = await setup({ ANNOUNCE_PINGS: "event=verified", PING_ROLE_NAMES: "shiny=Shiny Pings" });
    const announcer = new Announcer({
      broadcasts: true, pings: { event: "verified" }, pingRoles: pings, maxEventAgeSeconds: 600, channels: new FakeChannels(),
      queue: new DeliveryQueue({ name: "a", maxSize: 1, maxAttempts: 1, retryDelayMs: 1, logger: silentLogger, metrics: new Metrics() }),
      logger: silentLogger, metrics: new Metrics(),
    });
    expect(announcer.pingFor({ kind: "announcement", category: "event", text: "x", calendar: { key: "k", id: "i", state: "started", type: "holiday" } })).toBe("verified");
    expect(verified.id).toBeDefined();
  });

  it("pings Shiny Pings and Legendary Pings on spawn alerts", async () => {
    const { config, pings, role } = await setup();
    const channels = new FakeChannels();
    const metrics = new Metrics();
    const queue = new DeliveryQueue({ name: "spawns", maxSize: 10, maxAttempts: 1, retryDelayMs: 1, logger: silentLogger, metrics });
    const spawns = new SpawnAnnouncer({ config: config.spawns, channels, queue, artwork: new ArtworkResolver(undefined), pings, logger: silentLogger, metrics });
    const shiny: SpawnEvent = {
      kind: "spawn", species: "Shiny Rattata", baseSpecies: "Rattata", dexNumber: 19, level: 8, shiny: true, legendary: false,
      source: "spawn", startup: false, creatureId: 1, nearestTown: "Pallet",
    };
    spawns.handle(envelope(shiny));
    spawns.handle(envelope({ ...shiny, species: "Shiny Mewtwo", legendary: true, creatureId: 2 }));
    await queue.idle();
    const shinyPost = channels.channel("shinySpawns").sent[0]!.message;
    expect(shinyPost.content).toBe(`<@&${role("Shiny Pings").id}>`);
    expect(shinyPost.embeds).toHaveLength(1);
    expect(channels.channel("legendarySpawns").sent[0]!.message.mentionRoleIds).toEqual([role("Shiny Pings").id, role("Legendary Pings").id]);
  });

  it("pings Legendary Pings on a new wild legendary and a set, not on their updates", async () => {
    const { config, store, pings, role } = await setup();
    const channels = new FakeChannels();
    const metrics = new Metrics();
    const queue = new DeliveryQueue({ name: "spawns", maxSize: 10, maxAttempts: 1, retryDelayMs: 1, logger: silentLogger, metrics });
    const legendaries = new LegendaryEncounters({
      config: config.spawns, channels, store, queue, artwork: new ArtworkResolver(undefined), pings, logger: silentLogger, metrics,
    });
    const now = Math.floor(Date.now() / 1000);
    const spawn: LegendaryEvent = { kind: "legendary", event: "spawn", encounterId: 31, species: "Articuno", area: "Seafoam Islands", endsAt: now + 3600 };
    legendaries.handle(envelope(spawn));
    await queue.idle();
    legendaries.handle(envelope({ ...spawn, event: "sighting", trainer: "Ash" }));
    legendaries.handle(envelope({
      kind: "legendary", event: "set", species: "Legendary birds", setId: "birds", setName: "The legendary birds",
      members: [{ encounterId: 41, species: "Zapdos", endsAt: now + 3600 }],
    }));
    await queue.idle();
    const sent = channels.channel("legendarySpawns").sent.map((item) => item.message.content);
    const ping = `<@&${role("Legendary Pings").id}>`;
    expect(sent).toEqual([ping, ping]);
  });

  it("pings the matching role on /pokeverse announce unless ping is off", async () => {
    const { guild, pings, role } = await setup();
    const channels = new FakeChannels();
    const metrics = new Metrics();
    const queue = new DeliveryQueue({ name: "a", maxSize: 10, maxAttempts: 1, retryDelayMs: 1, logger: silentLogger, metrics });
    const announcer = new Announcer({ broadcasts: true, pingRoles: pings, guild: () => guild, maxEventAgeSeconds: 600, channels, queue, logger: silentLogger, metrics });
    await announcer.announce("news", "Patch", "New map", "Jim");
    await announcer.announce("event", undefined, "Party tonight", "Jim");
    await announcer.announce("maintenance", undefined, "Down at 22:00", "Jim");
    await announcer.announce("news", undefined, "Quiet one", "Jim", false);
    expect(channels.channel("announcements").sent.map((item) => item.message.content)).toEqual([
      `<@&${role("News Pings").id}>`, `<@&${role("Event Pings").id}>`, `<@&${role("Server Pings").id}>`, undefined,
    ]);
  });

  it("pings Event Pings on the calendar reminder", async () => {
    const { store, guild, pings, role } = await setup();
    const channels = new FakeChannels();
    const metrics = new Metrics();
    const queue = new DeliveryQueue({ name: "a", maxSize: 10, maxAttempts: 1, retryDelayMs: 1, logger: silentLogger, metrics });
    const now = Date.now();
    const api = {
      connected: true,
      hasFeature: () => true,
      roles: async () => 0,
      calendarRange: async (from: number, to: number) => ({
        from, to,
        events: [{ key: "weekend:1", id: "weekend", name: "Weekend Event", startsAt: Math.floor(now / 1000) + 1800, endsAt: Math.floor(now / 1000) + 90000, bonuses: [] }],
      }),
    } as unknown as AnnouncementApi;
    guild.permissions = [...guild.permissions, "CreateEvents", "ManageEvents"];
    const calendar = new CalendarSync({ enabled: true, reminders: true, api, guild: () => guild, channels, store, queue, pings, logger: silentLogger, metrics, now: () => now });
    await calendar.sync();
    await calendar.sync();
    await queue.idle();
    expect(channels.channel("announcements").sent.map((item) => item.message.content)).toEqual([`<@&${role("Event Pings").id}>`]);
  });

  it("pings Server Pings once per restart countdown and for maintenance, and deletes the post when it's over", async () => {
    const { store, pings, role } = await setup();
    const game = new FakeGame();
    const channels = new FakeChannels();
    const metrics = new Metrics();
    const status = new StatusService({ game, channels, store, refreshSeconds: 60, pings, logger: silentLogger, metrics });
    const channel = channels.channel("serverStatus");
    const now = Math.floor(Date.now() / 1000);
    status.onRestartWarning({ kind: "restart_warning", reason: "shutdown", minutes: 15 }, now);
    status.onRestartWarning({ kind: "restart_warning", reason: "shutdown", minutes: 10 }, now + 300);
    status.onRestartWarning({ kind: "restart_warning", reason: "global_save", minutes: 1 }, now + 400);
    await status.noticesIdle();
    await status.render();
    const notices = channel.sent.filter((item) => item.message.content);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.message.content).toBe(`<@&${role("Server Pings").id}> 🔧 **Server restart** <t:${now + 900}:R>. The countdown is in the status message.`);
    expect(notices[0]!.message.mentionRoleIds).toEqual([role("Server Pings").id]);

    status.onRestartWarning({ kind: "restart_warning", reason: "shutdown_cancelled" }, now + 500);
    await status.noticesIdle();
    expect(channel.deleted).toEqual([notices[0]!.id]);
    expect(store.get().serverNotice).toBeUndefined();

    await status.onConnected({ serverName: "PokeVerse", bootId: "boot-1", restarted: false, features: [] } as never);
    status.onServerState(envelope({ kind: "server_state", state: "maintain" }));
    status.onServerState(envelope({ kind: "server_state", state: "maintain" }));
    await status.noticesIdle();
    const maintenance = channel.sent.filter((item) => item.message.content?.includes("maintenance"));
    expect(maintenance).toHaveLength(1);
    status.onServerState(envelope({ kind: "server_state", state: "normal" }));
    await status.noticesIdle();
    expect(channel.deleted).toContain(maintenance[0]!.id);
  });

  it("posts without a ping when the bot can't mention the role or the role is gone", async () => {
    const { guild, pings, role, metrics } = await setup();
    guild.permissions = ALL_PERMISSIONS.filter((permission) => permission !== "MentionEveryone");
    expect(await pings.mention(["shiny"])).toBeUndefined();
    guild.permissions = [...ALL_PERMISSIONS, "ManageRoles", "MentionEveryone"];
    guild.roles.splice(guild.roles.indexOf(role("Shiny Pings")), 1);
    expect(await pings.mention(["shiny"])).toBeUndefined();
    expect(await pings.mention(["shiny", "news"])).toEqual({ content: `<@&${role("News Pings").id}>`, mentionRoleIds: [role("News Pings").id] });
    expect(metrics.snapshot()["pings.not_allowed"]).toBe(1);
    expect(metrics.snapshot()["pings.role_missing"]).toBe(2);
  });
});

describe("ping roles: /pings", () => {
  function user(id: string) {
    return { id, displayName: "Ash", roleIds: [], manageGuild: false };
  }

  it("shows each ping with an on/off button and toggles the role", async () => {
    const { guild, pings, role, verified } = await setup();
    const commands = new PingCommands({ pings, guild: () => guild, logger: silentLogger, metrics: new Metrics() });
    const panel = await commands.handle(MEMBER);
    expect(panel.ephemeral).toBe(true);
    expect(panel.message.embeds![0]!.description).toContain("**Shiny Pings**: off");
    expect(panel.message.buttons!.map((button) => button.customId)).toEqual(
      ["event", "tournament", "shiny", "legendary", "news", "server"].map((kind) => `pings:toggle:${kind}:${MEMBER}`),
    );

    const on = await commands.handleComponent({ customId: `pings:toggle:shiny:${MEMBER}`, user: user(MEMBER), guildId: DEV_GUILD });
    expect(guild.members.get(MEMBER)!.roleIds).toEqual([verified.id, role("Shiny Pings").id]);
    expect(on.message.embeds![0]!.description).toContain("Shiny Pings: **on**");
    expect(on.message.buttons![2]).toMatchObject({ label: "Turn off Shiny Pings", style: "secondary" });

    await commands.handleComponent({ customId: `pings:toggle:shiny:${MEMBER}`, user: user(MEMBER), guildId: DEV_GUILD });
    expect(guild.members.get(MEMBER)!.roleIds).toEqual([verified.id]);
  });

  it("refuses someone else's buttons and reports a role the bot can't hand out", async () => {
    const { guild, pings, store } = await setup();
    const commands = new PingCommands({ pings, guild: () => guild, logger: silentLogger, metrics: new Metrics() });
    const other = await commands.handleComponent({ customId: `pings:toggle:shiny:${MEMBER}`, user: user(OTHER), guildId: DEV_GUILD });
    expect(other.message.embeds![0]!.description).toContain("not for you");
    expect(guild.memberCalls).toEqual([]);

    guild.failMemberOps.push(new Error("Missing Permissions"));
    const failed = await commands.handleComponent({ customId: `pings:toggle:news:${MEMBER}`, user: user(MEMBER), guildId: DEV_GUILD });
    expect(failed.message.embeds![0]!.description).toContain("must be above the ping roles");

    store.update((state) => {
      delete state.roles["ping:event"];
    });
    const missing = await commands.handleComponent({ customId: `pings:toggle:event:${MEMBER}`, user: user(MEMBER), guildId: DEV_GUILD });
    expect(missing.message.embeds![0]!.description).toContain("not set up yet");
  });

  it("is a private command routed through the command router", async () => {
    const { config, store, guild, pings } = await setup();
    const game = new FakeGame();
    const channels = new FakeChannels();
    const metrics = new Metrics();
    const queue = new DeliveryQueue({ name: "a", maxSize: 10, maxAttempts: 1, retryDelayMs: 1, logger: silentLogger, metrics });
    const router = new CommandRouter({
      config, game, artwork: new ArtworkResolver(undefined), autocomplete: new PokemonAutocomplete(game),
      status: new StatusService({ game, channels, store, refreshSeconds: 60, logger: silentLogger, metrics }),
      setup: new ChannelSetup(store, silentLogger),
      announcer: new Announcer({ broadcasts: true, maxEventAgeSeconds: 600, channels, queue, logger: silentLogger, metrics }),
      store, guild: () => guild, queueSizes: () => ({}), logger: silentLogger, metrics,
      pings: new PingCommands({ pings, guild: () => guild, logger: silentLogger, metrics }),
    });
    expect(isPrivateCommand("pings")).toBe(true);
    const panel = await router.handle({ commandName: "pings", options: {}, user: user(MEMBER), guildId: DEV_GUILD });
    expect(panel.message.embeds![0]!.title).toBe("Ping notifications");
    await router.handleComponent({ customId: `pings:toggle:legendary:${MEMBER}`, user: user(MEMBER), guildId: DEV_GUILD });
    expect(guild.members.get(MEMBER)!.roleIds).toContain(store.get().roles["ping:legendary"]);

    expect(buildCommandDefinitions({ linking: false, pings: true }).map((command) => command.name)).toContain("pings");
    expect(buildCommandDefinitions({ linking: false }).map((command) => command.name)).not.toContain("pings");
  });
});
