import type { APIEmbed } from "discord.js";
import { BridgeRequestError, BridgeUnavailableError } from "../integrations/pokeverse/bridgeClient.js";
import type { LinkApi } from "../integrations/pokeverse/gameApi.js";
import type { LinkSummary } from "../integrations/pokeverse/protocol.js";
import { COLORS, plain } from "../services/embeds.js";
import type { LinkService, SyncResult } from "../services/linking/linkService.js";
import { discordTimestamp } from "../utils/format.js";
import type { Logger } from "../utils/logger.js";
import type { Metrics } from "../utils/metrics.js";
import { KeyedRateLimiter } from "../utils/rateLimiter.js";
import type { CommandInput, CommandResponse, ComponentInput } from "./router.js";

export const LINK_COMMANDS = ["link", "unlink", "account", "characters", "main", "sync"] as const;

const OFFLINE = "The PokeVerse game server is offline right now. Please try again later.";
const UNAVAILABLE = "Account linking is not available on the game server yet.";
const NOT_LINKED = "Your Discord account is not linked. In the game, type `!discord link` to get a code, then use `/link` here.";
const UNLINK_CONFIRM_SECONDS = 60;
const CODE_PATTERN = /^[0-9A-Za-z][0-9A-Za-z\- ]{6,14}[0-9A-Za-z]$/;

const REDEEM_ERRORS: Record<string, string> = {
  invalid_code: "That code is not valid. Check it, or get a new one in the game with `!discord link`.",
  expired: "That code has expired. Get a new one in the game with `!discord link`.",
  locked: "Too many wrong codes. Please wait 15 minutes before trying again.",
  already_linked: "Your Discord account is already linked to a game account. Use `/unlink` first if you want to link another one.",
  account_linked:
    "That game account is already linked to another Discord account. Log in to the game and type `!discord unlink` first.",
  disabled: "Account linking is disabled on the game server.",
};

function reply(text: string, color?: number): CommandResponse {
  return color === undefined
    ? { ephemeral: true, message: { content: text } }
    : { ephemeral: true, message: { embeds: [{ description: text, color }] } };
}

function premiumText(link: LinkSummary): string {
  if (link.premiumUnlimited) {
    return "Yes (unlimited)";
  }
  return link.premium ? `Yes (${link.premiumDays ?? "?"} days left)` : "No";
}

/**
 * /link, /unlink, /account, /characters, /main and /sync. Every reply is private to the user,
 * and every game request acts only for the user who ran the command.
 */
export class LinkCommands {
  private readonly linkLimiter = new KeyedRateLimiter(5, 10 * 60_000);
  private readonly commandLimiter = new KeyedRateLimiter(5, 10_000);
  private readonly syncLimiter = new KeyedRateLimiter(2, 60_000);

  constructor(
    private readonly options: {
      links: LinkApi;
      service: LinkService;
      roleNames: { verified: string; premium: string | undefined };
      logger: Logger;
      metrics: Metrics;
      now?: () => number;
    },
  ) {}

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  async handle(input: CommandInput): Promise<CommandResponse> {
    const userId = input.user.id;
    const limiter = input.commandName === "link" ? this.linkLimiter : input.commandName === "sync" ? this.syncLimiter : this.commandLimiter;
    if (!limiter.tryTake(userId)) {
      this.options.metrics.increment("commands.rate_limited");
      return reply(input.commandName === "link"
        ? "Too many link attempts. Please wait a few minutes."
        : "You are using this command too quickly. Please wait a moment.");
    }
    if (!this.options.links.connected) {
      return reply(OFFLINE);
    }
    if (!this.options.service.available) {
      return reply(UNAVAILABLE);
    }
    try {
      switch (input.commandName) {
        case "link":
          return await this.link(userId, input.options.code ?? "");
        case "unlink":
          return await this.unlinkPrompt(userId);
        case "account":
          return await this.account(userId);
        case "characters":
          return await this.characters(userId);
        case "main":
          return await this.main(userId, input.options.character ?? "");
        case "sync":
          return await this.sync(userId);
        default:
          return reply("Unknown command.");
      }
    } catch (error) {
      if (error instanceof BridgeUnavailableError) {
        return reply(OFFLINE);
      }
      if (error instanceof BridgeRequestError && error.code === "not_linked") {
        return reply(NOT_LINKED);
      }
      throw error;
    }
  }

