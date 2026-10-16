import type { APIEmbed } from "discord.js";
import type { OutgoingFile, OutgoingMessage } from "../bot/ports.js";

export const COLORS = {
  info: 0x3b82f6,
  success: 0x22c55e,
  warning: 0xf59e0b,
  danger: 0xef4444,
  shiny: 0xfacc15,
  legendary: 0xa855f7,
  neutral: 0x64748b,
} as const;

/** Game strings are plain text; keep Discord from interpreting them as markdown. */
export function plain(text: string): string {
  return text.replace(/([\\*_~`|>[\]])/g, "\\$1").replace(/@(everyone|here)/gi, "@\u200b$1");
}

export function capitalizeWords(text: string): string {
  return text.replace(/\b([a-z])/g, (letter) => letter.toUpperCase());
}

/** Message with an embed and an optional artwork thumbnail attachment. */
export function embedMessage(embed: APIEmbed, artwork?: OutgoingFile, placement: "thumbnail" | "image" = "thumbnail"): OutgoingMessage {
  if (!artwork) {
    return { embeds: [embed] };
  }
  return {
    embeds: [{ ...embed, [placement]: { url: `attachment://${artwork.name}` } }],
    files: [artwork],
  };
}

/** The games' type colors, for embeds about one Pokemon. */
export const TYPE_COLORS: Record<string, number> = {
  normal: 0xa8a77a,
  fire: 0xee8130,
  water: 0x6390f0,
  electric: 0xf7d02c,
  grass: 0x7ac74c,
  ice: 0x96d9d6,
  fighting: 0xc22e28,
  poison: 0xa33ea1,
  ground: 0xe2bf65,
  flying: 0xa98ff3,
  psychic: 0xf95587,
  bug: 0xa6b91a,
  rock: 0xb6a136,
  ghost: 0x735797,
  dragon: 0x6f35fc,
  dark: 0x705746,
  steel: 0xb7b7ce,
  fairy: 0xd685ad,
};

export function typeColor(types: readonly string[]): number | undefined {
  return types.length > 0 ? TYPE_COLORS[types[0]!.toLowerCase()] : undefined;
}

/** "▰▰▰▱▱": value out of max in `width` cells. */
export function progressBar(value: number, max: number, width = 10): string {
  const filled = max > 0 ? Math.round((Math.min(Math.max(value, 0), max) / max) * width) : 0;
  return "▰".repeat(filled) + "▱".repeat(width - filled);
}

/** ♂ / ♀ for the game's sex values (0 female, 1 male, or "female" / "male"). */
export function sexSymbol(sex: number | string | null | undefined): string {
  if (sex === 0 || sex === "female") {
    return " ♀";
  }
  if (sex === 1 || sex === "male") {
    return " ♂";
  }
  return "";
}

export function sexLabel(sex: number | null | undefined): string | undefined {
  switch (sex) {
    case 0:
      return "Female";
    case 1:
      return "Male";
    default:
      return undefined;
  }
}
