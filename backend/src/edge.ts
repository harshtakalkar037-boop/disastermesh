import { randomUUID } from "node:crypto";
import {
  authorizeEvidenceRequest,
  classifyUnheard,
  officeKitStatus,
  parseGateDecision,
  parseHeardDigest,
  parseWitness,
  verifyEvidence,
  type ParsedPacket,
} from "@disastermesh/protocol";
import type { Db } from "./db.js";

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

async function audit(db: Db, action: string, detail: string, actor: string | undefined, target: string | undefined, at: number) {
  await db.query(
    "INSERT INTO audit_logs (id, at_ms, actor, action, target, detail) VALUES ($1,$2,$3,$4,$5,$6)",
    [`aud_${at}_${Math.random().toString(16).slice(2)}`, at, actor ?? null, action, target ?? null, detail],
  );
}

export async function acceptEdgePacket(
  db: Db,
  packet: ParsedPacket,
  payloadText: string,
  now: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const messageId = hex(packet.messageId);
  const origin = hex(packet.originPseudonym);
  const location = packet.location
    ? { lat: packet.location.latE7 / 1e7, lon: packet.location.lonE7 / 1e7, accuracy: packet.location.accuracyM }
    : null;
  if (packet.payloadType === "witness_delta") {
    const parsed = parseWitness(payloadText);
    if (!parsed.ok) return parsed;
    await db.query(
      `INSERT INTO witness_reports (
        id, message_id, origin_pseudonym, incident_type, claimed_state, people_count, language,
        waterline_band, tilt_deg, confidence, evidence_hash, inference, self_conflict, life_threat,
        summary_text, model, gate_decision, gate_reason, fragments_saved, lat, lon, accuracy_m,
        event_timestamp, received_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
      [
        `wit_${messageId}`, messageId, origin, parsed.value.incidentType, parsed.value.claimedState, parsed.value.peopleCount,
        parsed.value.language, parsed.value.waterlineBand, parsed.value.tiltDeg, parsed.value.confidence,
        parsed.value.evidenceHash, parsed.value.inference, parsed.value.selfConflict, parsed.value.lifeThreat,
        parsed.value.text, parsed.value.model, parsed.value.gateDecision, parsed.value.gateReason, parsed.value.fragmentsSaved,
        location?.lat ?? null, location?.lon ?? null, location?.accuracy ?? null, packet.eventTimestampMs, now,
      ],
    );
    if (parsed.value.gateDecision) await insertGate(db, messageId, origin, parsed.value.gateDecision, parsed.value.gateReason ?? "embedded", [], parsed.value.fragmentsSaved, now);
    await noteWitnessConflict(db, origin, messageId, parsed.value.peopleCount, parsed.value.claimedState, now);
    return { ok: true };
  }
  if (packet.payloadType === "heard_digest") {
    const parsed = parseHeardDigest(payloadText);
    if (!parsed.ok) return parsed;
    await db.query(
      `INSERT INTO heard_digests (id, message_id, origin_pseudonym, window_start_ms, battery_bucket, pseudonyms_json, held_message_id, received_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [randomUUID(), messageId, origin, parsed.value.windowStartMs, parsed.value.batteryBucket, JSON.stringify(parsed.value.pseudonyms), parsed.value.heldMessageId, now],
    );
    return { ok: true };
  }
  if (packet.payloadType === "scarce_slot_decision") {
    const parsed = parseGateDecision(payloadText);
    if (!parsed.ok) return parsed;
    await insertGate(db, messageId, origin, parsed.value.decision, parsed.value.reason, parsed.value.newFields, parsed.value.fragmentsSaved, now);
    return { ok: true };
  }
  if (packet.payloadType === "evidence_request" || packet.payloadType === "evidence_response") {
    return { ok: false, reason: "operator_channel_only" };
  }
  return { ok: false, reason: "not_an_edge_packet" };
}

async function insertGate(db: Db, messageId: string | null, origin: string | null, decision: string, reason: string, fields: string[], saved: number, now: number) {
  await db.query(
    "INSERT INTO gate_events (id, message_id, origin_pseudonym, decision, reason, new_fields, fragments_saved, at_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    [randomUUID(), messageId, origin, decision, reason, JSON.stringify(fields), saved, now],
  );
}

async function noteWitnessConflict(db: Db, origin: string, messageId: string, people: number | null, state: string, now: number) {
  const prior = await db.query<{ message_id: string; people_count: number | null; claimed_state: string }>(
    "SELECT message_id, people_count, claimed_state FROM witness_reports WHERE origin_pseudonym = $1 AND message_id <> $2 ORDER BY received_at DESC LIMIT 8",
    [origin, messageId],
  );
  for (const row of prior) {
    if (row.people_count != null && people != null && row.people_count !== people) {
      await db.query(
        "INSERT INTO witness_conflicts (id, origin_pseudonym, left_message_id, right_message_id, field, left_value, right_value, at_ms) VALUES ($1,$2,$3,$4,'people_count',$5,$6,$7)",
        [randomUUID(), origin, row.message_id, messageId, String(row.people_count), String(people), now],
      );
    }
    if (row.claimed_state !== state && (row.claimed_state === "need_help" || state === "need_help")) {
      await db.query(
        "INSERT INTO witness_conflicts (id, origin_pseudonym, left_message_id, right_message_id, field, left_value, right_value, at_ms) VALUES ($1,$2,$3,$4,'claimed_state',$5,$6,$7)",
        [randomUUID(), origin, row.message_id, messageId, row.claimed_state, state, now],
      );
    }
  }
}

export async function edgeBoard(db: Db, now: number) {
  const witnesses = await db.query("SELECT * FROM witness_reports ORDER BY received_at DESC LIMIT 100");
  const digests = await db.query<{ origin_pseudonym: string; window_start_ms: number; pseudonyms_json: string; battery_bucket: string; held_message_id: string | null }>(
    "SELECT origin_pseudonym, window_start_ms, pseudonyms_json, battery_bucket, held_message_id FROM heard_digests ORDER BY received_at DESC LIMIT 100",
  );
  const heard = digests.map((row) => ({
    origin: row.origin_pseudonym,
    atMs: Number(row.window_start_ms),
    heard: JSON.parse(row.pseudonyms_json) as string[],
    batteryBucket: row.battery_bucket,
    heldMessageId: row.held_message_id,
  }));
  const gate = await db.query("SELECT decision, reason, new_fields, fragments_saved, at_ms, origin_pseudonym FROM gate_events ORDER BY at_ms DESC LIMIT 100");
  const saved = await db.query<{ n: number }>("SELECT coalesce(sum(fragments_saved),0)::int AS n FROM gate_events");
  return {
    witnesses,
    heard,
    unheard: classifyUnheard(heard.map((row) => ({ atMs: row.atMs, heard: row.heard })), now),
    unheardNote: "UNHEARD ≠ SAFE",
    conflicts: await db.query("SELECT * FROM witness_conflicts ORDER BY at_ms DESC LIMIT 100"),
    countsAreSeparate: true,
    averaged: false,
    gate,
    fragmentsSaved: Number(saved[0]?.n ?? 0),
    evidence: await db.query("SELECT id, witness_id, actor, expected_hash, status, explicit, requested_at, verified_at, verify_reason FROM evidence_requests ORDER BY requested_at DESC LIMIT 100"),
    officeKit: officeKitStatus({}),
    mediaOnMesh: false,
    localModel: "MODEL_UNAVAILABLE",
  };
}

export async function requestEvidence(db: Db, actor: string, role: string, witnessId: string, explicit: boolean, now: number) {
  const allowed = authorizeEvidenceRequest(role, explicit);
  if (!allowed.ok) return allowed;
  const rows = await db.query<{ id: string; evidence_hash: string | null }>("SELECT id, evidence_hash FROM witness_reports WHERE id = $1", [witnessId]);
  if (rows.length === 0) return { ok: false as const, reason: "witness_not_found" };
  const id = randomUUID();
  await db.query(
    "INSERT INTO evidence_requests (id, witness_id, actor, expected_hash, status, explicit, requested_at) VALUES ($1,$2,$3,$4,'hash_only',true,$5)",
    [id, witnessId, actor, rows[0].evidence_hash, now],
  );
  await audit(db, "evidence_request", `explicit hash-only request for ${witnessId}`, actor, witnessId, now);
  return { ok: true as const, id, status: "hash_only", expectedHash: rows[0].evidence_hash, officeKit: officeKitStatus({}) };
}

export async function verifyPastedEvidence(db: Db, actor: string, requestId: string, bytes: Uint8Array, now: number) {
  const rows = await db.query<{ expected_hash: string | null; witness_id: string }>("SELECT expected_hash, witness_id FROM evidence_requests WHERE id = $1", [requestId]);
  if (rows.length === 0) return { ok: false as const, reason: "request_not_found" };
  const expected = rows[0].expected_hash;
  if (!expected) {
    await db.query("UPDATE evidence_requests SET status = 'no_hash', verified_at = $2, verify_reason = 'no_hash' WHERE id = $1", [requestId, now]);
    return { ok: false as const, reason: "no_hash" };
  }
  const checked = verifyEvidence(bytes, expected);
  await db.query(
    "UPDATE evidence_requests SET status = $2, verified_at = $3, verify_reason = $4 WHERE id = $1",
    [requestId, checked.ok ? "hash_matches" : "corrupt_evidence", now, checked.reason],
  );
  await audit(db, "evidence_verify", `${checked.reason}; clipboard treated as untrusted`, actor, rows[0].witness_id, now);
  return { ok: checked.ok, reason: checked.reason, storedMedia: false };
}
