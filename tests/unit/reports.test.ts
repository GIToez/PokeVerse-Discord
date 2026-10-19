import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ReportApi } from "../../src/integrations/pokeverse/gameApi.js";
import { gameEventSchema, type GameReport, type ReportEvent } from "../../src/integrations/pokeverse/protocol.js";
import { forumTagsFor } from "../../src/services/reports/reportKinds.js";
import { buildReportEmbed, postName, ReportForums, SCREENSHOT_SLICE, updateLine } from "../../src/services/reports/reportForums.js";
import { ChannelSetup } from "../../src/setup/channelSetup.js";
import { ADMIN_CATEGORY_NAME, CATEGORY_NAME } from "../../src/setup/channels.js";
import { DeliveryQueue } from "../../src/utils/deliveryQueue.js";
import { silentLogger } from "../../src/utils/logger.js";
import { Metrics } from "../../src/utils/metrics.js";
import { StateStore } from "../../src/utils/stateStore.js";
import { BOT_USER, EVERYONE, FakeChannels, FakeForum, FakeGuild, envelope, makeConfig, tempDir } from "../helpers/fakes.js";

const STAFF_ROLE = "800000000000000001";
const REPORTER = "900000000000000001";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20000, 7)]);

function bugReport(overrides: Partial<GameReport> = {}): GameReport {
  return {
    id: 12,
    kind: "bug",
    kindName: "Bug",
    category: "map",
    categoryName: "Map",
    status: "open",
    statusName: "Open",
    closed: false,
    title: "Stuck between two rocks east of the Pokemon Center",
    description: "I walked east from the Pokemon Center and got stuck between two rocks.",
    reporter: { name: "Ash", level: 50, vocation: "Hunter", discordUserId: REPORTER },
    position: { x: 3290, y: 800, z: 7 },
    area: "near Pallet, Kanto",
    client: "linux, version 3.1.2",
    createdAt: 1_790_000_000,
    ...overrides,
  };
}

function playerReport(overrides: Partial<GameReport> = {}): GameReport {
  return bugReport({
    id: 13,
    kind: "player",
    kindName: "Player report",
    category: "harassment",
    categoryName: "Harassment or insults",
    title: "Threats in the Help channel",
    description: "Trainer kept insulting me in the Help channel.",
    target: { name: "Trainer", level: 30, online: true, position: { x: 3300, y: 810, z: 7 }, chat: [{ at: 1_790_000_000, text: "noob" }] },
    statement: "give me your pokemon or I will keep killing yours",
    ...overrides,
  });
}

function event(report: GameReport, action = "created", change?: ReportEvent["change"]): ReportEvent {
  return { kind: "report", ...(report.kind === "player" ? { scope: "admin" as const } : {}), action, report, change };
}

function fakeApi(png = PNG) {
  const encoded = png.toString("base64");
  const calls: string[] = [];
  const api: ReportApi & { connected: boolean; fail?: Error } = {
    connected: true,
    async setStatus(id, status, by) {
      calls.push(`setStatus ${id} ${status} ${by}`);
      if (api.fail) {
        throw api.fail;
      }
      return { id, status, changed: true };
    },
    async get() {
      return { found: false };
    },
    async screenshot(id, offset, length) {
      calls.push(`screenshot ${id} ${offset}`);
      return { found: true, done: true, total: encoded.length, offset, data: encoded.slice(offset, offset + Math.min(length, SCREENSHOT_SLICE)) };
    },
  };
  return { api, calls };
}

function setup(options: { private?: boolean; mention?: boolean } = {}) {
  const config = makeConfig(options.mention === false ? { REPORT_MENTION_REPORTER: "false" } : {});
  const store = new StateStore(join(tempDir(), "state.json"), "development");
  const channels = new FakeChannels();
  const bugs = FakeForum.withTags("600000000000000001", forumTagsFor("bug"));
  const players = FakeForum.withTags("600000000000000002", forumTagsFor("player"));
  channels.forums.set("bugReports", bugs);
  channels.forums.set("playerReports", players);
  store.update((state) => {
    state.channels.bugReports = bugs.id;
    state.channels.playerReports = players.id;
  });
  const guild = new FakeGuild();
  guild.accessOverride.set(players.id, {
    everyoneCanView: options.private === false,
    roles: [{ id: STAFF_ROLE, name: "Staff", administrator: false, ownBotRole: false }],
    members: [BOT_USER],
  });
  const metrics = new Metrics();
  const queue = new DeliveryQueue({ name: "reports", maxSize: 50, maxAttempts: 1, retryDelayMs: 1, logger: silentLogger, metrics });
  const { api, calls } = fakeApi();
  const forums = new ReportForums({
    config: config.reports,
    channels,
    guild: () => guild,
    policy: (botUserId) => ({ roleIds: [STAFF_ROLE], userIds: [], botUserId }),
    store,
    api,
    queue,
    logger: silentLogger,
    metrics,
  });
  return { forums, bugs, players, store, queue, metrics, api, calls };
}

