import type { BridgeClient } from "./bridgeClient.js";
import {
  adminSessionsResultSchema,
  announcementRolesResultSchema,
  calendarRangeResultSchema,
  boostLevelResultSchema,
  boosterRulesResultSchema,
  boosterWeekResultSchema,
  bridgeConfigResultSchema,
  chatSendResultSchema,
  linkAccountResultSchema,
  linkCharactersResultSchema,
  linkListResultSchema,
  linkSummarySchema,
  pokemonResultSchema,
  pokemonSearchResultSchema,
  reportGetResultSchema,
  reportScreenshotResultSchema,
  reportSetStatusResultSchema,
  serverStatusResultSchema,
  trainerResultSchema,
  unlinkResultSchema,
  type AdminSessionsResult,
  type BoostLevelResult,
  type BoosterRules,
  type BoosterWeekResult,
  type BridgeConfigResult,
  type CalendarRangeResult,
  type StaffRoom,
  type LinkAccountResult,
  type LinkCharactersResult,
  type LinkListResult,
  type LinkSummary,
  type PokemonResult,
  type ReportGetResult,
  type ReportScreenshotResult,
  type ReportSetStatusResult,
  type ServerStatusResult,
  type TrainerResult,
} from "./protocol.js";

/** Read-only game lookups plus chat delivery, all through the authenticated bridge. */
export interface GameApi {
  readonly connected: boolean;
  lookupTrainer(name: string): Promise<TrainerResult>;
  lookupPokemon(name: string): Promise<PokemonResult>;
  searchPokemon(query: string, limit: number): Promise<string[]>;
  serverStatus(): Promise<ServerStatusResult>;
  sendChat(author: string, text: string): Promise<{ delivered: number; text: string }>;
  bridgeConfig(): Promise<BridgeConfigResult>;
}

/**
 * Account linking requests. Each one acts for exactly one Discord user: the user who ran
 * the command, or the target of an admin-only command.
 */
export interface LinkApi {
  readonly connected: boolean;
  hasFeature(feature: string): boolean;
  redeem(discordUserId: string, code: string): Promise<LinkSummary>;
  account(discordUserId: string): Promise<LinkAccountResult>;
  characters(discordUserId: string): Promise<LinkCharactersResult>;
  setMain(discordUserId: string, character: string): Promise<LinkSummary>;
  unlink(discordUserId: string): Promise<{ unlinked: boolean }>;
  list(offset: number, limit: number): Promise<LinkListResult>;
}

/** The in-game staff channels (feature `staffChat`). */
export interface StaffChatApi {
  readonly connected: boolean;
  hasFeature(feature: string): boolean;
  send(room: StaffRoom, author: string, text: string): Promise<{ delivered: number; text: string }>;
}

export interface AdminApi {
  readonly connected: boolean;
  sessions(): Promise<AdminSessionsResult>;
}

/** Announcements and the calendar. */
export interface AnnouncementApi {
  readonly connected: boolean;
  hasFeature(feature: string): boolean;
  /** Tells the game which Discord roles staff can ping from the Admin window. Resolves with how many it kept. */
  roles(roles: string[], everyone: boolean): Promise<number>;
  /** The calendar's events overlapping [from, to] (unix seconds). */
  calendarRange(from: number, to: number): Promise<CalendarRangeResult>;
}

/** In-game reports: a status tag picked on a forum post answers the report; screenshots are read in slices. */
export interface ReportApi {
  readonly connected: boolean;
  setStatus(id: number, status: string, by: string, note?: string): Promise<ReportSetStatusResult>;
  get(id: number): Promise<ReportGetResult>;
  /** Up to `length` base64 characters of the screenshot from `offset` (the game caps a slice). */
  screenshot(id: number, offset: number, length: number): Promise<ReportScreenshotResult>;
}

