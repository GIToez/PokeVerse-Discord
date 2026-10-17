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
});

export type LegendaryEncounterRecord = z.infer<typeof legendaryEncounterSchema>;

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
  adminCategoryId: z.string().optional(),
  /** Linking roles created or adopted by setup: `verified`, `premium`, `staff:<group id>`. */
  roles: z.record(z.string()).default({}),
  /**
   * Members the bot gave a linking role or nickname, so they can be cleaned up after an
   * unlink without the privileged members intent. Value: the nickname the bot set, or "".
   */
  linkedMembers: z.record(z.string()).default({}),
  /** Wild legendary encounters with a Discord post, by the game's encounter id. */
  legendaryEncounters: z.record(legendaryEncounterSchema).default({}),
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
      return { version: 1, profile: this.profile, channels: {}, roles: {}, linkedMembers: {}, legendaryEncounters: {} };
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
