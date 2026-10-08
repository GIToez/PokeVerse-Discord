import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CatchEvent } from "../../src/integrations/pokeverse/protocol.js";
import { CatchAnnouncer, buildCatchEmbed, pokemonDisplayName } from "../../src/services/catches/catchAnnouncer.js";
import { ArtworkResolver } from "../../src/services/pokemon/artwork.js";
import { DeliveryQueue } from "../../src/utils/deliveryQueue.js";
import { silentLogger } from "../../src/utils/logger.js";
import { Metrics } from "../../src/utils/metrics.js";
import type { CatchMode } from "../../src/utils/stateStore.js";
import { FakeChannels, envelope, tempDir } from "../helpers/fakes.js";

const RATTATA: CatchEvent = {
  kind: "catch",
  trainer: "Bridge Trainer",
  species: "Rattata",
  baseSpecies: "Rattata",
  dexNumber: 19,
  level: 5,
  sex: 1,
  shiny: false,
  legendary: false,
  extraPoints: 0,
  ball: "ultra ball",
  safari: false,
};

function setup(mode: CatchMode = "all", options: { artworkDir?: string; rare?: string[] } = {}) {
  const channels = new FakeChannels();
  const metrics = new Metrics();
  const queue = new DeliveryQueue({ name: "catches", maxSize: 50, maxAttempts: 1, retryDelayMs: 1, logger: silentLogger, metrics });
  let currentMode = mode;
  const announcer = new CatchAnnouncer({
    mode: () => currentMode,
    rareSpecies: new Set(options.rare ?? []),
    maxEventAgeSeconds: 600,
    channels,
    queue,
    artwork: new ArtworkResolver(options.artworkDir),
    logger: silentLogger,
    metrics,
  });
  return { announcer, channel: channels.channel("catches"), queue, metrics, setMode: (next: CatchMode) => (currentMode = next) };
}

describe("catch announcements", () => {
  it("announces every confirmed catch in development mode (all)", async () => {
    const { announcer, channel, queue } = setup("all");
    expect(announcer.handle(envelope(RATTATA))).toBe("announce");
    await queue.idle();
    const embed = channel.sent[0]!.message.embeds![0]!;
    expect(embed.title).toBe("Rattata caught!");
    expect(embed.description).toBe("**Bridge Trainer** caught **Rattata**.");
    expect(embed.fields).toEqual(
      expect.arrayContaining([
        { name: "Trainer", value: "Bridge Trainer", inline: true },
        { name: "Level", value: "5", inline: true },
        { name: "Sex", value: "Male", inline: true },
        { name: "Ball", value: "Ultra Ball", inline: true },
      ]),
    );
    expect(embed.footer?.text).toBe("Pokedex #019");
  });

  it("shows the bonus only when the game reports one", () => {
    expect(pokemonDisplayName("Rattata", 0)).toBe("Rattata");
    expect(pokemonDisplayName("Rattata", null)).toBe("Rattata");
    expect(pokemonDisplayName("Rattata", undefined)).toBe("Rattata");
    expect(pokemonDisplayName("Rattata", 3)).toBe("Rattata +3");
    expect(buildCatchEmbed({ ...RATTATA, extraPoints: 2 }, 0).title).toBe("Rattata +2 caught!");
  });

  it("never announces a catch twice", async () => {
    const { announcer, channel, queue } = setup();
    const event = envelope(RATTATA);
    expect(announcer.handle(event)).toBe("announce");
    expect(announcer.handle(event)).toBe("duplicate");
    await queue.idle();
    expect(channel.sent).toHaveLength(1);
  });

  it("applies rare_only, shiny_legendary_only and off", () => {
    const { announcer, setMode } = setup("rare_only", { rare: ["dratini"] });
    expect(announcer.handle(envelope(RATTATA))).toBe("filtered");
    expect(announcer.handle(envelope({ ...RATTATA, species: "Dratini", baseSpecies: "Dratini" }))).toBe("announce");
    expect(announcer.handle(envelope({ ...RATTATA, species: "Shiny Rattata", shiny: true }))).toBe("announce");
    setMode("shiny_legendary_only");
    expect(announcer.handle(envelope({ ...RATTATA, species: "Dratini", baseSpecies: "Dratini" }))).toBe("filtered");
    expect(announcer.handle(envelope({ ...RATTATA, species: "Mewtwo", baseSpecies: "Mewtwo", legendary: true }))).toBe("announce");
    setMode("off");
    expect(announcer.handle(envelope({ ...RATTATA, shiny: true }))).toBe("mode_off");
  });

  it("drops old catches queued while the bot was offline", () => {
    const { announcer } = setup();
    expect(announcer.handle(envelope(RATTATA, { time: Math.floor(Date.now() / 1000) - 3600 }))).toBe("stale");
  });

  it("styles shiny and legendary catches", () => {
    const shiny = buildCatchEmbed({ ...RATTATA, species: "Shiny Rattata", shiny: true }, 0);
    expect(shiny.title).toBe("Shiny Rattata caught!");
    expect(shiny.color).toBe(0xfacc15);
    const legendary = buildCatchEmbed({ ...RATTATA, species: "Mewtwo", legendary: true, sex: 2 }, 0);
    expect(legendary.title).toBe("Legendary Mewtwo caught!");
    expect(legendary.fields?.some((field) => field.name === "Sex")).toBe(false);
  });

  it("attaches game artwork when available, nothing otherwise", async () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "19.png"), "png");
    const withArt = setup("all", { artworkDir: dir });
    withArt.announcer.handle(envelope(RATTATA));
    withArt.announcer.handle(envelope({ ...RATTATA, dexNumber: 150 }));
    await withArt.queue.idle();
    const [first, second] = withArt.channel.sent;
    expect(first!.message.files).toEqual([{ name: "pokemon-19.png", path: join(dir, "19.png") }]);
    expect(first!.message.embeds![0]!.thumbnail).toEqual({ url: "attachment://pokemon-19.png" });
    expect(second!.message.files).toBeUndefined();

    const noArt = setup("all");
    noArt.announcer.handle(envelope(RATTATA));
    await noArt.queue.idle();
    expect(noArt.channel.sent[0]!.message.files).toBeUndefined();
  });
});
