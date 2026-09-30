import { randomBytes } from "node:crypto";
import {
  DEFAULT_HOP_LIMIT,
  DMSP_VERSION,
  Flag,
  FRAME_VERSION,
  MAGIC,
  MAX_HOP,
  MAX_PACKET,
  MAX_PAYLOAD,
  MAX_CLOCK_SKEW_MS,
  MAX_TTL_MS,
  PAYLOAD_TYPE_NAME,
  PUBKEY_LEN,
  PayloadType,
  SIGNATURE_LEN,
  SIGNED_HEADER_LEN,
  type PayloadTypeName,
  type Priority,
} from "./constants.js";
import { keyIdOf, type Identity } from "./crypto.js";

export interface LocationFix {
  latE7: number;
  lonE7: number;
  accuracyM: number;
  ageSec: number;
}

export interface PacketDraft {
  hopLimit?: number;
  hopCount?: number;
  relayFlags?: number;
  flags?: number;
  priority: Priority;
  payloadType: PayloadTypeName;
  messageId: Uint8Array;
  originPseudonym: Uint8Array;
  incidentId?: Uint8Array;
  eventTimestampMs: number;
  expiryTimestampMs: number;
  nonce: Uint8Array;
  sequence?: number;
  payload: Uint8Array;
  location?: LocationFix;
  simulated?: boolean;
}

export interface ParsedPacket {
  hopLimit: number;
  hopCount: number;
  relayFlags: number;
  flags: number;
  priority: Priority;
  payloadType: PayloadTypeName;
  payloadTypeCode: number;
  messageId: Uint8Array;
  originPseudonym: Uint8Array;
  incidentId: Uint8Array;
  eventTimestampMs: number;
  expiryTimestampMs: number;
  nonce: Uint8Array;
  sequence: number;
  payload: Uint8Array;
  location: LocationFix | null;
  publicKey: Uint8Array;
  signerKeyId: Uint8Array;
  simulated: boolean;
  signedBlob: Uint8Array;
  signature: Uint8Array;
  raw: Uint8Array;
}

export type VerifyFailure =
  | "bad_magic"
  | "bad_version"
  | "bad_frame"
  | "truncated"
  | "bad_signature"
  | "bad_key_id"
  | "bad_pubkey"
  | "expired"
  | "not_yet_valid"
  | "ttl_too_long"
  | "bad_priority"
  | "bad_payload_type"
  | "bad_hop"
  | "payload_too_large"
  | "location_invalid"
  | "oversized"
  | "reserved_nonzero";

export function randomId(bytes = 16): Uint8Array {
  return new Uint8Array(randomBytes(bytes));
}

export function encodePacket(draft: PacketDraft, signer: Identity): Uint8Array {
  if (draft.payload.length > MAX_PAYLOAD) throw new Error("payload too large for mesh packet");
  if (draft.messageId.length !== 16) throw new Error("messageId must be 16 bytes");
  if (draft.originPseudonym.length !== 16) throw new Error("originPseudonym must be 16 bytes");
  if (draft.nonce.length !== 12) throw new Error("nonce must be 12 bytes");
  if (signer.publicKeyRaw.length !== PUBKEY_LEN || signer.publicKeyRaw[0] !== 0x04) {
    throw new Error("public key must be uncompressed P-256");
  }
  const priority = draft.priority;
  if (!Number.isInteger(priority) || priority < 0 || priority > 4) throw new Error("bad priority");
  assertTime(draft.eventTimestampMs);
  assertTime(draft.expiryTimestampMs);
  const incidentId = draft.incidentId ?? new Uint8Array(16);
  if (incidentId.length !== 16) throw new Error("incidentId must be 16 bytes");
  const payloadTypeCode = PayloadType[draft.payloadType];
  let flags = draft.flags ?? 0;
  if (draft.location) flags |= Flag.HAS_LOCATION;
  else flags &= ~Flag.HAS_LOCATION;
  if (!isZero(incidentId)) flags |= Flag.HAS_INCIDENT;
  if (draft.simulated) flags |= Flag.SIMULATED;
  else flags &= ~Flag.SIMULATED;

  const signedLen = SIGNED_HEADER_LEN + draft.payload.length;
  const signed = new Uint8Array(signedLen);
  signed.set(MAGIC, 0);
  signed[4] = DMSP_VERSION;
  signed[5] = flags & 0xff;
  signed[6] = priority;
  signed[7] = payloadTypeCode;
  writeU16(signed, 8, draft.payload.length);
  signed.set(draft.messageId, 10);
  signed.set(draft.originPseudonym, 26);
  signed.set(incidentId, 42);
  writeU64(signed, 58, draft.eventTimestampMs);
  writeU64(signed, 66, draft.expiryTimestampMs);
  signed.set(draft.nonce, 74);
  writeU32(signed, 86, draft.sequence ?? 1);
  if (draft.location) {
    assertLocation(draft.location);
    writeI32(signed, 90, draft.location.latE7);
    writeI32(signed, 94, draft.location.lonE7);
    writeU16(signed, 98, draft.location.accuracyM);
    writeU16(signed, 100, draft.location.ageSec);
  }
  signed.set(signer.publicKeyRaw, 102);
  signed.set(keyIdOf(signer.publicKeyRaw), 167);
  // bytes 175 reserved 0
  signed.set(draft.payload, SIGNED_HEADER_LEN);

  const signature = signer.sign(signed);
  if (signature.length !== SIGNATURE_LEN) throw new Error("signer returned a non-P1363 signature");
  const hopLimit = draft.hopLimit ?? DEFAULT_HOP_LIMIT;
  const hopCount = draft.hopCount ?? 0;
  if (hopLimit < 0 || hopLimit > MAX_HOP || hopCount < 0 || hopCount > MAX_HOP) {
    throw new Error("hop fields out of range");
  }
  const raw = new Uint8Array(6 + signed.length + SIGNATURE_LEN);
  raw[0] = hopLimit;
  raw[1] = hopCount;
  raw[2] = draft.relayFlags ?? 0;
  raw[3] = FRAME_VERSION;
  writeU16(raw, 4, signed.length);
  raw.set(signed, 6);
  raw.set(signature, 6 + signed.length);
  if (raw.length > MAX_PACKET) throw new Error("encoded packet exceeds MAX_PACKET");
  return raw;
}

