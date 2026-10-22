import type { APIEmbed } from "discord.js";
import type { ChannelDirectory, GuildPort, MemberInfo, OutgoingMessage } from "../../bot/ports.js";
import { BridgeRequestError, BridgeUnavailableError } from "../../integrations/pokeverse/bridgeClient.js";
import type { BoosterApi, LinkApi } from "../../integrations/pokeverse/gameApi.js";
import { FEATURES, type BoosterRules, type LinkSummary } from "../../integrations/pokeverse/protocol.js";
import type { DeliveryQueue } from "../../utils/deliveryQueue.js";
import { discordTimestamp } from "../../utils/format.js";
import type { Logger } from "../../utils/logger.js";
import type { Metrics } from "../../utils/metrics.js";
import type { BoosterRecord, StateStore } from "../../utils/stateStore.js";

export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;
const RULES_TTL_MS = 10 * 60_000;
/** The game's defaults (config.lua), shown in the info post until the game reports its own. */
export const DEFAULT_BOOSTER_RULES: BoosterRules = {
  weekly: 1,
  loyaltyEvery: 4,
  loyalty: 1,
  yearlyEvery: 52,
  yearly: 15,
  communityEvery: 5,
  communityMax: 5,
  perks: [
    { level: 1, text: "+5% experience" },
    { level: 2, text: "+5% catch rate" },
    { level: 3, text: "+10% shiny spawn rate" },
  ],
};
/** Boosts Discord needs for server boost level 1, 2 and 3 (only used for "N more boosts" hints). */
export const BOOST_LEVEL_BOOSTS = [0, 2, 7, 14] as const;
const BOOSTS_SETTLE_MS = 5000;
/** Discord's boost pink. */
const BOOST_COLOR = 0xf47fff;

export interface BoosterReward {
  discordUserId: string;
  /** Weeks of the streak paid now (usually one; more after the bot or the game was away). */
  weeks: number[];
  weekly: number;
  loyalty: number;
  yearly: number;
  /** Community bonus (server boosts) on loyalty weeks. */
  community: number;
  /** Server boost count sent with the last week paid. */
  serverBoosts: number;
  total: number;
  streakDays: number;
  /** Soul Coins deposited in this streak so far, including this reward. */
  streakTotal: number;
}

export interface BoosterRewardsOptions {
  config: { reminders: boolean; mention: boolean; checkMinutes: number };
  api: BoosterApi;
  links: LinkApi;
  guild: () => GuildPort | undefined;
  channels: ChannelDirectory;
  store: StateStore;
  queue: DeliveryQueue;
  logger: Logger;
  metrics: Metrics;
  /** Told about every deposit (staff activity log). */
  onReward?: (reward: BoosterReward) => void;
  now?: () => number;
  /** Wait after a server boost change before acting, so a burst of boosts is one update. */
  boostsSettleMs?: number;
}

/** "unknown": the game could not be asked, so the link state is not known right now. */
type LinkState = LinkSummary | undefined | "unknown";

function coins(amount: number): string {
  return `${amount} Soul Coin${amount === 1 ? "" : "s"}`;
}

function boostsText(count: number): string {
  return `${count} boost${count === 1 ? "" : "s"}`;
}

/** The community bonus a loyalty week pays at `boosts` server boosts. */
export function communityBonus(rules: BoosterRules, boosts: number): number {
  return rules.communityEvery > 0 ? Math.min(rules.communityMax, Math.floor(boosts / rules.communityEvery)) : 0;
}

function communityEnabled(rules: BoosterRules): boolean {
  return rules.communityEvery > 0 && rules.communityMax > 0 && rules.loyaltyEvery > 0;
}

/** "Right now: 14 boosts give +2. 1 more boost for +3." */
function communityNow(rules: BoosterRules, boosts: number): string {
  const bonus = communityBonus(rules, boosts);
  const more = (bonus + 1) * rules.communityEvery - boosts;
  const moreText = `${more} more boost${more === 1 ? "" : "s"}`;
  if (bonus === 0) {
    return `Right now: **${boostsText(boosts)}** on the server. ${moreText} for the first +1.`;
  }
  const now = `Right now: **${boostsText(boosts)}** ${boosts === 1 ? "gives" : "give"} **+${coins(bonus)}**.`;
  if (bonus >= rules.communityMax) {
    return `${now} That is the maximum!`;
  }
  return `${now} ${moreText} for +${bonus + 1}.`;
}

