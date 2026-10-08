import { PermissionFlagsBits } from "discord.js";
import { REQUIRED_GUILD_PERMISSIONS } from "./channels.js";

export function requiredPermissionBits(): bigint {
  return REQUIRED_GUILD_PERMISSIONS.reduce((bits, name) => bits | PermissionFlagsBits[name], 0n);
}

/** OAuth2 invite link with exactly the permissions the bot needs (no Administrator). */
export function inviteUrl(applicationId: string, guildId?: string): string {
  const params = new URLSearchParams({
    client_id: applicationId,
    scope: "bot applications.commands",
    permissions: requiredPermissionBits().toString(),
  });
  if (guildId) {
    params.set("guild_id", guildId);
    params.set("disable_guild_select", "true");
  }
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}