  /** Buttons of the /unlink confirmation. */
  async handleComponent(input: ComponentInput): Promise<CommandResponse> {
    const [, action, owner, expires] = input.customId.split(":");
    if (owner !== input.user.id) {
      return reply("This button is not for you.");
    }
    if (action === "cancel") {
      return reply("Nothing was changed. Your account is still linked.", COLORS.neutral);
    }
    if (action !== "confirm" || Number(expires) * 1000 < this.now) {
      return reply("This confirmation has expired. Run `/unlink` again.");
    }
    if (!this.options.links.connected) {
      return reply(OFFLINE);
    }
    const result = await this.options.links.unlink(owner);
    if (!result.unlinked) {
      await this.options.service.sync(owner, undefined);
      return reply("Your Discord account was not linked.", COLORS.neutral);
    }
    this.options.metrics.increment("linking.unlinked");
    this.options.logger.info("Account unlinked from Discord", { user: owner });
    const sync = await this.options.service.sync(owner, undefined);
    return reply(this.withProblems("Your Discord account is no longer linked. Your characters are not affected.", sync), COLORS.success);
  }

  async autocompleteMain(userId: string, value: string): Promise<Array<{ name: string; value: string }>> {
    if (!this.options.service.available) {
      return [];
    }
    const result = await this.options.links.characters(userId);
    if (!result.linked) {
      return [];
    }
    const query = value.trim().toLowerCase();
    return result.characters
      .filter((character) => character.name.toLowerCase().includes(query))
      .slice(0, 25)
      .map((character) => ({ name: `${character.name} (level ${character.level})${character.main ? " - main" : ""}`, value: character.name }));
  }

  private async link(userId: string, code: string): Promise<CommandResponse> {
    const trimmed = code.trim();
    if (!CODE_PATTERN.test(trimmed)) {
      return reply("Enter the 8-character code shown in the game, for example `ABCD-1234`.");
    }
    let summary: LinkSummary;
    try {
      summary = await this.options.links.redeem(userId, trimmed);
    } catch (error) {
      if (error instanceof BridgeRequestError && REDEEM_ERRORS[error.code]) {
        this.options.metrics.increment(`linking.redeem_${error.code}`);
        return reply(REDEEM_ERRORS[error.code]!, COLORS.warning);
      }
      throw error;
    }
    this.options.metrics.increment("linking.linked");
    this.options.logger.info("Account linked to Discord", { user: userId });
    const sync = await this.options.service.sync(userId, summary, "always");
    const lines = ["Your Discord account is now linked to your PokeVerse account."];
    if (summary.main) {
      lines.push(`Main character: **${plain(summary.main.name)}**`);
    }
    return reply(this.withProblems(lines.join("\n") + this.changesText(sync), sync), COLORS.success);
  }

  private async unlinkPrompt(userId: string): Promise<CommandResponse> {
    const account = await this.options.links.account(userId);
    if (!account.linked) {
      return reply(NOT_LINKED);
    }
    const expires = Math.floor(this.now / 1000) + UNLINK_CONFIRM_SECONDS;
    return {
      ephemeral: true,
      message: {
        embeds: [{
          description: [
            `Unlink your Discord account from the PokeVerse account with **${account.characterCount}** character(s)?`,
            `You will lose the ${[this.options.roleNames.verified, this.options.roleNames.premium].filter(Boolean).join(" and ")} role(s). Your characters are not affected.`,
            `This confirmation expires ${discordTimestamp(expires)}.`,
          ].join("\n"),
          color: COLORS.warning,
        }],
        buttons: [
          { customId: `unlink:confirm:${userId}:${expires}`, label: "Unlink", style: "danger" },
          { customId: `unlink:cancel:${userId}:${expires}`, label: "Cancel", style: "secondary" },
        ],
      },
    };
  }

