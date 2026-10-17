import { describe, expect, it } from "vitest";
import type { LegendaryEvent } from "../../src/integrations/pokeverse/protocol.js";
import { gameEventSchema } from "../../src/integrations/pokeverse/protocol.js";
import { LegendaryEncounters, threadLine } from "../../src/services/legendaries/legendaryEncounters.js";
import { ArtworkResolver } from "../../src/services/pokemon/artwork.js";
import { DeliveryQueue } from "../../src/utils/deliveryQueue.js";
import { silentLogger } from "../../src/utils/logger.js";
import { Metrics } from "../../src/utils/metrics.js";
import { FakeChannels, envelope, makeConfig, makeStore } from "../helpers/fakes.js";

const NOW = Math.floor(Date.now() / 1000);

const SPAWN: LegendaryEvent = {
  kind: "legendary",
  event: "spawn",
  encounterId: 31,
  species: "Articuno",
  dexNumber: 144,
  tier: 1,
  area: "Seafoam Islands",
  position: { x: 3570, y: 981, z: 7 },
  nearestTown: "Fuchsia",
  endsAt: NOW + 5400,
  source: "schedule",
  health: 27000,
};

function setup(overrides: Record<string, string> = {}, store = makeStore()) {
  const config = makeConfig(overrides);
  const channels = new FakeChannels();
  const metrics = new Metrics();
  const queue = new DeliveryQueue({ name: "spawns", maxSize: 50, maxAttempts: 1, retryDelayMs: 1, logger: silentLogger, metrics });
  const make = () => new LegendaryEncounters({
    config: config.spawns, channels, store, queue, artwork: new ArtworkResolver(undefined), logger: silentLogger, metrics,
  });
  return { legendaries: make(), make, channels, queue, store, metrics, channel: channels.channel("legendarySpawns") };
}

