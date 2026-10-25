import { describe, expect, it } from "vitest";
import { Announcer } from "../../src/services/announcements/announcer.js";
import { DeliveryQueue } from "../../src/utils/deliveryQueue.js";
import { silentLogger } from "../../src/utils/logger.js";
import { Metrics } from "../../src/utils/metrics.js";
import type { AnnouncementApi } from "../../src/integrations/pokeverse/gameApi.js";
import { FEATURES, gameEventSchema, type AnnouncementEvent, type CalendarRangeResult } from "../../src/integrations/pokeverse/protocol.js";
import { ALL_PERMISSIONS, FakeChannels, FakeGuild, envelope, makeConfig } from "../helpers/fakes.js";

function setup(options: { broadcasts?: boolean } = {}) {
  const channels = new FakeChannels();
  const metrics = new Metrics();
  const queue = new DeliveryQueue({ name: "announcements", maxSize: 10, maxAttempts: 1, retryDelayMs: 1, logger: silentLogger, metrics });
  const announcer = new Announcer({
    broadcasts: options.broadcasts ?? true,
    maxEventAgeSeconds: 600,
    channels,
    queue,
    logger: silentLogger,
    metrics,
  });
  return { announcer, channel: channels.channel("announcements"), queue };
}

describe("announcements", () => {
  it("posts GM broadcasts with the author", async () => {
    const { announcer, channel, queue } = setup();
    expect(announcer.handleBroadcast(envelope({ kind: "broadcast", source: "gm", author: "GM Oak", text: "Double XP **tonight**" }))).toBe(true);
    await queue.idle();
    const embed = channel.sent[0]!.message.embeds![0]!;
    expect(embed.title).toBe("Game Master broadcast");
    expect(embed.description).toBe("Double XP \\*\\*tonight\\*\\*");
    expect(embed.footer?.text).toBe("From GM Oak");
  });

  it("respects the switches and de-duplicates", async () => {
    const off = setup({ broadcasts: false });
    expect(off.announcer.handleBroadcast(envelope({ kind: "broadcast", source: "gm", text: "x" }))).toBe(false);

    const on = setup();
    const event = envelope({ kind: "broadcast", source: "staff", text: "x" });
    expect(on.announcer.handleBroadcast(event)).toBe(true);
    expect(on.announcer.handleBroadcast(event)).toBe(false);
  });

  it("posts admin announcements", async () => {
    const { announcer, channel } = setup();
    await announcer.announce("maintenance", "Tonight", "Server maintenance at 22:00.", "Jim");
    const embed = channel.sent[0]!.message.embeds![0]!;
    expect(embed.title).toBe("Maintenance: Tonight");
    expect(embed.footer?.text).toBe("Posted by Jim");
  });
});

class FakeAnnouncementApi implements AnnouncementApi {
  connected = true;
  features = new Set<string>([FEATURES.announcements, FEATURES.calendar]);
  readonly sentRoles: Array<{ roles: string[]; everyone: boolean }> = [];
  hasFeature(feature: string): boolean {
    return this.features.has(feature);
  }
  async roles(roles: string[], everyone: boolean): Promise<number> {
    this.sentRoles.push({ roles, everyone });
    return roles.length;
  }
  async calendarRange(from: number, to: number): Promise<CalendarRangeResult> {
    return { from, to, events: [] };
  }
}

function gameSetup(overrides: Record<string, string> = {}) {
  const config = makeConfig(overrides);
  const channels = new FakeChannels();
  const metrics = new Metrics();
  const guild = new FakeGuild();
  guild.permissions = [...ALL_PERMISSIONS, "MentionEveryone"];
  const verified = guild.addRoleInfo({ name: "Verified Trainer" });
  const tutor = guild.addRoleInfo({ name: "Senior Tutor", mentionable: false });
  guild.addRoleInfo({ name: "PokeVerse", managed: true });
  const api = new FakeAnnouncementApi();
  const queue = new DeliveryQueue({ name: "announcements", maxSize: 10, maxAttempts: 1, retryDelayMs: 1, logger: silentLogger, metrics });
  const announcer = new Announcer({
    broadcasts: config.announcements.broadcasts,
    categories: config.announcements.categories,
    pings: config.announcements.pings,
    staffPings: config.announcements.staffPings,
    verifiedRoleName: config.linking.verifiedRoleName,
    guild: () => guild,
    api,
    calendarLink: (key) => (key === "weekend:1" ? "https://discord.com/events/1/2" : undefined),
    maxEventAgeSeconds: 600,
    channels,
    queue,
    logger: silentLogger,
    metrics,
  });
  return { announcer, api, guild, verified, tutor, queue, metrics, channel: channels.channel("announcements") };
}

const STARTED: AnnouncementEvent = {
  kind: "announcement",
  category: "event",
  title: "Weekend Event has started",
  text: "Double EXP all weekend. It runs for 2 days",
  source: "077-eventCalendar",
  calendar: { key: "weekend:1", id: "weekend", state: "started", type: "server" },
};