/** The game's perks, or the planned ones while the game lists none. */
function withPerks(rules: BoosterRules): BoosterRules {
  return rules.perks.length > 0 ? rules : { ...rules, perks: DEFAULT_BOOSTER_RULES.perks };
}

function perksAt(rules: BoosterRules, level: number): string[] {
  return rules.perks.filter((perk) => perk.level <= level).map((perk) => perk.text);
}

function perksOf(rules: BoosterRules, level: number): string {
  return rules.perks.filter((perk) => perk.level === level).map((perk) => perk.text).join(", ");
}

/** "5 more boosts unlock Level 3: +10% shiny spawn rate." (empty at level 3). */
function nextLevelText(rules: BoosterRules, boosts: { count: number; level: number }, verb: "unlock" | "bring back"): string {
  const next = boosts.level + 1;
  if (next > 3) {
    return "";
  }
  const more = Math.max(1, BOOST_LEVEL_BOOSTS[next]! - boosts.count);
  const perks = perksOf(rules, next);
  const conjugated = more === 1 ? (verb === "unlock" ? "unlocks" : "brings back") : verb;
  return `${more} more boost${more === 1 ? "" : "s"} ${conjugated} Level ${next}${perks ? `: ${perks}` : ""}.`;
}

/**
 * Soul Coins for server boosters. Discord reports when a member's current unbroken boost
 * started (`premiumSince`); it is cleared when the last boost is removed or transferred and
 * set anew on the next boost. So "N complete weeks of continuous boosting" is simply
 * N * 7 days since `premiumSince`, and a changed `premiumSince` is a reset, even when the
 * bot was offline while it happened. Week N is due at `premiumSince + N * 7 days`.
 *
 * The game owns the amounts (weekly, loyalty and yearly bonuses) and the ledger: the bot asks
 * it to deposit week N of the boost that started at `premiumSince`, and the game refuses a
 * week twice, a week that is not due, and weeks completed before the account was linked.
 * Only weeks completed while linked are paid; members who boost without a link get a reminder.
 *
 * Boosters are found three ways: linked members at every link sync (LinkService), Discord's
 * "just boosted" system messages, and /booster. Work runs one item at a time.
 */
export class BoosterRewards {
  private chain: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private cachedRules: { rules: BoosterRules; at: number } | undefined;
  private infoChain: Promise<void> = Promise.resolve();
  private boostsTimer: NodeJS.Timeout | undefined;
  private boostsChain: Promise<void> = Promise.resolve();

  constructor(private readonly options: BoosterRewardsOptions) {}

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  get available(): boolean {
    return this.options.api.connected && this.options.api.hasFeature(FEATURES.boosterRewards);
  }

  /** The game applies the server-wide boost level perks. */
  get perksAvailable(): boolean {
    return this.options.api.connected && this.options.api.hasFeature(FEATURES.boostPerks);
  }

  start(): void {
    void this.refreshServerBoosts();
    if (this.options.config.checkMinutes > 0) {
      this.timer = setInterval(() => void this.checkUnlinked(), this.options.config.checkMinutes * 60_000);
      this.timer.unref();
    }
  }

  stop(): void {
    clearInterval(this.timer);
    clearTimeout(this.boostsTimer);
  }

  /** Discord changed the server's boost count or level. */
  onServerBoostsChanged(): void {
    clearTimeout(this.boostsTimer);
    this.boostsTimer = setTimeout(() => void this.refreshServerBoosts(), this.options.boostsSettleMs ?? BOOSTS_SETTLE_MS);
    this.boostsTimer.unref();
  }

  /**
   * Announces a level change, tells the game the level for its perks and updates the info
   * post (the live tracker). The first run only records the level.
   */
  refreshServerBoosts(): Promise<void> {
    this.boostsChain = this.boostsChain.then(async () => {
      const guild = this.options.guild();
      if (!guild) {
        return;
      }
      const boosts = guild.boosts();
      const saved = this.options.store.get().boostLevel;
      if (saved?.level !== boosts.level || saved.boosts !== boosts.count) {
        this.options.store.update((state) => {
          state.boostLevel = { level: boosts.level, boosts: boosts.count };
        });
      }
      if (saved && saved.level !== boosts.level) {
        this.options.logger.info("Server boost level changed", { from: saved.level, to: boosts.level, boosts: boosts.count });
        this.options.metrics.increment("boosters.level_changes");
        this.postLevelChange(saved.level, boosts, withPerks((await this.rules()) ?? DEFAULT_BOOSTER_RULES));
      }
      await this.sendLevel(boosts);
      await this.ensureInfoPost();
    }).catch((error: unknown) => {
      this.options.logger.warn("Server boost update failed", { error });
    });
    return this.boostsChain;
  }

