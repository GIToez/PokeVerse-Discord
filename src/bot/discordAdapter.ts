import type {
  PermissionsBitField} from "discord.js";
import {
  AttachmentBuilder,
  ChannelType,
  DiscordAPIError,
  MessageFlags,
  OverwriteType,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  type Client,
  type Guild,
  type GuildBasedChannel,
  type MessageCreateOptions,
  type MessageEditOptions,
  type TextChannel,
} from "discord.js";
import type { StateStore } from "../utils/stateStore.js";
import type { ChannelPurpose } from "../utils/stateStore.js";
import type {
  ChannelDirectory,
  ChannelSink,
  GuildChannelInfo,
  GuildPort,
  OutgoingMessage,
  PermissionName,
  PermissionOverwriteSpec,
} from "./ports.js";

function toBits(names: PermissionName[]): bigint {
  return names.reduce((bits, name) => bits | PermissionFlagsBits[name], 0n);
}

function toNames(bits: Readonly<PermissionsBitField> | null | undefined): PermissionName[] {
  return bits ? (bits.toArray() as PermissionName[]) : [];
}

function toInfo(channel: GuildBasedChannel): GuildChannelInfo {
  const kind = channel.type === ChannelType.GuildCategory ? "category" : channel.type === ChannelType.GuildText ? "text" : "other";
  return { id: channel.id, name: channel.name, kind, parentId: channel.parentId ?? null };
}

function overwrites(specs: PermissionOverwriteSpec[]) {
  return specs.map((spec) => ({
    id: spec.id,
    type: spec.type === "role" ? OverwriteType.Role : OverwriteType.Member,
    allow: toBits(spec.allow),
    deny: toBits(spec.deny),
  }));
}

function toCreateOptions(message: OutgoingMessage): MessageCreateOptions {
  return {
    content: message.content,
    embeds: message.embeds,
    files: message.files?.map((file) => new AttachmentBuilder(file.path, { name: file.name })),
    allowedMentions: { parse: [] },
    flags: message.suppressEmbeds ? MessageFlags.SuppressEmbeds : undefined,
  };
}

function toEditOptions(message: OutgoingMessage): MessageEditOptions {
  return {
    content: message.content ?? null,
    embeds: message.embeds ?? [],
    files: message.files?.map((file) => new AttachmentBuilder(file.path, { name: file.name })),
    attachments: message.files ? undefined : [],
    allowedMentions: { parse: [] },
  };
}

export class TextChannelSink implements ChannelSink {
  constructor(private readonly channel: TextChannel) {}

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

  botPermissions(): PermissionName[] {
    return toNames(this.guild.members.me?.permissions);
  }

  botChannelPermissions(channelId: string): PermissionName[] | undefined {
    const channel = this.guild.channels.cache.get(channelId);
    const me = this.guild.members.me;
    if (!channel || !me) {
      return undefined;
    }
    return toNames(channel.permissionsFor(me));
  }
}
