import { z } from "zod";

/**
 * Wire protocol of the game-side Discord bridge (PokeVerse repository,
 * docs/discord-bridge.md). Protocol version 1.
 */
export const PROTOCOL_VERSION = 1;
export const MAX_LINE_BYTES = 64 * 1024;

export const helloSchema = z.object({ type: z.literal("hello"), protocol: z.number(), nonce: z.string().regex(/^[0-9a-f]{16,128}$/) });
export const welcomeSchema = z.object({
  type: z.literal("welcome"),
  protocol: z.number(),
  bootId: z.string(),
  serverName: z.string(),
  queued: z.number(),
  /** Optional protocol parts the server has switched on; absent on servers built before them. */
  features: z.array(z.string()).optional(),
});

export const FEATURES = {
  playerSessions: "playerSessions",
  accountLinking: "accountLinking",
  boosterRewards: "boosterRewards",
  boostPerks: "boostPerks",
  /** Every server-wide broadcast comes as an `announcement` event; staff broadcasts no longer need `broadcast`. */
  announcements: "announcements",
  /** `calendar.range` lists the game's calendar events. */
  calendar: "calendar",
  /** The Counselor and Staff channels: `staff_chat` events and `chat.staff`. */
  staffChat: "staffChat",
} as const;
export const errorSchema = z.object({ type: z.literal("error"), code: z.string() });

/** The game's JSON encoder writes an empty list as {}. */
const emptyList = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0 ? [] : value;

const position = z.object({ x: z.number(), y: z.number(), z: z.number() });

export const chatEventSchema = z.object({
  kind: z.literal("chat"),
  channelId: z.number(),
  author: z.string(),
  level: z.number().optional(),
  text: z.string(),
});

/** The in-game staff channels: "tutors" is Counselor (Tutor and up), "gamemasters" is Staff (Gamemaster and up). */
export const STAFF_ROOMS = ["tutors", "gamemasters"] as const;
export type StaffRoom = (typeof STAFF_ROOMS)[number];

/** A line in an in-game staff channel. Its own kind, so a bot that doesn't know it never posts it in #game-chat. */
export const staffChatEventSchema = z.object({
  kind: z.literal("staff_chat"),
  scope: z.literal("admin"),
  room: z.enum(STAFF_ROOMS),
  channelId: z.number().optional(),
  author: z.string(),
  level: z.number().optional(),
  text: z.string(),
});

export const catchEventSchema = z.object({
  kind: z.literal("catch"),
  trainer: z.string(),
  species: z.string(),
  baseSpecies: z.string(),
  dexNumber: z.number().nullish(),
  level: z.number(),
  sex: z.number().nullish(),
  shiny: z.boolean(),
  legendary: z.boolean(),
  extraPoints: z.number().nullish(),
  ball: z.string().nullish(),
  safari: z.boolean().optional(),
});

export const spawnEventSchema = z.object({
  kind: z.literal("spawn"),
  species: z.string(),
  baseSpecies: z.string(),
  dexNumber: z.number().nullish(),
  level: z.number().nullish(),
  shiny: z.boolean(),
  legendary: z.boolean(),
  source: z.string(),
  startup: z.boolean().optional(),
  creatureId: z.number(),
  position: position.optional(),
  nearestTown: z.string().nullish(),
});

/**
 * Wild legendaries (game: 078-wildLegendaries.lua). One `encounterId` per legendary, from
 * its spawn to its end, so the bot can keep one thread per encounter.
 */
export const LEGENDARY_EVENTS = [
  "spawn", "sighting", "flee", "end", "caught",
  /** Signs before a spawn (Mewtwo's psychic disturbance); no encounter yet. */
  "sign",
  /** A set appearing together (the birds, the beasts, the sleeping Regis): `members`, one encounter each. */
  "set",
  /** A trainer woke a sleeping Regi (`trainer`). */
  "woke",
  /** Mew showed its true self (`trainer`, `disguise`). */
  "revealed",
  /** Two legendaries met (`other`, `otherEncounterId`, `text`), or Rayquaza is coming to calm them (`calm`). */
  "clash",
  "calm",
  /** A legendary given by a quest or an NPC (`trainer`); no encounter. */
  "reward",
] as const;
export const LEGENDARY_END_REASONS = ["defeated", "fled", "staff", "restart", "vanished"] as const;

