import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, describeConfig, isLoopbackHost, loadConfig } from "../../src/config/load.js";
import { parseEnvFile } from "../../src/config/envFile.js";
import { StateStore } from "../../src/utils/stateStore.js";
import { BASE_ENV, DEV_GUILD, PROD_GUILD, makeConfig, tempDir, writeEnv } from "../helpers/fakes.js";

function problemsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConfigError) {
      return error.problems;
    }
    throw error;
  }
  throw new Error("expected a ConfigError");
}

describe("configuration", () => {
  it("loads the development profile with development defaults", () => {
    const config = makeConfig();
    expect(config.profile).toBe("development");
    expect(config.catches.mode).toBe("all");
    expect(config.autoSetup).toBe(true);
    expect(config.log.format).toBe("pretty");
    expect(config.bridge).toMatchObject({ host: "127.0.0.1", port: 7199 });
    expect(config.stateFile.endsWith(join("data", "state.development.json"))).toBe(true);
    expect(config.spawns.sources).toEqual(new Set(["spawn", "script", "fishing", "headbutt"]));
  });

  it("uses production defaults only with explicit confirmation", () => {
    const problems = problemsOf(() => makeConfig({ DISCORD_GUILD_ID: PROD_GUILD }, "production"));
    expect(problems.join(" ")).toMatch(/POKEVERSE_CONFIRM_PRODUCTION=yes/);

    const config = makeConfig({ DISCORD_GUILD_ID: PROD_GUILD, POKEVERSE_CONFIRM_PRODUCTION: "yes" }, "production");
    expect(config.catches.mode).toBe("rare_only");
    expect(config.autoSetup).toBe(false);
    expect(config.log.format).toBe("json");
    expect(config.stateFile.endsWith("state.production.json")).toBe(true);
  });

  it("refuses a file whose profile does not match the selected profile", () => {
    const dir = tempDir();
    writeEnv(dir, "development", { ...BASE_ENV, POKEVERSE_PROFILE: "production", POKEVERSE_CONFIRM_PRODUCTION: "yes" });
    const problems = problemsOf(() => loadConfig({ profile: "development", configDir: dir, env: {} }));
    expect(problems.join(" ")).toMatch(/selected profile is "development"/);
  });

  it("never falls back from development to the production file", () => {
    const dir = tempDir();
    writeEnv(dir, "production", { ...BASE_ENV, POKEVERSE_PROFILE: "production", POKEVERSE_CONFIRM_PRODUCTION: "yes" });
    expect(() => loadConfig({ configDir: dir, env: {} })).toThrow(/\.env\.development/);
  });

  it("selects the profile from POKEVERSE_PROFILE but cannot override the file's profile", () => {
    const dir = tempDir();
    writeEnv(dir, "development", BASE_ENV);
    const config = loadConfig({ configDir: dir, env: { POKEVERSE_PROFILE: "development", CATCH_MODE: "off" } });
    expect(config.catches.mode).toBe("off");
    expect(() => loadConfig({ configDir: dir, env: { POKEVERSE_PROFILE: "staging" } })).toThrow(ConfigError);
  });

  it("rejects the production guild in development", () => {
    const problems = problemsOf(() => makeConfig({ DISCORD_GUILD_ID: PROD_GUILD, PRODUCTION_GUILD_ID: PROD_GUILD }));
    expect(problems.join(" ")).toMatch(/production guild/);
  });

  it("requires a loopback bridge in development", () => {
    expect(problemsOf(() => makeConfig({ BRIDGE_HOST: "51.68.1.2" })).join(" ")).toMatch(/loopback/);
    expect(problemsOf(() => makeConfig({ BRIDGE_ALLOW_REMOTE: "true" })).join(" ")).toMatch(/not allowed in development/);
    expect(isLoopbackHost("127.0.0.2")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
  });

  it("reports placeholder tokens, short secrets and invalid ids", () => {
    const problems = problemsOf(() =>
      makeConfig({ DISCORD_TOKEN: "paste-the-development-bot-token-here", BRIDGE_SECRET: "short", DISCORD_GUILD_ID: "abc" }),
    );
    expect(problems.some((line) => line.startsWith("DISCORD_TOKEN"))).toBe(true);
    expect(problems.some((line) => line.startsWith("BRIDGE_SECRET"))).toBe(true);
    expect(problems.some((line) => line.startsWith("DISCORD_GUILD_ID"))).toBe(true);
  });

  it("validates enums, numbers and booleans", () => {
    expect(problemsOf(() => makeConfig({ CATCH_MODE: "everything" }))[0]).toMatch(/CATCH_MODE/);
    expect(problemsOf(() => makeConfig({ CHAT_MAX_LENGTH: "999" }))[0]).toMatch(/between 1 and 255/);
    expect(problemsOf(() => makeConfig({ CHAT_ENABLED: "maybe" }))[0]).toMatch(/true or false/);
    expect(problemsOf(() => makeConfig({ SPAWN_SOURCES: "spawn,raid" }))[0]).toMatch(/SPAWN_SOURCES/);
    expect(problemsOf(() => makeConfig({ SPAWN_SHINY_LEGENDARY_ROUTE: "both" }))[0]).toMatch(/SPAWN_SHINY_LEGENDARY_ROUTE/);
  });

  it("parses lists and keeps secrets out of describeConfig", () => {
    const config = makeConfig({ DISCORD_ADMIN_USER_IDS: "300000000000000001, 300000000000000002", CATCH_RARE_SPECIES: "Dratini, Lapras" });
    expect(config.discord.adminUserIds).toEqual(["300000000000000001", "300000000000000002"]);
    expect(config.catches.rareSpecies).toEqual(new Set(["dratini", "lapras"]));
    const described = JSON.stringify(describeConfig(config));
    expect(described).not.toContain(config.discord.token);
    expect(described).not.toContain(config.bridge.secret);
    expect(described).toContain(DEV_GUILD);
  });

  it("keeps state files separate per profile", () => {
    const dir = tempDir();
    const file = join(dir, "state.json");
    new StateStore(file, "development").update((state) => {
      state.channels.gameChat = "1";
    });
    expect(() => new StateStore(file, "production")).toThrow(/belongs to profile "development"/);
    expect(new StateStore(file, "development").getChannelId("gameChat")).toBe("1");
  });
});

describe("env file parser", () => {
  it("handles comments, quotes, BOM, CRLF and Windows paths", () => {
    const parsed = parseEnvFile(
      '\uFEFFA=1\r\n# comment\r\nB="two words"\r\nC=\'x # y\'\r\nD=value # trailing\r\nE=C:\\PokeVerse\\pictures\r\nexport F=f\r\n',
    );
    expect(parsed).toEqual({ A: "1", B: "two words", C: "x # y", D: "value", E: "C:\\PokeVerse\\pictures", F: "f" });
  });

  it("reports the line of invalid entries", () => {
    expect(() => parseEnvFile("A=1\nnot a pair\n")).toThrow(/line 2/);
  });
});
