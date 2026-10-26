import type { APIEmbed } from "discord.js";
import type { BotConfig } from "../../config/load.js";
import type { ChannelDirectory, ChannelSink, OutgoingMessage, ThreadSink } from "../../bot/ports.js";
import type { GameEventEnvelope, LegendaryEvent } from "../../integrations/pokeverse/protocol.js";
import { RecentKeys } from "../../utils/dedupe.js";
import type { DeliveryQueue } from "../../utils/deliveryQueue.js";
import { padDex } from "../../utils/format.js";
import type { Logger } from "../../utils/logger.js";
import type { Metrics } from "../../utils/metrics.js";
import type { LegendaryEncounterRecord, LegendarySetRecord, StateStore } from "../../utils/stateStore.js";
import { COLORS, embedMessage, plain } from "../embeds.js";
import type { PingRoles } from "../pings/pingRoles.js";
import type { ArtworkResolver } from "../pokemon/artwork.js";

export interface LegendaryEncountersOptions {
  config: BotConfig["spawns"];
  channels: ChannelDirectory;
  store: StateStore;
  queue: DeliveryQueue;
  artwork: ArtworkResolver;
  /** A new encounter or set pings Legendary Pings (its updates don't). */
  pings?: PingRoles;
  logger: Logger;
  metrics: Metrics;
  now?: () => number;
}

export type LegendaryDecision =
  | { action: "post" }
  | { action: "skip"; reason: "disabled" | "no_encounter" | "stale" | "duplicate" | "unknown_encounter" };

/** Encounters are forgotten this long after they started (the longest one lasts 2 hours). */
export const ENCOUNTER_RETENTION_SECONDS = 24 * 3600;
const DEFAULT_LEVEL = 50;

/** Posts of their own, without an encounter. */
const STANDALONE = new Set<LegendaryEvent["event"]>(["sign", "reward"]);

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
  awake: "Awake",
};

function outcomeText(reason: string, detail?: string): string {
  const name = OUTCOMES[reason] ?? plain(reason);
  return detail ? `${name}: ${detail}` : name;
}

export function describeArea(event: Pick<LegendaryEvent, "area" | "nearestTown" | "position">, mode: BotConfig["spawns"]["locationMode"]): string | undefined {
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

function spawnDescription(record: LegendaryEncounterRecord): string {
  const species = plain(record.species);
  const where = record.area ? ` near **${plain(record.area)}**` : "";
  const level = `Recommended for trainers level ${record.level ?? DEFAULT_LEVEL}+.`;
  if (record.revealed) {
    return `A trainer found **${species}** hiding as another Pokémon${where}! It shows its true self. ${level} Follow the thread for sightings.`;
  }
  if (record.asleep) {
    return `**${species}** is sleeping${where}. Wake it up to fight it! ${level}`;
  }
  return `**${species}** appeared${where}! ${level} Follow the thread for sightings.`;
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
    fields.push({ name: "Outcome", value: outcomeText(outcome.reason, outcome.detail), inline: false });
  } else if (record.endsAt) {
    fields.push({ name: record.asleep ? "Wakes up" : "Flies off", value: record.asleep ? `Only when a trainer wakes it` : `<t:${Math.floor(record.endsAt)}:R> unless it is beaten`, inline: true });
  }
  const title = record.revealed ? `👑 ${record.species} shows its true self!` : record.asleep ? `💤 A wild ${record.species} is sleeping` : `👑 A wild ${record.species} appeared!`;
  return {
    author: { name: "Wild legendary" },
    title: outcome ? `👑 ${record.species}: ${OUTCOMES[outcome.reason] ?? outcome.reason}` : title,
    description: outcome ? `The encounter is over. The thread below has the whole chase.` : spawnDescription(record),
    color: outcome ? COLORS.neutral : COLORS.legendary,
    fields,
    footer: record.dexNumber ? { text: `Pokédex #${padDex(record.dexNumber)}` } : undefined,
    timestamp: new Date(record.startedAt * 1000).toISOString(),
  };
}

