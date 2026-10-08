import type { Logger } from "./logger.js";
import type { Metrics } from "./metrics.js";

export interface DeliveryQueueOptions {
  name: string;
  maxSize: number;
  maxAttempts: number;
  /** Base delay for retries; doubled per attempt. */
  retryDelayMs: number;
  logger: Logger;
  metrics: Metrics;
  sleep?: (ms: number) => Promise<void>;
}

interface Job {
  label: string;
  run: () => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Status codes worth retrying: rate limits and transient server errors. */
export function isRetryable(error: unknown): boolean {
  const status = (error as { status?: unknown; httpStatus?: unknown } | null)?.status ??
    (error as { httpStatus?: unknown } | null)?.httpStatus;
  if (typeof status === "number") {
    return status === 429 || status >= 500;
  }
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ECONNRESET" || code === "ETIMEDOUT" || code === "EAI_AGAIN" || code === "UND_ERR_CONNECT_TIMEOUT";
}

/**
 * Bounded, sequential async delivery. When full, the oldest pending job is dropped,
 * so a Discord outage can never grow memory without limit.
 */
export class DeliveryQueue {
  private readonly jobs: Job[] = [];
  private running = false;
  private readonly sleep: (ms: number) => Promise<void>;
  private idleResolvers: Array<() => void> = [];

  constructor(private readonly options: DeliveryQueueOptions) {
    this.sleep = options.sleep ?? defaultSleep;
  }

  get size(): number {
    return this.jobs.length;
  }

  enqueue(label: string, run: () => Promise<void>): void {
    if (this.jobs.length >= this.options.maxSize) {
      const dropped = this.jobs.shift();
      this.options.metrics.increment(`${this.options.name}.dropped`);
      this.options.logger.warn("Delivery queue full, dropping oldest message", {
        queue: this.options.name,
        dropped: dropped?.label,
      });
    }
    this.jobs.push({ label, run });
    this.options.metrics.increment(`${this.options.name}.queued`);
    void this.drain();
  }

  /** Resolves when the queue is empty and nothing is running. */
  idle(): Promise<void> {
    if (!this.running && this.jobs.length === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.idleResolvers.push(resolve));
  }

  private async drain(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      let job: Job | undefined;
      while ((job = this.jobs.shift())) {
        await this.runJob(job);
      }
    } finally {
      this.running = false;
      const resolvers = this.idleResolvers;
      this.idleResolvers = [];
      resolvers.forEach((resolve) => resolve());
    }
  }

  private async runJob(job: Job): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await job.run();
        this.options.metrics.increment(`${this.options.name}.sent`);
        return;
      } catch (error) {
        if (attempt >= this.options.maxAttempts || !isRetryable(error)) {
          this.options.metrics.increment(`${this.options.name}.failed`);
          this.options.logger.error("Delivery failed", { queue: this.options.name, job: job.label, attempt, error });
          return;
        }
        const retryAfter = Number((error as { retryAfter?: unknown }).retryAfter);
        const delay = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter
          : this.options.retryDelayMs * 2 ** (attempt - 1);
        this.options.metrics.increment(`${this.options.name}.retried`);
        this.options.logger.warn("Delivery failed, retrying", { queue: this.options.name, job: job.label, attempt, delay });
        await this.sleep(delay);
      }
    }
  }
}
