import { DiscordAPIError, RESTJSONErrorCodes } from "discord.js";
import type { GuildPort, MemberInfo } from "../../bot/ports.js";
import type { LinkApi } from "../../integrations/pokeverse/gameApi.js";
import { FEATURES, type LinkSummary } from "../../integrations/pokeverse/protocol.js";
import type { Logger } from "../../utils/logger.js";
import type { Metrics } from "../../utils/metrics.js";
import type { StateStore } from "../../utils/stateStore.js";

export interface LinkServiceOptions {
  config: {
    verifiedRoleName: string;
    premiumRoleEnabled: boolean;
    premiumRoleName: string;
    nicknameSync: boolean;
    resyncMinutes: number;
  };
  links: LinkApi;
  guild: () => GuildPort | undefined;
  store: StateStore;
  logger: Logger;
  metrics: Metrics;
}

/**
 * When to write the nickname:
 * - "always": linking, /main, /sync and rejoining members;
 * - "if_changed": automatic syncs, only when the main differs from the nickname the bot set
 *   last time (so a nickname a member chose later is left alone).
 */
export type NicknameMode = "always" | "if_changed";

export interface SyncResult {
  memberFound: boolean;
  added: string[];
  removed: string[];
  nickname: "set" | "reset" | "unchanged" | "skipped";
  /** Things the bot could not do, in plain words for the member or staff. */
  problems: string[];
}

const REASON = "PokeVerse account link";
/** Discord nickname limit. */
const MAX_NICKNAME = 32;
const PAGE_SIZE = 200;

function isMissingPermissions(error: unknown): boolean {
  return error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.MissingPermissions;
}

/**
 * Keeps Discord in line with the game's account links: the Verified Trainer role for every
 * linked member, the Ace Trainer role while the account has premium time, and the nickname
 * set to the main character. Only these two roles are ever added or removed; every other role
 * and the global username are left alone. Syncs are idempotent and only call Discord for
 * actual differences. A failed sync never touches the link itself (the game owns it).
 */
export class LinkService {
  private timer: NodeJS.Timeout | undefined;
  private resyncing: Promise<number> | undefined;

  constructor(private readonly options: LinkServiceOptions) {}

  get available(): boolean {
    return this.options.links.connected && this.options.links.hasFeature(FEATURES.accountLinking);
  }

  start(): void {
    if (this.options.config.resyncMinutes > 0) {
      this.timer = setInterval(() => void this.resyncAll(), this.options.config.resyncMinutes * 60_000);
      this.timer.unref();
    }
  }

  stop(): void {
    clearInterval(this.timer);
  }

  roleIds(): { verified: string | undefined; premium: string | undefined } {
    const roles = this.options.store.get().roles;
    return { verified: roles.verified, premium: this.options.config.premiumRoleEnabled ? roles.premium : undefined };
  }

  /** Brings one member in line with their link (`undefined` = not linked). */
  async sync(discordUserId: string, link: LinkSummary | undefined, mode: NicknameMode = "if_changed"): Promise<SyncResult> {
    const result: SyncResult = { memberFound: false, added: [], removed: [], nickname: "skipped", problems: [] };
    const guild = this.options.guild();
    if (!guild) {
      result.problems.push("The Discord server is not available yet.");
      return result;
    }
    const member = await guild.fetchMember(discordUserId);
    if (!member) {
      if (!link) {
        this.forget(discordUserId);
      }
      return result;
    }
    result.memberFound = true;
    const { verified, premium } = this.roleIds();
    const { config } = this.options;

    await this.setRole(guild, member, verified, config.verifiedRoleName, link !== undefined, result);
    if (config.premiumRoleEnabled) {
      await this.setRole(guild, member, premium, config.premiumRoleName, link?.premium === true, result);
    }
    await this.syncNickname(guild, member, link, mode, result);

    if (result.added.length || result.removed.length || result.nickname === "set" || result.nickname === "reset") {
      this.options.metrics.increment("linking.members_updated");
      this.options.logger.info("Member synced with account link", {
        user: discordUserId,
        linked: link !== undefined,
        added: result.added,
        removed: result.removed,
        nickname: result.nickname,
      });
    }
    if (result.problems.length > 0) {
      this.options.metrics.increment("linking.sync_problems");
      this.options.logger.warn("Member sync incomplete", { user: discordUserId, problems: result.problems });
    }
    return result;
  }

  /** Reads the link from the game, then syncs. */
  async refresh(discordUserId: string, mode: NicknameMode = "if_changed"): Promise<SyncResult> {
    const account = await this.options.links.account(discordUserId);
    return this.sync(discordUserId, account.linked ? account : undefined, mode);
  }

