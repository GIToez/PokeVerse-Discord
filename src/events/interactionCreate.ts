import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  PermissionFlagsBits,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
  type Interaction,
  type InteractionEditReplyOptions,
} from "discord.js";
import type { OutgoingMessage } from "../bot/ports.js";
import { isPrivateCommand, type CommandInput, type CommandRouter, type CommandUser } from "../commands/router.js";
import type { Logger } from "../utils/logger.js";

const AUTOCOMPLETE_TIMEOUT_MS = 2500;

const BUTTON_STYLES = { primary: ButtonStyle.Primary, secondary: ButtonStyle.Secondary, danger: ButtonStyle.Danger } as const;

function toCommandUser(interaction: ChatInputCommandInteraction | ButtonInteraction): CommandUser {
  const member = interaction.member as GuildMember | null;
  const roleIds = member && "cache" in member.roles ? [...member.roles.cache.keys()] : [];
  return {
    id: interaction.user.id,
    displayName: member?.displayName ?? interaction.user.displayName ?? interaction.user.username,
    roleIds,
    manageGuild: interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false,
  };
}

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
  return {
    commandName: interaction.commandName,
    subcommand,
    options,
    user: toCommandUser(interaction),
    guildId: interaction.guildId,
  };
}

function toReply(message: OutgoingMessage): InteractionEditReplyOptions {
  const components = message.buttons?.length
    ? [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          message.buttons.map((button) =>
            new ButtonBuilder().setCustomId(button.customId).setLabel(button.label).setStyle(BUTTON_STYLES[button.style]),
          ),
        ),
      ]
    : [];
  return {
    content: message.content ?? null,
    embeds: message.embeds ?? [],
    files: message.files?.map((file) => new AttachmentBuilder(file.path, { name: file.name })),
    components,
    allowedMentions: { parse: [] },
  };
}

async function handleCommand(interaction: ChatInputCommandInteraction, router: CommandRouter): Promise<void> {
  const privateCommand = isPrivateCommand(interaction.commandName);
  await interaction.deferReply(privateCommand ? { flags: MessageFlags.Ephemeral } : {});
  const response = await router.handle(toCommandInput(interaction));
  if (response.ephemeral && !privateCommand) {
    // Errors for public commands are shown only to the user who asked.
    await interaction.deleteReply().catch(() => undefined);
    await interaction.followUp({ ...toReply(response.message), content: response.message.content ?? undefined, flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.editReply(toReply(response.message));
}

async function handleButton(interaction: ButtonInteraction, router: CommandRouter): Promise<void> {
  await interaction.deferUpdate();
  const response = await router.handleComponent({
    customId: interaction.customId,
    user: toCommandUser(interaction),
    guildId: interaction.guildId,
  });
  // Buttons only appear on private replies, so the clicking user owns the message.
  await interaction.editReply(toReply(response.message));
}

async function handleAutocomplete(interaction: AutocompleteInteraction, router: CommandRouter): Promise<void> {
  const focused = interaction.options.getFocused(true);
  const choices = await Promise.race([
    router.autocomplete(interaction.commandName, focused.name, String(focused.value), interaction.user.id),
    new Promise<Array<{ name: string; value: string }>>((resolve) => setTimeout(() => resolve([]), AUTOCOMPLETE_TIMEOUT_MS)),
  ]);
  await interaction.respond(choices.slice(0, 25));
}

export function createInteractionHandler(router: CommandRouter, logger: Logger) {
  return async (interaction: Interaction): Promise<void> => {
    try {
      if (interaction.isChatInputCommand()) {
        await handleCommand(interaction, router);
      } else if (interaction.isButton()) {
        await handleButton(interaction, router);
      } else if (interaction.isAutocomplete()) {
        await handleAutocomplete(interaction, router);
      }
    } catch (error) {
      logger.error("Interaction failed", { error });
      if ((interaction.isChatInputCommand() || interaction.isButton()) && (interaction.deferred || interaction.replied)) {
        await interaction.editReply({ content: "Something went wrong. The error was logged.", embeds: [], components: [] }).catch(() => undefined);
      }
    }
  };
}
