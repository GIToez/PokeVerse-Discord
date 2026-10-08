import type { BridgeClient } from "./bridgeClient.js";
import {
  bridgeConfigResultSchema,
  chatSendResultSchema,
  pokemonResultSchema,
  pokemonSearchResultSchema,
  serverStatusResultSchema,
  trainerResultSchema,
  type BridgeConfigResult,
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