export function verifyPacket(
  bytes: Uint8Array,
  verifier: (blob: Uint8Array, sig: Uint8Array, pub: Uint8Array) => boolean,
  nowMs: number,
): { ok: true; packet: ParsedPacket } | { ok: false; error: VerifyFailure; packet?: ParsedPacket } {
  if (bytes.length > MAX_PACKET) return { ok: false, error: "oversized" };
  const parsed = parseUnchecked(bytes);
  if (!parsed.ok) return parsed;
  const packet = parsed.packet;
  const knownFlags = Flag.HAS_LOCATION | Flag.HAS_INCIDENT | Flag.ACK_REQUESTED | Flag.IS_ACK | Flag.GATEWAY_ORIGINATED | Flag.SIMULATED;
  if ((packet.flags & ~knownFlags) !== 0) return { ok: false, error: "reserved_nonzero", packet };
  if (packet.signedBlob[175] !== 0) return { ok: false, error: "reserved_nonzero", packet };
  if (!verifier(packet.signedBlob, packet.signature, packet.publicKey)) {
    return { ok: false, error: "bad_signature", packet };
  }
  const expectId = keyIdOf(packet.publicKey);
  if (!equalBytes(expectId, packet.signerKeyId)) return { ok: false, error: "bad_key_id", packet };
  if (packet.eventTimestampMs > nowMs + MAX_CLOCK_SKEW_MS) {
    return { ok: false, error: "not_yet_valid", packet };
  }
  if (packet.expiryTimestampMs <= nowMs) return { ok: false, error: "expired", packet };
  if (packet.expiryTimestampMs > packet.eventTimestampMs + MAX_TTL_MS) {
    return { ok: false, error: "ttl_too_long", packet };
  }
  if (packet.eventTimestampMs < nowMs - MAX_TTL_MS) return { ok: false, error: "expired", packet };
  if (packet.location && !locationInRange(packet.location)) {
    return { ok: false, error: "location_invalid", packet };
  }
  return { ok: true, packet };
}

export function withRelayHop(
  bytes: Uint8Array,
): { ok: true; bytes: Uint8Array } | { ok: false; error: "hop_exhausted" | "bad_frame" | "hop_invalid" } {
  if (bytes.length < 6 + SIGNED_HEADER_LEN + SIGNATURE_LEN || bytes.length > MAX_PACKET) {
    return { ok: false, error: "bad_frame" };
  }
  if (bytes[3] !== FRAME_VERSION) return { ok: false, error: "bad_frame" };
  const hopLimit = bytes[0];
  const hopCount = bytes[1];
  if (hopLimit < 1) return { ok: false, error: "hop_exhausted" };
  if (hopCount >= MAX_HOP || hopLimit > MAX_HOP) return { ok: false, error: "hop_invalid" };
  const next = new Uint8Array(bytes);
  next[0] = hopLimit - 1;
  next[1] = hopCount + 1;
  return { ok: true, bytes: next };
}