  /** Resolves when the queued work is done (used by tests). */
  async idle(): Promise<void> {
    await this.chain;
  }

  /** A member was synced with their link (LinkService); `member` undefined: not in the server. */
  observe(discordUserId: string, member: MemberInfo | undefined, link: LinkSummary | undefined): void {
    void this.run(() => this.process(discordUserId, member, link));
  }

  /** Discord posted a "just boosted the server" message for this user. */
  onBoostMessage(discordUserId: string): void {
    this.options.metrics.increment("boosters.boost_messages");
    void this.run(() => this.check(discordUserId));
  }

  /** Re-checks boosters who were not linked last time (the link resync covers the linked ones). */
  async checkUnlinked(): Promise<number> {
    const ids = Object.entries(this.options.store.get().boosters)
      .filter(([, record]) => !record.linked)
      .map(([id]) => id);
    for (const id of ids) {
      await this.run(() => this.check(id));
    }
    return ids.length;
  }

  /** The private /booster reply: streak, next rewards and link state. */
  async statusText(discordUserId: string): Promise<string> {
    const guild = this.options.guild();
    if (!guild) {
      return "The Discord server is not available yet. Please try again in a moment.";
    }
    const member = await guild.fetchMember(discordUserId);
    const link = await this.linkState(discordUserId);
    await this.run(() => this.process(discordUserId, member, link));
    const rules = await this.rules();
    const since = member?.premiumSince ?? null;
    if (since === null) {
      return [
        "You are not boosting the server right now.",
        rules ? `Boosters with a linked game account get ${this.rulesText(rules)}.` : "Boosters with a linked game account get Soul Coins every 7 days of continuous boosting.",
        "Removing or transferring a boost resets the streak.",
      ].join("\n");
    }
    const elapsed = this.now - since;
    const lines = [`🔥 Boosting for **${Math.floor(elapsed / DAY_MS)} days** (since ${discordTimestamp(since / 1000, "f")}).`];
    if (link === undefined) {
      lines.push(
        "Your Discord account is not linked, so no Soul Coins are deposited.",
        "In the game, type `!discord link` to get a code, then use `/link` here. Weeks completed before you link are not paid.",
      );
    } else {
      const nextWeek = Math.floor(elapsed / WEEK_MS) + 1;
      const due = (week: number) => discordTimestamp((since + week * WEEK_MS) / 1000, "R");
      lines.push(`💎 Next weekly reward: ${due(nextWeek)}${rules ? ` (+${coins(rules.weekly)})` : ""}`);
      if (rules && rules.loyaltyEvery > 0 && rules.loyalty > 0) {
        const week = Math.ceil(nextWeek / rules.loyaltyEvery) * rules.loyaltyEvery;
        const community = communityEnabled(rules) ? communityBonus(rules, guild.boosts().count) : 0;
        lines.push(`🎁 Next loyalty bonus: ${due(week)} (+${coins(rules.loyalty)}${community > 0 ? `, +${community} community bonus` : ""})`);
      }
      if (rules && rules.yearlyEvery > 0 && rules.yearly > 0) {
        const week = Math.ceil(nextWeek / rules.yearlyEvery) * rules.yearlyEvery;
        lines.push(`🏆 Next yearly milestone: ${due(week)} (+${coins(rules.yearly)})`);
      }
      lines.push(`Deposited this streak: **${coins(this.options.store.get().boosters[discordUserId]?.total ?? 0)}**`);
      if (!this.available) {
        lines.push(this.options.api.connected
          ? "Booster rewards are not available on the game server yet; your weeks are paid once they are."
          : "The game server is offline; your rewards are deposited when it is back.");
      }
    }
    const boosts = guild.boosts();
    lines.push(`🤝 The server has **${boostsText(boosts.count)}** (Server Boost Level ${boosts.level}).`);
    lines.push("Removing or transferring your boost resets the streak.");
    return lines.join("\n");
  }

