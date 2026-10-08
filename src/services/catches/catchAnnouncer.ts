import type { APIEmbed } from "discord.js";
import type { ChannelDirectory } from "../../bot/ports.js";
import type { CatchEvent, GameEventEnvelope } from "../../integrations/pokeverse/protocol.js";
import { RecentKeys } from "../../utils/dedupe.js";
import type { DeliveryQueue } from "../../utils/deliveryQueue.js";
import { padDex } from "../../utils/format.js";
import type { Logger } from "../../utils/logger.js";
import type { Metrics } from "../../utils/metrics.js";
import type { CatchMode } from "../../utils/stateStore.js";
import { COLORS, capitalizeWords, embedMessage, plain, sexLabel } from "../embeds.js";
import type { ArtworkResolver } from "../pokemon/artwork.js";

export interface CatchAnnouncerOptions {
  /** Current mode (config default, overridable by admins at runtime). */
  mode: () => CatchMode;
  rareSpecies: Set<string>;
  maxEventAgeSeconds: number;
  channels: ChannelDirectory;
  queue: DeliveryQueue;
  artwork: ArtworkResolver;
  logger: Logger;
  metrics: Metrics;
  now?: () => number;
}

export type CatchDecision = "announce" | "mode_off" | "filtered" | "stale" | "duplicate";

export function isRareCatch(event: CatchEvent, rareSpecies: Set<string>): boolean {
  return (
    event.shiny ||
    event.legendary ||
    rareSpecies.has(event.species.toLowerCase()) ||
    rareSpecies.has(event.baseSpecies.toLowerCase())
  );
}

export function catchPassesMode(event: CatchEvent, mode: CatchMode, rareSpecies: Set<string>): boolean {
  switch (mode) {
    case "all":
      return true;
    case "rare_only":
      return isRareCatch(event, rareSpecies);
    case "shiny_legendary_only":
      return event.shiny || event.legendary;
    case "off":
      return false;
  }
}

/** "Rattata" or "Rattata +3"; the bonus is only shown when the game reports one. */
export function pokemonDisplayName(species: string, extraPoints: number | null | undefined): string {
  return extraPoints !== null && extraPoints !== undefined && extraPoints > 0 ? `${species} +${extraPoints}` : species;
}

export function buildCatchEmbed(event: CatchEvent, time: number): APIEmbed {
  const name = pokemonDisplayName(event.species, event.extraPoints);
  const tags = [
    event.legendary ? "Legendary" : undefined,
    event.shiny && !/^shiny\b/i.test(event.species) ? "Shiny" : undefined,
  ].filter(Boolean);
  const fields: NonNullable<APIEmbed["fields"]> = [
    { name: "Trainer", value: plain(event.trainer), inline: true },
    { name: "Pokemon", value: plain(name), inline: true },
    { name: "Level", value: String(event.level), inline: true },
  ];
  const sex = sexLabel(event.sex);
  if (sex) {
    fields.push({ name: "Sex", value: sex, inline: true });
  }
  if (event.ball) {
    fields.push({ name: "Ball", value: plain(capitalizeWords(event.ball)), inline: true });
  }
  if (event.safari) {
    fields.push({ name: "Area", value: "Safari Zone", inline: true });
  }
  return {
    title: `${tags.length > 0 ? `${tags.join(" ")} ` : ""}${name} caught!`,
    description: `**${plain(event.trainer)}** caught **${plain(name)}**.`,
    color: event.legendary ? COLORS.legendary : event.shiny ? COLORS.shiny : COLORS.success,
    fields,
    footer: event.dexNumber ? { text: `Pokedex #${padDex(event.dexNumber)}` } : undefined,
    timestamp: new Date(time * 1000).toISOString(),
  };
}

/**
 * Announces confirmed catches. The game only emits `catch` after the Pokemon was
 * delivered to the trainer, so failed throws never reach this service.
 */
export class CatchAnnouncer {
  private readonly seen = new RecentKeys(5000);
  private readonly now: () => number;

  constructor(private readonly options: CatchAnnouncerOptions) {
    this.now = options.now ?? Date.now;
  }

  handle(envelope: GameEventEnvelope<CatchEvent>): CatchDecision {
    const { metrics, logger } = this.options;
    const mode = this.options.mode();
    if (mode === "off") {
      metrics.increment("catches.mode_off");
      return "mode_off";
    }
    if (!catchPassesMode(envelope.event, mode, this.options.rareSpecies)) {
      metrics.increment("catches.filtered");
      return "filtered";
    }
    if (this.now() / 1000 - envelope.time > this.options.maxEventAgeSeconds) {
      metrics.increment("catches.stale");
      logger.debug("Dropping stale catch event", { id: envelope.id });
      return "stale";
    }
    if (!this.seen.add(envelope.id)) {
      metrics.increment("catches.duplicate");
      return "duplicate";
    }

    const message = embedMessage(
      buildCatchEmbed(envelope.event, envelope.time),
      this.options.artwork.resolve(envelope.event.dexNumber),
    );
    this.options.queue.enqueue(`catch ${envelope.id}`, async () => {
      const channel = this.options.channels.get("catches");
      if (!channel) {
        metrics.increment("catches.no_channel");
        return;
      }
      await channel.send(message);
      metrics.increment("catches.announced");
      logger.info("Announced catch", {
        id: envelope.id,
        trainer: envelope.event.trainer,
        species: envelope.event.species,
      });
    });
    return "announce";
  }
}
