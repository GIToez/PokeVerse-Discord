import type { GuildChannelInfo, GuildPort, PermissionName, PermissionOverwriteSpec, RoleInfo } from "../bot/ports.js";
import { checkPrivacy, type PrivacyCheck, type PrivacyPolicy } from "../services/activity/privacy.js";
import type { PingKind } from "../services/pings/pingRoles.js";
import type { Logger } from "../utils/logger.js";
import type { ChannelPurpose, StateStore } from "../utils/stateStore.js";
import {
  ADMIN_CATEGORY_NAME,
  CATEGORY_NAME,
  STAFF_CATEGORY_NAME,
  CHANNEL_DEFINITIONS,
  definitionFor,
  LINKING_GUILD_PERMISSIONS,
  REPORT_GUILD_PERMISSIONS,
  REQUIRED_GUILD_PERMISSIONS,
  PING_GUILD_PERMISSIONS,
  CALENDAR_GUILD_PERMISSIONS,
  type ChannelDefinition,
} from "./channels.js";

export type ChannelAction = "kept" | "adopted" | "created" | "failed" | "skipped";

export interface ChannelReport {
  purpose: ChannelPurpose;
  name: string;
  channelId: string | undefined;
  action: ChannelAction;
  missingPermissions: PermissionName[];
  /** What setup changed on an existing channel (new default topic, bot permissions). */
  updated?: string[];
  error?: string;
  /** Admin channels only: why the channel is not private (empty when it is). */
  privacyProblems?: string[];
  /** Admin channels only: roles with Administrator, which always see every channel. */
  administratorRoles?: string[];
  /** Staff rooms only: the roles that should get in. */
  staffRoles?: string[];
  /** Staff rooms only: staff roles that can't get in yet. */
  accessProblems?: string[];
}

/** `staff:<id>`: the role for in-game group `<id>` (Tutor, Gamemaster, ...). `ping:<kind>`: an opt-in ping role. */
export type RoleKey = "verified" | "premium" | `staff:${number}` | `ping:${PingKind}`;

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
  staffCategoryId?: string | undefined;
  staffCategoryAction?: ChannelAction;
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
  reports: { bugs: boolean; players: boolean };
  /** The #booster-rewards channel. */
  boosters?: boolean;
  /** Staff pings (Mention Everyone) and the calendar sync (Create and Manage Events). */
  pings?: boolean;
  calendar?: boolean;
  /** #tutor-room and #gm-room, opened by the `staff:<group>` linking roles. */
  staffRooms?: boolean;
  /** Opt-in ping roles members pick for themselves (created without linking too). */
  pingRoles?: Array<{ key: `ping:${PingKind}`; name: string }>;
}

const DEFAULT_OPTIONS: SetupOptions = {
  activity: { enabled: false, viewerRoleIds: [], viewerUserIds: [] },
  adminRoleIds: [],
  adminUserIds: [],
  linking: { enabled: false, roles: [] },
  reports: { bugs: false, players: false },
};

