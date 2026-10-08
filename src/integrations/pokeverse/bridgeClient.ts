import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
import type { z } from "zod";
import { RecentKeys } from "../../utils/dedupe.js";
import type { Logger } from "../../utils/logger.js";
import type { Metrics } from "../../utils/metrics.js";
import {
  errorSchema,
  eventEnvelopeSchema,
  gameEventSchema,
  helloSchema,
  MAX_LINE_BYTES,
  PROTOCOL_VERSION,
  responseSchema,
  welcomeSchema,
  type GameEventEnvelope,
} from "./protocol.js";

export class BridgeUnavailableError extends Error {
  constructor(message = "The game server is not connected") {
    super(message);
    this.name = "BridgeUnavailableError";
  }
}

export class BridgeRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BridgeRequestError";
  }
}

export interface BridgeClientOptions {
  host: string;
  port: number;
  secret: string;
  requestTimeoutMs: number;
  logger: Logger;
  metrics: Metrics;
  /** Reconnect backoff bounds. */
  minReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  pingIntervalMs?: number;
  idleTimeoutMs?: number;
  authTimeoutMs?: number;
}

export interface ConnectedInfo {
  bootId: string;
  serverName: string;
  queued: number;
  /** True when the boot id differs from the previous connection (game restarted). */
  restarted: boolean;
  previousBootId: string | undefined;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

type State = "stopped" | "connecting" | "authenticating" | "connected" | "waiting";

export interface BridgeClientEvents {
  connected: [ConnectedInfo];
  disconnected: [string];
  event: [GameEventEnvelope];
  authFailed: [];
}

/**
 * Client for the game-side bridge. Reconnects forever with backoff; never throws
 * from background activity. Each game event is emitted at most once per client.
 */
export class BridgeClient extends EventEmitter<BridgeClientEvents> {
  private socket: Socket | undefined;
  private state: State = "stopped";
  private buffer = "";
  private decoder = new StringDecoder("utf8");
  private reconnectTimer: NodeJS.Timeout | undefined;
  private pingTimer: NodeJS.Timeout | undefined;
  private authTimer: NodeJS.Timeout | undefined;
  private reconnectDelay: number;
  private lastReceived = 0;
  private requestCounter = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly seenEvents = new RecentKeys(20_000);
  private currentBootId: string | undefined;
  private lastBootId: string | undefined;
  private currentServerName: string | undefined;
  private authFailed = false;

  private readonly minDelay: number;
  private readonly maxDelay: number;
  private readonly pingIntervalMs: number;
  private readonly idleTimeoutMs: number;
  private readonly authTimeoutMs: number;

  constructor(private readonly options: BridgeClientOptions) {
    super();
    this.minDelay = options.minReconnectDelayMs ?? 1000;
    this.maxDelay = options.maxReconnectDelayMs ?? 30_000;
    this.pingIntervalMs = options.pingIntervalMs ?? 15_000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 45_000;
    this.authTimeoutMs = options.authTimeoutMs ?? 10_000;
    this.reconnectDelay = this.minDelay;
  }

  get connected(): boolean {
    return this.state === "connected";
  }

  get bootId(): string | undefined {
    return this.currentBootId;
  }

  get serverName(): string | undefined {
    return this.currentServerName;
  }

  /** Last boot id seen, even while disconnected. */
  get lastKnownBootId(): string | undefined {
    return this.lastBootId;
  }

  /** Seeds the last known boot id (persisted across bot restarts) for restart detection. */
  setLastKnownBootId(bootId: string | undefined): void {
    this.lastBootId = bootId;
  }

  start(): void {
    if (this.state !== "stopped") {
      return;
    }
    this.connect();
  }

  stop(): void {
    this.state = "stopped";
    clearTimeout(this.reconnectTimer);
    this.teardown("client stopped");
  }

