/** Remembers the most recent `capacity` keys (insertion order) to drop duplicates. */
export class RecentKeys {
  private readonly keys = new Set<string>();

  constructor(private readonly capacity: number) {}

  /** Returns true the first time a key is seen, false for duplicates. */
  add(key: string): boolean {
    if (this.keys.has(key)) {
      return false;
    }
    this.keys.add(key);
    if (this.keys.size > this.capacity) {
      const oldest = this.keys.values().next().value;
      if (oldest !== undefined) {
        this.keys.delete(oldest);
      }
    }
    return true;
  }

  has(key: string): boolean {
    return this.keys.has(key);
  }

  get size(): number {
    return this.keys.size;
  }
}
