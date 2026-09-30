import { createHash } from "node:crypto";
import { LINK_CHUNK, MAX_PAYLOAD, type EmergencyState, type IncidentType, type Priority } from "./constants.js";
import { extractReport } from "./extractor.js";

export const WATERLINE_BANDS = ["unknown", "low", "mid", "high"] as const;
export const INFERENCE_STATUS = ["NPU", "CPU_FALLBACK", "MODEL_UNAVAILABLE"] as const;
export const GATE_DECISIONS = ["admit", "defer", "replace_previous"] as const;
export const BATTERY_BUCKETS = ["unknown", "low", "mid", "high"] as const;

export type WaterlineBand = (typeof WATERLINE_BANDS)[number];
export type InferenceStatus = (typeof INFERENCE_STATUS)[number];
export type GateDecision = (typeof GATE_DECISIONS)[number];
export type BatteryBucket = (typeof BATTERY_BUCKETS)[number];

export interface WitnessDraft {
  incidentType: IncidentType;
  claimedState: EmergencyState;
  peopleCount: number | null;
  language: "en" | "hi" | "mr" | "mixed" | "unknown";
  waterlineBand: WaterlineBand;
  tiltDeg: number | null;
  confidence: number;
  evidenceHash: string | null;
  inference: InferenceStatus;
  selfConflict: boolean;
  lifeThreat: boolean;
  sourceText: string;
  requiresUserConfirmation: true;
  model: string;
}

export interface GateFact {
  origin: string;
  incidentType: string;
  claimedState: string;
  peopleCount: number | null;
  waterlineBand: string;
  lifeThreat: boolean;
  priority: Priority;
  text: string;
}

export interface HeardSet {
  windowStartMs: number;
  batteryBucket: BatteryBucket;
  pseudonyms: string[];
  heldMessageId: string | null;
}

const HIGH = ["chest", "door", "छाती", "दरवाज", "दरवाजा", "उरा"];
const MID = ["knee", "waist", "घुटना", "कमर", "गुडघा"];
const LOW = ["ankle", "feet", "foot", "टखना", "पाय", "पैर"];

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function estimateFragments(payloadBytes: number): number {
  return Math.max(1, Math.ceil((6 + 176 + payloadBytes + 64) / LINK_CHUNK));
}

export function batteryBucket(percent: number | null): BatteryBucket {
  if (percent == null) return "unknown";
  if (percent < 15) return "low";
  if (percent < 50) return "mid";
  return "high";
}

export function localModelStatus(probe: { modelFilePresent?: boolean; npuDelegateLoaded?: boolean }): InferenceStatus {
  if (probe.npuDelegateLoaded) return "NPU";
  if (probe.modelFilePresent) return "CPU_FALLBACK";
  return "MODEL_UNAVAILABLE";
}

function bandFromText(text: string): WaterlineBand {
  const lower = text.toLowerCase();
  if (HIGH.some((word) => lower.includes(word))) return "high";
  if (MID.some((word) => lower.includes(word))) return "mid";
  if (LOW.some((word) => lower.includes(word))) return "low";
  return "unknown";
}

export function draftWitness(input: {
  transcript: string | null;
  modelStatus: InferenceStatus;
  tiltDeg?: number | null;
  frameCue?: "water_cue" | "no_water_cue" | "unknown" | null;
  modelName?: string;
}): { ok: true; draft: WitnessDraft } | { ok: false; error: "manual_form_required"; inference: "MODEL_UNAVAILABLE" } {
  const transcript = (input.transcript ?? "").trim();
  if (!transcript || (input.modelStatus === "NPU" && input.modelName == null)) {
    return { ok: false, error: "manual_form_required", inference: "MODEL_UNAVAILABLE" };
  }
  const extracted = extractReport(transcript);
  const trapped = /फंस|फँस|trapped|stuck|अडक/i.test(transcript);
  const claimedState = extracted.claimedState === "unknown" && trapped ? "need_help" : extracted.claimedState;
  const speechBand = bandFromText(transcript);
  const floodLike = extracted.incidentType === "flood" || speechBand !== "unknown";
  const selfConflict = Boolean(floodLike && input.frameCue === "no_water_cue");
  let confidence = Math.min(0.99, extracted.confidence);
  if (selfConflict) confidence = Math.min(confidence, 0.49);
  if (input.modelStatus === "MODEL_UNAVAILABLE") confidence = Math.min(confidence, 0.74);
  return {
    ok: true,
    draft: {
      incidentType: extracted.incidentType,
      claimedState,
      peopleCount: extracted.peopleCount,
      language: extracted.languageHint,
      waterlineBand: speechBand,
      tiltDeg: input.tiltDeg ?? null,
      confidence,
      evidenceHash: null,
      inference: input.modelStatus,
      selfConflict,
      lifeThreat: extracted.suggestedPriority === 0,
      sourceText: [...transcript].slice(0, 120).join(""),
      requiresUserConfirmation: true,
      model: input.modelName ?? (input.modelStatus === "MODEL_UNAVAILABLE" ? "deterministic-rules-v1" : "local-rules"),
    },
  };
}

