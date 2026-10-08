import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ZodError } from "zod";
import type { CatchMode } from "../utils/stateStore.js";
import type { LogFormat, LogLevel } from "../utils/logger.js";
import { readEnvFile } from "./envFile.js";
import { envSchema, PROFILES, SPAWN_SOURCES, type Profile } from "./schema.js";

export interface BotConfig {
  profile: Profile;
  envFile: string;
  discord: {
    token: string;
    applicationId: string | undefined;
    guildId: string;
    adminUserIds: string[];
    adminRoleIds: string[];
  };
  bridge: {
    host: string;
    port: number;
    secret: string;
    requestTimeoutMs: number;
  };
  chat: {
    enabled: boolean;
    maxLength: number;
    userMessages: number;
    userIntervalMs: number;
    globalMessages: number;
    globalIntervalMs: number;
    maxEventAgeSeconds: number;
  };
  catches: {
    mode: CatchMode;
    rareSpecies: Set<string>;
    maxEventAgeSeconds: number;
  };
  spawns: {
    shinyEnabled: boolean;
    legendaryEnabled: boolean;
    locationMode: "none" | "town" | "coordinates";
    shinyLegendaryRoute: "legendary" | "shiny";
    announceStartup: boolean;
    sources: Set<string>;
    maxEventAgeSeconds: number;
  };
  announcements: {
    broadcasts: boolean;
    restartWarnings: boolean;
  };
  status: { refreshSeconds: number };
  autoSetup: boolean;
  artworkDir: string | undefined;
  deliveryQueueSize: number;
  stateFile: string;
  log: { level: LogLevel; format: LogFormat; file: string | undefined };
}

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly problems: string[],
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface LoadOptions {
  /** Profile from the command line; falls back to POKEVERSE_PROFILE, then "development". */
  profile?: string | undefined;
  /** Folder that contains .env.development / .env.production. */
  configDir: string;
  /** Process environment (overrides values from the file). */
  env?: NodeJS.ProcessEnv;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host.trim().toLowerCase()) || /^127\.\d+\.\d+\.\d+$/.test(host.trim());
}

export function envFileFor(configDir: string, profile: Profile): string {
  return resolve(configDir, `.env.${profile}`);
}

export function selectProfile(cliProfile: string | undefined, env: NodeJS.ProcessEnv): Profile {
  const value = (cliProfile ?? env.POKEVERSE_PROFILE ?? "development").trim().toLowerCase();
  if (!(PROFILES as readonly string[]).includes(value)) {
    throw new ConfigError(`Unknown profile "${value}"`, [`Profile must be one of: ${PROFILES.join(", ")}`]);
  }
  return value as Profile;
}