describe("game announcements", () => {
  it("parses the game's announcement event", () => {
    expect(gameEventSchema.parse({ ...STARTED, full: "Weekend Event has started: Double EXP" })).toMatchObject({ kind: "announcement", category: "event" });
  });

  it("posts a calendar event in its colour, links the Discord event and pings Verified Trainer", async () => {
    const { announcer, channel, queue, verified } = gameSetup();
    expect(announcer.handleAnnouncement(envelope(STARTED))).toBe(true);
    await queue.idle();
    const message = channel.sent[0]!.message;
    expect(message.content).toBe(`<@&${verified.id}>`);
    expect(message.mentionRoleIds).toEqual([verified.id]);
    expect(message.mentionEveryone).toBeFalsy();
    const embed = message.embeds![0]!;
    expect(embed.title).toBe("⭐ Weekend Event has started");
    expect(embed.author?.name).toBe("Event");
    expect(embed.description).toContain("[Event details](https://discord.com/events/1/2)");
  });

  it("doesn't ping for bonus events staff start, and posts milestones and news without a ping", async () => {
    const { announcer, channel, queue } = gameSetup();
    announcer.handleAnnouncement(envelope({ kind: "announcement", category: "event", title: "Experience event started", text: "2x kill experience", source: "058-serverExpEvent" }));
    announcer.handleAnnouncement(envelope({ kind: "announcement", category: "milestone", title: "New record", text: "40 players are logged in." }));
    announcer.handleAnnouncement(envelope({ kind: "announcement", category: "brand-new", text: "Something" }));
    await queue.idle();
    expect(channel.sent.map((item) => item.message.content)).toEqual([undefined, undefined, undefined]);
    expect(channel.sent.map((item) => item.message.embeds![0]!.author?.name)).toEqual(["Event", "Milestone", "News"]);
  });

  it("leaves legendaries, server notices and tips to their own posts", async () => {
    const { announcer, channel, queue } = gameSetup();
    for (const category of ["legendary", "server", "tip"]) {
      expect(announcer.handleAnnouncement(envelope({ kind: "announcement", category, text: "x" }))).toBe(false);
    }
    await queue.idle();
    expect(channel.sent).toHaveLength(0);
    const all = gameSetup({ ANNOUNCE_CATEGORIES: "server" });
    expect(all.announcer.handleAnnouncement(envelope({ kind: "announcement", category: "server", text: "Saving in 1 minute" }))).toBe(true);
    expect(all.announcer.handleAnnouncement(envelope({ kind: "announcement", category: "event", text: "x" }))).toBe(false);
  });

  it("pings what staff picked: @everyone, a role by a loose name, or nothing for an unknown role", async () => {
    const { announcer, channel, queue, tutor } = gameSetup();
    const staff = { kind: "announcement" as const, category: "staff", title: "GM Oak", text: "Event tonight!", author: "GM Oak" };
    announcer.handleAnnouncement(envelope({ ...staff, ping: "everyone" }));
    announcer.handleAnnouncement(envelope({ ...staff, ping: "senior_tutor" }));
    announcer.handleAnnouncement(envelope({ ...staff, ping: "Nobody" }));
    await queue.idle();
    expect(channel.sent[0]!.message).toMatchObject({ content: "@everyone", mentionEveryone: true });
    expect(channel.sent[1]!.message).toMatchObject({ content: `<@&${tutor.id}>`, mentionRoleIds: [tutor.id] });
    expect(channel.sent[2]!.message.content).toBeUndefined();
    const embed = channel.sent[0]!.message.embeds![0]!;
    expect(embed.title).toBe("📣 Staff broadcast");
    expect(embed.footer?.text).toBe("From GM Oak");
  });

  it("posts without the ping when the bot can't mention everyone", async () => {
    const { announcer, channel, queue, guild, metrics } = gameSetup();
    guild.permissions = [...ALL_PERMISSIONS];
    announcer.handleAnnouncement(envelope({ kind: "announcement", category: "staff", text: "x", ping: "here" }));
    announcer.handleAnnouncement(envelope({ kind: "announcement", category: "staff", text: "y", ping: "Senior Tutor" }));
    await queue.idle();
    expect(channel.sent.map((item) => item.message.content)).toEqual([undefined, undefined]);
    expect(metrics.get("announcements.ping_not_allowed")).toBe(2);
  });

  it("ignores staff pings when ANNOUNCE_STAFF_PINGS is off", async () => {
    const { announcer, channel, queue } = gameSetup({ ANNOUNCE_STAFF_PINGS: "false" });
    announcer.handleAnnouncement(envelope({ kind: "announcement", category: "staff", text: "x", ping: "everyone" }));
    await queue.idle();
    expect(channel.sent[0]!.message.content).toBeUndefined();
  });

  it("drops the old broadcast event when the game sends announcements", () => {
    const { announcer, api } = gameSetup();
    expect(announcer.handleBroadcast(envelope({ kind: "broadcast", source: "gm", author: "GM Oak", text: "x" }))).toBe(false);
    api.features.delete(FEATURES.announcements);
    expect(announcer.handleBroadcast(envelope({ kind: "broadcast", source: "gm", author: "GM Oak", text: "x" }))).toBe(true);
  });

  it("sends the pingable roles to the game for the Admin window", async () => {
    const { announcer, api, guild } = gameSetup();
    await announcer.syncRoles();
    expect(api.sentRoles).toEqual([{ roles: ["Verified Trainer", "Senior Tutor"], everyone: true }]);
    guild.permissions = [...ALL_PERMISSIONS];
    await announcer.syncRoles();
    expect(api.sentRoles[1]).toEqual({ roles: ["Verified Trainer"], everyone: false });
  });

  it("reads the category and ping settings", () => {
    expect(makeConfig({ ANNOUNCE_PINGS: "event=Events,milestone=verified" }).announcements.pings).toEqual({ event: "Events", milestone: "verified" });
    expect(() => makeConfig({ ANNOUNCE_PINGS: "event=everyone" })).toThrow();
    expect(() => makeConfig({ ANNOUNCE_CATEGORIES: "event,tips" })).toThrow();
    expect([...makeConfig({ ANNOUNCE_CATEGORIES: "none" }).announcements.categories]).toEqual([]);
  });
});
