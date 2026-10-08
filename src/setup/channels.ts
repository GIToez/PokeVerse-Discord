import type { PermissionName } from "../bot/ports.js";
import type { ChannelPurpose } from "../utils/stateStore.js";

export const CATEGORY_NAME = "PokeVerse Integration";

export interface ChannelDefinition {
  purpose: ChannelPurpose;
  name: string;
  topic: string;
  /** Members can read but not post (the bot posts). */
  readOnly: boolean;
  /** Permissions the bot needs in this channel to work. */
  required: PermissionName[];
}

const POST: PermissionName[] = ["ViewChannel", "SendMessages", "EmbedLinks", "ReadMessageHistory"];

export const CHANNEL_DEFINITIONS: readonly ChannelDefinition[] = [
  {
    purpose: "gameChat",
    name: "game-chat",
    topic: "Two-way chat with the in-game public channel. Be kind: everything here is shown in the game.",
    readOnly: false,
    required: ["ViewChannel", "SendMessages", "ReadMessageHistory"],
  },
  {
    purpose: "catches",
    name: "pokemon-catches",
    topic: "Pokemon caught in PokeVerse.",
    readOnly: true,
    required: [...POST, "AttachFiles"],
  },
  {
    purpose: "shinySpawns",
    name: "shiny-spawns",
    topic: "Shiny Pokemon sightings.",
    readOnly: true,
    required: [...POST, "AttachFiles"],
  },
  {
    purpose: "legendarySpawns",
    name: "legendary-spawns",
    topic: "Legendary Pokemon sightings.",
    readOnly: true,
    required: [...POST, "AttachFiles"],
  },
  {
    purpose: "announcements",
    name: "game-announcements",
    topic: "News, events, maintenance, GM broadcasts and restart warnings.",
    readOnly: true,
    required: POST,
  },
  {
    purpose: "serverStatus",
    name: "server-status",
    topic: "Live PokeVerse server status.",
    readOnly: true,
    required: POST,
  },
  {
    purpose: "botCommands",
    name: "bot-commands",
    topic: "Use /trainer, /pokemon and /server here.",
    readOnly: false,
    required: ["ViewChannel", "SendMessages", "EmbedLinks"],
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
];
