import type { GuildChannelInfo, GuildPort, PermissionName, PermissionOverwriteSpec } from "../bot/ports.js";
import type { Logger } from "../utils/logger.js";
import { CHANNEL_PURPOSES, type ChannelPurpose, type StateStore } from "../utils/stateStore.js";
import { CATEGORY_NAME, CHANNEL_DEFINITIONS, definitionFor, REQUIRED_GUILD_PERMISSIONS, type ChannelDefinition } from "./channels.js";

export type ChannelAction = "kept" | "adopted" | "created" | "failed" | "skipped";

export interface ChannelReport {
  purpose: ChannelPurpose;
  name: string;
  channelId: string | undefined;
  action: ChannelAction;
  missingPermissions: PermissionName[];
  error?: string;
}

export interface SetupReport {
  guildId: string;
  categoryId: string | undefined;
  categoryAction: ChannelAction;
  missingGuildPermissions: PermissionName[];
  channels: ChannelReport[];
  /** True when every channel exists and the bot has every permission it needs. */
  ok: boolean;
}

const REASON = "PokeVerse Discord bot setup";

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

function overwritesFor(definition: ChannelDefinition, guild: GuildPort): PermissionOverwriteSpec[] {
  const overwrites: PermissionOverwriteSpec[] = [
    { id: guild.botUserId, type: "member", allow: definition.required, deny: [] },
  ];
  if (definition.readOnly) {
    overwrites.push({ id: guild.everyoneRoleId, type: "role", allow: [], deny: ["SendMessages"] });
  }
  return overwrites;
}

/**
 * Creates or adopts the "PokeVerse Integration" category and its channels.
 *
 * - Saved channel IDs win, wherever an admin moved or renamed the channel.
 * - Otherwise a channel with the expected name inside the category is adopted.
 * - Only missing channels are created; nothing is ever deleted, renamed or re-permissioned.
 * - Each new ID is saved immediately, so an interrupted run never creates duplicates.
 */
export class ChannelSetup {
  private running: Promise<SetupReport> | undefined;

  constructor(
    private readonly store: StateStore,
    private readonly logger: Logger,
  ) {}

  run(guild: GuildPort): Promise<SetupReport> {
    if (!this.running) {
      this.running = this.execute(guild).finally(() => {
        this.running = undefined;
      });
    }
    return this.running;
  }

  /** Permission report for the channels currently saved, without creating anything. */
  async inspect(guild: GuildPort): Promise<SetupReport> {
    const channels = await guild.listChannels();
    const byId = new Map(channels.map((channel) => [channel.id, channel]));
    const state = this.store.get();
    const reports = CHANNEL_DEFINITIONS.map((definition): ChannelReport => {
      const id = state.channels[definition.purpose];
      const channel = id ? byId.get(id) : undefined;
      return {
        purpose: definition.purpose,
        name: channel?.name ?? definition.name,
        channelId: channel?.id,
        action: channel ? "kept" : "skipped",
        missingPermissions: channel ? this.missingIn(guild, channel.id, definition.required) : [],
      };
    });
    const category = state.categoryId ? byId.get(state.categoryId) : undefined;
    return this.finish(guild, category?.id, category ? "kept" : "skipped", reports);
  }

  /** Points a purpose at an existing text channel chosen by an admin. */
  async assign(guild: GuildPort, purpose: ChannelPurpose, channelId: string): Promise<ChannelReport> {
    const channels = await guild.listChannels();
    const channel = channels.find((item) => item.id === channelId);
    const definition = definitionFor(purpose);
    if (!channel || channel.kind !== "text") {
      return {
        purpose,
        name: definition.name,
        channelId: undefined,
        action: "failed",
        missingPermissions: [],
        error: "That is not a text channel in this server.",
      };
    }
    this.store.update((state) => {
      state.guildId = guild.id;
      state.channels[purpose] = channel.id;
      if (purpose === "serverStatus") {
        state.statusMessageId = undefined;
      }
    });
    this.logger.info("Channel reassigned", { purpose, channelId });
    return {
      purpose,
      name: channel.name,
      channelId: channel.id,
      action: "kept",
      missingPermissions: this.missingIn(guild, channel.id, definition.required),
    };
  }

