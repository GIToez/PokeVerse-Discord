import type { APIEmbed } from "discord.js";
import type { ChannelDirectory } from "../../bot/ports.js";
import type { ConnectedInfo } from "../../integrations/pokeverse/bridgeClient.js";
import type { GameApi } from "../../integrations/pokeverse/gameApi.js";
import type { GameEventEnvelope, ServerStateEvent } from "../../integrations/pokeverse/protocol.js";
import { discordTimestamp, formatDuration } from "../../utils/format.js";
import type { Logger } from "../../utils/logger.js";
import type { Metrics } from "../../utils/metrics.js";
import type { StateStore } from "../../utils/stateStore.js";
import { COLORS, plain } from "../embeds.js";

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
}

export interface StatusServiceOptions {
  game: GameApi;
  channels: ChannelDirectory;
  store: StateStore;
  refreshSeconds: number;
  logger: Logger;
  metrics: Metrics;
  now?: () => number;
}

const STATE_LABELS: Record<string, string> = {
  normal: "Online",
  init: "Starting",
  startup: "Starting",
  maintain: "Maintenance (staff only)",
  closed: "Closed",
  closing: "Closing",
  shutdown: "Shutting down",
};

export function describeState(snapshot: StatusSnapshot): { label: string; color: number } {
  if (!snapshot.online) {
    return { label: "Offline", color: COLORS.danger };
  }
  const state = snapshot.state ?? "normal";
  const label = STATE_LABELS[state] ?? state;
  return { label, color: state === "normal" ? COLORS.success : COLORS.warning };
}

export function buildStatusEmbed(snapshot: StatusSnapshot, now: number): APIEmbed {
  const { label, color } = describeState(snapshot);
  const fields: NonNullable<APIEmbed["fields"]> = [{ name: "Status", value: label, inline: true }];
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
    void this.render();
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
        this.snapshot.updatedAt = this.now();
      } catch (error) {
        this.options.logger.warn("Could not read the server status", { error });
      }
    } else {
      this.snapshot.online = false;
    }
    await this.render();
    return { ...this.snapshot };
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
