import type { GuildChannelInfo, GuildPort, PermissionName, PermissionOverwriteSpec, RoleInfo } from "../bot/ports.js";
import { checkPrivacy, type PrivacyPolicy } from "../services/activity/privacy.js";
import type { Logger } from "../utils/logger.js";
import type { ChannelPurpose, StateStore } from "../utils/stateStore.js";
import {
  ADMIN_CATEGORY_NAME,
  CATEGORY_NAME,
  CHANNEL_DEFINITIONS,
  definitionFor,
  LINKING_GUILD_PERMISSIONS,
  REQUIRED_GUILD_PERMISSIONS,
  type ChannelDefinition,
} from "./channels.js";

export type ChannelAction = "kept" | "adopted" | "created" | "failed" | "skipped";

export interface ChannelReport {
  purpose: ChannelPurpose;
  name: string;
  channelId: string | undefined;
  action: ChannelAction;
  missingPermissions: PermissionName[];
  error?: string;
  /** Admin channels only: why the channel is not private (empty when it is). */
  privacyProblems?: string[];
  /** Admin channels only: roles with Administrator, which always see every channel. */
  administratorRoles?: string[];
}

export type RoleKey = "verified" | "premium";

export interface RoleReport {
  key: RoleKey;
  name: string;
  roleId: string | undefined;
  action: ChannelAction;
  /** The bot's highest role is above it, so the bot can assign it. */
  assignable: boolean;
  error?: string;
}

export interface SetupReport {
  guildId: string;
  categoryId: string | undefined;
  categoryAction: ChannelAction;
  adminCategoryId?: string | undefined;
  adminCategoryAction?: ChannelAction;
  missingGuildPermissions: PermissionName[];
  channels: ChannelReport[];
  roles: RoleReport[];
  /** True when every channel exists, admin channels are private and every permission is granted. */
  ok: boolean;
}

export interface SetupOptions {
  activity: { enabled: boolean; viewerRoleIds: string[]; viewerUserIds: string[] };
  adminRoleIds: string[];
  adminUserIds: string[];
  linking: { enabled: boolean; roles: Array<{ key: RoleKey; name: string }> };
}

const DEFAULT_OPTIONS: SetupOptions = {
  activity: { enabled: false, viewerRoleIds: [], viewerUserIds: [] },
  adminRoleIds: [],
  adminUserIds: [],
  linking: { enabled: false, roles: [] },
};

const REASON = "PokeVerse Discord bot setup";
const BOT_POST: PermissionName[] = ["ViewChannel", "SendMessages", "EmbedLinks", "ReadMessageHistory"];
const VIEWER: PermissionName[] = ["ViewChannel", "ReadMessageHistory"];

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Creates or adopts the "PokeVerse Integration" category and its channels, the private
 * "Admin Logs" category with #player-activity, and the account linking roles.
 *
 * - Saved IDs win, wherever an admin moved or renamed the channel or role.
 * - Otherwise a channel with the expected name inside the category (or a role with the
 *   expected name) is adopted.
 * - Only missing items are created; nothing is ever deleted, renamed or re-permissioned.
 * - Each new ID is saved immediately, so an interrupted run never creates duplicates.
 */
export class ChannelSetup {
  private running: Promise<SetupReport> | undefined;
  private readonly options: SetupOptions;

