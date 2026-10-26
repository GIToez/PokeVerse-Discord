import type { APIEmbed } from "discord.js";
import type { ChannelDirectory } from "../../bot/ports.js";
import type { ConnectedInfo } from "../../integrations/pokeverse/bridgeClient.js";
import type { GameApi } from "../../integrations/pokeverse/gameApi.js";
import type { GameEventEnvelope, RestartReason, RestartWarningEvent, ServerStateEvent } from "../../integrations/pokeverse/protocol.js";
import { discordTimestamp, formatDuration } from "../../utils/format.js";
import type { Logger } from "../../utils/logger.js";
import type { Metrics } from "../../utils/metrics.js";
import type { StateStore } from "../../utils/stateStore.js";
import { COLORS, plain } from "../embeds.js";
import type { PingRoles } from "../pings/pingRoles.js";

export interface StatusSnapshot {
  online: boolean;
  serverName: string | undefined;
  /** Game state from the server (normal, maintain, closing, shutdown...). */
  state: string | undefined;
  playersOnline: number | undefined;
  maxPlayers: number | undefined;
  /** Unix seconds when the current game run started. */
  startedAt: number | undefined;
  bootId: string | undefined;
  lastRestartAt: number | undefined;
  lastDisconnectAt: number | undefined;
  lastDisconnectReason: string | undefined;
  /** Bridge disconnects seen since the bot started. */
  disconnects: number;
  /** Unix ms of the last successful status read. */
  updatedAt: number | undefined;
  /** The next restart the game has planned (server.status). */
  scheduledRestart: { at: number; reason: RestartReason } | undefined;
  /** A restart or save the game is counting down to (restart_warning events), unix seconds. */
  warning: RestartCountdown | undefined;
}

export interface RestartCountdown {
  at: number;
  kind: "restart" | "save";
  /** The game run that sent the warning; a different boot id means the restart happened. */
  bootId?: string;
}

/** A save is over shortly after its time; a restart the server didn't do is stale after this too. */
const COUNTDOWN_GRACE_S = 120;
/** How long after a warned restart an unreachable server shows as "Restarting" rather than "Offline". */
const RESTARTING_WINDOW_S = 600;
/** A warning's minutes are rounded; a planned restart this close to it is the same restart. */
const SAME_RESTART_S = 90;

const RESTART_LABELS: Record<RestartReason, string> = {
  daily: "Daily restart",
  staff: "Restart scheduled by staff",
  update: "Update restart",
};

/** The countdown that still applies at `now` (unix seconds), if any. */
export function activeCountdown(snapshot: StatusSnapshot, now: number): RestartCountdown | undefined {
  const warning = snapshot.warning;
  if (!warning) {
    return undefined;
  }
  if (warning.kind === "restart" && !snapshot.online) {
    return now <= warning.at + RESTARTING_WINDOW_S ? warning : undefined;
  }
  if (warning.kind === "restart" && warning.bootId !== undefined && snapshot.bootId !== undefined && warning.bootId !== snapshot.bootId) {
    return undefined;
  }
  return now <= warning.at + COUNTDOWN_GRACE_S ? warning : undefined;
}

export interface StatusServiceOptions {
  game: GameApi;
  channels: ChannelDirectory;
  store: StateStore;
  refreshSeconds: number;
  /** Restart countdowns and maintenance ping Server Pings in a post of their own. */
  pings?: PingRoles;
  logger: Logger;
  metrics: Metrics;
  now?: () => number;
}

type ServerNotice = "restart" | "maintenance";

const STATE_LABELS: Record<string, string> = {
  normal: "Online",
  init: "Starting",
  startup: "Starting",
  maintain: "Maintenance (staff only)",
  closed: "Closed",
  closing: "Closing",
  shutdown: "Shutting down",
};

export function describeState(snapshot: StatusSnapshot, now = Date.now() / 1000): { label: string; color: number } {
  const countdown = activeCountdown(snapshot, now);
  if (!snapshot.online) {
    return countdown?.kind === "restart" ? { label: "Restarting", color: COLORS.warning } : { label: "Offline", color: COLORS.danger };
  }
  const state = snapshot.state ?? "normal";
  if (state === "normal" && countdown?.kind === "restart") {
    return { label: "Restarting soon", color: COLORS.warning };
  }
  const label = STATE_LABELS[state] ?? state;
  return { label, color: state === "normal" ? COLORS.success : COLORS.warning };
}

