import { readFileSync } from "node:fs";

/**
 * Minimal .env parser: KEY=VALUE lines, # comments, optional single/double quotes,
 * \n escapes inside double quotes. No variable expansion.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      return;
    }
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) {
      throw new Error(`Invalid line ${index + 1}: expected KEY=VALUE`);
    }
    const key = match[1] as string;
    let value = (match[2] ?? "").trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"');
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      const comment = value.search(/\s#/);
      if (comment >= 0) {
        value = value.slice(0, comment).trim();
      }
    }
    result[key] = value;
  });
  return result;
}

export function readEnvFile(path: string): Record<string, string> {
  return parseEnvFile(readFileSync(path, "utf8"));
}
