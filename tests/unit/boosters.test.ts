import { describe, expect, it } from "vitest";
import { BoosterRewards, DAY_MS, WEEK_MS, type BoosterReward } from "../../src/services/boosters/boosterRewards.js";
import { DeliveryQueue } from "../../src/utils/deliveryQueue.js";
import { silentLogger } from "../../src/utils/logger.js";
import { Metrics } from "../../src/utils/metrics.js";
import { FakeBoosterApi, FakeChannels, FakeGuild, FakeLinkApi, LINKED_USER, linkSummary, makeStore } from "../helpers/fakes.js";

const T0 = 1_800_000_000_000;
const HOUR_MS = 3_600_000;

function setup(config: Partial<{ reminders: boolean; mention: boolean }> = {}) {
  let now = T0;
  const guild = new FakeGuild();
  const store = makeStore();
  const links = new FakeLinkApi();
  const api = new FakeBoosterApi(() => now);
  const channels = new FakeChannels(["boosterRewards"]);
  const metrics = new Metrics();
  const queue = new DeliveryQueue({ name: "boosters", maxSize: 100, maxAttempts: 1, retryDelayMs: 1, logger: silentLogger, metrics });
  const rewards: BoosterReward[] = [];
  const service = new BoosterRewards({
    config: { reminders: true, mention: true, checkMinutes: 0, ...config },
    api, links, guild: () => guild, channels, store, queue, logger: silentLogger, metrics,
    onReward: (reward) => rewards.push(reward),
    now: () => now,
    boostsSettleMs: 0,
  });
  const member = guild.addMember(LINKED_USER);
  const link = (atMs = now) => {
    links.link(LINKED_USER, { link: linkSummary({ discordUserId: LINKED_USER, linkedAt: Math.floor(atMs / 1000) }) });
    api.linkedAt.set(LINKED_USER, Math.floor(atMs / 1000));
  };
  /** What a link sync does: the member and their link as they are now. */
  const sync = async () => {
    const account = await links.account(LINKED_USER);
    service.observe(LINKED_USER, await guild.fetchMember(LINKED_USER), account.linked ? account : undefined);
    await service.idle();
    await queue.idle();
  };
  const posts = () => channels.channel("boosterRewards").sent.map((item) => item.message);
  const lastText = () => posts().at(-1)?.embeds?.[0]?.description ?? "";
  return {
    guild, store, links, api, channels, service, member, rewards, link, sync, posts, lastText, queue,
    advance: (ms: number) => {
      now += ms;
    },
    at: () => now,
  };
}