function when(at: number): string {
  return `${discordTimestamp(at, "t")} (${discordTimestamp(at, "R")})`;
}

export function buildStatusEmbed(snapshot: StatusSnapshot, now: number): APIEmbed {
  const nowS = now / 1000;
  const { label, color } = describeState(snapshot, nowS);
  const countdown = activeCountdown(snapshot, nowS);
  const fields: NonNullable<APIEmbed["fields"]> = [{ name: "Status", value: label, inline: true }];
  let description: string | undefined;
  if (countdown?.kind === "restart") {
    description = countdown.at <= nowS || !snapshot.online
      ? "The server is restarting. You can log in again in about a minute."
      : `The server restarts ${discordTimestamp(countdown.at, "R")} (at ${discordTimestamp(countdown.at, "t")}). Please log out safely.`;
  } else if (countdown?.kind === "save") {
    description = countdown.at <= nowS
      ? "The server is saving."
      : `The server saves ${discordTimestamp(countdown.at, "R")}. Please find a safe place.`;
  }
  if (snapshot.online) {
    const players = snapshot.playersOnline ?? 0;
    fields.push({
      name: "Players online",
      value: snapshot.maxPlayers ? `${players} / ${snapshot.maxPlayers}` : String(players),
      inline: true,
    });
    if (snapshot.startedAt !== undefined) {
      fields.push({
        name: "Uptime",
        value: `${formatDuration(now / 1000 - snapshot.startedAt)} (since ${discordTimestamp(snapshot.startedAt, "f")})`,
        inline: true,
      });
    }
  }
  if (countdown?.kind === "restart" && countdown.at > nowS && snapshot.online) {
    fields.push({ name: "Next restart", value: when(countdown.at), inline: true });
  } else if (!countdown && snapshot.online && snapshot.scheduledRestart && snapshot.scheduledRestart.at > nowS) {
    fields.push({
      name: "Next restart",
      value: `${RESTART_LABELS[snapshot.scheduledRestart.reason]} at ${when(snapshot.scheduledRestart.at)}`,
      inline: true,
    });
  }
  if (snapshot.lastRestartAt !== undefined) {
    fields.push({ name: "Last restart", value: discordTimestamp(snapshot.lastRestartAt), inline: true });
  }
  if (snapshot.lastDisconnectAt !== undefined) {
    fields.push({
      name: snapshot.online ? "Last disconnect" : "Offline since",
      value: discordTimestamp(snapshot.lastDisconnectAt),
      inline: true,
    });
  }
  if (snapshot.disconnects > 0) {
    fields.push({ name: "Disconnects (since bot start)", value: String(snapshot.disconnects), inline: true });
  }
  return {
    title: `${plain(snapshot.serverName ?? "PokeVerse")} server status`,
    ...(description ? { description } : {}),
    color,
    fields,
    footer: { text: snapshot.online ? "Updates automatically" : "The game server is not reachable from the bot" },
    timestamp: new Date(snapshot.updatedAt ?? now).toISOString(),
  };
}

/**
 * Tracks game availability from bridge connects/disconnects, server_state events and
 * periodic server.status reads, and keeps a single persistent message in #server-status.
 */
export class StatusService {
  private readonly snapshot: StatusSnapshot;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | undefined;
  private rendering: Promise<void> | undefined;
  private dirty = false;
  private notices: Promise<void> = Promise.resolve();

  constructor(private readonly options: StatusServiceOptions) {
    this.now = options.now ?? Date.now;
    const saved = options.store.get();
    this.snapshot = {
      online: false,
      serverName: undefined,
      state: undefined,
      playersOnline: undefined,
      maxPlayers: undefined,
      startedAt: undefined,
      bootId: undefined,
      lastRestartAt: saved.lastRestartAt,
      lastDisconnectAt: undefined,
      lastDisconnectReason: undefined,
      disconnects: 0,
      updatedAt: undefined,
      scheduledRestart: undefined,
      warning: saved.pendingRestart,
    };
  }