  private async execute(guild: GuildPort): Promise<SetupReport> {
    const state = this.store.get();
    if (state.guildId && state.guildId !== guild.id) {
      throw new Error(
        `The state file belongs to guild ${state.guildId}, not ${guild.id}. Use a separate STATE_FILE per guild.`,
      );
    }
    if (!state.guildId) {
      this.store.update((next) => {
        next.guildId = guild.id;
      });
    }

    const canCreate = guild.botPermissions().includes("ManageChannels");
    const channels = await guild.listChannels();
    const byId = new Map(channels.map((channel) => [channel.id, channel]));

    let categoryAction: ChannelAction;
    let category = state.categoryId ? byId.get(state.categoryId) : undefined;
    if (category?.kind === "category") {
      categoryAction = "kept";
    } else {
      category = channels.find((channel) => channel.kind === "category" && normalizeName(channel.name) === normalizeName(CATEGORY_NAME));
      if (category) {
        categoryAction = "adopted";
      } else if (canCreate) {
        try {
          category = await guild.createCategory(CATEGORY_NAME, [], REASON);
          categoryAction = "created";
        } catch (error) {
          this.logger.error("Could not create the category", { error });
          categoryAction = "failed";
        }
      } else {
        categoryAction = "failed";
      }
      if (category) {
        const categoryId = category.id;
        this.store.update((next) => {
          next.categoryId = categoryId;
        });
      }
    }

    const reports: ChannelReport[] = [];
    for (const definition of CHANNEL_DEFINITIONS) {
      reports.push(await this.ensureChannel(guild, definition, channels, byId, category, canCreate));
    }
    const report = this.finish(guild, category?.id, categoryAction, reports);
    this.logger.info("Channel setup finished", {
      category: categoryAction,
      created: reports.filter((item) => item.action === "created").map((item) => item.name),
      adopted: reports.filter((item) => item.action === "adopted").map((item) => item.name),
      failed: reports.filter((item) => item.action === "failed").map((item) => item.name),
      missingGuildPermissions: report.missingGuildPermissions,
    });
    return report;
  }

  private async ensureChannel(
    guild: GuildPort,
    definition: ChannelDefinition,
    channels: GuildChannelInfo[],
    byId: Map<string, GuildChannelInfo>,
    category: GuildChannelInfo | undefined,
    canCreate: boolean,
  ): Promise<ChannelReport> {
    const base = { purpose: definition.purpose, missingPermissions: [] as PermissionName[] };
    const savedId = this.store.getChannelId(definition.purpose);
    const saved = savedId ? byId.get(savedId) : undefined;
    if (saved && saved.kind === "text") {
      return {
        ...base,
        name: saved.name,
        channelId: saved.id,
        action: "kept",
        missingPermissions: this.missingIn(guild, saved.id, definition.required),
      };
    }

    const existing = category
      ? channels.find(
          (channel) => channel.kind === "text" && channel.parentId === category.id && normalizeName(channel.name) === definition.name,
        )
      : undefined;
    if (existing) {
      this.save(definition.purpose, existing.id);
      return {
        ...base,
        name: existing.name,
        channelId: existing.id,
        action: "adopted",
        missingPermissions: this.missingIn(guild, existing.id, definition.required),
      };
    }

    if (!category || !canCreate) {
      return {
        ...base,
        name: definition.name,
        channelId: undefined,
        action: "failed",
        error: canCreate ? "The category is missing." : "Missing Manage Channels permission.",
      };
    }
    try {
      const created = await guild.createTextChannel(definition.name, category.id, definition.topic, overwritesFor(definition, guild), REASON);
      this.save(definition.purpose, created.id);
      channels.push(created);
      byId.set(created.id, created);
      return {
        ...base,
        name: created.name,
        channelId: created.id,
        action: "created",
        missingPermissions: this.missingIn(guild, created.id, definition.required),
      };
    } catch (error) {
      this.logger.error("Could not create channel", { channel: definition.name, error });
      return { ...base, name: definition.name, channelId: undefined, action: "failed", error: (error as Error).message };
    }
  }

  private save(purpose: ChannelPurpose, id: string): void {
    this.store.update((state) => {
      state.channels[purpose] = id;
      if (purpose === "serverStatus") {
        state.statusMessageId = undefined;
      }
    });
  }

  private missingIn(guild: GuildPort, channelId: string, required: PermissionName[]): PermissionName[] {
    const granted = guild.botChannelPermissions(channelId);
    if (!granted) {
      return [...required];
    }
    return required.filter((permission) => !granted.includes(permission));
  }

  private finish(
    guild: GuildPort,
    categoryId: string | undefined,
    categoryAction: ChannelAction,
    channels: ChannelReport[],
  ): SetupReport {
    const granted = guild.botPermissions();
    const missingGuildPermissions = granted.includes("Administrator")
      ? []
      : REQUIRED_GUILD_PERMISSIONS.filter((permission) => !granted.includes(permission));
    const ok =
      channels.length === CHANNEL_PURPOSES.length &&
      channels.every((channel) => channel.channelId !== undefined && channel.missingPermissions.length === 0);
    return { guildId: guild.id, categoryId, categoryAction, missingGuildPermissions, channels, ok };
  }
}

export function formatSetupReport(report: SetupReport): string {
  const lines: string[] = [];
  lines.push(`Category "${CATEGORY_NAME}": ${report.categoryAction}`);
  for (const channel of report.channels) {
    const where = channel.channelId ? `<#${channel.channelId}>` : `#${channel.name}`;
    let line = `- ${where}: ${channel.action}`;
    if (channel.missingPermissions.length > 0) {
      line += ` (missing: ${channel.missingPermissions.join(", ")})`;
    }
    if (channel.error) {
      line += ` (${channel.error})`;
    }
    lines.push(line);
  }
  if (report.missingGuildPermissions.length > 0) {
    lines.push(`Missing server permissions: ${report.missingGuildPermissions.join(", ")}`);
  }
  lines.push(report.ok ? "Everything is ready." : "Some channels need attention (see above).");
  return lines.join("\n");
}
