import type {
  PermissionsBitField} from "discord.js";
import {
  AttachmentBuilder,
  ChannelType,
  DiscordAPIError,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  GuildScheduledEventStatus,
  MessageFlags,
  OverwriteType,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  type Client,
  type ForumChannel,
  type Guild,
  type GuildBasedChannel,
  type Role,
  type MessageCreateOptions,
  type MessageEditOptions,
  type TextChannel,
  type ThreadChannel,
  ThreadAutoArchiveDuration,
} from "discord.js";
import type { StateStore } from "../utils/stateStore.js";
import type { ChannelPurpose } from "../utils/stateStore.js";
import type {
  ChannelAccess,
  ChannelDirectory,
  ChannelSink,
  ForumPostSink,
  ForumPostSpec,
  ForumSink,
  ForumTag,
  ForumTagSpec,
  GuildChannelInfo,
  GuildPort,
  MemberInfo,
  OutgoingFile,
  OutgoingMessage,
  PermissionName,
  PermissionOverwriteSpec,
  RoleInfo,
  ScheduledEventSpec,
  ScheduledEventStatus,
  ThreadSink,
} from "./ports.js";

function toBits(names: PermissionName[]): bigint {
  return names.reduce((bits, name) => bits | PermissionFlagsBits[name], 0n);
}

function toNames(bits: Readonly<PermissionsBitField> | null | undefined): PermissionName[] {
  if (!bits) {
    return [];
  }
  // Guild-level member permissions keep only the flags the roles set; Administrator implies all.
  return bits.has(PermissionFlagsBits.Administrator) ? (Object.keys(PermissionFlagsBits) as PermissionName[]) : (bits.toArray() as PermissionName[]);
}

function toInfo(channel: GuildBasedChannel): GuildChannelInfo {
  if (channel.type === ChannelType.GuildForum) {
    return {
      id: channel.id, name: channel.name, kind: "forum", parentId: channel.parentId ?? null, topic: channel.topic,
      tagNames: channel.availableTags.map((tag) => tag.name),
    };
  }
  const kind = channel.type === ChannelType.GuildCategory ? "category" : channel.type === ChannelType.GuildText ? "text" : "other";
  return { id: channel.id, name: channel.name, kind, parentId: channel.parentId ?? null, topic: channel.type === ChannelType.GuildText ? channel.topic : undefined };
}

function toTagData(tag: ForumTagSpec) {
  return { name: tag.name.slice(0, 20), moderated: tag.moderated, emoji: tag.emoji ? { id: null, name: tag.emoji } : null };
}

function mentions(message: OutgoingMessage) {
  return {
    parse: message.mentionEveryone ? ["everyone" as const] : [],
    ...(message.mentionUserIds?.length ? { users: message.mentionUserIds } : {}),
    ...(message.mentionRoleIds?.length ? { roles: message.mentionRoleIds } : {}),
  };
}

const EVENT_STATUS = {
  active: GuildScheduledEventStatus.Active,
  completed: GuildScheduledEventStatus.Completed,
  canceled: GuildScheduledEventStatus.Canceled,
} as const satisfies Record<Exclude<ScheduledEventStatus, "scheduled">, GuildScheduledEventStatus>;

function isUnknownEvent(error: unknown): boolean {
  return error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownGuildScheduledEvent;
}

function overwrites(specs: PermissionOverwriteSpec[]) {
  return specs.map((spec) => ({
    id: spec.id,
    type: spec.type === "role" ? OverwriteType.Role : OverwriteType.Member,
    allow: toBits(spec.allow),
    deny: toBits(spec.deny),
  }));
}

function attachment(file: OutgoingFile): AttachmentBuilder {
  return new AttachmentBuilder(file.data ?? file.path ?? "", { name: file.name });
}

function toCreateOptions(message: OutgoingMessage): MessageCreateOptions {
  return {
    content: message.content,
    embeds: message.embeds,
    files: message.files?.map(attachment),
    allowedMentions: mentions(message),
    flags: message.suppressEmbeds ? MessageFlags.SuppressEmbeds : undefined,
  };
}

function toEditOptions(message: OutgoingMessage): MessageEditOptions {
  return {
    content: message.content ?? null,
    embeds: message.embeds ?? [],
    files: message.files?.map(attachment),
    attachments: message.files ? undefined : [],
    allowedMentions: { parse: [] },
  };
}

export class TextChannelSink implements ChannelSink {
  constructor(protected readonly channel: TextChannel | ThreadChannel) {}

  get id(): string {
    return this.channel.id;
  }

  async send(message: OutgoingMessage): Promise<string> {
    const sent = await this.channel.send(toCreateOptions(message));
    return sent.id;
  }

