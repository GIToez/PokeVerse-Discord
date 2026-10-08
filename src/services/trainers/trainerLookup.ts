import type { APIEmbed } from "discord.js";
import type { OutgoingMessage } from "../../bot/ports.js";
import type { GameApi } from "../../integrations/pokeverse/gameApi.js";
import type { FoundTrainer } from "../../integrations/pokeverse/protocol.js";
import { COLORS, plain } from "../embeds.js";

/** Same rules as character names in the game: letters, spaces, apostrophes and dashes. */
export const TRAINER_NAME_PATTERN = /^[A-Za-z][A-Za-z' -]{1,29}$/;

export function normalizeTrainerName(input: string): string | undefined {
  const name = input.trim().replace(/\s+/g, " ");
  return TRAINER_NAME_PATTERN.test(name) ? name : undefined;
}

export function buildTrainerEmbed(trainer: FoundTrainer): APIEmbed {
  const fields: NonNullable<APIEmbed["fields"]> = [
    { name: "Level", value: String(trainer.level), inline: true },
    { name: "Status", value: trainer.online ? "Online" : "Offline", inline: true },
  ];
  if (trainer.vocation) {
    fields.push({ name: "Vocation", value: plain(trainer.vocation), inline: true });
  }
  fields.push({ name: "Guild", value: trainer.guild ? plain(trainer.guild) : "None", inline: true });
  fields.push({
    name: "Collection",
    value: [
      `Caught: **${trainer.caught}**`,
      `Unique species: **${trainer.uniqueCaught}**`,
      `Shiny caught: **${trainer.shinyCaught}**`,
    ].join("\n"),
    inline: true,
  });
  fields.push({
    name: "PvP",
    value: [
      `Duels won: **${trainer.duelWins}**`,
      `Duels lost: **${trainer.duelLosses}**`,
      `Players defeated: **${trainer.playersDefeated}**`,
      `Tournaments won: **${trainer.tournamentsWon}**`,
    ].join("\n"),
    inline: true,
  });
  const achievements = trainer.achievements;
  const recent = achievements.recent.length > 0 ? `\n${achievements.recent.map((name) => `- ${plain(name)}`).join("\n")}` : "";
  fields.push({
    name: "Achievements",
    value: `${achievements.earned} / ${achievements.total}${recent}`,
    inline: false,
  });
  return {
    title: `Trainer ${plain(trainer.name)}`,
    color: trainer.online ? COLORS.success : COLORS.neutral,
    fields,
  };
}

export type TrainerLookupResult =
  | { kind: "found"; message: OutgoingMessage }
  | { kind: "invalid_name" }
  | { kind: "not_found"; name: string };

export async function lookupTrainer(game: GameApi, input: string): Promise<TrainerLookupResult> {
  const name = normalizeTrainerName(input);
  if (!name) {
    return { kind: "invalid_name" };
  }
  const result = await game.lookupTrainer(name);
  if (!result.found) {
    return { kind: "not_found", name };
  }
  return { kind: "found", message: { embeds: [buildTrainerEmbed(result)] } };
}
