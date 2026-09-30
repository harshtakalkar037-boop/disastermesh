import {
  EMERGENCY_STATES,
  INCIDENT_TYPES,
  MAX_TEXT_CHARS,
  VERIFICATION_LEVELS,
  type EmergencyState,
  type IncidentType,
  type VerificationLevel,
} from "./constants.js";

const INJURY = ["none", "minor", "moderate", "severe", "critical", "unknown"] as const;
const MOBILITY = ["walking", "assisted", "immobile", "unknown"] as const;

export interface StatusPayload {
  t: IncidentType;
  s: EmergencyState;
  n?: number;
  inj?: (typeof INJURY)[number];
  mob?: (typeof MOBILITY)[number];
  vul?: number;
  txt?: string;
  lang?: "en" | "hi" | "mr";
  dest?: string;
  gs?: number;
  vl?: VerificationLevel;
}

export type PayloadError = { ok: false; error: string };
export type PayloadOk<T> = { ok: true; value: T };

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function encodeStatus(payload: StatusPayload): Uint8Array {
  const checked = parseStatus(JSON.stringify(payload));
  if (!checked.ok) throw new Error(checked.error);
  return new TextEncoder().encode(JSON.stringify(checked.value));
}

export function parseStatus(json: string): PayloadOk<StatusPayload> | PayloadError {
  if (json.length > 512) return { ok: false, error: "status payload too large" };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, error: "status payload is not json" };
  }
  if (!isObj(raw)) return { ok: false, error: "status payload must be an object" };
  const t = raw.t;
  const s = raw.s;
  if (typeof t !== "string" || !(INCIDENT_TYPES as readonly string[]).includes(t)) {
    return { ok: false, error: "bad incident type" };
  }
  if (typeof s !== "string" || !(EMERGENCY_STATES as readonly string[]).includes(s)) {
    return { ok: false, error: "bad emergency state" };
  }
  const value: StatusPayload = { t: t as IncidentType, s: s as EmergencyState };
  if (raw.n != null) {
    if (!Number.isInteger(raw.n) || (raw.n as number) < 0 || (raw.n as number) > 10000) return { ok: false, error: "bad people count" };
    value.n = raw.n as number;
  }
  if (raw.vul != null) {
    if (!Number.isInteger(raw.vul) || (raw.vul as number) < 0 || (raw.vul as number) > 10000) return { ok: false, error: "bad vulnerable count" };
    value.vul = raw.vul as number;
  }
  if (raw.inj != null) {
    if (typeof raw.inj !== "string" || !(INJURY as readonly string[]).includes(raw.inj)) return { ok: false, error: "bad injury" };
    value.inj = raw.inj as StatusPayload["inj"];
  }
  if (raw.mob != null) {
    if (typeof raw.mob !== "string" || !(MOBILITY as readonly string[]).includes(raw.mob)) return { ok: false, error: "bad mobility" };
    value.mob = raw.mob as StatusPayload["mob"];
  }
  if (raw.txt != null) {
    if (typeof raw.txt !== "string" || [...raw.txt].length > MAX_TEXT_CHARS) return { ok: false, error: "text too long for mesh" };
    value.txt = raw.txt;
  }
  if (raw.lang != null) {
    if (raw.lang !== "en" && raw.lang !== "hi" && raw.lang !== "mr") return { ok: false, error: "bad language" };
    value.lang = raw.lang;
  }
  if (raw.dest != null) {
    if (typeof raw.dest !== "string" || [...raw.dest].length > 80) return { ok: false, error: "destination too long" };
    value.dest = raw.dest;
  }
  if (raw.gs != null) {
    if (!Number.isInteger(raw.gs) || (raw.gs as number) < 0 || (raw.gs as number) > 10000) return { ok: false, error: "bad group size" };
    value.gs = raw.gs as number;
  }
  if (raw.vl != null) {
    if (typeof raw.vl !== "string" || !(VERIFICATION_LEVELS as readonly string[]).includes(raw.vl)) {
      return { ok: false, error: "bad verification level" };
    }
    if (raw.vl === "official") return { ok: false, error: "mesh status cannot self-declare official" };
    value.vl = raw.vl as VerificationLevel;
  }
  return { ok: true, value };
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}