function draftToJson(draft: WitnessDraft, hash: string | null) {
  return {
    k: "wd",
    t: draft.incidentType,
    s: draft.claimedState,
    n: draft.peopleCount,
    lang: draft.language === "en" || draft.language === "hi" || draft.language === "mr" ? draft.language : undefined,
    wb: draft.waterlineBand,
    tilt: draft.tiltDeg,
    c: draft.confidence,
    eh: hash,
    inf: draft.inference,
    cf: draft.selfConflict,
    lt: draft.lifeThreat,
    txt: [...draft.sourceText].slice(0, 72).join(""),
    model: draft.model.slice(0, 40),
  };
}

export interface WitnessRecord {
  incidentType: IncidentType;
  claimedState: EmergencyState;
  peopleCount: number | null;
  language: "en" | "hi" | "mr" | null;
  waterlineBand: WaterlineBand;
  tiltDeg: number | null;
  confidence: number;
  evidenceHash: string | null;
  inference: InferenceStatus;
  selfConflict: boolean;
  lifeThreat: boolean;
  text: string;
  model: string;
  gateDecision: GateDecision | null;
  gateReason: string | null;
  fragmentsSaved: number;
}

export function parseWitness(json: string): { ok: true; value: WitnessRecord } | { ok: false; error: string } {
  if (json.length > MAX_PAYLOAD) return { ok: false, error: "witness payload too large" };
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return { ok: false, error: "witness payload is not json" }; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "witness payload must be an object" };
  const row = raw as Record<string, unknown>;
  if ("official" in row || row.vl === "official" || row.assign || row.teamId) return { ok: false, error: "model_output_rejected" };
  if (row.k !== "wd") return { ok: false, error: "not_a_witness_delta" };
  if (typeof row.t !== "string" || typeof row.s !== "string") return { ok: false, error: "bad witness fields" };
  if (row.s === "safe" && (typeof row.txt !== "string" || row.txt.trim().length < 3)) return { ok: false, error: "cannot_mark_another_person_safe" };
  if (typeof row.c !== "number" || row.c < 0 || row.c >= 1) return { ok: false, error: "confidence_must_stay_below_one" };
  if (typeof row.wb !== "string" || !(WATERLINE_BANDS as readonly string[]).includes(row.wb)) return { ok: false, error: "bad waterline band" };
  if (typeof row.inf !== "string" || !(INFERENCE_STATUS as readonly string[]).includes(row.inf)) return { ok: false, error: "bad inference status" };
  if (row.inf === "NPU" && row.model == null) return { ok: false, error: "npu_claim_without_delegate" };
  const people = row.n == null ? null : row.n;
  if (people != null && (!Number.isInteger(people) || (people as number) < 0 || (people as number) > 10000)) return { ok: false, error: "bad people count" };
  const gate = row.gd == null ? null : row.gd;
  if (gate != null && (typeof gate !== "string" || !(GATE_DECISIONS as readonly string[]).includes(gate))) return { ok: false, error: "bad gate decision" };
  return {
    ok: true,
    value: {
      incidentType: row.t as IncidentType,
      claimedState: row.s as EmergencyState,
      peopleCount: people as number | null,
      language: row.lang === "en" || row.lang === "hi" || row.lang === "mr" ? row.lang : null,
      waterlineBand: row.wb as WaterlineBand,
      tiltDeg: typeof row.tilt === "number" ? row.tilt : null,
      confidence: row.c,
      evidenceHash: typeof row.eh === "string" ? row.eh : null,
      inference: row.inf as InferenceStatus,
      selfConflict: row.cf === true,
      lifeThreat: row.lt === true,
      text: typeof row.txt === "string" ? row.txt : "",
      model: typeof row.model === "string" ? row.model : "unspecified",
      gateDecision: gate as GateDecision | null,
      gateReason: typeof row.gr === "string" ? row.gr : null,
      fragmentsSaved: typeof row.fs === "number" ? row.fs : 0,
    },
  };
}