describe("report forums: setup", () => {
  function reportsSetup() {
    const store = new StateStore(join(tempDir(), "state.json"), "development");
    const channelSetup = new ChannelSetup(store, silentLogger, {
      activity: { enabled: false, viewerRoleIds: [STAFF_ROLE], viewerUserIds: [] },
      reports: { bugs: true, players: true },
    });
    const guild = new FakeGuild();
    guild.permissions = [...guild.permissions, "ManageThreads"];
    guild.addRoleInfo({ id: STAFF_ROLE, name: "Staff" });
    return { store, channelSetup, guild };
  }

  it("creates a public bug forum and a private player forum with their tags", async () => {
    const { store, channelSetup, guild } = reportsSetup();
    const report = await channelSetup.run(guild);
    expect(report.ok).toBe(true);
    const main = guild.created.find((channel) => channel.name === CATEGORY_NAME)!;
    const admin = guild.created.find((channel) => channel.name === ADMIN_CATEGORY_NAME)!;
    const bugs = guild.created.find((channel) => channel.name === "bug-reports")!;
    const players = guild.created.find((channel) => channel.name === "player-reports")!;
    expect(bugs).toMatchObject({ kind: "forum", parentId: main.id });
    expect(players).toMatchObject({ kind: "forum", parentId: admin.id });
    expect(bugs.tagNames).toEqual(expect.arrayContaining(["Open", "Planned", "Fixed", "Map"]));
    expect(players.tagNames).toEqual(expect.arrayContaining(["Investigating", "Action taken", "Harassment"]));
    expect([...bugs.tagNames!, ...players.tagNames!].every((name) => name.length <= 20)).toBe(true);
    expect(players.overwrites).toContainEqual({ id: EVERYONE, type: "role", allow: [], deny: ["ViewChannel"] });
    expect(players.overwrites).toContainEqual({
      id: STAFF_ROLE,
      type: "role",
      allow: ["ViewChannel", "ReadMessageHistory", "SendMessagesInThreads", "ManageThreads"],
      deny: ["SendMessages"],
    });
    expect(bugs.overwrites).toContainEqual({ id: EVERYONE, type: "role", allow: [], deny: ["SendMessages"] });
    expect(store.getChannelId("bugReports")).toBe(bugs.id);
    expect(store.getChannelId("playerReports")).toBe(players.id);
  });

  it("adds the tags a forum lost and keeps the forum on a re-run", async () => {
    const { channelSetup, guild } = reportsSetup();
    await channelSetup.run(guild);
    const bugs = guild.channels.find((channel) => channel.name === "bug-reports")!;
    bugs.tagNames = bugs.tagNames!.filter((name) => name !== "Planned");
    const count = guild.channels.length;
    const report = await channelSetup.run(guild);
    expect(guild.channels).toHaveLength(count);
    expect(bugs.tagNames).toContain("Planned");
    expect(report.channels.find((channel) => channel.purpose === "bugReports")).toMatchObject({ action: "kept", updated: ["tags (Planned)"] });
  });

  it("needs Manage Threads only with a report forum", async () => {
    const off = new ChannelSetup(new StateStore(join(tempDir(), "state.json"), "development"), silentLogger);
    expect((await off.run(new FakeGuild())).missingGuildPermissions).not.toContain("ManageThreads");
    const { channelSetup } = reportsSetup();
    expect((await channelSetup.run(new FakeGuild())).missingGuildPermissions).toContain("ManageThreads");
  });
});

