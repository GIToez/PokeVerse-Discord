/** Token bucket: `capacity` tokens, refilled continuously over `intervalMs`. */
export class TokenBucket {
  private tokens: number;
  private updatedAt: number;

  constructor(
    private readonly capacity: number,
    private readonly intervalMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.updatedAt = now();
  }

  private refill(): void {
    const current = this.now();
    const elapsed = current - this.updatedAt;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + (elapsed / this.intervalMs) * this.capacity);
      this.updatedAt = current;
    }
  }

  tryTake(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  isFull(): boolean {
    this.refill();
    return this.tokens >= this.capacity;
  }
}

/** One token bucket per key (e.g. per Discord user), with idle buckets pruned. */
export class KeyedRateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(
    private readonly capacity: number,
    private readonly intervalMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  tryTake(key: string): boolean {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size > 10_000) {
        this.prune();
      }
      bucket = new TokenBucket(this.capacity, this.intervalMs, this.now);
      this.buckets.set(key, bucket);
    }
    return bucket.tryTake();
  }

  private prune(): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.isFull()) {
        this.buckets.delete(key);
      }
    }
  }
}
