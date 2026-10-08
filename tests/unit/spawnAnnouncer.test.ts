import { describe, expect, it } from "vitest";
import type { SpawnEvent } from "../../src/integrations/pokeverse/protocol.js";
import { ArtworkResolver } from "../../src/services/pokemon/artwork.js";
import { SpawnAnnouncer, buildSpawnEmbed, describeLocation, routeSpawn } from "../../src/services/spawns/spawnAnnouncer.js";
import { DeliveryQueue } from "../../src/utils/deliveryQueue.js";
import { silentLogger } from "../../src/utils/logger.js";
import { Metrics } from "../../src/utils/metrics.js";
import { FakeChannels, envelope, makeConfig } from "../helpers/fakes.js";

const SHINY: SpawnEvent = {
  kind: "spawn",
  species: "Shiny Rattata",
  baseSpecies: "Rattata",
  dexNumber: 19,
  level: 8,
  shiny: true,
  legendary: false,
  source: "spawn",
  startup: false,
  creatureId: 1001,
  position: { x: 1000, y: 1000, z: 7 },
  nearestTown: "Pallet",
};

const LEGENDARY: SpawnEvent = { ...SHINY, species: "Mewtwo", baseSpecies: "Mewtwo", dexNumber: 150, shiny: false, legendary: true, source: "script", creatureId: 2002 };
const SHINY_LEGENDARY: SpawnEvent = { ...LEGENDARY, species: "Shiny Mewtwo", shiny: true, creatureId: 3003 };

function setup(overrides: Record<string, string> = {}) {
  const config = makeConfig(overrides);
  const channels = new FakeChannels();
  const metrics = new Metrics();
  const queue = new DeliveryQueue({ name: "spawns", maxSize: 50, maxAttempts: 1, retryDelayMs: 1, logger: silentLogger, metrics });
  const announcer = new SpawnAnnouncer({ config: config.spawns, channels, queue, artwork: new ArtworkResolver(undefined), logger: silentLogger, metrics });
  return { config, announcer, channels, queue, metrics };
}

describe("spawn alerts", () => {
  it("routes shiny spawns to #shiny-spawns and legendaries to #legendary-spawns", async () => {
    const { announcer, channels, queue } = setup();
    expect(announcer.handle(envelope(SHINY))).toEqual({ action: "announce", channel: "shinySpawns" });
    expect(announcer.handle(envelope(LEGENDARY))).toEqual({ action: "announce", channel: "legendarySpawns" });
    await queue.idle();
    expect(channels.channel("shinySpawns").sent[0]!.message.embeds![0]!.title).toBe("Shiny Rattata spotted!");
    expect(channels.channel("legendarySpawns").sent[0]!.message.embeds![0]!.title).toBe("Legendary Mewtwo spotted!");
  });

  it("announces a shiny legendary exactly once", async () => {
    const { announcer, channels, queue } = setup();
    expect(announcer.handle(envelope(SHINY_LEGENDARY))).toEqual({ action: "announce", channel: "legendarySpawns" });
    await queue.idle();
    expect(channels.channel("legendarySpawns").sent).toHaveLength(1);
    expect(channels.channel("shinySpawns").sent).toHaveLength(0);
    expect(channels.channel("legendarySpawns").sent[0]!.message.embeds![0]!.title).toBe("Legendary Shiny Mewtwo spotted!");

    const shinyRoute = setup({ SPAWN_SHINY_LEGENDARY_ROUTE: "shiny" });
    expect(routeSpawn(SHINY_LEGENDARY, shinyRoute.config.spawns)).toBe("shinySpawns");
  });

  it("falls back to the other channel when one kind is disabled", () => {
    const { config } = setup({ SPAWN_LEGENDARY_ENABLED: "false" });
    expect(routeSpawn(SHINY_LEGENDARY, config.spawns)).toBe("shinySpawns");
    expect(routeSpawn(LEGENDARY, config.spawns)).toBeUndefined();
  });

  it("de-duplicates by event id and by creature", () => {
    const { announcer } = setup();
    const event = envelope(SHINY);
    expect(announcer.handle(event).action).toBe("announce");
    expect(announcer.handle(event)).toEqual({ action: "skip", reason: "duplicate" });
    expect(announcer.handle(envelope(SHINY, { bootId: "boot1" }))).toEqual({ action: "skip", reason: "duplicate" });
    expect(announcer.handle(envelope(SHINY, { bootId: "boot2" })).action).toBe("announce");
  });

  it("skips startup spawns, disabled sources, stale events and non-rare monsters", () => {
    const { announcer } = setup({ SPAWN_SOURCES: "spawn,fishing" });
    expect(announcer.handle(envelope({ ...SHINY, startup: true, creatureId: 1 }))).toEqual({ action: "skip", reason: "startup" });
    expect(announcer.handle(envelope({ ...SHINY, source: "headbutt", creatureId: 2 }))).toEqual({ action: "skip", reason: "source" });
    expect(announcer.handle(envelope({ ...SHINY, creatureId: 3 }, { time: Math.floor(Date.now() / 1000) - 3600 }))).toEqual({ action: "skip", reason: "stale" });
    expect(announcer.handle(envelope({ ...SHINY, shiny: false, creatureId: 4 }))).toEqual({ action: "skip", reason: "not_rare" });
    const startupAllowed = setup({ SPAWN_ANNOUNCE_STARTUP: "true" });
    expect(startupAllowed.announcer.handle(envelope({ ...SHINY, startup: true })).action).toBe("announce");
  });

  it("shows the location only when available and enabled", () => {
    expect(describeLocation(SHINY, "none")).toBeUndefined();
    expect(describeLocation(SHINY, "town")).toBe("near Pallet");
    expect(describeLocation(SHINY, "coordinates")).toBe("near Pallet (1000, 1000, 7)");
    expect(describeLocation({ ...SHINY, nearestTown: null }, "town")).toBeUndefined();
    expect(describeLocation({ ...SHINY, nearestTown: undefined }, "coordinates")).toBe("1000, 1000, 7");
    expect(describeLocation({ ...SHINY, nearestTown: undefined, position: undefined }, "coordinates")).toBeUndefined();

    const withoutLocation = buildSpawnEmbed(SHINY, 0, undefined);
    expect(withoutLocation.fields?.some((field) => field.name === "Location")).toBe(false);
    const withLocation = buildSpawnEmbed(SHINY, 0, "near Pallet");
    expect(withLocation.fields).toContainEqual({ name: "Location", value: "near Pallet", inline: false });
    expect(withLocation.fields).toContainEqual({ name: "Source", value: "Wild spawn", inline: true });
  });
});