describe("report forums: posts", () => {
  it("posts a bug report with its tags, its spot and a ping for the linked reporter", async () => {
    const { forums, bugs, store, queue } = setup();
    expect(forums.handle(envelope(event(bugReport())))).toEqual({ action: "post" });
    await queue.idle();
    const post = bugs.post0();
    expect(post.postName).toBe("[#12] Stuck between two rocks east of the Pokemon Center");
    expect(bugs.tagNames(post)).toEqual(["Open", "Map"]);
    const first = post.sent[0]!.message;
    expect(first.content).toContain(`<@${REPORTER}>`);
    expect(first.mentionUserIds).toEqual([REPORTER]);
    const embed = first.embeds![0]!;
    expect(embed.fields).toContainEqual({ name: "Where", value: "`3290, 800, 7` near Pallet, Kanto", inline: true });
    expect(embed.fields!.find((field) => field.name === "Reporter")!.value).toContain("**Ash**, level 50, Hunter");
    expect(store.get().reportPosts["12"]).toMatchObject({ threadId: post.id, status: "open", category: "map" });
  });

  it("does not ping when REPORT_MENTION_REPORTER is off", async () => {
    const { forums, bugs, queue } = setup({ mention: false });
    forums.handle(envelope(event(bugReport())));
    await queue.idle();
    expect(bugs.post0().sent[0]!.message.mentionUserIds).toBeUndefined();
  });

  it("follows status changes: tags, a line that pings the reporter, archived when closed", async () => {
    const { forums, bugs, store, queue } = setup();
    forums.handle(envelope(event(bugReport())));
    await queue.idle();
    forums.handle(envelope(event(bugReport({ status: "planned", statusName: "Planned" }), "updated",
      { status: "planned", previousStatus: "open", note: "Next update", by: "Admin", source: "game" })));
    await queue.idle();
    const post = bugs.post0();
    expect(bugs.tagNames(post)).toEqual(["Planned", "Map"]);
    const line = post.sent.at(-1)!.message;
    expect(line.content).toBe(`<@${REPORTER}> 📌 **Admin** set it to **Planned**.\n> Next update`);
    expect(line.mentionUserIds).toEqual([REPORTER]);
    expect(post.archived).toBe(false);

    forums.handle(envelope(event(bugReport({ status: "fixed", statusName: "Fixed", closed: true }), "updated",
      { status: "fixed", previousStatus: "planned", by: "Admin", source: "game" })));
    await queue.idle();
    expect(bugs.tagNames(post)).toEqual(["Fixed", "Map"]);
    expect(post.archived).toBe(true);
    expect(store.get().reportPosts["12"]).toMatchObject({ status: "fixed", closed: true });
    expect(post.edits.at(-1)!.message.embeds![0]!.fields).toContainEqual({ name: "Status", value: "✅ Fixed", inline: true });
  });

  it("says who took a report and links merged reports", async () => {
    const { forums, bugs, queue } = setup();
    forums.handle(envelope(event(bugReport())));
    forums.handle(envelope(event(bugReport({ id: 14, title: "Rocks again" }))));
    await queue.idle();
    forums.handle(envelope(event(bugReport({ assignedTo: "Admin" }), "updated", { assignedTo: "Admin", by: "Admin", source: "game" })));
    forums.handle(envelope(event(bugReport({ id: 14, title: "Rocks again", status: "duplicate", closed: true, duplicateOf: 12 }), "updated",
      { status: "duplicate", previousStatus: "open", duplicateOf: 12, by: "Admin", source: "game" })));
    await queue.idle();
    const [original, duplicate] = [...bugs.posts.values()];
    expect(original!.contents()).toContain("🙋 **Admin** took this report.");
    expect(duplicate!.contents().at(-1)).toBe(`<@${REPORTER}> ♻️ **Admin** marked this as the same as #12 (<#${original!.id}>). Its reporter hears about that one from now on.`);
    expect(duplicate!.archived).toBe(true);
  });

  it("attaches the screenshot, read from the game in slices", async () => {
    const { forums, bugs, queue, calls } = setup();
    forums.handle(envelope(event(bugReport())));
    await queue.idle();
    forums.handle(envelope(event(bugReport({ screenshot: true }), "screenshot")));
    await queue.idle();
    const sent = bugs.post0().sent.at(-1)!.message;
    expect(sent.files).toHaveLength(1);
    expect(sent.files![0]!.name).toBe("report-12.png");
    expect(sent.files![0]!.data!.equals(PNG)).toBe(true);
    expect(sent.embeds![0]!.image).toEqual({ url: "attachment://report-12.png" });
    const slices = calls.filter((call) => call.startsWith("screenshot"));
    expect(slices.length).toBe(Math.ceil(PNG.toString("base64").length / SCREENSHOT_SLICE));
    expect(slices[1]).toBe(`screenshot 12 ${SCREENSHOT_SLICE}`);
  });

  it("drops a screenshot that is not a PNG", async () => {
    const { forums } = setup();
    const { api } = fakeApi(Buffer.from("not a png at all"));
    (forums as unknown as { options: { api: ReportApi } }).options.api = api;
    expect(await forums.fetchScreenshot(12)).toBeUndefined();
  });

  it("posts player reports only while the forum is private, and never pings", async () => {
    const closed = setup({ private: false });
    closed.forums.handle(envelope(event(playerReport())));
    await closed.queue.idle();
    expect(closed.players.posts.size).toBe(0);
    expect(closed.metrics.get("reports.blocked_not_private")).toBe(1);

    const open = setup();
    open.forums.handle(envelope(event(playerReport())));
    await open.queue.idle();
    const post = open.players.post0();
    expect(open.players.tagNames(post)).toEqual(["Open", "Harassment"]);
    const first = post.sent[0]!.message;
    expect(first.mentionUserIds).toBeUndefined();
    const fields = first.embeds![0]!.fields!;
    expect(fields.find((field) => field.name === "Reported player")!.value).toBe("**Trainer** (level 30, online)");
    expect(fields.find((field) => field.name === "Reported message")!.value).toContain("give me your pokemon");
    expect(fields.find((field) => field.name === "Their last channel messages")!.value).toContain("noob");
  });

  it("skips disabled kinds and repeated events", async () => {
    const config = makeConfig({ BUG_REPORTS_ENABLED: "false" });
    const { forums, queue, bugs } = setup();
    (forums as unknown as { options: { config: typeof config.reports } }).options.config = config.reports;
    expect(forums.handle(envelope(event(bugReport())))).toEqual({ action: "skip", reason: "disabled" });
    const repeated = envelope(event(playerReport()));
    expect(forums.handle(repeated)).toEqual({ action: "post" });
    expect(forums.handle(repeated)).toEqual({ action: "skip", reason: "duplicate" });
    await queue.idle();
    expect(bugs.posts.size).toBe(0);
  });
});

