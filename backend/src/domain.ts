import {
  clusterReports,
  diffGroups,
  findContradictions,
  parseStatus,
  suggestDuplicates,
  utf8Decode,
  type ParsedPacket,
  type ReportPoint,
} from "@disastermesh/protocol";
import type { Db } from "./db.js";

export function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export async function audit(db: Db, action: string, detail: string, actor?: string, target?: string, at = Date.now()): Promise<void> {
  await db.query(
    "INSERT INTO audit_logs (id, at_ms, actor, action, target, detail) VALUES ($1, $2, $3, $4, $5, $6)",
    [`aud_${at}_${Math.random().toString(16).slice(2)}`, at, actor ?? null, action, target ?? null, detail],
  );
}

export async function acceptSignedPacket(
  db: Db,
  packet: ParsedPacket,
  rawHex: string,
  now: number,
): Promise<{ messageId: string; result: "accepted" | "duplicate" | "rejected"; reason?: string; incidentId?: string }> {
  const messageId = hex(packet.messageId);
  if (packet.simulated) {
    await storePacket(db, packet, rawHex, now, "rejected", "simulated_flag_on_live_sync");
    return { messageId, result: "rejected", reason: "simulated_flag_on_live_sync" };
  }
  const existing = await db.query<{ message_id: string }>("SELECT message_id FROM packets WHERE message_id = $1", [messageId]);
  if (existing.length > 0) return { messageId, result: "duplicate", reason: "message_id" };

  const payloadText = utf8Decode(packet.payload);
  if (
    packet.payloadType === "witness_delta"
    || packet.payloadType === "heard_digest"
    || packet.payloadType === "scarce_slot_decision"
    || packet.payloadType === "evidence_request"
    || packet.payloadType === "evidence_response"
  ) {
    const { acceptEdgePacket } = await import("./edge.js");
    const edge = await acceptEdgePacket(db, packet, payloadText, now);
    if (!edge.ok) {
      await storePacket(db, packet, rawHex, now, "rejected", edge.reason);
      await delivery(db, messageId, "rejected", now, "gateway", edge.reason);
      return { messageId, result: "rejected", reason: edge.reason };
    }
    await storePacket(db, packet, rawHex, now, "accepted", null);
    await delivery(db, messageId, "received_by_command_center", now, "gateway", "edge fact stored; media was not requested");
    return { messageId, result: "accepted" };
  }
  const structured = packet.payloadType === "status" || packet.payloadType === "sos" || packet.payloadType === "disaster_report"
    ? parseStatus(payloadText)
    : null;
  if (structured && !structured.ok && packet.payloadType !== "hello") {
    await storePacket(db, packet, rawHex, now, "rejected", structured.error);
    await delivery(db, messageId, "rejected", now, "gateway", structured.error);
    return { messageId, result: "rejected", reason: structured.error };
  }
  await storePacket(db, packet, rawHex, now, "accepted", null);
  await delivery(db, messageId, "received_by_command_center", now, "gateway", "signature valid; factual verification is separate");

  if (!structured || !structured.ok) {
    return { messageId, result: "accepted" };
  }
  const origin = hex(packet.originPseudonym);
  const incidentHex = hex(packet.incidentId);
  const incidentKey = `${origin}:${incidentHex}`;
  const id = incidentKey;
  const body = structured.value;
  const rows = await db.query<IncidentRow>(
    "SELECT id, content_sequence, emergency_state, raw_payload, origin_pseudonym FROM incidents WHERE id = $1",
    [id],
  );
  const location = packet.location
    ? {
        lat: packet.location.latE7 / 1e7,
        lon: packet.location.lonE7 / 1e7,
        accuracy: packet.location.accuracyM,
      }
    : null;
  if (rows.length === 0) {
    await db.query(
      `INSERT INTO incidents (
        id, message_id, origin_pseudonym, incident_key, incident_type, emergency_state, priority,
        people_count, injury_severity, mobility, vulnerable_count, summary_text, language,
        lat, lon, accuracy_m, location_time, event_timestamp, received_at, expires_at,
        verification_level, source_auth, content_sequence, simulated, cancelled, raw_payload
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,false,false,$24
      )`,
      [
        id, messageId, origin, incidentKey, body.t, body.s, packet.priority,
        body.n ?? null, body.inj ?? null, body.mob ?? null, body.vul ?? null, body.txt ?? null, body.lang ?? null,
        location?.lat ?? null, location?.lon ?? null, location?.accuracy ?? null, location ? packet.eventTimestampMs : null,
        packet.eventTimestampMs, now, packet.expiryTimestampMs,
        body.vl ?? "unverified", "signature_valid", packet.sequence, payloadText,
      ],
    );
  } else {
    const current = rows[0];
    if (packet.sequence < current.content_sequence) {
      await conflict(db, id, messageId, "stale_sequence", now);
      await delivery(db, messageId, "rejected", now, "gateway", "stale_sequence");
      await db.query("UPDATE packets SET accept_result = $2, reject_reason = $3 WHERE message_id = $1", [messageId, "rejected", "stale_sequence"]);
      return { messageId, result: "rejected", reason: "stale_sequence", incidentId: id };
    }
    if (packet.sequence === current.content_sequence && current.raw_payload !== payloadText) {
      await conflict(db, id, messageId, "same_sequence_conflict", now);
      return { messageId, result: "rejected", reason: "same_sequence_conflict", incidentId: id };
    }
    if (current.origin_pseudonym !== origin) {
      await conflict(db, id, messageId, "origin_mismatch", now);
      return { messageId, result: "rejected", reason: "origin_mismatch", incidentId: id };
    }
    await db.query(
      `UPDATE incidents SET message_id=$2, emergency_state=$3, priority=$4, people_count=$5, injury_severity=$6,
        mobility=$7, vulnerable_count=$8, summary_text=$9, language=$10, lat=$11, lon=$12, accuracy_m=$13,
        event_timestamp=$14, received_at=$15, expires_at=$16, verification_level=$17, content_sequence=$18, raw_payload=$19
       WHERE id=$1`,
      [
        id, messageId, body.s, packet.priority, body.n ?? null, body.inj ?? null, body.mob ?? null, body.vul ?? null,
        body.txt ?? null, body.lang ?? null, location?.lat ?? null, location?.lon ?? null, location?.accuracy ?? null,
        packet.eventTimestampMs, now, packet.expiryTimestampMs, body.vl ?? "unverified", packet.sequence, payloadText,
      ],
    );
  }
  if (location) {
    await db.query(
      "INSERT INTO observations (id, kind, lat, lon, accuracy_m, observed_at, source_id, simulated) VALUES ($1,$2,$3,$4,$5,$6,$7,false)",
      [`obs_${messageId}`, "incident", location.lat, location.lon, location.accuracy, packet.eventTimestampMs, origin],
    );
  }
  await rebuildAutoGroups(db, false, now);
  return { messageId, result: "accepted", incidentId: id };
}

