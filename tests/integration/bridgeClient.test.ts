import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  BridgeClient,
  BridgeRequestError,
  BridgeUnavailableError,
  type ConnectedInfo,
} from "../../src/integrations/pokeverse/bridgeClient.js";
import type { GameEventEnvelope } from "../../src/integrations/pokeverse/protocol.js";
import { silentLogger } from "../../src/utils/logger.js";
import { Metrics } from "../../src/utils/metrics.js";
import { FakeBridgeServer, waitFor } from "../helpers/fakeBridgeServer.js";

const SECRET = "integration-secret-0123456789";
const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    await cleanup.pop()!();
  }
});

async function startServer(options: Partial<ConstructorParameters<typeof FakeBridgeServer>[0]> = {}) {
  const server = new FakeBridgeServer({
    secret: SECRET,
    onRequest: (method, params) => {
      if (method === "echo") {
        return { value: params.value };
      }
      if (method === "fail") {
        throw { code: "invalid_params", message: "bad" };
      }
      return undefined;
    },
    ...options,
  });
  await server.start();
  cleanup.push(() => server.stop());
  return server;
}

function startClient(port: number, overrides: Partial<ConstructorParameters<typeof BridgeClient>[0]> = {}) {
  const metrics = new Metrics();
  const client = new BridgeClient({
    host: "127.0.0.1",
    port,
    secret: SECRET,
    requestTimeoutMs: 300,
    logger: silentLogger,
    metrics,
    minReconnectDelayMs: 20,
    maxReconnectDelayMs: 100,
    ...overrides,
  });
  const connections: ConnectedInfo[] = [];
  const events: GameEventEnvelope[] = [];
  const disconnects: string[] = [];
  client.on("connected", (info) => connections.push(info));
  client.on("event", (event) => events.push(event));
  client.on("disconnected", (reason) => disconnects.push(reason));
  client.start();
  cleanup.push(() => client.stop());
  return { client, metrics, connections, events, disconnects };
}

describe("bridge client", () => {
  it("authenticates with HMAC and answers requests", async () => {
    const server = await startServer();
    const { client, connections } = startClient(server.port);
    await waitFor(() => client.connected, 3000, "connect");
    expect(connections[0]).toMatchObject({ bootId: "boot1", serverName: "PokeVerse", restarted: false });
    expect(await client.request("echo", { value: 42 }, z.object({ value: z.number() }))).toEqual({ value: 42 });
    await expect(client.request("fail", {}, z.object({}))).rejects.toEqual(new BridgeRequestError("invalid_params", "bad"));
    await expect(client.request("echo", { value: "x" }, z.object({ value: z.number() }))).rejects.toThrow(/Unexpected response/);
  });

  it("times out requests the server never answers", async () => {
    const server = await startServer();
    const { client, metrics } = startClient(server.port);
    await waitFor(() => client.connected);
    await expect(client.request("silent", {}, z.object({}))).rejects.toBeInstanceOf(BridgeUnavailableError);
    expect(metrics.get("bridge.request_timeouts")).toBe(1);
  });

  it("rejects requests immediately while disconnected", async () => {
    const { client } = startClient(1);
    await expect(client.request("echo", {}, z.object({}))).rejects.toBeInstanceOf(BridgeUnavailableError);
  });

  it("reports a wrong secret and does not connect", async () => {
    const server = await startServer();
    const { client, metrics } = startClient(server.port, { secret: "wrong-secret-0123456789" });
    let failed = false;
    client.on("authFailed", () => (failed = true));
    await waitFor(() => failed, 3000, "auth failure");
    expect(client.connected).toBe(false);
    expect(metrics.get("bridge.auth_failures")).toBe(1);
    expect(server.authenticatedClients).toBe(0);
  });

  it("emits validated events once and ignores malformed or unknown ones", async () => {
    const server = await startServer();
    const { client, events, metrics } = startClient(server.port);
    await waitFor(() => client.connected);
    const id = server.emit({ kind: "chat", channelId: 7, author: "Red", level: 20, text: "hi" });
    server.emit({ kind: "chat", channelId: 7, author: "Red", level: 20, text: "hi" }, { id });
    server.emit({ kind: "catch", trainer: "Red" });
    server.emit({ kind: "future_feature", value: 1 });
    server.sendRaw("this is not json\n");
    server.emit({ kind: "spawn", species: "Shiny Rattata", baseSpecies: "Rattata", shiny: true, legendary: false, source: "spawn", creatureId: 5 });
    await waitFor(() => events.length >= 2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events.map((event) => event.event.kind)).toEqual(["chat", "spawn"]);
    expect(events[0]).toMatchObject({ id, bootId: "boot1" });
    expect(metrics.get("bridge.duplicate_events")).toBe(1);
    expect(metrics.get("bridge.unknown_events")).toBe(2);
    expect(metrics.get("bridge.invalid_messages")).toBe(1);
  });

  it("reconnects after the connection drops and detects game restarts", async () => {
    const server = await startServer();
    const { client, connections, disconnects } = startClient(server.port);
    await waitFor(() => client.connected);
    server.dropClients();
    await waitFor(() => disconnects.length === 1, 3000, "disconnect");
    await waitFor(() => connections.length === 2, 3000, "reconnect");
    expect(connections[1]!.restarted).toBe(false);

    await server.restart("boot2");
    await waitFor(() => connections.length === 3, 3000, "reconnect after restart");
    expect(connections[2]).toMatchObject({ bootId: "boot2", restarted: true, previousBootId: "boot1" });
  });

  it("keeps retrying while the game is down", async () => {
    const server = await startServer();
    const port = server.port;
    await server.stop();
    const { client } = startClient(port);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(client.connected).toBe(false);
    const again = new FakeBridgeServer({ secret: SECRET });
    await again.start(port);
    cleanup.push(() => again.stop());
    await waitFor(() => client.connected, 3000, "connect after game start");
  });

  it("drops idle connections and reconnects", async () => {
    const server = await startServer();
    server.respondToPing = false;
    const { client, connections } = startClient(server.port, { pingIntervalMs: 30, idleTimeoutMs: 100 });
    await waitFor(() => client.connected);
    await waitFor(() => connections.length >= 2, 3000, "reconnect after idle");
  });

  it("uses the persisted boot id to detect restarts after a bot restart", async () => {
    const server = await startServer({ bootId: "boot7" });
    const metrics = new Metrics();
    const client = new BridgeClient({ host: "127.0.0.1", port: server.port, secret: SECRET, requestTimeoutMs: 300, logger: silentLogger, metrics });
    client.setLastKnownBootId("boot6");
    const infos: ConnectedInfo[] = [];
    client.on("connected", (info) => infos.push(info));
    client.start();
    cleanup.push(() => client.stop());
    await waitFor(() => infos.length === 1);
    expect(infos[0]).toMatchObject({ restarted: true, previousBootId: "boot6" });
  });
});
