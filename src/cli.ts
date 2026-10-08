import { REST, Routes } from "discord.js";
import { BotApp, StartupError } from "./bot/app.js";
import { buildCommandDefinitions } from "./commands/definitions.js";
import { ConfigError, describeConfig, loadConfig, type BotConfig } from "./config/load.js";
import { BridgeClient } from "./integrations/pokeverse/bridgeClient.js";
import { serverStatusResultSchema } from "./integrations/pokeverse/protocol.js";
import { inviteUrl } from "./setup/invite.js";
import { createLogger, type Logger } from "./utils/logger.js";
import { Metrics } from "./utils/metrics.js";

const COMMANDS = ["start", "setup", "check-config", "check-bridge", "register-commands", "invite", "help"] as const;
type Command = (typeof COMMANDS)[number];

interface CliArgs {
  command: Command;
  profile: string | undefined;
  configDir: string;
}

const USAGE = `Usage: pokeverse-discord <command> [--profile development|production] [--config-dir <folder>]

Commands:
  start              Run the bot (default)
  setup              Create or repair the Discord channels, then exit
  check-config       Validate the configuration file without connecting anywhere
  check-bridge       Connect to the game bridge and show the server status
  register-commands  Register the slash commands in the configured guild
  invite             Print the invite link (minimum permissions, no Administrator)
`;

export function parseArgs(argv: string[]): CliArgs {
  let command: Command = "start";
  let profile: string | undefined;
  let configDir = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--profile") {
      profile = argv[++i];
    } else if (arg.startsWith("--profile=")) {
      profile = arg.slice("--profile=".length);
    } else if (arg === "--config-dir") {
      configDir = argv[++i] ?? configDir;
    } else if (arg.startsWith("--config-dir=")) {
      configDir = arg.slice("--config-dir=".length);
    } else if (arg === "--help" || arg === "-h") {
      command = "help";
    } else if ((COMMANDS as readonly string[]).includes(arg)) {
      command = arg as Command;
    } else {
      throw new ConfigError(`Unknown argument "${arg}"`, [USAGE]);
    }
  }
  return { command, profile, configDir };
}

function print(line = ""): void {
  process.stdout.write(line + "\n");
}

function printError(title: string, hints: string[]): void {
  process.stderr.write(`\nERROR: ${title}\n`);
  for (const hint of hints) {
    process.stderr.write(`  - ${hint}\n`);
  }
  process.stderr.write("\n");
}

async function checkBridge(config: BotConfig, logger: Logger): Promise<number> {
  const client = new BridgeClient({
    host: config.bridge.host,
    port: config.bridge.port,
    secret: config.bridge.secret,
    requestTimeoutMs: config.bridge.requestTimeoutMs,
    logger,
    metrics: new Metrics(),
  });
  const outcome = await new Promise<"connected" | "auth_failed" | "timeout">((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), 10_000);
    client.once("connected", () => {
      clearTimeout(timer);
      resolve("connected");
    });
    client.once("authFailed", () => {
      clearTimeout(timer);
      resolve("auth_failed");
    });
    client.start();
  });
  try {
    if (outcome === "auth_failed") {
      printError("The game server rejected BRIDGE_SECRET.", [
        "BRIDGE_SECRET must be identical to discordBridgeSecret in the game's config.local.lua.",
      ]);
      return 1;
    }
    if (outcome === "timeout") {
      printError(`Could not reach the game bridge at ${config.bridge.host}:${config.bridge.port}.`, [
        "Start the game server first.",
        "Check discordBridgeEnabled = true and the port in the game's config.local.lua.",
      ]);
      return 1;
    }
    const status = await client.request("server.status", {}, serverStatusResultSchema);
    print(`Game bridge OK: ${status.serverName}, state ${status.state}, ${status.playersOnline} player(s) online.`);
    return 0;
  } finally {
    client.stop();
  }
}

async function registerCommands(config: BotConfig): Promise<number> {
  const rest = new REST().setToken(config.discord.token);
  const application = (await rest.get(Routes.currentApplication())) as { id: string };
  if (config.discord.applicationId && config.discord.applicationId !== application.id) {
    printError("DISCORD_APPLICATION_ID does not match the bot token.", []);
    return 1;
  }
  await rest.put(Routes.applicationGuildCommands(application.id, config.discord.guildId), {
    body: buildCommandDefinitions(),
  });
  print(`Registered ${buildCommandDefinitions().length} commands in guild ${config.discord.guildId}.`);
  return 0;
}

async function run(app: BotApp, logger: Logger): Promise<number> {
  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) {
      return;
    }
    stopping = true;
    logger.info("Shutting down", { signal });
    await app.stop().catch((error: unknown) => logger.error("Error while stopping", { error }));
    process.exit(0);
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
  await app.start();
  return new Promise<number>(() => {});
}

export async function main(argv: string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    printError((error as Error).message, (error as ConfigError).problems ?? []);
    return 2;
  }
  if (args.command === "help") {
    print(USAGE);
    return 0;
  }

  let config: BotConfig;
  try {
    config = loadConfig({ profile: args.profile, configDir: args.configDir });
  } catch (error) {
    if (error instanceof ConfigError) {
      printError(error.message, error.problems);
      return 2;
    }
    throw error;
  }

  const logger = createLogger({
    level: config.log.level,
    format: config.log.format,
    file: config.log.file,
    secrets: [config.discord.token, config.bridge.secret],
  });

  process.on("unhandledRejection", (reason) => logger.error("Unhandled promise rejection", { error: reason }));
  process.on("uncaughtException", (error) => logger.error("Uncaught exception", { error }));

  if (config.profile === "production") {
    logger.warn("Running with the PRODUCTION profile", { guildId: config.discord.guildId });
  }

  switch (args.command) {
    case "check-config":
      print(`Configuration OK (${config.envFile})`);
      print(JSON.stringify(describeConfig(config), null, 2));
      return 0;
    case "check-bridge":
      return checkBridge(config, logger);
    case "invite":
      if (!config.discord.applicationId) {
        printError("DISCORD_APPLICATION_ID is not set.", ["Copy the Application ID from the Developer Portal (General Information)."]);
        return 2;
      }
      print(inviteUrl(config.discord.applicationId, config.discord.guildId));
      return 0;
    case "register-commands":
      return registerCommands(config);
    case "setup":
    case "start": {
      logger.info("Starting PokeVerse Discord bot", describeConfig(config));
      const app = new BotApp(config, logger, { setupOnly: args.command === "setup" });
      try {
        if (args.command === "setup") {
          await app.start();
          await app.stop();
          return 0;
        }
        return await run(app, logger);
      } catch (error) {
        await app.stop().catch(() => undefined);
        if (error instanceof StartupError) {
          printError(error.message, error.hints);
          return 1;
        }
        throw error;
      }
    }
  }
}
