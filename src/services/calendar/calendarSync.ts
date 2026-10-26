import type { APIEmbed } from "discord.js";
import type { ChannelDirectory, GuildPort, ScheduledEventSpec, ScheduledEventStatus } from "../../bot/ports.js";
import type { AnnouncementApi } from "../../integrations/pokeverse/gameApi.js";
import { FEATURES, type CalendarEvent } from "../../integrations/pokeverse/protocol.js";
import type { DeliveryQueue } from "../../utils/deliveryQueue.js";
import type { Logger } from "../../utils/logger.js";
import type { Metrics } from "../../utils/metrics.js";
import type { CalendarEventRecord, StateStore } from "../../utils/stateStore.js";
import { plain } from "../embeds.js";
import type { PingRoles } from "../pings/pingRoles.js";

export interface CalendarSyncOptions {
  enabled: boolean;
  reminders: boolean;
  api: AnnouncementApi;
  guild: () => GuildPort | undefined;
  channels: ChannelDirectory;
  store: StateStore;
  queue: DeliveryQueue;
  /** The reminder an hour before pings Event Pings. */
  pings?: PingRoles;
  logger: Logger;
  metrics: Metrics;
  now?: () => number;
  intervalMs?: number;
}

/** How far ahead the game's calendar is copied to Discord. */
export const CALENDAR_DAYS = 30;
/** The reminder goes out when an event starts within this many seconds. */
export const REMINDER_SECONDS = 3600;
/** Discord events can't start in the past: one created late starts this many seconds from now. */
const LATE_START_SECONDS = 60;
const LOCATION = "In game: PokeVerse";
const REASON = "PokeVerse calendar";

function multiplier(value: number): string {
  return `${Math.round(value * 100) / 100}x`;
}

/** The Discord event's description: the game's text and its bonuses. */
export function describeCalendarEvent(event: CalendarEvent): string {
  const lines = [event.description?.trim() || event.name];
  if (event.bonuses.length > 0) {
    lines.push(`Bonuses: ${event.bonuses.map((bonus) => `${multiplier(bonus.value)} ${bonus.label ?? bonus.kind}`).join(", ")}`);
  }
  return lines.join("\n\n").slice(0, 1000);
}

export function eventLink(guildId: string, eventId: string): string {
  return `https://discord.com/events/${guildId}/${eventId}`;
}

export function buildReminderEmbed(event: CalendarEvent, link: string | undefined): APIEmbed {
  const start = Math.floor(event.startsAt);
  const description = [`Starts <t:${start}:R> (<t:${start}:t>) and runs until <t:${Math.floor(event.endsAt)}:f>.`, plain(describeCalendarEvent(event))];
  if (link) {
    description.push(`[Event details](${link})`);
  }
  return {
    author: { name: "Event" },
    title: `⏰ Starting soon: ${plain(event.name)}`.slice(0, 256),
    description: description.join("\n\n").slice(0, 4096),
    color: 0xf5b82e,
    timestamp: new Date(start * 1000).toISOString(),
  };
}

/**
 * The game's calendar (holidays, the weekend events, staff events) as Discord scheduled events,
 * keyed by the occurrence's key: new ones are created, changed ones edited, removed ones
 * deleted, and each is started and finished on time. An hour before one starts, a reminder
 * goes to #game-announcements.
 */
export class CalendarSync {
  private timer: NodeJS.Timeout | undefined;
  private startTimer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private warnedPermissions = false;
  private readonly now: () => number;

  constructor(private readonly options: CalendarSyncOptions) {
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (!this.options.enabled) {
      return;
    }
    this.timer = setInterval(() => void this.sync(), this.options.intervalMs ?? 15 * 60_000);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    clearTimeout(this.startTimer);
  }

  onConnected(delayMs = 5000): void {
    if (!this.options.enabled) {
      return;
    }
    clearTimeout(this.startTimer);
    this.startTimer = setTimeout(() => void this.sync(), delayMs);
    this.startTimer.unref();
  }

  /** The Discord event of a calendar occurrence. */
  link(key: string): string | undefined {
    const guild = this.options.guild();
    const record = this.options.store.get().calendarEvents[key];
    return guild && record ? eventLink(guild.id, record.eventId) : undefined;
  }

