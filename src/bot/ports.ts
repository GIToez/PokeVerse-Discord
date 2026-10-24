import type { APIEmbed, PermissionFlagsBits } from "discord.js";
import type { ChannelPurpose } from "../utils/stateStore.js";

/**
 * Narrow interfaces between the services and discord.js. Services only talk to
 * these, so they can be tested without a Discord connection.
 */

export interface OutgoingFile {
  name: string;
  /** A file on disk, or the bytes in `data`. */
  path?: string;
  data?: Buffer;
}

export interface OutgoingMessage {
  content?: string;
  embeds?: APIEmbed[];
  files?: OutgoingFile[];
  /** Hide link previews (used for relayed chat). */
  suppressEmbeds?: boolean;
  /** Buttons (interaction replies only). */
  buttons?: OutgoingButton[];
  /** Users this message may ping; every other mention stays silent. */
  mentionUserIds?: string[];
  /** Roles this message may ping. */
  mentionRoleIds?: string[];
  /** The message may ping @everyone and @here. */
  mentionEveryone?: boolean;
}

export interface OutgoingButton {
  customId: string;
  label: string;
  style: "primary" | "secondary" | "danger";
}

export interface ChannelSink {
  readonly id: string;
  /** Sends a message; mentions are never resolved. Returns the message id. */
  send(message: OutgoingMessage): Promise<string>;
  /** Edits a message sent by the bot. Resolves false if the message no longer exists. */
  edit(messageId: string, message: OutgoingMessage): Promise<boolean>;
  /** Deletes a message sent by the bot. Resolves false if it no longer exists. */
  delete(messageId: string): Promise<boolean>;
  /** Starts a public thread on one of the bot's messages (text channels only). */
  startThread?(messageId: string, name: string): Promise<ThreadSink>;
  /** A thread of this channel, or undefined if it was deleted. */
  thread?(threadId: string): Promise<ThreadSink | undefined>;
}

export interface ThreadSink extends ChannelSink {
  archive(): Promise<void>;
}

export interface ForumTag {
  id: string;
  name: string;
}

export interface ForumTagSpec {
  name: string;
  emoji?: string;
  /** Only members with Manage Threads can apply it. */
  moderated: boolean;
}

export interface ForumPostSpec {
  name: string;
  message: OutgoingMessage;
  tagIds: string[];
}

export interface ForumPostSink extends ThreadSink {
  /** Applies the tags and the name; an archived post is reopened for it and archived again if `archived`. */
  update(change: { tagIds?: string[]; name?: string; archived?: boolean }): Promise<void>;
}

export interface ForumSink {
  readonly id: string;
  /** The forum's tags right now. */
  tags(): ForumTag[];
  createPost(spec: ForumPostSpec): Promise<{ threadId: string; messageId: string }>;
  /** A post of this forum, or undefined if it was deleted. */
  post(threadId: string): Promise<ForumPostSink | undefined>;
}

export interface ChannelDirectory {
  get(purpose: ChannelPurpose): ChannelSink | undefined;
  /** Forum channels (bug and player reports). */
  forum?(purpose: ChannelPurpose): ForumSink | undefined;
}

export type PermissionName = keyof typeof PermissionFlagsBits;

export interface GuildChannelInfo {
  id: string;
  name: string;
  kind: "category" | "text" | "forum" | "other";
  parentId: string | null;
  /** Text and forum channels only. */
  topic?: string | null;
  /** Forum channels only: the names of their tags. */
  tagNames?: string[];
}

export interface PermissionOverwriteSpec {
  id: string;
  type: "role" | "member";
  allow: PermissionName[];
  deny: PermissionName[];
}

/** Who can see a channel right now, computed from roles and permission overwrites. */
export interface ChannelAccess {
  everyoneCanView: boolean;
  /** Roles (other than @everyone) whose members can see the channel. */
  roles: Array<{ id: string; name: string; administrator: boolean; ownBotRole: boolean }>;
  /** Members with a member overwrite that allows ViewChannel. */
  members: string[];
}