const legendaryMemberSchema = z.object({
  encounterId: z.number(),
  species: z.string(),
  dexNumber: z.number().nullish(),
  tier: z.number().nullish(),
  area: z.string().nullish(),
  position: position.nullish(),
  endsAt: z.number().nullish(),
});

export const legendaryEventSchema = z.object({
  kind: z.literal("legendary"),
  event: z.enum(LEGENDARY_EVENTS),
  encounterId: z.number().nullish(),
  species: z.string(),
  dexNumber: z.number().nullish(),
  tier: z.number().nullish(),
  area: z.string().nullish(),
  position: position.nullish(),
  nearestTown: z.string().nullish(),
  /** Unix seconds when it flies off if nobody beats it (spawn). */
  endsAt: z.number().nullish(),
  /** "schedule", "staff" or "test" (spawn). */
  source: z.string().nullish(),
  health: z.number().nullish(),
  healthPercent: z.number().nullish(),
  /** Unknown future reasons are kept as plain strings. */
  reason: z.string().nullish(),
  trainers: z.preprocess(emptyList, z.array(z.string()).nullish()),
  topTrainer: z.string().nullish(),
  trainer: z.string().nullish(),
  /** Recommended trainer level (spawn, set, woke). */
  level: z.number().nullish(),
  /** A set member's spawn, or the set itself. */
  setId: z.string().nullish(),
  setName: z.string().nullish(),
  /** Sleeping until a trainer wakes it (spawn, set). */
  asleep: z.boolean().nullish(),
  members: z.preprocess(emptyList, z.array(legendaryMemberSchema).nullish()),
  /** What Mew was hiding as (revealed). */
  disguise: z.string().nullish(),
  /** The other legendary of a clash, and its encounter. */
  other: z.string().nullish(),
  otherEncounterId: z.number().nullish(),
  /** The line players saw in game. */
  text: z.string().nullish(),
});

/**
 * Every server-wide broadcast (game: 092-announcements.lua), the same data as the news banner.
 * Tips never come here.
 */
export const ANNOUNCEMENT_CATEGORIES = ["event", "legendary", "server", "staff", "milestone", "news"] as const;
export type GameAnnouncementCategory = (typeof ANNOUNCEMENT_CATEGORIES)[number];

export const announcementEventSchema = z.object({
  kind: z.literal("announcement"),
  /** Unknown future categories are posted as news. */
  category: z.string(),
  title: z.string().nullish(),
  text: z.string(),
  /** The broadcast as players saw it in game. */
  full: z.string().nullish(),
  /** The game script that sent it, like "077-eventCalendar". */
  source: z.string().nullish(),
  /** The staff member, for staff broadcasts. */
  author: z.string().nullish(),
  /**
   * Picked by staff: "everyone", "here", "verified" or a role name. The game already dropped
   * "everyone" and "here" for staff below Gamemaster.
   */
  ping: z.string().nullish(),
  /** A calendar event starting or ending. */
  calendar: z
    .object({
      key: z.string(),
      id: z.string(),
      state: z.string(),
      /** "holiday", "server" (the weekend events) or "staff" (added with /calendar). */
      type: z.string(),
    })
    .nullish(),
});

export const broadcastEventSchema = z.object({
  kind: z.literal("broadcast"),
  source: z.string(),
  author: z.string().nullish(),
  text: z.string(),
});

export const RESTART_REASONS = ["daily", "staff", "update"] as const;
export type RestartReason = (typeof RESTART_REASONS)[number];

export const restartWarningEventSchema = z.object({
  kind: z.literal("restart_warning"),
  reason: z.string(),
  minutes: z.number().nullish(),
  shutdown: z.boolean().optional(),
});