  /** One pass; a pass already running is joined instead of starting another. */
  sync(): Promise<void> {
    this.running ??= this.run().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async run(): Promise<void> {
    const { api, metrics, logger } = this.options;
    const guild = this.options.guild();
    if (!this.options.enabled || !guild || !api.connected || !api.hasFeature(FEATURES.calendar)) {
      return;
    }
    const granted = guild.botPermissions();
    if (!granted.includes("Administrator") && !granted.includes("ManageEvents")) {
      if (!this.warnedPermissions) {
        this.warnedPermissions = true;
        logger.warn("The calendar sync needs the Manage Events permission (Create Events and Manage Events)");
      }
      metrics.increment("calendar.no_permission");
      return;
    }
    const now = Math.floor(this.now() / 1000);
    let events: CalendarEvent[];
    try {
      events = (await api.calendarRange(now, now + CALENDAR_DAYS * 86400)).events;
    } catch (error) {
      metrics.increment("calendar.range_failed");
      logger.warn("Could not read the game's calendar", { error });
      return;
    }
    // Staff turning a holiday on by hand is announced, not planned.
    const wanted = new Map(events.filter((event) => !event.forced && event.endsAt > now + LATE_START_SECONDS).map((event) => [event.key, event]));

    for (const [key, record] of Object.entries(this.options.store.get().calendarEvents)) {
      if (!wanted.has(key)) {
        await this.attempt(key, () => this.retire(guild, key, record, now));
      }
    }
    for (const event of wanted.values()) {
      await this.attempt(event.key, () => this.apply(guild, event, now));
    }
    metrics.increment("calendar.synced");
  }

  private async attempt(key: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.options.metrics.increment("calendar.errors");
      this.options.logger.warn("Calendar event sync failed", { key, error });
    }
  }

  /** Over: finish it. Gone before it ended: staff removed it, so delete it. */
  private async retire(guild: GuildPort, key: string, record: CalendarEventRecord, now: number): Promise<void> {
    if (record.endsAt <= now) {
      if (record.status === "active") {
        await guild.editScheduledEvent(record.eventId, { status: "completed" }, REASON);
      }
      this.options.metrics.increment("calendar.completed");
    } else {
      await guild.deleteScheduledEvent(record.eventId);
      this.options.metrics.increment("calendar.deleted");
    }
    this.options.store.update((state) => {
      delete state.calendarEvents[key];
    });
  }

  private async apply(guild: GuildPort, event: CalendarEvent, now: number): Promise<void> {
    const { store, metrics } = this.options;
    const description = describeCalendarEvent(event);
    let record = store.get().calendarEvents[event.key];
    if (!record) {
      const startsAt = Math.max(event.startsAt, now + LATE_START_SECONDS);
      const eventId = await guild.createScheduledEvent(
        { name: event.name, description, startsAt: startsAt * 1000, endsAt: event.endsAt * 1000, location: LOCATION },
        REASON,
      );
      record = { eventId, name: event.name, description, startsAt: event.startsAt, endsAt: event.endsAt, status: "scheduled" };
      const created = record;
      store.update((state) => {
        state.calendarEvents[event.key] = created;
      });
      metrics.increment("calendar.created");
    } else {
      const change: Partial<ScheduledEventSpec> & { status?: Exclude<ScheduledEventStatus, "scheduled"> } = {};
      if (record.name !== event.name) {
        change.name = event.name;
      }
      if (record.description !== description) {
        change.description = description;
      }
      if (record.endsAt !== event.endsAt) {
        change.endsAt = event.endsAt * 1000;
      }
      let status = record.status;
      if (status === "scheduled" && event.startsAt <= now) {
        change.status = "active";
        status = "active";
      } else if (status === "scheduled" && record.startsAt !== event.startsAt) {
        change.startsAt = Math.max(event.startsAt, now + LATE_START_SECONDS) * 1000;
      }
      if (Object.keys(change).length > 0) {
        const kept = await guild.editScheduledEvent(record.eventId, change, REASON);
        if (!kept) {
          // Deleted on Discord: made again on the next pass.
          store.update((state) => {
            delete state.calendarEvents[event.key];
          });
          metrics.increment("calendar.lost");
          return;
        }
        record = { ...record, name: event.name, description, startsAt: event.startsAt, endsAt: event.endsAt, status };
        const edited = record;
        store.update((state) => {
          state.calendarEvents[event.key] = edited;
        });
        metrics.increment(change.status ? "calendar.started" : "calendar.updated");
      }
    }
    if (this.options.reminders && !record.remindedAt && event.startsAt > now && event.startsAt - now <= REMINDER_SECONDS) {
      this.remind(guild, event, record.eventId);
      store.update((state) => {
        const saved = state.calendarEvents[event.key];
        if (saved) {
          saved.remindedAt = now;
        }
      });
    }
  }

  private remind(guild: GuildPort, event: CalendarEvent, eventId: string): void {
    const embed = buildReminderEmbed(event, eventLink(guild.id, eventId));
    this.options.queue.enqueue(`calendar reminder ${event.key}`, async () => {
      const channel = this.options.channels.get("announcements");
      if (!channel) {
        this.options.metrics.increment("calendar.no_channel");
        return;
      }
      const mention = await this.options.pings?.mention(["event"]);
      await channel.send({ ...mention, embeds: [embed] });
      this.options.metrics.increment("calendar.reminded");
    });
  }
}
