import { afterEach, describe, expect, it } from "vitest";
import { GameIntegration } from "../../src/bot/integration.js";
import { silentLogger } from "../../src/utils/logger.js";
import { Metrics } from "../../src/utils/metrics.js";
import { FakeBridgeServer, waitFor } from "../helpers/fakeBridgeServer.js";
import { DEV_GUILD, FakeChannels, FakeGuild, RATTATA, TRAINER, makeConfig, makeStore } from "../helpers/fakes.js";

const SECRET = "integration-secret-0123456789";
const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    await cleanup.pop()!();
  }
});

/** Full bot pipeline (bridge client -> services -> channel sinks) against a protocol-level fake game. */
async function setup(overrides: Record<string, string> = {}) {
  const chats: Array<Record<string, unknown>> = [];
  const server: FakeBridgeServer = new FakeBridgeServer({
    secret: SECRET,
    onRequest: (method, params): unknown => {
      switch (method) {
        case "chat.send":
          chats.push(params);
          return { delivered: 2, text: params.text };
        case "server.status":
          return { serverName: "PokeVerse", state: "normal", playersOnline: 2, maxPlayers: 1000, uptime: 120, bootId: server.bootId };
        case "trainer.lookup":
          return String(params.name).toLowerCase() === "red trainer" ? TRAINER : { found: false };
        case "pokemon.lookup":
          return String(params.name).toLowerCase() === "rattata" ? RATTATA : { found: false };
        case "pokemon.search":
          return { names: ["Rattata", "Raticate"] };
        default:
          throw { code: "unknown_method" };
      }
    },
  });
  await server.start();
  cleanup.push(() => server.stop());
  const config = makeConfig({ BRIDGE_PORT: String(server.port), BRIDGE_SECRET: SECRET, ...overrides });
  const store = makeStore(config);
  const channels = new FakeChannels();
  const integration = new GameIntegration({ config, store, channels, guild: () => new FakeGuild(), logger: silentLogger, metrics: new Metrics() });
  integration.start();
  cleanup.push(() => integration.stop());
  await waitFor(() => integration.game.connected, 3000, "bridge connection");
  return { server, integration, channels, chats, store };
}

