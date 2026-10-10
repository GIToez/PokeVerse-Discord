import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PlayerLoginEvent, PlayerLogoutEvent } from "../../src/integrations/pokeverse/protocol.js";
import { ActivityLog } from "../../src/services/activity/activityLog.js";
import { ActivityStore } from "../../src/services/activity/activityStore.js";
import { GeoIp } from "../../src/services/activity/geoip.js";
import { maskIp, nonPublicRange, parseIpv4 } from "../../src/services/activity/ip.js";
import { checkPrivacy } from "../../src/services/activity/privacy.js";
import { DeliveryQueue } from "../../src/utils/deliveryQueue.js";
import { createLogger, silentLogger } from "../../src/utils/logger.js";
import { Metrics } from "../../src/utils/metrics.js";
import { BOT_USER, EVERYONE, FakeAdminApi, FakeChannels, FakeGuild, envelope, tempDir } from "../helpers/fakes.js";
import { writeMmdb } from "../helpers/mmdb.js";

const VIEWER_ROLE = "800000000000000001";
const VIEWER_USER = "800000000000000002";
const POLICY = { roleIds: [VIEWER_ROLE], userIds: [VIEWER_USER], botUserId: BOT_USER };
const IP = "81.2.69.160";

function login(overrides: Partial<PlayerLoginEvent> = {}): PlayerLoginEvent {
  return {
    kind: "player_login",
    scope: "admin",
    sessionId: "boot1-s1",
    character: "Red Trainer",
    level: 25,
    accountId: 42,
    loginTime: 1_700_000_000,
    ip: IP,
    clientOs: "otclient-windows",
    clientVersion: 1098,
    playersOnline: 3,
    ...overrides,
  };
}

function logout(overrides: Partial<PlayerLogoutEvent> = {}): PlayerLogoutEvent {
  return {
    kind: "player_logout",
    scope: "admin",
    sessionId: "boot1-s1",
    character: "Red Trainer",
    level: 26,
    accountId: 42,
    loginTime: 1_700_000_000,
    logoutTime: 1_700_003_725,
    duration: 3725,
    reason: "logout",
    playersOnline: 2,
    ...overrides,
  };
}

function setup(options: { ipMode?: "full" | "masked" | "hidden"; geo?: GeoIp; file?: string; now?: () => number } = {}) {
  const guild = new FakeGuild();
  const channels = new FakeChannels();
  const sink = channels.channel("playerActivity");
  guild.addRoleInfo({ id: VIEWER_ROLE, name: "Staff" });
  guild.add({
    id: sink.id,
    name: "player-activity",
    kind: "text",
    parentId: null,
    overwrites: [
      { id: EVERYONE, type: "role", allow: [], deny: ["ViewChannel"] },
      { id: BOT_USER, type: "member", allow: ["ViewChannel", "SendMessages"], deny: [] },
      { id: VIEWER_ROLE, type: "role", allow: ["ViewChannel"], deny: ["SendMessages"] },
    ],
  });
  const lines: string[] = [];
  const logger = createLogger({ level: "debug", format: "json", write: (line) => lines.push(line) });
  const metrics = new Metrics();
  const admin = new FakeAdminApi();
  const store = new ActivityStore({ file: options.file ?? join(tempDir(), "activity.json"), logger, writeDelayMs: 5 });
  const queue = new DeliveryQueue({ name: "activity", maxSize: 100, maxAttempts: 1, retryDelayMs: 1, logger, metrics });
  const log = new ActivityLog({
    config: { ipMode: options.ipMode ?? "full", retentionDays: 30 },
    channels,
    guild: () => guild,
    policy: () => POLICY,
    store,
    geo: options.geo ?? GeoIp.disabled(),
    admin,
    sessionsAvailable: () => true,
    queue,
    logger,
    metrics,
    now: options.now,
  });
  const fields = (index = 0) => Object.fromEntries((sink.sent[index]?.message.embeds?.[0]?.fields ?? []).map((field) => [field.name, field.value]));
  return { guild, channels, sink, lines, metrics, admin, store, queue, log, fields };
}

