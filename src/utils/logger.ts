import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFormat = "json" | "pretty";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  level: LogLevel;
  format: LogFormat;
  file?: string | undefined;
  /** Values that must never appear in logs (tokens, secrets). */
  secrets?: string[];
  write?: (line: string) => void;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(context: Record<string, unknown>): Logger;
}

function serializeError(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

export function createLogger(options: LoggerOptions, context: Record<string, unknown> = {}): Logger {
  const threshold = LEVELS[options.level];
  const secrets = (options.secrets ?? []).filter((s) => s.length >= 8);
  const write = options.write ?? ((line: string) => process.stdout.write(line + "\n"));
  if (options.file) {
    mkdirSync(dirname(options.file), { recursive: true });
  }

  const redact = (text: string): string => {
    let out = text;
    for (const secret of secrets) {
      out = out.split(secret).join("[REDACTED]");
    }
    return out;
  };

  const log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (LEVELS[level] < threshold) {
      return;
    }
    const record: Record<string, unknown> = { time: new Date().toISOString(), level, msg, ...context };
    for (const [key, value] of Object.entries(fields ?? {})) {
      record[key] = serializeError(value);
    }
    const json = redact(JSON.stringify(record));
    if (options.file) {
      try {
        appendFileSync(options.file, json + "\n");
      } catch {
        // Logging must never crash the bot.
      }
    }
    if (options.format === "json") {
      write(json);
      return;
    }
    const { time, level: _l, msg: _m, ...rest } = record;
    const extra = Object.keys(rest).length > 0 ? " " + redact(JSON.stringify(rest)) : "";
    write(`${String(time).slice(11, 19)} ${level.toUpperCase().padEnd(5)} ${redact(msg)}${extra}`);
  };

  return {
    debug: (msg, fields) => log("debug", msg, fields),
    info: (msg, fields) => log("info", msg, fields),
    warn: (msg, fields) => log("warn", msg, fields),
    error: (msg, fields) => log("error", msg, fields),
    child: (extra) => createLogger(options, { ...context, ...extra }),
  };
}

/** Logger that discards everything (tests). */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