describe("bot <-> game bridge pipeline", () => {
  it("relays chat both ways without loops", async () => {
    const { server, integration, channels, chats } = await setup();
    const chatChannel = channels.channel("gameChat");

    const outcome = await integration.chat.handleDiscordMessage({
      id: "1",
      guildId: DEV_GUILD,
      channelId: chatChannel.id,
      authorId: "500000000000000001",
      authorName: "Jim",
      isBot: false,
      isWebhook: false,
      isSystem: false,
      content: "hello from **Discord**",
      attachmentCount: 0,
    });
    expect(outcome).toBe("sent");
    expect(chats).toEqual([{ author: "Jim", text: "hello from Discord" }]);

    server.emit({ kind: "chat", channelId: 7, author: "RedTrainer", level: 20, text: "hi Discord" });
    await waitFor(() => chatChannel.sent.length === 1, 3000, "game chat in Discord");
    expect(chatChannel.contents()).toEqual(["[Game] RedTrainer: hi Discord"]);

    // The bot's own post comes back from Discord as a bot message and is not sent to the game.
    expect(
      await integration.chat.handleDiscordMessage({
        id: "2", guildId: DEV_GUILD, channelId: chatChannel.id, authorId: "bot", authorName: "PokeVerse",
        isBot: true, isWebhook: false, isSystem: false, content: chatChannel.contents()[0]!, attachmentCount: 0,
      }),
    ).toBe("ignored");
    expect(chats).toHaveLength(1);
  });

  it("announces confirmed catches and spawns, and keeps the status message updated", async () => {
    const { server, integration, channels } = await setup();
    await waitFor(() => channels.channel("serverStatus").sent.length === 1, 3000, "status message");

    server.emit({ kind: "catch", trainer: "Bridge Trainer", species: "Rattata", baseSpecies: "Rattata", dexNumber: 19, level: 5, sex: 1, shiny: false, legendary: false, extraPoints: 0, ball: "ultra ball", safari: false });
    server.emit({ kind: "spawn", species: "Shiny Rattata", baseSpecies: "Rattata", dexNumber: 19, level: 10, shiny: true, legendary: false, source: "script", startup: false, creatureId: 9, position: { x: 1, y: 2, z: 7 }, nearestTown: "Pallet" });
    server.emit({ kind: "spawn", species: "Articuno", baseSpecies: "Articuno", dexNumber: 144, level: 100, shiny: false, legendary: true, source: "script", startup: false, creatureId: 10 });
    server.emit({ kind: "broadcast", source: "gm", author: "GM", text: "Event starts now" });
    server.emit({ kind: "restart_warning", reason: "global_save", minutes: 5, shutdown: false });
    server.emit({ kind: "server_state", state: "maintain", players: 2 });

    await waitFor(() => channels.channel("catches").sent.length === 1, 3000, "catch");
    await waitFor(() => channels.channel("shinySpawns").sent.length === 1, 3000, "shiny");
    await waitFor(() => channels.channel("legendarySpawns").sent.length === 1, 3000, "legendary");
    await waitFor(() => channels.channel("announcements").sent.length === 2, 3000, "announcements");
    await integration.idle();
    expect(channels.channel("catches").sent[0]!.message.embeds![0]!.title).toBe("Rattata caught!");
    expect(channels.channel("shinySpawns").sent[0]!.message.embeds![0]!.fields).toContainEqual({ name: "Location", value: "near Pallet", inline: false });
    await waitFor(() => channels.channel("serverStatus").edits.some((edit) => JSON.stringify(edit.message).includes("Maintenance")), 3000, "status edit");
    expect(channels.channel("serverStatus").sent).toHaveLength(1);
  });

  it("answers lookups through the bridge", async () => {
    const { integration } = await setup();
    const user = { id: "1", displayName: "U", roleIds: [], manageGuild: false };
    const trainer = await integration.commands.handle({ commandName: "trainer", options: { name: "Red Trainer" }, user, guildId: DEV_GUILD });
    expect(trainer.message.embeds![0]!.title).toBe("Trainer Red Trainer");
    const pokemon = await integration.commands.handle({ commandName: "pokemon", options: { name: "Rattata" }, user, guildId: DEV_GUILD });
    expect(pokemon.message.embeds![0]!.title).toBe("#019 Rattata");
    expect(await integration.commands.autocomplete("pokemon", "name", "ra")).toHaveLength(2);
  });

  it("marks the server offline when the game goes away and recovers after a restart", async () => {
    const { server, integration, channels, store } = await setup();
    await waitFor(() => channels.channel("serverStatus").sent.length === 1);
    await server.stop();
    await waitFor(() => !integration.status.current.online, 3000, "offline");
    await server.restart("boot2");
    await waitFor(() => integration.status.current.online && integration.status.current.bootId === "boot2", 5000, "online again");
    expect(integration.status.current.lastRestartAt).toBeDefined();
    expect(store.get().lastBootId).toBe("boot2");
    await integration.status.render();
    const last = channels.channel("serverStatus").edits.at(-1)!.message.embeds![0]!;
    expect(last.fields!.map((field) => field.name)).toContain("Last restart");
    expect(channels.channel("serverStatus").sent).toHaveLength(1);
  });

  it("does not post when catch announcements are off", async () => {
    const { server, integration, channels, store } = await setup();
    store.update((state) => {
      state.catchMode = "off";
    });
    server.emit({ kind: "catch", trainer: "A", species: "Rattata", baseSpecies: "Rattata", level: 5, shiny: true, legendary: false });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await integration.idle();
    expect(channels.channel("catches").sent).toHaveLength(0);
  });
});