  /**
   * Posts the "how it works" embed in #booster-rewards, or edits it when the amounts changed.
   * Posted again if someone deleted it or the channel was reassigned.
   */
  ensureInfoPost(): Promise<void> {
    this.infoChain = this.infoChain.then(() => this.writeInfoPost());
    return this.infoChain;
  }

  private async writeInfoPost(): Promise<void> {
    const sink = this.options.channels.get("boosterRewards");
    if (!sink) {
      return;
    }
    const rules = (await this.rules()) ?? DEFAULT_BOOSTER_RULES;
    const embed = boosterInfoEmbed(withPerks(rules), this.options.guild()?.boosts() ?? { count: 0, level: 0 }, this.perksAvailable);
    const text = JSON.stringify(embed);
    const saved = this.options.store.get().boosterInfo;
    try {
      if (saved?.channelId === sink.id) {
        if (saved.text === text) {
          return;
        }
        if (await sink.edit(saved.messageId, { embeds: [embed] })) {
          this.options.store.update((state) => {
            state.boosterInfo = { ...saved, text };
          });
          return;
        }
      }
      const messageId = await sink.send({ embeds: [embed] });
      this.options.store.update((state) => {
        state.boosterInfo = { channelId: sink.id, messageId, text };
      });
      this.options.logger.info("Booster info post created", { channelId: sink.id });
    } catch (error) {
      this.options.logger.warn("Could not post the booster info", { error });
    }
  }

  /** The game reconnected: its amounts may have changed, and it needs the boost level. */
  onConnected(): void {
    this.cachedRules = undefined;
    void this.refreshServerBoosts();
  }

  private async sendLevel(boosts: { count: number; level: number }): Promise<void> {
    if (!this.perksAvailable) {
      return;
    }
    try {
      const result = await this.options.api.level(boosts.level, boosts.count);
      this.options.metrics.increment("boosters.level_sent");
      this.options.logger.debug("Server boost level sent to the game", { level: result.level, perks: result.perks });
    } catch (error) {
      this.options.logger.warn("Could not send the server boost level to the game", { error });
    }
  }

  private postLevelChange(from: number, boosts: { count: number; level: number }, rules: BoosterRules): void {
    const perks = perksAt(rules, boosts.level);
    const list = perks.length > 0 ? perks.map((perk) => `• ${perk}`).join("\n") : "No boost perks are active.";
    const up = boosts.level > from;
    const next = nextLevelText(rules, boosts, up ? "unlock" : "bring back");
    const description = up
      ? `Thanks to **${boostsText(boosts.count)}**, everyone in the game now gets:\n${list}`
      : `The server has **${boostsText(boosts.count)}** now. Active in the game:\n${list}`;
    const embed: APIEmbed = {
      title: up ? `🚀 PokeVerse reached Server Boost Level ${boosts.level}!` : `Server Boost Level dropped to ${boosts.level}`,
      description: next ? `${description}\n\n${next}` : description,
      color: BOOST_COLOR,
    };
    this.options.queue.enqueue("boost level", async () => {
      const sink = this.options.channels.get("boosterRewards");
      if (sink) {
        await sink.send({ embeds: [embed] });
        this.options.metrics.increment("boosters.posted");
      }
    });
  }

  private run<T>(task: () => Promise<T>): Promise<T | undefined> {
    const next = this.chain.then(task).catch((error: unknown) => {
      this.options.logger.warn("Booster check failed", { error });
      return undefined;
    });
    this.chain = next;
    return next;
  }

  private async check(discordUserId: string): Promise<void> {
    const guild = this.options.guild();
    if (!guild) {
      return;
    }
    const member = await guild.fetchMember(discordUserId);
    await this.process(discordUserId, member, await this.linkState(discordUserId));
  }

  private async linkState(discordUserId: string): Promise<LinkState> {
    const { links } = this.options;
    if (!links.connected || !links.hasFeature(FEATURES.accountLinking)) {
      return "unknown";
    }
    try {
      const account = await links.account(discordUserId);
      return account.linked ? account : undefined;
    } catch (error) {
      if (error instanceof BridgeRequestError && error.code === "not_linked") {
        return undefined;
      }
      return "unknown";
    }
  }

