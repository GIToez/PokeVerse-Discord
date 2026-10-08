import {
  AttachmentBuilder,
  MessageFlags,
  PermissionFlagsBits,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
  type Interaction,
  type InteractionEditReplyOptions,
} from "discord.js";
import type { OutgoingMessage } from "../bot/ports.js";
import type { CommandInput, CommandRouter } from "../commands/router.js";
import type { Logger } from "../utils/logger.js";

const AUTOCOMPLETE_TIMEOUT_MS = 2500;

export function toCommandInput(interaction: ChatInputCommandInteraction): CommandInput {
  const options: Record<string, string | undefined> = {};
  const subcommand = interaction.options.getSubcommand(false) ?? undefined;
  const raw = interaction.options.data.flatMap((option) => (option.options ? option.options : [option]));
  for (const option of raw) {
    if (option.channel) {
      options[option.name] = option.channel.id;
    } else if (option.value !== undefined && option.value !== null) {
      options[option.name] = String(option.value);
    }
  }
  const member = interaction.member as GuildMember | null;
  const roleIds = member && "cache" in member.roles ? [...member.roles.cache.keys()] : [];
  return {
    commandName: interaction.commandName,
    subcommand,
    options,
    user: {
      id: interaction.user.id,
      displayName: member?.displayName ?? interaction.user.displayName ?? interaction.user.username,
      roleIds,
      manageGuild: interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false,
    },
    guildId: interaction.guildId,
  };
}

function toReply(message: OutgoingMessage): InteractionEditReplyOptions {
  return {
    content: message.content ?? null,
    embeds: message.embeds ?? [],
    files: message.files?.map((file) => new AttachmentBuilder(file.path, { name: file.name })),
    allowedMentions: { parse: [] },
  };
}

async function handleCommand(interaction: ChatInputCommandInteraction, router: CommandRouter): Promise<void> {
  const adminCommand = interaction.commandName === "pokeverse";
  await interaction.deferReply(adminCommand ? { flags: MessageFlags.Ephemeral } : {});
  const response = await router.handle(toCommandInput(interaction));
  if (response.ephemeral && !adminCommand) {
    // Errors for public commands are shown only to the user who asked.
    await interaction.deleteReply().catch(() => undefined);
    await interaction.followUp({ ...toReply(response.message), content: response.message.content ?? undefined, flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.editReply(toReply(response.message));
}

async function handleAutocomplete(interaction: AutocompleteInteraction, router: CommandRouter): Promise<void> {
  const focused = interaction.options.getFocused(true);
  const choices = await Promise.race([
    router.autocomplete(interaction.commandName, focused.name, String(focused.value)),
    new Promise<Array<{ name: string; value: string }>>((resolve) => setTimeout(() => resolve([]), AUTOCOMPLETE_TIMEOUT_MS)),
  ]);
  await interaction.respond(choices.slice(0, 25));
}

export function createInteractionHandler(router: CommandRouter, logger: Logger) {
  return async (interaction: Interaction): Promise<void> => {
    try {
      if (interaction.isChatInputCommand()) {
        await handleCommand(interaction, router);
      } else if (interaction.isAutocomplete()) {
        await handleAutocomplete(interaction, router);
      }
    } catch (error) {
      logger.error("Interaction failed", { error });
      if (interaction.isChatInputCommand() && (interaction.deferred || interaction.replied)) {
        await interaction.editReply({ content: "Something went wrong. The error was logged.", embeds: [] }).catch(() => undefined);
      }
    }
  };
}