  async edit(messageId: string, message: OutgoingMessage): Promise<boolean> {
    try {
      const existing = await this.channel.messages.fetch(messageId);
      if (existing.author.id !== this.channel.client.user.id) {
        return false;
      }
      await existing.edit(toEditOptions(message));
      return true;
    } catch (error) {
      if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownMessage) {
        return false;
      }
      throw error;
    }
  }

  async delete(messageId: string): Promise<boolean> {
    try {
      await this.channel.messages.delete(messageId);
      return true;
    } catch (error) {
      if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownMessage) {
        return false;
      }
      throw error;
    }
  }

  async startThread(messageId: string, name: string): Promise<ThreadSink> {
    const channel = this.channel;
    if (channel.isThread()) {
      throw new Error("Threads can't have threads");
    }
    const message = await channel.messages.fetch(messageId);
    const thread = await message.startThread({ name: name.slice(0, 100), autoArchiveDuration: ThreadAutoArchiveDuration.OneHour });
    return new ThreadChannelSink(thread);
  }

  async thread(threadId: string): Promise<ThreadSink | undefined> {
    const channel = this.channel;
    if (channel.isThread()) {
      return undefined;
    }
    try {
      const thread = await (channel as TextChannel).threads.fetch(threadId);
      return thread ? new ThreadChannelSink(thread) : undefined;
    } catch (error) {
      if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownChannel) {
        return undefined;
      }
      throw error;
    }
  }
}

/** A thread the bot started; sending to an archived thread reopens it. */
export class ThreadChannelSink extends TextChannelSink implements ThreadSink {
  constructor(
    protected readonly threadChannel: ThreadChannel,
    private readonly archiveReason = "Wild legendary encounter ended",
  ) {
    super(threadChannel);
  }

  async archive(): Promise<void> {
    if (!this.threadChannel.archived) {
      await this.threadChannel.setArchived(true, this.archiveReason);
    }
  }
}

const REPORT_REASON = "PokeVerse report";

/** A forum post the bot made. */
export class ForumPostChannelSink extends ThreadChannelSink implements ForumPostSink {
  constructor(thread: ThreadChannel) {
    super(thread, "Report closed");
  }

  async update(change: { tagIds?: string[]; name?: string; archived?: boolean }): Promise<void> {
    const thread = this.threadChannel;
    if (thread.archived && (change.tagIds !== undefined || change.name !== undefined || change.archived === false)) {
      await thread.setArchived(false, REPORT_REASON);
    }
    const edit: { appliedTags?: string[]; name?: string; reason: string } = { reason: REPORT_REASON };
    if (change.tagIds !== undefined) {
      edit.appliedTags = change.tagIds.slice(0, 5);
    }
    if (change.name !== undefined && change.name !== thread.name) {
      edit.name = change.name.slice(0, 100);
    }
    if (edit.appliedTags !== undefined || edit.name !== undefined) {
      await thread.edit(edit);
    }
    if (change.archived) {
      await thread.setArchived(true, REPORT_REASON);
    }
  }
}

export class ForumChannelSink implements ForumSink {
  constructor(private readonly channel: ForumChannel) {}

  get id(): string {
    return this.channel.id;
  }

  tags(): ForumTag[] {
    return this.channel.availableTags.map((tag) => ({ id: tag.id, name: tag.name }));
  }

  async createPost(spec: ForumPostSpec): Promise<{ threadId: string; messageId: string }> {
    const thread = await this.channel.threads.create({
      name: spec.name.slice(0, 100),
      message: toCreateOptions(spec.message),
      appliedTags: spec.tagIds.slice(0, 5),
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
      reason: REPORT_REASON,
    });
    // A forum post's first message has the thread's id.
    return { threadId: thread.id, messageId: thread.id };
  }

  async post(threadId: string): Promise<ForumPostSink | undefined> {
    try {
      const thread = await this.channel.threads.fetch(threadId);
      return thread ? new ForumPostChannelSink(thread) : undefined;
    } catch (error) {
      if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownChannel) {
        return undefined;
      }
      throw error;
    }
  }
}

function isUnknownMember(error: unknown): boolean {
  return error instanceof DiscordAPIError &&
    (error.code === RESTJSONErrorCodes.UnknownMember || error.code === RESTJSONErrorCodes.UnknownUser);
}

/** Resolves feature channels from the saved IDs on every call, so reassignments apply immediately. */
export class DiscordChannelDirectory implements ChannelDirectory {
  constructor(
    private readonly client: Client,
    private readonly store: StateStore,
    private readonly guildId: string,
  ) {}

  get(purpose: ChannelPurpose): ChannelSink | undefined {
    const id = this.store.getChannelId(purpose);
    if (!id) {
      return undefined;
    }
    const channel = this.client.channels.cache.get(id);
    if (!channel || channel.type !== ChannelType.GuildText || channel.guildId !== this.guildId) {
      return undefined;
    }
    return new TextChannelSink(channel);
  }