/** Server boost rewards: Soul Coins for every 7 days of continuous boosting (linked accounts only). */
export interface BoosterApi {
  readonly connected: boolean;
  hasFeature(feature: string): boolean;
  rules(): Promise<BoosterRules>;
  /**
   * Deposits week `week` of the boost that started at `boostSince` (unix seconds); idempotent.
   * `serverBoosts`: the server's boost count now, for the community bonus.
   */
  week(discordUserId: string, boostSince: number, week: number, serverBoosts: number): Promise<BoosterWeekResult>;
  /** Tells the game the server boost level (0-3) for its server-wide perks (`boostPerks`). */
  level(level: number, boosts: number): Promise<BoostLevelResult>;
}

export function createGameApi(client: BridgeClient): GameApi {
  return {
    get connected() {
      return client.connected;
    },
    lookupTrainer: (name) => client.request("trainer.lookup", { name }, trainerResultSchema),
    lookupPokemon: (name) => client.request("pokemon.lookup", { name }, pokemonResultSchema),
    searchPokemon: async (query, limit) =>
      (await client.request("pokemon.search", { query, limit }, pokemonSearchResultSchema)).names,
    serverStatus: () => client.request("server.status", {}, serverStatusResultSchema),
    sendChat: (author, text) => client.request("chat.send", { author, text }, chatSendResultSchema),
    bridgeConfig: () => client.request("bridge.config", {}, bridgeConfigResultSchema),
  };
}

export function createLinkApi(client: BridgeClient): LinkApi {
  return {
    get connected() {
      return client.connected;
    },
    hasFeature: (feature) => client.hasFeature(feature),
    redeem: (discordUserId, code) => client.request("link.redeem", { discordUserId, code }, linkSummarySchema),
    account: (discordUserId) => client.request("link.account", { discordUserId }, linkAccountResultSchema),
    characters: (discordUserId) => client.request("link.characters", { discordUserId }, linkCharactersResultSchema),
    setMain: (discordUserId, character) => client.request("link.setMain", { discordUserId, character }, linkSummarySchema),
    unlink: (discordUserId) => client.request("link.unlink", { discordUserId }, unlinkResultSchema),
    list: (offset, limit) => client.request("link.list", { offset, limit }, linkListResultSchema),
  };
}

export function createAdminApi(client: BridgeClient): AdminApi {
  return {
    get connected() {
      return client.connected;
    },
    sessions: () => client.request("admin.sessions", {}, adminSessionsResultSchema),
  };
}

export function createStaffChatApi(client: BridgeClient): StaffChatApi {
  return {
    get connected() {
      return client.connected;
    },
    hasFeature: (feature) => client.hasFeature(feature),
    send: (room, author, text) => client.request("chat.staff", { room, author, text }, chatSendResultSchema),
  };
}

export function createBoosterApi(client: BridgeClient): BoosterApi {
  return {
    get connected() {
      return client.connected;
    },
    hasFeature: (feature) => client.hasFeature(feature),
    rules: () => client.request("booster.rules", {}, boosterRulesResultSchema),
    week: (discordUserId, boostSince, week, serverBoosts) =>
      client.request("booster.week", { discordUserId, boostSince, week, serverBoosts }, boosterWeekResultSchema),
    level: (level, boosts) => client.request("boost.level", { level, boosts }, boostLevelResultSchema),
  };
}

export function createReportApi(client: BridgeClient): ReportApi {
  return {
    get connected() {
      return client.connected;
    },
    setStatus: (id, status, by, note) =>
      client.request("report.setStatus", { id, status, by, ...(note ? { note } : {}) }, reportSetStatusResultSchema),
    get: (id) => client.request("report.get", { id }, reportGetResultSchema),
    screenshot: (id, offset, length) => client.request("report.screenshot", { id, offset, length }, reportScreenshotResultSchema),
  };
}

export function createAnnouncementApi(client: BridgeClient): AnnouncementApi {
  return {
    get connected() {
      return client.connected;
    },
    hasFeature: (feature) => client.hasFeature(feature),
    roles: async (roles, everyone) =>
      (await client.request("announcements.roles", { roles, everyone }, announcementRolesResultSchema)).roles,
    calendarRange: (from, to) => client.request("calendar.range", { from, to }, calendarRangeResultSchema),
  };
}
