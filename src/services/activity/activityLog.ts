import type { APIEmbed } from "discord.js";
import type { ChannelDirectory, ChannelSink, GuildPort } from "../../bot/ports.js";
import type { ConnectedInfo } from "../../integrations/pokeverse/bridgeClient.js";
import type { AdminApi } from "../../integrations/pokeverse/gameApi.js";
import {
  type GameEventEnvelope,
  type PlayerLoginEvent,
  type PlayerLogoutEvent,
} from "../../integrations/pokeverse/protocol.js";
import type { DeliveryQueue } from "../../utils/deliveryQueue.js";
import { discordTimestamp, formatDuration } from "../../utils/format.js";
import type { Logger } from "../../utils/logger.js";
import type { Metrics } from "../../utils/metrics.js";
import { COLORS, plain } from "../embeds.js";
import type { ActivityStore, SessionRecord } from "./activityStore.js";
import type { GeoIp } from "./geoip.js";
import { maskIp } from "./ip.js";
import { checkPrivacy, type PrivacyCheck, type PrivacyPolicy } from "./privacy.js";

export interface ActivityLogOptions {
  config: { ipMode: "full" | "masked" | "hidden"; retentionDays: number };
  channels: ChannelDirectory;
  guild: () => GuildPort | undefined;
  policy: (botUserId: string) => PrivacyPolicy;
  store: ActivityStore;
  geo: GeoIp;
  admin: AdminApi;
  /** True when the connected game server sends player sessions. */
  sessionsAvailable: () => boolean;
  queue: DeliveryQueue;
  logger: Logger;
  metrics: Metrics;
  now?: () => number;
  /** Delay after a bridge connect before reconciling, so queued events arrive first. */
  reconcileDelayMs?: number;
}

/** Only reasons the game reports; anything else is shown as sent. */
const REASON_TEXT: Record<string, string> = {
  logout: "Logged out",
  connection_lost: "Connection lost",
  timeout: "Timed out (no answer from the client)",
  kick: "Kicked by staff",
  death: "Died",
  shutdown: "Server shutdown",
  server_closed: "Server closed to players",
};

const CLIENT_TEXT: Record<string, string> = {
  windows: "Classic client (Windows)",
  linux: "Classic client (Linux)",
  flash: "Flash client",
  "otclient-windows": "OTClient (Windows)",
  "otclient-linux": "OTClient (Linux)",
  "otclient-mac": "OTClient (macOS)",
};

const WARN_INTERVAL_MS = 60_000;
const RETENTION_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Staff-only login/logout log in #player-activity.
 *
 * - Every post first checks that the channel is still private; otherwise nothing is posted.
 * - IP addresses go only into that channel (full, masked or hidden by config). They are never
 *   logged, stored on disk or shown anywhere else.
 * - A bridge disconnect never ends a session. When the game restarted (new boot id), sessions
 *   left open are closed as "ended by restart"; after a reconnect to the same server run,
 *   sessions the game no longer has are closed as "logout not received".
 * - Session records and posted messages are deleted after the retention period.
 */