  forum(purpose: ChannelPurpose): ForumSink | undefined {
    const id = this.store.getChannelId(purpose);
    const channel = id ? this.client.channels.cache.get(id) : undefined;
    if (!channel || channel.type !== ChannelType.GuildForum || channel.guildId !== this.guildId) {
      return undefined;
    }
    return new ForumChannelSink(channel);
  }
}

export class DiscordGuildPort implements GuildPort {
  constructor(private readonly guild: Guild) {}

  get id(): string {
    return this.guild.id;
  }

  get name(): string {
    return this.guild.name;
  }

  get everyoneRoleId(): string {
    return this.guild.roles.everyone.id;
  }

  get botUserId(): string {
    return this.guild.client.user.id;
  }

  async listChannels(): Promise<GuildChannelInfo[]> {
    const channels = await this.guild.channels.fetch();
    return [...channels.values()].filter((channel): channel is NonNullable<typeof channel> => channel !== null).map(toInfo);
  }

  async createCategory(name: string, specs: PermissionOverwriteSpec[], reason: string): Promise<GuildChannelInfo> {
    const channel = await this.guild.channels.create({
      name,
      type: ChannelType.GuildCategory,
      permissionOverwrites: overwrites(specs),
      reason,
    });
    return toInfo(channel);
  }

  async createTextChannel(
    name: string,
    parentId: string,
    topic: string,
    specs: PermissionOverwriteSpec[],
    reason: string,
  ): Promise<GuildChannelInfo> {
    const channel = await this.guild.channels.create({
      name,
      type: ChannelType.GuildText,
      parent: parentId,
      topic,
      permissionOverwrites: overwrites(specs),
      reason,
    });
    return toInfo(channel);
  }

  async createForumChannel(
    name: string,
    parentId: string,
    topic: string,
    tags: ForumTagSpec[],
    specs: PermissionOverwriteSpec[],
    reason: string,
  ): Promise<GuildChannelInfo> {
    const channel = await this.guild.channels.create({
      name,
      type: ChannelType.GuildForum,
      parent: parentId,
      topic,
      availableTags: tags.slice(0, 20).map(toTagData),
      permissionOverwrites: overwrites(specs),
      reason,
    });
    return toInfo(channel);
  }

  async addForumTags(channelId: string, tags: ForumTagSpec[], reason: string): Promise<string[]> {
    const channel = await this.guild.channels.fetch(channelId);
    if (channel?.type !== ChannelType.GuildForum) {
      return [];
    }
    const existing = channel.availableTags;
    const names = new Set(existing.map((tag) => tag.name.toLowerCase()));
    const added = tags.filter((tag) => !names.has(tag.name.toLowerCase())).slice(0, Math.max(0, 20 - existing.length));
    if (added.length === 0) {
      return [];
    }
    await channel.setAvailableTags([...existing, ...added.map(toTagData)], reason);
    return added.map((tag) => tag.name);
  }

  botPermissions(): PermissionName[] {
    return toNames(this.guild.members.me?.permissions);
  }

  async setChannelTopic(channelId: string, topic: string, reason: string): Promise<void> {
    const channel = await this.guild.channels.fetch(channelId);
    if (channel?.type === ChannelType.GuildText || channel?.type === ChannelType.GuildForum) {
      await channel.setTopic(topic, reason);
    }
  }

  async allowBotInChannel(channelId: string, permissions: PermissionName[], reason: string): Promise<void> {
    const channel = await this.guild.channels.fetch(channelId);
    if (channel?.type === ChannelType.GuildText || channel?.type === ChannelType.GuildForum) {
      await channel.permissionOverwrites.edit(
        this.botUserId,
        Object.fromEntries(permissions.map((name) => [name, true])),
        { reason, type: OverwriteType.Member },
      );
    }
  }

  async allowRoleInChannel(channelId: string, roleId: string, permissions: PermissionName[], reason: string): Promise<void> {
    const channel = await this.guild.channels.fetch(channelId);
    if (channel?.type === ChannelType.GuildText || channel?.type === ChannelType.GuildForum) {
      await channel.permissionOverwrites.edit(
        roleId,
        Object.fromEntries(permissions.map((name) => [name, true])),
        { reason, type: OverwriteType.Role },
      );
    }
  }

  botChannelPermissions(channelId: string): PermissionName[] | undefined {
    const channel = this.guild.channels.cache.get(channelId);
    const me = this.guild.members.me;
    if (!channel || !me) {
      return undefined;
    }
    return toNames(channel.permissionsFor(me));
  }

