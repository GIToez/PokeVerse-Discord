import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

export const CHANNEL_PURPOSES = [
  "gameChat",
  "catches",
  "shinySpawns",
  "legendarySpawns",
  "announcements",
  "serverStatus",
  "botCommands",
  "playerActivity",
  "bugReports",
  "playerReports",
  "boosterRewards",
  "staffTutors",
  "staffGamemasters",
] as const;

export type ChannelPurpose = (typeof CHANNEL_PURPOSES)[number];

export const CATCH_MODES = ["all", "rare_only", "shiny_legendary_only", "off"] as const;
export type CatchMode = (typeof CATCH_MODES)[number];

const legendaryEncounterSchema = z.object({
  channelId: z.string(),
  messageId: z.string(),
  threadId: z.string().optional(),
  species: z.string(),
  dexNumber: z.number().optional(),
  tier: z.number().optional(),
  area: z.string().optional(),
  location: z.string().optional(),
  endsAt: z.number().optional(),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  /** A member of a set: the key of its post in `legendarySets`. */
  set: z.string().optional(),
  level: z.number().optional(),
  asleep: z.boolean().optional(),
  /** Mew, found hiding as another Pokemon. */
  revealed: z.boolean().optional(),
});

export type LegendaryEncounterRecord = z.infer<typeof legendaryEncounterSchema>;

const legendarySetSchema = z.object({
  channelId: z.string(),
  messageId: z.string(),
  threadId: z.string().optional(),
  name: z.string(),
  level: z.number().optional(),
  asleep: z.boolean().optional(),
  startedAt: z.number(),
  members: z.array(z.object({
    encounterId: z.number(),
    species: z.string(),
    dexNumber: z.number().optional(),
    area: z.string().optional(),
    /** How it ended, or "awake" for a woken Regi. */
    outcome: z.string().optional(),
    detail: z.string().optional(),
    ended: z.boolean().optional(),
  })),
});

export type LegendarySetRecord = z.infer<typeof legendarySetSchema>;

/** A Discord scheduled event the bot made for a game calendar occurrence. */
const calendarEventSchema = z.object({
  eventId: z.string(),
  name: z.string(),
  description: z.string(),
  /** Unix seconds, as the game has them (the Discord event may start a minute later when created late). */
  startsAt: z.number(),
  endsAt: z.number(),
  status: z.enum(["scheduled", "active"]),
  remindedAt: z.number().optional(),
});

export type CalendarEventRecord = z.infer<typeof calendarEventSchema>;

const reportPostSchema = z.object({
  kind: z.string(),
  channelId: z.string(),
  threadId: z.string(),
  messageId: z.string(),
  /** The status the post's tags show; a different status tag picked on Discord is a staff change. */
  status: z.string(),
  category: z.string().optional(),
  closed: z.boolean().optional(),
  createdAt: z.number(),
});

export type ReportPostRecord = z.infer<typeof reportPostSchema>;

const boosterSchema = z.object({
  /** premiumSince of the boost streak (ms); a different value is a new streak. */
  since: z.number(),
  /** Last week of this streak that was paid, skipped (before linking) or written off. */
  paidWeek: z.number().int().default(0),
  /** Soul Coins deposited in this streak. */
  total: z.number().int().default(0),
  linked: z.boolean().default(false),
  /** When the "link your account" reminder was posted (ms). */
  remindedAt: z.number().optional(),
  missedReminder: z.boolean().optional(),
});

export type BoosterRecord = z.infer<typeof boosterSchema>;

const stateSchema = z.object({
  version: z.literal(1),
  profile: z.string(),
  guildId: z.string().optional(),
  categoryId: z.string().optional(),
  channels: z.record(z.string()).default({}),
  statusMessageId: z.string().optional(),
  catchMode: z.enum(CATCH_MODES).optional(),
  lastBootId: z.string().optional(),
  lastRestartAt: z.number().optional(),
  /** A restart or save the game warned about (unix seconds), shown in #server-status until it happened. */
  pendingRestart: z.object({ at: z.number(), kind: z.enum(["restart", "save"]), bootId: z.string().optional() }).optional(),
  adminCategoryId: z.string().optional(),
  staffCategoryId: z.string().optional(),
  /** Linking roles created or adopted by setup: `verified`, `premium`, `staff:<group id>`. */
  roles: z.record(z.string()).default({}),
  /**
   * Members the bot gave a linking role or nickname, so they can be cleaned up after an
   * unlink without the privileged members intent. Value: the nickname the bot set, or "".
   */
  linkedMembers: z.record(z.string()).default({}),
  /** Wild legendary encounters with a Discord post, by the game's encounter id. */
  legendaryEncounters: z.record(legendaryEncounterSchema).default({}),
  /** One post for a set of legendaries that appeared together, by "<set id>:<first encounter id>". */
  legendarySets: z.record(legendarySetSchema).default({}),
  /** Discord scheduled events for the game's calendar, by the occurrence's key. */
  calendarEvents: z.record(calendarEventSchema).default({}),
  /** Forum posts of in-game reports, by the game's report id. */
  reportPosts: z.record(reportPostSchema).default({}),
  /** Members seen boosting the server, by Discord user id (booster rewards). */
  boosters: z.record(boosterSchema).default({}),
  /** The "how booster rewards work" post in #booster-rewards; `text` is what it shows now. */
  /** The server boost level and count last seen, to announce level changes. */
  boostLevel: z.object({ level: z.number().int(), boosts: z.number().int() }).optional(),
  boosterInfo: z.object({ channelId: z.string(), messageId: z.string(), text: z.string() }).optional(),
});

export type BotState = z.infer<typeof stateSchema>;

/**
 * Small JSON state file (channel IDs, status message, admin overrides).
 * Writes are atomic (temp file + rename). One file per profile.
 */
export class StateStore {
  private state: BotState;

  constructor(
    private readonly file: string,
    private readonly profile: string,
  ) {
    this.state = this.load();
  }

  private load(): BotState {
    if (!existsSync(this.file)) {
      return { version: 1, profile: this.profile, channels: {}, roles: {}, linkedMembers: {}, legendaryEncounters: {}, legendarySets: {}, calendarEvents: {}, reportPosts: {}, boosters: {} };
    }
    const parsed = stateSchema.parse(JSON.parse(readFileSync(this.file, "utf8")));
    if (parsed.profile !== this.profile) {
      throw new Error(
        `State file ${this.file} belongs to profile "${parsed.profile}", not "${this.profile}". ` +
          "Each profile must use its own state file.",
      );
    }
    return parsed;
  }

  get(): Readonly<BotState> {
    return this.state;
  }

  getChannelId(purpose: ChannelPurpose): string | undefined {
    return this.state.channels[purpose];
  }

  update(change: (state: BotState) => void): void {
    const next: BotState = structuredClone(this.state);
    change(next);
    this.state = stateSchema.parse(next);
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify(this.state, null, 2) + "\n");
    renameSync(temp, this.file);
  }
}
