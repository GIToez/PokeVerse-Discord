import type { APIEmbed } from "discord.js";
import type { OutgoingMessage } from "../../bot/ports.js";
import type { GameApi } from "../../integrations/pokeverse/gameApi.js";
import type { FoundPokemon } from "../../integrations/pokeverse/protocol.js";
import { padDex, truncate } from "../../utils/format.js";
import { COLORS, embedMessage, plain } from "../embeds.js";
import type { ArtworkResolver } from "./artwork.js";

export function normalizePokemonQuery(input: string): string | undefined {
  const name = input.trim().replace(/\s+/g, " ");
  return name.length >= 1 && name.length <= 40 && /^[\p{L}\p{N} .'\-:♀♂]+$/u.test(name) ? name : undefined;
}

function statLine(label: string, value: number | null | undefined): string | undefined {
  return value === null || value === undefined ? undefined : `${label}: **${value}**`;
}

function list(items: string[], max: number): string {
  if (items.length === 0) {
    return "None";
  }
  const shown = items.slice(0, max).map(plain).join(", ");
  return items.length > max ? `${shown} and ${items.length - max} more` : shown;
}

export function buildPokemonEmbed(pokemon: FoundPokemon): APIEmbed {
  const fields: NonNullable<APIEmbed["fields"]> = [];
  if (pokemon.types.length > 0) {
    fields.push({ name: "Type", value: pokemon.types.map(plain).join(" / "), inline: true });
  }
  if (pokemon.generation) {
    fields.push({ name: "Generation", value: String(pokemon.generation), inline: true });
  }
  const tags = [
    pokemon.legendary ? "Legendary" : undefined,
    pokemon.shiny ? "Shiny" : undefined,
    pokemon.catchable ? "Catchable" : "Not catchable",
  ].filter((tag): tag is string => tag !== undefined);
  fields.push({ name: "Tags", value: tags.join(", "), inline: true });

  const stats = [
    statLine("HP", pokemon.stats.health),
    statLine("Energy", pokemon.stats.energy),
    statLine("Attack", pokemon.stats.attack),
    statLine("Defense", pokemon.stats.defense),
    statLine("Sp. Attack", pokemon.stats.specialAttack),
    statLine("Sp. Defense", pokemon.stats.specialDefense),
  ].filter((line): line is string => line !== undefined);
  if (stats.length > 0) {
    fields.push({ name: "Base stats", value: stats.join("\n"), inline: true });
  }

  if (pokemon.evolutions.length > 0) {
    const lines = pokemon.evolutions.slice(0, 8).map((evolution) => {
      const requirement = [
        evolution.level ? `level ${evolution.level}` : undefined,
        evolution.items ? "items" : undefined,
      ].filter(Boolean).join(", ");
      return `${plain(evolution.from)} -> ${plain(evolution.to)}${requirement ? ` (${requirement})` : ""}`;
    });
    fields.push({ name: "Evolutions", value: lines.join("\n"), inline: true });
  }
  if (pokemon.abilities.length > 0) {
    fields.push({ name: "Abilities", value: list(pokemon.abilities, 10), inline: false });
  }
  if (pokemon.specialAbilities.length > 0) {
    fields.push({ name: "Field abilities", value: list(pokemon.specialAbilities, 10), inline: false });
  }
  if (pokemon.moves.length > 0) {
    const moves = pokemon.moves.map((move) => (move.level ? `${move.name} (${move.level})` : move.name));
    fields.push({ name: "Moves", value: truncate(list(moves, 12), 1024), inline: false });
  }
  if (pokemon.shinyVariant) {
    fields.push({ name: "Shiny variant", value: plain(pokemon.shinyVariant), inline: true });
  }

  return {
    title: pokemon.dexNumber ? `#${padDex(pokemon.dexNumber)} ${plain(pokemon.name)}` : plain(pokemon.name),
    description: pokemon.description ? truncate(plain(pokemon.description), 1000) : undefined,
    color: pokemon.legendary ? COLORS.legendary : pokemon.shiny ? COLORS.shiny : COLORS.info,
    fields,
  };
}

export type PokemonLookupResult =
  | { kind: "found"; message: OutgoingMessage }
  | { kind: "invalid_name" }
  | { kind: "not_found"; name: string; suggestions: string[] };

export async function lookupPokemon(game: GameApi, artwork: ArtworkResolver, input: string): Promise<PokemonLookupResult> {
  const name = normalizePokemonQuery(input);
  if (!name) {
    return { kind: "invalid_name" };
  }
  const result = await game.lookupPokemon(name);
  if (!result.found) {
    const suggestions = await game.searchPokemon(name.slice(0, 3), 5).catch(() => []);
    return { kind: "not_found", name, suggestions };
  }
  return {
    kind: "found",
    message: embedMessage(buildPokemonEmbed(result), artwork.resolve(result.dexNumber), "thumbnail"),
  };
}

/** Short-lived cache for autocomplete so typing does not flood the game with requests. */
export class PokemonAutocomplete {
  private readonly cache = new Map<string, { names: string[]; expires: number }>();

  constructor(
    private readonly game: GameApi,
    private readonly ttlMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  async suggest(input: string): Promise<string[]> {
    if (!this.game.connected) {
      return [];
    }
    const query = input.trim().toLowerCase().slice(0, 40);
    const cached = this.cache.get(query);
    if (cached && cached.expires > this.now()) {
      return cached.names;
    }
    const names = (await this.game.searchPokemon(query, 25)).slice(0, 25);
    if (this.cache.size > 500) {
      this.cache.clear();
    }
    this.cache.set(query, { names, expires: this.now() + this.ttlMs });
    return names;
  }
}
