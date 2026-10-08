import { z } from "zod";
import { CATCH_MODES } from "../utils/stateStore.js";

export const PROFILES = ["development", "production"] as const;
export type Profile = (typeof PROFILES)[number];

export const SPAWN_LOCATION_MODES = ["none", "town", "coordinates"] as const;
/** A shiny legendary is announced exactly once, in one of these channels. */
export const SHINY_LEGENDARY_ROUTES = ["legendary", "shiny"] as const;
export const SPAWN_SOURCES = ["spawn", "script", "fishing", "headbutt"] as const;

const snowflake = z.string().regex(/^\d{17,20}$/, "must be a Discord ID (17-20 digits)");

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value === "") {
        return fallback;
      }
      const normalized = value.trim().toLowerCase();
      if (["1", "true", "yes", "on"].includes(normalized)) {
        return true;
      }
      if (["0", "false", "no", "off"].includes(normalized)) {
        return false;
      }
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be true or false" });
      return z.NEVER;
    });

const int = (fallback: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value === "") {
        return fallback;
      }
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `must be an integer between ${min} and ${max}` });
        return z.NEVER;
      }
      return parsed;
    });

const list = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== ""),
  );

const snowflakeList = list.pipe(z.array(snowflake));

const optionalString = z
  .string()
  .optional()
  .transform((value) => (value === undefined || value.trim() === "" ? undefined : value.trim()));

/** Raw environment -> typed config. Profile-dependent defaults are applied in load.ts. */
export const envSchema = z.object({
  POKEVERSE_PROFILE: z.enum(PROFILES),
  POKEVERSE_CONFIRM_PRODUCTION: optionalString,

  DISCORD_TOKEN: z
    .string()
    .min(1, "is required")
    .refine((value) => !/^(your|change|replace|paste)/i.test(value), "still contains the placeholder value"),
  DISCORD_APPLICATION_ID: optionalString.pipe(snowflake.optional()),
  DISCORD_GUILD_ID: snowflake,
  DISCORD_ADMIN_USER_IDS: snowflakeList,
  DISCORD_ADMIN_ROLE_IDS: snowflakeList,
  PRODUCTION_GUILD_ID: optionalString.pipe(snowflake.optional()),

  BRIDGE_HOST: z.string().default("127.0.0.1"),
  BRIDGE_PORT: int(7199, 1, 65535),
  BRIDGE_SECRET: z.string().min(16, "must be at least 16 characters (same value as discordBridgeSecret in the game)"),
  BRIDGE_REQUEST_TIMEOUT_MS: int(5000, 500, 60000),
  BRIDGE_ALLOW_REMOTE: bool(false),

  CHAT_ENABLED: bool(true),
  CHAT_MAX_LENGTH: int(200, 1, 255),
  CHAT_USER_MESSAGES: int(5, 1, 100),
  CHAT_USER_INTERVAL_SECONDS: int(10, 1, 3600),
  CHAT_GLOBAL_MESSAGES: int(20, 1, 1000),
  CHAT_GLOBAL_INTERVAL_SECONDS: int(10, 1, 3600),
  CHAT_MAX_EVENT_AGE_SECONDS: int(30, 1, 3600),

  CATCH_MODE: z.enum(CATCH_MODES).optional(),
  CATCH_RARE_SPECIES: list,
  CATCH_MAX_EVENT_AGE_SECONDS: int(600, 1, 86400),

  SPAWN_SHINY_ENABLED: bool(true),
  SPAWN_LEGENDARY_ENABLED: bool(true),
  SPAWN_LOCATION_MODE: z.enum(SPAWN_LOCATION_MODES).default("town"),
  SPAWN_SHINY_LEGENDARY_ROUTE: z.enum(SHINY_LEGENDARY_ROUTES).default("legendary"),
  SPAWN_ANNOUNCE_STARTUP: bool(false),
  SPAWN_SOURCES: list.pipe(z.array(z.enum(SPAWN_SOURCES))),
  SPAWN_MAX_EVENT_AGE_SECONDS: int(300, 1, 86400),

  ANNOUNCE_BROADCASTS: bool(true),
  ANNOUNCE_RESTART_WARNINGS: bool(true),

  STATUS_REFRESH_SECONDS: int(60, 15, 3600),
  AUTO_SETUP: z.string().optional(),
  POKEMON_ARTWORK_DIR: optionalString,
  DELIVERY_QUEUE_SIZE: int(500, 10, 10000),

  STATE_FILE: optionalString,
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  LOG_FORMAT: z.enum(["json", "pretty"]).optional(),
  LOG_FILE: optionalString,
});

export type RawEnv = z.input<typeof envSchema>;
export type ParsedEnv = z.output<typeof envSchema>;
