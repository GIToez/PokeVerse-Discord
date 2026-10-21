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
    guild, store, links, api, channels, service, member, rewards, link, sync, posts, lastText,
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
    expect(rewards).toEqual([{ discordUserId: LINKED_USER, weeks: [1], weekly: 1, loyalty: 0, yearly: 0, total: 1, streakDays: 7, streakTotal: 1 }]);
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
    expect(await service.statusText(LINKED_USER)).toContain("1 Soul Coin every 7 days of continuous boosting, +1 Soul Coin every 4 weeks, +15 Soul Coins every year");
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
    expect(at()).toBe(T0 + 10 * DAY_MS);
  });
});
