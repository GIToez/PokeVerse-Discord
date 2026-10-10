import type { APIEmbed, PermissionFlagsBits } from "discord.js";
import type { ChannelPurpose } from "../utils/stateStore.js";

/**
 * Narrow interfaces between the services and discord.js. Services only talk to
 * these, so they can be tested without a Discord connection.
 */

export interface OutgoingFile {
  name: string;
  path: string;
}

export interface OutgoingMessage {
  content?: string;
  embeds?: APIEmbed[];
  files?: OutgoingFile[];
  /** Hide link previews (used for relayed chat). */
  suppressEmbeds?: boolean;
  /** Buttons (interaction replies only). */
  buttons?: OutgoingButton[];
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
}

export interface ChannelDirectory {
  get(purpose: ChannelPurpose): ChannelSink | undefined;
}

export type PermissionName = keyof typeof PermissionFlagsBits;

export interface GuildChannelInfo {
  id: string;
  name: string;
  kind: "category" | "text" | "other";
  parentId: string | null;
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
}

export interface MemberInfo {
  id: string;
  roleIds: string[];
  nickname: string | null;
  /** The bot can change this member's nickname (not the owner, below the bot's highest role). */
  nicknameManageable: boolean;
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
  /** Guild-level permissions of the bot member. */
  botPermissions(): PermissionName[];
  /** Effective permissions of the bot in a channel, or undefined if the channel is unknown. */
  botChannelPermissions(channelId: string): PermissionName[] | undefined;
  channelAccess(channelId: string): ChannelAccess | undefined;
  listRoles(): Promise<RoleInfo[]>;
  createRole(name: string, reason: string): Promise<RoleInfo>;
  /** Undefined when the user is not a member of the guild. */
  fetchMember(userId: string): Promise<MemberInfo | undefined>;
  addRole(userId: string, roleId: string, reason: string): Promise<void>;
  removeRole(userId: string, roleId: string, reason: string): Promise<void>;
  setNickname(userId: string, nickname: string | null, reason: string): Promise<void>;
}