interface IncidentRow {
  id: string;
  content_sequence: number;
  emergency_state: string;
  raw_payload: string;
  origin_pseudonym: string;
}

async function storePacket(db: Db, packet: ParsedPacket, rawHex: string, now: number, result: string, reason: string | null) {
  await db.query(
    `INSERT INTO packets (message_id, origin_pseudonym, payload_type, priority, event_timestamp, received_at, expires_at, hop_count, signature_valid, simulated, raw_hex, accept_result, reject_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9,$10,$11,$12)
     ON CONFLICT (message_id) DO NOTHING`,
    [
      hex(packet.messageId), hex(packet.originPseudonym), packet.payloadType, packet.priority,
      packet.eventTimestampMs, now, packet.expiryTimestampMs, packet.hopCount, packet.simulated,
      rawHex, result, reason,
    ],
  );
}

async function delivery(db: Db, messageId: string, state: string, now: number, actor: string, detail: string) {
  await db.query(
    "INSERT INTO delivery_events (id, message_id, state, at_ms, actor, detail) VALUES ($1,$2,$3,$4,$5,$6)",
    [`del_${messageId}_${state}_${now}`, messageId, state, now, actor, detail],
  );
}

async function conflict(db: Db, incidentId: string, messageId: string, reason: string, now: number) {
  await db.query(
    "INSERT INTO incident_conflicts (id, incident_id, message_id, reason, at_ms, resolved) VALUES ($1,$2,$3,$4,$5,false)",
    [`cnf_${messageId}`, incidentId, messageId, reason, now],
  );
}