function parseUnchecked(
  bytes: Uint8Array,
): { ok: true; packet: ParsedPacket } | { ok: false; error: VerifyFailure } {
  if (bytes.length < 6 + SIGNED_HEADER_LEN + SIGNATURE_LEN) return { ok: false, error: "truncated" };
  if (bytes[3] !== FRAME_VERSION) return { ok: false, error: "bad_frame" };
  const hopLimit = bytes[0];
  const hopCount = bytes[1];
  if (hopLimit > MAX_HOP || hopCount > MAX_HOP) return { ok: false, error: "bad_hop" };
  const signedLen = readU16(bytes, 4);
  if (signedLen < SIGNED_HEADER_LEN || signedLen > SIGNED_HEADER_LEN + MAX_PAYLOAD) {
    return { ok: false, error: "bad_frame" };
  }
  const total = 6 + signedLen + SIGNATURE_LEN;
  if (bytes.length !== total) return { ok: false, error: "truncated" };
  const signed = bytes.subarray(6, 6 + signedLen);
  const signature = bytes.subarray(6 + signedLen);
  if (signed[0] !== MAGIC[0] || signed[1] !== MAGIC[1] || signed[2] !== MAGIC[2] || signed[3] !== MAGIC[3]) {
    return { ok: false, error: "bad_magic" };
  }
  if (signed[4] !== DMSP_VERSION) return { ok: false, error: "bad_version" };
  const flags = signed[5];
  const priority = signed[6];
  if (priority > 4) return { ok: false, error: "bad_priority" };
  const payloadTypeCode = signed[7];
  const payloadType = PAYLOAD_TYPE_NAME[payloadTypeCode];
  if (!payloadType) return { ok: false, error: "bad_payload_type" };
  const payloadLength = readU16(signed, 8);
  if (payloadLength > MAX_PAYLOAD || SIGNED_HEADER_LEN + payloadLength !== signedLen) {
    return { ok: false, error: "payload_too_large" };
  }
  const publicKey = signed.subarray(102, 167);
  if (publicKey.length !== PUBKEY_LEN || publicKey[0] !== 0x04) return { ok: false, error: "bad_pubkey" };
  const location = (flags & Flag.HAS_LOCATION) !== 0
    ? {
        latE7: readI32(signed, 90),
        lonE7: readI32(signed, 94),
        accuracyM: readU16(signed, 98),
        ageSec: readU16(signed, 100),
      }
    : null;
  if ((flags & Flag.HAS_LOCATION) === 0) {
    if (readI32(signed, 90) !== 0 || readI32(signed, 94) !== 0) {
      return { ok: false, error: "location_invalid" };
    }
  }
  const packet: ParsedPacket = {
    hopLimit,
    hopCount,
    relayFlags: bytes[2],
    flags,
    priority: priority as Priority,
    payloadType,
    payloadTypeCode,
    messageId: signed.slice(10, 26),
    originPseudonym: signed.slice(26, 42),
    incidentId: signed.slice(42, 58),
    eventTimestampMs: readU64(signed, 58),
    expiryTimestampMs: readU64(signed, 66),
    nonce: signed.slice(74, 86),
    sequence: readU32(signed, 86),
    payload: signed.slice(SIGNED_HEADER_LEN),
    location,
    publicKey: publicKey.slice(),
    signerKeyId: signed.slice(167, 175),
    simulated: (flags & Flag.SIMULATED) !== 0,
    signedBlob: signed.slice(),
    signature: signature.slice(),
    raw: bytes.slice(),
  };
  return { ok: true, packet };
}

function assertTime(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("timestamp out of range");
}

function assertLocation(location: LocationFix) {
  if (!locationInRange(location)) throw new Error("location out of range");
}

function locationInRange(location: LocationFix): boolean {
  if (!Number.isInteger(location.latE7) || location.latE7 < -900_000_000 || location.latE7 > 900_000_000) return false;
  if (!Number.isInteger(location.lonE7) || location.lonE7 < -1_800_000_000 || location.lonE7 > 1_800_000_000) return false;
  if (!Number.isInteger(location.accuracyM) || location.accuracyM < 0 || location.accuracyM > 65535) return false;
  if (!Number.isInteger(location.ageSec) || location.ageSec < 0 || location.ageSec > 65535) return false;
  return true;
}

function isZero(bytes: Uint8Array): boolean {
  return bytes.every((b) => b === 0);
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) throw new Error("bad hex");
  return new Uint8Array(Buffer.from(hex, "hex"));
}

function writeU16(buf: Uint8Array, offset: number, value: number) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new Error("u16");
  buf[offset] = (value >> 8) & 0xff;
  buf[offset + 1] = value & 0xff;
}

function writeU32(buf: Uint8Array, offset: number, value: number) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error("u32");
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

function writeI32(buf: Uint8Array, offset: number, value: number) {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) throw new Error("i32");
  writeU32(buf, offset, value < 0 ? value + 0x100000000 : value);
}

function writeU64(buf: Uint8Array, offset: number, value: number) {
  assertTime(value);
  const hi = Math.floor(value / 0x100000000);
  const lo = value - hi * 0x100000000;
  writeU32(buf, offset, hi);
  writeU32(buf, offset + 4, lo);
}

function readU16(buf: Uint8Array, offset: number): number {
  return (buf[offset] << 8) | buf[offset + 1];
}

function readU32(buf: Uint8Array, offset: number): number {
  return (
    buf[offset] * 0x1000000 +
    ((buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3])
  );
}

function readI32(buf: Uint8Array, offset: number): number {
  const u = readU32(buf, offset);
  return u > 0x7fffffff ? u - 0x100000000 : u;
}

function readU64(buf: Uint8Array, offset: number): number {
  return readU32(buf, offset) * 0x100000000 + readU32(buf, offset + 4);
}
