import { describe, expect, it } from "vitest";
import { LinkCommands } from "../../src/commands/linkCommands.js";
import type { CommandInput } from "../../src/commands/router.js";
import { LinkService } from "../../src/services/linking/linkService.js";
import { silentLogger } from "../../src/utils/logger.js";
import { Metrics } from "../../src/utils/metrics.js";
import {
  DEV_GUILD,
  FakeGuild,
  FakeLinkApi,
  LINKED_USER,
  linkSummary,
  makeStore,
  missingPermissionsError,
} from "../helpers/fakes.js";

const OTHER = "223456789012345678";

function setup(config: Partial<ConstructorParameters<typeof LinkService>[0]["config"]> = {}) {
  const guild = new FakeGuild();
  const store = makeStore();
  const links = new FakeLinkApi();
  const metrics = new Metrics();
  const verified = guild.addRoleInfo({ name: "Verified Trainer" });
  const premium = guild.addRoleInfo({ name: "Ace Trainer" });
  const unrelated = guild.addRoleInfo({ name: "Event Winner" });
  store.update((state) => {
    state.roles = { verified: verified.id, premium: premium.id };
  });
  const service = new LinkService({
    config: { verifiedRoleName: "Verified Trainer", premiumRoleEnabled: true, premiumRoleName: "Ace Trainer", nicknameSync: true, resyncMinutes: 0, ...config },
    links,
    guild: () => guild,
    store,
    logger: silentLogger,
    metrics,
  });
  let now = 1_700_000_000_000;
  const commands = new LinkCommands({
    links,
    service,
    roleNames: { verified: "Verified Trainer", premium: "Ace Trainer" },
    logger: silentLogger,
    metrics,
    now: () => now,
  });
  const member = guild.addMember(LINKED_USER, { roleIds: [unrelated.id] });
  const run = (commandName: string, options: Record<string, string> = {}, userId = LINKED_USER) =>
    commands.handle({
      commandName,
      options,
      guildId: DEV_GUILD,
      user: { id: userId, displayName: "Member", roleIds: [], manageGuild: false },
    } satisfies CommandInput);
  const press = (customId: string, userId = LINKED_USER) =>
    commands.handleComponent({ customId, guildId: DEV_GUILD, user: { id: userId, displayName: "Member", roleIds: [], manageGuild: false } });
  const text = (response: Awaited<ReturnType<typeof run>>) => response.message.content ?? response.message.embeds?.[0]?.description ?? "";
  return {
    guild, store, links, metrics, service, commands, member, run, press, text, verified, premium, unrelated,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("link service", () => {
  it("adds the Verified Trainer role and nickname, keeping other roles", async () => {
    const { service, member, verified, unrelated, store } = setup();
    const result = await service.sync(LINKED_USER, linkSummary(), "always");
    expect(result).toEqual({ memberFound: true, added: ["Verified Trainer"], removed: [], nickname: "set", problems: [] });
    expect(member.roleIds).toEqual([unrelated.id, verified.id]);
    expect(member.nickname).toBe("Red Trainer");
    expect(store.get().linkedMembers[LINKED_USER]).toBe("Red Trainer");
  });

  it("gives Ace Trainer only while the account has premium time", async () => {
    const { service, member, premium } = setup();
    await service.sync(LINKED_USER, linkSummary({ premium: true, premiumDays: 12 }));
    expect(member.roleIds).toContain(premium.id);
    const expired = await service.sync(LINKED_USER, linkSummary({ premium: false }));
    expect(expired.removed).toEqual(["Ace Trainer"]);
    expect(member.roleIds).not.toContain(premium.id);
  });

  it("never touches the premium role when it is disabled", async () => {
    const { service, member, premium } = setup({ premiumRoleEnabled: false });
    member.roleIds.push(premium.id);
    await service.sync(LINKED_USER, linkSummary({ premium: false }));
    expect(member.roleIds).toContain(premium.id);
  });

  it("is idempotent: a second sync makes no Discord calls", async () => {
    const { service, guild } = setup();
    await service.sync(LINKED_USER, linkSummary({ premium: true }), "always");
    const calls = guild.memberCalls.length;
    const again = await service.sync(LINKED_USER, linkSummary({ premium: true }), "always");
    expect(guild.memberCalls).toHaveLength(calls);
    expect(again).toMatchObject({ added: [], removed: [], nickname: "unchanged" });
  });

  it("leaves a nickname the member chose later alone on automatic syncs", async () => {
    const { service, member } = setup();
    await service.sync(LINKED_USER, linkSummary(), "always");
    member.nickname = "My Own Name";
    expect((await service.sync(LINKED_USER, linkSummary())).nickname).toBe("skipped");
    expect(member.nickname).toBe("My Own Name");
    // A new main (e.g. /main or a deleted main) is applied.
    await service.sync(LINKED_USER, linkSummary({ main: { name: "Blue Trainer", level: 10 } }));
    expect(member.nickname).toBe("Blue Trainer");
    member.nickname = "Mine Again";
    await service.sync(LINKED_USER, linkSummary({ main: { name: "Blue Trainer", level: 10 } }), "always");
    expect(member.nickname).toBe("Blue Trainer");
  });

  it("truncates nicknames to 32 characters and respects NICKNAME_SYNC=false", async () => {
    const long = "A".repeat(40);
    const on = setup();
    await on.service.sync(LINKED_USER, linkSummary({ main: { name: long, level: 1 } }), "always");
    expect(on.member.nickname).toBe("A".repeat(32));
    const off = setup({ nicknameSync: false });
    await off.service.sync(LINKED_USER, linkSummary(), "always");
    expect(off.member.nickname).toBeNull();
    expect(off.guild.memberCalls.some((call) => call.startsWith("nick"))).toBe(false);
  });

  it("on unlink removes only its roles and resets only the nickname it set", async () => {
    const { service, member, unrelated, premium, store } = setup();
    await service.sync(LINKED_USER, linkSummary({ premium: true }), "always");
    const result = await service.sync(LINKED_USER, undefined);
    expect(result.removed).toEqual(["Verified Trainer", "Ace Trainer"]);
    expect(result.nickname).toBe("reset");
    expect(member.roleIds).toEqual([unrelated.id]);
    expect(member.nickname).toBeNull();
    expect(store.get().linkedMembers[LINKED_USER]).toBeUndefined();

    await service.sync(LINKED_USER, linkSummary(), "always");
    member.nickname = "Custom";
    await service.sync(LINKED_USER, undefined);
    expect(member.nickname).toBe("Custom");
    expect(member.roleIds).not.toContain(premium.id);
  });

  it("reports missing permissions and unmanageable members without failing", async () => {
    const { service, guild, member } = setup();
    guild.failMemberOps.push(missingPermissionsError());
    member.nicknameManageable = false;
    const result = await service.sync(LINKED_USER, linkSummary(), "always");
    expect(result.added).toEqual([]);
    expect(result.problems).toHaveLength(2);
    expect(result.problems[0]).toMatch(/cannot give the "Verified Trainer" role/);
    expect(result.problems[1]).toMatch(/cannot change your nickname/);

    const other = setup();
    other.guild.failMemberOps.push(undefined, missingPermissionsError());
    const nick = await other.service.sync(LINKED_USER, linkSummary(), "always");
    expect(nick.added).toEqual(["Verified Trainer"]);
    expect(nick.problems[0]).toMatch(/Manage Nicknames/);
  });

  it("explains roles that are not set up and rethrows unexpected errors", async () => {
    const { service, store, guild } = setup();
    store.update((state) => {
      state.roles = {};
    });
    expect((await service.sync(LINKED_USER, linkSummary())).problems[0]).toMatch(/not set up yet/);
    const broken = setup();
    broken.guild.failMemberOps.push(new Error("network"));
    await expect(broken.service.sync(LINKED_USER, linkSummary())).rejects.toThrow("network");
    expect(guild.memberCalls.filter((call) => call.startsWith("add"))).toHaveLength(0);
  });

  it("skips members who are not in the server", async () => {
    const { service, guild } = setup();
    const result = await service.sync(OTHER, linkSummary({ discordUserId: OTHER }));
    expect(result.memberFound).toBe(false);
    expect(guild.memberCalls).toHaveLength(0);
  });

  it("resyncs every link page by page and cleans up links removed in the game", async () => {
    const { service, links, guild, store, member, verified } = setup();
    for (let index = 0; index < 205; index++) {
      links.link(String(300000000000000000n + BigInt(index)));
    }
    links.link(LINKED_USER, { link: linkSummary({ premium: true }) });
    expect(await service.resyncAll()).toBe(206);
    expect(links.calls.filter((call) => call === "link.list")).toHaveLength(2);
    expect(member.roleIds).toContain(verified.id);

    guild.addMember(OTHER, { roleIds: [verified.id] });
    store.update((state) => {
      state.linkedMembers[OTHER] = "";
    });
    links.accounts.delete(LINKED_USER);
    await service.resyncAll();
    expect(member.roleIds).not.toContain(verified.id);
    expect(guild.members.get(OTHER)!.roleIds).toEqual([]);
    expect(store.get().linkedMembers).toEqual({});
  });

  it("does nothing while the game does not support linking", async () => {
    const { service, links } = setup();
    links.features.clear();
    expect(service.available).toBe(false);
    expect(await service.resyncAll()).toBe(0);
    links.connected = false;
    expect(service.available).toBe(false);
  });
});

describe("/link", () => {
  it("links with a valid code, gives the role and sets the nickname", async () => {
    const { run, text, links, member, verified } = setup();
    links.addCode("ABCD-2345");
    const response = await run("link", { code: " abcd 2345 " });
    expect(response.ephemeral).toBe(true);
    expect(text(response)).toMatch(/now linked/);
    expect(text(response)).toMatch(/Main character: \*\*Red Trainer\*\*/);
    expect(text(response)).toMatch(/Roles given: Verified Trainer/);
    expect(member.roleIds).toContain(verified.id);
    expect(member.nickname).toBe("Red Trainer");
    expect(links.accounts.get(LINKED_USER)?.link.discordUserId).toBe(LINKED_USER);
  });

  it("maps game errors to clear messages and never calls the game for malformed codes", async () => {
    const { run, text, links } = setup();
    expect(text(await run("link", { code: "x" }))).toMatch(/8-character code/);
    expect(text(await run("link", { code: "ABCD;1234" }))).toMatch(/8-character code/);
    expect(links.calls).toEqual([]);
    expect(text(await run("link", { code: "ZZZZ-9999" }))).toMatch(/not valid/);
    for (const [code, pattern] of [
      ["expired", /expired/],
      ["locked", /Too many wrong codes/],
      ["account_linked", /already linked to another Discord account/],
      ["disabled", /disabled/],
    ] as const) {
      links.failNext.push(code);
      expect(text(await run("link", { code: "ABCD-2345" }, OTHER))).toMatch(pattern);
    }
  });

  it("refuses a second link and rate-limits attempts", async () => {
    const { run, text, links } = setup();
    links.link(LINKED_USER);
    expect(text(await run("link", { code: "ABCD-2345" }))).toMatch(/already linked/);
    for (let attempt = 0; attempt < 3; attempt++) {
      await run("link", { code: "ABCD-2345" });
    }
    expect(text(await run("link", { code: "ABCD-2345" }))).toMatch(/already linked/);
    expect(text(await run("link", { code: "ABCD-2345" }))).toMatch(/Too many link attempts/);
  });

  it("reports an offline game or a game without linking", async () => {
    const offline = setup();
    offline.links.connected = false;
    expect(offline.text(await offline.run("account"))).toMatch(/offline/);
    const old = setup();
    old.links.features.clear();
    expect(old.text(await old.run("account"))).toMatch(/not available/);
  });
});

describe("/unlink", () => {
  it("asks for confirmation with buttons only the owner can use", async () => {
    const { run, press, text, links, member, verified } = setup();
    links.link(LINKED_USER);
    await run("sync");
    const prompt = await run("unlink");
    const buttons = prompt.message.buttons!;
    expect(buttons.map((button) => button.label)).toEqual(["Unlink", "Cancel"]);
    expect(links.accounts.has(LINKED_USER)).toBe(true);

    expect(text(await press(buttons[0]!.customId, OTHER))).toMatch(/not for you/);
    expect(text(await press(buttons[1]!.customId))).toMatch(/Nothing was changed/);
    expect(links.accounts.has(LINKED_USER)).toBe(true);

    expect(text(await press(buttons[0]!.customId))).toMatch(/no longer linked/);
    expect(links.accounts.has(LINKED_USER)).toBe(false);
    expect(member.roleIds).not.toContain(verified.id);
    expect(member.nickname).toBeNull();
  });

  it("expires the confirmation after 60 seconds", async () => {
    const { run, press, text, links, advance } = setup();
    links.link(LINKED_USER);
    const prompt = await run("unlink");
    advance(61_000);
    expect(text(await press(prompt.message.buttons![0]!.customId))).toMatch(/expired/);
    expect(links.accounts.has(LINKED_USER)).toBe(true);
  });

  it("tells unlinked users how to link", async () => {
    const { run, text } = setup();
    expect(text(await run("unlink"))).toMatch(/!discord link/);
  });
});

describe("/account, /characters, /main, /sync", () => {
  it("shows the private account summary with premium and sync state", async () => {
    const { run, links } = setup();
    links.link(LINKED_USER, { link: linkSummary({ premium: true, premiumDays: 9 }) });
    const response = await run("account");
    expect(response.ephemeral).toBe(true);
    const fields = Object.fromEntries(response.message.embeds![0]!.fields!.map((field) => [field.name, field.value]));
    expect(fields).toMatchObject({ "Main character": "Red Trainer (level 25, Trainer)", Characters: "2", Premium: "Yes (9 days left)" });
    expect(fields["Discord sync"]).toMatch(/up to date/);
    expect(JSON.stringify(response)).not.toMatch(/accountId|"ip"/);
  });

  it("lists characters with the main and online tags", async () => {
    const { run, links } = setup();
    links.link(LINKED_USER);
    const description = (await run("characters")).message.embeds![0]!.description!;
    expect(description).toBe("**Red Trainer**: level 25, Trainer (main)\n**Blue Trainer**: level 10 (online)");
  });

  it("changes the main to an owned character only and updates the nickname", async () => {
    const { run, text, links, member, commands } = setup();
    links.link(LINKED_USER);
    expect(text(await run("main", { character: "Somebody Else" }))).toMatch(/not on your linked account/);
    expect(text(await run("main", { character: "blue trainer" }))).toMatch(/Main character set to \*\*Blue Trainer\*\*/);
    expect(member.nickname).toBe("Blue Trainer");
    expect(await commands.autocompleteMain(LINKED_USER, "red")).toEqual([{ name: "Red Trainer (level 25)", value: "Red Trainer" }]);
    expect(await commands.autocompleteMain(OTHER, "")).toEqual([]);
  });

  it("syncs on request, with its own rate limit", async () => {
    const { run, text, links } = setup();
    links.link(LINKED_USER);
    expect(text(await run("sync"))).toMatch(/Synced\.\nRoles given: Verified Trainer\nNickname updated/);
    expect(text(await run("sync"))).toBe("Everything was already up to date.");
    expect(text(await run("sync"))).toMatch(/too quickly/);
  });

  it("removes stale roles when a user runs /sync after an unlink in the game", async () => {
    const { run, text, links, member, verified, service } = setup();
    links.link(LINKED_USER);
    await service.sync(LINKED_USER, linkSummary(), "always");
    links.accounts.delete(LINKED_USER);
    expect(text(await run("sync"))).toMatch(/not linked/);
    expect(member.roleIds).not.toContain(verified.id);
  });

  it("treats not_linked errors as not linked", async () => {
    const { run, text, links } = setup();
    expect(text(await run("main", { character: "Red Trainer" }))).toMatch(/not linked/);
    links.failNext.push("not_linked");
    expect(text(await run("characters"))).toMatch(/not linked/);
  });
});
