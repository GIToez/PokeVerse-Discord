import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCommandDefinitions } from "../../src/commands/definitions.js";
import { CommandRouter, type CommandInput } from "../../src/commands/router.js";
import { parseArgs } from "../../src/cli.js";
import { BridgeRequestError } from "../../src/integrations/pokeverse/bridgeClient.js";
import { Announcer } from "../../src/services/announcements/announcer.js";
import { ArtworkResolver } from "../../src/services/pokemon/artwork.js";
import { PokemonAutocomplete } from "../../src/services/pokemon/pokemonLookup.js";
import { StatusService } from "../../src/services/status/statusService.js";
import { ChannelSetup } from "../../src/setup/channelSetup.js";
import { DeliveryQueue } from "../../src/utils/deliveryQueue.js";
import { silentLogger } from "../../src/utils/logger.js";
import { Metrics } from "../../src/utils/metrics.js";
import { DEV_GUILD, FakeChannels, FakeGame, FakeGuild, makeConfig, makeStore, tempDir } from "../helpers/fakes.js";

const ADMIN = "700000000000000001";
const MEMBER = "700000000000000002";

function setup(overrides: Record<string, string> = {}, artworkDir?: string) {
  const config = makeConfig(overrides);
  const store = makeStore(config);
  const game = new FakeGame();
  const channels = new FakeChannels();
  const metrics = new Metrics();
  const guild = new FakeGuild();
  const queue = new DeliveryQueue({ name: "a", maxSize: 10, maxAttempts: 1, retryDelayMs: 1, logger: silentLogger, metrics });
  const announcer = new Announcer({ broadcasts: true, restartWarnings: true, maxEventAgeSeconds: 600, channels, queue, logger: silentLogger, metrics });
  const status = new StatusService({ game, channels, store, refreshSeconds: 60, logger: silentLogger, metrics });
  const router = new CommandRouter({
    config,
    game,
    artwork: new ArtworkResolver(artworkDir),
    autocomplete: new PokemonAutocomplete(game),
    status,
    setup: new ChannelSetup(store, silentLogger),
    announcer,
    store,
    guild: () => guild,
    queueSizes: () => ({ chat: 0 }),
    logger: silentLogger,
    metrics,
  });
  const run = (commandName: string, options: Record<string, string> = {}, extra: Partial<CommandInput> = {}) =>
    router.handle({
      commandName,
      options,
      guildId: DEV_GUILD,
      user: { id: MEMBER, displayName: "Member", roleIds: [], manageGuild: false },
      ...extra,
    });
  return { config, store, game, channels, guild, router, run, metrics };
}

const adminUser = { id: ADMIN, displayName: "Admin", roleIds: [], manageGuild: true };

describe("/trainer", () => {
  it("shows real public data from the game", async () => {
    const { run, game } = setup();
    const response = await run("trainer", { name: "  Red   Trainer " });
    expect(response.ephemeral).toBe(false);
    const embed = response.message.embeds![0]!;
    expect(embed.title).toBe("Trainer Red Trainer");
    const fields = Object.fromEntries(embed.fields!.map((field) => [field.name, field.value]));
    expect(fields).toMatchObject({ Level: "25", Status: "Online", Vocation: "Trainer", Guild: "None" });
    expect(fields.Collection).toContain("Caught: **12**");
    expect(fields.PvP).toContain("Duels won: **3**");
    expect(fields.Achievements).toBe("2 / 40\n- First Catch\n- Explorer");
    expect(game.calls).toEqual(["trainer.lookup"]);
  });

  it("handles not found, invalid names and an offline game", async () => {
    const { run, game } = setup();
    expect((await run("trainer", { name: "Nobody" })).message.embeds![0]!.description).toBe('No trainer named "Nobody" was found.');
    expect((await run("trainer", { name: "x;DROP TABLE" })).message.content).toMatch(/letters, spaces/);
    expect(game.calls).toEqual(["trainer.lookup"]);
    game.connected = false;
    const offline = await run("trainer", { name: "Red Trainer" });
    expect(offline.ephemeral).toBe(true);
    expect(offline.message.content).toMatch(/offline/);
  });

  it("rate limits lookups per user", async () => {
    const { run } = setup();
    for (let i = 0; i < 5; i++) {
      await run("trainer", { name: "Red Trainer" });
    }
    expect((await run("trainer", { name: "Red Trainer" })).message.content).toMatch(/too quickly/);
  });
});

describe("/pokemon", () => {
  it("shows species data with artwork from the game assets", async () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "19.png"), "png");
    const { run } = setup({}, dir);
    const response = await run("pokemon", { name: "rattata" });
    const embed = response.message.embeds![0]!;
    expect(embed.title).toBe("#019 Rattata");
    expect(embed.thumbnail).toEqual({ url: "attachment://pokemon-19.png" });
    expect(response.message.files).toHaveLength(1);
    const fields = Object.fromEntries(embed.fields!.map((field) => [field.name, field.value]));
    expect(fields.Type).toBe("normal");
    expect(fields["Base stats"]).toContain("Attack: **56**");
    expect(fields["Base stats"]).not.toContain("Energy");
    expect(fields.Evolutions).toBe("Rattata -> Raticate (level 20)");
  });

  it("suggests names when not found and autocompletes", async () => {
    const { run, router, game } = setup();
    const response = await run("pokemon", { name: "Rat" });
    expect(response.message.embeds![0]!.description).toContain("Did you mean: Rattata, Raticate?");
    expect(await router.autocomplete("pokemon", "name", "ra")).toEqual([
      { name: "Rattata", value: "Rattata" },
      { name: "Raticate", value: "Raticate" },
      { name: "Raichu", value: "Raichu" },
    ]);
    const before = game.calls.length;
    await router.autocomplete("pokemon", "name", "ra");
    expect(game.calls.length).toBe(before);
    game.connected = false;
    expect(await router.autocomplete("pokemon", "name", "bu")).toEqual([]);
  });
});

