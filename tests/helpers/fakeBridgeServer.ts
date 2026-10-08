import { createHmac, randomBytes } from "node:crypto";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";

export interface FakeBridgeOptions {
  secret: string;
  bootId?: string;
  serverName?: string;
  /** Handles requests; return a result or throw { code, message }. */
  onRequest?: (method: string, params: Record<string, unknown>) => unknown;
}

interface Connection {
  socket: Socket;
  authenticated: boolean;
  nonce: string;
}

/**
 * In-process implementation of the game bridge protocol (docs/discord-bridge.md in
 * the game repository) for integration tests of the bot.
 */
export class FakeBridgeServer {
  private server: Server | undefined;
  private connections = new Set<Connection>();
  private sequence = 0;
  readonly received: unknown[] = [];
  bootId: string;
  port = 0;
  /** When false, pings from the client are not answered (idle tests). */
  respondToPing = true;

  constructor(private readonly options: FakeBridgeOptions) {
    this.bootId = options.bootId ?? "boot1";
  }

  async start(port = 0): Promise<number> {
    this.server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve) => this.server!.listen(port, "127.0.0.1", resolve));
    this.port = (this.server.address() as AddressInfo).port;
    return this.port;
  }

  async stop(): Promise<void> {
    this.dropClients();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = undefined;
  }

  /** Simulates a game restart: new boot id, sequence restarts. */
  async restart(newBootId: string): Promise<void> {
    const port = this.port;
    await this.stop();
    this.bootId = newBootId;
    this.sequence = 0;
    await this.start(port);
  }

  dropClients(): void {
    for (const connection of this.connections) {
      connection.socket.destroy();
    }
    this.connections.clear();
  }

  get authenticatedClients(): number {
    return [...this.connections].filter((connection) => connection.authenticated).length;
  }

  /** Emits an event to authenticated clients; returns the envelope id. */
  emit(event: Record<string, unknown>, options: { id?: string; time?: number } = {}): string {
    const id = options.id ?? `${this.bootId}-${++this.sequence}`;
    this.broadcast({ type: "event", id, time: options.time ?? Math.floor(Date.now() / 1000), event });
    return id;
  }

  sendRaw(line: string): void {
    for (const connection of this.connections) {
      if (connection.authenticated) {
        connection.socket.write(line);
      }
    }
  }

  private broadcast(message: unknown): void {
    this.sendRaw(JSON.stringify(message) + "\n");
  }

  private accept(socket: Socket): void {
    const connection: Connection = { socket, authenticated: false, nonce: randomBytes(32).toString("hex") };
    this.connections.add(connection);
    socket.on("close", () => this.connections.delete(connection));
    socket.on("error", () => undefined);
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim() !== "") {
          this.onMessage(connection, JSON.parse(line) as Record<string, unknown>);
        }
      }
    });
    socket.write(JSON.stringify({ type: "hello", protocol: 1, nonce: connection.nonce }) + "\n");
  }

  private onMessage(connection: Connection, message: Record<string, unknown>): void {
    this.received.push(message);
    const write = (value: unknown) => connection.socket.write(JSON.stringify(value) + "\n");
    if (!connection.authenticated) {
      const expected = createHmac("sha256", this.options.secret).update(connection.nonce).digest("hex");
      if (message.type === "auth" && message.hmac === expected) {
        for (const other of this.connections) {
          if (other !== connection && other.authenticated) {
            other.socket.destroy();
          }
        }
        connection.authenticated = true;
        write({ type: "welcome", protocol: 1, bootId: this.bootId, serverName: this.options.serverName ?? "PokeVerse", queued: 0 });
      } else {
        write({ type: "error", code: "auth_failed" });
        connection.socket.end();
      }
      return;
    }
    if (message.type === "ping") {
      if (this.respondToPing) {
        write({ type: "pong" });
      }
      return;
    }
    if (message.type === "request") {
      const requestId = message.requestId as string;
      try {
        const result = this.options.onRequest?.(message.method as string, (message.params ?? {}) as Record<string, unknown>);
        if (result === undefined) {
          return; // Simulates a request the server never answers.
        }
        write({ type: "response", requestId, ok: true, result });
      } catch (error) {
        const { code, message: text } = error as { code?: string; message?: string };
        write({ type: "response", requestId, ok: false, error: { code: code ?? "internal", message: text } });
      }
    }
  }
}

export async function waitFor(condition: () => boolean, timeoutMs = 5000, label = "condition"): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