export const serverStateEventSchema = z.object({
  kind: z.literal("server_state"),
  state: z.string(),
  players: z.number().optional(),
});

/** Admin-only: contains the account id and (optionally) the IP address. */
export const playerLoginEventSchema = z.object({
  kind: z.literal("player_login"),
  scope: z.literal("admin"),
  sessionId: z.string().min(1),
  character: z.string(),
  level: z.number(),
  accountId: z.number(),
  loginTime: z.number(),
  ip: z.string().optional(),
  clientOs: z.string().optional(),
  clientVersion: z.number().optional(),
  playersOnline: z.number().optional(),
});

export const playerLogoutEventSchema = z.object({
  kind: z.literal("player_logout"),
  scope: z.literal("admin"),
  sessionId: z.string().min(1),
  character: z.string(),
  level: z.number(),
  accountId: z.number(),
  loginTime: z.number(),
  logoutTime: z.number(),
  duration: z.number(),
  reason: z.string().optional(),
  playersOnline: z.number().optional(),
});

const discordUserId = z.string().regex(/^\d{17,20}$/);

export const accountLinkEventSchema = z.object({
  kind: z.literal("account_link"),
  scope: z.literal("account"),
  action: z.string(),
  source: z.string().optional(),
  discordUserId,
});

export const accountCharactersEventSchema = z.object({
  kind: z.literal("account_characters"),
  scope: z.literal("account"),
  discordUserId,
  change: z.string(),
  character: z.string(),
});

/** One in-game report (083-reports.lua). Player reports are admin-scoped. */
export const reportSchema = z.object({
  id: z.number().int().positive(),
  kind: z.string(),
  kindName: z.string().optional(),
  category: z.string(),
  categoryName: z.string().optional(),
  status: z.string(),
  statusName: z.string().optional(),
  closed: z.boolean().optional(),
  title: z.string(),
  description: z.string(),
  reporter: z.object({
    name: z.string(),
    level: z.number().optional(),
    vocation: z.string().nullish(),
    discordUserId: discordUserId.nullish(),
  }),
  position: position.nullish(),
  area: z.string().nullish(),
  pokemon: z.string().nullish(),
  client: z.string().nullish(),
  target: z
    .object({
      name: z.string(),
      level: z.number().nullish(),
      online: z.boolean().nullish(),
      position: position.nullish(),
      /** Their last channel lines before the report. */
      chat: z.array(z.object({ at: z.number(), text: z.string() })).nullish(),
    })
    .nullish(),
  statement: z.string().nullish(),
  createdAt: z.number(),
  updatedAt: z.number().optional(),
  /** The staff member who took it. */
  assignedTo: z.string().nullish(),
  /** The report this one repeats. */
  duplicateOf: z.number().int().nullish(),
  /** How many reports were merged into this one. */
  duplicates: z.number().int().optional(),
  /** A screenshot is stored; "report.screenshot" reads it. */
  screenshot: z.boolean().optional(),
});

export const reportEventSchema = z.object({
  kind: z.literal("report"),
  scope: z.literal("admin").optional(),
  action: z.string(),
  report: reportSchema,
  change: z
    .object({
      status: z.string().optional(),
      previousStatus: z.string().optional(),
      note: z.string().nullish(),
      by: z.string().optional(),
      source: z.string().optional(),
      assignedTo: z.string().nullish(),
      /** This report was merged into that one. */
      duplicateOf: z.number().int().optional(),
      /** That report was merged into this one. */
      duplicate: z.number().int().optional(),
    })
    .nullish(),
});

export const gameEventSchema = z.discriminatedUnion("kind", [
  chatEventSchema,
  staffChatEventSchema,
  catchEventSchema,
  spawnEventSchema,
  legendaryEventSchema,
  announcementEventSchema,
  broadcastEventSchema,
  restartWarningEventSchema,
  serverStateEventSchema,
  playerLoginEventSchema,
  playerLogoutEventSchema,
  accountLinkEventSchema,
  accountCharactersEventSchema,
  reportEventSchema,
]);

