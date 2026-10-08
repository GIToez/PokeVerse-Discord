import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ChannelDirectory,
  ChannelSink,
  GuildChannelInfo,
  GuildPort,
  OutgoingMessage,
  PermissionName,
  PermissionOverwriteSpec,
} from "../../src/bot/ports.js";
import { loadConfig, type BotConfig } from "../../src/config/load.js";
import { BridgeUnavailableError } from "../../src/integrations/pokeverse/bridgeClient.js";
import type { GameApi } from "../../src/integrations/pokeverse/gameApi.js";
import type {
  BridgeConfigResult,
  GameEvent,
  GameEventEnvelope,
  PokemonResult,
  ServerStatusResult,
  TrainerResult,
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

  contents(): string[] {
    return this.sent.map((item) => item.message.content ?? "");
  }
}

export class FakeChannels implements ChannelDirectory {
  readonly channels = new Map<ChannelPurpose, FakeChannel>();

  constructor(purposes: ChannelPurpose[] = ["gameChat", "catches", "shinySpawns", "legendarySpawns", "announcements", "serverStatus", "botCommands"]) {
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
    return this.channels.map(({ id, name, kind, parentId }) => ({ id, name, kind, parentId }));
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