  get current(): Readonly<StatusSnapshot> {
    return this.snapshot;
  }

  start(): void {
    this.stop();
    this.timer = setInterval(() => void this.refresh(), this.options.refreshSeconds * 1000);
    this.timer.unref();
    void this.render();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async onConnected(info: ConnectedInfo): Promise<void> {
    this.snapshot.online = true;
    this.snapshot.serverName = info.serverName;
    this.snapshot.bootId = info.bootId;
    const saved = this.options.store.get();
    const restarted = info.restarted || (saved.lastBootId !== undefined && saved.lastBootId !== info.bootId);
    if (restarted || (this.snapshot.warning?.bootId !== undefined && this.snapshot.warning.bootId !== info.bootId)) {
      this.setWarning(undefined);
    }
    if (restarted) {
      this.snapshot.lastRestartAt = Math.floor(this.now() / 1000);
      this.options.metrics.increment("status.restarts_detected");
      this.options.logger.info("Game server restart detected", { previousBootId: saved.lastBootId, bootId: info.bootId });
    }
    if (saved.lastBootId !== info.bootId || restarted) {
      this.options.store.update((state) => {
        state.lastBootId = info.bootId;
        if (restarted) {
          state.lastRestartAt = this.snapshot.lastRestartAt;
        }
      });
    }
    await this.refresh();
  }

  onDisconnected(reason: string): void {
    this.snapshot.online = false;
    this.snapshot.playersOnline = undefined;
    this.snapshot.lastDisconnectAt = Math.floor(this.now() / 1000);
    this.snapshot.lastDisconnectReason = reason;
    this.snapshot.disconnects += 1;
    this.options.metrics.increment("status.disconnects");
    void this.render();
  }

  onServerState(envelope: GameEventEnvelope<ServerStateEvent>): void {
    this.snapshot.state = envelope.event.state;
    if (envelope.event.players !== undefined) {
      this.snapshot.playersOnline = envelope.event.players;
    }
    this.checkMaintenance();
    void this.render();
  }

  /**
   * A restart_warning event: the countdown goes into the status message (never a new post).
   * `time`: when the game sent it, unix seconds.
   */
  onRestartWarning(event: RestartWarningEvent, time: number): void {
    switch (event.reason) {
      case "shutdown":
      case "global_save": {
        let at = time + Math.max(0, event.minutes ?? 0) * 60;
        const planned = this.snapshot.scheduledRestart;
        if (planned && Math.abs(planned.at - at) <= SAME_RESTART_S) {
          at = planned.at;
        }
        const kind = event.reason === "shutdown" || event.shutdown ? "restart" : "save";
        this.setWarning({ at, kind, ...(this.snapshot.bootId ? { bootId: this.snapshot.bootId } : {}) });
        if (kind === "restart") {
          this.notice("restart", `🔧 **Server restart** <t:${Math.round(at)}:R>. The countdown is in the status message.`);
        }
        this.options.metrics.increment("status.restart_warnings");
        void this.render();
        break;
      }
      case "shutdown_cancelled":
        this.setWarning(undefined);
        this.snapshot.scheduledRestart = undefined;
        this.options.metrics.increment("status.restart_cancelled");
        void this.refresh();
        break;
      default:
        this.options.logger.debug("Ignoring an unknown restart warning", { reason: event.reason });
    }
  }

  private setWarning(warning: RestartCountdown | undefined): void {
    if (!warning) {
      this.clearNotice("restart");
    }
    this.snapshot.warning = warning;
    if (JSON.stringify(this.options.store.get().pendingRestart) !== JSON.stringify(warning)) {
      this.options.store.update((state) => {
        state.pendingRestart = warning ? { ...warning } : undefined;
      });
    }
  }

  /** Reads server.status from the game (if connected) and re-renders. */
  async refresh(): Promise<StatusSnapshot> {
    if (this.options.game.connected) {
      try {
        const status = await this.options.game.serverStatus();
        this.snapshot.online = true;
        this.snapshot.serverName = status.serverName;
        this.snapshot.state = status.state;
        this.snapshot.playersOnline = status.playersOnline;
        this.snapshot.maxPlayers = status.maxPlayers ?? undefined;
        this.snapshot.startedAt = Math.floor(this.now() / 1000 - status.uptime);
        this.snapshot.bootId = status.bootId;
        this.snapshot.scheduledRestart = status.restart ?? undefined;
        this.snapshot.updatedAt = this.now();
      } catch (error) {
        this.options.logger.warn("Could not read the server status", { error });
      }
    } else {
      this.snapshot.online = false;
    }
    if (this.snapshot.warning && !activeCountdown(this.snapshot, this.now() / 1000)) {
      this.setWarning(undefined);
    }
    this.checkMaintenance();
    await this.render();
    return { ...this.snapshot };
  }

  /** Resolves when the Server Pings posts are written or deleted (used by tests). */
  noticesIdle(): Promise<void> {
    return this.notices;
  }

  private checkMaintenance(): void {
    if (this.snapshot.online && this.snapshot.state === "maintain") {
      this.notice("maintenance", "🛠️ **The server is closed for maintenance.** Only staff can log in until it reopens.");
    } else if (this.snapshot.online && this.snapshot.state !== undefined) {
      this.clearNotice("maintenance");
    }
  }

  /** One post at a time, one per restart or maintenance; posted only when Server Pings can be pinged. */
  private notice(reason: ServerNotice, text: string): void {
    const pings = this.options.pings;
    if (!pings?.has("server")) {
      return;
    }
    this.notices = this.notices.then(async () => {
      if (this.options.store.get().serverNotice?.reason === reason) {
        return;
      }
      const channel = this.options.channels.get("serverStatus");
      const mention = channel ? await pings.mention(["server"]) : undefined;
      if (!channel || !mention) {
        return;
      }
      await this.deleteNotice(undefined);
      const messageId = await channel.send({ ...mention, content: `${mention.content} ${text}` });
      this.options.store.update((state) => {
        state.serverNotice = { messageId, reason };
      });
      this.options.metrics.increment(`status.notice.${reason}`);
    }).catch((error: unknown) => {
      this.options.logger.warn("Could not post the Server Pings notice", { reason, error });
    });
  }

  private clearNotice(reason: ServerNotice): void {
    this.notices = this.notices.then(() => this.deleteNotice(reason)).catch((error: unknown) => {
      this.options.logger.warn("Could not delete the Server Pings notice", { reason, error });
    });
  }

  /** Deletes the saved notice (only if it is for `reason`, when given). */
  private async deleteNotice(reason: ServerNotice | undefined): Promise<void> {
    const saved = this.options.store.get().serverNotice;
    if (!saved || (reason && saved.reason !== reason)) {
      return;
    }
    const channel = this.options.channels.get("serverStatus");
    await channel?.delete(saved.messageId);
    this.options.store.update((state) => {
      state.serverNotice = undefined;
    });
  }

  embed(): APIEmbed {
    return buildStatusEmbed(this.snapshot, this.now());
  }

  /** Coalesces renders: at most one edit in flight, plus one follow-up if state changed meanwhile. */
  render(): Promise<void> {
    if (this.rendering) {
      this.dirty = true;
      return this.rendering;
    }
    this.rendering = (async () => {
      try {
        do {
          this.dirty = false;
          await this.writeMessage();
        } while (this.dirty);
      } finally {
        this.rendering = undefined;
      }
    })();
    return this.rendering;
  }

  private async writeMessage(): Promise<void> {
    const channel = this.options.channels.get("serverStatus");
    if (!channel) {
      return;
    }
    const message = { embeds: [this.embed()] };
    try {
      const existing = this.options.store.get().statusMessageId;
      if (existing && (await channel.edit(existing, message))) {
        this.options.metrics.increment("status.edits");
        return;
      }
      const id = await channel.send(message);
      this.options.store.update((state) => {
        state.statusMessageId = id;
      });
      this.options.metrics.increment("status.messages_created");
    } catch (error) {
      this.options.metrics.increment("status.failures");
      this.options.logger.warn("Could not update the status message", { error });
    }
  }
}
