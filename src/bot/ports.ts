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
}

export interface ChannelSink {
  readonly id: string;
  /** Sends a message; mentions are never resolved. Returns the message id. */
  send(message: OutgoingMessage): Promise<string>;
  /** Edits a message sent by the bot. Resolves false if the message no longer exists. */
  edit(messageId: string, message: OutgoingMessage): Promise<boolean>;
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
}
