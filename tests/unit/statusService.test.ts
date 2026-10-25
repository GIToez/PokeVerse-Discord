import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StatusService } from "../../src/services/status/statusService.js";
import { silentLogger } from "../../src/utils/logger.js";
import { Metrics } from "../../src/utils/metrics.js";
import { StateStore } from "../../src/utils/stateStore.js";
import { FakeChannels, FakeGame, envelope, tempDir } from "../helpers/fakes.js";

function setup(file = join(tempDir(), "state.json"), clock = { now: NOW }) {
  const store = new StateStore(file, "development");
  const channels = new FakeChannels();
  const game = new FakeGame();
  const metrics = new Metrics();
  const status = new StatusService({ game, channels, store, refreshSeconds: 60, logger: silentLogger, metrics, now: () => clock.now });
  return { file, store, channels, game, status, metrics, clock, channel: channels.channel("serverStatus") };
}

const NOW = 1_800_000_000_000;
const NOW_S = NOW / 1000;
const CONNECTED = { bootId: "boot1", serverName: "PokeVerse", queued: 0, features: [], restarted: false, previousBootId: undefined };

const field = (embed: { fields?: Array<{ name: string; value: string }> }, name: string) =>
  embed.fields?.find((item) => item.name === name)?.value;

describe("server status", () => {
  it("creates one persistent message and edits it afterwards", async () => {
    const { status, channel, store } = setup();
    await status.onConnected({ bootId: "boot1", serverName: "PokeVerse", queued: 0, features: [], restarted: false, previousBootId: undefined });
    expect(channel.sent).toHaveLength(1);
    const embed = channel.sent[0]!.message.embeds![0]!;
    expect(field(embed, "Status")).toBe("Online");
    expect(field(embed, "Players online")).toBe("3 / 1000");
    expect(field(embed, "Uptime")).toMatch(/^1h 0m/);
    expect(store.get().statusMessageId).toBe(channel.sent[0]!.id);

    await status.refresh();
    await status.refresh();
    expect(channel.sent).toHaveLength(1);
    expect(channel.edits.length).toBeGreaterThanOrEqual(2);
  });

  it("recreates the message if an admin deleted it", async () => {
    const { status, channel, store } = setup();
    await status.refresh();
    channel.existing.clear();
    await status.refresh();
    expect(channel.sent).toHaveLength(2);
    expect(store.get().statusMessageId).toBe(channel.sent[1]!.id);
  });

  it("shows offline and disconnect information", async () => {
    const { status, channel, game } = setup();
    await status.onConnected({ bootId: "boot1", serverName: "PokeVerse", queued: 0, features: [], restarted: false, previousBootId: undefined });
    game.connected = false;
    status.onDisconnected("connection closed");
    await status.render();
    const embed = channel.edits.at(-1)!.message.embeds![0]!;
    expect(field(embed, "Status")).toBe("Offline");
    expect(field(embed, "Offline since")).toMatch(/^<t:\d+:R>$/);
    expect(field(embed, "Disconnects (since bot start)")).toBe("1");
    expect(field(embed, "Players online")).toBeUndefined();
  });

  it("detects game restarts across bot restarts using the saved boot id", async () => {
    const first = setup();
    await first.status.onConnected({ bootId: "boot1", serverName: "PokeVerse", queued: 0, features: [], restarted: false, previousBootId: undefined });
    expect(first.status.current.lastRestartAt).toBeUndefined();
    expect(first.store.get().lastBootId).toBe("boot1");

    // The bot restarts, then the game restarts: the new boot id differs from the saved one.
    const second = setup(first.file);
    await second.status.onConnected({ bootId: "boot2", serverName: "PokeVerse", queued: 0, features: [], restarted: false, previousBootId: undefined });
    expect(second.status.current.lastRestartAt).toBeGreaterThan(0);
    expect(second.metrics.get("status.restarts_detected")).toBe(1);
    expect(new StateStore(first.file, "development").get().lastRestartAt).toBe(second.status.current.lastRestartAt);
  });

  it("reflects server_state events such as maintenance", async () => {
    const { status, channel } = setup();
    await status.refresh();
    status.onServerState(envelope({ kind: "server_state", state: "maintain", players: 1 }));
    await status.render();
    const embed = channel.edits.at(-1)!.message.embeds![0]!;
    expect(field(embed, "Status")).toBe("Maintenance (staff only)");
  });

  it("coalesces concurrent renders into at most one follow-up", async () => {
    const { status, channel } = setup();
    await status.refresh();
    const before = channel.edits.length;
    await Promise.all([status.render(), status.render(), status.render(), status.render()]);
    expect(channel.edits.length - before).toBeLessThanOrEqual(2);
  });
});

