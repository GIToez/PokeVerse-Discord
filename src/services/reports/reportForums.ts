import type { APIEmbed } from "discord.js";
import type { BotConfig } from "../../config/load.js";
import type { ChannelDirectory, ForumPostSink, ForumSink, GuildPort, OutgoingMessage } from "../../bot/ports.js";
import type { ReportApi } from "../../integrations/pokeverse/gameApi.js";
import type { GameEventEnvelope, GameReport, ReportEvent } from "../../integrations/pokeverse/protocol.js";
import { RecentKeys } from "../../utils/dedupe.js";
import type { DeliveryQueue } from "../../utils/deliveryQueue.js";
import { discordTimestamp } from "../../utils/format.js";
import type { Logger } from "../../utils/logger.js";
import type { Metrics } from "../../utils/metrics.js";
import type { ReportPostRecord, StateStore } from "../../utils/stateStore.js";
import { checkPrivacy, type PrivacyPolicy } from "../activity/privacy.js";
import { COLORS, plain } from "../embeds.js";
import { categoryTag, REPORT_KINDS, statusByTag, statusOf, type ReportKind } from "./reportKinds.js";

export interface ReportForumsOptions {
  config: BotConfig["reports"];
  channels: ChannelDirectory;
  guild: () => GuildPort | undefined;
  /** Who may see the private #player-reports forum (as for #player-activity). */
  policy: (botUserId: string) => PrivacyPolicy;
  store: StateStore;
  api: ReportApi;
  queue: DeliveryQueue;
  logger: Logger;
  metrics: Metrics;
  now?: () => number;
}

export type ReportDecision =
  | { action: "post" }
  | { action: "skip"; reason: "disabled" | "unknown_kind" | "duplicate" };

/** The game sends a slice of at most this many base64 characters (Reports.SHOT_SLICE). */
export const SCREENSHOT_SLICE = 12000;
/** Discord's upload limit without boosts is 10 MB; the game's screenshots are far smaller. */
const SCREENSHOT_MAX_BYTES = 8 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WARN_INTERVAL_MS = 10 * 60 * 1000;
const KIND_ICONS: Record<string, string> = { bug: "🐞", player: "🚩" };

