import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StatusService } from "../../src/services/status/statusService.js";
import { silentLogger } from "../../src/utils/logger.js";
import { Metrics } from "../../src/utils/metrics.js";
import { StateStore } from "../../src/utils/stateStore.js";
import { FakeChannels, FakeGame, envelope, tempDir } from "../helpers/fakes.js";

function setup(file = join(tempDir(), "state.json")) {
  const store = new StateStore(file, "development");
  const channels = new FakeChannels();
  const game = new FakeGame();
  const metrics = new Metrics();
  const status = new StatusService({ game, channels, store, refreshSeconds: 60, logger: silentLogger, metrics });
  return { file, store, channels, game, status, metrics, channel: channels.channel("serverStatus") };
}

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
