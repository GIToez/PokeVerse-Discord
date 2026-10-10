import type { BridgeClient } from "./bridgeClient.js";
import {
  adminSessionsResultSchema,
  bridgeConfigResultSchema,
  chatSendResultSchema,
  linkAccountResultSchema,
  linkCharactersResultSchema,
  linkListResultSchema,
  linkSummarySchema,
  pokemonResultSchema,
  pokemonSearchResultSchema,
  serverStatusResultSchema,
  trainerResultSchema,
  unlinkResultSchema,
  type AdminSessionsResult,
  type BridgeConfigResult,
  type LinkAccountResult,
  type LinkCharactersResult,
  type LinkListResult,
  type LinkSummary,
  type PokemonResult,
  type ServerStatusResult,
  type TrainerResult,
} from "./protocol.js";

/** Read-only game lookups plus chat delivery, all through the authenticated bridge. */
export interface GameApi {
  readonly connected: boolean;
  lookupTrainer(name: string): Promise<TrainerResult>;
  lookupPokemon(name: string): Promise<PokemonResult>;
  searchPokemon(query: string, limit: number): Promise<string[]>;
  serverStatus(): Promise<ServerStatusResult>;
  sendChat(author: string, text: string): Promise<{ delivered: number; text: string }>;
  bridgeConfig(): Promise<BridgeConfigResult>;
}

/**
 * Account linking requests. Each one acts for exactly one Discord user: the user who ran
 * the command, or the target of an admin-only command.
 */
export interface LinkApi {
  readonly connected: boolean;
  hasFeature(feature: string): boolean;
  redeem(discordUserId: string, code: string): Promise<LinkSummary>;
  account(discordUserId: string): Promise<LinkAccountResult>;
  characters(discordUserId: string): Promise<LinkCharactersResult>;
  setMain(discordUserId: string, character: string): Promise<LinkSummary>;
  unlink(discordUserId: string): Promise<{ unlinked: boolean }>;
  list(offset: number, limit: number): Promise<LinkListResult>;
}

export interface AdminApi {
  readonly connected: boolean;
  sessions(): Promise<AdminSessionsResult>;
}

export function createGameApi(client: BridgeClient): GameApi {
  return {
    get connected() {
      return client.connected;
    },
    lookupTrainer: (name) => client.request("trainer.lookup", { name }, trainerResultSchema),
    lookupPokemon: (name) => client.request("pokemon.lookup", { name }, pokemonResultSchema),
    searchPokemon: async (query, limit) =>
      (await client.request("pokemon.search", { query, limit }, pokemonSearchResultSchema)).names,
    serverStatus: () => client.request("server.status", {}, serverStatusResultSchema),
    sendChat: (author, text) => client.request("chat.send", { author, text }, chatSendResultSchema),
    bridgeConfig: () => client.request("bridge.config", {}, bridgeConfigResultSchema),
  };
}

export function createLinkApi(client: BridgeClient): LinkApi {
  return {
    get connected() {
      return client.connected;
    },
    hasFeature: (feature) => client.hasFeature(feature),
    redeem: (discordUserId, code) => client.request("link.redeem", { discordUserId, code }, linkSummarySchema),
    account: (discordUserId) => client.request("link.account", { discordUserId }, linkAccountResultSchema),
    characters: (discordUserId) => client.request("link.characters", { discordUserId }, linkCharactersResultSchema),
    setMain: (discordUserId, character) => client.request("link.setMain", { discordUserId, character }, linkSummarySchema),
    unlink: (discordUserId) => client.request("link.unlink", { discordUserId }, unlinkResultSchema),
    list: (offset, limit) => client.request("link.list", { offset, limit }, linkListResultSchema),
  };
}

export function createAdminApi(client: BridgeClient): AdminApi {
  return {
    get connected() {
      return client.connected;
    },
    sessions: () => client.request("admin.sessions", {}, adminSessionsResultSchema),
  };
}