export const eventEnvelopeSchema = z.object({
  type: z.literal("event"),
  id: z.string().min(1),
  time: z.number(),
  event: z.object({ kind: z.string() }).passthrough(),
});

export const responseSchema = z.object({
  type: z.literal("response"),
  requestId: z.string(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string().optional() }).optional(),
});

export type ChatEvent = z.infer<typeof chatEventSchema>;
export type StaffChatEvent = z.infer<typeof staffChatEventSchema>;
export type CatchEvent = z.infer<typeof catchEventSchema>;
export type SpawnEvent = z.infer<typeof spawnEventSchema>;
export type LegendaryEvent = z.infer<typeof legendaryEventSchema>;
export type AnnouncementEvent = z.infer<typeof announcementEventSchema>;
export type LegendaryMember = z.infer<typeof legendaryMemberSchema>;
export type BroadcastEvent = z.infer<typeof broadcastEventSchema>;
export type RestartWarningEvent = z.infer<typeof restartWarningEventSchema>;
export type ServerStateEvent = z.infer<typeof serverStateEventSchema>;
export type PlayerLoginEvent = z.infer<typeof playerLoginEventSchema>;
export type PlayerLogoutEvent = z.infer<typeof playerLogoutEventSchema>;
export type AccountLinkEvent = z.infer<typeof accountLinkEventSchema>;
export type AccountCharactersEvent = z.infer<typeof accountCharactersEventSchema>;
export type ReportEvent = z.infer<typeof reportEventSchema>;
export type GameReport = z.infer<typeof reportSchema>;
export type GameEvent = z.infer<typeof gameEventSchema>;

export interface GameEventEnvelope<E extends GameEvent = GameEvent> {
  id: string;
  /** Unix seconds when the game emitted the event. */
  time: number;
  /** Boot id of the game server run that produced the event. */
  bootId: string;
  event: E;
}

// Request results -------------------------------------------------------------

const cardPokemonSchema = z.object({
  name: z.string(),
  level: z.number(),
  sex: z.string().nullish(),
  number: z.number().nullish(),
  shiny: z.boolean().nullish(),
  types: z.array(z.string()).optional(),
});

export const trainerCardSchema = z.object({
  title: z.string(),
  about: z.string().optional(),
  since: z.number().optional(),
  vocation: z
    .object({ key: z.string(), name: z.string(), rank: z.number(), maxRank: z.number(), title: z.string().nullish() })
    .optional(),
  favorite: cardPokemonSchema.optional(),
  trophies: z.array(cardPokemonSchema).optional(),
  playTime: z.number().optional(),
  dex: z.object({ seen: z.number(), total: z.number() }).optional(),
  badges: z.array(z.object({ region: z.string(), earned: z.array(z.string()), total: z.number() })).optional(),
  /** What the trainer's privacy settings keep off their card: playTime, stats, trophies. */
  hidden: z.array(z.string()).optional(),
});

export const trainerResultSchema = z.union([
  z.object({ found: z.literal(false) }),
  z.object({
    found: z.literal(true),
    name: z.string(),
    level: z.number(),
    vocation: z.string().nullish(),
    guild: z.string().nullish(),
    online: z.boolean(),
    caught: z.number(),
    uniqueCaught: z.number(),
    shinyCaught: z.number(),
    duelWins: z.number(),
    duelLosses: z.number(),
    playersDefeated: z.number(),
    tournamentsWon: z.number(),
    achievements: z.object({ earned: z.number(), total: z.number(), recent: z.array(z.string()) }),
    mastery: z.string().nullish(),
    /** The Trainer Card; game servers from before it leave it out. */
    card: trainerCardSchema.optional(),
  }),
]);

