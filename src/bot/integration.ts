import type { BotConfig } from "../config/load.js";
import { CommandRouter } from "../commands/router.js";
import { BridgeClient, type ConnectedInfo } from "../integrations/pokeverse/bridgeClient.js";
import { createGameApi, type GameApi } from "../integrations/pokeverse/gameApi.js";
import type { GameEventEnvelope } from "../integrations/pokeverse/protocol.js";
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
  private readonly queues: Record<string, DeliveryQueue>;

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
    };

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
    this.setup = new ChannelSetup(store, logger.child({ component: "setup" }));
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
    });

    this.bridge.on("connected", (info) => this.onConnected(info));
    this.bridge.on("disconnected", (reason) => this.status.onDisconnected(reason));
    this.bridge.on("event", (envelope) => this.dispatch(envelope));
  }

  start(): void {
    this.bridge.start();
    this.status.start();
  }

  async stop(): Promise<void> {
    this.status.stop();
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
      }
    } catch (error) {
      this.options.metrics.increment("events.errors");
      this.options.logger.error("Failed to handle game event", { id: envelope.id, kind: envelope.event.kind, error });
    }
  }

  private onConnected(info: ConnectedInfo): void {
    this.status.onConnected(info).catch((error: unknown) => {
      this.options.logger.warn("Status update after connect failed", { error });
    });
  }
}
