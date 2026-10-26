import type { GuildPort, OutgoingButton } from "../bot/ports.js";
import { COLORS } from "../services/embeds.js";
import { PING_DESCRIPTIONS, PING_KINDS, type PingKind, type PingRoles } from "../services/pings/pingRoles.js";
import type { Logger } from "../utils/logger.js";
import type { Metrics } from "../utils/metrics.js";
import { KeyedRateLimiter } from "../utils/rateLimiter.js";
import type { CommandResponse, ComponentInput } from "./router.js";

export const PING_COMMAND = "pings";
const REASON = "Ping notifications picked with /pings";

function reply(text: string, color = COLORS.warning): CommandResponse {
  return { ephemeral: true, message: { embeds: [{ description: text, color }] } };
}

/** /pings: a private panel with an on/off button for each ping role. */
export class PingCommands {
  private readonly limiter = new KeyedRateLimiter(10, 30_000);

  constructor(
    private readonly options: {
      pings: PingRoles;
      guild: () => GuildPort | undefined;
      logger: Logger;
      metrics: Metrics;
    },
  ) {}

  async handle(userId: string): Promise<CommandResponse> {
    if (!this.limiter.tryTake(userId)) {
      this.options.metrics.increment("commands.rate_limited");
      return reply("You are using this command too quickly. Please wait a moment.");
    }
    return this.panel(userId);
  }

  /** `pings:toggle:<kind>:<user id>` */
  async handleComponent(input: ComponentInput): Promise<CommandResponse> {
    const [, action, kind, owner] = input.customId.split(":");
    if (owner !== input.user.id) {
      return reply("These buttons are not for you. Use `/pings` to pick your own.");
    }
    if (action !== "toggle" || !(PING_KINDS as readonly string[]).includes(kind ?? "")) {
      return reply("This button is no longer active. Use `/pings` again.");
    }
    if (!this.limiter.tryTake(owner)) {
      this.options.metrics.increment("commands.rate_limited");
      return this.panel(owner, "You are changing your pings too quickly. Please wait a moment.");
    }
    return this.toggle(owner, kind as PingKind);
  }

  private async toggle(userId: string, kind: PingKind): Promise<CommandResponse> {
    const { pings, guild: getGuild, logger, metrics } = this.options;
    const guild = getGuild();
    const roleId = pings.roleId(kind);
    const name = pings.roles.find((role) => role.kind === kind)?.name ?? kind;
    if (!guild || !roleId) {
      return reply(`The "${name}" role is not set up yet. Ask staff to run \`/pokeverse setup\`.`);
    }
    const member = await guild.fetchMember(userId);
    if (!member) {
      return reply("You are not a member of this server.");
    }
    const on = !member.roleIds.includes(roleId);
    try {
      if (on) {
        await guild.addRole(userId, roleId, REASON);
      } else {
        await guild.removeRole(userId, roleId, REASON);
      }
    } catch (error) {
      metrics.increment("pings.toggle_failed");
      logger.warn("Could not change a ping role", { user: userId, kind, error });
      return this.panel(userId, `The bot couldn't change "${name}". Staff: the bot's role must be above the ping roles.`);
    }
    metrics.increment(`pings.${on ? "on" : "off"}.${kind}`);
    return this.panel(userId, `${name}: **${on ? "on" : "off"}**.`, { roleId, on });
  }

  /** `change` is applied on top of the member read back, which can lag behind the role change. */
  private async panel(userId: string, note?: string, change?: { roleId: string; on: boolean }): Promise<CommandResponse> {
    const { pings, guild: getGuild } = this.options;
    const guild = getGuild();
    const member = guild ? await guild.fetchMember(userId) : undefined;
    const held = new Set(member?.roleIds ?? []);
    if (change) {
      if (change.on) {
        held.add(change.roleId);
      } else {
        held.delete(change.roleId);
      }
    }
    const kinds = pings.roles.map((role) => ({ ...role, roleId: pings.roleId(role.kind) }));
    const lines = kinds.map(({ kind, name, roleId }) => {
      const state = !roleId ? "not set up yet" : held.has(roleId) ? "**on**" : "off";
      return `**${name}**: ${state}\n${PING_DESCRIPTIONS[kind]}`;
    });
    const buttons: OutgoingButton[] = kinds
      .filter(({ roleId }) => roleId)
      .map(({ kind, name, roleId }) => ({
        customId: `pings:toggle:${kind}:${userId}`,
        label: `${held.has(roleId!) ? "Turn off" : "Turn on"} ${name}`.slice(0, 80),
        style: held.has(roleId!) ? "secondary" : "primary",
      }));
    return {
      ephemeral: true,
      message: {
        embeds: [{
          title: "Ping notifications",
          description: [
            ...(note ? [note, ""] : []),
            "Pick what the bot may ping you for. You can also change these in **Channels & Roles**.",
            "",
            lines.join("\n\n"),
          ].join("\n").slice(0, 4096),
          color: COLORS.info,
        }],
        buttons,
      },
    };
  }
}