export function confirmWitness(
  draft: WitnessDraft,
  confirmed: boolean,
  evidence?: Uint8Array,
): { ok: false; error: string } | { ok: true; payload: Uint8Array; hash: string | null } {
  if (!confirmed) return { ok: false, error: "user_confirmation_required" };
  if (draft.confidence >= 1) return { ok: false, error: "confidence_must_stay_below_one" };
  let hash = draft.evidenceHash;
  if (evidence && evidence.length > 0) {
    const actual = sha256Hex(evidence);
    if (hash && hash !== actual) return { ok: false, error: "evidence_hash_mismatch" };
    hash = actual;
  }
  const compact = JSON.stringify({ ...draftToJson(draft, hash), gd: "admit", gr: "confirmed", fs: 0 });
  if (new TextEncoder().encode(compact).length > MAX_PAYLOAD) return { ok: false, error: "witness payload too large" };
  const parsed = parseWitness(compact);
  if (!parsed.ok) return parsed;
  return { ok: true, payload: new TextEncoder().encode(compact), hash };
}

function newFields(prior: GateFact, next: GateFact): string[] {
  const fields: string[] = [];
  if (prior.claimedState !== next.claimedState) fields.push("claimedState");
  if (prior.peopleCount !== next.peopleCount) fields.push("peopleCount");
  if (prior.waterlineBand !== next.waterlineBand) fields.push("waterlineBand");
  if (!prior.lifeThreat && next.lifeThreat) fields.push("lifeThreat");
  if (prior.incidentType !== next.incidentType) fields.push("incidentType");
  if (prior.text.trim().toLowerCase() !== next.text.trim().toLowerCase()) fields.push("text");
  return fields;
}

export function scarceSlotGate(input: {
  fact: GateFact;
  outbox: GateFact[];
  heard: GateFact[];
  batteryPercent: number | null;
  fragmentCount: number;
}): { decision: GateDecision; reason: string; newFields: string[]; fragmentsSaved: number } {
  const prior = [...input.outbox, ...input.heard].filter((item) => item.origin === input.fact.origin).at(-1) ?? null;
  const fields = prior ? newFields(prior, input.fact) : ["incidentType", "claimedState"];
  const life = input.fact.lifeThreat || input.fact.priority === 0;
  if (!prior) return { decision: "admit", reason: "new_fact", newFields: fields, fragmentsSaved: 0 };
  if (fields.length === 0) return { decision: "defer", reason: "no_new_fact", newFields: [], fragmentsSaved: input.fragmentCount };
  if (!life && input.fact.priority >= 3 && input.batteryPercent != null && input.batteryPercent < 15) {
    return { decision: "defer", reason: "battery_low_routine", newFields: fields, fragmentsSaved: input.fragmentCount };
  }
  if (input.outbox.some((item) => item.origin === input.fact.origin)) {
    return { decision: "replace_previous", reason: "new_fact_replaces_unsent", newFields: fields, fragmentsSaved: Math.max(0, input.fragmentCount - 1) };
  }
  return { decision: "admit", reason: "new_fact", newFields: fields, fragmentsSaved: 0 };
}

export function encodeGateDecision(input: {
  decision: GateDecision;
  reason: string;
  newFields: string[];
  fragmentsSaved: number;
}): { ok: true; payload: Uint8Array } | { ok: false; error: string } {
  const compact = JSON.stringify({ k: "gs", d: input.decision, r: input.reason.slice(0, 40), nf: input.newFields.slice(0, 6), fs: input.fragmentsSaved });
  const parsed = parseGateDecision(compact);
  if (!parsed.ok) return parsed;
  return { ok: true, payload: new TextEncoder().encode(compact) };
}

