import type { GuildPort, OutgoingMessage } from "../../bot/ports.js";
import type { Logger } from "../../utils/logger.js";
import type { Metrics } from "../../utils/metrics.js";
import type { StateStore } from "../../utils/stateStore.js";

/** Notifications members turn on for themselves; each is a role the bot pings. */
export const PING_KINDS = ["event", "shiny", "legendary", "news"] as const;
export type PingKind = (typeof PING_KINDS)[number];

export const PING_DESCRIPTIONS: Record<PingKind, string> = {
  event: "Holiday and weekend events in #game-announcements",
  shiny: "Shiny Pokémon spawns in #shiny-spawns",
  legendary: "Wild legendaries in #legendary-spawns",
  news: "News posts in #game-announcements",
};

export interface PingRoleConfig {
  kind: PingKind;
  name: string;
}

export interface PingRolesOptions {
  /** Empty when ping roles are off. */
  roles: PingRoleConfig[];
  store: StateStore;
  guild: () => GuildPort | undefined;
  logger: Logger;
  metrics: Metrics;
}

export type PingMention = Pick<OutgoingMessage, "content" | "mentionRoleIds">;

/**
 * Opt-in ping roles ("Shiny Pings", ...). Setup creates them (not mentionable, so members
 * can't ping each other with them); the bot pings them with Mention Everyone. Members pick
 * them in Discord's Onboarding, in Channels & Roles, or with /pings.
 */
export class PingRoles {
  constructor(private readonly options: PingRolesOptions) {}

  get enabled(): boolean {
    return this.options.roles.length > 0;
  }

  get roles(): readonly PingRoleConfig[] {
    return this.options.roles;
  }

  has(kind: PingKind): boolean {
    return this.options.roles.some((role) => role.kind === kind);
  }

  /** The saved role id; undefined when the kind is off or setup hasn't run. */
  roleId(kind: PingKind): string | undefined {
    return this.has(kind) ? this.options.store.get().roles[`ping:${kind}`] : undefined;
  }

  /** The content and allowed mentions that ping these kinds' roles; undefined when none can be pinged. */
  async mention(kinds: PingKind[]): Promise<PingMention | undefined> {
    const ids = [...new Set(kinds.flatMap((kind) => this.roleId(kind) ?? []))];
    const guild = this.options.guild();
    if (ids.length === 0 || !guild) {
      return undefined;
    }
    const roles = await guild.listRoles();
    const canMentionAll = guild.botPermissions().some((permission) => permission === "MentionEveryone" || permission === "Administrator");
    const pingable = ids.filter((id) => {
      const role = roles.find((item) => item.id === id);
      if (!role) {
        this.options.metrics.increment("pings.role_missing");
        this.options.logger.warn("A ping role was deleted; run /pokeverse setup to create it again", { roleId: id });
        return false;
      }
      if (role.mentionable === false && !canMentionAll) {
        this.options.metrics.increment("pings.not_allowed");
        this.options.logger.warn("The bot needs Mention Everyone to ping the ping roles; posted without the ping", { role: role.name });
        return false;
      }
      return true;
    });
    if (pingable.length === 0) {
      return undefined;
    }
    this.options.metrics.increment("pings.sent");
    return { content: pingable.map((id) => `<@&${id}>`).join(" "), mentionRoleIds: pingable };
  }
}
