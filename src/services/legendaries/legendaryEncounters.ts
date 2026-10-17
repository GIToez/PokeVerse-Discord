import type { APIEmbed } from "discord.js";
import type { BotConfig } from "../../config/load.js";
import type { ChannelDirectory, ChannelSink, OutgoingMessage } from "../../bot/ports.js";
import type { GameEventEnvelope, LegendaryEvent } from "../../integrations/pokeverse/protocol.js";
import { RecentKeys } from "../../utils/dedupe.js";
import type { DeliveryQueue } from "../../utils/deliveryQueue.js";
import { padDex } from "../../utils/format.js";
import type { Logger } from "../../utils/logger.js";
import type { Metrics } from "../../utils/metrics.js";
import type { LegendaryEncounterRecord, StateStore } from "../../utils/stateStore.js";
import { COLORS, embedMessage, plain } from "../embeds.js";
import type { ArtworkResolver } from "../pokemon/artwork.js";

export interface LegendaryEncountersOptions {
  config: BotConfig["spawns"];
  channels: ChannelDirectory;
  store: StateStore;
  queue: DeliveryQueue;
  artwork: ArtworkResolver;
  logger: Logger;
  metrics: Metrics;
  now?: () => number;
}

export type LegendaryDecision =
  | { action: "post" }
  | { action: "skip"; reason: "disabled" | "no_encounter" | "stale" | "duplicate" | "unknown_encounter" };

/** Encounters are forgotten this long after they started (the longest one lasts 2 hours). */
export const ENCOUNTER_RETENTION_SECONDS = 24 * 3600;

const END_LINES: Record<string, (species: string, event: LegendaryEvent) => string> = {
  defeated: (species, event) => {
    const trainers = event.trainers ?? [];
    const by = trainers.length > 0 ? ` by ${trainers.map(plain).join(", ")}` : "";
    const top = event.topTrainer ? ` **${plain(event.topTrainer)}** has 60 seconds to throw a ball first.` : "";
    return `⚔️ The wild **${species}** was defeated${by}!${top}`;
  },
  fled: (species) => `🕊️ The wild **${species}** flew away.`,
  staff: (species) => `The wild **${species}** was sent away by staff.`,
  restart: (species) => `The wild **${species}** left before the server restart.`,
  vanished: (species) => `The wild **${species}** vanished.`,
};

const OUTCOMES: Record<string, string> = {
  defeated: "Defeated",
  fled: "Flew away",
  staff: "Sent away by staff",
  restart: "Left before the restart",
  vanished: "Vanished",
  caught: "Caught",
};

export function describeArea(event: LegendaryEvent, mode: BotConfig["spawns"]["locationMode"]): string | undefined {
  if (mode === "none") {
    return undefined;
  }
  const place = event.area ?? (event.nearestTown ? `near ${event.nearestTown}` : undefined);
  if (mode === "coordinates" && event.position) {
    const coordinates = `${event.position.x}, ${event.position.y}, ${event.position.z}`;
    return place ? `${place} (${coordinates})` : coordinates;
  }
  return place;
}

export function threadName(record: Pick<LegendaryEncounterRecord, "species" | "area">, encounterId: number): string {
  return `${record.species}${record.area ? ` near ${record.area}` : ""} #${encounterId}`.slice(0, 100);
}