export const pokemonResultSchema = z.union([
  z.object({ found: z.literal(false) }),
  z.object({
    found: z.literal(true),
    name: z.string(),
    baseSpecies: z.string(),
    dexNumber: z.number().nullish(),
    generation: z.number().nullish(),
    types: z.array(z.string()),
    stats: z.object({
      attack: z.number().nullish(),
      defense: z.number().nullish(),
      specialAttack: z.number().nullish(),
      specialDefense: z.number().nullish(),
      health: z.number().nullish(),
      energy: z.number().nullish(),
    }),
    description: z.string().nullish(),
    evolutions: z.array(
      z.object({ from: z.string(), to: z.string(), level: z.number().nullish(), items: z.boolean().nullish() }),
    ),
    moves: z.array(z.object({ name: z.string(), level: z.number().nullish() })),
    abilities: z.array(z.string()),
    specialAbilities: z.array(z.string()),
    shiny: z.boolean(),
    legendary: z.boolean(),
    catchable: z.boolean(),
    shinyVariant: z.string().nullish(),
  }),
]);

export const pokemonSearchResultSchema = z.object({ names: z.array(z.string()) });

export const serverStatusResultSchema = z.object({
  serverName: z.string(),
  state: z.string(),
  playersOnline: z.number(),
  maxPlayers: z.number().nullish(),
  uptime: z.number(),
  bootId: z.string(),
  /** The next restart the game has planned (unix seconds), or null when none is. */
  restart: z.object({ at: z.number().int(), reason: z.enum(RESTART_REASONS) }).nullish(),
});

export const chatSendResultSchema = z.object({ delivered: z.number(), text: z.string() });

export const bridgeConfigResultSchema = z.object({
  chatChannelId: z.number(),
  chatAuthorPrefix: z.string(),
  chatTextMaxLength: z.number(),
  chatAuthorMaxLength: z.number(),
  legendary: z.array(z.string()),
});

// Account linking (results never contain account ids, account names or IPs).

export const linkSummarySchema = z.object({
  linked: z.literal(true),
  discordUserId,
  linkedAt: z.number(),
  characterCount: z.number(),
  main: z.object({ name: z.string(), level: z.number(), vocation: z.string().nullish() }).optional(),
  mainChanged: z.boolean(),
  premium: z.boolean(),
  premiumUnlimited: z.boolean(),
  premiumDays: z.number().optional(),
  /**
   * Distinct group ids of the account's characters (players.group_id, live for online ones).
   * Absent from game servers older than staff roles. The game's JSON encoder writes an
   * empty list as {}.
   */
  groupIds: z.union([z.array(z.number().int()), z.object({}).strict().transform((): number[] => [])]).optional(),
});

const notLinked = z.object({ linked: z.literal(false) });

export const linkAccountResultSchema = z.union([notLinked, linkSummarySchema]);

export const linkCharactersResultSchema = z.union([
  notLinked,
  z.object({
    linked: z.literal(true),
    characters: z.array(
      z.object({ name: z.string(), level: z.number(), vocation: z.string().nullish(), main: z.boolean(), online: z.boolean() }),
    ),
  }),
]);

export const unlinkResultSchema = z.object({ unlinked: z.boolean() });

export const linkListResultSchema = z.object({
  links: z.array(linkSummarySchema),
  nextOffset: z.number().optional(),
});

export const adminSessionsResultSchema = z.object({
  sessions: z.array(z.object({ sessionId: z.string(), character: z.string(), level: z.number() })),
  playersOnline: z.number(),
});

export type LinkSummary = z.infer<typeof linkSummarySchema>;
export type LinkAccountResult = z.infer<typeof linkAccountResultSchema>;
export type LinkCharactersResult = z.infer<typeof linkCharactersResultSchema>;
export type LinkListResult = z.infer<typeof linkListResultSchema>;
export type AdminSessionsResult = z.infer<typeof adminSessionsResultSchema>;

export type TrainerResult = z.infer<typeof trainerResultSchema>;
export type PokemonResult = z.infer<typeof pokemonResultSchema>;
export type FoundPokemon = Extract<PokemonResult, { found: true }>;
export type FoundTrainer = Extract<TrainerResult, { found: true }>;
export type TrainerCard = z.infer<typeof trainerCardSchema>;
export type CardPokemon = z.infer<typeof cardPokemonSchema>;
export type ServerStatusResult = z.infer<typeof serverStatusResultSchema>;
export type BridgeConfigResult = z.infer<typeof bridgeConfigResultSchema>;

