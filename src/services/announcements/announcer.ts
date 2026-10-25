import type { APIEmbed } from "discord.js";
import type { ChannelDirectory, GuildPort, OutgoingMessage, RoleInfo } from "../../bot/ports.js";
import type { AnnouncementApi } from "../../integrations/pokeverse/gameApi.js";
import {
  FEATURES,
  type AnnouncementEvent,
  type BroadcastEvent,
  type GameEventEnvelope,
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
  /** Game announcement categories posted here. */
  categories?: Set<string>;
  /** Category -> role name each one pings on its own ("verified": the Verified Trainer role). */
  pings?: Record<string, string>;
  /** Staff broadcasts may ping the role they name. */
  staffPings?: boolean;
  verifiedRoleName?: string;
  guild?: () => GuildPort | undefined;
  /** The game's side: its features, and where the Admin window's ping list goes. */
  api?: AnnouncementApi;
  /** A link to the Discord event of a calendar occurrence, when there is one. */
  calendarLink?: (key: string) => string | undefined;
  /** Broadcasts older than this are dropped (queued while the bot was away). */
  maxEventAgeSeconds: number;
  channels: ChannelDirectory;
  queue: DeliveryQueue;
  logger: Logger;
  metrics: Metrics;
  now?: () => number;
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

const GAME_STYLE: Record<string, { name: string; emoji: string; color: number }> = {
  event: { name: "Event", emoji: "⭐", color: 0xf5b82e },
  legendary: { name: "Legendary", emoji: "✨", color: COLORS.legendary },
  server: { name: "Server", emoji: "🔧", color: COLORS.danger },
  staff: { name: "PokeVerse staff", emoji: "📣", color: COLORS.info },
  milestone: { name: "Milestone", emoji: "🏆", color: COLORS.success },
  news: { name: "News", emoji: "📰", color: 0x14b8a6 },
};

export function gameAnnouncementStyle(category: string): { name: string; emoji: string; color: number } {
  return GAME_STYLE[category] ?? GAME_STYLE.news!;
}

export function buildGameAnnouncementEmbed(event: AnnouncementEvent, time: number, link?: string): APIEmbed {
  const style = gameAnnouncementStyle(event.category);
  const title = event.category === "staff" ? undefined : event.title;
  const text = plain(event.text);
  return {
    author: { name: style.name },
    title: `${style.emoji} ${plain(title ?? (event.category === "staff" ? "Staff broadcast" : style.name))}`.slice(0, 256),
    description: (link ? `${text}\n\n[Event details](${link})` : text).slice(0, 4096),
    color: style.color,
    footer: event.author ? { text: `From ${event.author}` } : undefined,
    timestamp: new Date(time * 1000).toISOString(),
  };
}

/** Lower case letters and digits only, so "@seniortutor" and "@Senior_Tutor" both find "Senior Tutor". */
export function roleKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Roles staff can ping: not @everyone, not managed, and mentionable unless the bot can mention everyone. */
export function pingableRoles(roles: RoleInfo[], mentionEveryone: boolean): RoleInfo[] {
  return roles.filter((role) => !role.managed && (mentionEveryone || role.mentionable !== false));
}

/** #game-announcements: GM/staff broadcasts, game announcements and admin announcements. Restart warnings go to #server-status. */
export class Announcer {
  private readonly seen = new RecentKeys(2000);
  private readonly now: () => number;

  constructor(private readonly options: AnnouncerOptions) {
    this.now = options.now ?? Date.now;
  }

  /** A game with announcements sends staff broadcasts as announcements too, so `broadcast` would post them twice. */
  private get announcementsFromGame(): boolean {
    return this.options.api?.hasFeature(FEATURES.announcements) ?? false;
  }

  handleBroadcast(envelope: GameEventEnvelope<BroadcastEvent>): boolean {
    if (this.announcementsFromGame) {
      this.options.metrics.increment("announcements.broadcast_replaced");
      return false;
    }
    if (!this.options.broadcasts || !this.accept(envelope)) {
      return false;
    }
    this.post(`broadcast ${envelope.id}`, buildBroadcastEmbed(envelope.event, envelope.time));
    return true;
  }

  handleAnnouncement(envelope: GameEventEnvelope<AnnouncementEvent>): boolean {
    const event = envelope.event;
    if (event.category === "tip") {
      return false;
    }
    const category = GAME_STYLE[event.category] ? event.category : "news";
    if (category === "staff" ? !this.options.broadcasts : !(this.options.categories?.has(category) ?? false)) {
      this.options.metrics.increment(`announcements.skipped.${category}`);
      return false;
    }
    if (!this.accept(envelope)) {
      return false;
    }
    const ping = this.pingFor({ ...event, category });
    const link = event.calendar ? this.options.calendarLink?.(event.calendar.key) : undefined;
    const embed = buildGameAnnouncementEmbed({ ...event, category }, envelope.time, link);
    this.options.queue.enqueue(`announcement ${envelope.id}`, async () => {
      const channel = this.options.channels.get("announcements");
      if (!channel) {
        this.options.metrics.increment("announcements.no_channel");
        return;
      }
      const mention = ping ? await this.resolvePing(ping) : undefined;
      await channel.send({ ...mention, embeds: [embed] });
      this.options.metrics.increment(`announcements.game.${category}`);
    });
    return true;
  }

  /** The staff member's pick, or the category's own ping (events: only holidays and the weekend events). */
  pingFor(event: AnnouncementEvent): string | undefined {
    if (event.ping && this.options.staffPings) {
      return event.ping;
    }
    const role = this.options.pings?.[event.category];
    if (!role) {
      return undefined;
    }
    if (event.category === "event") {
      const type = event.calendar?.type;
      return type === "holiday" || type === "server" ? role : undefined;
    }
    return role;
  }

  /** The message content and allowed mentions for a ping; undefined when the role doesn't exist. */
  async resolvePing(ping: string): Promise<Pick<OutgoingMessage, "content" | "mentionRoleIds" | "mentionEveryone"> | undefined> {
    const name = ping.replace(/^@/, "");
    const guild = this.options.guild?.();
    const canMentionAll = guild ? guild.botPermissions().some((permission) => permission === "MentionEveryone" || permission === "Administrator") : false;
    if (/^(everyone|here)$/i.test(name)) {
      if (!canMentionAll) {
        this.options.metrics.increment("announcements.ping_not_allowed");
        this.options.logger.warn("The bot needs Mention Everyone to ping @everyone and @here; posted without the ping");
        return undefined;
      }
      return { content: `@${name.toLowerCase()}`, mentionEveryone: true };
    }
    if (!guild) {
      return undefined;
    }
    const wanted = roleKey(/^verified$/i.test(name) ? (this.options.verifiedRoleName ?? "Verified Trainer") : name);
    const role = (await guild.listRoles()).find((item) => roleKey(item.name) === wanted && !item.managed);
    if (!role) {
      this.options.metrics.increment("announcements.ping_unknown_role");
      this.options.logger.warn("Announcement ping names a role the server doesn't have; posted without the ping", { ping });
      return undefined;
    }
    if (role.mentionable === false && !canMentionAll) {
      this.options.metrics.increment("announcements.ping_not_allowed");
      this.options.logger.warn("The role isn't mentionable and the bot lacks Mention Everyone; posted without the ping", { role: role.name });
      return undefined;
    }
    return { content: `<@&${role.id}>`, mentionRoleIds: [role.id] };
  }

  /** Tells the game which roles the Admin window's "Ping on Discord" list shows. */
  async syncRoles(): Promise<void> {
    const { api, guild: getGuild } = this.options;
    const guild = getGuild?.();
    if (!api?.connected || !api.hasFeature(FEATURES.announcements) || !guild || !this.options.staffPings) {
      return;
    }
    const everyone = guild.botPermissions().some((permission) => permission === "MentionEveryone" || permission === "Administrator");
    const roles = pingableRoles(await guild.listRoles(), everyone).map((role) => role.name).slice(0, 50);
    await api.roles(roles, everyone);
    this.options.metrics.increment("announcements.roles_synced");
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
