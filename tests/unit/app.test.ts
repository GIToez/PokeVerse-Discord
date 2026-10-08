import { GatewayIntentBits, IntentsBitField } from "discord.js";
import { afterEach, describe, expect, it } from "vitest";
import { BotApp } from "../../src/bot/app.js";
import { silentLogger } from "../../src/utils/logger.js";
import { makeConfig } from "../helpers/fakes.js";

describe("BotApp intents", () => {
  const apps: BotApp[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.stop()));
  });

  it("requests Message Content only when the bot runs, not for channel setup", () => {
    const running = new BotApp(makeConfig(), silentLogger);
    const setup = new BotApp(makeConfig(), silentLogger, { setupOnly: true });
    apps.push(running, setup);

    const runningIntents = new IntentsBitField(running.client.options.intents);
    const setupIntents = new IntentsBitField(setup.client.options.intents);
    expect(runningIntents.has(GatewayIntentBits.MessageContent)).toBe(true);
    expect(setupIntents.has(GatewayIntentBits.MessageContent)).toBe(false);
    expect(setupIntents.toArray()).toEqual(["Guilds"]);
  });
});
