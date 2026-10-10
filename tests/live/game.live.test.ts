import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHmac } from "node:crypto";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GameIntegration } from "../../src/bot/integration.js";
import type { CommandInput } from "../../src/commands/router.js";
import { silentLogger } from "../../src/utils/logger.js";
import { Metrics } from "../../src/utils/metrics.js";
import { waitFor } from "../helpers/fakeBridgeServer.js";
import { DEV_GUILD, FakeChannels, FakeGuild, makeConfig, makeStore, setUpGuild } from "../helpers/fakes.js";

/**
 * Runs the bot's real pipeline (BridgeClient, services, command router) against a real
 * game server started by scripts/live-test.sh. Discord is replaced by in-memory channels.
 */
const port = process.env.PV_LIVE_BRIDGE_PORT;
const secret = process.env.PV_LIVE_SECRET;
const live = port && secret && process.env.PV_GAME_REPO ? describe : describe.skip;

const TRAINER = { account: "livetrainer", password: "secret", character: "Live Trainer" };
const STAFF = { account: "livestaff", password: "secret", character: "Live Staff" };
/** Two characters, "Live Linker" created first; scripts/live-test.sh gives the account premium days. */
const LINKER = { account: "livelink", password: "secret", character: "Live Second" };
const LINK_USER = "1234567890123456789";

class GameActor {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, (reply: Record<string, unknown>) => void>();
  private counter = 0;

  constructor() {
    this.process = spawn("python3", [fileURLToPath(new URL("./game_actor.py", import.meta.url))], { env: process.env });
    createInterface({ input: this.process.stdout }).on("line", (line) => {
      const reply = JSON.parse(line) as Record<string, unknown>;
      this.pending.get(reply.id as number)?.(reply);
    });
    this.process.stderr.on("data", (chunk) => process.stderr.write(`[game_actor] ${chunk}`));
  }

  async call(op: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = ++this.counter;
    const reply = await new Promise<Record<string, unknown>>((resolve) => {
      this.pending.set(id, resolve);
      this.process.stdin.write(JSON.stringify({ id, op, ...params }) + "\n");
    });
    if (!reply.ok) {
      throw new Error(`game actor ${op} failed: ${String(reply.error)}`);
    }
    return reply;
  }

  async stop(): Promise<void> {
    await this.call("quit").catch(() => undefined);
    this.process.kill();
  }
}