describe("wild legendary encounters", () => {
  it("parses the game's legendary events", () => {
    expect(gameEventSchema.parse(SPAWN)).toMatchObject({ kind: "legendary", event: "spawn", encounterId: 31 });
    expect(gameEventSchema.parse({ kind: "legendary", event: "end", reason: "defeated", encounterId: 31, species: "Articuno",
      trainers: ["Ash"], topTrainer: "Ash" })).toMatchObject({ reason: "defeated" });
  });

  it("posts the spawn in #legendary-spawns and opens a thread for the encounter", async () => {
    const { legendaries, channel, queue, store } = setup();
    expect(legendaries.handle(envelope(SPAWN))).toEqual({ action: "post" });
    await queue.idle();
    expect(channel.sent).toHaveLength(1);
    const embed = channel.sent[0]!.message.embeds![0]!;
    expect(embed.title).toBe("👑 A wild Articuno appeared!");
    expect(embed.description).toContain("Seafoam Islands");
    expect(embed.description).toContain("level 50+");
    expect(embed.fields!.find((field) => field.name === "Flies off")!.value).toContain(`<t:${SPAWN.endsAt}:R>`);
    const thread = channel.thread0();
    expect(thread.name).toBe("Articuno near Seafoam Islands #31");
    expect(thread.starterId).toBe(channel.sent[0]!.id);
    expect(store.get().legendaryEncounters["31"]).toMatchObject({ species: "Articuno", threadId: thread.id });
  });

  it("sends sightings, the flee and the end into the thread, then closes it", async () => {
    const { legendaries, channel, queue } = setup();
    legendaries.handle(envelope(SPAWN));
    legendaries.handle(envelope({ ...SPAWN, event: "sighting", area: "Route 20" }));
    legendaries.handle(envelope({ ...SPAWN, event: "flee", area: "Route 19", healthPercent: 49.6 }));
    legendaries.handle(envelope({ kind: "legendary", event: "end", reason: "fled", encounterId: 31, species: "Articuno" }));
    await queue.idle();
    const thread = channel.thread0();
    expect(thread.contents()).toEqual([
      "📍 **Articuno** was spotted near **Route 20**.",
      "💨 **Articuno** fled near **Route 19** with 50% health!",
      "🕊️ The wild **Articuno** flew away.",
    ]);
    expect(channel.sent).toHaveLength(1);
    expect(channel.edits[0]!.message.embeds![0]!.title).toBe("👑 Articuno: Flew away");
    expect(thread.archived).toBe(true);
  });

  it("keeps the thread open after a defeat for the catch", async () => {
    const { legendaries, channel, queue } = setup();
    legendaries.handle(envelope(SPAWN));
    legendaries.handle(envelope({ kind: "legendary", event: "end", reason: "defeated", encounterId: 31, species: "Articuno",
      trainers: ["Ash", "Misty"], topTrainer: "Ash" }));
    await queue.idle();
    const thread = channel.thread0();
    expect(thread.contents()[0]).toBe("⚔️ The wild **Articuno** was defeated by Ash, Misty! **Ash** has 60 seconds to throw a ball first.");
    expect(thread.archived).toBe(false);
    expect(channel.edits.at(-1)!.message.embeds![0]!.fields!.at(-1)!.value).toBe("Defeated: Ash, Misty");

    legendaries.handle(envelope({ kind: "legendary", event: "caught", encounterId: 31, species: "Articuno", trainer: "Ash" }));
    await queue.idle();
    expect(thread.contents()[1]).toBe("🎉 **Ash** caught the wild **Articuno**!");
    expect(channel.edits.at(-1)!.message.embeds![0]!.title).toBe("👑 Articuno: Caught");
    expect(thread.archived).toBe(true);
  });

  it("keeps posting into the same thread after a bot restart", async () => {
    const first = setup();
    first.legendaries.handle(envelope(SPAWN));
    await first.queue.idle();
    const again = first.make();
    again.handle(envelope({ ...SPAWN, event: "sighting", area: "Route 20" }));
    await first.queue.idle();
    expect(first.channel.thread0().contents()).toHaveLength(1);
  });

  it("posts in the channel when the thread can't be made", async () => {
    const { legendaries, channel, queue, metrics } = setup();
    channel.failThreads = true;
    legendaries.handle(envelope(SPAWN));
    legendaries.handle(envelope({ ...SPAWN, event: "sighting", area: "Route 20" }));
    await queue.idle();
    expect(channel.contents()[1]).toBe("📍 **Articuno** was spotted near **Route 20**. (encounter #31)");
    expect(metrics.snapshot()["legendaries.thread_failed"]).toBe(1);
  });

  it("skips duplicates, unknown encounters, old spawns and disabled alerts", async () => {
    const { legendaries, queue } = setup();
    const spawn = envelope(SPAWN);
    expect(legendaries.handle(spawn).action).toBe("post");
    expect(legendaries.handle(spawn)).toEqual({ action: "skip", reason: "duplicate" });
    await queue.idle();
    expect(legendaries.handle(envelope({ ...SPAWN, event: "sighting", encounterId: 99 }))).toEqual({ action: "skip", reason: "unknown_encounter" });
    expect(legendaries.handle(envelope({ ...SPAWN, encounterId: 32, endsAt: NOW - 10 }))).toEqual({ action: "skip", reason: "stale" });
    expect(legendaries.handle(envelope({ ...SPAWN, encounterId: null }))).toEqual({ action: "skip", reason: "no_encounter" });
    expect(setup({ SPAWN_LEGENDARY_ENABLED: "false" }).legendaries.handle(envelope(SPAWN))).toEqual({ action: "skip", reason: "disabled" });
  });

  it("words every end reason", () => {
    const end = (reason: string) => threadLine({ kind: "legendary", event: "end", reason, species: "Mew" }, undefined);
    expect(end("staff")).toBe("The wild **Mew** was sent away by staff.");
    expect(end("restart")).toBe("The wild **Mew** left before the server restart.");
    expect(end("vanished")).toBe("The wild **Mew** vanished.");
    expect(end("something new")).toBe("The wild **Mew** is gone.");
  });
});
