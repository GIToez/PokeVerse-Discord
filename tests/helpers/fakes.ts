import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiscordAPIError, RESTJSONErrorCodes } from "discord.js";
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
  OutgoingMessage,
  PermissionName,
  PermissionOverwriteSpec,
  RoleInfo,
  ScheduledEventSpec,
  ScheduledEventStatus,
  ThreadSink,
} from "../../src/bot/ports.js";
import { loadConfig, type BotConfig } from "../../src/config/load.js";
import type { ChannelSetup, SetupReport } from "../../src/setup/channelSetup.js";
import { BridgeRequestError, BridgeUnavailableError } from "../../src/integrations/pokeverse/bridgeClient.js";
import type { AdminApi, BoosterApi, GameApi, LinkApi } from "../../src/integrations/pokeverse/gameApi.js";
import {
  FEATURES,
  type AdminSessionsResult,
  type BoostLevelResult,
  type BoosterRules,
  type BoosterWeekResult,
  type BridgeConfigResult,
  type GameEvent,
  type GameEventEnvelope,
  type LinkAccountResult,
  type LinkCharactersResult,
  type LinkListResult,
  type LinkSummary,
  type PokemonResult,
  type ServerStatusResult,
  type TrainerResult,
} from "../../src/integrations/pokeverse/protocol.js";
import { StateStore, type ChannelPurpose } from "../../src/utils/stateStore.js";

export const DEV_GUILD = "100000000000000001";
export const PROD_GUILD = "100000000000000999";
export const BOT_USER = "200000000000000001";
export const EVERYONE = DEV_GUILD;

export function tempDir(prefix = "pv-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export const BASE_ENV: Record<string, string> = {
  POKEVERSE_PROFILE: "development",
  DISCORD_TOKEN: "test-token-not-real",
  DISCORD_GUILD_ID: DEV_GUILD,
  BRIDGE_SECRET: "0123456789abcdef0123",
  LOG_LEVEL: "error",
};