/** The post in the legendary channel; edited with the outcome when the encounter ends. */
export function buildEncounterEmbed(record: LegendaryEncounterRecord, outcome?: { reason: string; detail?: string }): APIEmbed {
  const fields: NonNullable<APIEmbed["fields"]> = [];
  if (record.tier) {
    fields.push({ name: "Tier", value: record.tier >= 2 ? "Tier 2" : "Tier 1", inline: true });
  }
  if (record.location) {
    fields.push({ name: "Spawned", value: plain(record.location), inline: true });
  }
  if (outcome) {
    fields.push({ name: "Outcome", value: outcome.detail ? `${OUTCOMES[outcome.reason] ?? plain(outcome.reason)}: ${outcome.detail}` : (OUTCOMES[outcome.reason] ?? plain(outcome.reason)), inline: false });
  } else if (record.endsAt) {
    fields.push({ name: "Flies off", value: `<t:${Math.floor(record.endsAt)}:R> unless it is beaten`, inline: true });
  }
  const species = plain(record.species);
  return {
    author: { name: "Wild legendary" },
    title: outcome ? `👑 ${record.species}: ${OUTCOMES[outcome.reason] ?? outcome.reason}` : `👑 A wild ${record.species} appeared!`,
    description: outcome
      ? `The encounter is over. The thread below has the whole chase.`
      : `**${species}** appeared${record.area ? ` near **${plain(record.area)}**` : ""}! Recommended for trainers level 50+. It roams Kanto: follow the thread for sightings.`,
    color: outcome ? COLORS.neutral : COLORS.legendary,
    fields,
    footer: record.dexNumber ? { text: `Pokédex #${padDex(record.dexNumber)}` } : undefined,
    timestamp: new Date(record.startedAt * 1000).toISOString(),
  };
}

export function threadLine(event: LegendaryEvent, location: string | undefined): string | undefined {
  const species = plain(event.species);
  const where = location ? ` near **${plain(location)}**` : "";
  switch (event.event) {
    case "sighting":
      return `📍 **${species}** was spotted${where}.`;
    case "flee": {
      const health = event.healthPercent !== null && event.healthPercent !== undefined ? ` with ${Math.round(event.healthPercent)}% health` : "";
      return `💨 **${species}** fled${where}${health}!`;
    }
    case "end":
      return (END_LINES[event.reason ?? ""] ?? ((name: string) => `The wild **${name}** is gone.`))(species, event);
    case "caught":
      return `🎉 **${plain(event.trainer ?? "A trainer")}** caught the wild **${species}**!`;
    default:
      return undefined;
  }
}

/**
 * One post per wild legendary in #legendary-spawns, with a thread for its sightings, flees and
 * end. The encounters are saved, so a bot restart keeps posting into the same thread.
 */
export class LegendaryEncounters {
  private readonly seen = new RecentKeys(5000);
  /** Spawns queued but not posted yet, so updates right behind them aren't dropped. */
  private readonly queuedSpawns = new RecentKeys(100);
  private readonly now: () => number;

  constructor(private readonly options: LegendaryEncountersOptions) {
    this.now = options.now ?? Date.now;
  }

  private nowSeconds(): number {
    return Math.floor(this.now() / 1000);
  }

  decide(envelope: GameEventEnvelope<LegendaryEvent>): LegendaryDecision {
    const event = envelope.event;
    if (!this.options.config.legendaryEnabled) {
      return { action: "skip", reason: "disabled" };
    }
    if (event.encounterId === null || event.encounterId === undefined) {
      return { action: "skip", reason: "no_encounter" };
    }
    const known = this.options.store.get().legendaryEncounters[String(event.encounterId)];
    if (event.event === "spawn") {
      if (event.endsAt && event.endsAt < this.nowSeconds()) {
        return { action: "skip", reason: "stale" };
      }
    } else if (!known && !this.queuedSpawns.has(String(event.encounterId))) {
      return { action: "skip", reason: "unknown_encounter" };
    } else if (event.event === "sighting" && this.nowSeconds() - envelope.time > this.options.config.maxEventAgeSeconds) {
      return { action: "skip", reason: "stale" };
    }
    if (!this.seen.add(envelope.id)) {
      return { action: "skip", reason: "duplicate" };
    }
    return { action: "post" };
  }

  handle(envelope: GameEventEnvelope<LegendaryEvent>): LegendaryDecision {
    const decision = this.decide(envelope);
    const { metrics, queue } = this.options;
    if (decision.action === "skip") {
      metrics.increment(`legendaries.skipped.${decision.reason}`);
      return decision;
    }
    const event = envelope.event;
    if (event.event === "spawn") {
      this.queuedSpawns.add(String(event.encounterId));
    }
    queue.enqueue(`legendary ${event.event} ${envelope.id}`, () =>
      event.event === "spawn" ? this.postSpawn(envelope) : this.postUpdate(envelope));
    return decision;
  }