  private async rules(): Promise<BoosterRules | undefined> {
    if (this.cachedRules && this.now - this.cachedRules.at < RULES_TTL_MS) {
      return this.cachedRules.rules;
    }
    if (!this.available) {
      return this.cachedRules?.rules;
    }
    try {
      this.cachedRules = { rules: await this.options.api.rules(), at: this.now };
    } catch (error) {
      this.options.logger.debug("Could not read the booster rules", { error });
    }
    return this.cachedRules?.rules;
  }

  private rulesText(rules: BoosterRules): string {
    const parts = [`${coins(rules.weekly)} every 7 days of continuous boosting`];
    if (rules.loyaltyEvery > 0 && rules.loyalty > 0) {
      parts.push(`+${coins(rules.loyalty)} every ${rules.loyaltyEvery} weeks`);
    }
    if (communityEnabled(rules)) {
      parts.push(`+1 more on those weeks for every ${rules.communityEvery} server boosts (up to +${rules.communityMax})`);
    }
    if (rules.yearlyEvery > 0 && rules.yearly > 0) {
      parts.push(`+${coins(rules.yearly)} every ${rules.yearlyEvery === 52 ? "year" : `${rules.yearlyEvery} weeks`}`);
    }
    return parts.join(", ");
  }

  private async process(discordUserId: string, member: MemberInfo | undefined, link: LinkState): Promise<void> {
    const since = member?.premiumSince ?? null;
    const saved = this.options.store.get().boosters[discordUserId];
    if (since === null) {
      if (saved) {
        this.save(discordUserId, undefined);
        this.options.metrics.increment("boosters.streaks_ended");
        this.options.logger.info("Boost streak ended", { user: discordUserId, paidWeeks: saved.paidWeek, total: saved.total });
      }
      return;
    }
    let record: BoosterRecord;
    if (saved && saved.since === since) {
      record = { ...saved };
    } else {
      record = { since, paidWeek: 0, total: 0, linked: false };
      this.options.metrics.increment("boosters.streaks_started");
      this.options.logger.info(saved ? "Boost streak reset (boost removed or transferred, then boosted again)" : "Booster seen", {
        user: discordUserId,
        since,
      });
    }
    if (link === "unknown") {
      this.save(discordUserId, record);
      return;
    }
    record.linked = link !== undefined;
    const dueWeeks = Math.floor((this.now - since) / WEEK_MS);
    if (link === undefined) {
      this.save(discordUserId, this.remind(discordUserId, record, dueWeeks));
      return;
    }
    if (!this.available || record.paidWeek >= dueWeeks) {
      this.save(discordUserId, record);
      return;
    }
    await this.pay(discordUserId, record, link, dueWeeks);
  }

  private async pay(discordUserId: string, record: BoosterRecord, link: LinkSummary, dueWeeks: number): Promise<void> {
    const reward: BoosterReward = {
      discordUserId, weeks: [], weekly: 0, loyalty: 0, yearly: 0, community: 0, serverBoosts: 0, total: 0, streakDays: 0, streakTotal: 0,
    };
    const serverBoosts = this.options.guild()?.boosts().count ?? 0;
    for (let week = record.paidWeek + 1; week <= dueWeeks; week++) {
      if (record.since + week * WEEK_MS < link.linkedAt * 1000) {
        record.paidWeek = week;
        continue;
      }
      try {
        const result = await this.options.api.week(discordUserId, Math.floor(record.since / 1000), week, serverBoosts);
        record.paidWeek = week;
        record.total += result.total;
        reward.weeks.push(week);
        reward.weekly += result.weekly;
        reward.loyalty += result.loyalty;
        reward.yearly += result.yearly;
        reward.community += result.community;
        reward.serverBoosts = serverBoosts;
        reward.total += result.total;
        this.options.metrics.increment(result.deposited ? "boosters.deposits" : "boosters.deposits_already_paid");
      } catch (error) {
        if (error instanceof BridgeRequestError && error.code === "before_link") {
          record.paidWeek = week;
          continue;
        }
        if (error instanceof BridgeRequestError && error.code === "stale_streak") {
          // The game has payments for a later boost: this premiumSince is out of date.
          this.options.logger.warn("The game refused an outdated boost streak", { user: discordUserId, since: record.since });
          record.paidWeek = dueWeeks;
          break;
        }
        if (!(error instanceof BridgeUnavailableError)) {
          this.options.metrics.increment("boosters.deposit_errors");
          this.options.logger.warn("Booster deposit failed; retried at the next check", {
            user: discordUserId,
            week,
            code: error instanceof BridgeRequestError ? error.code : undefined,
            error: error instanceof BridgeRequestError ? undefined : error,
          });
        }
        break;
      } finally {
        this.save(discordUserId, record);
      }
    }
    this.save(discordUserId, record);
    if (reward.weeks.length === 0) {
      return;
    }
    reward.streakDays = Math.floor((this.now - record.since) / DAY_MS);
    reward.streakTotal = record.total;
    this.options.logger.info("Booster reward deposited", { user: discordUserId, weeks: reward.weeks, total: reward.total });
    this.post(discordUserId, "reward", { embeds: [this.rewardEmbed(reward)] });
    try {
      this.options.onReward?.(reward);
    } catch (error) {
      this.options.logger.warn("Booster reward listener failed", { error });
    }
  }

