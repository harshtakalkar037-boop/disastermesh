import { createHash, randomUUID } from "node:crypto";
import { createReadStream, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import { z } from "zod";
import {
  extractReport,
  fromHex,
  toHex,
  verifyP256,
  verifyPacket,
  type Priority,
} from "@disastermesh/protocol";
import { SCENARIOS, runScenario } from "@disastermesh/simulator";
import type { AppConfig } from "./config.js";
import type { Db } from "./db.js";
import { acceptSignedPacket, audit, reviewHints } from "./domain.js";
import { edgeBoard, requestEvidence, verifyPastedEvidence } from "./edge.js";
import { dummyVerify, hashPassword, verifyPassword } from "./passwords.js";

export interface BuildOpts {
  db: Db;
  config: AppConfig;
  now?: () => number;
}

type AuthUser = { sub: string; role: string; email: string };

const loginAttempts = new Map<string, { fails: number; windowStart: number }>();

export class UnconfiguredOfficialFeed {
  readonly id = "none";
  async pull(): Promise<{ configured: false; reason: string }> {
    return {
      configured: false,
      reason: "No authorized government alert feed is configured. This build does not integrate SACHET or any other official warning system.",
    };
  }
}

export async function buildApp(opts: BuildOpts): Promise<FastifyInstance> {
  const now = opts.now ?? (() => Date.now());
  const { db, config } = opts;
  const https = config.tlsCert && config.tlsKey
    ? { cert: (await import("node:fs")).readFileSync(config.tlsCert), key: (await import("node:fs")).readFileSync(config.tlsKey) }
    : undefined;
  const app = Fastify({ logger: false, ...(https ? { https } : {}) });
  await app.register(cors, { origin: config.corsOrigin.split(","), credentials: false });
  await app.register(jwt, { secret: config.jwtSecret });
  await app.register(multipart, { limits: { fileSize: 4 * 1024 * 1024, files: 1 } });
  await app.register(websocket);
  const feed = new UnconfiguredOfficialFeed();
  const sockets = new Set<{ send: (s: string) => void }>();

  function broadcast(event: Record<string, unknown>) {
    const payload = JSON.stringify({ ...event, at: now() });
    for (const socket of sockets) {
      try { socket.send(payload); } catch { sockets.delete(socket); }
    }
  }

  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("X-DisasterMesh-Prototype", "not-a-certified-emergency-service");
    return payload;
  });

  function userOf(req: FastifyRequest): AuthUser {
    return req.user as AuthUser;
  }

  async function requireUser(req: FastifyRequest, reply: FastifyReply) {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: "unauthorized" });
    }
  }

  function requireRoles(...roles: string[]) {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      await requireUser(req, reply);
      if (reply.sent) return;
      if (!roles.includes(userOf(req).role)) return reply.code(403).send({ error: "forbidden" });
    };
  }

  app.get("/api/v1/health", async () => ({
    ok: true,
    service: "disastermesh-backend",
    db: db.kind,
    prototype: true,
    certifiedEmergencyService: false,
    tls: Boolean(https),
    officialAlertFeed: feed.id,
  }));

  app.post("/api/v1/auth/login", async (req, reply) => {
    const body = z.object({ email: z.string().email(), password: z.string().min(1).max(200) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const key = `${req.ip}:${body.data.email.toLowerCase()}`;
    const slot = loginAttempts.get(key) ?? { fails: 0, windowStart: now() };
    if (now() - slot.windowStart > 15 * 60_000) {
      slot.fails = 0;
      slot.windowStart = now();
    }
    if (slot.fails >= 8) return reply.code(429).send({ error: "rate_limited" });
    const rows = await db.query<{ id: string; email: string; password_hash: string; role: string; display_name: string; disabled: boolean }>(
      "SELECT id, email, password_hash, role, display_name, disabled FROM users WHERE email = $1",
      [body.data.email.toLowerCase()],
    );
    const user = rows[0];
    const ok = user ? await verifyPassword(body.data.password, user.password_hash) : false;
    if (!user) await dummyVerify(body.data.password);
    if (!user || !ok || user.disabled) {
      slot.fails += 1;
      loginAttempts.set(key, slot);
      await audit(db, "login_failed", body.data.email.toLowerCase(), undefined, undefined, now());
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    loginAttempts.delete(key);
    const token = await reply.jwtSign({ sub: user.id, role: user.role, email: user.email }, { expiresIn: "8h" });
    await audit(db, "login", user.email, user.id, user.id, now());
    return { token, user: { id: user.id, email: user.email, role: user.role, displayName: user.display_name } };
  });

  app.post("/api/v1/auth/logout", { preHandler: requireUser }, async (req) => {
    await audit(db, "logout", "client should discard the token", userOf(req).sub, undefined, now());
    return { ok: true };
  });

  app.get("/api/v1/auth/me", { preHandler: requireUser }, async (req, reply) => {
    const rows = await db.query("SELECT id, email, role, display_name, team_id, disabled FROM users WHERE id = $1", [userOf(req).sub]);
    if (rows.length === 0) return reply.code(401).send({ error: "unauthorized" });
    return { user: rows[0] };
  });

  app.get("/api/v1/dashboard/summary", { preHandler: requireRoles("admin", "operator", "responder", "alert_publisher") }, async (req) => {
    const includeSimulated = boolQuery(req, "includeSimulated");
    return summary(db, includeSimulated, now());
  });

  app.get("/api/v1/incidents", { preHandler: requireRoles("admin", "operator", "responder") }, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const includeSimulated = q.includeSimulated === "1";
    const where = ["simulated = $1"];
    const params: unknown[] = [includeSimulated];
    if (q.state) {
      params.push(q.state);
      where.push(`emergency_state = $${params.length}`);
    }
    if (q.verification) {
      params.push(q.verification);
      where.push(`verification_level = $${params.length}`);
    }
    if (q.urgency) {
      params.push(Number(q.urgency));
      where.push(`priority = $${params.length}`);
    }
    if (q.assigned === "unassigned") where.push("assigned_team_id IS NULL");
    if (q.assigned && q.assigned !== "unassigned") {
      params.push(q.assigned);
      where.push(`assigned_team_id = $${params.length}`);
    }
    if (q.ageHours) {
      params.push(now() - Number(q.ageHours) * 3600_000);
      where.push(`event_timestamp >= $${params.length}`);
    }
    if (q.q) {
      params.push(`%${q.q.slice(0, 80)}%`);
      where.push(`(summary_text ILIKE $${params.length} OR incident_type ILIKE $${params.length} OR id ILIKE $${params.length})`);
    }
    params.push(200);
    const rows = await db.query(
      `SELECT * FROM incidents WHERE ${where.join(" AND ")} ORDER BY priority ASC, event_timestamp DESC LIMIT $${params.length}`,
      params,
    );
    return { incidents: rows, source: includeSimulated ? "simulator" : "live" };
  });

  app.get("/api/v1/incidents/:id", { preHandler: requireRoles("admin", "operator", "responder") }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const rows = await db.query("SELECT * FROM incidents WHERE id = $1", [id]);
    if (rows.length === 0) return reply.code(404).send({ error: "not_found" });
    const events = await db.query("SELECT * FROM delivery_events WHERE message_id = $1 ORDER BY at_ms", [(rows[0] as { message_id: string }).message_id]);
    const conflicts = await db.query("SELECT * FROM incident_conflicts WHERE incident_id = $1", [id]);
    return { incident: rows[0], events, conflicts };
  });

  app.patch("/api/v1/incidents/:id", { preHandler: requireRoles("admin", "operator") }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = z.object({
      emergencyState: z.enum(["unknown", "need_help", "safe", "evacuating", "resolved"]).optional(),
      verificationLevel: z.enum(["unverified", "eyewitness", "corroborated", "conflicting"]).optional(),
      operatorNote: z.string().max(500).optional(),
      peopleCount: z.number().int().min(0).max(10000).nullable().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const current = await db.query("SELECT id FROM incidents WHERE id = $1", [id]);
    if (current.length === 0) return reply.code(404).send({ error: "not_found" });
    if (body.data.emergencyState) await db.query("UPDATE incidents SET emergency_state = $2 WHERE id = $1", [id, body.data.emergencyState]);
    if (body.data.verificationLevel) await db.query("UPDATE incidents SET verification_level = $2 WHERE id = $1", [id, body.data.verificationLevel]);
    if (body.data.operatorNote != null) await db.query("UPDATE incidents SET operator_note = $2 WHERE id = $1", [id, body.data.operatorNote]);
    if (body.data.peopleCount !== undefined) await db.query("UPDATE incidents SET people_count = $2 WHERE id = $1", [id, body.data.peopleCount]);
    await audit(db, "incident_corrected", JSON.stringify(body.data), userOf(req).sub, id, now());
    broadcast({ type: "incident", id });
    const rows = await db.query("SELECT * FROM incidents WHERE id = $1", [id]);
    return { incident: rows[0] };
  });

  app.post("/api/v1/incidents/:id/ack", { preHandler: requireRoles("admin", "operator") }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const rows = await db.query<{ message_id: string }>("SELECT message_id FROM incidents WHERE id = $1", [id]);
    if (rows.length === 0) return reply.code(404).send({ error: "not_found" });
    await db.query(
      "INSERT INTO delivery_events (id, message_id, state, at_ms, actor, detail) VALUES ($1,$2,'acknowledged_by_operator',$3,$4,$5)",
      [`ack_${id}_${now()}`, rows[0].message_id, now(), userOf(req).sub, "Operator marked the report as seen. This is not a rescue promise."],
    );
    await audit(db, "operator_ack", "seen, not a rescue promise", userOf(req).sub, id, now());
    broadcast({ type: "ack", id });
    return { ok: true, state: "acknowledged_by_operator" };
  });

  app.post("/api/v1/incidents/:id/assign", { preHandler: requireRoles("admin", "operator") }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = z.object({ teamId: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const team = await db.query("SELECT id FROM teams WHERE id = $1", [body.data.teamId]);
    if (team.length === 0) return reply.code(404).send({ error: "team_not_found" });
    const updated = await db.query("UPDATE incidents SET assigned_team_id = $2 WHERE id = $1 RETURNING id", [id, body.data.teamId]);
    if (updated.length === 0) return reply.code(404).send({ error: "not_found" });
    await audit(db, "assign_incident", body.data.teamId, userOf(req).sub, id, now());
    return { ok: true };
  });

  app.get("/api/v1/groups", { preHandler: requireRoles("admin", "operator", "responder") }, async (req) => {
    const includeSimulated = boolQuery(req, "includeSimulated");
    const groups = await db.query("SELECT * FROM emergency_groups WHERE simulated = $1 ORDER BY updated_at DESC", [includeSimulated]);
    const members = await db.query("SELECT * FROM group_members");
    const lineage = await db.query("SELECT * FROM group_lineage WHERE simulated = $1 ORDER BY at_ms DESC LIMIT 200", [includeSimulated]);
    return {
      groups: groups.map((g) => ({ ...g, members: members.filter((m) => (m as { group_id: string }).group_id === (g as { id: string }).id) })),
      lineage,
      note: "Auto groups use conservative GPS rules. BLE proximity is not membership proof.",
    };
  });

  app.post("/api/v1/groups/manual-merge", { preHandler: requireRoles("admin", "operator") }, async (req, reply) => {
    const body = z.object({ groupIds: z.array(z.string()).min(2), reason: z.string().min(3).max(200) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const id = `manual:${randomUUID()}`;
    const members = await db.query<{ incident_id: string }>(
      "SELECT incident_id FROM group_members WHERE group_id = ANY($1::text[])",
      [body.data.groupIds],
    );
    await db.query(
      `INSERT INTO emergency_groups (id, incident_type, created_at, updated_at, confidence, simulated, source, status)
       VALUES ($1, 'mixed', $2, $2, 'unknown', false, 'operator', 'active')`,
      [id, now()],
    );
    for (const member of members) {
      await db.query("INSERT INTO group_members (group_id, incident_id, joined_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [id, member.incident_id, now()]);
    }
    await db.query(
      "INSERT INTO group_lineage (id, event_type, group_id, at_ms, details, simulated) VALUES ($1,'merge',$2,$3,$4,false)",
      [`lin_${id}`, id, now(), JSON.stringify({ reason: body.data.reason, sources: body.data.groupIds, reportsPreserved: true })],
    );
    await audit(db, "manual_merge", body.data.reason, userOf(req).sub, id, now());
    return { id, note: "Manual merge does not delete individual reports and is not proof people are together." };
  });

  app.post("/api/v1/groups/:id/assign", { preHandler: requireRoles("admin", "operator") }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = z.object({ teamId: z.string() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const updated = await db.query("UPDATE emergency_groups SET assigned_team_id = $2, updated_at = $3 WHERE id = $1 RETURNING id", [id, body.data.teamId, now()]);
    if (updated.length === 0) return reply.code(404).send({ error: "not_found" });
    await audit(db, "assign_group", body.data.teamId, userOf(req).sub, id, now());
    return { ok: true };
  });

  app.get("/api/v1/teams", { preHandler: requireRoles("admin", "operator", "responder") }, async () => {
    const teams = await db.query("SELECT * FROM teams ORDER BY name");
    return { teams };
  });

  app.post("/api/v1/teams", { preHandler: requireRoles("admin", "operator") }, async (req, reply) => {
    const body = z.object({ name: z.string().min(2).max(80), availability: z.string().min(2).max(40) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const id = randomUUID();
    await db.query(
      "INSERT INTO teams (id, name, status, availability, updated_at, simulated) VALUES ($1,$2,'available',$3,$4,false)",
      [id, body.data.name, body.data.availability, now()],
    );
    await audit(db, "team_created", body.data.name, userOf(req).sub, id, now());
    return { id };
  });

  app.patch("/api/v1/teams/:id", { preHandler: requireRoles("admin", "operator", "responder") }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = z.object({
      status: z.enum(["available", "assigned", "rescue_in_progress", "partially_resolved", "resolved", "handoff_requested"]).optional(),
      availability: z.string().max(40).optional(),
      etaNote: z.string().max(160).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const actor = userOf(req);
    if (actor.role === "responder") {
      const mine = await db.query("SELECT id FROM users WHERE id = $1 AND team_id = $2", [actor.sub, id]);
      if (mine.length === 0) return reply.code(403).send({ error: "not_your_team" });
    }
    const current = await db.query("SELECT id FROM teams WHERE id = $1", [id]);
    if (current.length === 0) return reply.code(404).send({ error: "not_found" });
    if (body.data.status) await db.query("UPDATE teams SET status = $2, updated_at = $3 WHERE id = $1", [id, body.data.status, now()]);
    if (body.data.availability) await db.query("UPDATE teams SET availability = $2, updated_at = $3 WHERE id = $1", [id, body.data.availability, now()]);
    if (body.data.etaNote != null) await db.query("UPDATE teams SET eta_note = $2, updated_at = $3 WHERE id = $1", [id, body.data.etaNote, now()]);
    await audit(db, "team_status", JSON.stringify(body.data), actor.sub, id, now());
    broadcast({ type: "team", id });
    return { ok: true };
  });

  app.get("/api/v1/alerts", { preHandler: requireRoles("admin", "operator", "responder", "alert_publisher") }, async (req) => {
    const includeSimulated = boolQuery(req, "includeSimulated");
    const alerts = await db.query("SELECT * FROM alerts WHERE simulated = $1 ORDER BY created_at DESC LIMIT 200", [includeSimulated]);
    return { alerts, officialFeed: await feed.pull() };
  });

  app.post("/api/v1/alerts", { preHandler: requireRoles("admin", "alert_publisher") }, async (req, reply) => {
    const body = z.object({
      title: z.string().min(3).max(120),
      body: z.string().min(3).max(1000),
      severity: z.enum(["info", "watch", "warning"]),
      kind: z.enum(["test", "official"]),
      language: z.enum(["en", "hi", "mr"]),
      lat: z.number().optional(),
      lon: z.number().optional(),
      radiusM: z.number().int().positive().max(100000).optional(),
      confirmOfficial: z.string().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    if (body.data.kind === "official") {
      if (userOf(req).role !== "admin") return reply.code(403).send({ error: "official_alerts_require_admin" });
      if (body.data.confirmOfficial !== "VERIFIED_OFFICIAL_NOT_AI") {
        return reply.code(400).send({ error: "official_confirmation_required" });
      }
    }
    const id = randomUUID();
    const source = body.data.kind === "official" ? "operator-marked-official" : "test-alert";
    await db.query(
      `INSERT INTO alerts (id, title, body, severity, kind, source_label, language, lat, lon, radius_m, created_by, created_at, simulated, ai_generated)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,false,false)`,
      [id, body.data.title, body.data.body, body.data.severity, body.data.kind, source, body.data.language, body.data.lat ?? null, body.data.lon ?? null, body.data.radiusM ?? null, userOf(req).sub, now()],
    );
    await audit(db, "alert_published", source, userOf(req).sub, id, now());
    broadcast({ type: "alert", id, kind: body.data.kind });
    return { id, sourceLabel: source, aiGenerated: false };
  });

  app.get("/api/v1/alerts/official-feed", { preHandler: requireRoles("admin", "operator", "alert_publisher") }, async () => feed.pull());

  app.get("/api/v1/timeline", { preHandler: requireRoles("admin", "operator", "responder") }, async (req) => {
    const limit = Math.min(500, Number((req.query as { limit?: string }).limit ?? 100));
    const events = await db.query("SELECT * FROM delivery_events ORDER BY at_ms DESC LIMIT $1", [limit]);
    const packets = await db.query("SELECT message_id, payload_type, priority, accept_result, reject_reason, received_at, event_timestamp, simulated, hop_count FROM packets ORDER BY received_at DESC LIMIT $1", [limit]);
    return { events, packets, note: "event_timestamp is when the phone created the event. received_at is gateway arrival." };
  });

  app.get("/api/v1/connectivity", { preHandler: requireRoles("admin", "operator") }, async (req) => {
    const includeSimulated = boolQuery(req, "includeSimulated");
    const contacts = await db.query(
      "SELECT kind, source_id, max(observed_at) AS last_at, count(*)::int AS observations FROM observations WHERE simulated = $1 GROUP BY kind, source_id ORDER BY max(observed_at) DESC LIMIT 200",
      [includeSimulated],
    );
    return {
      contacts,
      coverageClaim: null,
      note: "Observed contacts only. This is not a measured geographic coverage map.",
    };
  });

  app.get("/api/v1/unknown-zones", { preHandler: requireRoles("admin", "operator") }, async (req) => {
    const includeSimulated = boolQuery(req, "includeSimulated");
    const cutoff = now() - 30 * 60_000;
    const zones = await db.query(
      `SELECT floor(lat * 100) / 100 AS lat_cell, floor(lon * 100) / 100 AS lon_cell, max(observed_at) AS last_contact, count(*)::int AS observations
       FROM observations WHERE simulated = $1 AND lat IS NOT NULL GROUP BY 1, 2 HAVING max(observed_at) < $2`,
      [includeSimulated, cutoff],
    );
    return { zones, label: "communication_uncertainty", note: "Lost contact is not proof that people are missing or safe." };
  });

  app.get("/api/v1/analytics", { preHandler: requireRoles("admin", "operator") }, async (req) => {
    const includeSimulated = boolQuery(req, "includeSimulated");
    const byState = await db.query("SELECT emergency_state, count(*)::int AS n, coalesce(sum(people_count),0)::int AS stated_people FROM incidents WHERE simulated = $1 AND cancelled = false GROUP BY emergency_state", [includeSimulated]);
    const byType = await db.query("SELECT incident_type, count(*)::int AS n FROM incidents WHERE simulated = $1 AND cancelled = false GROUP BY incident_type", [includeSimulated]);
    const packets = await db.query("SELECT accept_result, count(*)::int AS n FROM packets WHERE simulated = $1 GROUP BY accept_result", [includeSimulated]);
    const delay = await db.query<{ avg_delay: number | null }>("SELECT avg(received_at - event_timestamp) AS avg_delay FROM packets WHERE simulated = $1 AND accept_result = 'accepted'", [includeSimulated]);
    return {
      source: includeSimulated ? "simulator" : "live",
      byState,
      byType,
      packets,
      averageGatewayDelayMs: delay[0]?.avg_delay == null ? null : Number(delay[0].avg_delay),
      note: "Counts are stored records only. No estimated lives saved.",
    };
  });

  app.get("/api/v1/audit", { preHandler: requireRoles("admin") }, async () => {
    const logs = await db.query("SELECT * FROM audit_logs ORDER BY at_ms DESC LIMIT 500");
    return { logs };
  });

  app.get("/api/v1/users", { preHandler: requireRoles("admin") }, async () => {
    const users = await db.query("SELECT id, email, role, display_name, team_id, disabled, created_at FROM users ORDER BY created_at");
    return { users };
  });

  app.post("/api/v1/users", { preHandler: requireRoles("admin") }, async (req, reply) => {
    const body = z.object({
      email: z.string().email(),
      password: z.string().min(12).max(200),
      role: z.enum(["admin", "operator", "responder", "alert_publisher"]),
      displayName: z.string().min(2).max(80),
      teamId: z.string().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const id = randomUUID();
    const hash = await hashPassword(body.data.password);
    try {
      await db.query(
        "INSERT INTO users (id, email, password_hash, role, display_name, team_id, disabled, created_at) VALUES ($1,$2,$3,$4,$5,$6,false,$7)",
        [id, body.data.email.toLowerCase(), hash, body.data.role, body.data.displayName, body.data.teamId ?? null, now()],
      );
    } catch {
      return reply.code(409).send({ error: "email_exists" });
    }
    await audit(db, "user_created", body.data.role, userOf(req).sub, id, now());
    return { id };
  });

  app.post("/api/v1/sync/packets", async (req, reply) => {
    const body = z.object({ packets: z.array(z.object({ rawHex: z.string().max(4000) })).max(50) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const results = [];
    for (const item of body.data.packets) {
      let bytes: Uint8Array;
      try { bytes = fromHex(item.rawHex); } catch { results.push({ result: "rejected", reason: "bad_hex" }); continue; }
      const verified = verifyPacket(bytes, verifyP256, now());
      if (!verified.ok) {
        results.push({ result: "rejected", reason: verified.error });
        await audit(db, "sync_rejected", verified.error, undefined, undefined, now());
        continue;
      }
      const origin = toHex(verified.packet.originPseudonym);
      if (!takeToken(origin, now())) {
        results.push({ messageId: toHex(verified.packet.messageId), result: "rejected", reason: "rate_limited" });
        continue;
      }
      const accepted = await acceptSignedPacket(db, verified.packet, item.rawHex, now());
      results.push(accepted);
      if (accepted.result === "accepted") broadcast({ type: "packet", messageId: accepted.messageId });
    }
    return { results, receivedAt: now() };
  });

  app.post("/api/v1/sync/acks", async (req, reply) => {
    const body = z.object({
      pseudonymHex: z.string().length(32),
      nowMs: z.number(),
      publicKeyHex: z.string().length(130),
      signatureHex: z.string().length(128),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    if (Math.abs(body.data.nowMs - now()) > 120_000) return reply.code(401).send({ error: "stale_poll" });
    const message = new TextEncoder().encode(`acks:${body.data.pseudonymHex}:${body.data.nowMs}`);
    const ok = verifyP256(message, fromHex(body.data.signatureHex), fromHex(body.data.publicKeyHex));
    if (!ok) return reply.code(401).send({ error: "bad_signature" });
    const rows = await db.query(
      `SELECT d.* FROM delivery_events d
       JOIN incidents i ON i.message_id = d.message_id
       WHERE i.origin_pseudonym = $1 AND d.state = 'acknowledged_by_operator' AND d.at_ms >= $2`,
      [body.data.pseudonymHex, body.data.nowMs - 7 * 24 * 3600_000],
    );
    return { acks: rows };
  });

  app.post("/api/v1/sync/photo", async (req, reply) => {
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: "file_required" });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of file.file) {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) return reply.code(413).send({ error: "too_large" });
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    const sha = createHash("sha256").update(bytes).digest("hex");
    mkdirSync(config.dataDir, { recursive: true });
    const stored = join(config.dataDir, `${sha}.bin`);
    writeFileSync(stored, bytes);
    const id = randomUUID();
    await db.query(
      "INSERT INTO photos (id, sha256, bytes, mime, stored_path, created_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [id, sha, bytes.length, file.mimetype || "application/octet-stream", stored, now()],
    );
    return { id, sha256: sha, bytes: bytes.length, note: "Photo stored. It is evidence, not a verified scene description." };
  });

  app.get("/api/v1/sync/photo/:id", { preHandler: requireRoles("admin", "operator", "responder") }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const rows = await db.query<{ stored_path: string; mime: string }>("SELECT stored_path, mime FROM photos WHERE id = $1", [id]);
    if (rows.length === 0) return reply.code(404).send({ error: "not_found" });
    reply.type(rows[0].mime);
    return reply.send(createReadStream(rows[0].stored_path));
  });

  app.get("/api/v1/edge", { preHandler: requireRoles("admin", "operator", "responder") }, async () => edgeBoard(db, now()));

  app.post("/api/v1/edge/evidence/request", { preHandler: requireRoles("admin", "operator") }, async (req, reply) => {
    const body = z.object({ witnessId: z.string().min(4).max(80), explicit: z.boolean() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const result = await requestEvidence(db, userOf(req).sub, userOf(req).role, body.data.witnessId, body.data.explicit, now());
    if (!result.ok) return reply.code(result.reason === "unauthorized" || result.reason === "explicit_request_required" ? 403 : 404).send({ error: result.reason });
    return result;
  });

  app.post("/api/v1/edge/evidence/verify", { preHandler: requireRoles("admin", "operator") }, async (req, reply) => {
    const body = z.object({
      requestId: z.string().uuid(),
      bytesBase64: z.string().max(6_000_000),
      command: z.string().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    if (body.data.command) return reply.code(400).send({ error: "remote_command_rejected" });
    let bytes: Buffer;
    try { bytes = Buffer.from(body.data.bytesBase64, "base64"); } catch { return reply.code(400).send({ error: "untrusted_clipboard" }); }
    if (bytes.length === 0 || bytes.length > 4 * 1024 * 1024) return reply.code(400).send({ error: "untrusted_clipboard" });
    const result = await verifyPastedEvidence(db, userOf(req).sub, body.data.requestId, bytes, now());
    if (!result.ok && result.reason === "request_not_found") return reply.code(404).send(result);
    return { ...result, clipboard: "untrusted" };
  });

  app.post("/api/v1/ai/extract", { preHandler: requireRoles("admin", "operator") }, async (req, reply) => {
    const body = z.object({ text: z.string().max(2000) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const extraction = extractReport(body.data.text);
    return { extraction, persisted: false, officialAlertCreated: false };
  });

  app.post("/api/v1/ai/suggest", { preHandler: requireRoles("admin", "operator") }, async (req) => {
    const includeSimulated = boolQuery(req, "includeSimulated");
    return reviewHints(db, includeSimulated);
  });

  app.get("/api/v1/simulator/scenarios", { preHandler: requireRoles("admin", "operator") }, async () => ({
    scenarios: Object.values(SCENARIOS).map((s) => ({ id: s.id, description: s.description, nodes: s.nodes })),
    separatedFromLiveData: true,
  }));

  app.post("/api/v1/simulator/run", { preHandler: requireRoles("admin", "operator") }, async (req, reply) => {
    const body = z.object({ scenario: z.string(), seed: z.number().int().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const scenario = SCENARIOS[body.data.scenario];
    if (!scenario) return reply.code(404).send({ error: "unknown_scenario" });
    if (scenario.nodes > 1000) return reply.code(400).send({ error: "use_cli_for_10000" });
    const started = now();
    const metrics = runScenario({ ...scenario, seed: body.data.seed ?? scenario.seed });
    const id = randomUUID();
    await db.query(
      "INSERT INTO simulator_runs (id, scenario, seed, started_at, finished_at, metrics_json) VALUES ($1,$2,$3,$4,$5,$6)",
      [id, scenario.id, metrics.seed, started, now(), JSON.stringify(metrics)],
    );
    await audit(db, "simulator_run", scenario.id, userOf(req).sub, id, now());
    return { id, metrics, liveDataUnchanged: true };
  });

  app.get("/api/v1/simulator/runs", { preHandler: requireRoles("admin", "operator") }, async () => {
    const runs = await db.query("SELECT * FROM simulator_runs ORDER BY started_at DESC LIMIT 50");
    return { runs, note: "Simulator runs are not field measurements." };
  });

  app.post("/api/v1/admin/reset-demo", { preHandler: requireRoles("admin") }, async (req, reply) => {
    if (config.nodeEnv === "production" && !config.allowDemoReset) return reply.code(403).send({ error: "reset_disabled" });
    const header = req.headers["x-confirm-reset"];
    const body = z.object({ confirm: z.literal("DELETE-DEMO-DATA") }).safeParse(req.body);
    if (header !== "DELETE-DEMO-DATA" || !body.success) return reply.code(400).send({ error: "confirmation_required" });
    for (const table of ["group_members", "group_lineage", "emergency_groups", "delivery_events", "incident_conflicts", "incidents", "packets", "alerts", "observations", "simulator_runs", "photos"]) {
      await db.query(`DELETE FROM ${table}`);
    }
    await audit(db, "demo_reset", "operational rows deleted; audit retained", userOf(req).sub, undefined, now());
    return { ok: true, auditRetained: true };
  });

  app.post("/api/v1/admin/retention", { preHandler: requireRoles("admin") }, async (req, reply) => {
    const body = z.object({ simulatorOlderThanDays: z.number().int().min(0).max(3650) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const cutoff = now() - body.data.simulatorOlderThanDays * 24 * 3600_000;
    await db.query("DELETE FROM incidents WHERE simulated = true AND event_timestamp < $1", [cutoff]);
    await db.query("DELETE FROM packets WHERE simulated = true AND event_timestamp < $1", [cutoff]);
    await audit(db, "retention", `simulator older than ${body.data.simulatorOlderThanDays}d`, userOf(req).sub, undefined, now());
    return { ok: true, note: "Live NEED HELP reports are not deleted by this control." };
  });

  app.get("/api/v1/live", { websocket: true }, (connection) => {
    const socket = connection.socket;
    let authed = false;
    socket.on("message", (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type?: string; token?: string };
        if (msg.type === "auth" && msg.token) {
          app.jwt.verify(msg.token);
          authed = true;
          sockets.add(socket);
          socket.send(JSON.stringify({ type: "ready" }));
        }
      } catch {
        socket.send(JSON.stringify({ type: "error", error: "unauthorized" }));
      }
    });
    socket.on("close", () => sockets.delete(socket));
    setTimeout(() => {
      if (!authed) socket.close();
    }, 5000);
  });

  return app;
}

function boolQuery(req: FastifyRequest, key: string): boolean {
  return (req.query as Record<string, string | undefined>)[key] === "1";
}

const syncBuckets = new Map<string, { tokens: number; at: number }>();
function takeToken(origin: string, t: number): boolean {
  const slot = syncBuckets.get(origin) ?? { tokens: 60, at: t };
  const elapsed = (t - slot.at) / 1000;
  slot.tokens = Math.min(60, slot.tokens + elapsed);
  slot.at = t;
  if (slot.tokens < 1) {
    syncBuckets.set(origin, slot);
    return false;
  }
  slot.tokens -= 1;
  syncBuckets.set(origin, slot);
  return true;
}

async function summary(db: Db, includeSimulated: boolean, t: number) {
  const rows = await db.query<{ emergency_state: string; n: number; stated: number }>(
    "SELECT emergency_state, count(*)::int AS n, coalesce(sum(people_count),0)::int AS stated FROM incidents WHERE simulated = $1 AND cancelled = false GROUP BY emergency_state",
    [includeSimulated],
  );
  const count = (state: string) => Number(rows.find((r) => r.emergency_state === state)?.n ?? 0);
  const stated = rows.reduce((sum, row) => sum + Number(row.stated ?? 0), 0);
  const groups = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM emergency_groups WHERE simulated = $1", [includeSimulated]);
  const teams = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM teams WHERE simulated = false");
  const last = await db.query<{ received_at: number | null }>("SELECT max(received_at) AS received_at FROM packets WHERE simulated = $1", [includeSimulated]);
  const active = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM incidents WHERE simulated = $1 AND cancelled = false AND emergency_state IN ('need_help','evacuating','unknown')", [includeSimulated]);
  return {
    source: includeSimulated ? "simulator" : "live",
    includeSimulated,
    counts: {
      reports: rows.reduce((sum, row) => sum + Number(row.n), 0),
      statedPeople: stated,
      safe: count("safe"),
      needHelp: count("need_help"),
      evacuating: count("evacuating"),
      unknown: count("unknown"),
      resolved: count("resolved"),
    },
    activeIncidents: Number(active[0]?.n ?? 0),
    groups: Number(groups[0]?.n ?? 0),
    teams: Number(teams[0]?.n ?? 0),
    gatewaysObserved: null,
    lastSyncAt: last[0]?.received_at ?? null,
    generatedAt: t,
    disclaimer: "Prototype counts from stored records. Not a certified emergency service.",
  };
}

export async function insertUser(db: Db, input: { email: string; password: string; role: string; displayName: string; teamId?: string }, at = Date.now()): Promise<string> {
  const id = randomUUID();
  const hash = await hashPassword(input.password);
  await db.query(
    "INSERT INTO users (id, email, password_hash, role, display_name, team_id, disabled, created_at) VALUES ($1,$2,$3,$4,$5,$6,false,$7)",
    [id, input.email.toLowerCase(), hash, input.role, input.displayName, input.teamId ?? null, at],
  );
  return id;
}