function statusColor(report: GameReport): number {
  switch (report.status) {
    case "open":
      return COLORS.info;
    case "fixed":
    case "action_taken":
      return COLORS.success;
    case "wont_fix":
    case "no_action":
    case "duplicate":
      return COLORS.neutral;
    default:
      return COLORS.warning;
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function where(position: GameReport["position"], area?: string | null): string | undefined {
  if (!position) {
    return area ? plain(area) : undefined;
  }
  const coordinates = `\`${position.x}, ${position.y}, ${position.z}\``;
  if (!area) {
    return coordinates;
  }
  const text = plain(area);
  return /^near\s/i.test(text) ? `${coordinates} ${text}` : `${coordinates} near ${text}`;
}

export function postName(report: Pick<GameReport, "id" | "title">): string {
  return clip(`[#${report.id}] ${report.title}`, 100);
}

function statusText(report: Pick<GameReport, "kind" | "status" | "statusName">): string {
  const status = statusOf(report.kind, report.status);
  return status ? `${status.emoji} ${status.tag}` : plain(report.statusName ?? report.status);
}

/** The post's first message: everything the game knows about the report. */
export function buildReportEmbed(report: GameReport): APIEmbed {
  const fields: NonNullable<APIEmbed["fields"]> = [];
  const reporter = report.reporter;
  const about = [`**${plain(reporter.name)}**`];
  if (reporter.level) {
    about.push(`level ${reporter.level}`);
  }
  if (reporter.vocation) {
    about.push(plain(reporter.vocation));
  }
  fields.push({
    name: "Reporter",
    value: about.join(", ") + (reporter.discordUserId ? `\n<@${reporter.discordUserId}>` : ""),
    inline: true,
  });
  fields.push({ name: "Status", value: statusText(report), inline: true });
  fields.push({ name: "Category", value: plain(report.categoryName ?? report.category), inline: true });

  const target = report.target;
  if (target) {
    const state = [target.level ? `level ${target.level}` : undefined, target.online ? "online" : target.online === false ? "offline" : undefined]
      .filter(Boolean)
      .join(", ");
    fields.push({ name: "Reported player", value: `**${plain(target.name)}**${state ? ` (${state})` : ""}`, inline: true });
    const then = where(target.position);
    if (then) {
      fields.push({ name: "They stood at", value: then, inline: true });
    }
  }
  const spot = where(report.position, report.area);
  if (spot) {
    fields.push({ name: target ? "The reporter stood at" : "Where", value: spot, inline: true });
  }
  if (report.pokemon) {
    fields.push({ name: "Pokemon out", value: clip(plain(report.pokemon), 1024), inline: true });
  }
  if (report.statement) {
    fields.push({ name: "Reported message", value: clip(`> ${plain(report.statement)}`, 1024), inline: false });
  }
  if (target?.chat && target.chat.length > 0) {
    const lines = target.chat.map((line) => `${discordTimestamp(line.at, "t")} ${plain(line.text)}`);
    fields.push({ name: "Their last channel messages", value: clip(lines.join("\n"), 1024), inline: false });
  }
  if (report.client) {
    fields.push({ name: "Client", value: clip(plain(report.client), 1024), inline: false });
  }
  const handling: string[] = [];
  if (report.assignedTo) {
    handling.push(`Taken by **${plain(report.assignedTo)}**`);
  }
  if (report.duplicateOf) {
    handling.push(`Same as report #${report.duplicateOf}`);
  }
  if (report.duplicates) {
    handling.push(report.duplicates === 1 ? "1 other report was merged into this one" : `${report.duplicates} other reports were merged into this one`);
  }
  if (handling.length > 0) {
    fields.push({ name: "Team", value: handling.join("\n"), inline: false });
  }
  return {
    author: { name: report.kind === "player" ? "Player report" : "Bug report" },
    title: clip(`${KIND_ICONS[report.kind] ?? "📝"} ${report.title}`, 256),
    description: clip(plain(report.description), 4096),
    color: statusColor(report),
    fields: fields.slice(0, 25),
    footer: { text: `Report #${report.id} · staff answer in the game's Reports window or with the status tag` },
    timestamp: new Date(report.createdAt * 1000).toISOString(),
  };
}

/** One line in the post for a change, or undefined when there is nothing to say. */
export function updateLine(event: ReportEvent, threadOf: (id: number) => string | undefined): string | undefined {
  const change = event.change ?? {};
  const report = event.report;
  const by = change.by ? `**${plain(change.by)}**` : "The team";
  const onDiscord = change.source === "discord" ? " on Discord" : "";
  const link = (id: number) => {
    const thread = threadOf(id);
    return thread ? `#${id} (<#${thread}>)` : `#${id}`;
  };
  if (change.duplicateOf) {
    return `♻️ ${by} marked this as the same as ${link(change.duplicateOf)}${onDiscord}. Its reporter hears about that one from now on.`;
  }
  if (change.duplicate) {
    return `♻️ ${link(change.duplicate)} is the same as this report; its reporter hears about this one too.`;
  }
  const note = change.note ? `\n> ${clip(plain(change.note), 1500).replace(/\n/g, "\n> ")}` : "";
  if (change.status && change.status !== change.previousStatus) {
    return `${statusOf(report.kind, change.status)?.emoji ?? "🔄"} ${by} set it to **${statusText({ ...report, status: change.status }).replace(/^\S+ /, "")}**${onDiscord}.${note}`;
  }
  if (change.note) {
    return `💬 ${by}${onDiscord}:${note}`;
  }
  if (change.status === undefined) {
    return report.assignedTo ? `🙋 **${plain(report.assignedTo)}** took this report.` : `${by} let this report go.`;
  }
  return undefined;
}

/**
 * Each in-game report is a post in #bug-reports (public) or #player-reports (private, Admin Logs):
 * the first message has the whole report, the tags show its status and category, and changes are
 * lines in the post. A status tag picked on Discord answers the report in the game.
 */
export class ReportForums {
  private readonly seen = new RecentKeys(5000);
  private readonly now: () => number;
  private lastPrivacyWarning = 0;

  constructor(private readonly options: ReportForumsOptions) {
    this.now = options.now ?? Date.now;
  }

  private kindOf(kind: string): ReportKind | undefined {
    const info = REPORT_KINDS[kind];
    const { bugs, players } = this.options.config;
    if (!info || (kind === "bug" && !bugs) || (kind === "player" && !players)) {
      return undefined;
    }
    return info;
  }

  decide(envelope: GameEventEnvelope<ReportEvent>): ReportDecision {
    const kind = envelope.event.report.kind;
    if (!REPORT_KINDS[kind]) {
      return { action: "skip", reason: "unknown_kind" };
    }
    if (!this.kindOf(kind)) {
      return { action: "skip", reason: "disabled" };
    }
    if (!this.seen.add(envelope.id)) {
      return { action: "skip", reason: "duplicate" };
    }
    return { action: "post" };
  }

  handle(envelope: GameEventEnvelope<ReportEvent>): ReportDecision {
    const decision = this.decide(envelope);
    if (decision.action === "skip") {
      this.options.metrics.increment(`reports.skipped.${decision.reason}`);
      return decision;
    }
    const event = envelope.event;
    this.options.queue.enqueue(`report ${event.action} ${event.report.id}`, () => this.deliver(event));
    return decision;
  }

  /** The report's forum, if it exists (and, for player reports, is private right now). */
  private forumFor(kind: ReportKind): ForumSink | undefined {
    const { channels, guild, policy, metrics, logger } = this.options;
    const forum = channels.forum?.(kind.purpose);
    if (!forum) {
      metrics.increment("reports.no_channel");
      return undefined;
    }
    if (kind.purpose !== "playerReports") {
      return forum;
    }
    const port = guild();
    const privacy = port ? checkPrivacy(port.channelAccess(forum.id), policy(port.botUserId)) : undefined;
    if (!privacy?.private) {
      metrics.increment("reports.blocked_not_private");
      if (this.now() - this.lastPrivacyWarning > WARN_INTERVAL_MS) {
        this.lastPrivacyWarning = this.now();
        logger.error("#player-reports is not private; player reports are not posted until it is fixed", {
          problems: privacy?.problems ?? ["the guild is not available"],
        });
      }
      return undefined;
    }
    return forum;
  }

  private tagIds(forum: ForumSink, report: Pick<GameReport, "kind" | "status" | "category">): string[] {
    const names = [statusOf(report.kind, report.status)?.tag, categoryTag(report.kind, report.category)]
      .filter((name): name is string => name !== undefined)
      .map((name) => name.toLowerCase());
    const tags = forum.tags();
    return names.map((name) => tags.find((tag) => tag.name.toLowerCase() === name)?.id).filter((id): id is string => id !== undefined);
  }

  private threadOf(id: number): string | undefined {
    return this.options.store.get().reportPosts[String(id)]?.threadId;
  }

  /** Bug reports ping their linked reporter (the report's own post only). */
  private mention(report: GameReport): string | undefined {
    return report.kind === "bug" && this.options.config.mentionReporter ? (report.reporter.discordUserId ?? undefined) : undefined;
  }

  private async deliver(event: ReportEvent): Promise<void> {
    const { store, metrics } = this.options;
    const report = event.report;
    const kind = this.kindOf(report.kind);
    const forum = kind && this.forumFor(kind);
    if (!forum) {
      return;
    }
    const key = String(report.id);
    const record = store.get().reportPosts[key];
    const post = record && record.channelId === forum.id ? await forum.post(record.threadId) : undefined;
    if (!post || !record) {
      await this.createPost(forum, report);
      metrics.increment(`reports.${event.action === "created" ? "posted" : "reposted"}`);
      return;
    }

    store.update((state) => {
      const saved = state.reportPosts[key];
      if (saved) {
        saved.status = report.status;
        saved.category = report.category;
        saved.closed = report.closed === true;
      }
    });
    await post.update({ tagIds: this.tagIds(forum, report), name: postName(report), archived: false });
    await post.edit(record.messageId, { embeds: [buildReportEmbed(report)] });
    if (event.action === "screenshot") {
      await this.sendScreenshot(post, report);
    } else {
      const line = updateLine(event, (id) => this.threadOf(id));
      if (line) {
        const mention = event.change?.status && event.change.status !== event.change.previousStatus ? this.mention(report) : undefined;
        await post.send(mention ? { content: `<@${mention}> ${line}`, mentionUserIds: [mention] } : { content: line });
      }
    }
    if (report.closed) {
      await post.archive();
    }
    metrics.increment(`reports.${event.action}`);
  }

  private async createPost(forum: ForumSink, report: GameReport): Promise<void> {
    const mention = this.mention(report);
    const message: OutgoingMessage = { embeds: [buildReportEmbed(report)] };
    if (mention) {
      message.content = `<@${mention}> thank you for the report! Updates show up in this post.`;
      message.mentionUserIds = [mention];
    }
    const created = await forum.createPost({ name: postName(report), message, tagIds: this.tagIds(forum, report) });
    const record: ReportPostRecord = {
      kind: report.kind,
      channelId: forum.id,
      threadId: created.threadId,
      messageId: created.messageId,
      status: report.status,
      category: report.category,
      closed: report.closed === true,
      createdAt: Math.floor(this.now() / 1000),
    };
    this.options.store.update((state) => {
      state.reportPosts[String(report.id)] = record;
    });
    this.options.logger.info("Posted an in-game report", { id: report.id, kind: report.kind, thread: created.threadId });
    if (!report.screenshot && !report.duplicateOf && !report.closed) {
      return;
    }
    const post = await forum.post(created.threadId);
    if (!post) {
      return;
    }
    if (report.screenshot) {
      await this.sendScreenshot(post, report);
    }
    if (report.duplicateOf) {
      await post.send({ content: updateLine({ kind: "report", action: "updated", report, change: { duplicateOf: report.duplicateOf } }, (id) => this.threadOf(id)) });
    }
    if (report.closed) {
      await post.archive();
    }
  }

  /** Reads the screenshot from the game in slices; undefined when there is none or it is not a PNG. */
  async fetchScreenshot(id: number): Promise<Buffer | undefined> {
    const { api, metrics } = this.options;
    let encoded = "";
    let total = Infinity;
    while (encoded.length < total) {
      const slice = await api.screenshot(id, encoded.length, SCREENSHOT_SLICE);
      if (!slice.found || !slice.done || slice.total === undefined || !slice.data) {
        return undefined;
      }
      total = slice.total;
      encoded += slice.data;
      if (encoded.length * 0.75 > SCREENSHOT_MAX_BYTES) {
        metrics.increment("reports.screenshot_too_big");
        return undefined;
      }
    }
    const png = Buffer.from(encoded, "base64");
    if (png.length < PNG_SIGNATURE.length || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      metrics.increment("reports.screenshot_invalid");
      return undefined;
    }
    return png;
  }

  private async sendScreenshot(post: ForumPostSink, report: GameReport): Promise<void> {
    const png = await this.fetchScreenshot(report.id);
    if (!png) {
      return;
    }
    const name = `report-${report.id}.png`;
    await post.send({
      embeds: [{ title: "📸 Screenshot from the game", color: COLORS.neutral, image: { url: `attachment://${name}` } }],
      files: [{ name, data: png }],
    });
    this.options.metrics.increment("reports.screenshot");
  }

  /** A post's tags changed on Discord: a new status tag answers the report in the game. */
  handleTagsChanged(change: { threadId: string; tagIds: string[]; by?: string }): void {
    const found = Object.entries(this.options.store.get().reportPosts).find(([, record]) => record.threadId === change.threadId);
    if (!found || !this.options.config.tagSync) {
      return;
    }
    const [key, record] = found;
    this.options.queue.enqueue(`report tags ${key}`, () => this.applyTags(Number(key), record, change));
  }

  private async applyTags(id: number, record: ReportPostRecord, change: { threadId: string; tagIds: string[]; by?: string }): Promise<void> {
    const { api, metrics, logger, store } = this.options;
    const kind = this.kindOf(record.kind);
    const forum = kind && this.options.channels.forum?.(kind.purpose);
    if (!forum || forum.id !== record.channelId) {
      return;
    }
    const current = store.get().reportPosts[String(id)] ?? record;
    const names = new Map(forum.tags().map((tag) => [tag.id, tag.name]));
    const statuses = change.tagIds.map((tagId) => statusByTag(record.kind, names.get(tagId) ?? "")).filter((status) => status !== undefined);
    if (statuses.some((status) => status.key === current.status) && statuses.length === 1) {
      return;
    }
    const chosen = statuses.find((status) => status.key !== current.status);
    const restore = async (reason: string) => {
      const post = await forum.post(record.threadId);
      if (post) {
        await post.update({
          tagIds: this.tagIds(forum, { kind: record.kind, status: current.status, category: current.category ?? "" }),
          archived: current.closed === true,
        });
        if (reason) {
          await post.send({ content: `⚠️ ${reason} The status tag was put back.` });
        }
      }
    };
    if (!chosen) {
      // the status tag was taken off: a report always shows its status
      await restore("");
      return;
    }
    if (!api.connected) {
      metrics.increment("reports.tag_offline");
      await restore("The game is offline, so the report was not changed.");
      return;
    }
    try {
      await api.setStatus(id, chosen.key, change.by ?? "Discord staff");
      store.update((state) => {
        const saved = state.reportPosts[String(id)];
        if (saved) {
          saved.status = chosen.key;
        }
      });
      metrics.increment("reports.tag_applied");
    } catch (error) {
      metrics.increment("reports.tag_failed");
      logger.warn("Could not change a report from its Discord tag", { id, status: chosen.key, error });
      await restore("The game did not take the change.");
    }
  }
}