export class ActivityLog {
  private readonly now: () => number;
  private lastPrivacyWarning = 0;
  private retentionTimer: NodeJS.Timeout | undefined;
  private reconcileTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: ActivityLogOptions) {
    this.now = options.now ?? Date.now;
  }

  start(): void {
    this.retentionTimer = setInterval(() => void this.enforceRetention(), RETENTION_INTERVAL_MS);
    this.retentionTimer.unref();
    void this.enforceRetention();
  }

  stop(): void {
    clearInterval(this.retentionTimer);
    clearTimeout(this.reconcileTimer);
    this.options.store.flush();
  }

  /** Current privacy state of #player-activity (diagnostics). */
  privacy(): PrivacyCheck | undefined {
    const guild = this.options.guild();
    const sink = this.options.channels.get("playerActivity");
    if (!guild || !sink) {
      return undefined;
    }
    return checkPrivacy(guild.channelAccess(sink.id), this.options.policy(guild.botUserId));
  }

  handleLogin(envelope: GameEventEnvelope<PlayerLoginEvent>): void {
    const event = envelope.event;
    const added = this.options.store.add({
      sessionId: event.sessionId,
      bootId: envelope.bootId,
      character: event.character,
      level: event.level,
      loginTime: event.loginTime,
      recordedAt: this.seconds(),
    });
    if (!added) {
      this.options.metrics.increment("activity.duplicates");
      return;
    }
    this.options.metrics.increment("activity.logins");
    this.post(event.sessionId, "login", { embeds: [this.loginEmbed(event)] });
  }

  handleLogout(envelope: GameEventEnvelope<PlayerLogoutEvent>): void {
    const event = envelope.event;
    const known = this.options.store.get(event.sessionId);
    if (known?.ended) {
      this.options.metrics.increment("activity.duplicates");
      return;
    }
    if (!known) {
      this.options.store.add({
        sessionId: event.sessionId,
        bootId: envelope.bootId,
        character: event.character,
        level: event.level,
        loginTime: event.loginTime,
        recordedAt: this.seconds(),
      });
    }
    this.options.store.update(event.sessionId, (record) => {
      record.level = event.level;
      record.logoutTime = event.logoutTime;
      record.ended = "logout";
    });
    this.options.metrics.increment("activity.logouts");
    this.post(event.sessionId, "logout", { embeds: [this.logoutEmbed(event)] });
  }

  /** Called on every bridge connect; reconciles after queued events had time to arrive. */
  onConnected(info: ConnectedInfo): void {
    clearTimeout(this.reconcileTimer);
    this.reconcileTimer = setTimeout(() => void this.reconcile(info.bootId), this.options.reconcileDelayMs ?? 3000);
    this.reconcileTimer.unref();
  }

  async reconcile(bootId: string): Promise<void> {
    for (const record of this.options.store.open()) {
      if (record.bootId !== bootId) {
        this.close(record, "restart");
      }
    }
    if (!this.options.admin.connected || !this.options.sessionsAvailable()) {
      return;
    }
    let online: Awaited<ReturnType<AdminApi["sessions"]>>;
    try {
      online = await this.options.admin.sessions();
    } catch (error) {
      this.options.logger.warn("Could not read the open game sessions", { error });
      return;
    }
    const onlineIds = new Set(online.sessions.map((session) => session.sessionId));
    for (const record of this.options.store.open()) {
      if (record.bootId === bootId && !onlineIds.has(record.sessionId)) {
        this.close(record, "missed");
      }
    }
    for (const session of online.sessions) {
      this.options.store.add({ ...session, bootId, recordedAt: this.seconds() });
    }
  }

  async enforceRetention(): Promise<void> {
    const cutoff = this.seconds() - this.options.config.retentionDays * 86400;
    const messages = this.options.store.expire(cutoff);
    if (messages.length === 0) {
      return;
    }
    const sink = this.options.channels.get("playerActivity");
    this.options.logger.info("Deleting expired activity messages", { count: messages.length, retentionDays: this.options.config.retentionDays });
    for (const id of messages) {
      this.options.queue.enqueue("activity retention", async () => {
        if (sink) {
          await sink.delete(id);
          this.options.metrics.increment("activity.messages_expired");
        }
      });
    }
  }

  private close(record: SessionRecord, ended: "restart" | "missed"): void {
    this.options.store.update(record.sessionId, (next) => {
      next.ended = ended;
    });
    this.options.metrics.increment(`activity.closed_${ended}`);
    const embed: APIEmbed = {
      title: ended === "restart" ? "Session ended by a server restart" : "Session ended",
      color: COLORS.warning,
      fields: [
        { name: "Character", value: plain(record.character), inline: true },
        { name: "Level", value: String(record.level), inline: true },
        ...(record.loginTime ? [{ name: "Login", value: discordTimestamp(record.loginTime, "f"), inline: true }] : []),
        {
          name: "Logout",
          value: ended === "restart"
            ? "Not received: the game server restarted, so the exact logout time is unknown."
            : `Not received: the character was no longer online at ${discordTimestamp(this.seconds(), "f")}.`,
        },
        { name: "Session", value: record.sessionId, inline: true },
      ],
      footer: { text: this.footer() },
    };
    this.post(record.sessionId, `close ${ended}`, { embeds: [embed] });
  }

  private post(sessionId: string, label: string, message: { embeds: APIEmbed[] }): void {
    this.options.queue.enqueue(`activity ${label}`, async () => {
      const sink = this.privateSink();
      if (!sink) {
        return;
      }
      const id = await sink.send(message);
      this.options.store.addMessage(sessionId, id);
      this.options.metrics.increment("activity.posted");
    });
  }

  /** The #player-activity channel, only if it exists and is private right now. */
  private privateSink(): ChannelSink | undefined {
    const sink = this.options.channels.get("playerActivity");
    const guild = this.options.guild();
    if (!sink || !guild) {
      this.options.metrics.increment("activity.skipped_no_channel");
      return undefined;
    }
    const privacy = checkPrivacy(guild.channelAccess(sink.id), this.options.policy(guild.botUserId));
    if (!privacy.private) {
      this.options.metrics.increment("activity.blocked_not_private");
      if (this.now() - this.lastPrivacyWarning > WARN_INTERVAL_MS) {
        this.lastPrivacyWarning = this.now();
        this.options.logger.error("#player-activity is not private; activity is not posted until it is fixed", {
          problems: privacy.problems,
        });
      }
      return undefined;
    }
    return sink;
  }

  private loginEmbed(event: PlayerLoginEvent): APIEmbed {
    const fields: NonNullable<APIEmbed["fields"]> = [
      { name: "Character", value: plain(event.character), inline: true },
      { name: "Level", value: String(event.level), inline: true },
      { name: "Account", value: `#${event.accountId}`, inline: true },
      { name: "Time", value: discordTimestamp(event.loginTime, "f"), inline: true },
    ];
    const ipMode = this.options.config.ipMode;
    if (ipMode !== "hidden") {
      fields.push({
        name: "IP address",
        value: event.ip ? (ipMode === "full" ? `\`${event.ip}\`` : maskIp(event.ip)) : "Not sent by the game",
        inline: true,
      });
    }
    if (event.ip && (this.options.geo.enabled || ipMode !== "hidden")) {
      const geo = this.options.geo.lookup(event.ip);
      if (geo) {
        fields.push({ name: "Location (approximate)", value: geo.anonymizer ? `${geo.label} (${geo.anonymizer})` : geo.label, inline: true });
      } else if (!this.options.geo.enabled) {
        fields.push({ name: "Location", value: "GeoIP disabled", inline: true });
      }
    }
    if (event.playersOnline !== undefined) {
      fields.push({ name: "Players online", value: String(event.playersOnline), inline: true });
    }
    if (event.clientOs) {
      const client = CLIENT_TEXT[event.clientOs] ?? "Unknown client";
      fields.push({ name: "Client", value: event.clientVersion ? `${client}, protocol ${event.clientVersion}` : client, inline: true });
    }
    fields.push({ name: "Session", value: event.sessionId, inline: true });
    return { title: "Login", color: COLORS.success, fields, footer: { text: this.footer() } };
  }

  private logoutEmbed(event: PlayerLogoutEvent): APIEmbed {
    const fields: NonNullable<APIEmbed["fields"]> = [
      { name: "Character", value: plain(event.character), inline: true },
      { name: "Level", value: String(event.level), inline: true },
      { name: "Time", value: discordTimestamp(event.logoutTime, "f"), inline: true },
      { name: "Session length", value: formatDuration(event.duration), inline: true },
    ];
    if (event.reason) {
      fields.push({ name: "Reason", value: REASON_TEXT[event.reason] ?? plain(event.reason), inline: true });
    }
    if (event.playersOnline !== undefined) {
      fields.push({ name: "Players online", value: String(event.playersOnline), inline: true });
    }
    fields.push({ name: "Session", value: event.sessionId, inline: true });
    return { title: "Logout", color: COLORS.neutral, fields, footer: { text: this.footer() } };
  }

  private footer(): string {
    return `Private staff log. Kept ${this.options.config.retentionDays} days.`;
  }

  private seconds(): number {
    return Math.floor(this.now() / 1000);
  }
}