/** One post for a set; a line per member, with its outcome once it has one. */
export function buildSetEmbed(set: LegendarySetRecord): APIEmbed {
  const over = set.members.every((member) => member.ended);
  const lines = set.members.map((member) => {
    const where = member.area ? ` near **${plain(member.area)}**` : "";
    const state = member.outcome ? `: ${outcomeText(member.outcome, member.detail)}` : "";
    return `• **${plain(member.species)}**${where}${state}`;
  });
  const intro = set.asleep
    ? `**${plain(set.name)}** are sleeping across the land. Find them and wake them up!`
    : `**${plain(set.name)}** have appeared together!`;
  return {
    author: { name: "Wild legendaries" },
    title: over ? `👑 ${set.name}: the encounters are over` : set.asleep ? `💤 ${set.name} are sleeping` : `👑 ${set.name} appeared together!`,
    description: [
      over ? "Every member's encounter is over. The thread below has the whole chase." : `${intro} Recommended for trainers level ${set.level ?? DEFAULT_LEVEL}+.`,
      lines.join("\n"),
    ].join("\n\n").slice(0, 4096),
    color: over ? COLORS.neutral : COLORS.legendary,
    timestamp: new Date(set.startedAt * 1000).toISOString(),
  };
}

export function threadLine(event: LegendaryEvent, location: string | undefined): string | undefined {
  const species = plain(event.species);
  const where = location ? ` near **${plain(location)}**` : "";
  const trainer = plain(event.trainer ?? "A trainer");
  switch (event.event) {
    case "sighting":
      return event.trainer
        ? `📍 **${trainer}** spotted **${species}**${where}.`
        : `📍 **${species}** was spotted${where}.`;
    case "flee": {
      const health = event.healthPercent !== null && event.healthPercent !== undefined ? ` with ${Math.round(event.healthPercent)}% health` : "";
      return `💨 **${species}** fled${where}${health}!`;
    }
    case "end":
      return (END_LINES[event.reason ?? ""] ?? ((name: string) => `The wild **${name}** is gone.`))(species, event);
    case "caught":
      return `🎉 **${trainer}** caught the wild **${species}**!`;
    case "woke":
      return `⏰ **${trainer}** woke **${species}** up${where}! It can be fought now.`;
    case "revealed":
      return `🎭 **${trainer}** found **${species}** hiding as a wild **${plain(event.disguise ?? "Pokémon")}**! It shows its true self.`;
    case "clash":
    case "calm":
      return `${event.event === "calm" ? "🌈" : "🌩️"} ${plain(event.text ?? `${event.species} and ${event.other ?? "another legendary"} meet${where}!`)}`;
    default:
      return undefined;
  }
}

function setKey(event: LegendaryEvent): string {
  return `${event.setId ?? "set"}:${event.members?.[0]?.encounterId ?? 0}`;
}

