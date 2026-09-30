import { LINK_CHUNK } from "./constants.js";

export interface LinkFragment {
  index: number;
  count: number;
  messagePrefix: Uint8Array;
  totalLen: number;
  data: Uint8Array;
  bytes: Uint8Array;
}

const HEADER = 13;

export function fragmentPacket(packet: Uint8Array, messageId: Uint8Array): LinkFragment[] {
  if (messageId.length < 8) throw new Error("message id too short");
  if (packet.length > 0xffff) throw new Error("packet too large to fragment");
  const count = Math.max(1, Math.ceil(packet.length / LINK_CHUNK));
  if (count > 16) throw new Error("too many link fragments");
  const prefix = messageId.subarray(0, 8);
  const out: LinkFragment[] = [];
  for (let index = 0; index < count; index += 1) {
    const data = packet.subarray(index * LINK_CHUNK, Math.min(packet.length, (index + 1) * LINK_CHUNK));
    const bytes = new Uint8Array(HEADER + data.length);
    bytes[0] = (index === 0 ? 0x01 : 0) | (index === count - 1 ? 0x02 : 0);
    bytes[1] = index;
    bytes[2] = count;
    bytes.set(prefix, 3);
    bytes[11] = (packet.length >> 8) & 0xff;
    bytes[12] = packet.length & 0xff;
    bytes.set(data, HEADER);
    out.push({ index, count, messagePrefix: prefix.slice(), totalLen: packet.length, data: data.slice(), bytes });
  }
  return out;
}

export class Reassembler {
  private readonly parts = new Map<string, { total: number; count: number; chunks: Map<number, Uint8Array>; started: number }>();

  constructor(private readonly timeoutMs = 8000) {}

  push(frame: Uint8Array, nowMs: number): { done: false } | { done: true; packet: Uint8Array } | { done: false; error: string } {
    this.evict(nowMs);
    if (frame.length < HEADER) return { done: false, error: "short fragment" };
    const index = frame[1];
    const count = frame[2];
    const total = (frame[11] << 8) | frame[12];
    if (count < 1 || count > 16 || index >= count) return { done: false, error: "bad fragment index" };
    const prefix = Buffer.from(frame.subarray(3, 11)).toString("hex");
    const key = `${prefix}:${total}:${count}`;
    let entry = this.parts.get(key);
    if (!entry) {
      entry = { total, count, chunks: new Map(), started: nowMs };
      this.parts.set(key, entry);
    }
    if (entry.count !== count || entry.total !== total) return { done: false, error: "fragment mismatch" };
    entry.chunks.set(index, frame.slice(HEADER));
    if (entry.chunks.size < count) return { done: false };
    const packet = new Uint8Array(total);
    let offset = 0;
    for (let i = 0; i < count; i += 1) {
      const chunk = entry.chunks.get(i);
      if (!chunk) return { done: false, error: "missing chunk" };
      if (offset + chunk.length > total) return { done: false, error: "overflow" };
      packet.set(chunk, offset);
      offset += chunk.length;
    }
    this.parts.delete(key);
    if (offset !== total) return { done: false, error: "length mismatch" };
    return { done: true, packet };
  }

  private evict(nowMs: number) {
    for (const [key, entry] of this.parts) {
      if (nowMs - entry.started > this.timeoutMs) this.parts.delete(key);
    }
  }
}
