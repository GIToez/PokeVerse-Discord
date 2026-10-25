import type { ForumTagSpec, PermissionName } from "../bot/ports.js";
import { forumTagsFor } from "../services/reports/reportKinds.js";
import type { ChannelPurpose } from "../utils/stateStore.js";

export const CATEGORY_NAME = "PokeVerse Integration";
/** Private category for staff-only channels. */
export const ADMIN_CATEGORY_NAME = "Admin Logs";
/** Private category for the staff rooms, opened by the staff roles. */
export const STAFF_CATEGORY_NAME = "PokeVerse Staff";

export interface ChannelDefinition {
  purpose: ChannelPurpose;
  name: string;
  topic: string;
  /** Members can read but not post (the bot posts). */
  readOnly: boolean;
  /** Allowed to @everyone when setup creates the channel (reactions in a read-only channel). */
  everyoneAllow?: PermissionName[];
  /** Permissions the bot needs in this channel to work. */
  required: PermissionName[];
  /** Earlier default topics; setup replaces them with `topic`, but never a topic someone wrote. */
  previousTopics?: string[];
  /**
   * "admin" channels live in the private Admin Logs category and are verified before every post.
   * "staff" rooms live in the private PokeVerse Staff category; the staff roles from `minGroup` up can see them.
   */
  group: "main" | "admin" | "staff";
  /** Staff rooms: the lowest in-game staff group (groups.xml) whose role gets in. */
  minGroup?: number;
  /** Defaults to a text channel. Forum channels get `tags`, added again by setup when missing. */
  type?: "text" | "forum";
  tags?: ForumTagSpec[];
  /** The config switch the channel belongs to; without one it is always set up. */
  feature?: "activity" | "bugReports" | "playerReports" | "boosterRewards" | "staffRooms";
}

const POST: PermissionName[] = ["ViewChannel", "SendMessages", "EmbedLinks", "ReadMessageHistory"];
const FORUM: PermissionName[] = [...POST, "SendMessagesInThreads"];

export const CHANNEL_DEFINITIONS: readonly ChannelDefinition[] = [
  {
    purpose: "gameChat",
    name: "game-chat",
    topic: "Two-way chat with the in-game public channel. Be kind: everything here is shown in the game.",
    readOnly: false,
    required: ["ViewChannel", "SendMessages", "ReadMessageHistory"],
    group: "main",
  },
  {
    purpose: "catches",
    name: "pokemon-catches",
    topic: "Pokemon caught in PokeVerse.",
    readOnly: true,
    required: [...POST, "AttachFiles"],
    group: "main",
  },
  {
    purpose: "shinySpawns",
    name: "shiny-spawns",
    topic: "Shiny Pokemon sightings.",
    readOnly: true,
    required: [...POST, "AttachFiles"],
    group: "main",
  },
  {
    purpose: "legendarySpawns",
    name: "legendary-spawns",
    topic: "Legendary Pokemon sightings, one thread per wild legendary.",
    previousTopics: ["Legendary Pokemon sightings."],
    readOnly: true,
    required: [...POST, "AttachFiles", "CreatePublicThreads", "SendMessagesInThreads"],
    group: "main",
  },
  {
    purpose: "announcements",
    name: "game-announcements",
    topic: "News, events, maintenance, GM broadcasts and restart warnings.",
    readOnly: true,
    required: POST,
    group: "main",
  },
  {
    purpose: "serverStatus",
    name: "server-status",
    topic: "Live PokeVerse server status.",
    readOnly: true,
    required: POST,
    group: "main",
  },
  {
    purpose: "botCommands",
    name: "bot-commands",
    topic: "Use /trainer, /pokemon, /server and /link here.",
    readOnly: false,
    required: ["ViewChannel", "SendMessages", "EmbedLinks"],
    group: "main",
  },
  {
    purpose: "playerActivity",
    name: "player-activity",
    topic: "PRIVATE staff log of game logins and logouts. Contains personal data; never share it.",
    readOnly: true,
    required: POST,
    group: "admin",
    feature: "activity",
  },
  {
    purpose: "boosterRewards",
    name: "booster-rewards",
    topic: "Thank you, boosters! Every 7 days of continuous boosting earns Soul Coins on your linked game account, " +
      "with loyalty and yearly bonuses. Link your account with /link and check your streak with /booster.",
    readOnly: true,
    everyoneAllow: ["AddReactions", "ReadMessageHistory"],
    required: POST,
    group: "main",
    feature: "boosterRewards",
  },
  {
    purpose: "bugReports",
    name: "bug-reports",
    topic: "Bugs reported in the game (Reports window, Ctrl+Z), one post each. The tags show what became of them. " +
      "Add what you know in a post; report new bugs in the game so the team gets your position and client.",
    readOnly: true,
    required: FORUM,
    group: "main",
    type: "forum",
    tags: forumTagsFor("bug"),
    feature: "bugReports",
  },
  {
    purpose: "playerReports",
    name: "player-reports",
    topic: "PRIVATE staff forum of player reports from the game. Change the status tag to answer the report in the game.",
    readOnly: true,
    required: FORUM,
    group: "admin",
    type: "forum",
    tags: forumTagsFor("player"),
    feature: "playerReports",
  },
  {
    purpose: "staffTutors",
    name: "tutor-room",
    topic: "Staff room for Tutors, Senior Tutors, Gamemasters and up. Access follows the in-game staff group of your linked account.",
    readOnly: false,
    required: ["ViewChannel"],
    group: "staff",
    minGroup: 2,
    feature: "staffRooms",
  },
  {
    purpose: "staffGamemasters",
    name: "gm-room",
    topic: "Staff room for Gamemasters, Community Managers and Gods. Access follows the in-game staff group of your linked account.",
    readOnly: false,
    required: ["ViewChannel"],
    group: "staff",
    minGroup: 4,
    feature: "staffRooms",
  },
];

export function definitionFor(purpose: ChannelPurpose): ChannelDefinition {
  const definition = CHANNEL_DEFINITIONS.find((item) => item.purpose === purpose);
  if (!definition) {
    throw new Error(`Unknown channel purpose ${purpose}`);
  }
  return definition;
}

/** Guild-level permissions the bot needs (invite link and setup check). No Administrator. */
export const REQUIRED_GUILD_PERMISSIONS: PermissionName[] = [
  "ViewChannel",
  "SendMessages",
  "EmbedLinks",
  "AttachFiles",
  "ReadMessageHistory",
  "ManageChannels",
  "ManageRoles",
  "ManageNicknames",
  "CreatePublicThreads",
  "SendMessagesInThreads",
  "ManageThreads",
  "MentionEveryone",
  "CreateEvents",
  "ManageEvents",
];

/** Guild permissions only needed for the report forums (status tags are moderated, posts are archived). */
export const REPORT_GUILD_PERMISSIONS: PermissionName[] = ["ManageThreads"];

/** Only needed for staff pings of @everyone, @here and roles nobody else can ping (ANNOUNCE_STAFF_PINGS). */
export const PING_GUILD_PERMISSIONS: PermissionName[] = ["MentionEveryone"];

/** Only needed for the calendar's scheduled events (CALENDAR_SYNC_ENABLED). */
export const CALENDAR_GUILD_PERMISSIONS: PermissionName[] = ["CreateEvents", "ManageEvents"];

/** Guild permissions only needed for account linking (roles and nicknames). */
export const LINKING_GUILD_PERMISSIONS: PermissionName[] = ["ManageRoles", "ManageNicknames"];