  async request<T extends z.ZodTypeAny>(method: string, params: Record<string, unknown>, schema: T): Promise<z.infer<T>> {
    if (this.state !== "connected" || !this.socket) {
      throw new BridgeUnavailableError();
    }
    const requestId = `r${++this.requestCounter}`;
    const result = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.options.metrics.increment("bridge.request_timeouts");
        reject(new BridgeUnavailableError(`The game server did not answer "${method}" in time`));
      }, this.options.requestTimeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.write({ type: "request", requestId, method, params });
    });
    const parsed = schema.safeParse(result);
    if (!parsed.success) {
      this.options.logger.error("Invalid bridge response", { method, issues: parsed.error.issues.slice(0, 5) });
      throw new BridgeRequestError("invalid_response", `Unexpected response for "${method}"`);
    }
    return parsed.data;
  }

  private connect(): void {
    this.state = "connecting";
    this.buffer = "";
    this.decoder = new StringDecoder("utf8");
    const socket = new Socket();
    this.socket = socket;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30_000);

    socket.on("data", (chunk) => this.onData(socket, chunk));
    socket.on("error", (error) => {
      this.options.logger.debug("Bridge socket error", { error: error.message });
    });
    socket.on("close", () => {
      if (this.socket === socket) {
        this.onClosed("connection closed");
      }
    });
    socket.connect(this.options.port, this.options.host, () => {
      if (this.socket !== socket) {
        return;
      }
      this.state = "authenticating";
      this.lastReceived = Date.now();
      this.authTimer = setTimeout(() => {
        this.options.logger.warn("Bridge authentication timed out");
        socket.destroy();
      }, this.authTimeoutMs);
    });
  }

  private onData(socket: Socket, chunk: Buffer): void {
    if (this.socket !== socket) {
      return;
    }
    this.lastReceived = Date.now();
    this.buffer += this.decoder.write(chunk);
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line !== "") {
        this.onLine(line);
      }
      if (this.socket !== socket) {
        return;
      }
    }
    if (Buffer.byteLength(this.buffer) > MAX_LINE_BYTES) {
      this.options.logger.error("Bridge message too long, reconnecting");
      socket.destroy();
    }
  }

  private onLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.options.metrics.increment("bridge.invalid_messages");
      this.options.logger.warn("Ignoring invalid JSON from the bridge");
      return;
    }
    const type = (message as { type?: unknown })?.type;
    switch (type) {
      case "hello":
        return this.onHello(message);
      case "welcome":
        return this.onWelcome(message);
      case "error":
        return this.onError(message);
      case "event":
        return this.onEvent(message);
      case "response":
        return this.onResponse(message);
      case "ping":
        this.write({ type: "pong" });
        return;
      case "pong":
        return;
      default:
        this.options.metrics.increment("bridge.invalid_messages");
        this.options.logger.debug("Ignoring unknown bridge message", { type });
    }
  }

  private onHello(message: unknown): void {
    const hello = helloSchema.safeParse(message);
    if (!hello.success || this.state !== "authenticating") {
      this.socket?.destroy();
      return;
    }
    if (hello.data.protocol !== PROTOCOL_VERSION) {
      this.options.logger.error("Unsupported bridge protocol version", {
        server: hello.data.protocol,
        client: PROTOCOL_VERSION,
      });
      this.socket?.destroy();
      return;
    }
    const hmac = createHmac("sha256", this.options.secret).update(hello.data.nonce).digest("hex");
    this.write({ type: "auth", hmac });
  }

  private onWelcome(message: unknown): void {
    const welcome = welcomeSchema.safeParse(message);
    if (!welcome.success) {
      this.socket?.destroy();
      return;
    }
    clearTimeout(this.authTimer);
    const previousBootId = this.lastBootId;
    this.state = "connected";
    this.authFailed = false;
    this.reconnectDelay = this.minDelay;
    this.currentBootId = welcome.data.bootId;
    this.lastBootId = welcome.data.bootId;
    this.currentServerName = welcome.data.serverName;
    this.options.metrics.increment("bridge.connections");
    this.pingTimer = setInterval(() => this.heartbeat(), this.pingIntervalMs);
    const info: ConnectedInfo = {
      bootId: welcome.data.bootId,
      serverName: welcome.data.serverName,
      queued: welcome.data.queued,
      restarted: previousBootId !== undefined && previousBootId !== welcome.data.bootId,
      previousBootId,
    };
    this.options.logger.info("Connected to the game server", { ...info });
    this.emit("connected", info);
  }

  private onError(message: unknown): void {
    const error = errorSchema.safeParse(message);
    const code = error.success ? error.data.code : "unknown";
    if (code === "auth_failed") {
      this.authFailed = true;
      this.options.metrics.increment("bridge.auth_failures");
      this.options.logger.error(
        "The game server rejected the bridge secret. BRIDGE_SECRET must equal discordBridgeSecret in the game's config.local.lua.",
      );
      this.emit("authFailed");
    } else {
      this.options.logger.warn("Bridge error", { code });
    }
  }

  private onEvent(message: unknown): void {
    const envelope = eventEnvelopeSchema.safeParse(message);
    if (!envelope.success) {
      this.options.metrics.increment("bridge.invalid_events");
      this.options.logger.warn("Ignoring malformed bridge event");
      return;
    }
    const event = gameEventSchema.safeParse(envelope.data.event);
    if (!event.success) {
      this.options.metrics.increment("bridge.unknown_events");
      this.options.logger.debug("Ignoring unknown or invalid game event", { kind: envelope.data.event.kind });
      return;
    }
    if (!this.seenEvents.add(envelope.data.id)) {
      this.options.metrics.increment("bridge.duplicate_events");
      return;
    }
    const separator = envelope.data.id.lastIndexOf("-");
    const bootId = separator > 0 ? envelope.data.id.slice(0, separator) : (this.currentBootId ?? "");
    this.options.metrics.increment(`bridge.events.${event.data.kind}`);
    this.emit("event", { id: envelope.data.id, time: envelope.data.time, bootId, event: event.data });
  }

  private onResponse(message: unknown): void {
    const response = responseSchema.safeParse(message);
    if (!response.success) {
      return;
    }
    const pending = this.pending.get(response.data.requestId);
    if (!pending) {
      return;
    }
    this.pending.delete(response.data.requestId);
    clearTimeout(pending.timer);
    if (response.data.ok) {
      pending.resolve(response.data.result);
    } else {
      const code = response.data.error?.code ?? "error";
      pending.reject(new BridgeRequestError(code, response.data.error?.message ?? code));
    }
  }

  private heartbeat(): void {
    if (Date.now() - this.lastReceived > this.idleTimeoutMs) {
      this.options.logger.warn("Bridge connection idle, reconnecting");
      this.socket?.destroy();
      return;
    }
    this.write({ type: "ping" });
  }

  private write(message: unknown): void {
    if (!this.socket || this.socket.destroyed) {
      return;
    }
    this.socket.write(JSON.stringify(message) + "\n");
  }

  private teardown(reason: string): void {
    clearTimeout(this.authTimer);
    clearInterval(this.pingTimer);
    const socket = this.socket;
    this.socket = undefined;
    socket?.removeAllListeners("data");
    socket?.destroy();
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new BridgeUnavailableError(`Connection to the game server lost (${reason})`));
      this.pending.delete(id);
    }
    const wasConnected = this.currentBootId !== undefined;
    this.currentBootId = undefined;
    if (wasConnected) {
      this.emit("disconnected", reason);
    }
  }

  private onClosed(reason: string): void {
    const wasConnected = this.state === "connected";
    this.teardown(reason);
    if (this.state === "stopped") {
      return;
    }
    if (wasConnected) {
      this.options.logger.warn("Disconnected from the game server", { reason });
    }
    this.state = "waiting";
    const delay = this.authFailed ? Math.max(this.reconnectDelay, 30_000) : this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxDelay);
    const jitter = Math.floor(Math.random() * Math.min(1000, delay / 4));
    this.options.logger.debug("Reconnecting to the game server", { delayMs: delay + jitter });
    this.reconnectTimer = setTimeout(() => this.connect(), delay + jitter);
  }
}