export function parseGateDecision(json: string): { ok: true; value: { decision: GateDecision; reason: string; newFields: string[]; fragmentsSaved: number } } | { ok: false; error: string } {
  if (json.length > 256) return { ok: false, error: "gate decision too large" };
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return { ok: false, error: "gate decision is not json" }; }
  if (!raw || typeof raw !== "object") return { ok: false, error: "gate decision must be an object" };
  const row = raw as Record<string, unknown>;
  if (row.k !== "gs") return { ok: false, error: "not_a_gate_decision" };
  if (typeof row.d !== "string" || !(GATE_DECISIONS as readonly string[]).includes(row.d)) return { ok: false, error: "bad gate decision" };
  if (typeof row.r !== "string" || !Array.isArray(row.nf) || row.nf.some((field) => typeof field !== "string")) return { ok: false, error: "bad gate fields" };
  return { ok: true, value: { decision: row.d as GateDecision, reason: row.r, newFields: row.nf as string[], fragmentsSaved: typeof row.fs === "number" ? row.fs : 0 } };
}

export function encodeHeardDigest(set: HeardSet): { ok: true; payload: Uint8Array } | { ok: false; error: string } {
  const parsed = parseHeardDigest(JSON.stringify({ k: "hd", win: set.windowStartMs, bat: set.batteryBucket, ids: set.pseudonyms, hold: set.heldMessageId }));
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    payload: new TextEncoder().encode(JSON.stringify({
      k: "hd",
      win: parsed.value.windowStartMs,
      bat: parsed.value.batteryBucket,
      ids: parsed.value.pseudonyms,
      hold: parsed.value.heldMessageId,
    })),
  };
}

export function parseHeardDigest(json: string): { ok: true; value: HeardSet } | { ok: false; error: string } {
  if (json.length > MAX_PAYLOAD) return { ok: false, error: "heard digest too large" };
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return { ok: false, error: "heard digest is not json" }; }
  if (!raw || typeof raw !== "object") return { ok: false, error: "heard digest must be an object" };
  const row = raw as Record<string, unknown>;
  if (row.k !== "hd") return { ok: false, error: "not_a_heard_digest" };
  if (!Array.isArray(row.ids) || row.ids.length > 8) return { ok: false, error: "too_many_heard_ids" };
  const pseudonyms: string[] = [];
  for (const id of row.ids) {
    if (typeof id !== "string" || !/^[0-9a-f]{32}$/i.test(id)) return { ok: false, error: "pseudonym_required" };
    pseudonyms.push(id.toLowerCase());
  }
  if (typeof row.bat !== "string" || !(BATTERY_BUCKETS as readonly string[]).includes(row.bat)) return { ok: false, error: "bad battery bucket" };
  if (typeof row.win !== "number") return { ok: false, error: "bad window" };
  return { ok: true, value: { windowStartMs: row.win, batteryBucket: row.bat as BatteryBucket, pseudonyms, heldMessageId: typeof row.hold === "string" ? row.hold : null } };
}

export function classifyUnheard(
  digests: { atMs: number; heard: string[] }[],
  nowMs: number,
  windowMs = 10 * 60_000,
): { id: string; label: "UNHEARD"; safe: false }[] {
  const current = new Set<string>();
  const previous = new Set<string>();
  for (const digest of digests) {
    const bucket = digest.atMs >= nowMs - windowMs ? current : previous;
    for (const id of digest.heard) bucket.add(id);
  }
  return [...previous].filter((id) => !current.has(id)).map((id) => ({ id, label: "UNHEARD" as const, safe: false as const }));
}

export function verifyEvidence(bytes: Uint8Array, expectedHash: string): { ok: boolean; reason: string } {
  if (!/^[0-9a-f]{64}$/i.test(expectedHash)) return { ok: false, reason: "bad_hash" };
  return sha256Hex(bytes) === expectedHash.toLowerCase() ? { ok: true, reason: "hash_matches" } : { ok: false, reason: "corrupt_evidence" };
}

export function authorizeEvidenceRequest(role: string, explicit: boolean): { ok: boolean; reason: string } {
  if (!explicit) return { ok: false, reason: "explicit_request_required" };
  if (role !== "admin" && role !== "operator") return { ok: false, reason: "unauthorized" };
  return { ok: true, reason: "operator_requested" };
}

export function officeKitStatus(probe: { sdkPresent?: boolean; transferTested?: boolean } = {}): {
  officeKit: "UNAVAILABLE" | "UNVERIFIED";
  mechanism: "os_share" | "office_kit";
  note: string;
} {
  if (!probe.sdkPresent) {
    return { officeKit: "UNAVAILABLE", mechanism: "os_share", note: "Office Kit SDK is not present. Use the platform share sheet. This is not an Office Kit transfer." };
  }
  return { officeKit: "UNVERIFIED", mechanism: "office_kit", note: "Office Kit package is present. No file transfer has been tested." };
}