describe("report forums: status tags picked on Discord", () => {
  async function posted() {
    const context = setup();
    context.forums.handle(envelope(event(bugReport())));
    await context.queue.idle();
    const post = context.bugs.post0();
    const tag = (name: string) => context.bugs.tags().find((item) => item.name === name)!.id;
    return { ...context, post, tag };
  }

  it("answers the report in the game with the new status tag", async () => {
    const { forums, post, tag, calls, queue, store } = await posted();
    forums.handleTagsChanged({ threadId: post.id, tagIds: [tag("Open"), tag("Confirmed"), tag("Map")], by: "Misty" });
    await queue.idle();
    expect(calls).toContain("setStatus 12 confirmed Misty");
    expect(store.get().reportPosts["12"]!.status).toBe("confirmed");
  });

  it("ignores the bot's own tag changes", async () => {
    const { forums, post, tag, calls, queue } = await posted();
    forums.handleTagsChanged({ threadId: post.id, tagIds: [tag("Open"), tag("Map")] });
    await queue.idle();
    expect(calls.filter((call) => call.startsWith("setStatus"))).toEqual([]);
  });

  it("puts the status tag back when it is taken off or the game says no", async () => {
    const { forums, post, tag, queue, api, bugs } = await posted();
    forums.handleTagsChanged({ threadId: post.id, tagIds: [tag("Map")] });
    await queue.idle();
    expect(bugs.tagNames(post)).toEqual(["Open", "Map"]);

    api.fail = new Error("That status doesn't exist");
    forums.handleTagsChanged({ threadId: post.id, tagIds: [tag("Fixed"), tag("Map")], by: "Misty" });
    await queue.idle();
    expect(bugs.tagNames(post)).toEqual(["Open", "Map"]);
    expect(post.contents().at(-1)).toBe("⚠️ The game did not take the change. The status tag was put back.");

    api.fail = undefined;
    api.connected = false;
    forums.handleTagsChanged({ threadId: post.id, tagIds: [tag("Fixed"), tag("Map")] });
    await queue.idle();
    expect(post.contents().at(-1)).toBe("⚠️ The game is offline, so the report was not changed. The status tag was put back.");
  });

  it("does nothing with REPORT_TAG_SYNC off", async () => {
    const { forums, post, tag, calls, queue } = await posted();
    (forums as unknown as { options: { config: { tagSync: boolean } } }).options.config.tagSync = false;
    forums.handleTagsChanged({ threadId: post.id, tagIds: [tag("Fixed"), tag("Map")] });
    await queue.idle();
    expect(calls.filter((call) => call.startsWith("setStatus"))).toEqual([]);
  });
});

describe("report protocol", () => {
  it("parses the game's report event", () => {
    const parsed = gameEventSchema.parse({
      kind: "report",
      scope: "admin",
      action: "updated",
      report: {
        ...playerReport(),
        reporter: { name: "Ash", level: 50 },
        assignedTo: "Admin",
        duplicates: 2,
        screenshot: false,
      },
      change: { assignedTo: "Admin", by: "Admin", source: "game" },
    });
    expect(parsed.kind).toBe("report");
  });

  it("names posts and lines plainly", () => {
    expect(postName({ id: 3, title: "x".repeat(200) })).toHaveLength(100);
    expect(buildReportEmbed(bugReport({ title: "Uses *bots*" })).title).toBe("🐞 Uses *bots*");
    expect(updateLine(event(bugReport(), "updated", { note: "Thanks", by: "GM_Ash", source: "discord" }), () => undefined))
      .toBe("💬 **GM\\_Ash** on Discord:\n> Thanks");
  });
});