export function writeEnv(dir: string, profile: string, values: Record<string, string>): string {
  const file = join(dir, `.env.${profile}`);
  writeFileSync(file, Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n") + "\n");
  return file;
}

/** Loads a real config from a temporary .env.development. */
export function makeConfig(overrides: Record<string, string> = {}, profile = "development"): BotConfig {
  const dir = tempDir();
  writeEnv(dir, profile, { ...BASE_ENV, POKEVERSE_PROFILE: profile, ...overrides });
  return loadConfig({ profile, configDir: dir, env: {} });
}

export function makeStore(config?: BotConfig): StateStore {
  const dir = tempDir();
  return new StateStore(join(dir, "state.json"), config?.profile ?? "development");
}

export interface SentMessage {
  id: string;
  message: OutgoingMessage;
}

export class FakeChannel implements ChannelSink {
  readonly sent: SentMessage[] = [];
  readonly edits: SentMessage[] = [];
  private counter = 0;
  /** Messages that exist in the channel (ids). */
  readonly existing = new Set<string>();
  failNext: unknown[] = [];

  constructor(readonly id: string) {}

  async send(message: OutgoingMessage): Promise<string> {
    const failure = this.failNext.shift();
    if (failure) {
      throw failure;
    }
    const id = `${this.id}-m${++this.counter}`;
    this.sent.push({ id, message });
    this.existing.add(id);
    return id;
  }

  async edit(messageId: string, message: OutgoingMessage): Promise<boolean> {
    if (!this.existing.has(messageId)) {
      return false;
    }
    this.edits.push({ id: messageId, message });
    return true;
  }

  readonly deleted: string[] = [];

  async delete(messageId: string): Promise<boolean> {
    if (!this.existing.delete(messageId)) {
      return false;
    }
    this.deleted.push(messageId);
    return true;
  }

  contents(): string[] {
    return this.sent.map((item) => item.message.content ?? "");
  }

  readonly threads = new Map<string, FakeThread>();
  failThreads = false;

  async startThread(messageId: string, name: string): Promise<ThreadSink> {
    if (this.failThreads || !this.existing.has(messageId)) {
      throw new Error("Missing Permissions");
    }
    const thread = new FakeThread(`${this.id}-t${this.threads.size + 1}`, name, messageId);
    this.threads.set(thread.id, thread);
    return thread;
  }

  async thread(threadId: string): Promise<ThreadSink | undefined> {
    return this.threads.get(threadId);
  }

  thread0(): FakeThread {
    const thread = [...this.threads.values()][0];
    if (!thread) {
      throw new Error(`no thread in ${this.id}`);
    }
    return thread;
  }
}

export class FakeThread extends FakeChannel implements ThreadSink {
  archived = false;

  constructor(id: string, readonly name: string, readonly starterId: string) {
    super(id);
  }

  override async send(message: OutgoingMessage): Promise<string> {
    this.archived = false;
    return super.send(message);
  }

  async archive(): Promise<void> {
    this.archived = true;
  }
}

export class FakePost extends FakeThread implements ForumPostSink {
  tagIds: string[];
  readonly updates: Array<{ tagIds?: string[]; name?: string; archived?: boolean }> = [];

  constructor(id: string, public postName: string, spec: ForumPostSpec) {
    super(id, postName, id);
    this.tagIds = spec.tagIds;
    this.sent.push({ id, message: spec.message });
    this.existing.add(id);
  }

  async update(change: { tagIds?: string[]; name?: string; archived?: boolean }): Promise<void> {
    this.updates.push(change);
    if (change.tagIds !== undefined) {
      this.tagIds = change.tagIds;
    }
    if (change.name !== undefined) {
      this.postName = change.name;
    }
    if (change.archived !== undefined) {
      this.archived = change.archived;
    }
  }
}

export class FakeForum implements ForumSink {
  readonly posts = new Map<string, FakePost>();
  private counter = 0;

  constructor(readonly id: string, readonly forumTags: ForumTag[] = []) {}

  static withTags(id: string, specs: ForumTagSpec[]): FakeForum {
    return new FakeForum(id, specs.map((spec, index) => ({ id: `${id}-tag${index}`, name: spec.name })));
  }

  tags(): ForumTag[] {
    return this.forumTags;
  }

  async createPost(spec: ForumPostSpec): Promise<{ threadId: string; messageId: string }> {
    const id = `${this.id}-p${++this.counter}`;
    this.posts.set(id, new FakePost(id, spec.name, spec));
    return { threadId: id, messageId: id };
  }

  async post(threadId: string): Promise<ForumPostSink | undefined> {
    return this.posts.get(threadId);
  }

  post0(): FakePost {
    const post = [...this.posts.values()][0];
    if (!post) {
      throw new Error(`no post in ${this.id}`);
    }
    return post;
  }

  tagNames(post: FakePost): string[] {
    return post.tagIds.map((id) => this.forumTags.find((tag) => tag.id === id)?.name ?? id);
  }
}

export class FakeChannels implements ChannelDirectory {
  readonly channels = new Map<ChannelPurpose, FakeChannel>();
  readonly forums = new Map<ChannelPurpose, FakeForum>();

  forum(purpose: ChannelPurpose): FakeForum | undefined {
    return this.forums.get(purpose);
  }

  constructor(
    purposes: ChannelPurpose[] = ["gameChat", "catches", "shinySpawns", "legendarySpawns", "announcements", "serverStatus", "botCommands", "playerActivity"],
  ) {
    purposes.forEach((purpose, index) => this.channels.set(purpose, new FakeChannel(`30000000000000000${index}`)));
  }

  get(purpose: ChannelPurpose): FakeChannel | undefined {
    return this.channels.get(purpose);
  }

  channel(purpose: ChannelPurpose): FakeChannel {
    const channel = this.channels.get(purpose);
    if (!channel) {
      throw new Error(`no channel ${purpose}`);
    }
    return channel;
  }
}

export const ALL_PERMISSIONS: PermissionName[] = [
  "ViewChannel",
  "SendMessages",
  "EmbedLinks",
  "AttachFiles",
  "ReadMessageHistory",
  "ManageChannels",
  "CreatePublicThreads",
  "SendMessagesInThreads",
];

export interface CreatedChannel extends GuildChannelInfo {
  topic?: string;
  overwrites: PermissionOverwriteSpec[];
}

export class FakeGuild implements GuildPort {
  readonly id: string;
  readonly name = "Dev Guild";
  readonly everyoneRoleId: string;
  readonly botUserId = BOT_USER;
  readonly channels: CreatedChannel[] = [];
  readonly created: CreatedChannel[] = [];
  permissions: PermissionName[] = [...ALL_PERMISSIONS];
  /** Per-channel permission overrides for the bot. */
  channelPermissions = new Map<string, PermissionName[]>();
  failCreate = false;
  private counter = 0;

  constructor(id = DEV_GUILD) {
    this.id = id;
    this.everyoneRoleId = id;
  }

  add(channel: Omit<CreatedChannel, "overwrites"> & { overwrites?: PermissionOverwriteSpec[] }): CreatedChannel {
    const full = { overwrites: [], ...channel };
    this.channels.push(full);
    return full;
  }

  async listChannels(): Promise<GuildChannelInfo[]> {
    return this.channels.map(({ id, name, kind, parentId, topic, tagNames }) => ({
      id,
      name,
      kind,
      parentId,
      ...(kind === "text" || kind === "forum" ? { topic: topic ?? null } : {}),
      ...(kind === "forum" ? { tagNames: [...(tagNames ?? [])] } : {}),
    }));
  }

  async createForumChannel(
    name: string,
    parentId: string,
    topic: string,
    tags: ForumTagSpec[],
    overwrites: PermissionOverwriteSpec[],
  ): Promise<GuildChannelInfo> {
    const info = this.create({ name, kind: "forum", parentId, topic, overwrites, tagNames: tags.map((tag) => tag.name) });
    return { ...info, tagNames: tags.map((tag) => tag.name) };
  }

  async addForumTags(channelId: string, tags: ForumTagSpec[]): Promise<string[]> {
    const channel = this.channels.find((item) => item.id === channelId)!;
    const names = tags.map((tag) => tag.name);
    channel.tagNames = [...(channel.tagNames ?? []), ...names];
    this.channelUpdates.push(`tags ${channelId} ${names.join(",")}`);
    return names;
  }

  async createCategory(name: string, overwrites: PermissionOverwriteSpec[]): Promise<GuildChannelInfo> {
    return this.create({ name, kind: "category", parentId: null, overwrites });
  }

  async createTextChannel(name: string, parentId: string, topic: string, overwrites: PermissionOverwriteSpec[]): Promise<GuildChannelInfo> {
    return this.create({ name, kind: "text", parentId, topic, overwrites });
  }

  private create(spec: Omit<CreatedChannel, "id">): GuildChannelInfo {
    if (this.failCreate) {
      throw new Error("Missing Permissions");
    }
    const channel: CreatedChannel = { id: `40000000000000${String(++this.counter).padStart(4, "0")}`, ...spec };
    this.channels.push(channel);
    this.created.push(channel);
    return { id: channel.id, name: channel.name, kind: channel.kind, parentId: channel.parentId };
  }

  botPermissions(): PermissionName[] {
    return this.permissions;
  }

  botChannelPermissions(channelId: string): PermissionName[] | undefined {
    if (!this.channels.some((channel) => channel.id === channelId)) {
      return undefined;
    }
    return this.channelPermissions.get(channelId) ?? this.permissions;
  }

  /** Topic and overwrite changes made on existing channels. */
  readonly channelUpdates: string[] = [];

  async setChannelTopic(channelId: string, topic: string): Promise<void> {
    const channel = this.channels.find((item) => item.id === channelId)!;
    channel.topic = topic;
    this.channelUpdates.push(`topic ${channelId}`);
  }

  async allowBotInChannel(channelId: string, permissions: PermissionName[]): Promise<void> {
    const channel = this.channels.find((item) => item.id === channelId)!;
    let own = channel.overwrites.find((item) => item.id === this.botUserId);
    if (!own) {
      own = { id: this.botUserId, type: "member", allow: [], deny: [] };
      channel.overwrites.push(own);
    }
    own.allow = [...new Set([...own.allow, ...permissions])];
    own.deny = own.deny.filter((name) => !permissions.includes(name));
    const granted = this.channelPermissions.get(channelId);
    if (granted) {
      this.channelPermissions.set(channelId, [...new Set([...granted, ...permissions])]);
    }
    this.channelUpdates.push(`allow ${channelId} ${permissions.join(",")}`);
  }

  async allowRoleInChannel(channelId: string, roleId: string, permissions: PermissionName[]): Promise<void> {
    const channel = this.channels.find((item) => item.id === channelId)!;
    let own = channel.overwrites.find((item) => item.id === roleId);
    if (!own) {
      own = { id: roleId, type: "role", allow: [], deny: [] };
      channel.overwrites.push(own);
    }
    own.allow = [...new Set([...own.allow, ...permissions])];
    own.deny = own.deny.filter((name) => !permissions.includes(name));
    this.channelUpdates.push(`allow role ${roleId} ${channelId} ${permissions.join(",")}`);
  }

  /** Roles of the guild (without @everyone). */
  readonly roles: FakeRole[] = [];
  readonly members = new Map<string, FakeMember>();
  /** Overrides the access computed from a channel's overwrites. */
  accessOverride = new Map<string, ChannelAccess>();
  /** Thrown by the next addRole/removeRole/setNickname call. */
  failMemberOps: unknown[] = [];
  failCreateRole = false;
  readonly memberCalls: string[] = [];

  addRoleInfo(role: Partial<FakeRole> & { name: string }): FakeRole {
    const full: FakeRole = { id: `50000000000000${String(++this.counter).padStart(4, "0")}`, managed: false, assignable: true, administrator: false, ...role };
    this.roles.push(full);
    return full;
  }

  addMember(id: string, member: Partial<Omit<FakeMember, "id">> = {}): FakeMember {
    const full: FakeMember = { id, roleIds: [], nickname: null, nicknameManageable: true, premiumSince: null, ...member };
    this.members.set(id, full);
    return full;
  }

  channelAccess(channelId: string): ChannelAccess | undefined {
    const override = this.accessOverride.get(channelId);
    if (override) {
      return override;
    }
    const channel = this.channels.find((item) => item.id === channelId);
    if (!channel) {
      return undefined;
    }
    const everyone = channel.overwrites.find((item) => item.id === this.everyoneRoleId);
    const roles = this.roles
      .filter((role) => role.administrator || channel.overwrites.some((item) => item.id === role.id && item.allow.includes("ViewChannel")))
      .map((role) => ({ id: role.id, name: role.name, administrator: role.administrator, ownBotRole: false }));
    return {
      everyoneCanView: !everyone?.deny.includes("ViewChannel"),
      roles,
      members: channel.overwrites.filter((item) => item.type === "member" && item.allow.includes("ViewChannel")).map((item) => item.id),
    };
  }

  async listRoles(): Promise<RoleInfo[]> {
    return this.roles.map(({ id, name, managed, assignable, administrator, mentionable }) => ({ id, name, managed, assignable, administrator, mentionable }));
  }

  async createRole(name: string): Promise<RoleInfo> {
    if (this.failCreateRole) {
      throw new Error("Missing Permissions");
    }
    const role = this.addRoleInfo({ name });
    return { id: role.id, name: role.name, managed: role.managed, assignable: role.assignable, administrator: role.administrator };
  }

  async fetchMember(userId: string): Promise<MemberInfo | undefined> {
    const member = this.members.get(userId);
    return member ? { ...member, roleIds: [...member.roleIds] } : undefined;
  }

  private memberOp(userId: string, call: string): FakeMember {
    this.memberCalls.push(call);
    const failure = this.failMemberOps.shift();
    if (failure) {
      throw failure;
    }
    const member = this.members.get(userId);
    if (!member) {
      throw new Error("Unknown Member");
    }
    return member;
  }

  async addRole(userId: string, roleId: string): Promise<void> {
    const member = this.memberOp(userId, `add ${userId} ${roleId}`);
    if (!member.roleIds.includes(roleId)) {
      member.roleIds.push(roleId);
    }
  }

  async removeRole(userId: string, roleId: string): Promise<void> {
    const member = this.memberOp(userId, `remove ${userId} ${roleId}`);
    member.roleIds = member.roleIds.filter((id) => id !== roleId);
  }

  async setNickname(userId: string, nickname: string | null): Promise<void> {
    const member = this.memberOp(userId, `nick ${userId} ${nickname ?? "<reset>"}`);
    member.nickname = nickname;
  }

  boostCount = 0;
  boostLevel = 0;

  boosts(): { count: number; level: number } {
    return { count: this.boostCount, level: this.boostLevel };
  }

  /** Scheduled events by id. */
  readonly scheduledEvents = new Map<string, ScheduledEventSpec & { status: ScheduledEventStatus }>();
  readonly eventCalls: string[] = [];
  failEvents: unknown[] = [];

  private eventOp(call: string): void {
    this.eventCalls.push(call);
    const failure = this.failEvents.shift();
    if (failure) {
      throw failure;
    }
  }

  async createScheduledEvent(spec: ScheduledEventSpec): Promise<string> {
    this.eventOp(`create ${spec.name}`);
    const id = `60000000000000${String(++this.counter).padStart(4, "0")}`;
    this.scheduledEvents.set(id, { ...spec, status: "scheduled" });
    return id;
  }

  async editScheduledEvent(
    eventId: string,
    change: Partial<ScheduledEventSpec> & { status?: Exclude<ScheduledEventStatus, "scheduled"> },
  ): Promise<boolean> {
    this.eventOp(`edit ${eventId}${change.status ? ` ${change.status}` : ""}`);
    const event = this.scheduledEvents.get(eventId);
    if (!event) {
      return false;
    }
    const defined = Object.fromEntries(Object.entries(change).filter(([, value]) => value !== undefined));
    Object.assign(event, defined);
    return true;
  }

  async deleteScheduledEvent(eventId: string): Promise<boolean> {
    this.eventOp(`delete ${eventId}`);
    return this.scheduledEvents.delete(eventId);
  }
}

export type FakeRole = RoleInfo;

export type FakeMember = MemberInfo;

/** A DiscordAPIError with code 50013 (Missing Permissions). */
export function missingPermissionsError(): DiscordAPIError {
  return new DiscordAPIError(
    { code: RESTJSONErrorCodes.MissingPermissions, message: "Missing Permissions" },
    RESTJSONErrorCodes.MissingPermissions,
    403,
    "PUT",
    "https://discord.com/api/v10/test",
    {},
  );
}

export const LINKED_USER = "123456789012345678";

export function linkSummary(overrides: Partial<LinkSummary> = {}): LinkSummary {
  return {
    linked: true,
    discordUserId: LINKED_USER,
    linkedAt: 1_700_000_000,
    characterCount: 2,
    main: { name: "Red Trainer", level: 25, vocation: "Trainer" },
    mainChanged: false,
    premium: false,
    premiumUnlimited: false,
    ...overrides,
  };
}

interface FakeAccount {
  link: LinkSummary;
  characters: Array<{ name: string; level: number; vocation: string | null; online: boolean }>;
}

/** Game-side account links, with the same rules and error codes as 058-discordAccounts.lua. */
export class FakeLinkApi implements LinkApi {
  connected = true;
  features = new Set<string>([FEATURES.accountLinking, FEATURES.playerSessions]);
  readonly calls: string[] = [];
  /** Valid codes (normalized) and the account they belong to. */
  readonly codes = new Map<string, FakeAccount>();
  readonly accounts = new Map<string, FakeAccount>();
  /** Error codes thrown by the next requests. */
  failNext: string[] = [];

  hasFeature(feature: string): boolean {
    return this.connected && this.features.has(feature);
  }

  private guard(name: string): void {
    this.calls.push(name);
    if (!this.connected) {
      throw new BridgeUnavailableError();
    }
    const failure = this.failNext.shift();
    if (failure) {
      throw new BridgeRequestError(failure, failure);
    }
  }

  addCode(code: string, account: Partial<FakeAccount> = {}): FakeAccount {
    const full: FakeAccount = {
      link: account.link ?? linkSummary(),
      characters: account.characters ?? [
        { name: "Red Trainer", level: 25, vocation: "Trainer", online: false },
        { name: "Blue Trainer", level: 10, vocation: null, online: true },
      ],
    };
    this.codes.set(code.replace(/[\s-]/g, "").toUpperCase(), full);
    return full;
  }

  link(discordUserId: string, account: Partial<FakeAccount> = {}): FakeAccount {
    const full = this.addCode(`LINK${discordUserId}`, account);
    full.link = { ...full.link, discordUserId };
    this.codes.delete(`LINK${discordUserId}`);
    this.accounts.set(discordUserId, full);
    return full;
  }

  async redeem(discordUserId: string, code: string): Promise<LinkSummary> {
    this.guard("link.redeem");
    if (this.accounts.has(discordUserId)) {
      throw new BridgeRequestError("already_linked", "already linked");
    }
    const key = code.replace(/[\s-]/g, "").toUpperCase();
    const account = this.codes.get(key);
    if (!account) {
      throw new BridgeRequestError("invalid_code", "invalid code");
    }
    this.codes.delete(key);
    account.link = { ...account.link, discordUserId };
    this.accounts.set(discordUserId, account);
    return account.link;
  }

  async account(discordUserId: string): Promise<LinkAccountResult> {
    this.guard("link.account");
    return this.accounts.get(discordUserId)?.link ?? { linked: false };
  }

  async characters(discordUserId: string): Promise<LinkCharactersResult> {
    this.guard("link.characters");
    const account = this.accounts.get(discordUserId);
    if (!account) {
      return { linked: false };
    }
    return {
      linked: true,
      characters: account.characters.map((character) => ({ ...character, main: character.name === account.link.main?.name })),
    };
  }

  async setMain(discordUserId: string, character: string): Promise<LinkSummary> {
    this.guard("link.setMain");
    const account = this.accounts.get(discordUserId);
    if (!account) {
      throw new BridgeRequestError("not_linked", "not linked");
    }
    const found = account.characters.find((item) => item.name.toLowerCase() === character.toLowerCase());
    if (!found) {
      throw new BridgeRequestError("not_owned", "not owned");
    }
    account.link = { ...account.link, main: { name: found.name, level: found.level, vocation: found.vocation } };
    return account.link;
  }

  async unlink(discordUserId: string): Promise<{ unlinked: boolean }> {
    this.guard("link.unlink");
    return { unlinked: this.accounts.delete(discordUserId) };
  }

  async list(offset: number, limit: number): Promise<LinkListResult> {
    this.guard("link.list");
    const links = [...this.accounts.values()].map((account) => account.link);
    const page = links.slice(offset, offset + limit);
    return offset + limit < links.length ? { links: page, nextOffset: offset + limit } : { links: page };
  }
}

export class FakeAdminApi implements AdminApi {
  connected = true;
  sessionsResult: AdminSessionsResult = { sessions: [], playersOnline: 0 };
  calls = 0;

  async sessions(): Promise<AdminSessionsResult> {
    this.calls++;
    if (!this.connected) {
      throw new BridgeUnavailableError();
    }
    return this.sessionsResult;
  }
}

/**
 * Runs channel setup (as /pokeverse setup does) on a fake guild and gives the created
 * channels the ids of the in-memory channels, so privacy checks see the real overwrites.
 */
export async function setUpGuild(setup: ChannelSetup, guild: FakeGuild, channels: FakeChannels): Promise<SetupReport> {
  const report = await setup.run(guild);
  for (const item of report.channels) {
    const sink = channels.get(item.purpose);
    const created = guild.channels.find((channel) => channel.id === item.channelId);
    if (sink && created) {
      created.id = sink.id;
    }
  }
  return report;
}

export const RATTATA: Extract<PokemonResult, { found: true }> = {
  found: true,
  name: "Rattata",
  baseSpecies: "Rattata",
  dexNumber: 19,
  generation: 1,
  types: ["normal"],
  stats: { attack: 56, defense: 35, specialAttack: 25, specialDefense: 35, health: 30, energy: null },
  description: "Bites anything when it attacks.",
  evolutions: [{ from: "Rattata", to: "Raticate", level: 20, items: false }],
  moves: [{ name: "Quick Attack", level: 1 }],
  abilities: ["Run Away"],
  specialAbilities: [],
  shiny: false,
  legendary: false,
  catchable: true,
  shinyVariant: "Shiny Rattata",
};

export const TRAINER: Extract<TrainerResult, { found: true }> = {
  found: true,
  name: "Red Trainer",
  level: 25,
  vocation: "Trainer",
  guild: null,
  online: true,
  caught: 12,
  uniqueCaught: 9,
  shinyCaught: 1,
  duelWins: 3,
  duelLosses: 2,
  playersDefeated: 4,
  tournamentsWon: 0,
  achievements: { earned: 2, total: 40, recent: ["First Catch", "Explorer"] },
};

export class FakeGame implements GameApi {
  connected = true;
  readonly chats: Array<{ author: string; text: string }> = [];
  readonly calls: string[] = [];
  trainers = new Map<string, TrainerResult>([["red trainer", TRAINER]]);
  pokemon = new Map<string, PokemonResult>([["rattata", RATTATA]]);
  species = ["Rattata", "Raticate", "Raichu", "Bulbasaur", "Charmander"];
  status: ServerStatusResult = { serverName: "PokeVerse", state: "normal", playersOnline: 3, maxPlayers: 1000, uptime: 3600, bootId: "boot1" };

  private guard(name: string): void {
    this.calls.push(name);
    if (!this.connected) {
      throw new BridgeUnavailableError();
    }
  }

  async lookupTrainer(name: string): Promise<TrainerResult> {
    this.guard("trainer.lookup");
    return this.trainers.get(name.toLowerCase()) ?? { found: false };
  }

  async lookupPokemon(name: string): Promise<PokemonResult> {
    this.guard("pokemon.lookup");
    return this.pokemon.get(name.toLowerCase()) ?? { found: false };
  }

  async searchPokemon(query: string, limit: number): Promise<string[]> {
    this.guard("pokemon.search");
    const q = query.toLowerCase();
    return this.species.filter((name) => name.toLowerCase().startsWith(q)).slice(0, limit);
  }

  async serverStatus(): Promise<ServerStatusResult> {
    this.guard("server.status");
    return this.status;
  }

  async sendChat(author: string, text: string): Promise<{ delivered: number; text: string }> {
    this.guard("chat.send");
    this.chats.push({ author, text });
    return { delivered: 1, text };
  }

  async bridgeConfig(): Promise<BridgeConfigResult> {
    this.guard("bridge.config");
    return { chatChannelId: 7, chatAuthorPrefix: "[Discord] ", chatTextMaxLength: 255, chatAuthorMaxLength: 24, legendary: [] };
  }
}

let sequence = 0;

export function envelope<E extends GameEvent>(event: E, options: { time?: number; bootId?: string; id?: string } = {}): GameEventEnvelope<E> {
  const bootId = options.bootId ?? "boot1";
  return {
    id: options.id ?? `${bootId}-${++sequence}`,
    time: options.time ?? Math.floor(Date.now() / 1000),
    bootId,
    event,
  };
}

/**
 * The game's booster rewards with the rules the game enforces: amounts from its own settings,
 * one payment per (Discord user, boost start, week), no week before it is due, no week
 * completed before the link, no outdated streak.
 */
export class FakeBoosterApi implements BoosterApi {
  connected = true;
  features = new Set<string>([FEATURES.boosterRewards, FEATURES.boostPerks]);
  rulesValue: BoosterRules = {
    weekly: 1, loyaltyEvery: 4, loyalty: 1, yearlyEvery: 52, yearly: 15, communityEvery: 5, communityMax: 5,
    perks: [{ level: 1, text: "+5% experience" }, { level: 2, text: "+5% catch rate" }, { level: 3, text: "+10% shiny spawn rate" }],
  };
  /** Levels sent with boost.level, in order. */
  readonly levels: Array<{ level: number; boosts: number }> = [];
  /** Paid weeks by `${user}:${boostSince}:${week}`, with the time they were paid (unix seconds). */
  readonly ledger = new Map<string, BoosterWeekResult & { user: string; boostSince: number; paidAt: number }>();
  readonly calls: string[] = [];
  /** Discord user -> linked_at (unix seconds); users missing here are not linked. */
  readonly linkedAt = new Map<string, number>();
  failNext: string[] = [];

  constructor(private readonly now: () => number) {}

  hasFeature(feature: string): boolean {
    return this.connected && this.features.has(feature);
  }

  private guard(name: string): void {
    this.calls.push(name);
    if (!this.connected) {
      throw new BridgeUnavailableError();
    }
    const failure = this.failNext.shift();
    if (failure) {
      throw new BridgeRequestError(failure, failure);
    }
  }

  async rules(): Promise<BoosterRules> {
    this.guard("booster.rules");
    return this.rulesValue;
  }

  async level(level: number, boosts: number): Promise<BoostLevelResult> {
    this.guard("boost.level");
    this.levels.push({ level, boosts });
    return { level, perks: this.rulesValue.perks.filter((perk) => perk.level <= level).map((perk) => perk.text) };
  }

  async week(discordUserId: string, boostSince: number, week: number, serverBoosts = 0): Promise<BoosterWeekResult> {
    this.guard(`booster.week ${discordUserId} ${week}`);
    const now = Math.floor(this.now() / 1000);
    const linkedAt = this.linkedAt.get(discordUserId);
    if (linkedAt === undefined) {
      throw new BridgeRequestError("not_linked", "not linked");
    }
    const paid = this.ledger.get(`${discordUserId}:${boostSince}:${week}`);
    if (paid) {
      const { user: _user, boostSince: _since, paidAt: _at, ...result } = paid;
      return { ...result, deposited: false };
    }
    const due = boostSince + week * 7 * 86_400;
    if (due > now + 300) {
      throw new BridgeRequestError("not_due", "not due");
    }
    if (due < linkedAt) {
      throw new BridgeRequestError("before_link", "before link");
    }
    const last = [...this.ledger.values()].filter((item) => item.user === discordUserId).sort((a, b) => b.paidAt - a.paidAt)[0];
    if (last && last.boostSince !== boostSince && (boostSince < last.boostSince || boostSince < last.paidAt)) {
      throw new BridgeRequestError("stale_streak", "stale streak");
    }
    const rules = this.rulesValue;
    const loyalty = rules.loyaltyEvery > 0 && week % rules.loyaltyEvery === 0 ? rules.loyalty : 0;
    const yearly = rules.yearlyEvery > 0 && week % rules.yearlyEvery === 0 ? rules.yearly : 0;
    const community = rules.loyaltyEvery > 0 && week % rules.loyaltyEvery === 0 && rules.communityEvery > 0
      ? Math.min(rules.communityMax, Math.floor(serverBoosts / rules.communityEvery))
      : 0;
    const result = { deposited: true, week, weekly: rules.weekly, loyalty, yearly, community, total: rules.weekly + loyalty + yearly + community };
    this.ledger.set(`${discordUserId}:${boostSince}:${week}`, { ...result, user: discordUserId, boostSince, paidAt: now });
    return result;
  }

  /** Soul Coins deposited for a Discord user. */
  deposited(discordUserId: string): number {
    return [...this.ledger.values()].filter((item) => item.user === discordUserId).reduce((sum, item) => sum + item.total, 0);
  }
}