/**
 * One post per wild legendary in #legendary-spawns, with a thread for its sightings, flees and
 * end, and one post for a set that appears together. Signs before a spawn and quest rewards
 * are posts of their own. The encounters are saved, so a bot restart keeps posting into the
 * same thread.
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

  private known(encounterId: number | null | undefined): boolean {
    if (encounterId === null || encounterId === undefined) {
      return false;
    }
    return this.options.store.get().legendaryEncounters[String(encounterId)] !== undefined || this.queuedSpawns.has(String(encounterId));
  }

  decide(envelope: GameEventEnvelope<LegendaryEvent>): LegendaryDecision {
    const event = envelope.event;
    if (!this.options.config.legendaryEnabled) {
      return { action: "skip", reason: "disabled" };
    }
    const stale = this.nowSeconds() - envelope.time > this.options.config.maxEventAgeSeconds;
    if (STANDALONE.has(event.event)) {
      if (stale) {
        return { action: "skip", reason: "stale" };
      }
    } else if (event.event === "set") {
      if (!event.members?.length) {
        return { action: "skip", reason: "no_encounter" };
      }
      if (stale) {
        return { action: "skip", reason: "stale" };
      }
    } else if (event.encounterId === null || event.encounterId === undefined) {
      return { action: "skip", reason: "no_encounter" };
    } else if (event.event === "spawn") {
      if (event.endsAt && event.endsAt < this.nowSeconds()) {
        return { action: "skip", reason: "stale" };
      }
    } else if (event.event === "clash" || event.event === "calm") {
      if (!this.known(event.encounterId) && !this.known(event.otherEncounterId)) {
        return { action: "skip", reason: "unknown_encounter" };
      }
      if (stale) {
        return { action: "skip", reason: "stale" };
      }
    } else if (!this.known(event.encounterId)) {
      if (event.event !== "revealed") {
        return { action: "skip", reason: "unknown_encounter" };
      }
    } else if (event.event === "sighting" && stale) {
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
    const starts = event.event === "spawn" || (event.event === "revealed" && !this.known(event.encounterId));
    if (starts) {
      this.queuedSpawns.add(String(event.encounterId));
    }
    if (event.event === "set") {
      for (const member of event.members ?? []) {
        this.queuedSpawns.add(String(member.encounterId));
      }
    }
    queue.enqueue(`legendary ${event.event} ${envelope.id}`, () => {
      if (STANDALONE.has(event.event)) {
        return this.postStandalone(envelope);
      }
      if (event.event === "set") {
        return this.postSet(envelope);
      }
      if (event.event === "clash" || event.event === "calm") {
        return this.postClash(envelope);
      }
      return starts ? this.postSpawn(envelope) : this.postUpdate(envelope);
    });
    return decision;
  }

  private channel(): ChannelSink | undefined {
    const channel = this.options.channels.get("legendarySpawns");
    if (!channel) {
      this.options.metrics.increment("legendaries.no_channel");
    }
    return channel;
  }

  private async startThread(channel: ChannelSink, messageId: string, name: string, encounterId: number): Promise<string | undefined> {
    if (!channel.startThread) {
      return undefined;
    }
    try {
      return (await channel.startThread(messageId, name)).id;
    } catch (error) {
      this.options.metrics.increment("legendaries.thread_failed");
      this.options.logger.warn("Could not start the legendary thread; updates go to the channel", { encounterId, error });
      return undefined;
    }
  }

  private prune(state: ReturnType<StateStore["get"]>): void {
    const cutoff = this.nowSeconds() - ENCOUNTER_RETENTION_SECONDS;
    for (const [id, saved] of Object.entries(state.legendaryEncounters)) {
      if (saved.startedAt < cutoff) {
        delete state.legendaryEncounters[id];
      }
    }
    for (const [id, saved] of Object.entries(state.legendarySets)) {
      if (saved.startedAt < cutoff) {
        delete state.legendarySets[id];
      }
    }
  }

  private async postSpawn(envelope: GameEventEnvelope<LegendaryEvent>): Promise<void> {
    const { store, artwork, metrics, logger } = this.options;
    const event = envelope.event;
    const channel = this.channel();
    if (!channel) {
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
      level: event.level ?? undefined,
      asleep: event.asleep ?? undefined,
      revealed: event.event === "revealed" || undefined,
    };
    const mention = await this.options.pings?.mention(["legendary"]);
    record.messageId = await channel.send({ ...embedMessage(buildEncounterEmbed(record), artwork.resolve(event.dexNumber), "image"), ...mention });
    record.threadId = await this.startThread(channel, record.messageId, threadName(record, encounterId), encounterId);
    store.update((state) => {
      this.prune(state);
      state.legendaryEncounters[String(encounterId)] = record;
    });
    if (event.event === "revealed" && record.threadId && channel.thread) {
      const line = threadLine(event, undefined);
      const thread = await channel.thread(record.threadId);
      if (line && thread) {
        await thread.send({ content: line });
      }
    }
    metrics.increment(`legendaries.${event.event}`);
    logger.info("Announced wild legendary", { encounterId, species: event.species, thread: record.threadId });
  }

  private async postSet(envelope: GameEventEnvelope<LegendaryEvent>): Promise<void> {
    const { store, metrics, logger } = this.options;
    const event = envelope.event;
    const channel = this.channel();
    if (!channel) {
      return;
    }
    const key = setKey(event);
    const members = event.members ?? [];
    const set: LegendarySetRecord = {
      channelId: channel.id,
      messageId: "",
      name: event.setName ?? event.species,
      level: event.level ?? undefined,
      asleep: event.asleep ?? undefined,
      startedAt: envelope.time,
      members: members.map((member) => ({
        encounterId: member.encounterId,
        species: member.species,
        dexNumber: member.dexNumber ?? undefined,
        area: describeArea({ area: member.area, position: member.position }, this.options.config.locationMode),
      })),
    };
    const mention = await this.options.pings?.mention(["legendary"]);
    set.messageId = await channel.send({ embeds: [buildSetEmbed(set)], ...mention });
    set.threadId = await this.startThread(channel, set.messageId, `${set.name} #${members[0]!.encounterId}`.slice(0, 100), members[0]!.encounterId);
    store.update((state) => {
      this.prune(state);
      state.legendarySets[key] = set;
      for (const member of members) {
        state.legendaryEncounters[String(member.encounterId)] = {
          channelId: channel.id,
          messageId: set.messageId,
          threadId: set.threadId,
          species: member.species,
          dexNumber: member.dexNumber ?? undefined,
          tier: member.tier ?? undefined,
          area: member.area ?? undefined,
          location: describeArea({ area: member.area, position: member.position }, this.options.config.locationMode),
          endsAt: member.endsAt ?? undefined,
          startedAt: envelope.time,
          level: event.level ?? undefined,
          asleep: event.asleep ?? undefined,
          set: key,
        };
      }
    });
    metrics.increment("legendaries.set");
    logger.info("Announced a legendary set", { set: key, members: members.map((member) => member.species) });
  }

  private async threadOf(channel: ChannelSink, record: LegendaryEncounterRecord): Promise<ThreadSink | undefined> {
    return record.threadId && channel.thread ? channel.thread(record.threadId) : undefined;
  }

  /** A clash, or Rayquaza on its way: a line in each one's thread (once when they share a set's). */
  private async postClash(envelope: GameEventEnvelope<LegendaryEvent>): Promise<void> {
    const event = envelope.event;
    const channel = this.channel();
    const line = threadLine(event, describeArea(event, this.options.config.locationMode));
    if (!channel || !line) {
      return;
    }
    const encounters = this.options.store.get().legendaryEncounters;
    const records = [event.encounterId, event.otherEncounterId]
      .map((id) => (id === null || id === undefined ? undefined : encounters[String(id)]))
      .filter((record): record is LegendaryEncounterRecord => record !== undefined);
    const threads = new Set<string>();
    for (const record of records) {
      if (record.endedAt) {
        continue;
      }
      const thread = await this.threadOf(channel, record);
      if (thread && !threads.has(thread.id)) {
        threads.add(thread.id);
        await thread.send({ content: line });
      }
    }
    if (threads.size === 0) {
      await channel.send({ content: line });
    }
    this.options.metrics.increment(`legendaries.${event.event}`);
  }

  /** A sign before a spawn, or a legendary given as a quest reward. */
  private async postStandalone(envelope: GameEventEnvelope<LegendaryEvent>): Promise<void> {
    const event = envelope.event;
    const channel = this.channel();
    if (!channel) {
      return;
    }
    let embed: APIEmbed;
    if (event.event === "sign") {
      const where = event.area ? ` near **${plain(event.area)}**` : "";
      embed = {
        author: { name: "Strange signs" },
        title: `🔮 Something powerful is coming${event.area ? ` near ${event.area}` : ""}`.slice(0, 256),
        description: [
          plain(event.text ?? `Strange signs are building${where}... something powerful is coming.`),
          event.endsAt ? `It breaks <t:${Math.floor(event.endsAt)}:R>.` : undefined,
        ].filter(Boolean).join("\n\n"),
        color: COLORS.legendary,
        timestamp: new Date(envelope.time * 1000).toISOString(),
      };
      await channel.send({ embeds: [embed] });
    } else {
      embed = {
        author: { name: "Legendary reward" },
        title: `🎁 ${event.trainer ?? "A trainer"} received ${event.species}!`.slice(0, 256),
        description: plain(event.text ?? `${event.trainer ?? "A trainer"} received ${event.species} as a reward!`),
        color: COLORS.legendary,
        footer: event.dexNumber ? { text: `Pokédex #${padDex(event.dexNumber)}` } : undefined,
        timestamp: new Date(envelope.time * 1000).toISOString(),
      };
      await channel.send(embedMessage(embed, this.options.artwork.resolve(event.dexNumber), "thumbnail"));
    }
    this.options.metrics.increment(`legendaries.${event.event}`);
  }

  private async postUpdate(envelope: GameEventEnvelope<LegendaryEvent>): Promise<void> {
    const { store, metrics } = this.options;
    const event = envelope.event;
    const key = String(event.encounterId);
    const record = store.get().legendaryEncounters[key];
    const channel = this.channel();
    if (!record || !channel) {
      return;
    }
    const line = threadLine(event, describeArea(event, this.options.config.locationMode));
    if (!line) {
      return;
    }
    const thread = await this.threadOf(channel, record);
    const target: ChannelSink = thread ?? channel;
    await target.send({ content: thread ? line : `${line} (encounter #${key})` });
    metrics.increment(`legendaries.${event.event}`);

    if (record.set) {
      await this.updateSet(channel, thread, record, event);
      return;
    }
    if (event.event === "woke") {
      store.update((state) => {
        const saved = state.legendaryEncounters[key];
        if (saved) {
          saved.asleep = false;
          saved.endsAt = undefined;
        }
      });
      const awake = { ...record, asleep: false, endsAt: undefined };
      if (channel.id === record.channelId) {
        await channel.edit(record.messageId, embedMessage(buildEncounterEmbed(awake), this.options.artwork.resolve(record.dexNumber), "image"));
      }
      return;
    }
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
      await this.archive(thread, key);
    }
  }

  /** A set member woke up or ended: its line on the set's post, and the thread archived once all have ended. */
  private async updateSet(channel: ChannelSink, thread: ThreadSink | undefined, record: LegendaryEncounterRecord, event: LegendaryEvent): Promise<void> {
    const { store } = this.options;
    const ended = event.event === "end" || event.event === "caught";
    if (!ended && event.event !== "woke") {
      return;
    }
    const reason = event.event === "woke" ? "awake" : event.event === "caught" ? "caught" : (event.reason ?? "vanished");
    const detail = event.event === "caught" || event.event === "woke"
      ? (event.trainer ? plain(event.trainer) : undefined)
      : reason === "defeated" && event.trainers && event.trainers.length > 0 ? event.trainers.map(plain).join(", ") : undefined;
    let set: LegendarySetRecord | undefined;
    store.update((state) => {
      const saved = state.legendarySets[record.set!];
      const member = saved?.members.find((item) => item.encounterId === event.encounterId);
      if (saved && member) {
        member.outcome = reason;
        member.detail = detail;
        member.ended = ended || undefined;
        set = structuredClone(saved);
      }
      const encounter = state.legendaryEncounters[String(event.encounterId)];
      if (encounter && ended) {
        encounter.endedAt = this.nowSeconds();
      }
    });
    if (!set) {
      return;
    }
    if (channel.id === set.channelId) {
      await channel.edit(set.messageId, { embeds: [buildSetEmbed(set)] });
    }
    const done = set.members.every((member) => member.ended);
    if (thread && done && reason !== "defeated") {
      await this.archive(thread, record.set!);
    }
  }

  private async archive(thread: ThreadSink, key: string): Promise<void> {
    await thread.archive().catch((error: unknown) => {
      this.options.metrics.increment("legendaries.archive_failed");
      this.options.logger.warn("Could not archive the legendary thread", { encounterId: key, error });
    });
  }
}