describe("ip helpers", () => {
  it("parses, classifies and masks IPv4 addresses", () => {
    expect(parseIpv4("203.0.113.45")).toEqual([203, 0, 113, 45]);
    expect(parseIpv4("256.1.1.1")).toBeUndefined();
    expect(parseIpv4("::1")).toBeUndefined();
    expect(nonPublicRange("127.0.0.1")).toMatch(/loopback/);
    expect(nonPublicRange("10.1.2.3")).toBe("private network");
    expect(nonPublicRange("172.20.0.1")).toBe("private network");
    expect(nonPublicRange("172.32.0.1")).toBeUndefined();
    expect(nonPublicRange("192.168.1.10")).toBe("private network");
    expect(nonPublicRange("100.64.0.1")).toMatch(/carrier-grade NAT/);
    expect(nonPublicRange("169.254.1.1")).toBe("link-local");
    expect(nonPublicRange("0.0.0.0")).toBe("reserved address");
    expect(nonPublicRange("239.1.1.1")).toBe("reserved address");
    expect(nonPublicRange(IP)).toBeUndefined();
    expect(maskIp("203.0.113.45")).toBe("203.0.x.x");
    expect(maskIp("nonsense")).toBe("hidden");
    expect(maskIp(undefined)).toBe("unknown");
  });
});

describe("geoip", () => {
  it("looks up a local MaxMind database and reports anonymizers", () => {
    const file = join(tempDir(), "test.mmdb");
    writeMmdb(file, [
      {
        cidr: "81.2.69.0/24",
        data: {
          city: { names: { en: "London" } },
          subdivisions: [{ names: { en: "England" } }],
          country: { iso_code: "GB", names: { en: "United Kingdom" } },
        },
      },
      { cidr: "198.51.100.0/24", data: { country: { names: { en: "France" } }, traits: { is_anonymous_vpn: true } } },
    ]);
    const geo = GeoIp.open(file, silentLogger);
    expect(geo.enabled).toBe(true);
    expect(geo.description).toMatch(/^Test-City \(2023-11-14\)$/);
    expect(geo.lookup(IP)).toEqual({ label: "London, England, United Kingdom", nonPublic: false });
    expect(geo.lookup("198.51.100.7")).toEqual({ label: "France", nonPublic: false, anonymizer: "VPN" });
    expect(geo.lookup("8.8.8.8")).toEqual({ label: "Unknown location", nonPublic: false });
    expect(geo.lookup("192.168.0.2")).toEqual({ label: "No location (private network)", nonPublic: true });
    expect(geo.lookup(undefined)).toBeUndefined();
  });

  it("falls back to disabled when the database is missing or damaged", () => {
    const dir = tempDir();
    expect(GeoIp.open(join(dir, "missing.mmdb"), silentLogger).enabled).toBe(false);
    writeFileSync(join(dir, "bad.mmdb"), "not a database");
    expect(GeoIp.open(join(dir, "bad.mmdb"), silentLogger).enabled).toBe(false);
    expect(GeoIp.open(undefined, silentLogger).description).toBe("disabled");
    expect(GeoIp.disabled().lookup(IP)).toBeUndefined();
  });
});

describe("privacy check", () => {
  const access = { everyoneCanView: false, roles: [], members: [BOT_USER] };

  it("accepts a channel only authorized viewers can see", () => {
    expect(checkPrivacy({ ...access, roles: [{ id: VIEWER_ROLE, name: "Staff", administrator: false, ownBotRole: false }], members: [BOT_USER, VIEWER_USER] }, POLICY))
      .toEqual({ private: true, problems: [], administratorRoles: [] });
  });

  it("rejects public channels, unauthorized roles and members, and reports Administrator roles", () => {
    expect(checkPrivacy(undefined, POLICY).private).toBe(false);
    expect(checkPrivacy({ ...access, everyoneCanView: true }, POLICY).problems).toEqual(["@everyone can see the channel"]);
    const roles = [
      { id: "1", name: "Members", administrator: false, ownBotRole: false },
      { id: "2", name: "Owner", administrator: true, ownBotRole: false },
      { id: "3", name: "PokeVerse", administrator: false, ownBotRole: true },
    ];
    const check = checkPrivacy({ ...access, roles, members: [BOT_USER, "900000000000000001"] }, POLICY);
    expect(check.private).toBe(false);
    expect(check.problems).toHaveLength(2);
    expect(check.problems[0]).toMatch(/role "Members"/);
    expect(check.problems[1]).toMatch(/member 900000000000000001/);
    expect(check.administratorRoles).toEqual(["Owner"]);
  });
});