  /** Syncs every linked member and cleans up members whose link is gone. Returns members checked. */
  resyncAll(): Promise<number> {
    if (!this.resyncing) {
      this.resyncing = this.runResync().finally(() => {
        this.resyncing = undefined;
      });
    }
    return this.resyncing;
  }

  private async runResync(): Promise<number> {
    if (!this.available || !this.options.guild()) {
      return 0;
    }
    const linked = new Set<string>();
    let checked = 0;
    let offset: number | undefined = 0;
    try {
      while (offset !== undefined) {
        const page = await this.options.links.list(offset, PAGE_SIZE);
        for (const link of page.links) {
          linked.add(link.discordUserId);
          await this.syncQuietly(link.discordUserId, link);
          checked++;
        }
        offset = page.nextOffset;
      }
    } catch (error) {
      this.options.logger.warn("Link resync stopped early", { error, checked });
      return checked;
    }
    for (const discordUserId of Object.keys(this.options.store.get().linkedMembers)) {
      if (!linked.has(discordUserId)) {
        await this.syncQuietly(discordUserId, undefined);
        checked++;
      }
    }
    this.options.metrics.increment("linking.resyncs");
    this.options.logger.debug("Link resync finished", { checked });
    return checked;
  }

  private async syncQuietly(discordUserId: string, link: LinkSummary | undefined): Promise<void> {
    try {
      await this.sync(discordUserId, link);
    } catch (error) {
      this.options.logger.warn("Member sync failed", { user: discordUserId, error });
    }
  }

  private async setRole(
    guild: GuildPort,
    member: MemberInfo,
    roleId: string | undefined,
    roleName: string,
    wanted: boolean,
    result: SyncResult,
  ): Promise<void> {
    if (!roleId) {
      if (wanted) {
        result.problems.push(`The "${roleName}" role is not set up yet (staff: run /pokeverse setup).`);
      }
      return;
    }
    const has = member.roleIds.includes(roleId);
    if (has === wanted) {
      return;
    }
    try {
      if (wanted) {
        await guild.addRole(member.id, roleId, REASON);
        result.added.push(roleName);
      } else {
        await guild.removeRole(member.id, roleId, REASON);
        result.removed.push(roleName);
      }
    } catch (error) {
      if (!isMissingPermissions(error)) {
        throw error;
      }
      result.problems.push(`The bot cannot ${wanted ? "give" : "remove"} the "${roleName}" role: its own role must be above it and it needs Manage Roles.`);
    }
  }

  private async syncNickname(
    guild: GuildPort,
    member: MemberInfo,
    link: LinkSummary | undefined,
    mode: NicknameMode,
    result: SyncResult,
  ): Promise<void> {
    const store = this.options.store;
    const lastSet = store.get().linkedMembers[member.id];
    if (!link) {
      if (lastSet && member.nickname === lastSet && member.nicknameManageable) {
        await this.writeNickname(guild, member, null, result, "reset");
      }
      this.forget(member.id);
      return;
    }
    const desired = this.options.config.nicknameSync && link.main ? link.main.name.slice(0, MAX_NICKNAME) : undefined;
    if (!desired) {
      this.remember(member.id, lastSet ?? "");
      return;
    }
    if (member.nickname === desired) {
      result.nickname = "unchanged";
      this.remember(member.id, desired);
      return;
    }
    if (mode === "if_changed" && lastSet === desired) {
      return;
    }
    if (!member.nicknameManageable) {
      result.problems.push("The bot cannot change your nickname (server owner, or a role above the bot's role).");
      this.remember(member.id, lastSet ?? "");
      return;
    }
    if (await this.writeNickname(guild, member, desired, result, "set")) {
      this.remember(member.id, desired);
    }
  }

  private async writeNickname(
    guild: GuildPort,
    member: MemberInfo,
    nickname: string | null,
    result: SyncResult,
    outcome: "set" | "reset",
  ): Promise<boolean> {
    try {
      await guild.setNickname(member.id, nickname, REASON);
      result.nickname = outcome;
      return true;
    } catch (error) {
      if (!isMissingPermissions(error)) {
        throw error;
      }
      result.problems.push("The bot cannot change nicknames: it needs Manage Nicknames and a role above the member's roles.");
      return false;
    }
  }

  private remember(discordUserId: string, nickname: string): void {
    if (this.options.store.get().linkedMembers[discordUserId] !== nickname) {
      this.options.store.update((state) => {
        state.linkedMembers[discordUserId] = nickname;
      });
    }
  }

  private forget(discordUserId: string): void {
    if (discordUserId in this.options.store.get().linkedMembers) {
      this.options.store.update((state) => {
        delete state.linkedMembers[discordUserId];
      });
    }
  }
}
