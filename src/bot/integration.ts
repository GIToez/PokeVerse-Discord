import type { BotConfig } from "../config/load.js";
import { CommandRouter } from "../commands/router.js";
import { BridgeClient, type ConnectedInfo } from "../integrations/pokeverse/bridgeClient.js";
import { createAdminApi, createGameApi, createLinkApi, type GameApi, type LinkApi } from "../integrations/pokeverse/gameApi.js";
import { FEATURES, type GameEventEnvelope } from "../integrations/pokeverse/protocol.js";
import { LinkCommands } from "../commands/linkCommands.js";
import { ActivityLog } from "../services/activity/activityLog.js";
import { ActivityStore } from "../services/activity/activityStore.js";
import { GeoIp } from "../services/activity/geoip.js";
import { LinkService, type NicknameMode } from "../services/linking/linkService.js";
import { Announcer } from "../services/announcements/announcer.js";
import { CatchAnnouncer } from "../services/catches/catchAnnouncer.js";
import { ChatRelay } from "../services/chat/chatRelay.js";
import { ArtworkResolver } from "../services/pokemon/artwork.js";
import { PokemonAutocomplete } from "../services/pokemon/pokemonLookup.js";
import { SpawnAnnouncer } from "../services/spawns/spawnAnnouncer.js";
import { StatusService } from "../services/status/statusService.js";
import { ChannelSetup } from "../setup/channelSetup.js";
import { DeliveryQueue } from "../utils/deliveryQueue.js";
import type { Logger } from "../utils/logger.js";
import type { Metrics } from "../utils/metrics.js";
import type { StateStore } from "../utils/stateStore.js";
import type { ChannelDirectory, GuildPort } from "./ports.js";

export interface GameIntegrationOptions {
  config: BotConfig;
  store: StateStore;
  channels: ChannelDirectory;
  guild: () => GuildPort | undefined;
  logger: Logger;
  metrics: Metrics;
  /** Injected for tests; defaults to a BridgeClient built from the config. */
  bridge?: BridgeClient;
  now?: () => number;
  /** Delay after a bridge connect before reconciling sessions and resyncing links. */
  reconnectSyncDelayMs?: number;
}

/**
 * Everything between the game bridge and Discord, without a Discord connection:
 * services, queues and event routing. BotApp plugs discord.js into it.
 */
