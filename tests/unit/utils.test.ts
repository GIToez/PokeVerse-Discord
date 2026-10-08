import { describe, expect, it } from "vitest";
import { RecentKeys } from "../../src/utils/dedupe.js";
import { DeliveryQueue, isRetryable } from "../../src/utils/deliveryQueue.js";
import { formatDuration, padDex } from "../../src/utils/format.js";
import { createLogger, silentLogger } from "../../src/utils/logger.js";
import { Metrics } from "../../src/utils/metrics.js";
import { KeyedRateLimiter, TokenBucket } from "../../src/utils/rateLimiter.js";

describe("rate limiting", () => {
  it("token bucket refills over time", () => {
    let now = 0;
    const bucket = new TokenBucket(2, 1000, () => now);
    expect([bucket.tryTake(), bucket.tryTake(), bucket.tryTake()]).toEqual([true, true, false]);
    now = 500;
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(false);
  });

  it("keyed limiter is independent per key", () => {
    const limiter = new KeyedRateLimiter(1, 1000, () => 0);
    expect(limiter.tryTake("a")).toBe(true);
    expect(limiter.tryTake("a")).toBe(false);
    expect(limiter.tryTake("b")).toBe(true);
  });
});

describe("dedupe", () => {
  it("remembers recent keys with bounded capacity", () => {
    const keys = new RecentKeys(2);
    expect(keys.add("a")).toBe(true);
    expect(keys.add("a")).toBe(false);
    keys.add("b");
    keys.add("c");
    expect(keys.has("a")).toBe(false);
    expect(keys.has("c")).toBe(true);
  });
});

describe("delivery queue", () => {
  const make = (maxSize: number, metrics = new Metrics()) =>
    new DeliveryQueue({ name: "q", maxSize, maxAttempts: 3, retryDelayMs: 1, logger: silentLogger, metrics, sleep: async () => {} });

  it("delivers in order", async () => {
    const queue = make(10);
    const order: number[] = [];
    for (let i = 0; i < 5; i++) {
      queue.enqueue(`job${i}`, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        order.push(i);
      });
    }
    await queue.idle();
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it("drops the oldest pending job when full", async () => {
    const metrics = new Metrics();
    const queue = make(2, metrics);
    const done: string[] = [];
    let release!: () => void;
    queue.enqueue("blocker", () => new Promise<void>((resolve) => (release = resolve)));
    for (const label of ["a", "b", "c"]) {
      queue.enqueue(label, async () => {
        done.push(label);
      });
    }
    expect(queue.size).toBe(2);
    release();
    await queue.idle();
    expect(done).toEqual(["b", "c"]);
    expect(metrics.get("q.dropped")).toBe(1);
  });

  it("retries rate limits and server errors, not client errors", async () => {
    const metrics = new Metrics();
    const queue = make(10, metrics);
    let attempts = 0;
    queue.enqueue("flaky", async () => {
      attempts++;
      if (attempts < 3) {
        throw Object.assign(new Error("rate limited"), { status: 429 });
      }
    });
    let forbiddenAttempts = 0;
    queue.enqueue("forbidden", async () => {
      forbiddenAttempts++;
      throw Object.assign(new Error("Missing Permissions"), { status: 403 });
    });
    await queue.idle();
    expect(attempts).toBe(3);
    expect(forbiddenAttempts).toBe(1);
    expect(metrics.get("q.failed")).toBe(1);
    expect(isRetryable({ code: "ECONNRESET" })).toBe(true);
    expect(isRetryable({ status: 404 })).toBe(false);
  });
});

describe("logger", () => {
  it("redacts secrets and writes JSON", () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "info", format: "json", secrets: ["super-secret-token"], write: (line) => lines.push(line) });
    logger.debug("hidden");
    logger.info("token is super-secret-token", { nested: { value: "super-secret-token" } });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("super-secret-token");
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: "info" });
  });
});

describe("format", () => {
  it("formats durations and dex numbers", () => {
    expect(formatDuration(59)).toBe("59s");
    expect(formatDuration(3600 * 26 + 120)).toBe("1d 2h 2m");
    expect(padDex(7)).toBe("007");
  });
});