export interface RoleInfo {
  id: string;
  name: string;
  /** Managed by an integration (bot roles, boosters); cannot be assigned. */
  managed: boolean;
  /** The bot's highest role is above this role, so the bot can assign it. */
  assignable: boolean;
  administrator: boolean;
  /** Anyone can ping it; other roles only ping with Mention Everyone. */
  mentionable?: boolean;
}

export type ScheduledEventStatus = "scheduled" | "active" | "completed" | "canceled";

/** A Discord scheduled event the bot made for a game calendar event (an external event, "in PokeVerse"). */
export interface ScheduledEventSpec {
  name: string;
  description: string;
  /** Unix milliseconds. */
  startsAt: number;
  endsAt: number;
  location: string;
  image?: OutgoingFile;
}

export interface MemberInfo {
  id: string;
  roleIds: string[];
  nickname: string | null;
  /** The bot can change this member's nickname (not the owner, below the bot's highest role). */
  nicknameManageable: boolean;
  /**
   * Start of the member's current unbroken server boost (ms), null when not boosting. Discord
   * clears it when the last boost is removed or transferred and sets a new time on a new boost.
   */
  premiumSince: number | null;
}

export interface GuildPort {
  readonly id: string;
  readonly name: string;
  readonly everyoneRoleId: string;
  readonly botUserId: string;
  listChannels(): Promise<GuildChannelInfo[]>;
  createCategory(name: string, overwrites: PermissionOverwriteSpec[], reason: string): Promise<GuildChannelInfo>;
  createTextChannel(
    name: string,
    parentId: string,
    topic: string,
    overwrites: PermissionOverwriteSpec[],
    reason: string,
  ): Promise<GuildChannelInfo>;
  createForumChannel(
    name: string,
    parentId: string,
    topic: string,
    tags: ForumTagSpec[],
    overwrites: PermissionOverwriteSpec[],
    reason: string,
  ): Promise<GuildChannelInfo>;
  /** Adds the tags a forum is missing (by name); existing tags are left alone. Returns the names added. */
  addForumTags(channelId: string, tags: ForumTagSpec[], reason: string): Promise<string[]>;
  /** Guild-level permissions of the bot member. */
  botPermissions(): PermissionName[];
  /** Effective permissions of the bot in a channel, or undefined if the channel is unknown. */
  botChannelPermissions(channelId: string): PermissionName[] | undefined;
  setChannelTopic(channelId: string, topic: string, reason: string): Promise<void>;
  /** Adds allows to the bot's own member overwrite on a channel; other overwrites are left alone. */
  allowBotInChannel(channelId: string, permissions: PermissionName[], reason: string): Promise<void>;
  channelAccess(channelId: string): ChannelAccess | undefined;
  listRoles(): Promise<RoleInfo[]>;
  createRole(name: string, reason: string): Promise<RoleInfo>;
  /** Undefined when the user is not a member of the guild. */
  fetchMember(userId: string): Promise<MemberInfo | undefined>;
  addRole(userId: string, roleId: string, reason: string): Promise<void>;
  removeRole(userId: string, roleId: string, reason: string): Promise<void>;
  setNickname(userId: string, nickname: string | null, reason: string): Promise<void>;
  /** Active server boosts (all members together) and the server boost level, 0-3. */
  boosts(): { count: number; level: number };
  /** Returns the event's id. */
  createScheduledEvent(spec: ScheduledEventSpec, reason: string): Promise<string>;
  /** Resolves false when the event no longer exists. A started event only takes a new end, name and description. */
  editScheduledEvent(
    eventId: string,
    change: Partial<ScheduledEventSpec> & { status?: Exclude<ScheduledEventStatus, "scheduled"> },
    reason: string,
  ): Promise<boolean>;
  /** Resolves false when the event no longer exists. */
  deleteScheduledEvent(eventId: string): Promise<boolean>;
}