  private remind(discordUserId: string, record: BoosterRecord, dueWeeks: number): BoosterRecord {
    if (!this.options.config.reminders) {
      return record;
    }
    const link = "In the game, type `!discord link` to get a code, then use `/link` here.";
    if (record.remindedAt === undefined) {
      this.post(discordUserId, "reminder", {
        embeds: [{
          title: "💜 Thank you for boosting PokeVerse!",
          description: `<@${discordUserId}>, link your game account to receive Soul Coins for every 7 days you keep boosting. ${link}`,
          color: BOOST_COLOR,
        }],
      });
      return { ...record, remindedAt: this.now };
    }
    // One more reminder once a week has passed without a payout, then no more.
    if (!record.missedReminder && dueWeeks >= 1 && record.since + dueWeeks * WEEK_MS > record.remindedAt) {
      this.post(discordUserId, "missed week", {
        embeds: [{
          title: "💎 A boost week went unpaid",
          description: `<@${discordUserId}>, you completed another week of boosting, but your Discord account is not linked ` +
            `to a game account, so no Soul Coins were deposited. ${link} Your rewards start with your next week.`,
          color: BOOST_COLOR,
        }],
      });
      return { ...record, missedReminder: true };
    }
    return record;
  }

  private rewardEmbed(reward: BoosterReward): APIEmbed {
    const lines = [`Thank you for supporting our community, <@${reward.discordUserId}>!`, ""];
    const weeks = reward.weeks.length;
    lines.push(`💎 Weekly Reward: +${coins(reward.weekly)}${weeks > 1 ? ` (${weeks} weeks)` : ""}`);
    lines.push(`🔥 Continuous Boosting: ${reward.streakDays} days`);
    if (reward.loyalty > 0) {
      lines.push(`🎁 Loyalty Bonus: +${coins(reward.loyalty)}`);
    }
    if (reward.community > 0) {
      lines.push(`🤝 Community Bonus (${boostsText(reward.serverBoosts)}): +${coins(reward.community)}`);
    }
    if (reward.yearly > 0) {
      const years = Math.max(1, Math.round((reward.weeks[reward.weeks.length - 1]! * 7) / 365));
      lines.push(`🏆 ${years} Year Milestone: +${coins(reward.yearly)}`);
    }
    lines.push("", `**Total Deposited: ${coins(reward.total)}**`);
    return {
      title: "🎉 PokeVerse Booster Reward",
      description: lines.join("\n"),
      color: BOOST_COLOR,
      footer: { text: "Withdraw your Soul Coins in the store in the game. Check your streak with /booster." },
    };
  }

  private post(discordUserId: string, label: string, message: OutgoingMessage): void {
    const full: OutgoingMessage = this.options.config.mention
      ? { ...message, content: `<@${discordUserId}>`, mentionUserIds: [discordUserId] }
      : message;
    this.options.queue.enqueue(`booster ${label}`, async () => {
      const sink = this.options.channels.get("boosterRewards");
      if (!sink) {
        this.options.metrics.increment("boosters.skipped_no_channel");
        return;
      }
      await sink.send(full);
      this.options.metrics.increment("boosters.posted");
    });
  }

  private save(discordUserId: string, record: BoosterRecord | undefined): void {
    const current = this.options.store.get().boosters[discordUserId];
    if (JSON.stringify(current) === JSON.stringify(record)) {
      return;
    }
    this.options.store.update((state) => {
      if (record) {
        state.boosters[discordUserId] = { ...record };
      } else {
        delete state.boosters[discordUserId];
      }
    });
  }
}

