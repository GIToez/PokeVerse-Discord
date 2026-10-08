import {
  ChannelType,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import { ANNOUNCEMENT_CATEGORIES } from "../services/announcements/announcer.js";
import { CHANNEL_DEFINITIONS } from "../setup/channels.js";
import { CATCH_MODES } from "../utils/stateStore.js";

const CATCH_MODE_LABELS: Record<(typeof CATCH_MODES)[number], string> = {
  all: "All confirmed catches",
  rare_only: "Rare only (shiny, legendary, configured species)",
  shiny_legendary_only: "Shiny and legendary only",
  off: "Off",
};

export function buildCommandDefinitions(): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  const trainer = new SlashCommandBuilder()
    .setName("trainer")
    .setDescription("Show a PokeVerse trainer's public profile")
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option.setName("name").setDescription("Character name").setRequired(true).setMinLength(2).setMaxLength(30),
    );

  const pokemon = new SlashCommandBuilder()
    .setName("pokemon")
    .setDescription("Show PokeVerse data for a Pokemon species")
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option.setName("name").setDescription("Pokemon name").setRequired(true).setMaxLength(40).setAutocomplete(true),
    );

  const server = new SlashCommandBuilder()
    .setName("server")
    .setDescription("Show the PokeVerse game server status")
    .setContexts(InteractionContextType.Guild);

  const admin = new SlashCommandBuilder()
    .setName("pokeverse")
    .setDescription("PokeVerse bot administration")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) => sub.setName("setup").setDescription("Create or repair the PokeVerse channels (never deletes anything)"))
    .addSubcommand((sub) => sub.setName("status").setDescription("Show bot, bridge and permission diagnostics"))
    .addSubcommand((sub) =>
      sub
        .setName("channel")
        .setDescription("Use an existing channel for a PokeVerse feature")
        .addStringOption((option) =>
          option
            .setName("purpose")
            .setDescription("Feature")
            .setRequired(true)
            .addChoices(...CHANNEL_DEFINITIONS.map((definition) => ({ name: definition.name, value: definition.purpose }))),
        )
        .addChannelOption((option) =>
          option.setName("channel").setDescription("Text channel").setRequired(true).addChannelTypes(ChannelType.GuildText),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("catches")
        .setDescription("Choose which catches are announced")
        .addStringOption((option) =>
          option
            .setName("mode")
            .setDescription("Announcement mode")
            .setRequired(true)
            .addChoices(...CATCH_MODES.map((mode) => ({ name: CATCH_MODE_LABELS[mode], value: mode }))),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("announce")
        .setDescription("Post an announcement to #game-announcements")
        .addStringOption((option) =>
          option
            .setName("category")
            .setDescription("Kind of announcement")
            .setRequired(true)
            .addChoices(...ANNOUNCEMENT_CATEGORIES.map((category) => ({ name: category, value: category }))),
        )
        .addStringOption((option) => option.setName("text").setDescription("Announcement text").setRequired(true).setMaxLength(2000))
        .addStringOption((option) => option.setName("title").setDescription("Optional title").setMaxLength(100)),
    );

  return [trainer.toJSON(), pokemon.toJSON(), server.toJSON(), admin.toJSON()];
}
