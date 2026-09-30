import { DedupCache, PriorityScheduler, mayRelay } from "./routing.js";
import { equalBytes, toHex, withRelayHop, type ParsedPacket } from "./codec.js";

export const RADIO_KIND = "SIMULATED" as const;

export interface SimMetrics {
  radioKind: typeof RADIO_KIND;
  generated: number;
  relayed: number;
  locallyAccepted: number;
  duplicatesDropped: number;
  hopExhausted: number;
  expiredDropped: number;
  batteryFiltered: number;
  ticks: number;
  note: string;
}

interface Queued {
  bytes: Uint8Array;
  messageId: string;
  priority: ParsedPacket["priority"];
  expiryMs: number;
  ingress: string | null;
  origin: string;
}

/**
 * In-memory topology used to test store-and-forward, dedup, and multi-hop POLICY.
 * radioKind is always SIMULATED. This is not a radio test and must never be
 * reported as a successful physical-device relay.
 */
export class SimulatedMesh {
  readonly radioKind = RADIO_KIND;
  private links = new Set<string>();
  private remembered = new Map<string, Set<string>>();
  private outbox = new Map<string, PriorityScheduler<Queued>>();
  private dedup = new Map<string, DedupCache>();
  private accepted = new Map<string, ParsedPacket[]>();
  private seenFrom = new Map<string, Map<string, string>>();
  readonly metrics: SimMetrics = {
    radioKind: RADIO_KIND,
    generated: 0,
    relayed: 0,
    locallyAccepted: 0,
    duplicatesDropped: 0,
    hopExhausted: 0,
    expiredDropped: 0,
    batteryFiltered: 0,
    ticks: 0,
    note: "Simulated topology only. Not a measured device-to-device result.",
  };

  constructor(
    readonly nodeIds: string[],
    private readonly decode: (bytes: Uint8Array) => { ok: true; packet: ParsedPacket } | { ok: false; error: string },
    private readonly now: () => number = () => Date.now(),
    private readonly battery: (id: string) => number | null = () => 80,
    private readonly relayEnabled: (id: string) => boolean = () => true,
  ) {
    for (const id of nodeIds) {
      this.outbox.set(id, new PriorityScheduler());
      this.dedup.set(id, new DedupCache(2000));
      this.accepted.set(id, []);
      this.seenFrom.set(id, new Map());
    }
  }

  connect(a: string, b: string): void {
    if (a === b) return;
    this.links.add(key(a, b));
  }

  disconnect(a: string, b: string): void {
    this.links.delete(key(a, b));
  }

  disconnectNode(id: string): void {
    const remembered = new Set<string>();
    for (const link of [...this.links]) {
      const [x, y] = link.split("|");
      if (x === id || y === id) {
        remembered.add(link);
        this.links.delete(link);
      }
    }
    this.remembered.set(id, remembered);
  }

  reconnectNode(id: string): void {
    const remembered = this.remembered.get(id);
    if (!remembered) return;
    for (const link of remembered) this.links.add(link);
    this.remembered.delete(id);
  }

  neighbors(id: string): string[] {
    const out: string[] = [];
    for (const link of this.links) {
      const [x, y] = link.split("|");
      if (x === id) out.push(y);
      else if (y === id) out.push(x);
    }
    return out.sort();
  }

  originate(nodeId: string, bytes: Uint8Array): void {
    const decoded = this.decode(bytes);
    if (!decoded.ok) throw new Error(decoded.error);
    this.metrics.generated += 1;
    this.outbox.get(nodeId)!.enqueue(decoded.packet.priority, {
      bytes,
      messageId: toHex(decoded.packet.messageId),
      priority: decoded.packet.priority,
      expiryMs: decoded.packet.expiryTimestampMs,
      ingress: null,
      origin: nodeId,
    });
  }

  acceptedAt(nodeId: string): ParsedPacket[] {
    return this.accepted.get(nodeId) ?? [];
  }

  queuedAt(nodeId: string): number {
    return this.outbox.get(nodeId)?.size ?? 0;
  }

  tick(sendsPerNode = 4): void {
    this.metrics.ticks += 1;
    const now = this.now();
    const deliveries: { to: string; from: string; bytes: Uint8Array }[] = [];
    for (const nodeId of this.nodeIds) {
      const box = this.outbox.get(nodeId)!;
      const peers = this.neighbors(nodeId);
      let sent = 0;
      let guard = box.size + 2;
      while (sent < sendsPerNode && box.size > 0 && guard > 0) {
        guard -= 1;
        const next = box.next();
        if (!next) break;
        const item = next.item;
        if (item.expiryMs <= now) {
          this.metrics.expiredDropped += 1;
          continue;
        }
        const targets = peers.filter((p) => p !== item.ingress);
        if (targets.length === 0) {
          box.enqueue(item.priority, item);
          break;
        }
        const relay = item.origin !== nodeId;
        if (relay) {
          const decision = mayRelay(item.priority, this.battery(nodeId), this.relayEnabled(nodeId));
          if (!decision.allow) {
            this.metrics.batteryFiltered += 1;
            continue;
          }
          const hopped = withRelayHop(item.bytes);
          if (!hopped.ok) {
            this.metrics.hopExhausted += 1;
            continue;
          }
          item.bytes = hopped.bytes;
          this.metrics.relayed += 1;
        }
        for (const to of targets) deliveries.push({ to, from: nodeId, bytes: item.bytes });
        sent += 1;
      }
    }
    for (const delivery of deliveries) this.receive(delivery.to, delivery.from, delivery.bytes, now);
  }

  runUntilQuiet(maxTicks = 50): void {
    for (let i = 0; i < maxTicks; i += 1) {
      const before = this.metrics.locallyAccepted + this.metrics.duplicatesDropped + this.metrics.relayed;
      const queued = this.nodeIds.reduce((n, id) => n + this.queuedAt(id), 0);
      if (queued === 0 && i > 0) return;
      this.tick();
      const after = this.metrics.locallyAccepted + this.metrics.duplicatesDropped + this.metrics.relayed;
      if (after === before && queued === this.nodeIds.reduce((n, id) => n + this.queuedAt(id), 0)) return;
    }
  }

  private receive(nodeId: string, from: string, bytes: Uint8Array, now: number) {
    const decoded = this.decode(bytes);
    if (!decoded.ok) return;
    const id = toHex(decoded.packet.messageId);
    const cache = this.dedup.get(nodeId)!;
    if (cache.has(id, now) || !cache.add(id, decoded.packet.expiryTimestampMs)) {
      this.metrics.duplicatesDropped += 1;
      return;
    }
    this.metrics.locallyAccepted += 1;
    this.accepted.get(nodeId)!.push(decoded.packet);
    this.seenFrom.get(nodeId)!.set(id, from);
    if (decoded.packet.hopLimit > 0) {
      this.outbox.get(nodeId)!.enqueue(decoded.packet.priority, {
        bytes,
        messageId: id,
        priority: decoded.packet.priority,
        expiryMs: decoded.packet.expiryTimestampMs,
        ingress: from,
        origin: "remote",
      });
    }
  }

  receivedVia(nodeId: string, messageId: Uint8Array): string | undefined {
    return this.seenFrom.get(nodeId)?.get(toHex(messageId));
  }

  hasDirectLink(a: string, b: string): boolean {
    return this.links.has(key(a, b));
  }
}

function key(a: string, b: string): string {
  return [a, b].sort().join("|");
}

export function samePacketId(a: ParsedPacket, messageId: Uint8Array): boolean {
  return equalBytes(a.messageId, messageId);
}