function formatZodError(error: ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`);
}

export function loadConfig(options: LoadOptions): BotConfig {
  const env = options.env ?? process.env;
  const profile = selectProfile(options.profile, env);
  const envFile = envFileFor(options.configDir, profile);
  if (!existsSync(envFile)) {
    throw new ConfigError(`Configuration file not found: ${envFile}`, [
      `Create ${envFile} (copy .env.${profile}.example or run the configure script).`,
    ]);
  }

  let fileValues: Record<string, string>;
  try {
    fileValues = readEnvFile(envFile);
  } catch (error) {
    throw new ConfigError(`Cannot read ${envFile}`, [(error as Error).message]);
  }

  const problems: string[] = [];
  if (fileValues.POKEVERSE_PROFILE !== profile) {
    problems.push(
      `POKEVERSE_PROFILE in ${envFile} is "${fileValues.POKEVERSE_PROFILE ?? ""}" but the selected profile is ` +
        `"${profile}". Each profile must have its own file.`,
    );
  }

  const keys = Object.keys(envSchema.shape);
  const merged: Record<string, string> = { ...fileValues };
  for (const key of keys) {
    const value = env[key];
    if (value !== undefined && key !== "POKEVERSE_PROFILE") {
      merged[key] = value;
    }
  }
  merged.POKEVERSE_PROFILE = profile;

  const parsed = envSchema.safeParse(merged);
  if (!parsed.success) {
    throw new ConfigError(`Invalid configuration in ${envFile}`, [...problems, ...formatZodError(parsed.error)]);
  }
  const raw = parsed.data;

  if (profile === "development") {
    if (!isLoopbackHost(raw.BRIDGE_HOST)) {
      problems.push(`BRIDGE_HOST must be a loopback address in development (got "${raw.BRIDGE_HOST}").`);
    }
    if (raw.BRIDGE_ALLOW_REMOTE) {
      problems.push("BRIDGE_ALLOW_REMOTE is not allowed in development.");
    }
    if (raw.PRODUCTION_GUILD_ID && raw.PRODUCTION_GUILD_ID === raw.DISCORD_GUILD_ID) {
      problems.push("DISCORD_GUILD_ID is the production guild. Development must use a separate development guild.");
    }
  } else {
    if (raw.POKEVERSE_CONFIRM_PRODUCTION !== "yes") {
      problems.push("Production requires POKEVERSE_CONFIRM_PRODUCTION=yes in .env.production.");
    }
    if (!isLoopbackHost(raw.BRIDGE_HOST) && !raw.BRIDGE_ALLOW_REMOTE) {
      problems.push("BRIDGE_HOST is not a loopback address; set BRIDGE_ALLOW_REMOTE=true only for a private network or tunnel.");
    }
  }
  if (problems.length > 0) {
    throw new ConfigError(`Invalid configuration in ${envFile}`, problems);
  }

  const fromConfigDir = (path: string) => (isAbsolute(path) ? path : resolve(options.configDir, path));
  const autoSetupRaw = raw.AUTO_SETUP?.trim().toLowerCase();
  const autoSetup = autoSetupRaw === undefined || autoSetupRaw === ""
    ? profile === "development"
    : ["1", "true", "yes", "on"].includes(autoSetupRaw);

  return {
    profile,
    envFile,
    discord: {
      token: raw.DISCORD_TOKEN,
      applicationId: raw.DISCORD_APPLICATION_ID,
      guildId: raw.DISCORD_GUILD_ID,
      adminUserIds: raw.DISCORD_ADMIN_USER_IDS,
      adminRoleIds: raw.DISCORD_ADMIN_ROLE_IDS,
    },
    bridge: {
      host: raw.BRIDGE_HOST,
      port: raw.BRIDGE_PORT,
      secret: raw.BRIDGE_SECRET,
      requestTimeoutMs: raw.BRIDGE_REQUEST_TIMEOUT_MS,
    },
    chat: {
      enabled: raw.CHAT_ENABLED,
      maxLength: raw.CHAT_MAX_LENGTH,
      userMessages: raw.CHAT_USER_MESSAGES,
      userIntervalMs: raw.CHAT_USER_INTERVAL_SECONDS * 1000,
      globalMessages: raw.CHAT_GLOBAL_MESSAGES,
      globalIntervalMs: raw.CHAT_GLOBAL_INTERVAL_SECONDS * 1000,
      maxEventAgeSeconds: raw.CHAT_MAX_EVENT_AGE_SECONDS,
    },
    catches: {
      mode: raw.CATCH_MODE ?? (profile === "development" ? "all" : "rare_only"),
      rareSpecies: new Set(raw.CATCH_RARE_SPECIES.map((name) => name.toLowerCase())),
      maxEventAgeSeconds: raw.CATCH_MAX_EVENT_AGE_SECONDS,
    },
    spawns: {
      shinyEnabled: raw.SPAWN_SHINY_ENABLED,
      legendaryEnabled: raw.SPAWN_LEGENDARY_ENABLED,
      locationMode: raw.SPAWN_LOCATION_MODE,
      shinyLegendaryRoute: raw.SPAWN_SHINY_LEGENDARY_ROUTE,
      announceStartup: raw.SPAWN_ANNOUNCE_STARTUP,
      sources: new Set(raw.SPAWN_SOURCES.length > 0 ? raw.SPAWN_SOURCES : SPAWN_SOURCES),
      maxEventAgeSeconds: raw.SPAWN_MAX_EVENT_AGE_SECONDS,
    },
    announcements: {
      broadcasts: raw.ANNOUNCE_BROADCASTS,
      restartWarnings: raw.ANNOUNCE_RESTART_WARNINGS,
    },
    status: { refreshSeconds: raw.STATUS_REFRESH_SECONDS },
    autoSetup,
    artworkDir: raw.POKEMON_ARTWORK_DIR ? fromConfigDir(raw.POKEMON_ARTWORK_DIR) : undefined,
    deliveryQueueSize: raw.DELIVERY_QUEUE_SIZE,
    stateFile: fromConfigDir(raw.STATE_FILE ?? `data/state.${profile}.json`),
    log: {
      level: raw.LOG_LEVEL,
      format: raw.LOG_FORMAT ?? (profile === "development" ? "pretty" : "json"),
      file: raw.LOG_FILE ? fromConfigDir(raw.LOG_FILE) : undefined,
    },
  };
}

/** Human-readable summary for startup logs and check-config (never includes secrets). */
export function describeConfig(config: BotConfig): Record<string, unknown> {
  return {
    profile: config.profile,
    envFile: config.envFile,
    guildId: config.discord.guildId,
    bridge: `${config.bridge.host}:${config.bridge.port}`,
    chat: config.chat.enabled,
    catchMode: config.catches.mode,
    spawns: {
      shiny: config.spawns.shinyEnabled,
      legendary: config.spawns.legendaryEnabled,
      location: config.spawns.locationMode,
    },
    autoSetup: config.autoSetup,
    artworkDir: config.artworkDir ?? null,
    stateFile: config.stateFile,
  };
}
