import type { APIEmbed } from "discord.js";
import type { BotConfig } from "../../config/load.js";
import type { ChannelDirectory } from "../../bot/ports.js";
import type { GameEventEnvelope, SpawnEvent } from "../../integrations/pokeverse/protocol.js";
import { RecentKeys } from "../../utils/dedupe.js";
import type { DeliveryQueue } from "../../utils/deliveryQueue.js";
import { padDex } from "../../utils/format.js";
import type { Logger } from "../../utils/logger.js";
import type { Metrics } from "../../utils/metrics.js";
import type { ChannelPurpose } from "../../utils/stateStore.js";
import { COLORS, embedMessage, plain } from "../embeds.js";
import type { ArtworkResolver } from "../pokemon/artwork.js";

export interface SpawnAnnouncerOptions {
  config: BotConfig["spawns"];
  channels: ChannelDirectory;
  queue: DeliveryQueue;
  artwork: ArtworkResolver;
  logger: Logger;
  metrics: Metrics;
  now?: () => number;
}

export type SpawnDecision =
  | { action: "announce"; channel: ChannelPurpose }
  | { action: "skip"; reason: "disabled" | "not_rare" | "source" | "startup" | "stale" | "duplicate" };

const SOURCE_LABELS: Record<string, string> = {
  spawn: "Wild spawn",
  script: "Event",
  fishing: "Fishing",
  headbutt: "Headbutt",
};

/** Single destination for each spawn; a shiny legendary goes to exactly one channel. */
export function routeSpawn(event: SpawnEvent, config: BotConfig["spawns"]): ChannelPurpose | undefined {
  const legendary = event.legendary && config.legendaryEnabled;
  const shiny = event.shiny && config.shinyEnabled;
  if (legendary && shiny) {
    return config.shinyLegendaryRoute === "shiny" ? "shinySpawns" : "legendarySpawns";
  }
  if (legendary) {
    return "legendarySpawns";
  }
  if (shiny) {
    return "shinySpawns";
  }
  return undefined;
}

export function describeLocation(event: SpawnEvent, mode: BotConfig["spawns"]["locationMode"]): string | undefined {
  if (mode === "none") {
    return undefined;
  }
  const town = event.nearestTown ? `near ${event.nearestTown}` : undefined;
  if (mode === "town") {
    return town;
  }
  if (!event.position) {
    return town;
  }
  const coordinates = `${event.position.x}, ${event.position.y}, ${event.position.z}`;
  return town ? `${town} (${coordinates})` : coordinates;
}

export function buildSpawnEmbed(event: SpawnEvent, time: number, location: string | undefined): APIEmbed {
  const kind = event.shiny && event.legendary ? "Shiny legendary" : event.legendary ? "Legendary" : "Shiny";
  const fields: NonNullable<APIEmbed["fields"]> = [{ name: "Pokemon", value: plain(event.species), inline: true }];
  if (event.level !== null && event.level !== undefined && event.level > 0) {
    fields.push({ name: "Level", value: String(event.level), inline: true });
  }
  fields.push({ name: "Source", value: SOURCE_LABELS[event.source] ?? plain(event.source), inline: true });
  if (location) {
    fields.push({ name: "Location", value: plain(location), inline: false });
  }
  return {
    title: `${kind} spotted: ${event.species}`,
    description: `A ${kind.toLowerCase()} **${plain(event.species)}** has appeared!`,
    color: event.legendary ? COLORS.legendary : COLORS.shiny,
    fields,
    footer: event.dexNumber ? { text: `Pokedex #${padDex(event.dexNumber)}` } : undefined,
    timestamp: new Date(time * 1000).toISOString(),
  };
}

/** Shiny and legendary spawn alerts, driven by the game's spawn events (no polling). */
export class SpawnAnnouncer {
  private readonly seen = new RecentKeys(5000);
  private readonly now: () => number;

  constructor(private readonly options: SpawnAnnouncerOptions) {
    this.now = options.now ?? Date.now;
  }

  decide(envelope: GameEventEnvelope<SpawnEvent>): SpawnDecision {
    const { config } = this.options;
    const event = envelope.event;
    if (!event.shiny && !event.legendary) {
      return { action: "skip", reason: "not_rare" };
    }
    const channel = routeSpawn(event, config);
    if (!channel) {
      return { action: "skip", reason: "disabled" };
    }
    if (!config.sources.has(event.source)) {
      return { action: "skip", reason: "source" };
    }
    if (event.startup && !config.announceStartup) {
      return { action: "skip", reason: "startup" };
    }
    if (this.now() / 1000 - envelope.time > config.maxEventAgeSeconds) {
      return { action: "skip", reason: "stale" };
    }
    if (!this.seen.add(envelope.id) || !this.seen.add(`${envelope.bootId}:creature:${event.creatureId}`)) {
      return { action: "skip", reason: "duplicate" };
    }
    return { action: "announce", channel };
  }

  handle(envelope: GameEventEnvelope<SpawnEvent>): SpawnDecision {
    const { metrics, logger } = this.options;
    const decision = this.decide(envelope);
    if (decision.action === "skip") {
      metrics.increment(`spawns.skipped.${decision.reason}`);
      return decision;
    }
    const event = envelope.event;
    const message = embedMessage(
      buildSpawnEmbed(event, envelope.time, describeLocation(event, this.options.config.locationMode)),
      this.options.artwork.resolve(event.dexNumber),
    );
    this.options.queue.enqueue(`spawn ${envelope.id}`, async () => {
      const channel = this.options.channels.get(decision.channel);
      if (!channel) {
        metrics.increment("spawns.no_channel");
        return;
      }
      await channel.send(message);
      metrics.increment("spawns.announced");
      logger.info("Announced spawn", { id: envelope.id, species: event.species, channel: decision.channel });
    });
    return decision;
  }
}
