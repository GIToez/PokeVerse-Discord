import type { PermissionName } from "../bot/ports.js";
import type { ChannelPurpose } from "../utils/stateStore.js";

export const CATEGORY_NAME = "PokeVerse Integration";
/** Private category for staff-only channels. */
export const ADMIN_CATEGORY_NAME = "Admin Logs";

export interface ChannelDefinition {
  purpose: ChannelPurpose;
  name: string;
  topic: string;
  /** Members can read but not post (the bot posts). */
  readOnly: boolean;
  /** Permissions the bot needs in this channel to work. */
  required: PermissionName[];
  /** "admin" channels live in the private Admin Logs category and are verified before every post. */
  group: "main" | "admin";
}

const POST: PermissionName[] = ["ViewChannel", "SendMessages", "EmbedLinks", "ReadMessageHistory"];

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
    topic: "Legendary Pokemon sightings.",
    readOnly: true,
    required: [...POST, "AttachFiles"],
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
];

/** Guild permissions only needed for account linking (roles and nicknames). */
export const LINKING_GUILD_PERMISSIONS: PermissionName[] = ["ManageRoles", "ManageNicknames"];
