/**
 * Bounded "seen" set for alert ids (FIFO eviction), serialisable so the light mode can keep it in
 * `chrome.storage.session` and the service in its checkpoint.
 */
export class Deduper {
  private readonly seen = new Set<string>();

  constructor(
    initial: readonly string[] = [],
    private readonly capacity = 10_000,
  ) {
    for (const id of initial) this.add(id);
  }

  has(id: string): boolean {
    return this.seen.has(id);
  }

  /** Marks `id` seen; true when it was new. */
  add(id: string): boolean {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    while (this.seen.size > this.capacity) {
      const first = this.seen.values().next().value as string;
      this.seen.delete(first);
    }
    return true;
  }

  delete(id: string): void {
    this.seen.delete(id);
  }

  snapshot(): string[] {
    return [...this.seen];
  }
}
