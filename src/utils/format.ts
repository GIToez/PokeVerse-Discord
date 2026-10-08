/** "3d 4h 12m" style duration from seconds. */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${seconds}s`;
}

export function padDex(dexNumber: number): string {
  return String(dexNumber).padStart(3, "0");
}

/** Discord relative timestamp markup. */
export function discordTimestamp(unixSeconds: number, style: "R" | "f" | "t" = "R"): string {
  return `<t:${Math.floor(unixSeconds)}:${style}>`;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return text.slice(0, Math.max(0, max - 1)) + "…";
}