  private async postSpawn(envelope: GameEventEnvelope<LegendaryEvent>): Promise<void> {
    const { channels, store, artwork, metrics, logger } = this.options;
    const event = envelope.event;
    const channel = channels.get("legendarySpawns");
    if (!channel) {
      metrics.increment("legendaries.no_channel");
      return;
    }
    const encounterId = event.encounterId!;
    const record: LegendaryEncounterRecord = {
      channelId: channel.id,
      messageId: "",
      species: event.species,
      dexNumber: event.dexNumber ?? undefined,
      tier: event.tier ?? undefined,
      area: event.area ?? undefined,
      location: describeArea(event, this.options.config.locationMode),
      endsAt: event.endsAt ?? undefined,
      startedAt: envelope.time,
    };
    record.messageId = await channel.send(embedMessage(buildEncounterEmbed(record), artwork.resolve(event.dexNumber), "image"));
    if (channel.startThread) {
      try {
        const thread = await channel.startThread(record.messageId, threadName(record, encounterId));
        record.threadId = thread.id;
      } catch (error) {
        metrics.increment("legendaries.thread_failed");
        logger.warn("Could not start the legendary thread; updates go to the channel", { encounterId, error });
      }
    }
    const cutoff = this.nowSeconds() - ENCOUNTER_RETENTION_SECONDS;
    store.update((state) => {
      for (const [id, saved] of Object.entries(state.legendaryEncounters)) {
        if (saved.startedAt < cutoff) {
          delete state.legendaryEncounters[id];
        }
      }
      state.legendaryEncounters[String(encounterId)] = record;
    });
    metrics.increment("legendaries.spawn");
    logger.info("Announced wild legendary", { encounterId, species: event.species, thread: record.threadId });
  }

  private async postUpdate(envelope: GameEventEnvelope<LegendaryEvent>): Promise<void> {
    const { store, metrics } = this.options;
    const event = envelope.event;
    const key = String(event.encounterId);
    const record = store.get().legendaryEncounters[key];
    const channel = this.options.channels.get("legendarySpawns");
    if (!record || !channel) {
      metrics.increment("legendaries.no_channel");
      return;
    }
    const line = threadLine(event, describeArea(event, this.options.config.locationMode));
    if (!line) {
      return;
    }
    const thread = record.threadId && channel.thread ? await channel.thread(record.threadId) : undefined;
    const target: ChannelSink = thread ?? channel;
    await target.send({ content: thread ? line : `${line} (encounter #${key})` });
    metrics.increment(`legendaries.${event.event}`);

    const ended = event.event === "end" || event.event === "caught";
    if (!ended) {
      return;
    }
    const reason = event.event === "caught" ? "caught" : (event.reason ?? "vanished");
    const detail = event.event === "caught"
      ? (event.trainer ? plain(event.trainer) : undefined)
      : reason === "defeated" && event.trainers && event.trainers.length > 0 ? event.trainers.map(plain).join(", ") : undefined;
    const message: OutgoingMessage = embedMessage(buildEncounterEmbed(record, { reason, detail }), this.options.artwork.resolve(record.dexNumber), "image");
    if (channel.id === record.channelId) {
      await channel.edit(record.messageId, message);
    }
    store.update((state) => {
      const saved = state.legendaryEncounters[key];
      if (saved) {
        saved.endedAt = this.nowSeconds();
      }
    });
    // A defeat can still be followed by the catch; the thread then archives itself after an hour.
    if (thread && reason !== "defeated") {
      await thread.archive().catch((error: unknown) => {
        metrics.increment("legendaries.archive_failed");
        this.options.logger.warn("Could not archive the legendary thread", { encounterId: key, error });
      });
    }
  }
}