/** The game's booster reward amounts (Soul Coins); the game owns them, the bot only shows them. */
export const boosterRulesResultSchema = z.object({
  weekly: z.number().int().min(0),
  loyaltyEvery: z.number().int().min(0),
  loyalty: z.number().int().min(0),
  yearlyEvery: z.number().int().min(0),
  yearly: z.number().int().min(0),
  /** Community bonus on loyalty weeks: +1 per `communityEvery` server boosts, at most `communityMax`. */
  communityEvery: z.number().int().min(0).default(0),
  communityMax: z.number().int().min(0).default(0),
  /** In-game perks for the whole server by server boost level (each level keeps the ones below). */
  perks: z.array(z.object({ level: z.number().int().min(1).max(3), text: z.string().max(100) })).max(12).default([]),
});
export type BoosterRules = z.infer<typeof boosterRulesResultSchema>;

/**
 * A completed boost week. `deposited` is false when the game had already paid that week
 * (the amounts are then the ones paid before).
 */
export const boosterWeekResultSchema = z.object({
  deposited: z.boolean(),
  week: z.number().int(),
  weekly: z.number().int().min(0),
  loyalty: z.number().int().min(0),
  yearly: z.number().int().min(0),
  community: z.number().int().min(0).default(0),
  total: z.number().int().min(0),
});
export type BoosterWeekResult = z.infer<typeof boosterWeekResultSchema>;

/** The server boost level the game now applies, and the perks active at it. */
export const boostLevelResultSchema = z.object({
  level: z.number().int().min(0).max(3),
  perks: z.array(z.string().max(100)).max(12).default([]),
});
export type BoostLevelResult = z.infer<typeof boostLevelResultSchema>;

export const reportSetStatusResultSchema = z.object({ id: z.number(), status: z.string(), changed: z.boolean() });
export type ReportSetStatusResult = z.infer<typeof reportSetStatusResultSchema>;

export const reportGetResultSchema = z.object({ found: z.boolean(), report: reportSchema.optional() });
export type ReportGetResult = z.infer<typeof reportGetResultSchema>;

/** A slice of a report's screenshot: base64 PNG, `total` characters in all. */
export const reportScreenshotResultSchema = z.object({
  found: z.boolean(),
  done: z.boolean().optional(),
  total: z.number().int().optional(),
  offset: z.number().int().optional(),
  data: z.string().optional(),
});
export type ReportScreenshotResult = z.infer<typeof reportScreenshotResultSchema>;

/** The Discord roles staff can ping from the game's Admin window (announcements.roles). */
export const announcementRolesResultSchema = z.object({ roles: z.number().int().min(0) });
export type AnnouncementRolesResult = z.infer<typeof announcementRolesResultSchema>;

/** One occurrence of a calendar event (game: EventCalendar.rangeData). */
export const calendarEventSchema = z.object({
  /** Unique per occurrence, like "halloween:1793491200". */
  key: z.string(),
  /** The holiday, server event or "staff<id>" it belongs to. */
  id: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  color: z.string().nullish(),
  startsAt: z.number(),
  endsAt: z.number(),
  bonuses: z.preprocess(
    emptyList,
    z.array(z.object({ kind: z.string(), label: z.string().nullish(), value: z.number() })).default([]),
  ),
  holiday: z.boolean().optional(),
  /** Turned on by staff right now, not planned. */
  forced: z.boolean().optional(),
});
export type CalendarEvent = z.infer<typeof calendarEventSchema>;

export const calendarRangeResultSchema = z.object({
  from: z.number(),
  to: z.number(),
  events: z.preprocess(
    emptyList,
    z.array(calendarEventSchema),
  ),
});
export type CalendarRangeResult = z.infer<typeof calendarRangeResultSchema>;