describe("activity store", () => {
  it("persists sessions without IPs or account ids, owner-only, and expires them", () => {
    const file = join(tempDir(), "activity.json");
    const store = new ActivityStore({ file, logger: silentLogger });
    expect(store.add({ sessionId: "b-1", bootId: "b", character: "Red", level: 1, loginTime: 100, recordedAt: 100 })).toBe(true);
    expect(store.add({ sessionId: "b-1", bootId: "b", character: "Red", level: 1, loginTime: 100, recordedAt: 100 })).toBe(false);
    store.addMessage("b-1", "m1");
    store.addMessage("unknown", "m2");
    store.flush();
    const text = readFileSync(file, "utf8");
    expect(text).not.toMatch(/accountId|\bip\b/);
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    const reloaded = new ActivityStore({ file, logger: silentLogger });
    expect(reloaded.get("b-1")?.messageIds).toEqual(["m1"]);
    expect(reloaded.expire(50)).toEqual(["m2"]);
    expect(reloaded.size).toBe(1);
    expect(reloaded.expire(101)).toEqual(["m1"]);
    expect(reloaded.size).toBe(0);
  });

  it("bounds the number of records and starts empty from a damaged file", () => {
    const file = join(tempDir(), "activity.json");
    const store = new ActivityStore({ file, logger: silentLogger, maxRecords: 2 });
    for (let index = 1; index <= 3; index++) {
      store.add({ sessionId: `s${index}`, bootId: "b", character: "Red", level: 1, recordedAt: index, messageIds: [`m${index}`] });
    }
    expect(store.size).toBe(2);
    expect(store.get("s1")).toBeUndefined();
    expect(store.expire(0)).toEqual(["m1"]);
    writeFileSync(file, "{broken");
    expect(new ActivityStore({ file, logger: silentLogger }).size).toBe(0);
  });
});

