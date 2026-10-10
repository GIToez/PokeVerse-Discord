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

export const FEATURES = { playerSessions: "playerSessions", accountLinking: "accountLinking" } as const;
export const errorSchema = z.object({ type: z.literal("error"), code: z.string() });

const position = z.object({ x: z.number(), y: z.number(), z: z.number() });

export const chatEventSchema = z.object({
  kind: z.literal("chat"),
  channelId: z.number(),
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

export const broadcastEventSchema = z.object({
  kind: z.literal("broadcast"),
  source: z.string(),
  author: z.string().nullish(),
  text: z.string(),
});

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

export const gameEventSchema = z.discriminatedUnion("kind", [
  chatEventSchema,
  catchEventSchema,
  spawnEventSchema,
  broadcastEventSchema,
  restartWarningEventSchema,
  serverStateEventSchema,
  playerLoginEventSchema,
  playerLogoutEventSchema,
  accountLinkEventSchema,
  accountCharactersEventSchema,
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
export type CatchEvent = z.infer<typeof catchEventSchema>;
export type SpawnEvent = z.infer<typeof spawnEventSchema>;
export type BroadcastEvent = z.infer<typeof broadcastEventSchema>;
export type RestartWarningEvent = z.infer<typeof restartWarningEventSchema>;
export type ServerStateEvent = z.infer<typeof serverStateEventSchema>;
export type PlayerLoginEvent = z.infer<typeof playerLoginEventSchema>;
export type PlayerLogoutEvent = z.infer<typeof playerLogoutEventSchema>;
export type AccountLinkEvent = z.infer<typeof accountLinkEventSchema>;
export type AccountCharactersEvent = z.infer<typeof accountCharactersEventSchema>;
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
export type ServerStatusResult = z.infer<typeof serverStatusResultSchema>;
export type BridgeConfigResult = z.infer<typeof bridgeConfigResultSchema>;