describe("restart countdown", () => {
  const latest = (channel: ReturnType<typeof setup>["channel"]) => (channel.edits.at(-1) ?? channel.sent.at(-1))!.message.embeds![0]!;

  it("shows the game's next planned restart", async () => {
    const { status, channel, game } = setup();
    game.status = { ...game.status, restart: { at: NOW_S + 3 * 3600, reason: "daily" } };
    await status.onConnected(CONNECTED);
    const embed = latest(channel);
    expect(field(embed, "Status")).toBe("Online");
    expect(field(embed, "Next restart")).toBe(`Daily restart at <t:${NOW_S + 10800}:t> (<t:${NOW_S + 10800}:R>)`);
    expect(embed.description).toBeUndefined();
  });

  it("has no Next restart field when the game sends none", async () => {
    const { status, channel } = setup();
    await status.onConnected(CONNECTED);
    expect(field(latest(channel), "Next restart")).toBeUndefined();
  });

  it("edits the status message for each warning, never posting a new one, and snaps to the planned time", async () => {
    const { status, channel, game, store, metrics } = setup();
    const at = NOW_S + 600 + 20;
    game.status = { ...game.status, restart: { at, reason: "staff" } };
    await status.onConnected(CONNECTED);
    for (const minutes of [10, 5, 1]) {
      status.onRestartWarning({ kind: "restart_warning", reason: "shutdown", minutes, shutdown: true }, NOW_S + 600 - minutes * 60);
      await status.render();
    }
    expect(channel.sent).toHaveLength(1);
    const embed = latest(channel);
    expect(field(embed, "Status")).toBe("Restarting soon");
    expect(field(embed, "Next restart")).toBe(`<t:${at}:t> (<t:${at}:R>)`);
    expect(embed.description).toBe(`The server restarts <t:${at}:R> (at <t:${at}:t>). Please log out safely.`);
    expect(store.get().pendingRestart).toEqual({ at, kind: "restart", bootId: "boot1" });
    expect(metrics.get("status.restart_warnings")).toBe(3);
  });

  it("clears the countdown when staff cancel it", async () => {
    const { status, channel, game, store } = setup();
    await status.onConnected(CONNECTED);
    status.onRestartWarning({ kind: "restart_warning", reason: "shutdown", minutes: 10, shutdown: true }, NOW_S);
    game.status = { ...game.status, restart: { at: NOW_S + 7200, reason: "daily" } };
    status.onRestartWarning({ kind: "restart_warning", reason: "shutdown_cancelled", shutdown: false }, NOW_S + 60);
    await status.refresh();
    const embed = latest(channel);
    expect(field(embed, "Status")).toBe("Online");
    expect(embed.description).toBeUndefined();
    expect(field(embed, "Next restart")).toContain("Daily restart");
    expect(store.get().pendingRestart).toBeUndefined();
  });

  it("shows Restarting while the server is down, then clears when it comes back with a new boot id", async () => {
    const { status, channel, game, clock, store } = setup();
    await status.onConnected(CONNECTED);
    status.onRestartWarning({ kind: "restart_warning", reason: "shutdown", minutes: 1, shutdown: true }, NOW_S);
    clock.now = NOW + 70_000;
    game.connected = false;
    status.onDisconnected("connection closed");
    await status.render();
    let embed = latest(channel);
    expect(field(embed, "Status")).toBe("Restarting");
    expect(embed.description).toContain("restarting");

    game.connected = true;
    game.status = { ...game.status, bootId: "boot2" };
    await status.onConnected({ ...CONNECTED, bootId: "boot2", restarted: true, previousBootId: "boot1" });
    embed = latest(channel);
    expect(field(embed, "Status")).toBe("Online");
    expect(embed.description).toBeUndefined();
    expect(store.get().pendingRestart).toBeUndefined();
  });

  it("goes back to Offline when the server stays down long after the warned restart", async () => {
    const { status, channel, game, clock } = setup();
    await status.onConnected(CONNECTED);
    status.onRestartWarning({ kind: "restart_warning", reason: "shutdown", minutes: 1, shutdown: true }, NOW_S);
    game.connected = false;
    status.onDisconnected("connection closed");
    clock.now = NOW + 20 * 60_000;
    await status.refresh();
    expect(field(latest(channel), "Status")).toBe("Offline");
  });

  it("shows a save countdown that expires on its own", async () => {
    const { status, channel, clock, store } = setup();
    await status.onConnected(CONNECTED);
    status.onRestartWarning({ kind: "restart_warning", reason: "global_save", minutes: 5, shutdown: false }, NOW_S);
    await status.render();
    let embed = latest(channel);
    expect(field(embed, "Status")).toBe("Online");
    expect(embed.description).toBe(`The server saves <t:${NOW_S + 300}:R>. Please find a safe place.`);
    clock.now = NOW + 10 * 60_000;
    await status.refresh();
    embed = latest(channel);
    expect(embed.description).toBeUndefined();
    expect(store.get().pendingRestart).toBeUndefined();
  });

  it("keeps the countdown across a bot restart", async () => {
    const first = setup();
    await first.status.onConnected(CONNECTED);
    first.status.onRestartWarning({ kind: "restart_warning", reason: "shutdown", minutes: 10, shutdown: true }, NOW_S);
    const second = setup(first.file);
    await second.status.onConnected(CONNECTED);
    expect(field(latest(second.channel), "Status")).toBe("Restarting soon");
  });
});