describe("booster rewards", () => {
  it("pays 1 Soul Coin after 7 days of continuous boosting, once", async () => {
    const { member, link, sync, advance, posts, api, store, rewards } = setup();
    link(T0 - DAY_MS);
    member.premiumSince = T0;
    await sync();
    expect(posts()).toEqual([]);
    advance(WEEK_MS - HOUR_MS);
    await sync();
    expect(api.deposited(LINKED_USER)).toBe(0);
    advance(HOUR_MS);
    await sync();
    await sync();
    expect(api.deposited(LINKED_USER)).toBe(1);
    expect(posts()).toHaveLength(1);
    const post = posts()[0]!;
    expect(post.content).toBe(`<@${LINKED_USER}>`);
    expect(post.mentionUserIds).toEqual([LINKED_USER]);
    expect(post.embeds![0]!.title).toBe("🎉 PokeVerse Booster Reward");
    expect(post.embeds![0]!.description).toBe([
      `Thank you for supporting our community, <@${LINKED_USER}>!`,
      "",
      "💎 Weekly Reward: +1 Soul Coin",
      "🔥 Continuous Boosting: 7 days",
      "",
      "**Total Deposited: 1 Soul Coin**",
    ].join("\n"));
    expect(store.get().boosters[LINKED_USER]).toMatchObject({ since: T0, paidWeek: 1, total: 1, linked: true });
    expect(rewards).toEqual([{ discordUserId: LINKED_USER, weeks: [1], weekly: 1, loyalty: 0, yearly: 0, community: 0, serverBoosts: 0, total: 1, streakDays: 7, streakTotal: 1 }]);
  });

  it("adds the loyalty bonus every 4th week: 5 Soul Coins in 28 days", async () => {
    const { member, link, sync, advance, api, lastText } = setup();
    link(T0 - DAY_MS);
    member.premiumSince = T0;
    for (let week = 1; week <= 4; week++) {
      advance(WEEK_MS);
      await sync();
    }
    expect(api.deposited(LINKED_USER)).toBe(5);
    expect(lastText()).toContain("💎 Weekly Reward: +1 Soul Coin\n🔥 Continuous Boosting: 28 days\n🎁 Loyalty Bonus: +1 Soul Coin");
    expect(lastText()).toContain("**Total Deposited: 2 Soul Coins**");
  });

  it("adds the yearly milestone at week 52", async () => {
    const { member, link, sync, store, lastText, at } = setup();
    member.premiumSince = at() - 52 * WEEK_MS - HOUR_MS;
    link(member.premiumSince);
    store.update((state) => {
      state.boosters[LINKED_USER] = { since: member.premiumSince!, paidWeek: 51, total: 63, linked: true };
    });
    await sync();
    expect(lastText()).toContain("🏆 1 Year Milestone: +15 Soul Coins");
    expect(lastText()).toContain("**Total Deposited: 17 Soul Coins**");
    expect(store.get().boosters[LINKED_USER]!.total).toBe(80);
  });

  it("never pays a boost that started less than 7 days ago, even right before a check", async () => {
    const { member, link, sync, advance, api, store } = setup();
    link(T0 - 30 * DAY_MS);
    member.premiumSince = T0 - 30 * DAY_MS;
    await sync();
    expect(api.deposited(LINKED_USER)).toBe(4 + 1);
    // Boost removed, then boosted again an hour before the next check.
    member.premiumSince = null;
    await sync();
    expect(store.get().boosters[LINKED_USER]).toBeUndefined();
    advance(6 * DAY_MS);
    member.premiumSince = T0 + 6 * DAY_MS - HOUR_MS;
    await sync();
    advance(2 * HOUR_MS);
    await sync();
    expect(api.deposited(LINKED_USER)).toBe(5);
    expect(store.get().boosters[LINKED_USER]).toMatchObject({ paidWeek: 0, total: 0 });
    advance(WEEK_MS);
    await sync();
    expect(api.deposited(LINKED_USER)).toBe(6);
  });

  it("treats a changed boost start as a reset, even if the bot never saw the boost end", async () => {
    const { member, link, sync, advance, store, api } = setup();
    link(T0 - DAY_MS);
    member.premiumSince = T0;
    advance(3 * WEEK_MS);
    await sync();
    expect(store.get().boosters[LINKED_USER]).toMatchObject({ paidWeek: 3, total: 3 });
    // Removed after that payout and boosted again: Discord reports a new start time.
    advance(2 * HOUR_MS);
    member.premiumSince = T0 + 3 * WEEK_MS + HOUR_MS;
    await sync();
    expect(store.get().boosters[LINKED_USER]).toMatchObject({ since: member.premiumSince, paidWeek: 0, total: 0 });
    advance(WEEK_MS);
    await sync();
    // Week 1 of the new streak; the old streak's week 4 loyalty bonus is gone.
    expect(api.deposited(LINKED_USER)).toBe(4);
  });

  it("pays only weeks completed while linked; earlier days still count for the bonuses", async () => {
    const { member, link, sync, advance, api, store } = setup();
    member.premiumSince = T0;
    advance(10 * DAY_MS);
    link();
    await sync();
    expect(api.calls.filter((call) => call.startsWith("booster.week"))).toEqual([]);
    expect(store.get().boosters[LINKED_USER]!.paidWeek).toBe(1);
    advance(18 * DAY_MS);
    await sync();
    // Weeks 2, 3 and 4 (with the loyalty bonus).
    expect(api.deposited(LINKED_USER)).toBe(4);
  });

  it("reminds an unlinked booster once, and once more after an unpaid week, then stops", async () => {
    const { member, guild, service, link, sync, advance, posts, api, store } = setup();
    member.premiumSince = T0;
    service.onBoostMessage(LINKED_USER);
    await service.idle();
    await sync();
    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.embeds![0]!.description).toContain("link your game account to receive Soul Coins");
    advance(WEEK_MS);
    await sync();
    expect(posts()).toHaveLength(2);
    expect(posts()[1]!.embeds![0]!.title).toBe("💎 A boost week went unpaid");
    advance(WEEK_MS);
    await sync();
    expect(await service.checkUnlinked()).toBe(1);
    expect(posts()).toHaveLength(2);
    expect(api.deposited(LINKED_USER)).toBe(0);
    // Linking stops the reminders and starts the payouts from the next week.
    advance(HOUR_MS);
    link();
    advance(WEEK_MS);
    await sync();
    expect(api.deposited(LINKED_USER)).toBe(1);
    expect(store.get().boosters[LINKED_USER]!.linked).toBe(true);
    guild.members.delete(LINKED_USER);
    await sync();
    expect(store.get().boosters[LINKED_USER]).toBeUndefined();
  });

  it("can turn reminders and pings off", async () => {
    const quiet = setup({ reminders: false, mention: false });
    quiet.member.premiumSince = T0;
    await quiet.sync();
    expect(quiet.posts()).toEqual([]);
    quiet.link(T0 - DAY_MS);
    quiet.advance(WEEK_MS);
    await quiet.sync();
    expect(quiet.posts()[0]!.content).toBeUndefined();
    expect(quiet.posts()[0]!.mentionUserIds).toBeUndefined();
  });

  it("waits while the game is offline or without the feature, then pays every missed week in one post", async () => {
    const { member, link, sync, advance, api, lastText, posts } = setup();
    link(T0 - DAY_MS);
    member.premiumSince = T0;
    api.features.clear();
    advance(WEEK_MS);
    await sync();
    api.features.add("boosterRewards");
    api.connected = false;
    advance(WEEK_MS);
    await sync();
    expect(posts()).toEqual([]);
    api.connected = true;
    await sync();
    expect(api.deposited(LINKED_USER)).toBe(2);
    expect(lastText()).toContain("💎 Weekly Reward: +2 Soul Coins (2 weeks)");
    expect(lastText()).toContain("🔥 Continuous Boosting: 14 days");
  });

  it("never pays twice when the bot lost its state; retries a failed deposit later", async () => {
    const { member, link, sync, advance, api, store, posts } = setup();
    link(T0 - DAY_MS);
    member.premiumSince = T0;
    advance(WEEK_MS);
    api.failNext = ["db_error"];
    await sync();
    expect(api.deposited(LINKED_USER)).toBe(0);
    expect(store.get().boosters[LINKED_USER]!.paidWeek).toBe(0);
    await sync();
    expect(api.deposited(LINKED_USER)).toBe(1);
    store.update((state) => {
      state.boosters = {};
    });
    await sync();
    expect(api.deposited(LINKED_USER)).toBe(1);
    // The member is told once more (the post may have been lost with the state).
    expect(posts()).toHaveLength(2);
    expect(store.get().boosters[LINKED_USER]).toMatchObject({ paidWeek: 1, total: 1 });
  });

  it("stops on an outdated streak the game refuses", async () => {
    const { member, link, sync, advance, api, store } = setup();
    link(T0 - DAY_MS);
    member.premiumSince = T0;
    advance(2 * WEEK_MS);
    api.failNext = ["stale_streak"];
    await sync();
    expect(store.get().boosters[LINKED_USER]!.paidWeek).toBe(2);
    expect(api.deposited(LINKED_USER)).toBe(0);
  });

  it("/booster explains the streak, the link state and the next rewards", async () => {
    const { member, link, service, advance, at } = setup();
    expect(await service.statusText(LINKED_USER)).toContain("You are not boosting the server right now.");
    expect(await service.statusText(LINKED_USER)).toContain("1 Soul Coin every 7 days of continuous boosting, +1 Soul Coin every 4 weeks, " +
      "+1 more on those weeks for every 5 server boosts (up to +5), +15 Soul Coins every year");
    member.premiumSince = T0;
    advance(10 * DAY_MS);
    expect(await service.statusText(LINKED_USER)).toContain("Your Discord account is not linked");
    link();
    const text = await service.statusText(LINKED_USER);
    expect(text).toContain("🔥 Boosting for **10 days**");
    expect(text).toContain(`💎 Next weekly reward: <t:${(T0 + 2 * WEEK_MS) / 1000}:R> (+1 Soul Coin)`);
    expect(text).toContain(`🎁 Next loyalty bonus: <t:${(T0 + 4 * WEEK_MS) / 1000}:R>`);
    expect(text).toContain(`🏆 Next yearly milestone: <t:${(T0 + 52 * WEEK_MS) / 1000}:R>`);
    expect(text).toContain("Deposited this streak: **0 Soul Coins**");
    expect(text).toContain("🤝 The server has **0 boosts** (Server Boost Level 0).");
    expect(at()).toBe(T0 + 10 * DAY_MS);
  });

  describe("info post", () => {
    const info = (channels: ReturnType<typeof setup>["channels"], index = 0) => channels.channel("boosterRewards").sent[index]?.message.embeds?.[0];

    it("explains the rewards with the game's amounts and posts only once", async () => {
      const { service, channels, store, api } = setup();
      api.connected = false;
      await service.ensureInfoPost();
      await service.ensureInfoPost();
      const sink = channels.channel("boosterRewards");
      expect(sink.sent).toHaveLength(1);
      expect(sink.sent[0]!.message.content).toBeUndefined();
      const embed = info(channels)!;
      expect(embed.title).toBe("💜 PokeVerse Booster Rewards");
      const fields = Object.fromEntries((embed.fields ?? []).map((field) => [field.name, field.value]));
      expect(fields["💎 Every 7 days"]).toBe("+1 Soul Coin for each full week of continuous boosting.");
      expect(fields["🎁 Every 4 weeks (monthly)"]).toBe("+1 Soul Coin loyalty bonus, so **5 Soul Coins** every 4 weeks, plus the community bonus.");
      expect(fields["🏆 Every year"]).toBe("+15 Soul Coins milestone bonus at week 52, so **80 Soul Coins** in a full year of boosting, plus community bonuses.");
      expect(fields["🔗 How to get them"]).toContain("`!discord link`");
      expect(fields["📌 Good to know"]).toContain("resets the streak");
      expect(store.get().boosterInfo).toMatchObject({ channelId: sink.id, messageId: sink.sent[0]!.id });
    });

    it("edits the post when the game's amounts change, and posts again when it was deleted", async () => {
      const { service, channels, api } = setup();
      await service.ensureInfoPost();
      const sink = channels.channel("boosterRewards");
      api.rulesValue = { weekly: 2, loyaltyEvery: 4, loyalty: 0, yearlyEvery: 0, yearly: 0, communityEvery: 0, communityMax: 0, perks: [] };
      service.onConnected();
      await service.ensureInfoPost();
      expect(sink.sent).toHaveLength(1);
      expect(sink.edits).toHaveLength(1);
      const fields = sink.edits[0]!.message.embeds![0]!.fields!.map((field) => field.name);
      expect(fields).toEqual(["💎 Every 7 days", "🔗 How to get them", "📌 Good to know"]);
      await sink.delete(sink.sent[0]!.id);
      api.rulesValue = { ...api.rulesValue, weekly: 1 };
      service.onConnected();
      await service.ensureInfoPost();
      expect(sink.sent).toHaveLength(2);
    });
  });

  describe("server boosts", () => {
    const fieldsOf = (embed: { fields?: Array<{ name: string; value: string }> } | undefined) =>
      Object.fromEntries((embed?.fields ?? []).map((field) => [field.name, field.value]));

    it("adds the community bonus to loyalty weeks: +1 per 5 server boosts, up to +5", async () => {
      const { member, link, sync, advance, api, guild, lastText, rewards } = setup();
      link(T0 - DAY_MS);
      member.premiumSince = T0;
      guild.boostCount = 14;
      advance(4 * WEEK_MS);
      await sync();
      expect(api.deposited(LINKED_USER)).toBe(4 + 1 + 2);
      expect(lastText()).toContain("🤝 Community Bonus (14 boosts): +2 Soul Coins");
      expect(lastText()).toContain("**Total Deposited: 7 Soul Coins**");
      expect(rewards[0]).toMatchObject({ community: 2, serverBoosts: 14 });
      guild.boostCount = 40;
      advance(4 * WEEK_MS);
      await sync();
      expect(api.deposited(LINKED_USER)).toBe(7 + 4 + 1 + 5);
    });

    it("shows the community bonus and the level perks in the info post", async () => {
      const { service, channels, guild } = setup();
      guild.boostCount = 9;
      guild.boostLevel = 2;
      await service.ensureInfoPost();
      const fields = fieldsOf(channels.channel("boosterRewards").sent[0]!.message.embeds![0]);
      expect(Object.keys(fields)).toEqual([
        "💎 Every 7 days", "🎁 Every 4 weeks (monthly)", "🤝 Community bonus", "🏆 Every year",
        "🚀 Server boost perks (everyone in the game)", "🔗 How to get them", "📌 Good to know",
      ]);
      expect(fields["🤝 Community bonus"]).toBe(
        "Every 4th week, +1 Soul Coin for every 5 boosts on the server, up to +5 (at 25 boosts). Everyone's boosts count!\n" +
        "Right now: **9 boosts** give **+1 Soul Coin**. 1 more boost for +2.");
      expect(fields["🚀 Server boost perks (everyone in the game)"]).toBe([
        "✅ Level 1 (2 boosts): +5% experience",
        "✅ Level 2 (7 boosts): +5% catch rate",
        "🔒 Level 3 (14 boosts): +10% shiny spawn rate",
        "",
        "The server is **Level 2** with **9 boosts**. 5 more boosts unlock Level 3: +10% shiny spawn rate.",
      ].join("\n"));
    });

    it("keeps the info post up to date and announces level changes", async () => {
      const { service, channels, guild, api, store, queue } = setup();
      guild.boostCount = 9;
      guild.boostLevel = 2;
      await service.refreshServerBoosts();
      await queue.idle();
      const sink = channels.channel("boosterRewards");
      expect(sink.sent).toHaveLength(1);
      expect(api.levels).toEqual([{ level: 2, boosts: 9 }]);
      expect(store.get().boostLevel).toEqual({ level: 2, boosts: 9 });

      guild.boostCount = 10;
      service.onServerBoostsChanged();
      await new Promise((resolve) => setTimeout(resolve, 10));
      await service.refreshServerBoosts();
      await queue.idle();
      expect(sink.sent).toHaveLength(1);
      expect(sink.edits.at(-1)!.message.embeds![0]!.fields!.find((field) => field.name === "🤝 Community bonus")!.value)
        .toContain("**10 boosts** give **+2 Soul Coins**");

      guild.boostCount = 25;
      guild.boostLevel = 3;
      await service.refreshServerBoosts();
      await queue.idle();
      expect(sink.sent).toHaveLength(2);
      expect(sink.sent[1]!.message.embeds![0]).toMatchObject({
        title: "🚀 PokeVerse reached Server Boost Level 3!",
        description: "Thanks to **25 boosts**, everyone in the game now gets:\n• +5% experience\n• +5% catch rate\n• +10% shiny spawn rate",
      });
      expect(fieldsOf(sink.edits.at(-1)!.message.embeds![0])["🤝 Community bonus"]).toContain("That is the maximum!");

      guild.boostCount = 6;
      guild.boostLevel = 1;
      await service.refreshServerBoosts();
      await queue.idle();
      expect(sink.sent[2]!.message.embeds![0]).toMatchObject({
        title: "Server Boost Level dropped to 1",
        description: "The server has **6 boosts** now. Active in the game:\n• +5% experience\n\n1 more boost brings back Level 2: +5% catch rate.",
      });
      expect(api.levels.at(-1)).toEqual({ level: 1, boosts: 6 });
    });

    it("does not send the level to a game without boost perks", async () => {
      const { service, guild, api } = setup();
      api.features.delete("boostPerks");
      guild.boostLevel = 1;
      await service.refreshServerBoosts();
      expect(api.levels).toEqual([]);
    });
  });
});
