import type { ChannelAccess } from "../../bot/ports.js";

export interface PrivacyPolicy {
  /** Roles allowed to see the channel (activity viewers and bot admins). */
  roleIds: readonly string[];
  /** Users allowed to see the channel (activity viewers and bot admins). */
  userIds: readonly string[];
  botUserId: string;
}

export interface PrivacyCheck {
  private: boolean;
  /** Reasons the channel is not private; empty when it is. */
  problems: string[];
  /** Roles with Administrator: Discord always lets them see every channel. */
  administratorRoles: string[];
}

/**
 * A channel is private when nobody outside the policy can see it: @everyone is denied,
 * every role that can see it is authorized (or has Administrator, which Discord never lets
 * a channel hide from), and member overwrites only admit authorized users and the bot.
 *
 * Checking roles one at a time is enough: a member's access is the union of their roles'
 * grants, so a combination of roles can only see the channel if one of them can alone.
 */
export function checkPrivacy(access: ChannelAccess | undefined, policy: PrivacyPolicy): PrivacyCheck {
  if (!access) {
    return { private: false, problems: ["the channel was not found"], administratorRoles: [] };
  }
  const problems: string[] = [];
  if (access.everyoneCanView) {
    problems.push("@everyone can see the channel");
  }
  const administratorRoles: string[] = [];
  for (const role of access.roles) {
    if (role.administrator) {
      administratorRoles.push(role.name);
    } else if (!role.ownBotRole && !policy.roleIds.includes(role.id)) {
      problems.push(`role "${role.name}" can see the channel but is not an authorized viewer`);
    }
  }
  for (const member of access.members) {
    if (member !== policy.botUserId && !policy.userIds.includes(member)) {
      problems.push(`member ${member} has a channel overwrite but is not an authorized viewer`);
    }
  }
  return { private: problems.length === 0, problems, administratorRoles };
}