  private async account(userId: string): Promise<CommandResponse> {
    const account = await this.options.links.account(userId);
    if (!account.linked) {
      return reply(NOT_LINKED, COLORS.neutral);
    }
    const sync = await this.options.service.sync(userId, account);
    const fields: NonNullable<APIEmbed["fields"]> = [
      { name: "Linked since", value: discordTimestamp(account.linkedAt, "f"), inline: true },
      {
        name: "Main character",
        value: account.main ? `${plain(account.main.name)} (level ${account.main.level}${account.main.vocation ? `, ${plain(account.main.vocation)}` : ""})` : "None",
        inline: true,
      },
      { name: "Characters", value: String(account.characterCount), inline: true },
      { name: "Premium", value: premiumText(account), inline: true },
      {
        name: "Discord sync",
        value: sync.problems.length > 0 ? sync.problems.join("\n") : "Roles and nickname are up to date.",
      },
    ];
    return { ephemeral: true, message: { embeds: [{ title: "Your PokeVerse account", color: COLORS.info, fields }] } };
  }

  private async characters(userId: string): Promise<CommandResponse> {
    const result = await this.options.links.characters(userId);
    if (!result.linked) {
      return reply(NOT_LINKED, COLORS.neutral);
    }
    if (result.characters.length === 0) {
      return reply("Your account has no characters on this world yet.", COLORS.neutral);
    }
    const lines = result.characters.map((character) => {
      const vocation = character.vocation ? `, ${plain(character.vocation)}` : "";
      const tags = [character.main ? "main" : "", character.online ? "online" : ""].filter(Boolean).join(", ");
      return `**${plain(character.name)}**: level ${character.level}${vocation}${tags ? ` (${tags})` : ""}`;
    });
    return { ephemeral: true, message: { embeds: [{ title: "Your characters", color: COLORS.info, description: lines.join("\n").slice(0, 4000) }] } };
  }

  private async main(userId: string, character: string): Promise<CommandResponse> {
    if (character.trim() === "") {
      return reply("Choose one of your characters.");
    }
    let summary: LinkSummary;
    try {
      summary = await this.options.links.setMain(userId, character);
    } catch (error) {
      if (error instanceof BridgeRequestError && (error.code === "not_owned" || error.code === "invalid_params")) {
        return reply("That character is not on your linked account.", COLORS.warning);
      }
      throw error;
    }
    const sync = await this.options.service.sync(userId, summary, "always");
    return reply(this.withProblems(`Main character set to **${plain(summary.main?.name ?? character)}**.${this.changesText(sync)}`, sync), COLORS.success);
  }

  private async sync(userId: string): Promise<CommandResponse> {
    const account = await this.options.links.account(userId);
    const sync = await this.options.service.sync(userId, account.linked ? account : undefined, "always");
    if (!account.linked) {
      return reply(NOT_LINKED, COLORS.neutral);
    }
    const changes = this.changesText(sync);
    return reply(this.withProblems(changes ? `Synced.${changes}` : "Everything was already up to date.", sync), COLORS.success);
  }

  private changesText(sync: SyncResult): string {
    const parts: string[] = [];
    if (sync.added.length > 0) {
      parts.push(`Roles given: ${sync.added.join(", ")}`);
    }
    if (sync.removed.length > 0) {
      parts.push(`Roles removed: ${sync.removed.join(", ")}`);
    }
    if (sync.nickname === "set") {
      parts.push("Nickname updated to your main character");
    }
    return parts.length > 0 ? `\n${parts.join("\n")}` : "";
  }

  private withProblems(text: string, sync: SyncResult): string {
    return sync.problems.length > 0 ? `${text}\n\nNote: ${sync.problems.join(" ")}` : text;
  }
}
