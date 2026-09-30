import { DedupCache, PriorityScheduler, mayRelay, type Priority } from "@disastermesh/protocol";

export const RADIO_KIND = "SIMULATED" as const;

export interface Scenario {
  id: string;
  description: string;
  nodes: number;
  seed: number;
  ticks: number;
  radioRangeM: number;
  gateways: number;
  partitionAt?: number;
  reconnectAt?: number;
  gatewayLossAt?: number;
  gatewayRestoreAt?: number;
  loss: number;
  duplicateChance: number;
  expiryTicks: number;
  generateEvery: number;
  originMin?: number;
  originMax?: number;
}

export interface SimResult {
  radioKind: typeof RADIO_KIND;
  notDeviceThroughput: true;
  packetCrypto: "not-applied-in-scale-model";
  scenario: string;
  seed: number;
  nodes: number;
  ticksRun: number;
  generated: number;
  deliveredToGateway: number;
  expired: number;
  duplicatesDropped: number;
  hopExhausted: number;
  batteryFiltered: number;
  maxHopsObserved: number;
  undelivered: number;
  partitionedTicks: number;
  gatewayOfflineTicks: number;
  note: string;
}

interface Packet {
  key: string;
  priority: Priority;
  hop: number;
  hopLimit: number;
  expiryTick: number;
  originPartition: number;
}

