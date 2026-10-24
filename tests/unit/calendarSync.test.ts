import { describe, expect, it } from "vitest";
import type { AnnouncementApi } from "../../src/integrations/pokeverse/gameApi.js";
import { FEATURES, type CalendarEvent, type CalendarRangeResult } from "../../src/integrations/pokeverse/protocol.js";
import { CalendarSync, describeCalendarEvent } from "../../src/services/calendar/calendarSync.js";
import { DeliveryQueue } from "../../src/utils/deliveryQueue.js";
import { silentLogger } from "../../src/utils/logger.js";
import { Metrics } from "../../src/utils/metrics.js";
import { ALL_PERMISSIONS, FakeChannels, FakeGuild, makeStore } from "../helpers/fakes.js";

const NOW = 1_800_000_000;

class FakeCalendarApi implements AnnouncementApi {
  connected = true;
  features = new Set<string>([FEATURES.calendar]);
  events: CalendarEvent[] = [];
  readonly ranges: Array<[number, number]> = [];
  hasFeature(feature: string): boolean {
    return this.features.has(feature);
  }
  async roles(): Promise<number> {
    return 0;
  }
  async calendarRange(from: number, to: number): Promise<CalendarRangeResult> {
    this.ranges.push([from, to]);
    return { from, to, events: this.events.map((event) => ({ ...event })) };
  }
}

const WEEKEND: CalendarEvent = {
  key: "weekend:1800086400",
  id: "weekend",
  name: "Weekend Event",
  description: "Double EXP all weekend.",
  startsAt: NOW + 86400,
  endsAt: NOW + 86400 * 3,
  bonuses: [{ kind: "exp", label: "kill EXP", value: 2 }],
};

function setup(options: { reminders?: boolean; permissions?: string[] } = {}) {
  let now = NOW * 1000;
  const guild = new FakeGuild();
  guild.permissions = (options.permissions ?? [...ALL_PERMISSIONS, "CreateEvents", "ManageEvents"]) as typeof guild.permissions;
  const api = new FakeCalendarApi();
  const channels = new FakeChannels();
  const metrics = new Metrics();
  const store = makeStore();
  const queue = new DeliveryQueue({ name: "announcements", maxSize: 10, maxAttempts: 1, retryDelayMs: 1, logger: silentLogger, metrics });
  const sync = new CalendarSync({
    enabled: true,
    reminders: options.reminders ?? true,
    api,
    guild: () => guild,
    channels,
    store,
    queue,
    logger: silentLogger,
    metrics,
    now: () => now,
  });
  return { sync, api, guild, store, queue, metrics, channel: channels.channel("announcements"), advance: (seconds: number) => (now += seconds * 1000) };
}

describe("calendar sync", () => {
  it("describes an event with its bonuses", () => {
    expect(describeCalendarEvent(WEEKEND)).toBe("Double EXP all weekend.\n\nBonuses: 2x kill EXP");
  });

  it("makes a Discord event for each calendar event of the next 30 days", async () => {
    const { sync, api, guild, store } = setup();
    api.events = [WEEKEND, { ...WEEKEND, key: "halloween:1", id: "halloween", name: "Halloween", bonuses: [], forced: true }];
    await sync.sync();
    expect(api.ranges).toEqual([[NOW, NOW + 30 * 86400]]);
    expect(guild.eventCalls).toEqual(["create Weekend Event"]);
    const [id, event] = [...guild.scheduledEvents.entries()][0]!;
    expect(event).toMatchObject({ name: "Weekend Event", startsAt: WEEKEND.startsAt * 1000, endsAt: WEEKEND.endsAt * 1000, location: "In game: PokeVerse" });
    expect(store.get().calendarEvents[WEEKEND.key]).toMatchObject({ eventId: id, status: "scheduled" });
    expect(sync.link(WEEKEND.key)).toBe(`https://discord.com/events/${guild.id}/${id}`);
    await sync.sync();
    expect(guild.eventCalls).toHaveLength(1);
  });

  it("edits a changed event, deletes a removed one, starts and finishes on time", async () => {
    const { sync, api, guild, store, advance } = setup({ reminders: false });
    const staff: CalendarEvent = { ...WEEKEND, key: "staff3:1", id: "staff3", name: "Staff hunt", bonuses: [] };
    api.events = [WEEKEND, staff];
    await sync.sync();
    const weekendId = store.get().calendarEvents[WEEKEND.key]!.eventId;
    const staffId = store.get().calendarEvents[staff.key]!.eventId;

    api.events = [{ ...WEEKEND, endsAt: WEEKEND.endsAt + 3600, description: "Triple EXP!" }];
    await sync.sync();
    expect(guild.eventCalls.slice(2)).toEqual([`delete ${staffId}`, `edit ${weekendId}`]);
    expect(guild.scheduledEvents.get(weekendId)).toMatchObject({ endsAt: (WEEKEND.endsAt + 3600) * 1000, description: "Triple EXP!\n\nBonuses: 2x kill EXP" });

    advance(86400 + 10);
    await sync.sync();
    expect(guild.eventCalls.at(-1)).toBe(`edit ${weekendId} active`);
    expect(store.get().calendarEvents[WEEKEND.key]!.status).toBe("active");

    advance(86400 * 3);
    api.events = [];
    await sync.sync();
    expect(guild.eventCalls.at(-1)).toBe(`edit ${weekendId} completed`);
    expect(store.get().calendarEvents).toEqual({});
  });

  it("starts an event a minute from now when it's already running, and makes one deleted on Discord again", async () => {
    const { sync, api, guild, store } = setup({ reminders: false });
    api.events = [{ ...WEEKEND, startsAt: NOW - 600 }];
    await sync.sync();
    const id = store.get().calendarEvents[WEEKEND.key]!.eventId;
    expect(guild.scheduledEvents.get(id)!.startsAt).toBe((NOW + 60) * 1000);
    guild.scheduledEvents.delete(id);
    await sync.sync();
    expect(store.get().calendarEvents).toEqual({});
    await sync.sync();
    expect(Object.keys(store.get().calendarEvents)).toEqual([WEEKEND.key]);
  });

  it("reminds #game-announcements once, an hour before the start", async () => {
    const { sync, api, queue, channel, advance } = setup();
    api.events = [WEEKEND];
    await sync.sync();
    advance(86400 - 3000);
    await sync.sync();
    await sync.sync();
    await queue.idle();
    expect(channel.sent).toHaveLength(1);
    const embed = channel.sent[0]!.message.embeds![0]!;
    expect(embed.title).toBe("⏰ Starting soon: Weekend Event");
    expect(embed.description).toContain(`<t:${WEEKEND.startsAt}:R>`);
    expect(embed.description).toContain("[Event details](https://discord.com/events/");
    expect(channel.sent[0]!.message.content).toBeUndefined();
  });

  it("waits for the permission and the game's calendar", async () => {
    const noPermission = setup({ permissions: [...ALL_PERMISSIONS] });
    noPermission.api.events = [WEEKEND];
    await noPermission.sync.sync();
    expect(noPermission.guild.eventCalls).toEqual([]);
    expect(noPermission.metrics.get("calendar.no_permission")).toBe(1);

    const oldGame = setup();
    oldGame.api.features.clear();
    await oldGame.sync.sync();
    expect(oldGame.api.ranges).toEqual([]);
  });
});