  channelAccess(channelId: string): ChannelAccess | undefined {
    const channel = this.guild.channels.cache.get(channelId);
    if (!channel || channel.isThread()) {
      return undefined;
    }
    const everyone = this.guild.roles.everyone;
    const view = PermissionFlagsBits.ViewChannel;
    const roles = [...this.guild.roles.cache.values()]
      .filter((role) => role.id !== everyone.id && channel.permissionsFor(role).has(view))
      .map((role) => ({
        id: role.id,
        name: role.name,
        administrator: role.permissions.has(PermissionFlagsBits.Administrator),
        ownBotRole: role.tags?.botId === this.botUserId,
      }));
    const members = [...channel.permissionOverwrites.cache.values()]
      .filter((overwrite) => overwrite.type === OverwriteType.Member && overwrite.allow.has(view))
      .map((overwrite) => overwrite.id);
    return { everyoneCanView: channel.permissionsFor(everyone).has(view), roles, members };
  }

  private toRoleInfo(role: Role): RoleInfo {
    const me = this.guild.members.me;
    return {
      id: role.id,
      name: role.name,
      managed: role.managed,
      assignable: !role.managed && me !== null && me.roles.highest.comparePositionTo(role) > 0,
      administrator: role.permissions.has(PermissionFlagsBits.Administrator),
      mentionable: role.mentionable,
    };
  }

  async listRoles(): Promise<RoleInfo[]> {
    const roles = await this.guild.roles.fetch();
    return [...roles.values()].filter((role) => role.id !== this.guild.roles.everyone.id).map((role) => this.toRoleInfo(role));
  }

  async createRole(name: string, reason: string): Promise<RoleInfo> {
    const role = await this.guild.roles.create({ name, permissions: [], mentionable: false, hoist: false, reason });
    return this.toRoleInfo(role);
  }

  async fetchMember(userId: string): Promise<MemberInfo | undefined> {
    try {
      // Always from the API: without the Server Members intent the cache never sees role or
      // nickname changes, including the bot's own.
      const member = await this.guild.members.fetch({ user: userId, force: true });
      return {
        id: member.id,
        roleIds: [...member.roles.cache.keys()],
        nickname: member.nickname,
        nicknameManageable: member.manageable,
        premiumSince: member.premiumSinceTimestamp,
      };
    } catch (error) {
      if (isUnknownMember(error)) {
        return undefined;
      }
      throw error;
    }
  }

  async addRole(userId: string, roleId: string, reason: string): Promise<void> {
    await this.guild.members.addRole({ user: userId, role: roleId, reason });
  }

  async removeRole(userId: string, roleId: string, reason: string): Promise<void> {
    await this.guild.members.removeRole({ user: userId, role: roleId, reason });
  }

  async setNickname(userId: string, nickname: string | null, reason: string): Promise<void> {
    await this.guild.members.edit(userId, { nick: nickname, reason });
  }

  boosts(): { count: number; level: number } {
    return { count: this.guild.premiumSubscriptionCount ?? 0, level: this.guild.premiumTier };
  }

  async createScheduledEvent(spec: ScheduledEventSpec, reason: string): Promise<string> {
    const event = await this.guild.scheduledEvents.create({
      name: spec.name.slice(0, 100),
      description: spec.description.slice(0, 1000),
      scheduledStartTime: new Date(spec.startsAt),
      scheduledEndTime: new Date(spec.endsAt),
      privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
      entityType: GuildScheduledEventEntityType.External,
      entityMetadata: { location: spec.location.slice(0, 100) },
      image: spec.image ? (spec.image.data ?? spec.image.path) : undefined,
      reason,
    });
    return event.id;
  }

  async editScheduledEvent(
    eventId: string,
    change: Partial<ScheduledEventSpec> & { status?: Exclude<ScheduledEventStatus, "scheduled"> },
    reason: string,
  ): Promise<boolean> {
    try {
      await this.guild.scheduledEvents.edit(eventId, {
        name: change.name?.slice(0, 100),
        description: change.description?.slice(0, 1000),
        scheduledStartTime: change.startsAt !== undefined ? new Date(change.startsAt) : undefined,
        scheduledEndTime: change.endsAt !== undefined ? new Date(change.endsAt) : undefined,
        entityMetadata: change.location !== undefined ? { location: change.location.slice(0, 100) } : undefined,
        image: change.image ? (change.image.data ?? change.image.path) : undefined,
        status: change.status ? EVENT_STATUS[change.status] : undefined,
        reason,
      });
      return true;
    } catch (error) {
      if (isUnknownEvent(error)) {
        return false;
      }
      throw error;
    }
  }

  async deleteScheduledEvent(eventId: string): Promise<boolean> {
    try {
      await this.guild.scheduledEvents.delete(eventId);
      return true;
    } catch (error) {
      if (isUnknownEvent(error)) {
        return false;
      }
      throw error;
    }
  }
}
