import { describe, expect, it } from "vitest";
import {
  discordToGameAuthor,
  discordToGameText,
  escapeDiscordMarkdown,
  formatGameChatForDiscord,
  neutralizeMentions,
  stripDiscordMarkdown,
  toLatin1,
} from "../../src/services/chat/sanitize.js";

describe("Discord -> game text", () => {
  it("strips markdown, code blocks, spoilers and custom emoji markup", () => {
    expect(stripDiscordMarkdown("**bold** __under__ ~~gone~~ ||spoiler|| `code`")).toBe("bold under gone spoiler code");
    expect(stripDiscordMarkdown("```js\nconsole.log(1)\n```")).toBe("console.log(1)\n");
    expect(stripDiscordMarkdown("hi <:pikachu:123456789012345678>")).toBe("hi :pikachu:");
    expect(stripDiscordMarkdown("> quoted")).toBe("quoted");
    expect(stripDiscordMarkdown("# Heading")).toBe("Heading");
  });

  it("replaces links so the game never shows clickable or long URLs", () => {
    expect(stripDiscordMarkdown("see https://example.com/x?y=1 now")).toBe("see [link] now");
    expect(stripDiscordMarkdown("[click](https://evil.example)")).toBe("click");
  });

  it("keeps Latin-1, folds accents and drops characters the client cannot show", () => {
    expect(toLatin1("Olá ça été")).toBe("Olá ça été");
    expect(toLatin1("smart \u201Cquotes\u201D \u2014 dash\u2026")).toBe('smart "quotes" - dash...');
    expect(toLatin1("emoji \u{1F600} gone")).toBe("emoji  gone");
    // Ł has no Latin-1 base and is dropped; ź folds to z.
    expect(toLatin1("\u0141\u00F3d\u017A")).toBe("\u00F3dz");
  });

  it("collapses whitespace and enforces the length limit", () => {
    expect(discordToGameText("a\n\n  b\tc", 100)).toBe("a b c");
    const long = discordToGameText("x".repeat(300), 200);
    expect(long).toHaveLength(200);
    expect(long.endsWith("...")).toBe(true);
  });

  it("cleans author names", () => {
    expect(discordToGameAuthor("[Admin] <Jim>")).toBe("Admin Jim");
    expect(discordToGameAuthor("\u{1F600}\u{1F600}")).toBe("Discord user");
    expect(discordToGameAuthor("a".repeat(40))).toHaveLength(24);
  });
});

describe("game -> Discord text", () => {
  it('formats "[Game] Author: text"', () => {
    expect(formatGameChatForDiscord("RedTrainer", "hello there")).toBe("[Game] RedTrainer: hello there");
  });

  it("blocks @everyone, @here, user, role and channel mentions", () => {
    const text = formatGameChatForDiscord("Evil", "@everyone @here <@123456789012345678> <@&123456789012345678> <#123456789012345678>");
    expect(text).not.toMatch(/@everyone|@here/);
    expect(text).not.toMatch(/<@\d|<@&\d|<#\d/);
    expect(neutralizeMentions("@EveryOne")).toBe("@\u200bEveryOne");
  });

  it("escapes markdown so game text is shown literally", () => {
    expect(formatGameChatForDiscord("A_B", "**not bold** `x` [x](y)")).toBe(
      "[Game] A\\_B: \\*\\*not bold\\*\\* \\`x\\` \\[x\\]\\(y\\)",
    );
    expect(escapeDiscordMarkdown("> quote")).toBe("\\> quote");
  });
});