describe("activity log", () => {
  it("posts a login embed with all fields to the private channel", async () => {
    const { log, queue, sink, fields, lines, store } = setup();
    log.handleLogin(envelope(login()));
    await queue.idle();
    expect(sink.sent).toHaveLength(1);
    expect(sink.sent[0]!.message.embeds![0]!.title).toBe("Login");
    expect(fields()).toMatchObject({
      Character: "Red Trainer",
      Level: "25",
      Account: "#42",
      Time: "<t:1700000000:f>",
      "IP address": `\`${IP}\``,
      Location: "GeoIP disabled",
      "Players online": "3",
      Client: "OTClient (Windows), protocol 1098",
      Session: "boot1-s1",
    });
    expect(sink.sent[0]!.message.embeds![0]!.footer!.text).toMatch(/Kept 30 days/);
    expect(store.get("boot1-s1")?.messageIds).toEqual([sink.sent[0]!.id]);
    expect(lines.join("\n")).not.toContain(IP);
  });

  it("masks or hides the IP address by config", async () => {
    const masked = setup({ ipMode: "masked" });
    masked.log.handleLogin(envelope(login()));
    await masked.queue.idle();
    expect(masked.fields()["IP address"]).toBe("81.2.x.x");
    expect(JSON.stringify(masked.sink.sent)).not.toContain(IP);

    const hidden = setup({ ipMode: "hidden" });
    hidden.log.handleLogin(envelope(login()));
    await hidden.queue.idle();
    expect(hidden.fields()["IP address"]).toBeUndefined();
    expect(hidden.fields().Location).toBeUndefined();
    expect(JSON.stringify(hidden.sink.sent)).not.toContain("81.2");
  });

  it("shows the approximate location and private addresses", async () => {
    const file = join(tempDir(), "geo.mmdb");
    writeMmdb(file, [{ cidr: "81.2.69.0/24", data: { city: { names: { en: "London" } }, country: { names: { en: "United Kingdom" } } } }]);
    const { log, queue, fields } = setup({ geo: GeoIp.open(file, silentLogger) });
    log.handleLogin(envelope(login()));
    log.handleLogin(envelope(login({ sessionId: "boot1-s2", ip: "192.168.1.5" })));
    await queue.idle();
    expect(fields(0)["Location (approximate)"]).toBe("London, United Kingdom");
    expect(fields(1)["Location (approximate)"]).toBe("No location (private network)");
  });

  it("posts a logout with duration and the reported reason only", async () => {
    const { log, queue, sink, fields } = setup();
    log.handleLogin(envelope(login()));
    log.handleLogout(envelope(logout()));
    log.handleLogout(envelope(logout({ sessionId: "boot1-s9", reason: undefined })));
    await queue.idle();
    expect(sink.sent).toHaveLength(3);
    expect(fields(1)).toMatchObject({ Level: "26", "Session length": "1h 2m", Reason: "Logged out", "Players online": "2" });
    expect(fields(2).Reason).toBeUndefined();
  });

  it("ignores duplicate logins and logouts", async () => {
    const { log, queue, sink, metrics } = setup();
    log.handleLogin(envelope(login()));
    log.handleLogin(envelope(login()));
    log.handleLogout(envelope(logout()));
    log.handleLogout(envelope(logout()));
    await queue.idle();
    expect(sink.sent.map((item) => item.message.embeds![0]!.title)).toEqual(["Login", "Logout"]);
    expect(metrics.get("activity.duplicates")).toBe(2);
  });

  it("posts nothing while the channel is not private", async () => {
    const { log, queue, sink, guild, metrics, lines } = setup();
    guild.channels.find((channel) => channel.id === sink.id)!.overwrites.shift();
    log.handleLogin(envelope(login()));
    log.handleLogin(envelope(login({ sessionId: "boot1-s2" })));
    await queue.idle();
    expect(sink.sent).toHaveLength(0);
    expect(metrics.get("activity.blocked_not_private")).toBe(2);
    const errors = lines.filter((line) => line.includes("not private"));
    expect(errors).toHaveLength(1);
    expect(errors[0]).not.toContain(IP);

    guild.addRoleInfo({ name: "Everyone else" });
    guild.accessOverride.set(sink.id, { everyoneCanView: false, roles: [{ id: "1", name: "Members", administrator: false, ownBotRole: false }], members: [] });
    log.handleLogin(envelope(login({ sessionId: "boot1-s3" })));
    await queue.idle();
    expect(sink.sent).toHaveLength(0);
  });

  it("does not end sessions on a reconnect to the same server run", async () => {
    const { log, queue, sink, admin } = setup();
    log.handleLogin(envelope(login()));
    admin.sessionsResult = { sessions: [{ sessionId: "boot1-s1", character: "Red Trainer", level: 25 }], playersOnline: 1 };
    await log.reconcile("boot1");
    await queue.idle();
    expect(sink.sent).toHaveLength(1);
  });

  it("closes sessions from a previous server run as ended by restart", async () => {
    const { log, queue, sink, store } = setup();
    log.handleLogin(envelope(login()));
    await log.reconcile("boot2");
    await log.reconcile("boot2");
    await queue.idle();
    expect(sink.sent).toHaveLength(2);
    expect(sink.sent[1]!.message.embeds![0]!.title).toBe("Session ended by a server restart");
    expect(store.get("boot1-s1")?.ended).toBe("restart");
  });

  it("closes sessions the game no longer has and records unknown open sessions", async () => {
    const { log, queue, sink, admin, store } = setup();
    log.handleLogin(envelope(login()));
    admin.sessionsResult = { sessions: [{ sessionId: "boot1-s7", character: "Blue", level: 3 }], playersOnline: 1 };
    await log.reconcile("boot1");
    await queue.idle();
    expect(sink.sent[1]!.message.embeds![0]!.title).toBe("Session ended");
    expect(store.get("boot1-s1")?.ended).toBe("missed");
    expect(store.get("boot1-s7")).toMatchObject({ character: "Blue", bootId: "boot1" });
    log.handleLogin(envelope(login({ sessionId: "boot1-s7" })));
    await queue.idle();
    expect(sink.sent).toHaveLength(2);
  });

  it("keeps sessions open when the game cannot be asked", async () => {
    const { log, queue, sink, admin, store } = setup();
    log.handleLogin(envelope(login()));
    admin.connected = false;
    await log.reconcile("boot1");
    await queue.idle();
    expect(sink.sent).toHaveLength(1);
    expect(store.get("boot1-s1")?.ended).toBeUndefined();
  });

  it("survives a bot restart without duplicates and deletes expired messages", async () => {
    const file = join(tempDir(), "activity.json");
    let now = 1_700_000_000_000;
    const first = setup({ file, now: () => now });
    first.log.handleLogin(envelope(login()));
    await first.queue.idle();
    first.log.stop();

    const second = setup({ file, now: () => now });
    second.channels.channels.set("playerActivity", first.sink);
    second.guild.channels.splice(0, second.guild.channels.length, ...first.guild.channels);
    second.log.handleLogin(envelope(login()));
    second.log.handleLogout(envelope(logout()));
    await second.queue.idle();
    expect(first.sink.sent.map((item) => item.message.embeds![0]!.title)).toEqual(["Login", "Logout"]);

    now += 29 * 86_400_000;
    await second.log.enforceRetention();
    await second.queue.idle();
    expect(first.sink.deleted).toHaveLength(0);
    now += 2 * 86_400_000;
    await second.log.enforceRetention();
    await second.queue.idle();
    expect(first.sink.deleted).toEqual(first.sink.sent.map((item) => item.id));
    expect(second.store.size).toBe(0);
  });
});