const user = { id: "700000000000000002", displayName: "Jim", roleIds: [], manageGuild: false };
const command = (commandName: string, options: Record<string, string>): CommandInput => ({
  commandName,
  options,
  user: { ...user, id: String(Math.floor(Math.random() * 1e17) + 7e17) },
  guildId: DEV_GUILD,
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

live("live: bot against the real PokeVerse game server", () => {
  let integration: GameIntegration;
  let channels: FakeChannels;
  let actor: GameActor;
  let guild: FakeGuild;
  const fieldsOf = (embed: { fields?: Array<{ name: string; value: string }> } | undefined) =>
    Object.fromEntries((embed?.fields ?? []).map((field) => [field.name, field.value]));
  const activity = () => embeds("playerActivity");
  const linkCommand = (commandName: string, options: Record<string, string> = {}): CommandInput => ({
    commandName,
    options,
    user: { id: LINK_USER, displayName: "Linker", roleIds: [], manageGuild: false },
    guildId: DEV_GUILD,
  });
  const embeds = (purpose: Parameters<FakeChannels["channel"]>[0]) =>
    channels.channel(purpose).sent.map((item) => item.message.embeds?.[0]);

  beforeAll(async () => {
    const config = makeConfig({
      BRIDGE_PORT: port!,
      BRIDGE_SECRET: secret!,
      POKEMON_ARTWORK_DIR: process.env.PV_LIVE_ARTWORK ?? "",
      SPAWN_LOCATION_MODE: "coordinates",
      DISCORD_ADMIN_USER_IDS: "700000000000000001",
    });
    channels = new FakeChannels();
    guild = new FakeGuild();
    guild.permissions = [...guild.permissions, "ManageRoles", "ManageNicknames"];
    guild.addMember(LINK_USER);
    integration = new GameIntegration({ config, store: makeStore(config), channels, guild: () => guild, logger: silentLogger, metrics: new Metrics() });
    const report = await setUpGuild(integration.setup, guild, channels);
    expect(report.ok).toBe(true);
    integration.start();
    await waitFor(() => integration.game.connected, 15_000, "bridge connection");

    actor = new GameActor();
    await actor.call("login", { player: "trainer", ...TRAINER });
    await actor.call("login", { player: "staff", ...STAFF });
    await actor.call("open_channel", { player: "trainer", channel: 7 });
    await actor.call("open_channel", { player: "staff", channel: 7 });
    await sleep(1500);
  });

  afterAll(async () => {
    await actor?.stop();
    await integration?.stop();
  });

  it("reads the real server status", async () => {
    const status = await integration.game.serverStatus();
    expect(status.serverName).toBeTruthy();
    expect(status.state).toBe("normal");
    expect(status.playersOnline).toBeGreaterThanOrEqual(2);
    expect(status.bootId).toBe(integration.bridge.bootId);
    const response = await integration.commands.handle(command("server", {}));
    const fields = Object.fromEntries(response.message.embeds![0]!.fields!.map((field) => [field.name, field.value]));
    expect(fields.Status).toBe("Online");
    expect(Number(fields["Players online"]!.split(" ")[0])).toBeGreaterThanOrEqual(2);
    await waitFor(() => channels.channel("serverStatus").sent.length === 1, 5000, "status message");
  });

  it("/trainer shows real data, hides staff and handles unknown names", async () => {
    const found = await integration.commands.handle(command("trainer", { name: TRAINER.character }));
    const embed = found.message.embeds![0]!;
    expect(embed.title).toBe(`Trainer ${TRAINER.character}`);
    const fields = Object.fromEntries(embed.fields!.map((field) => [field.name, field.value]));
    expect(fields.Status).toBe("Online");
    expect(Number(fields.Level)).toBeGreaterThanOrEqual(1);
    expect(fields.PvP).toContain("Duels won: **0**");
    console.log("[live] /trainer fields:", JSON.stringify(fields));

    const staff = await integration.commands.handle(command("trainer", { name: STAFF.character }));
    expect(staff.message.embeds![0]!.description).toMatch(/No trainer named/);
    const unknown = await integration.commands.handle(command("trainer", { name: "Nobody Here" }));
    expect(unknown.message.embeds![0]!.description).toMatch(/No trainer named/);
  });

  it("/pokemon shows real species data with game artwork, and autocompletes", async () => {
    const response = await integration.commands.handle(command("pokemon", { name: "bulbasaur" }));
    const embed = response.message.embeds![0]!;
    expect(embed.title).toBe("#001 Bulbasaur");
    console.log("[live] /pokemon Bulbasaur:", JSON.stringify(embed.fields));
    if (process.env.PV_LIVE_ARTWORK) {
      expect(response.message.files?.[0]?.name).toBe("pokemon-1.png");
    }
    const missing = await integration.commands.handle(command("pokemon", { name: "Agumon" }));
    expect(missing.message.embeds![0]!.description).toMatch(/No Pokemon named "Agumon"/);
    const suggestions = await integration.commands.autocomplete("pokemon", "name", "bulb");
    expect(suggestions.map((choice) => choice.name)).toContain("Bulbasaur");
  });

  it("relays Discord chat into the game channel", async () => {
    const marker = `live${Date.now()}`;
    const outcome = await integration.chat.handleDiscordMessage({
      id: "1", guildId: DEV_GUILD, channelId: channels.channel("gameChat").id, authorId: user.id, authorName: "Jim",
      isBot: false, isWebhook: false, isSystem: false, content: `hello **${marker}**`, attachmentCount: 0,
    });
    expect(outcome).toBe("sent");
    // Shown in game as "[Discord] Jim: hello <marker>" (author and text are separate packet fields).
    const seen = await actor.call("wait_for_channel_message", {
      player: "trainer",
      author: "[Discord] Jim",
      channel: 7,
      text: `hello ${marker}`,
      timeout: 5,
    });
    expect(seen.found).toBe(true);
    // The game does not echo bridge messages back as chat events (no loop).
    await sleep(1500);
    expect(channels.channel("gameChat").contents().some((line) => line.includes(marker))).toBe(false);
  });

  it("relays game chat to Discord", async () => {
    const marker = `game${Date.now()}`;
    await actor.call("say_channel", { player: "staff", channel: 7, text: `hi from ${marker}` });
    await waitFor(() => channels.channel("gameChat").contents().some((line) => line.includes(marker)), 5000, "game chat");
    expect(channels.channel("gameChat").contents()).toContain(`[Game] ${STAFF.character}: hi from ${marker}`);
  });

  it("does not announce a failed catch", async () => {
    const before = channels.channel("catches").sent.length;
    await actor.call("say", { player: "trainer", text: "/bridgetest miss Bulbasaur" });
    await sleep(8000);
    await integration.idle();
    expect(channels.channel("catches").sent.length).toBe(before);
  });

  it("announces a confirmed catch exactly once", async () => {
    await actor.call("say", { player: "trainer", text: "/bridgetest catch Rattata" });
    await waitFor(() => channels.channel("catches").sent.length === 1, 20_000, "catch announcement");
    const embed = embeds("catches")[0]!;
    console.log("[live] catch embed:", JSON.stringify(embed));
    expect(embed.title).toBe("Rattata caught!");
    expect(embed.description).toBe(`**${TRAINER.character}** caught **Rattata**.`);
    expect(embed.footer?.text).toBe("Pokedex #019");
    await sleep(2000);
    expect(channels.channel("catches").sent).toHaveLength(1);
  });

  it("alerts shiny and legendary spawns from real spawn hooks, once each", async () => {
    await actor.call("say", { player: "trainer", text: "/bridgetest spawn Shiny Rattata" });
    await waitFor(() => channels.channel("shinySpawns").sent.some((item) => item.message.embeds?.[0]?.title === "Shiny Rattata spotted!"), 10_000, "shiny alert");
    await actor.call("say", { player: "trainer", text: "/bridgetest spawn Mewtwo" });
    await waitFor(() => channels.channel("legendarySpawns").sent.length === 1, 10_000, "legendary alert");
    const legendary = embeds("legendarySpawns")[0]!;
    console.log("[live] legendary embed:", JSON.stringify(legendary));
    expect(legendary.title).toBe("Legendary Mewtwo spotted!");
    expect(legendary.fields!.find((field) => field.name === "Source")!.value).toBe("Event");
    expect(legendary.fields!.find((field) => field.name === "Location")!.value).toMatch(/\d+, \d+, \d+/);

    const shinyCount = channels.channel("shinySpawns").sent.length;
    await actor.call("say", { player: "trainer", text: "/bridgetest spawn Mewtwo" });
    await actor.call("say", { player: "trainer", text: "/bridgetest spawn Rattata" });
    await sleep(3000);
    await integration.idle();
    expect(channels.channel("legendarySpawns").sent).toHaveLength(1);
    expect(channels.channel("shinySpawns").sent).toHaveLength(shinyCount);
  });

  it("posts a GM broadcast once", async () => {
    const marker = `bc${Date.now()}`;
    await actor.call("say", { player: "staff", text: `/b Event ${marker}` });
    await waitFor(() => channels.channel("announcements").sent.some((item) => item.message.embeds?.[0]?.description?.includes(marker)), 5000, "broadcast");
    await sleep(1500);
    const matching = channels.channel("announcements").sent.filter((item) => item.message.embeds?.[0]?.description?.includes(marker));
    expect(matching).toHaveLength(1);
    expect(matching[0]!.message.embeds![0]!.footer?.text).toBe(`From ${STAFF.character}`);
  });

  it("posts real logins to the private #player-activity channel", async () => {
    expect(integration.bridge.hasFeature("playerSessions")).toBe(true);
    await waitFor(() => activity().filter((embed) => embed?.title === "Login").length >= 2, 10_000, "login embeds");
    const login = activity().find((embed) => embed?.title === "Login" && fieldsOf(embed).Character === TRAINER.character)!;
    const fields = fieldsOf(login);
    console.log("[live] login embed:", JSON.stringify(fields));
    expect(fields.Account).toMatch(/^#\d+$/);
    expect(fields["IP address"]).toBe("`127.0.0.1`");
    expect(fields["Location (approximate)"]).toBe("No location (this machine (loopback))");
    expect(fields.Session).toMatch(new RegExp(`^${integration.bridge.bootId}-`));
    expect(Number(fields["Players online"])).toBeGreaterThanOrEqual(1);
    expect(activity().filter((embed) => embed?.title === "Login" && fieldsOf(embed).Character === TRAINER.character)).toHaveLength(1);
  });

  it("links a real game account with a code from !discord link, then syncs roles and nickname", async () => {
    expect(integration.linking!.available).toBe(true);
    await actor.call("login", { player: "linker", ...LINKER });
    const reply = await actor.call("command", { player: "linker", text: "!discord link" });
    const code = /link code is ([0-9A-Z]{4}-[0-9A-Z]{4})/.exec(String(reply.text))?.[1];
    expect(code, String(reply.text)).toBeDefined();

    const wrong = await integration.commands.handle(linkCommand("link", { code: "AAAA-AAAA" }));
    expect(wrong.message.embeds![0]!.description).toMatch(/not valid/);
    const linked = await integration.commands.handle(linkCommand("link", { code: code!.toLowerCase().replace("-", " ") }));
    console.log("[live] /link reply:", linked.message.embeds![0]!.description);
    expect(linked.message.embeds![0]!.description).toMatch(/now linked/);
    expect(linked.message.embeds![0]!.description).toContain("Main character: **Live Linker**");
    const member = guild.members.get(LINK_USER)!;
    const roles = integration.linking!.roleIds();
    expect(member.roleIds).toEqual([roles.verified, roles.premium]);
    expect(member.nickname).toBe("Live Linker");
    const reused = await integration.commands.handle(linkCommand("link", { code: code! }));
    expect(reused.message.embeds![0]!.description).toMatch(/already linked/);

    await waitFor(() => activity().some((embed) => embed?.title === "Account linked"), 10_000, "link embed");
    const linkPost = fieldsOf(activity().find((embed) => embed?.title === "Account linked"));
    console.log("[live] link embed:", JSON.stringify(linkPost));
    expect(linkPost["Discord user"]).toBe(`<@${LINK_USER}> (\`${LINK_USER}\`)`);
    expect(linkPost["Main character"]).toMatch(/^Live Linker \(level \d+\)$/);
    expect(linkPost.Characters).toBe("2");
    expect(linkPost.Premium).toMatch(/^Yes \(\d+ days left\)$/);
    expect(linkPost.Roles).toBe("Given: Verified Trainer, Ace Trainer");
    expect(activity().filter((embed) => embed?.title === "Account linked")).toHaveLength(1);

    const status = await actor.call("command", { player: "linker", text: "!discord status" });
    expect(String(status.text)).toContain("is linked to Discord since");
  });

  it("/account, /characters and /main use the real account data", async () => {
    const account = await integration.commands.handle(linkCommand("account"));
    const fields = fieldsOf(account.message.embeds![0]);
    console.log("[live] /account fields:", JSON.stringify(fields));
    expect(fields.Characters).toBe("2");
    expect(fields.Premium).toMatch(/^Yes \(\d+ days left\)$/);
    expect(fields["Main character"]).toMatch(/^Live Linker \(level \d+/);

    const characters = await integration.commands.handle(linkCommand("characters"));
    const list = characters.message.embeds![0]!.description!;
    expect(list).toMatch(/\*\*Live Linker\*\*: level \d+.*\(main\)/);
    expect(list).toMatch(/\*\*Live Second\*\*: level \d+.*\(online\)/);
    expect(await integration.commands.autocomplete("main", "character", "second", LINK_USER)).toEqual([
      expect.objectContaining({ value: "Live Second" }),
    ]);

    const other = await integration.commands.handle(linkCommand("main", { character: TRAINER.character }));
    expect(other.message.embeds![0]!.description).toMatch(/not on your linked account/);
    const main = await integration.commands.handle(linkCommand("main", { character: "Live Second" }));
    expect(main.message.embeds![0]!.description).toContain("Main character set to **Live Second**");
    expect(guild.members.get(LINK_USER)!.nickname).toBe("Live Second");
  });

  it("posts a real logout with the reported reason", async () => {
    await actor.call("logout", { player: "linker" });
    await waitFor(() => activity().some((embed) => embed?.title === "Logout" && fieldsOf(embed).Character === LINKER.character), 10_000, "logout embed");
    const fields = fieldsOf(activity().find((embed) => embed?.title === "Logout" && fieldsOf(embed).Character === LINKER.character));
    console.log("[live] logout embed:", JSON.stringify(fields));
    expect(fields.Reason).toBe("Logged out");
    expect(fields["Session length"]).toBeTruthy();
  });

  it("removes the roles and nickname after an in-game unlink", async () => {
    await actor.call("login", { player: "linker2", ...LINKER });
    const first = await actor.call("command", { player: "linker2", text: "!discord unlink" });
    expect(String(first.text)).toContain("!discord unlink confirm");
    const done = await actor.call("command", { player: "linker2", text: "!discord unlink confirm" });
    expect(String(done.text)).toContain("no longer linked");
    await waitFor(() => guild.members.get(LINK_USER)!.roleIds.length === 0, 10_000, "roles removed");
    await waitFor(() => guild.members.get(LINK_USER)!.nickname === null, 10_000, "nickname reset");
    const account = await integration.commands.handle(linkCommand("account"));
    expect(account.message.embeds![0]!.description).toMatch(/not linked/);
    await waitFor(() => activity().some((embed) => embed?.title === "Account unlinked"), 10_000, "unlink embed");
    const unlinkPost = fieldsOf(activity().find((embed) => embed?.title === "Account unlinked"));
    console.log("[live] unlink embed:", JSON.stringify(unlinkPost));
    expect(unlinkPost.How).toBe("`!discord unlink` in the game");
    expect(unlinkPost.Roles).toBe("Removed: Verified Trainer, Ace Trainer");
  });

  it("reconnects after losing the bridge connection and keeps working", async () => {
    const bootId = integration.bridge.bootId;
    // A second authenticated client replaces the bot's connection on the real server.
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(Number(port), "127.0.0.1");
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        for (const line of buffer.split("\n").slice(0, -1)) {
          const message = JSON.parse(line) as { type: string; nonce?: string };
          if (message.type === "hello") {
            socket.write(JSON.stringify({ type: "auth", hmac: createHmac("sha256", secret!).update(message.nonce!).digest("hex") }) + "\n");
          } else if (message.type === "welcome") {
            socket.end();
            resolve();
          }
        }
        buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
      });
      socket.on("error", reject);
    });
    await waitFor(() => integration.status.current.disconnects >= 1, 5000, "disconnect noticed");
    await waitFor(() => integration.game.connected, 15_000, "reconnected");
    expect(integration.bridge.bootId).toBe(bootId);
    expect(integration.status.current.lastRestartAt).toBeUndefined();
    const marker = `again${Date.now()}`;
    await actor.call("say_channel", { player: "staff", channel: 7, text: marker });
    await waitFor(() => channels.channel("gameChat").contents().some((line) => line.includes(marker)), 5000, "chat after reconnect");
    // A bridge reconnect is not a logout: open sessions stay open.
    await sleep(4000);
    await integration.idle();
    expect(activity().filter((embed) => embed?.title?.startsWith("Session ended"))).toHaveLength(0);
  });

  it("posts restart warnings and their cancellation", async () => {
    await actor.call("say", { player: "staff", text: "/shutdown 10" });
    await waitFor(() => embeds("announcements").some((embed) => embed?.title === "Server restart"), 5000, "restart warning");
    await actor.call("say", { player: "staff", text: "/shutdown stop" });
    await waitFor(() => embeds("announcements").some((embed) => embed?.title === "Restart cancelled"), 5000, "cancel");
    expect(embeds("announcements").find((embed) => embed?.title === "Server restart")!.description).toContain("in 10 minutes");
  });
});
