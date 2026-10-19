import type { ForumTagSpec } from "../../bot/ports.js";
import type { ChannelPurpose } from "../../utils/stateStore.js";

/**
 * The game's report kinds (083-reports.lua, Reports.KINDS). The keys are the game's; the names are
 * the forum tag names (Discord allows 20 characters). A key the bot does not know gets no tag.
 */
export interface ReportStatus {
  key: string;
  tag: string;
  emoji: string;
  closed: boolean;
}

export interface ReportKind {
  purpose: ChannelPurpose;
  statuses: ReportStatus[];
  categories: Array<{ key: string; tag: string }>;
}

export const REPORT_KINDS: Record<string, ReportKind> = {
  bug: {
    purpose: "bugReports",
    statuses: [
      { key: "open", tag: "Open", emoji: "🆕", closed: false },
      { key: "confirmed", tag: "Confirmed", emoji: "🔎", closed: false },
      { key: "planned", tag: "Planned", emoji: "📌", closed: false },
      { key: "in_progress", tag: "In progress", emoji: "🛠️", closed: false },
      { key: "fixed", tag: "Fixed", emoji: "✅", closed: true },
      { key: "wont_fix", tag: "Won't fix", emoji: "🚫", closed: true },
      { key: "duplicate", tag: "Duplicate", emoji: "♻️", closed: true },
    ],
    categories: [
      { key: "client", tag: "Client" },
      { key: "map", tag: "Map" },
      { key: "npc", tag: "NPCs and quests" },
      { key: "pokemon", tag: "Pokemon and moves" },
      { key: "items", tag: "Items and shops" },
      { key: "tasks", tag: "Tasks and events" },
      { key: "other", tag: "Other" },
    ],
  },
  player: {
    purpose: "playerReports",
    statuses: [
      { key: "open", tag: "Open", emoji: "🆕", closed: false },
      { key: "investigating", tag: "Investigating", emoji: "🔎", closed: false },
      { key: "action_taken", tag: "Action taken", emoji: "✅", closed: true },
      { key: "no_action", tag: "No action", emoji: "🚫", closed: true },
      { key: "duplicate", tag: "Duplicate", emoji: "♻️", closed: true },
    ],
    categories: [
      { key: "cheating", tag: "Cheating or botting" },
      { key: "bug_abuse", tag: "Bug abuse" },
      { key: "harassment", tag: "Harassment" },
      { key: "scam", tag: "Scamming" },
      { key: "name", tag: "Offensive name" },
      { key: "spam", tag: "Spam or advertising" },
      { key: "other", tag: "Other" },
    ],
  },
};

/** Status tags are moderated, so only staff (Manage Threads) can change them; categories are not. */
export function forumTagsFor(kind: string): ForumTagSpec[] {
  const info = REPORT_KINDS[kind];
  if (!info) {
    return [];
  }
  return [
    ...info.statuses.map((status): ForumTagSpec => ({ name: status.tag, emoji: status.emoji, moderated: true })),
    ...info.categories.map((category): ForumTagSpec => ({ name: category.tag, moderated: false })),
  ];
}

export function statusOf(kind: string, key: string): ReportStatus | undefined {
  return REPORT_KINDS[kind]?.statuses.find((status) => status.key === key);
}

export function statusByTag(kind: string, tag: string): ReportStatus | undefined {
  const name = tag.trim().toLowerCase();
  return REPORT_KINDS[kind]?.statuses.find((status) => status.tag.toLowerCase() === name);
}

export function categoryTag(kind: string, key: string): string | undefined {
  return REPORT_KINDS[kind]?.categories.find((category) => category.key === key)?.tag;
}
