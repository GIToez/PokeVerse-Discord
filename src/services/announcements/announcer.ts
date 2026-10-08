import type { APIEmbed } from "discord.js";
import type { ChannelDirectory } from "../../bot/ports.js";
import type {
  BroadcastEvent,
  GameEventEnvelope,
  RestartWarningEvent,
} from "../../integrations/pokeverse/protocol.js";
import { RecentKeys } from "../../utils/dedupe.js";
import type { DeliveryQueue } from "../../utils/deliveryQueue.js";
import type { Logger } from "../../utils/logger.js";
import type { Metrics } from "../../utils/metrics.js";
import { COLORS, plain } from "../embeds.js";

export const ANNOUNCEMENT_CATEGORIES = ["news", "event", "maintenance"] as const;
export type AnnouncementCategory = (typeof ANNOUNCEMENT_CATEGORIES)[number];

export interface AnnouncerOptions {
  broadcasts: boolean;
  restartWarnings: boolean;
  /** Broadcasts/warnings older than this are dropped (queued while the bot was away). */
  maxEventAgeSeconds: number;
  channels: ChannelDirectory;
  queue: DeliveryQueue;
  logger: Logger;
  metrics: Metrics;
  now?: () => number;
}

function minutesText(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) {
    return "soon";
  }
  if (minutes <= 0) {
    return "now";
  }
  return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

export function buildBroadcastEmbed(event: BroadcastEvent, time: number): APIEmbed {
  const title = event.source === "gm" ? "Game Master broadcast" : "Staff broadcast";
  return {
    title,
    description: plain(event.text),
    color: COLORS.info,
    footer: event.author ? { text: `From ${event.author}` } : undefined,
    timestamp: new Date(time * 1000).toISOString(),
  };
}

export function buildRestartWarningEmbed(event: RestartWarningEvent, time: number): APIEmbed {
  let title: string;
  let description: string;
  let color: number = COLORS.warning;
  switch (event.reason) {
    case "global_save":
      title = "Server save";
      description = `The server will save ${minutesText(event.minutes)}${event.shutdown ? " and then shut down" : ""}. ` +
        "Please find a safe place.";
      break;
    case "shutdown":
      title = "Server restart";
      description = `The server will shut down ${minutesText(event.minutes)}. Please log out safely.`;
      color = COLORS.danger;
      break;
    case "shutdown_cancelled":
      title = "Restart cancelled";
      description = "The scheduled server shutdown was cancelled.";
      color = COLORS.success;
      break;
    default:
      title = "Server notice";
      description = `Server event: ${plain(event.reason)} ${minutesText(event.minutes)}.`;
  }
  return { title, description, color, timestamp: new Date(time * 1000).toISOString() };
}

const CATEGORY_STYLE: Record<AnnouncementCategory, { title: string; color: number }> = {
  news: { title: "News", color: COLORS.info },
  event: { title: "Event", color: COLORS.legendary },
  maintenance: { title: "Maintenance", color: COLORS.warning },
};

export function buildManualAnnouncementEmbed(
  category: AnnouncementCategory,
  title: string | undefined,
  text: string,
  author: string,
  now: number,
): APIEmbed {
  const style = CATEGORY_STYLE[category];
  return {
    title: title ? `${style.title}: ${title}` : style.title,
    description: text,
    color: style.color,
    footer: { text: `Posted by ${author}` },
    timestamp: new Date(now).toISOString(),
  };
}

/** #game-announcements: GM/staff broadcasts, restart warnings and admin announcements. */
export class Announcer {
  private readonly seen = new RecentKeys(2000);
  private readonly now: () => number;

  constructor(private readonly options: AnnouncerOptions) {
    this.now = options.now ?? Date.now;
  }

  handleBroadcast(envelope: GameEventEnvelope<BroadcastEvent>): boolean {
    if (!this.options.broadcasts || !this.accept(envelope)) {
      return false;
    }
    this.post(`broadcast ${envelope.id}`, buildBroadcastEmbed(envelope.event, envelope.time));
    return true;
  }

  handleRestartWarning(envelope: GameEventEnvelope<RestartWarningEvent>): boolean {
    if (!this.options.restartWarnings || !this.accept(envelope)) {
      return false;
    }
    this.post(`restart ${envelope.id}`, buildRestartWarningEmbed(envelope.event, envelope.time));
    return true;
  }

  /** Admin announcement from /pokeverse announce. Resolves with the message id. */
  async announce(category: AnnouncementCategory, title: string | undefined, text: string, author: string): Promise<string> {
    const channel = this.options.channels.get("announcements");
    if (!channel) {
      throw new Error("The announcements channel is not configured. Run /pokeverse setup first.");
    }
    const id = await channel.send({ embeds: [buildManualAnnouncementEmbed(category, title, text, author, this.now())] });
    this.options.metrics.increment("announcements.manual");
    return id;
  }

  private accept(envelope: GameEventEnvelope): boolean {
    if (this.now() / 1000 - envelope.time > this.options.maxEventAgeSeconds) {
      this.options.metrics.increment("announcements.stale");
      return false;
    }
    return this.seen.add(envelope.id);
  }

  private post(label: string, embed: APIEmbed): void {
    this.options.queue.enqueue(label, async () => {
      const channel = this.options.channels.get("announcements");
      if (!channel) {
        this.options.metrics.increment("announcements.no_channel");
        return;
      }
      await channel.send({ embeds: [embed] });
      this.options.metrics.increment("announcements.posted");
    });
  }
}