export class GameIntegration {
  readonly bridge: BridgeClient;
  readonly game: GameApi;
  readonly chat: ChatRelay;
  readonly catches: CatchAnnouncer;
  readonly spawns: SpawnAnnouncer;
  readonly announcer: Announcer;
  readonly status: StatusService;
  readonly setup: ChannelSetup;
  readonly commands: CommandRouter;
  readonly artwork: ArtworkResolver;
  readonly links: LinkApi;
  readonly activity: ActivityLog | undefined;
  readonly linking: LinkService | undefined;
  private readonly queues: Record<string, DeliveryQueue>;
  private resyncTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: GameIntegrationOptions) {
    const { config, logger, metrics, store, channels } = options;
    this.bridge = options.bridge ?? new BridgeClient({
      host: config.bridge.host,
      port: config.bridge.port,
      secret: config.bridge.secret,
      requestTimeoutMs: config.bridge.requestTimeoutMs,
      logger: logger.child({ component: "bridge" }),
      metrics,
    });
    this.bridge.setLastKnownBootId(store.get().lastBootId);
    this.game = createGameApi(this.bridge);
    this.artwork = new ArtworkResolver(config.artworkDir);

    const queue = (name: string, maxSize = config.deliveryQueueSize) =>
      new DeliveryQueue({ name, maxSize, maxAttempts: 4, retryDelayMs: 1000, logger: logger.child({ component: name }), metrics });
    this.queues = {
      chat: queue("chat", Math.min(config.deliveryQueueSize, 200)),
      catches: queue("catches"),
      spawns: queue("spawns"),
      announcements: queue("announcements"),
      activity: queue("activity"),
      linking: queue("linking", 1000),
    };
    this.links = createLinkApi(this.bridge);

    this.chat = new ChatRelay({
      config: config.chat,
      guildId: config.discord.guildId,
      game: this.game,
      channels,
      queue: this.queues.chat!,
      logger: logger.child({ component: "chat" }),
      metrics,
      now: options.now,
    });
    this.catches = new CatchAnnouncer({
      mode: () => store.get().catchMode ?? config.catches.mode,
      rareSpecies: config.catches.rareSpecies,
      maxEventAgeSeconds: config.catches.maxEventAgeSeconds,
      channels,
      queue: this.queues.catches!,
      artwork: this.artwork,
      logger: logger.child({ component: "catches" }),
      metrics,
      now: options.now,
    });
    this.spawns = new SpawnAnnouncer({
      config: config.spawns,
      channels,
      queue: this.queues.spawns!,
      artwork: this.artwork,
      logger: logger.child({ component: "spawns" }),
      metrics,
      now: options.now,
    });
    this.announcer = new Announcer({
      broadcasts: config.announcements.broadcasts,
      restartWarnings: config.announcements.restartWarnings,
      maxEventAgeSeconds: 600,
      channels,
      queue: this.queues.announcements!,
      logger: logger.child({ component: "announcements" }),
      metrics,
      now: options.now,
    });
    this.status = new StatusService({
      game: this.game,
      channels,
      store,
      refreshSeconds: config.status.refreshSeconds,
      logger: logger.child({ component: "status" }),
      metrics,
      now: options.now,
    });
    this.setup = new ChannelSetup(store, logger.child({ component: "setup" }), {
      activity: { enabled: config.activity.enabled, viewerRoleIds: config.activity.viewerRoleIds, viewerUserIds: config.activity.viewerUserIds },
      adminRoleIds: config.discord.adminRoleIds,
      adminUserIds: config.discord.adminUserIds,
      linking: {
        enabled: config.linking.enabled,
        roles: [
          { key: "verified", name: config.linking.verifiedRoleName },
          ...(config.linking.premiumRoleEnabled ? [{ key: "premium" as const, name: config.linking.premiumRoleName }] : []),
        ],
      },
    });
    this.activity = config.activity.enabled
      ? new ActivityLog({
          config: { ipMode: config.activity.ipMode, retentionDays: config.activity.retentionDays },
          channels,
          guild: options.guild,
          policy: (botUserId) => this.setup.privacyPolicy(botUserId),
          store: new ActivityStore({ file: config.activity.file, logger: logger.child({ component: "activity" }) }),
          geo: GeoIp.open(config.activity.geoipDatabase, logger.child({ component: "geoip" })),
          admin: createAdminApi(this.bridge),
          sessionsAvailable: () => this.bridge.hasFeature(FEATURES.playerSessions),
          queue: this.queues.activity!,
          logger: logger.child({ component: "activity" }),
          metrics,
          now: options.now,
          reconcileDelayMs: options.reconnectSyncDelayMs,
        })
      : undefined;
    this.linking = config.linking.enabled
      ? new LinkService({
          config: config.linking,
          links: this.links,
          guild: options.guild,
          store,
          logger: logger.child({ component: "linking" }),
          metrics,
        })
      : undefined;
    this.commands = new CommandRouter({
      config,
      game: this.game,
      artwork: this.artwork,
      autocomplete: new PokemonAutocomplete(this.game),
      status: this.status,
      setup: this.setup,
      announcer: this.announcer,
      store,
      guild: options.guild,
      onSettingsChanged: () => void this.status.render(),
      queueSizes: () => this.queueSizes(),
      logger: logger.child({ component: "commands" }),
      metrics,
      activity: this.activity,
      linking: this.linking
        ? {
            service: this.linking,
            api: this.links,
            commands: new LinkCommands({
              links: this.links,
              service: this.linking,
              roleNames: {
                verified: config.linking.verifiedRoleName,
                premium: config.linking.premiumRoleEnabled ? config.linking.premiumRoleName : undefined,
              },
              logger: logger.child({ component: "linking" }),
              metrics,
              now: options.now,
            }),
          }
        : undefined,
    });

    this.bridge.on("connected", (info) => this.onConnected(info));
    this.bridge.on("disconnected", (reason) => this.status.onDisconnected(reason));
    this.bridge.on("event", (envelope) => this.dispatch(envelope));
  }

  start(): void {
    this.bridge.start();
    this.status.start();
    this.activity?.start();
    this.linking?.start();
  }

  async stop(): Promise<void> {
    this.status.stop();
    clearTimeout(this.resyncTimer);
    this.activity?.stop();
    this.linking?.stop();
    this.bridge.stop();
    await Promise.race([
      Promise.all(Object.values(this.queues).map((queue) => queue.idle())),
      new Promise((resolve) => setTimeout(resolve, 5000).unref()),
    ]);
  }

  queueSizes(): Record<string, number> {
    return Object.fromEntries(Object.entries(this.queues).map(([name, queue]) => [name, queue.size]));
  }

  /** Resolves when every delivery queue is empty (used by tests). */
  async idle(): Promise<void> {
    await Promise.all(Object.values(this.queues).map((queue) => queue.idle()));
  }

  dispatch(envelope: GameEventEnvelope): void {
    try {
      const event = envelope.event;
      switch (event.kind) {
        case "chat":
          this.chat.handleGameChat({ ...envelope, event });
          break;
        case "catch":
          this.catches.handle({ ...envelope, event });
          break;
        case "spawn":
          this.spawns.handle({ ...envelope, event });
          break;
        case "broadcast":
          this.announcer.handleBroadcast({ ...envelope, event });
          break;
        case "restart_warning":
          this.announcer.handleRestartWarning({ ...envelope, event });
          break;
        case "server_state":
          this.status.onServerState({ ...envelope, event });
          break;
        case "player_login":
          this.activity?.handleLogin({ ...envelope, event });
          break;
        case "player_logout":
          this.activity?.handleLogout({ ...envelope, event });
          break;
        case "account_link":
          this.syncMember(event.discordUserId, "if_changed");
          break;
        case "account_characters":
          this.syncMember(event.discordUserId, "if_changed");
          break;
      }
    } catch (error) {
      this.options.metrics.increment("events.errors");
      this.options.logger.error("Failed to handle game event", { id: envelope.id, kind: envelope.event.kind, error });
    }
  }

  /** Re-reads a member's link from the game and syncs roles and nickname (queued, one at a time). */
  syncMember(discordUserId: string, mode: NicknameMode): void {
    const linking = this.linking;
    if (!linking) {
      return;
    }
    this.queues.linking!.enqueue("link sync", async () => {
      if (linking.available) {
        await linking.refresh(discordUserId, mode);
      }
    });
  }

  /** A member joined (or rejoined) the guild: restore their roles and nickname. */
  onMemberJoin(discordUserId: string): void {
    this.syncMember(discordUserId, "always");
  }

  private onConnected(info: ConnectedInfo): void {
    this.status.onConnected(info).catch((error: unknown) => {
      this.options.logger.warn("Status update after connect failed", { error });
    });
    this.activity?.onConnected(info);
    const linking = this.linking;
    if (linking) {
      clearTimeout(this.resyncTimer);
      this.resyncTimer = setTimeout(() => void linking.resyncAll(), this.options.reconnectSyncDelayMs ?? 5000);
      this.resyncTimer.unref();
    }
  }
}