/**
 * The first post in #booster-rewards and its live tracker: what boosters earn, the community
 * bonus and the server-wide perks at the server's current boosts.
 */
export function boosterInfoEmbed(rules: BoosterRules, boosts: { count: number; level: number }, perksActive = true): APIEmbed {
  const community = communityEnabled(rules);
  const fields: NonNullable<APIEmbed["fields"]> = [
    { name: "💎 Every 7 days", value: `+${coins(rules.weekly)} for each full week of continuous boosting.` },
  ];
  if (rules.loyaltyEvery > 0 && rules.loyalty > 0) {
    const perPeriod = rules.weekly * rules.loyaltyEvery + rules.loyalty;
    fields.push({
      name: rules.loyaltyEvery === 4 ? "🎁 Every 4 weeks (monthly)" : `🎁 Every ${rules.loyaltyEvery} weeks`,
      value: `+${coins(rules.loyalty)} loyalty bonus, so **${coins(perPeriod)}** every ${rules.loyaltyEvery} weeks` +
        `${community ? ", plus the community bonus" : ""}.`,
    });
  }
  if (community) {
    const full = rules.communityMax * rules.communityEvery;
    fields.push({
      name: "🤝 Bonus coins for total server boosts",
      value: `Every ${rules.loyaltyEvery === 4 ? "4th week" : `${rules.loyaltyEvery}th week`}, +1 Soul Coin for every ` +
        `${rules.communityEvery} boosts on the server, up to +${rules.communityMax} (at ${full} boosts). Everyone's boosts count!\n` +
        communityNow(rules, boosts.count),
    });
  }
  if (rules.yearlyEvery > 0 && rules.yearly > 0) {
    const loyalties = rules.loyaltyEvery > 0 ? Math.floor(rules.yearlyEvery / rules.loyaltyEvery) * rules.loyalty : 0;
    const perYear = rules.weekly * rules.yearlyEvery + loyalties + rules.yearly;
    fields.push({
      name: rules.yearlyEvery === 52 ? "🏆 Every year" : `🏆 Every ${rules.yearlyEvery} weeks`,
      value: `+${coins(rules.yearly)} milestone bonus at week ${rules.yearlyEvery}, so **${coins(perYear)}** ` +
        `${rules.yearlyEvery === 52 ? "in a full year" : `every ${rules.yearlyEvery} weeks`} of boosting` +
        `${community ? ", plus community bonuses" : ""}.`,
    });
  }
  if (rules.perks.length > 0) {
    const levels = [1, 2, 3].filter((level) => perksOf(rules, level));
    const next = nextLevelText(rules, boosts, "unlock");
    fields.push({
      name: "🚀 In-game perks for the whole server",
      value: [
        "Every server boost level gives everyone playing PokeVerse a bonus, boosters or not:",
        ...levels.map((level) =>
          `${boosts.level >= level ? "✅" : "🔒"} Level ${level} (${boostsText(BOOST_LEVEL_BOOSTS[level]!)}): ${perksOf(rules, level)}`),
        "",
        `The server is **Level ${boosts.level}** with **${boostsText(boosts.count)}**.${next ? ` ${next}` : " Every perk is unlocked!"}`,
        ...(perksActive ? [] : ["⏳ The perks are switched on in the game soon."]),
      ].join("\n"),
    });
  }

  fields.push(
    {
      name: "🔗 How to get them",
      value: [
        "1. In the game, type `!discord link` to get a code.",
        "2. Use `/link` here with that code.",
        "3. Boost the server. Your Soul Coins are deposited automatically and announced here.",
        "Withdraw them in the store in the game.",
      ].join("\n"),
    },
    {
      name: "📌 Good to know",
      value: [
        "• Only weeks completed while your account is linked are paid.",
        "• Removing or transferring your boost resets the streak and the bonuses.",
        "• One reward per member, however many boosts you have.",
        "• `/booster` shows your streak and your next reward (only you can see it).",
      ].join("\n"),
    },
  );
  return {
    title: "💜 PokeVerse Booster Rewards",
    description: "Boost the PokeVerse Discord and earn **Soul Coins** on your game account. Thank you for supporting our community!",
    color: BOOST_COLOR,
    fields,
    footer: { text: "This post updates itself when the server's boosts change." },
  };
}
