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
