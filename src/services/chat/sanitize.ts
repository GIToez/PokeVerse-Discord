/**
 * Text conversion between Discord (UTF-8, markdown, mentions) and the game
 * (Latin-1 single line, max 255 characters, no markup).
 */

const ASCII_REPLACEMENTS: Record<string, string> = {
  "\u2018": "'",
  "\u2019": "'",
  "\u201A": "'",
  "\u201C": '"',
  "\u201D": '"',
  "\u201E": '"',
  "\u2013": "-",
  "\u2014": "-",
  "\u2026": "...",
  "\u00A0": " ",
  "\u2022": "*",
};

/** Keeps characters the game client can display (Latin-1); strips accents from others. */
export function toLatin1(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x20 && code <= 0x7e) {
      out += char;
    } else if (code >= 0xa0 && code <= 0xff) {
      out += code === 0xa0 ? " " : char;
    } else if (ASCII_REPLACEMENTS[char] !== undefined) {
      out += ASCII_REPLACEMENTS[char];
    } else if (code === 0x09 || code === 0x0a || code === 0x0d) {
      out += " ";
    } else {
      const base = char.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
      if (base !== char && [...base].every((c) => (c.codePointAt(0) ?? 0) <= 0xff && (c.codePointAt(0) ?? 0) >= 0x20)) {
        out += base;
      }
    }
  }
  return out;
}

/** Removes Discord markdown, custom emoji markup and links from a message. */
export function stripDiscordMarkdown(text: string): string {
  return text
    .replace(/```(?:[a-z0-9_+-]+\n)?([\s\S]*?)```/gi, "$1")
    .replace(/<a?:([A-Za-z0-9_]+):\d+>/g, ":$1:")
    .replace(/<t:(\d+)(?::[tTdDfFR])?>/g, (_m, seconds: string) => new Date(Number(seconds) * 1000).toISOString().slice(0, 16).replace("T", " "))
    .replace(/\[([^\]]+)\]\((?:https?:\/\/)[^)]+\)/g, "$1")
    .replace(/<?https?:\/\/\S+>?/gi, "[link]")
    .replace(/^\s*(?:>>>|>|#{1,3}|-#)\s+/gm, "")
    .replace(/(\*\*|__|~~|\|\|)/g, "")
    .replace(/(^|[^\w])[*_]([^*_\n]+)[*_](?=[^\w]|$)/g, "$1$2")
    .replace(/`/g, "");
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clamp(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return text.slice(0, Math.max(0, max - 3)).trimEnd() + "...";
}

/** Discord message content (cleanContent, mentions already resolved to names) -> game text. */
export function discordToGameText(content: string, maxLength: number): string {
  return clamp(collapse(toLatin1(stripDiscordMarkdown(content))), maxLength);
}

/** Discord display name -> game author (no brackets, Latin-1, max 24). */
export function discordToGameAuthor(name: string, maxLength = 24): string {
  const cleaned = collapse(toLatin1(name).replace(/[[\]<>@#:`*_~|\\]/g, ""));
  return clamp(cleaned, maxLength) || "Discord user";
}

const MARKDOWN_CHARS = /([\\*_~`|>[\]()#:-])/g;

export function escapeDiscordMarkdown(text: string): string {
  return text.replace(MARKDOWN_CHARS, "\\$1");
}

/** Breaks @everyone/@here and <@id>/<@&id>/<#id> so they can never ping anyone. */
export function neutralizeMentions(text: string): string {
  return text
    .replace(/@(everyone|here)/gi, "@\u200b$1")
    .replace(/<(@[!&]?|#)(\d+)>/g, "<\u200b$1$2>");
}

/** Game chat -> Discord line: "[Game] RedTrainer: text". */
export function formatGameChatForDiscord(author: string, text: string, maxLength = 1900): string {
  const safeAuthor = neutralizeMentions(escapeDiscordMarkdown(collapse(author)));
  const safeText = neutralizeMentions(escapeDiscordMarkdown(collapse(text)));
  return clamp(`[Game] ${safeAuthor}: ${safeText}`, maxLength);
}
