import { PRIORITY_WEIGHT, type Priority } from "./constants.js";

export interface RelayDecision {
  allow: boolean;
  reason:
    | "ok"
    | "relay_disabled"
    | "battery_critical"
    | "battery_low_priority_filtered"
    | "battery_unknown_allow";
}

/**
 * Battery-aware forwarding. Unknown battery does not pretend a measurement;
 * it allows relay and reports that the measurement is missing.
 * Below 8% the phone must not relay. Below 15% only P0 and P1 are relayed.
 * Originating the user's own report is not a relay and is not decided here.
 */
export function mayRelay(priority: Priority, batteryPercent: number | null, relayEnabled: boolean): RelayDecision {
  if (!relayEnabled) return { allow: false, reason: "relay_disabled" };
  if (batteryPercent == null || Number.isNaN(batteryPercent)) {
    return { allow: true, reason: "battery_unknown_allow" };
  }
  if (batteryPercent < 8) return { allow: false, reason: "battery_critical" };
  if (batteryPercent < 15 && priority > 1) return { allow: false, reason: "battery_low_priority_filtered" };
  return { allow: true, reason: "ok" };
}

/**
 * Weighted round-robin. Slot pattern P0×8, P1×4, P2×2, P3×1, P4×1.
 * Empty slots are skipped, so urgent traffic moves first without permanently
 * starving a non-empty lower-priority queue.
 */
export class PriorityScheduler<T> {
  private readonly queues = new Map<Priority, T[]>([
    [0, []],
    [1, []],
    [2, []],
    [3, []],
    [4, []],
  ]);
  private cursor = 0;
  private readonly pattern: Priority[] = [];

  constructor() {
    const order: Priority[] = [0, 1, 2, 3, 4];
    for (const priority of order) {
      for (let i = 0; i < PRIORITY_WEIGHT[priority]; i += 1) this.pattern.push(priority);
    }
  }

  enqueue(priority: Priority, item: T): void {
    const queue = this.queues.get(priority);
    if (!queue) throw new Error("bad priority");
    queue.push(item);
  }

  get size(): number {
    let n = 0;
    for (const queue of this.queues.values()) n += queue.length;
    return n;
  }

  peekCounts(): Record<Priority, number> {
    return {
      0: this.queues.get(0)!.length,
      1: this.queues.get(1)!.length,
      2: this.queues.get(2)!.length,
      3: this.queues.get(3)!.length,
      4: this.queues.get(4)!.length,
    };
  }

  next(): { priority: Priority; item: T } | null {
    if (this.size === 0) return null;
    for (let i = 0; i < this.pattern.length; i += 1) {
      const priority = this.pattern[this.cursor];
      this.cursor = (this.cursor + 1) % this.pattern.length;
      const queue = this.queues.get(priority)!;
      if (queue.length > 0) {
        return { priority, item: queue.shift()! };
      }
    }
    return null;
  }
}

export class TokenBucket {
  private tokens: number;
  private updatedMs: number;

  constructor(
    private readonly ratePerSec: number,
    private readonly burst: number,
    private readonly now: () => number,
  ) {
    this.tokens = burst;
    this.updatedMs = now();
  }

  tryTake(count = 1): boolean {
    const t = this.now();
    const elapsed = Math.max(0, t - this.updatedMs) / 1000;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.ratePerSec);
    this.updatedMs = t;
    if (this.tokens < count) return false;
    this.tokens -= count;
    return true;
  }
}

export class DedupCache {
  private readonly order: string[] = [];
  private readonly seen = new Map<string, number>();

  constructor(private readonly capacity: number) {}

  /** Returns true if this id was already seen and is not expired. */
  has(id: string, nowMs: number): boolean {
    const exp = this.seen.get(id);
    if (exp == null) return false;
    if (exp <= nowMs) {
      this.seen.delete(id);
      return false;
    }
    return true;
  }

  add(id: string, expiryMs: number): boolean {
    if (this.seen.has(id)) return false;
    this.seen.set(id, expiryMs);
    this.order.push(id);
    while (this.order.length > this.capacity) {
      const old = this.order.shift();
      if (old && this.seen.has(old)) this.seen.delete(old);
    }
    return true;
  }
}
