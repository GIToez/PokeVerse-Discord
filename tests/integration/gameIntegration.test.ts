import { afterEach, describe, expect, it } from "vitest";
import { GameIntegration } from "../../src/bot/integration.js";
import { silentLogger } from "../../src/utils/logger.js";
import { Metrics } from "../../src/utils/metrics.js";
import { FakeBridgeServer, waitFor } from "../helpers/fakeBridgeServer.js";
import type { LinkSummary } from "../../src/integrations/pokeverse/protocol.js";
import type { StateStore } from "../../src/utils/stateStore.js";
import { DEV_GUILD, FakeChannels, FakeGuild, LINKED_USER, RATTATA, TRAINER, linkSummary, makeConfig, makeStore, setUpGuild } from "../helpers/fakes.js";

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

const ADMIN_ID = "700000000000000001";
const OTHER_USER = "223456789012345678";

/** The bot pipeline against a fake game that supports player sessions and account linking. */
async function phase2(
  options: { features?: string[]; before?: (guild: FakeGuild, links: Map<string, LinkSummary>, store: StateStore) => void } = {},
) {
  const links = new Map<string, LinkSummary>();
  const requests: string[] = [];
  let online: Array<{ sessionId: string; character: string; level: number }> = [];
  const server: FakeBridgeServer = new FakeBridgeServer({
    secret: SECRET,
    features: options.features ?? ["playerSessions", "accountLinking"],
    onRequest: (method, params): unknown => {
      requests.push(method);
      switch (method) {
        case "server.status":
          return { serverName: "PokeVerse", state: "normal", playersOnline: online.length, maxPlayers: 1000, uptime: 120, bootId: server.bootId };
        case "link.account":
          return links.get(String(params.discordUserId)) ?? { linked: false };
        case "link.list":
          return { links: [...links.values()] };
        case "admin.sessions":
          return { sessions: online, playersOnline: online.length };
        default:
          throw { code: "unknown_method" };
      }
    },
  });
  await server.start();
  cleanup.push(() => server.stop());
  const config = makeConfig({ BRIDGE_PORT: String(server.port), BRIDGE_SECRET: SECRET, DISCORD_ADMIN_USER_IDS: ADMIN_ID });
  const store = makeStore(config);
  const channels = new FakeChannels();
  const guild = new FakeGuild();
  guild.permissions = [...guild.permissions, "ManageRoles", "ManageNicknames"];
  const integration = new GameIntegration({ config, store, channels, guild: () => guild, logger: silentLogger, metrics: new Metrics(), reconnectSyncDelayMs: 50 });
  await setUpGuild(integration.setup, guild, channels);
  const sink = channels.channel("playerActivity");
  options.before?.(guild, links, store);
  integration.start();
  cleanup.push(() => integration.stop());
  await waitFor(() => integration.game.connected, 3000, "bridge connection");
  return {
    server, integration, guild, store, sink, links, requests,
    setOnline: (sessions: typeof online) => {
      online = sessions;
    },
  };
}

describe("player activity and account linking pipeline", () => {
  it("posts logins and logouts to the private channel without duplicates", async () => {
    const { server, integration, sink } = await phase2();
    const login = { kind: "player_login", scope: "admin", sessionId: "boot1-1", character: "Red", level: 5, accountId: 2, loginTime: 1_700_000_000, ip: "203.0.113.7", playersOnline: 1 };
    server.emit(login);
    server.emit(login);
    server.emit({ ...login, kind: "player_logout", logoutTime: 1_700_000_100, duration: 100, reason: "logout", playersOnline: 0 });
    await waitFor(() => sink.sent.length === 2, 3000, "activity posts");
    await integration.idle();
    expect(sink.sent.map((item) => item.message.embeds![0]!.title)).toEqual(["Login", "Logout"]);
  });

  it("closes sessions of a previous game run after a restart", async () => {
    const { server, sink } = await phase2();
    server.emit({ kind: "player_login", scope: "admin", sessionId: "boot1-1", character: "Red", level: 5, accountId: 2, loginTime: 1_700_000_000 });
    await waitFor(() => sink.sent.length === 1);
    await server.restart("boot2");
    await waitFor(() => sink.sent.length === 2, 5000, "restart close");
    expect(sink.sent[1]!.message.embeds![0]!.title).toBe("Session ended by a server restart");
  });

  it("syncs a member when the game reports a link change and when they rejoin", async () => {
    const { server, integration, guild, store, links } = await phase2();
    const member = guild.addMember(LINKED_USER);
    links.set(LINKED_USER, linkSummary({ premium: true }));
    server.emit({ kind: "account_link", scope: "account", action: "linked", discordUserId: LINKED_USER });
    await waitFor(() => member.nickname === "Red Trainer", 3000, "nickname after link");
    expect(member.roleIds).toEqual([store.get().roles.verified, store.get().roles.premium]);

    member.nickname = "Custom";
    links.set(LINKED_USER, linkSummary({ premium: false }));
    server.emit({ kind: "account_characters", scope: "account", discordUserId: LINKED_USER, change: "created", character: "Green" });
    await waitFor(() => member.roleIds.length === 1, 3000, "premium removed");
    await integration.idle();
    expect(member.nickname).toBe("Custom");

    member.roleIds = [];
    integration.onMemberJoin(LINKED_USER);
    await waitFor(() => member.nickname === "Red Trainer", 3000, "nickname after rejoin");
    expect(member.roleIds).toEqual([store.get().roles.verified]);

    links.delete(LINKED_USER);
    server.emit({ kind: "account_link", scope: "account", action: "unlinked", source: "game", discordUserId: LINKED_USER });
    await waitFor(() => member.nickname === null, 3000, "nickname reset after unlink");
    expect(member.roleIds).toEqual([]);
  });

  it("resyncs all links after connecting, including members unlinked while the bot was away", async () => {
    const { guild, store, requests, integration } = await phase2({
      before: (guild, links, store) => {
        guild.addMember(LINKED_USER);
        links.set(LINKED_USER, linkSummary());
        guild.addMember(OTHER_USER);
        store.update((state) => {
          state.linkedMembers[OTHER_USER] = "Old Main";
        });
      },
    });
    await waitFor(() => !(OTHER_USER in store.get().linkedMembers), 3000, "resync");
    await integration.idle();
    expect(requests).toContain("link.list");
    expect(guild.members.get(LINKED_USER)!.nickname).toBe("Red Trainer");
    expect(store.get().linkedMembers).toEqual({ [LINKED_USER]: "Red Trainer" });
  });

  it("makes no linking or session requests to a game without the features", async () => {
    const { server, requests, guild, integration } = await phase2({ features: [] });
    guild.addMember(LINKED_USER);
    server.emit({ kind: "account_link", scope: "account", action: "linked", discordUserId: LINKED_USER });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await integration.idle();
    expect(requests.filter((method) => method.startsWith("link.") || method.startsWith("admin."))).toEqual([]);
  });
});