  constructor(
    private readonly store: StateStore,
    private readonly logger: Logger,
    options: Partial<SetupOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /** Who may see admin channels. */
  privacyPolicy(botUserId: string): PrivacyPolicy {
    const { activity, adminRoleIds, adminUserIds } = this.options;
    return {
      roleIds: [...new Set([...activity.viewerRoleIds, ...adminRoleIds])],
      userIds: [...new Set([...activity.viewerUserIds, ...adminUserIds])],
      botUserId,
    };
  }

  private definitions(): readonly ChannelDefinition[] {
    return CHANNEL_DEFINITIONS.filter((definition) => definition.group === "main" || this.options.activity.enabled);
  }

  run(guild: GuildPort): Promise<SetupReport> {
    if (!this.running) {
      this.running = this.execute(guild).finally(() => {
        this.running = undefined;
      });
    }
    return this.running;
  }

  /** Permission and privacy report for what is currently saved, without creating anything. */
  async inspect(guild: GuildPort): Promise<SetupReport> {
    const channels = await guild.listChannels();
    const byId = new Map(channels.map((channel) => [channel.id, channel]));
    const state = this.store.get();
    const reports = this.definitions().map((definition): ChannelReport => {
      const id = state.channels[definition.purpose];
      const channel = id ? byId.get(id) : undefined;
      return this.describe(guild, definition, channel, channel ? "kept" : "skipped");
    });
    const category = state.categoryId ? byId.get(state.categoryId) : undefined;
    const adminCategory = state.adminCategoryId ? byId.get(state.adminCategoryId) : undefined;
    const roles = this.options.linking.enabled ? await this.inspectRoles(guild) : [];
    return this.finish(guild, {
      categoryId: category?.id,
      categoryAction: category ? "kept" : "skipped",
      adminCategoryId: adminCategory?.id,
      adminCategoryAction: adminCategory ? "kept" : "skipped",
      channels: reports,
      roles,
    });
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
    return this.describe(guild, definition, channel, "kept");
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

    const main = await this.ensureCategory(guild, channels, byId, "categoryId", CATEGORY_NAME, [], canCreate);
    const admin = this.options.activity.enabled
      ? await this.ensureCategory(guild, channels, byId, "adminCategoryId", ADMIN_CATEGORY_NAME, this.privateOverwrites(guild), canCreate)
      : { category: undefined, action: "skipped" as ChannelAction };

    const reports: ChannelReport[] = [];
    for (const definition of this.definitions()) {
      const category = definition.group === "admin" ? admin.category : main.category;
      reports.push(await this.ensureChannel(guild, definition, channels, byId, category, canCreate));
    }
    const roles = this.options.linking.enabled ? await this.ensureRoles(guild) : [];
    const report = this.finish(guild, {
      categoryId: main.category?.id,
      categoryAction: main.action,
      adminCategoryId: admin.category?.id,
      adminCategoryAction: admin.action,
      channels: reports,
      roles,
    });
    this.logger.info("Channel setup finished", {
      category: main.action,
      adminCategory: admin.action,
      created: reports.filter((item) => item.action === "created").map((item) => item.name),
      adopted: reports.filter((item) => item.action === "adopted").map((item) => item.name),
      failed: reports.filter((item) => item.action === "failed").map((item) => item.name),
      roles: roles.map((role) => `${role.name}: ${role.action}`),
      missingGuildPermissions: report.missingGuildPermissions,
    });
    return report;
  }

  /** @everyone denied; the bot and authorized viewers allowed. */
  private privateOverwrites(guild: GuildPort): PermissionOverwriteSpec[] {
    const policy = this.privacyPolicy(guild.botUserId);
    return [
      { id: guild.everyoneRoleId, type: "role", allow: [], deny: ["ViewChannel"] },
      { id: guild.botUserId, type: "member", allow: BOT_POST, deny: [] },
      ...policy.roleIds.map((id): PermissionOverwriteSpec => ({ id, type: "role", allow: VIEWER, deny: ["SendMessages"] })),
      ...policy.userIds.map((id): PermissionOverwriteSpec => ({ id, type: "member", allow: VIEWER, deny: ["SendMessages"] })),
    ];
  }

  private overwritesFor(definition: ChannelDefinition, guild: GuildPort): PermissionOverwriteSpec[] {
    if (definition.group === "admin") {
      return this.privateOverwrites(guild);
    }
    const overwrites: PermissionOverwriteSpec[] = [
      { id: guild.botUserId, type: "member", allow: definition.required, deny: [] },
    ];
    if (definition.readOnly) {
      overwrites.push({ id: guild.everyoneRoleId, type: "role", allow: [], deny: ["SendMessages"] });
    }
    return overwrites;
  }

  private async ensureCategory(
    guild: GuildPort,
    channels: GuildChannelInfo[],
    byId: Map<string, GuildChannelInfo>,
    key: "categoryId" | "adminCategoryId",
    name: string,
    overwrites: PermissionOverwriteSpec[],
    canCreate: boolean,
  ): Promise<{ category: GuildChannelInfo | undefined; action: ChannelAction }> {
    const savedId = this.store.get()[key];
    const saved = savedId ? byId.get(savedId) : undefined;
    if (saved?.kind === "category") {
      return { category: saved, action: "kept" };
    }
    let category = channels.find((channel) => channel.kind === "category" && normalizeName(channel.name) === normalizeName(name));
    let action: ChannelAction;
    if (category) {
      action = "adopted";
    } else if (canCreate) {
      try {
        category = await guild.createCategory(name, overwrites, REASON);
        channels.push(category);
        byId.set(category.id, category);
        action = "created";
      } catch (error) {
        this.logger.error("Could not create the category", { category: name, error });
        action = "failed";
      }
    } else {
      action = "failed";
    }
    if (category) {
      const categoryId = category.id;
      this.store.update((next) => {
        next[key] = categoryId;
      });
    }
    return { category, action };
  }

  private async ensureChannel(
    guild: GuildPort,
    definition: ChannelDefinition,
    channels: GuildChannelInfo[],
    byId: Map<string, GuildChannelInfo>,
    category: GuildChannelInfo | undefined,
    canCreate: boolean,
  ): Promise<ChannelReport> {
    const savedId = this.store.getChannelId(definition.purpose);
    const saved = savedId ? byId.get(savedId) : undefined;
    if (saved && saved.kind === "text") {
      return this.describe(guild, definition, saved, "kept");
    }

    const existing = category
      ? channels.find(
          (channel) => channel.kind === "text" && channel.parentId === category.id && normalizeName(channel.name) === definition.name,
        )
      : undefined;
    if (existing) {
      this.save(definition.purpose, existing.id);
      return this.describe(guild, definition, existing, "adopted");
    }

    if (!category || !canCreate) {
      return {
        purpose: definition.purpose,
        name: definition.name,
        channelId: undefined,
        action: "failed",
        missingPermissions: [],
        error: canCreate ? "The category is missing." : "Missing Manage Channels permission.",
      };
    }
    try {
      const created = await guild.createTextChannel(definition.name, category.id, definition.topic, this.overwritesFor(definition, guild), REASON);
      this.save(definition.purpose, created.id);
      channels.push(created);
      byId.set(created.id, created);
      return this.describe(guild, definition, created, "created");
    } catch (error) {
      this.logger.error("Could not create channel", { channel: definition.name, error });
      return {
        purpose: definition.purpose,
        name: definition.name,
        channelId: undefined,
        action: "failed",
        missingPermissions: [],
        error: (error as Error).message,
      };
    }
  }

  private describe(
    guild: GuildPort,
    definition: ChannelDefinition,
    channel: GuildChannelInfo | undefined,
    action: ChannelAction,
  ): ChannelReport {
    const report: ChannelReport = {
      purpose: definition.purpose,
      name: channel?.name ?? definition.name,
      channelId: channel?.id,
      action,
      missingPermissions: channel ? this.missingIn(guild, channel.id, definition.required) : [],
    };
    if (definition.group === "admin" && channel) {
      const privacy = checkPrivacy(guild.channelAccess(channel.id), this.privacyPolicy(guild.botUserId));
      report.privacyProblems = privacy.problems;
      report.administratorRoles = privacy.administratorRoles;
    }
    return report;
  }

  private async inspectRoles(guild: GuildPort): Promise<RoleReport[]> {
    const roles = await guild.listRoles();
    const saved = this.store.get().roles;
    return this.options.linking.roles.map(({ key, name }) => {
      const role = roles.find((item) => item.id === saved[key]);
      return { key, name: role?.name ?? name, roleId: role?.id, action: role ? "kept" : "skipped", assignable: role?.assignable ?? false };
    });
  }

  private async ensureRoles(guild: GuildPort): Promise<RoleReport[]> {
    const canCreate = guild.botPermissions().includes("ManageRoles");
    let roles: RoleInfo[];
    try {
      roles = await guild.listRoles();
    } catch (error) {
      this.logger.error("Could not list roles", { error });
      return this.options.linking.roles.map(({ key, name }) => ({
        key, name, roleId: undefined, action: "failed", assignable: false, error: (error as Error).message,
      }));
    }
    const reports: RoleReport[] = [];
    for (const { key, name } of this.options.linking.roles) {
      const savedId = this.store.get().roles[key];
      let role = roles.find((item) => item.id === savedId);
      let action: ChannelAction = "kept";
      let error: string | undefined;
      if (!role) {
        role = roles.find((item) => !item.managed && normalizeName(item.name) === normalizeName(name));
        action = "adopted";
      }
      if (!role) {
        if (canCreate) {
          try {
            role = await guild.createRole(name, REASON);
            roles.push(role);
            action = "created";
          } catch (caught) {
            this.logger.error("Could not create role", { role: name, error: caught });
            action = "failed";
            error = (caught as Error).message;
          }
        } else {
          action = "failed";
          error = "Missing Manage Roles permission.";
        }
      }
      if (role && action !== "kept") {
        const roleId = role.id;
        this.store.update((next) => {
          next.roles[key] = roleId;
        });
      }
      reports.push({ key, name: role?.name ?? name, roleId: role?.id, action, assignable: role?.assignable ?? false, error });
    }
    return reports;
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
    parts: Omit<SetupReport, "guildId" | "missingGuildPermissions" | "ok">,
  ): SetupReport {
    const granted = guild.botPermissions();
    const needed = this.options.linking.enabled
      ? REQUIRED_GUILD_PERMISSIONS
      : REQUIRED_GUILD_PERMISSIONS.filter((permission) => !LINKING_GUILD_PERMISSIONS.includes(permission));
    const missingGuildPermissions = granted.includes("Administrator")
      ? []
      : needed.filter((permission) => !granted.includes(permission));
    const ok =
      parts.channels.length === this.definitions().length &&
      parts.channels.every(
        (channel) => channel.channelId !== undefined && channel.missingPermissions.length === 0 && !channel.privacyProblems?.length,
      ) &&
      parts.roles.every((role) => role.roleId !== undefined && role.assignable) &&
      missingGuildPermissions.length === 0;
    return { guildId: guild.id, ...parts, missingGuildPermissions, ok };
  }
}

const ACTION_TEXT: Record<ChannelAction, string> = {
  kept: "ok",
  adopted: "adopted",
  created: "created",
  failed: "FAILED",
  skipped: "not set up",
};

export function formatSetupReport(report: SetupReport): string {
  const lines: string[] = [];
  lines.push(`Category "${CATEGORY_NAME}": ${report.categoryAction}`);
  if (report.adminCategoryAction && report.adminCategoryAction !== "skipped") {
    lines.push(`Private category "${ADMIN_CATEGORY_NAME}": ${report.adminCategoryAction}`);
  }
  for (const channel of report.channels) {
    const where = channel.channelId ? `<#${channel.channelId}>` : `#${channel.name}`;
    let line = `- ${where}: ${channel.action}`;
    if (channel.missingPermissions.length > 0) {
      line += ` (missing: ${channel.missingPermissions.join(", ")})`;
    }
    if (channel.error) {
      line += ` (${channel.error})`;
    }
    if (channel.privacyProblems?.length) {
      line += ` NOT PRIVATE, nothing is posted until fixed: ${channel.privacyProblems.join("; ")}`;
    } else if (channel.privacyProblems) {
      line += " (private)";
    }
    lines.push(line);
    if (channel.administratorRoles?.length) {
      lines.push(`  Roles with Administrator always see it: ${channel.administratorRoles.join(", ")}`);
    }
  }
  for (const role of report.roles) {
    let line = `- Role "${role.name}": ${ACTION_TEXT[role.action]}`;
    if (role.roleId && !role.assignable) {
      line += " (move the bot's role above it so the bot can assign it)";
    }
    if (role.error) {
      line += ` (${role.error})`;
    }
    lines.push(line);
  }
  if (report.missingGuildPermissions.length > 0) {
    lines.push(`Missing server permissions: ${report.missingGuildPermissions.join(", ")}`);
  }
  lines.push(report.ok ? "Everything is ready." : "Some items need attention (see above).");
  return lines.join("\n");
}