describe("/server", () => {
  it("returns the live status embed", async () => {
    const { run } = setup();
    const response = await run("server");
    const fields = Object.fromEntries(response.message.embeds![0]!.fields!.map((field) => [field.name, field.value]));
    expect(fields.Status).toBe("Online");
    expect(fields["Players online"]).toBe("3 / 1000");
  });

  it("shows offline when the bridge is down", async () => {
    const { run, game } = setup();
    game.connected = false;
    const fields = Object.fromEntries((await run("server")).message.embeds![0]!.fields!.map((field) => [field.name, field.value]));
    expect(fields.Status).toBe("Offline");
  });
});

describe("/pokeverse (admin)", () => {
  it("is denied to regular members", async () => {
    const { run, guild } = setup();
    const response = await run("pokeverse", {}, { subcommand: "setup" });
    expect(response.message.content).toMatch(/not allowed/);
    expect(guild.created).toHaveLength(0);
  });

  it("allows Manage Server when no admin list is configured, otherwise only listed users/roles", async () => {
    const open = setup();
    expect(open.router.isAdmin(adminUser)).toBe(true);
    const restricted = setup({ DISCORD_ADMIN_USER_IDS: "700000000000000009", DISCORD_ADMIN_ROLE_IDS: "800000000000000001" });
    expect(restricted.router.isAdmin(adminUser)).toBe(false);
    expect(restricted.router.isAdmin({ ...adminUser, id: "700000000000000009", manageGuild: false })).toBe(true);
    expect(restricted.router.isAdmin({ ...adminUser, roleIds: ["800000000000000001"], manageGuild: false })).toBe(true);
  });

  it("runs setup and reports the result", async () => {
    const { run, guild } = setup();
    const response = await run("pokeverse", {}, { subcommand: "setup", user: adminUser });
    expect(response.ephemeral).toBe(true);
    expect(response.message.embeds![0]!.description).toContain("Everything is ready.");
    expect(guild.created).toHaveLength(8);
  });

  it("changes the catch mode persistently", async () => {
    const { run, store } = setup();
    await run("pokeverse", { mode: "shiny_legendary_only" }, { subcommand: "catches", user: adminUser });
    expect(store.get().catchMode).toBe("shiny_legendary_only");
    expect((await run("pokeverse", { mode: "bogus" }, { subcommand: "catches", user: adminUser })).message.content).toMatch(/Unknown/);
  });

  it("reassigns channels and posts announcements", async () => {
    const { run, store, guild, channels } = setup();
    guild.add({ id: "900000000000000001", name: "my-status", kind: "text", parentId: null });
    const response = await run("pokeverse", { purpose: "serverStatus", channel: "900000000000000001" }, { subcommand: "channel", user: adminUser });
    expect(response.message.embeds![0]!.description).toContain("<#900000000000000001>");
    expect(store.getChannelId("serverStatus")).toBe("900000000000000001");

    await run("pokeverse", { category: "event", text: "Shiny weekend!", title: "Weekend" }, { subcommand: "announce", user: adminUser });
    expect(channels.channel("announcements").sent[0]!.message.embeds![0]!.title).toBe("Event: Weekend");
  });

  it("shows diagnostics", async () => {
    const { run } = setup();
    const response = await run("pokeverse", {}, { subcommand: "status", user: adminUser });
    const text = response.message.embeds![0]!.description!;
    expect(text).toContain("Profile: **development**");
    expect(text).toContain("Game bridge: **connected**");
    expect(text).toContain("Catch announcements: **all**");
  });
});

describe("command safety", () => {
  it("ignores other guilds and maps bridge errors", async () => {
    const { run, game } = setup();
    expect((await run("trainer", { name: "Red Trainer" }, { guildId: "100000000000000555" })).message.content).toMatch(/configured server/);
    game.lookupTrainer = async () => {
      throw new BridgeRequestError("invalid_params", "invalid trainer name");
    };
    expect((await run("trainer", { name: "Red Trainer" })).message.content).toBe("That name is not valid.");
    game.lookupTrainer = async () => {
      throw new Error("boom");
    };
    expect((await run("trainer", { name: "Red Trainer" })).message.content).toMatch(/Something went wrong/);
  });

  it("builds valid command definitions with a restricted admin command", () => {
    const definitions = buildCommandDefinitions();
    expect(definitions.map((command) => command.name)).toEqual(["trainer", "pokemon", "server", "pokeverse", "link", "unlink", "account", "characters", "main", "sync"]);
    expect(buildCommandDefinitions({ linking: false }).map((command) => command.name)).toEqual(["trainer", "pokemon", "server", "pokeverse"]);
    const admin = definitions.find((command) => command.name === "pokeverse")!;
    expect(admin.default_member_permissions).toBe((1n << 5n).toString());
    const pokemon = definitions.find((command) => command.name === "pokemon")!;
    expect((pokemon.options![0] as { autocomplete?: boolean }).autocomplete).toBe(true);
    expect(JSON.stringify(definitions)).not.toMatch(/trade|gts|market|battle/i);
  });

  it("parses CLI arguments", () => {
    expect(parseArgs([])).toMatchObject({ command: "start", profile: undefined });
    expect(parseArgs(["setup", "--profile", "production", "--config-dir=/x"])).toMatchObject({ command: "setup", profile: "production", configDir: "/x" });
    expect(() => parseArgs(["--nope"])).toThrow(/Unknown argument/);
  });
});
