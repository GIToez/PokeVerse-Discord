import type { APIEmbed } from "discord.js";
import type { OutgoingMessage } from "../../bot/ports.js";
import type { GameApi } from "../../integrations/pokeverse/gameApi.js";
import type { CardPokemon, FoundTrainer } from "../../integrations/pokeverse/protocol.js";
import { formatDuration } from "../../utils/format.js";
import { COLORS, embedMessage, plain, progressBar, sexSymbol } from "../embeds.js";
import type { ArtworkResolver } from "../pokemon/artwork.js";

/** Same rules as character names in the game: letters, spaces, apostrophes and dashes. */
export const TRAINER_NAME_PATTERN = /^[A-Za-z][A-Za-z' -]{1,29}$/;

export function normalizeTrainerName(input: string): string | undefined {
  const name = input.trim().replace(/\s+/g, " ");
  return TRAINER_NAME_PATTERN.test(name) ? name : undefined;
}

/** The vocations' colors and icons, as in the game's vocation window. */
export const VOCATION_STYLES: Record<string, { color: number; icon: string }> = {
  ace: { color: 0xdc2626, icon: "⚔️" },
  catcher: { color: 0xf97316, icon: "🎯" },
  breeder: { color: 0xec4899, icon: "🥚" },
  ranger: { color: 0x16a34a, icon: "🧭" },
  angler: { color: 0x0ea5e9, icon: "🎣" },
  medic: { color: 0x14b8a6, icon: "🩺" },
};

const count = (value: number) => value.toLocaleString("en-US");

function pokemonLine(pokemon: CardPokemon): string {
  return `${pokemon.shiny ? "✨ " : ""}**${plain(pokemon.name)}** Lv ${pokemon.level}${sexSymbol(pokemon.sex)}`;
}

function stars(rank: number, maxRank: number): string {
  return "★".repeat(rank) + "☆".repeat(Math.max(0, maxRank - rank));
}

export function buildTrainerEmbed(trainer: FoundTrainer): APIEmbed {
  const card = trainer.card;
  const hidden = new Set(card?.hidden ?? []);
  const style = card?.vocation ? VOCATION_STYLES[card.vocation.key] : undefined;
  const fields: NonNullable<APIEmbed["fields"]> = [];

  fields.push({ name: "Level", value: `**${trainer.level}**`, inline: true });
  const vocation = card?.vocation
    ? `${style?.icon ?? ""} ${plain(card.vocation.name)}\n${stars(card.vocation.rank, card.vocation.maxRank)} ${plain(card.vocation.title ?? "")}`.trim()
    : plain(trainer.vocation ?? "Trainer");
  fields.push({
    name: "Vocation",
    value: trainer.mastery ? `${vocation}\nMastery: ${plain(trainer.mastery)}` : vocation,
    inline: true,
  });
  fields.push({ name: "Guild", value: trainer.guild ? plain(trainer.guild) : "None", inline: true });

  if (card?.badges && card.badges.length > 0) {
    fields.push({
      name: "Badges",
      value: card.badges
        .map((region) => `${plain(region.region)}\n\`${progressBar(region.earned.length, region.total, region.total)}\` ${region.earned.length} / ${region.total}`)
        .join("\n"),
      inline: true,
    });
  }
  if (hidden.has("stats")) {
    fields.push({ name: "Collection", value: "*Private*", inline: true });
  } else {
    const dex = card?.dex ? [`Pokédex \`${progressBar(card.dex.seen, card.dex.total)}\` ${card.dex.seen} / ${card.dex.total}`] : [];
    fields.push({
      name: "Collection",
      value: [
        ...dex,
        `Caught **${count(trainer.caught)}** · Species **${count(trainer.uniqueCaught)}**`,
        `Shiny caught **${count(trainer.shinyCaught)}**`,
      ].join("\n"),
      inline: true,
    });
  }
  fields.push({
    name: "Battles",
    value: [
      `Duels **${count(trainer.duelWins)}** won · **${count(trainer.duelLosses)}** lost`,
      `Players defeated **${count(trainer.playersDefeated)}**`,
      `Tournaments won **${count(trainer.tournamentsWon)}**`,
    ].join("\n"),
    inline: card?.badges === undefined,
  });

  if (card?.favorite) {
    fields.push({ name: "Favorite", value: pokemonLine(card.favorite), inline: true });
  }
  if (hidden.has("trophies")) {
    fields.push({ name: "Trophies", value: "*Private*", inline: true });
  } else if (card?.trophies && card.trophies.length > 0) {
    fields.push({ name: "Trophies", value: card.trophies.map(pokemonLine).join("\n"), inline: true });
  }

  const achievements = trainer.achievements;
  const recent = achievements.recent.length > 0 ? `\n${achievements.recent.map((name) => `🏅 ${plain(name)}`).join("\n")}` : "";
  fields.push({
    name: "Achievements",
    value: `\`${progressBar(achievements.earned, achievements.total)}\` ${achievements.earned} / ${achievements.total}${recent}`,
    inline: false,
  });

  const description = [
    card ? `***${plain(card.title)}***` : undefined,
    card?.about ? card.about.split("\n").map((line) => `> ${plain(line)}`).join("\n") : undefined,
  ].filter(Boolean).join("\n");
  const footer = [
    card?.playTime !== undefined ? `Played ${formatDuration(card.playTime)}` : undefined,
    card?.since ? "Trainer since" : undefined,
  ].filter(Boolean).join(" · ");

  return {
    author: { name: `Trainer Card · ${trainer.online ? "🟢 Online" : "⚫ Offline"}` },
    title: plain(trainer.name),
    description: description || undefined,
    color: style?.color ?? (trainer.online ? COLORS.success : COLORS.neutral),
    fields,
    footer: footer ? { text: footer } : undefined,
    timestamp: card?.since ? new Date(card.since * 1000).toISOString() : undefined,
  };
}

export type TrainerLookupResult =
  | { kind: "found"; message: OutgoingMessage }
  | { kind: "invalid_name" }
  | { kind: "not_found"; name: string };

export async function lookupTrainer(game: GameApi, artwork: ArtworkResolver, input: string): Promise<TrainerLookupResult> {
  const name = normalizeTrainerName(input);
  if (!name) {
    return { kind: "invalid_name" };
  }
  const result = await game.lookupTrainer(name);
  if (!result.found) {
    return { kind: "not_found", name };
  }
  return { kind: "found", message: embedMessage(buildTrainerEmbed(result), artwork.resolve(result.card?.favorite?.number)) };
}