const REASON = "PokeVerse Discord bot setup";
const BOT_POST: PermissionName[] = ["ViewChannel", "SendMessages", "EmbedLinks", "ReadMessageHistory"];
const VIEWER: PermissionName[] = ["ViewChannel", "ReadMessageHistory"];
/** Staff in a private forum answer in the posts and change their status tags. */
const FORUM_VIEWER: PermissionName[] = [...VIEWER, "SendMessagesInThreads", "ManageThreads"];
/** Staff talk in their rooms. */
const STAFF_MEMBER: PermissionName[] = [
  "ViewChannel", "SendMessages", "ReadMessageHistory", "EmbedLinks", "AttachFiles", "AddReactions",
  "CreatePublicThreads", "SendMessagesInThreads",
];

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Creates or adopts the "PokeVerse Integration" category and its channels, the private
 * "Admin Logs" category with #player-activity, the account linking roles and the ping roles.
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

  /** Whether only the staff room's roles (and the bot admins) can see the channel. */
  staffRoomPrivacy(guild: GuildPort, purpose: ChannelPurpose, channelId: string): PrivacyCheck {
    return checkPrivacy(guild.channelAccess(channelId), this.staffPolicy(guild, definitionFor(purpose)));
  }

  private definitions(): readonly ChannelDefinition[] {
    const { activity, reports } = this.options;
    const staffRooms = (this.options.staffRooms ?? false) && this.options.linking.enabled &&
      this.options.linking.roles.some((role) => role.key.startsWith("staff:"));
    const enabled = { activity: activity.enabled, bugReports: reports.bugs, playerReports: reports.players, boosterRewards: this.options.boosters ?? false, staffRooms };
    return CHANNEL_DEFINITIONS.filter((definition) => !definition.feature || enabled[definition.feature]);
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
    const staffCategory = state.staffCategoryId ? byId.get(state.staffCategoryId) : undefined;
    const roles = await this.inspectRoles(guild);
    return this.finish(guild, {
      categoryId: category?.id,
      categoryAction: category ? "kept" : "skipped",
      adminCategoryId: adminCategory?.id,
      adminCategoryAction: adminCategory ? "kept" : "skipped",
      staffCategoryId: staffCategory?.id,
      staffCategoryAction: staffCategory ? "kept" : "skipped",
      channels: reports,
      roles,
    });
  }

  /** Points a purpose at an existing text channel chosen by an admin. */
  async assign(guild: GuildPort, purpose: ChannelPurpose, channelId: string): Promise<ChannelReport> {
    const channels = await guild.listChannels();
    const channel = channels.find((item) => item.id === channelId);
    const definition = definitionFor(purpose);
    const kind = definition.type ?? "text";
    if (!channel || channel.kind !== kind) {
      return {
        purpose,
        name: definition.name,
        channelId: undefined,
        action: "failed",
        missingPermissions: [],
        error: `That is not a ${kind} channel in this server.`,
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
    const admin = this.definitions().some((definition) => definition.group === "admin")
      ? await this.ensureCategory(guild, channels, byId, "adminCategoryId", ADMIN_CATEGORY_NAME, this.privateOverwrites(guild), canCreate)
      : { category: undefined, action: "skipped" as ChannelAction };
    // The staff rooms' overwrites name the staff roles, so the roles come first.
    const roles = await this.ensureRoles(guild);
    const staff = this.definitions().some((definition) => definition.group === "staff")
      ? await this.ensureCategory(guild, channels, byId, "staffCategoryId", STAFF_CATEGORY_NAME, this.closedOverwrites(guild), canCreate)
      : { category: undefined, action: "skipped" as ChannelAction };

    const reports: ChannelReport[] = [];
    for (const definition of this.definitions()) {
      const category = definition.group === "admin" ? admin.category : definition.group === "staff" ? staff.category : main.category;
      reports.push(await this.ensureChannel(guild, definition, channels, byId, category, canCreate));
    }
    const report = this.finish(guild, {
      categoryId: main.category?.id,
      categoryAction: main.action,
      adminCategoryId: admin.category?.id,
      adminCategoryAction: admin.action,
      staffCategoryId: staff.category?.id,
      staffCategoryAction: staff.action,
      channels: reports,
      roles,
    });
    this.logger.info("Channel setup finished", {
      category: main.action,
      adminCategory: admin.action,
      staffCategory: staff.action,
      created: reports.filter((item) => item.action === "created").map((item) => item.name),
      adopted: reports.filter((item) => item.action === "adopted").map((item) => item.name),
      failed: reports.filter((item) => item.action === "failed").map((item) => item.name),
      roles: roles.map((role) => `${role.name}: ${role.action}`),
      missingGuildPermissions: report.missingGuildPermissions,
    });
    return report;
  }

  /** @everyone denied; the bot and authorized viewers allowed. */
  private privateOverwrites(guild: GuildPort, definition?: ChannelDefinition): PermissionOverwriteSpec[] {
    const policy = this.privacyPolicy(guild.botUserId);
    const forum = definition?.type === "forum";
    const viewer = forum ? FORUM_VIEWER : VIEWER;
    return [
      { id: guild.everyoneRoleId, type: "role", allow: [], deny: ["ViewChannel"] },
      { id: guild.botUserId, type: "member", allow: definition ? [...new Set([...BOT_POST, ...definition.required])] : BOT_POST, deny: [] },
      ...policy.roleIds.map((id): PermissionOverwriteSpec => ({ id, type: "role", allow: viewer, deny: ["SendMessages"] })),
      ...policy.userIds.map((id): PermissionOverwriteSpec => ({ id, type: "member", allow: viewer, deny: ["SendMessages"] })),
    ];
  }

  /** @everyone denied, the bot allowed: the staff category, opened channel by channel. */
  private closedOverwrites(guild: GuildPort): PermissionOverwriteSpec[] {
    return [
      { id: guild.everyoneRoleId, type: "role", allow: [], deny: ["ViewChannel"] },
      { id: guild.botUserId, type: "member", allow: BOT_POST, deny: [] },
    ];
  }

  /** The `staff:<group>` roles from the room's lowest group up, with their saved role ids. */
  private staffRolesFor(definition: ChannelDefinition): Array<{ name: string; roleId: string | undefined }> {
    const saved = this.store.get().roles;
    return this.options.linking.roles
      .filter(({ key }) => key.startsWith("staff:") && Number(key.slice("staff:".length)) >= (definition.minGroup ?? Infinity))
      .map(({ key, name }) => ({ name, roleId: saved[key] }));
  }

  /** Who may see a staff room: its staff roles and the bot admins. */
  private staffPolicy(guild: GuildPort, definition: ChannelDefinition): PrivacyPolicy {
    const roleIds = this.staffRolesFor(definition).flatMap(({ roleId }) => (roleId ? [roleId] : []));
    return {
      roleIds: [...new Set([...roleIds, ...this.options.adminRoleIds])],
      userIds: this.options.adminUserIds,
      botUserId: guild.botUserId,
    };
  }

  private staffOverwrites(guild: GuildPort, definition: ChannelDefinition): PermissionOverwriteSpec[] {
    const policy = this.staffPolicy(guild, definition);
    return [
      ...this.closedOverwrites(guild),
      ...policy.roleIds.map((id): PermissionOverwriteSpec => ({ id, type: "role", allow: STAFF_MEMBER, deny: [] })),
      ...policy.userIds.map((id): PermissionOverwriteSpec => ({ id, type: "member", allow: STAFF_MEMBER, deny: [] })),
    ];
  }

  private overwritesFor(definition: ChannelDefinition, guild: GuildPort): PermissionOverwriteSpec[] {
    if (definition.group === "admin") {
      return this.privateOverwrites(guild, definition);
    }
    if (definition.group === "staff") {
      return this.staffOverwrites(guild, definition);
    }
    const overwrites: PermissionOverwriteSpec[] = [
      { id: guild.botUserId, type: "member", allow: definition.required, deny: [] },
    ];
    if (definition.readOnly || definition.everyoneAllow) {
      overwrites.push({
        id: guild.everyoneRoleId,
        type: "role",
        allow: definition.everyoneAllow ?? [],
        deny: definition.readOnly ? ["SendMessages"] : [],
      });
    }
    return overwrites;
  }

  private async ensureCategory(
    guild: GuildPort,
    channels: GuildChannelInfo[],
    byId: Map<string, GuildChannelInfo>,
    key: "categoryId" | "adminCategoryId" | "staffCategoryId",
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
    const kind = definition.type ?? "text";
    const savedId = this.store.getChannelId(definition.purpose);
    const saved = savedId ? byId.get(savedId) : undefined;
    if (saved && saved.kind === kind) {
      return this.describeUpdated(guild, definition, saved, "kept");
    }

    const existing = category
      ? channels.find(
          (channel) => channel.kind === kind && channel.parentId === category.id && normalizeName(channel.name) === definition.name,
        )
      : undefined;
    if (existing) {
      this.save(definition.purpose, existing.id);
      return this.describeUpdated(guild, definition, existing, "adopted");
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
      const overwrites = this.overwritesFor(definition, guild);
      const created = kind === "forum"
        ? await guild.createForumChannel(definition.name, category.id, definition.topic, definition.tags ?? [], overwrites, REASON)
        : await guild.createTextChannel(definition.name, category.id, definition.topic, overwrites, REASON);
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

  /**
   * For an existing channel: replaces an earlier default topic, and adds to the bot's own
   * overwrite the permissions it needs, has server-wide, but the channel takes away. Nothing
   * else on the channel is changed.
   */
  private async describeUpdated(
    guild: GuildPort,
    definition: ChannelDefinition,
    channel: GuildChannelInfo,
    action: ChannelAction,
  ): Promise<ChannelReport> {
    const updated: string[] = [];
    let error: string | undefined;
    try {
      if (channel.topic !== undefined && definition.previousTopics?.includes(channel.topic ?? "")) {
        await guild.setChannelTopic(channel.id, definition.topic, REASON);
        channel.topic = definition.topic;
        updated.push("topic");
      }
      const missingTags = (definition.tags ?? []).filter(
        (tag) => channel.tagNames !== undefined && !channel.tagNames.some((name) => normalizeName(name) === normalizeName(tag.name)),
      );
      if (missingTags.length > 0) {
        const added = await guild.addForumTags(channel.id, missingTags, REASON);
        if (added.length > 0) {
          channel.tagNames = [...(channel.tagNames ?? []), ...added];
          updated.push(`tags (${added.join(", ")})`);
        }
      }
      const serverWide = guild.botPermissions();
      const restorable = this.missingIn(guild, channel.id, definition.required).filter((name) => serverWide.includes(name));
      if (restorable.length > 0 && serverWide.includes("ManageRoles")) {
        await guild.allowBotInChannel(channel.id, restorable, REASON);
        updated.push(`bot permissions (${restorable.join(", ")})`);
      }
      if (definition.group === "staff" && serverWide.includes("ManageRoles")) {
        const opened: string[] = [];
        for (const { name, roleId } of this.staffLockedOut(guild, definition, channel.id)) {
          await guild.allowRoleInChannel(channel.id, roleId, STAFF_MEMBER, REASON);
          opened.push(name);
        }
        if (opened.length > 0) {
          updated.push(`opened to ${opened.join(", ")}`);
        }
      }
    } catch (caught) {
      this.logger.error("Could not update channel", { channel: definition.name, error: caught });
      error = `Could not update: ${(caught as Error).message}`;
    }
    const report = this.describe(guild, definition, channel, action);
    if (updated.length > 0) {
      report.updated = updated;
    }
    if (error) {
      report.error = error;
    }
    return report;
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
    if (definition.group === "staff") {
      const roles = this.staffRolesFor(definition);
      report.staffRoles = roles.map(({ name }) => name);
      if (channel) {
        const privacy = checkPrivacy(guild.channelAccess(channel.id), this.staffPolicy(guild, definition));
        report.privacyProblems = privacy.problems;
        report.administratorRoles = privacy.administratorRoles;
        report.accessProblems = [
          ...roles.filter(({ roleId }) => !roleId).map(({ name }) => `role "${name}" doesn't exist yet`),
          ...this.staffLockedOut(guild, definition, channel.id).map(({ name }) => `role "${name}" can't see it`),
        ];
      }
    }
    return report;
  }

  /** Staff roles of the room that exist but can't see it. */
  private staffLockedOut(guild: GuildPort, definition: ChannelDefinition, channelId: string): Array<{ name: string; roleId: string }> {
    const access = guild.channelAccess(channelId);
    if (!access) {
      return [];
    }
    return this.staffRolesFor(definition).flatMap(({ name, roleId }) =>
      roleId && !access.roles.some((role) => role.id === roleId) ? [{ name, roleId }] : []);
  }

  /** Linking roles (when linking is on), then the ping roles. */
  private managedRoles(): Array<{ key: RoleKey; name: string }> {
    return [...(this.options.linking.enabled ? this.options.linking.roles : []), ...(this.options.pingRoles ?? [])];
  }

  private async inspectRoles(guild: GuildPort): Promise<RoleReport[]> {
    const wanted = this.managedRoles();
    if (wanted.length === 0) {
      return [];
    }
    const roles = await guild.listRoles();
    const saved = this.store.get().roles;
    return wanted.map(({ key, name }) => {
      const role = roles.find((item) => item.id === saved[key]);
      if (role?.administrator) {
        return { key, name: role.name, roleId: undefined, action: "failed", assignable: false, error: "This role has Administrator; the bot never hands it out." };
      }
      return { key, name: role?.name ?? name, roleId: role?.id, action: role ? "kept" : "skipped", assignable: role?.assignable ?? false };
    });
  }

  private async ensureRoles(guild: GuildPort): Promise<RoleReport[]> {
    const wanted = this.managedRoles();
    if (wanted.length === 0) {
      return [];
    }
    const canCreate = guild.botPermissions().includes("ManageRoles");
    let roles: RoleInfo[];
    try {
      roles = await guild.listRoles();
    } catch (error) {
      this.logger.error("Could not list roles", { error });
      return wanted.map(({ key, name }) => ({
        key, name, roleId: undefined, action: "failed", assignable: false, error: (error as Error).message,
      }));
    }
    const reports: RoleReport[] = [];
    for (const { key, name } of wanted) {
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
      if (role?.administrator) {
        reports.push({
          key, name: role.name, roleId: undefined, action: "failed", assignable: false,
          error: "This role has Administrator; the bot never hands it out. Remove Administrator from it or rename it.",
        });
        continue;
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
    const { linking, reports, pings, calendar } = this.options;
    const pingRoles = (this.options.pingRoles?.length ?? 0) > 0;
    const needed = REQUIRED_GUILD_PERMISSIONS.filter(
      (permission) =>
        (linking.enabled || (pingRoles && permission === "ManageRoles") || !LINKING_GUILD_PERMISSIONS.includes(permission)) &&
        (reports.bugs || reports.players || !REPORT_GUILD_PERMISSIONS.includes(permission)) &&
        (pings || pingRoles || !PING_GUILD_PERMISSIONS.includes(permission)) &&
        (calendar || !CALENDAR_GUILD_PERMISSIONS.includes(permission)),
    );
    const missingGuildPermissions = granted.includes("Administrator")
      ? []
      : needed.filter((permission) => !granted.includes(permission));
    const ok =
      parts.channels.length === this.definitions().length &&
      parts.channels.every(
        (channel) => channel.channelId !== undefined && channel.missingPermissions.length === 0 &&
          !channel.privacyProblems?.length && !channel.accessProblems?.length,
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
  if (report.staffCategoryAction && report.staffCategoryAction !== "skipped") {
    lines.push(`Private category "${STAFF_CATEGORY_NAME}": ${report.staffCategoryAction}`);
  }
  for (const channel of report.channels) {
    const where = channel.channelId ? `<#${channel.channelId}>` : `#${channel.name}`;
    let line = `- ${where}: ${channel.action}`;
    if (channel.updated?.length) {
      line += ` (updated: ${channel.updated.join(", ")})`;
    }
    if (channel.missingPermissions.length > 0) {
      line += ` (missing: ${channel.missingPermissions.join(", ")})`;
    }
    if (channel.error) {
      line += ` (${channel.error})`;
    }
    if (channel.staffRoles) {
      if (channel.privacyProblems?.length) {
        line += ` NOT PRIVATE: ${channel.privacyProblems.join("; ")}`;
      }
      if (channel.accessProblems?.length) {
        line += ` (${channel.accessProblems.join("; ")})`;
      }
      if (channel.channelId && !channel.privacyProblems?.length && !channel.accessProblems?.length) {
        line += ` (private: ${channel.staffRoles.join(", ")})`;
      }
    } else if (channel.privacyProblems?.length) {
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