export const SCENARIOS: Record<string, Scenario> = {
  "baseline-10": {
    id: "baseline-10",
    description: "Ten logical nodes, one gateway, no partition. Simulated only.",
    nodes: 10,
    seed: 42,
    ticks: 12,
    radioRangeM: 250,
    gateways: 1,
    loss: 0,
    duplicateChance: 0,
    expiryTicks: 20,
    generateEvery: 1,
  },
  "flood-100": {
    id: "flood-100",
    description: "One hundred logical nodes with loss and duplicates. Simulated only.",
    nodes: 100,
    seed: 7,
    ticks: 16,
    radioRangeM: 220,
    gateways: 2,
    loss: 0.05,
    duplicateChance: 0.1,
    expiryTicks: 20,
    generateEvery: 2,
  },
  "partition-1000": {
    id: "partition-1000",
    description: "One thousand logical nodes, temporary partition, then reconnect. Simulated only.",
    nodes: 1000,
    seed: 99,
    ticks: 12,
    radioRangeM: 200,
    gateways: 2,
    partitionAt: 1,
    reconnectAt: 6,
    loss: 0,
    duplicateChance: 0,
    expiryTicks: 30,
    generateEvery: 3,
  },
  "gateway-loss": {
    id: "gateway-loss",
    description: "Gateway disappears and later returns. Queued logical packets are not claimed delivered.",
    nodes: 40,
    seed: 3,
    ticks: 14,
    radioRangeM: 280,
    gateways: 1,
    gatewayLossAt: 2,
    gatewayRestoreAt: 8,
    loss: 0,
    duplicateChance: 0,
    expiryTicks: 30,
    generateEvery: 1,
  },
  "stress-10000": {
    id: "stress-10000",
    description: "Ten thousand logical nodes. Throughput here is not physical-device throughput.",
    nodes: 10000,
    seed: 1,
    ticks: 6,
    radioRangeM: 180,
    gateways: 4,
    loss: 0.01,
    duplicateChance: 0.05,
    expiryTicks: 10,
    generateEvery: 4,
  },
};

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function runScenario(input: Scenario): SimResult {
  if (input.nodes < 2 || input.nodes > 10000) throw new Error("node count out of range");
  const rand = mulberry32(input.seed);
  const cols = Math.ceil(Math.sqrt(input.nodes));
  const pos = Array.from({ length: input.nodes }, (_, i) => ({
    x: (i % cols) * 111,
    y: Math.floor(i / cols) * 111,
  }));
  const neighbors: number[][] = Array.from({ length: input.nodes }, () => []);
  const bucket = 200;
  const grid = new Map<string, number[]>();
  for (let i = 0; i < input.nodes; i += 1) {
    const k = `${Math.floor(pos[i].x / bucket)}:${Math.floor(pos[i].y / bucket)}`;
    const list = grid.get(k) ?? [];
    list.push(i);
    grid.set(k, list);
  }
  for (let i = 0; i < input.nodes; i += 1) {
    const bx = Math.floor(pos[i].x / bucket);
    const by = Math.floor(pos[i].y / bucket);
    const found: number[] = [];
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (const j of grid.get(`${bx + dx}:${by + dy}`) ?? []) {
          if (j <= i) continue;
          const dist = Math.hypot(pos[i].x - pos[j].x, pos[i].y - pos[j].y);
          if (dist <= input.radioRangeM) found.push(j);
        }
      }
    }
    found.sort((a, b) => Math.hypot(pos[i].x - pos[a].x, pos[i].y - pos[a].y) - Math.hypot(pos[i].x - pos[b].x, pos[i].y - pos[b].y));
    for (const j of found.slice(0, 4)) {
      neighbors[i].push(j);
      neighbors[j].push(i);
    }
  }
  const gatewaySet = new Set<number>(Array.from({ length: Math.min(input.gateways, input.nodes) }, (_, i) => i));
  const queues = Array.from({ length: input.nodes }, () => new PriorityScheduler<Packet>());
  const dedup = Array.from({ length: input.nodes }, () => new DedupCache(500));
  const delivered = new Set<string>();
  const battery = Array.from({ length: input.nodes }, () => 40 + Math.floor(rand() * 60));
  let generated = 0;
  let expired = 0;
  let duplicatesDropped = 0;
  let hopExhausted = 0;
  let batteryFiltered = 0;
  let maxHopsObserved = 0;
  let partitionedTicks = 0;
  let gatewayOfflineTicks = 0;
  let seq = 1;
  const half = Math.floor(input.nodes / 2);

  const samePartition = (a: number, b: number, tick: number) => {
    const partitioned = input.partitionAt != null && tick >= input.partitionAt && (input.reconnectAt == null || tick < input.reconnectAt);
    if (!partitioned) return true;
    return (a < half) === (b < half);
  };

  for (let tick = 0; tick < input.ticks; tick += 1) {
    const partitioned = input.partitionAt != null && tick >= input.partitionAt && (input.reconnectAt == null || tick < input.reconnectAt);
    if (partitioned) partitionedTicks += 1;
    const gatewaysDown = input.gatewayLossAt != null && tick >= input.gatewayLossAt && (input.gatewayRestoreAt == null || tick < input.gatewayRestoreAt);
    if (gatewaysDown) gatewayOfflineTicks += 1;
    if (tick % input.generateEvery === 0) {
      const originMin = input.originMin ?? 0;
      const originMax = input.originMax ?? input.nodes - 1;
      const origin = originMin + Math.floor(rand() * (originMax - originMin + 1));
      const priority = ([0, 1, 1, 2, 3, 4] as Priority[])[Math.floor(rand() * 6)];
      const packet: Packet = {
        key: `${origin}:${seq++}`,
        priority,
        hop: 0,
        hopLimit: 8,
        expiryTick: tick + input.expiryTicks,
        originPartition: origin < half ? 0 : 1,
      };
      queues[origin].enqueue(priority, packet);
      generated += 1;
    }
    const outbound: { to: number; packet: Packet }[] = [];
    for (let n = 0; n < input.nodes; n += 1) {
      const next = queues[n].next();
      if (!next) continue;
      const packet = next.item;
      if (packet.expiryTick <= tick) {
        expired += 1;
        continue;
      }
      if (gatewaySet.has(n) && !gatewaysDown && packet.hop > 0) {
        delivered.add(packet.key);
        continue;
      }
      const decision = mayRelay(packet.priority, battery[n], battery[n] >= 8);
      if (packet.hop > 0 && !decision.allow) {
        batteryFiltered += 1;
        continue;
      }
      const peers = neighbors[n].filter((p) => samePartition(n, p, tick));
      if (peers.length === 0 || packet.hopLimit < 1) {
        if (packet.hopLimit < 1) hopExhausted += 1;
        else queues[n].enqueue(packet.priority, packet);
        continue;
      }
      const peer = peers[Math.floor(rand() * peers.length)];
      const copy: Packet = { ...packet, hop: packet.hop + 1, hopLimit: packet.hopLimit - 1 };
      maxHopsObserved = Math.max(maxHopsObserved, copy.hop);
      if (copy.hop > 8) {
        hopExhausted += 1;
        continue;
      }
      outbound.push({ to: peer, packet: copy });
      if (rand() < input.duplicateChance) outbound.push({ to: peer, packet: { ...copy } });
    }
    for (const item of outbound) {
      if (rand() < input.loss) continue;
      const cache = dedup[item.to];
      if (cache.has(item.packet.key, tick) || !cache.add(item.packet.key, item.packet.expiryTick + 1)) {
        duplicatesDropped += 1;
        continue;
      }
      if (gatewaySet.has(item.to) && !gatewaysDown) {
        delivered.add(item.packet.key);
        maxHopsObserved = Math.max(maxHopsObserved, item.packet.hop);
        continue;
      }
      queues[item.to].enqueue(item.packet.priority, item.packet);
    }
  }
  return {
    radioKind: RADIO_KIND,
    notDeviceThroughput: true,
    packetCrypto: "not-applied-in-scale-model",
    scenario: input.id,
    seed: input.seed,
    nodes: input.nodes,
    ticksRun: input.ticks,
    generated,
    deliveredToGateway: delivered.size,
    expired,
    duplicatesDropped,
    hopExhausted,
    batteryFiltered,
    maxHopsObserved,
    undelivered: Math.max(0, generated - delivered.size - expired),
    partitionedTicks,
    gatewayOfflineTicks,
    note: "Logical simulator. Do not quote these numbers as phone-to-phone throughput or coverage.",
  };
}