export async function rebuildAutoGroups(db: Db, simulated: boolean, now: number): Promise<void> {
  const rows = await db.query<{
    id: string;
    incident_type: string;
    event_timestamp: number | string;
    lat: number | null;
    lon: number | null;
    accuracy_m: number | null;
  }>("SELECT id, incident_type, event_timestamp, lat, lon, accuracy_m FROM incidents WHERE simulated = $1 AND cancelled = false", [simulated]);
  const points: ReportPoint[] = rows.map((row) => ({
    id: row.id,
    incidentType: row.incident_type,
    eventTimestampMs: Number(row.event_timestamp),
    lat: row.lat,
    lon: row.lon,
    accuracyM: row.accuracy_m,
  }));
  const previousRows = await db.query<{ id: string; incident_type: string; confidence: string; centroid_lat: number | null; centroid_lon: number | null }>(
    "SELECT id, incident_type, confidence, centroid_lat, centroid_lon FROM emergency_groups WHERE simulated = $1 AND source = 'auto'",
    [simulated],
  );
  const memberRows = await db.query<{ group_id: string; incident_id: string }>(
    "SELECT group_id, incident_id FROM group_members WHERE group_id IN (SELECT id FROM emergency_groups WHERE simulated = $1 AND source = 'auto')",
    [simulated],
  );
  const previous = previousRows.map((g) => ({
    id: g.id,
    incidentType: g.incident_type,
    memberIds: memberRows.filter((m) => m.group_id === g.id).map((m) => m.incident_id),
    confidence: g.confidence as "high" | "low" | "unknown",
    centroidLat: g.centroid_lat,
    centroidLon: g.centroid_lon,
  }));
  const clustered = clusterReports(points);
  const events = diffGroups(previous, clustered.groups, now);
  await db.query("DELETE FROM group_members WHERE group_id IN (SELECT id FROM emergency_groups WHERE simulated = $1 AND source = 'auto')", [simulated]);
  await db.query("DELETE FROM emergency_groups WHERE simulated = $1 AND source = 'auto'", [simulated]);
  for (const group of clustered.groups) {
    await db.query(
      `INSERT INTO emergency_groups (id, incident_type, created_at, updated_at, confidence, centroid_lat, centroid_lon, simulated, source, status)
       VALUES ($1,$2,$3,$3,$4,$5,$6,$7,'auto','active')`,
      [group.id, group.incidentType, now, group.confidence, group.centroidLat, group.centroidLon, simulated],
    );
    for (const member of group.memberIds) {
      await db.query("INSERT INTO group_members (group_id, incident_id, joined_at) VALUES ($1,$2,$3)", [group.id, member, now]);
    }
  }
  for (const event of events) {
    await db.query(
      "INSERT INTO group_lineage (id, event_type, group_id, other_group_id, at_ms, details, simulated) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [`lin_${now}_${Math.random().toString(16).slice(2)}`, event.type, event.groupId, event.otherGroupId ?? null, now, JSON.stringify(event), simulated],
    );
  }
}

export async function reviewHints(db: Db, simulated: boolean) {
  const rows = await db.query<{
    id: string;
    incident_type: string;
    event_timestamp: number | string;
    lat: number | null;
    lon: number | null;
    accuracy_m: number | null;
    emergency_state: string;
  }>("SELECT id, incident_type, event_timestamp, lat, lon, accuracy_m, emergency_state FROM incidents WHERE simulated = $1 AND cancelled = false", [simulated]);
  const points = rows.map((row) => ({
    id: row.id,
    incidentType: row.incident_type,
    eventTimestampMs: Number(row.event_timestamp),
    lat: row.lat,
    lon: row.lon,
    accuracyM: row.accuracy_m,
    state: row.emergency_state,
  }));
  return {
    duplicates: suggestDuplicates(points),
    contradictions: findContradictions(points),
    advisory: "Suggestions only. Do not automatically declare anyone safe or allocate rescue resources.",
  };
}
