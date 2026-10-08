import { describe, expect, it } from "vitest";
import { Announcer, buildRestartWarningEmbed } from "../../src/services/announcements/announcer.js";
import { DeliveryQueue } from "../../src/utils/deliveryQueue.js";
import { silentLogger } from "../../src/utils/logger.js";
import { Metrics } from "../../src/utils/metrics.js";
import { FakeChannels, envelope } from "../helpers/fakes.js";

function setup(options: { broadcasts?: boolean; restartWarnings?: boolean } = {}) {
  const channels = new FakeChannels();
  const metrics = new Metrics();
  const queue = new DeliveryQueue({ name: "announcements", maxSize: 10, maxAttempts: 1, retryDelayMs: 1, logger: silentLogger, metrics });
  const announcer = new Announcer({
    broadcasts: options.broadcasts ?? true,
    restartWarnings: options.restartWarnings ?? true,
    maxEventAgeSeconds: 600,
    channels,
    queue,
    logger: silentLogger,
    metrics,
  });
  return { announcer, channel: channels.channel("announcements"), queue };
}

describe("announcements", () => {
  it("posts GM broadcasts with the author", async () => {
    const { announcer, channel, queue } = setup();
    expect(announcer.handleBroadcast(envelope({ kind: "broadcast", source: "gm", author: "GM Oak", text: "Double XP **tonight**" }))).toBe(true);
    await queue.idle();
    const embed = channel.sent[0]!.message.embeds![0]!;
    expect(embed.title).toBe("Game Master broadcast");
    expect(embed.description).toBe("Double XP \\*\\*tonight\\*\\*");
    expect(embed.footer?.text).toBe("From GM Oak");
  });

  it("posts restart warnings and cancellations", async () => {
    const { announcer, channel, queue } = setup();
    announcer.handleRestartWarning(envelope({ kind: "restart_warning", reason: "shutdown", minutes: 5, shutdown: true }));
    announcer.handleRestartWarning(envelope({ kind: "restart_warning", reason: "shutdown_cancelled", shutdown: false }));
    await queue.idle();
    expect(channel.sent.map((item) => item.message.embeds![0]!.title)).toEqual(["Server restart", "Restart cancelled"]);
    expect(channel.sent[0]!.message.embeds![0]!.description).toContain("in 5 minutes");
    expect(buildRestartWarningEmbed({ kind: "restart_warning", reason: "global_save", minutes: 1 }, 0).description).toContain("in 1 minute.");
  });

  it("respects the switches and de-duplicates", async () => {
    const off = setup({ broadcasts: false, restartWarnings: false });
    expect(off.announcer.handleBroadcast(envelope({ kind: "broadcast", source: "gm", text: "x" }))).toBe(false);
    expect(off.announcer.handleRestartWarning(envelope({ kind: "restart_warning", reason: "global_save", minutes: 1 }))).toBe(false);

    const on = setup();
    const event = envelope({ kind: "broadcast", source: "staff", text: "x" });
    expect(on.announcer.handleBroadcast(event)).toBe(true);
    expect(on.announcer.handleBroadcast(event)).toBe(false);
  });

  it("posts admin announcements", async () => {
    const { announcer, channel } = setup();
    await announcer.announce("maintenance", "Tonight", "Server maintenance at 22:00.", "Jim");
    const embed = channel.sent[0]!.message.embeds![0]!;
    expect(embed.title).toBe("Maintenance: Tonight");
    expect(embed.footer?.text).toBe("Posted by Jim");
  });
});
