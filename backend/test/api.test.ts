import assert from "node:assert/strict";
import test from "node:test";
import { encodePacket, encodeStatus, generateIdentity, randomId, toHex } from "@disastermesh/protocol";
import { buildApp, insertUser } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { migrate, openDatabase } from "../src/db.js";

const now = 1_700_000_000_000;

async function fixture() {
  const config = loadConfig({
    DM_DEV: "1",
    DM_ALLOW_PGLITE: "1",
    JWT_SECRET: "test-secret-123456",
    NODE_ENV: "test",
    HTTP_HOST: "127.0.0.1",
  });
  const db = await openDatabase(config);
  await migrate(db);
  const app = await buildApp({ db, config, now: () => now });
  const admin = await insertUser(db, { email: "admin@example.invalid", password: "dev-admin-pass", role: "admin", displayName: "Admin" }, now);
  const operator = await insertUser(db, { email: "operator@example.invalid", password: "dev-operator-pass", role: "operator", displayName: "Operator" }, now);
  const responder = await insertUser(db, { email: "responder@example.invalid", password: "dev-responder-pass", role: "responder", displayName: "Responder" }, now);
  const publisher = await insertUser(db, { email: "publisher@example.invalid", password: "dev-publisher-pass", role: "alert_publisher", displayName: "Publisher" }, now);
  async function token(email: string, password: string) {
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password } });
    assert.equal(res.statusCode, 200, res.body);
    return res.json().token as string;
  }
  return { app, db, admin, operator, responder, publisher, token };
}

function packet(opts: {
  signer: ReturnType<typeof generateIdentity>;
  origin: Uint8Array;
  incident: Uint8Array;
  messageId?: Uint8Array;
  sequence?: number;
  state?: "need_help" | "safe" | "evacuating" | "unknown" | "resolved";
  simulated?: boolean;
  event?: number;
  expiry?: number;
  priority?: 0 | 1 | 2 | 3 | 4;
}) {
  const raw = encodePacket(
    {
      priority: opts.priority ?? 1,
      payloadType: "status",
      messageId: opts.messageId ?? randomId(16),
      originPseudonym: opts.origin,
      incidentId: opts.incident,
      eventTimestampMs: opts.event ?? now,
      expiryTimestampMs: opts.expiry ?? now + 3_600_000,
      nonce: randomId(12),
      sequence: opts.sequence ?? 1,
      simulated: opts.simulated ?? false,
      payload: encodeStatus({
        t: "flood",
        s: opts.state ?? "need_help",
        n: 3,
        txt: "water rising",
        lang: "en",
        vl: "eyewitness",
      }),
      location: { latE7: 186_298_000, lonE7: 737_997_000, accuracyM: 12, ageSec: 2 },
    },
    opts.signer,
  );
  return toHex(raw);
}

test("health and empty dashboard are honest zeros", async () => {
  const { app, token } = await fixture();
  const health = await app.inject({ method: "GET", url: "/api/v1/health" });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().certifiedEmergencyService, false);
  const auth = await token("operator@example.invalid", "dev-operator-pass");
  const summary = await app.inject({ method: "GET", url: "/api/v1/dashboard/summary", headers: { authorization: `Bearer ${auth}` } });
  assert.equal(summary.statusCode, 200);
  const body = summary.json();
  assert.equal(body.counts.needHelp, 0);
  assert.equal(body.counts.statedPeople, 0);
  assert.equal(body.counts.safe, 0);
  assert.equal(body.source, "live");
  await app.close();
});

test("sync accepts a signed packet once and keeps event time distinct from arrival", async () => {
  const { app, db, token } = await fixture();
  const signer = generateIdentity();
  const origin = randomId(16);
  const incident = randomId(16);
  const rawHex = packet({ signer, origin, incident });
  const first = await app.inject({ method: "POST", url: "/api/v1/sync/packets", payload: { packets: [{ rawHex }] } });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().results[0].result, "accepted");
  const second = await app.inject({ method: "POST", url: "/api/v1/sync/packets", payload: { packets: [{ rawHex }] } });
  assert.equal(second.json().results[0].result, "duplicate");
  const auth = await token("operator@example.invalid", "dev-operator-pass");
  const summary = await app.inject({ method: "GET", url: "/api/v1/dashboard/summary", headers: { authorization: `Bearer ${auth}` } });
  assert.equal(summary.json().counts.needHelp, 1);
  assert.equal(summary.json().counts.statedPeople, 3);
  const rows = await db.query<{ event_timestamp: number; received_at: number }>("SELECT event_timestamp, received_at FROM incidents");
  assert.equal(Number(rows[0].event_timestamp), now);
  assert.equal(Number(rows[0].received_at), now);
  await app.close();
});

test("security rejects tamper, expiry, simulated flag, injection, and role escalation", async () => {
  const { app, token } = await fixture();
  const signer = generateIdentity();
  const origin = randomId(16);
  const incident = randomId(16);
  const good = packet({ signer, origin, incident });
  const bytes = Buffer.from(good, "hex");
  bytes[30] ^= 0xff;
  const tampered = await app.inject({ method: "POST", url: "/api/v1/sync/packets", payload: { packets: [{ rawHex: bytes.toString("hex") }] } });
  assert.equal(tampered.json().results[0].result, "rejected");
  const expired = packet({ signer, origin, incident, event: now - 10_000, expiry: now - 1, messageId: randomId(16) });
  const exp = await app.inject({ method: "POST", url: "/api/v1/sync/packets", payload: { packets: [{ rawHex: expired }] } });
  assert.equal(exp.json().results[0].reason, "expired");
  const sim = packet({ signer, origin, incident, simulated: true, messageId: randomId(16) });
  const simRes = await app.inject({ method: "POST", url: "/api/v1/sync/packets", payload: { packets: [{ rawHex: sim }] } });
  assert.equal(simRes.json().results[0].reason, "simulated_flag_on_live_sync");

  const publisher = await token("publisher@example.invalid", "dev-publisher-pass");
  const official = await app.inject({
    method: "POST",
    url: "/api/v1/alerts",
    headers: { authorization: `Bearer ${publisher}` },
    payload: { title: "Official looking", body: "This must not publish", severity: "warning", kind: "official", language: "en", confirmOfficial: "VERIFIED_OFFICIAL_NOT_AI" },
  });
  assert.equal(official.statusCode, 403);
  const admin = await token("admin@example.invalid", "dev-admin-pass");
  const missingPhrase = await app.inject({
    method: "POST",
    url: "/api/v1/alerts",
    headers: { authorization: `Bearer ${admin}` },
    payload: { title: "Try official", body: "No phrase", severity: "warning", kind: "official", language: "en" },
  });
  assert.equal(missingPhrase.statusCode, 400);
  const operator = await token("operator@example.invalid", "dev-operator-pass");
  const search = await app.inject({
    method: "GET",
    url: "/api/v1/incidents?q=" + encodeURIComponent("%' OR 1=1 --"),
    headers: { authorization: `Bearer ${operator}` },
  });
  assert.equal(search.statusCode, 200);
  assert.equal(search.json().incidents.length, 0);
  const responder = await token("responder@example.invalid", "dev-responder-pass");
  const reset = await app.inject({
    method: "POST",
    url: "/api/v1/admin/reset-demo",
    headers: { authorization: `Bearer ${responder}`, "x-confirm-reset": "DELETE-DEMO-DATA" },
    payload: { confirm: "DELETE-DEMO-DATA" },
  });
  assert.equal(reset.statusCode, 403);
  await app.close();
});

test("same-origin stale update does not downgrade and another origin cannot clear NEED HELP", async () => {
  const { app, db } = await fixture();
  const signer = generateIdentity();
  const other = generateIdentity();
  const origin = randomId(16);
  const incident = randomId(16);
  const first = packet({ signer, origin, incident, sequence: 2, state: "need_help" });
  const ok = await app.inject({ method: "POST", url: "/api/v1/sync/packets", payload: { packets: [{ rawHex: first }] } });
  assert.equal(ok.json().results[0].result, "accepted");
  const stale = packet({ signer, origin, incident, sequence: 1, state: "safe", messageId: randomId(16) });
  const staleRes = await app.inject({ method: "POST", url: "/api/v1/sync/packets", payload: { packets: [{ rawHex: stale }] } });
  assert.equal(staleRes.json().results[0].reason, "stale_sequence");
  const otherSafe = packet({ signer: other, origin: randomId(16), incident, sequence: 9, state: "safe", messageId: randomId(16) });
  const otherRes = await app.inject({ method: "POST", url: "/api/v1/sync/packets", payload: { packets: [{ rawHex: otherSafe }] } });
  assert.equal(otherRes.json().results[0].result, "accepted");
  const rows = await db.query<{ emergency_state: string; origin_pseudonym: string }>("SELECT emergency_state, origin_pseudonym FROM incidents ORDER BY content_sequence");
  const original = rows.find((row) => row.origin_pseudonym === toHex(origin));
  assert.equal(original?.emergency_state, "need_help");
  assert.equal(rows.length, 2);
  await app.close();
});

test("operator ack, AI extract, and demo reset keep their promises", async () => {
  const { app, db, token } = await fixture();
  const signer = generateIdentity();
  const rawHex = packet({ signer, origin: randomId(16), incident: randomId(16) });
  const synced = await app.inject({ method: "POST", url: "/api/v1/sync/packets", payload: { packets: [{ rawHex }] } });
  const incidentId = synced.json().results[0].incidentId as string;
  const operator = await token("operator@example.invalid", "dev-operator-pass");
  const ack = await app.inject({ method: "POST", url: `/api/v1/incidents/${encodeURIComponent(incidentId)}/ack`, headers: { authorization: `Bearer ${operator}` } });
  assert.equal(ack.statusCode, 200);
  assert.equal(ack.json().state, "acknowledged_by_operator");
  const extracted = await app.inject({
    method: "POST",
    url: "/api/v1/ai/extract",
    headers: { authorization: `Bearer ${operator}` },
    payload: { text: "बाढ़ में चार लोग फंसे हैं" },
  });
  assert.equal(extracted.statusCode, 200);
  assert.equal(extracted.json().officialAlertCreated, false);
  assert.equal(extracted.json().extraction.peopleCount, 4);
  const alerts = await db.query("SELECT id FROM alerts");
  assert.equal(alerts.length, 0);
  const admin = await token("admin@example.invalid", "dev-admin-pass");
  const reset = await app.inject({
    method: "POST",
    url: "/api/v1/admin/reset-demo",
    headers: { authorization: `Bearer ${admin}`, "x-confirm-reset": "DELETE-DEMO-DATA" },
    payload: { confirm: "DELETE-DEMO-DATA" },
  });
  assert.equal(reset.statusCode, 200);
  const left = await db.query("SELECT id FROM incidents");
  assert.equal(left.length, 0);
  const audits = await db.query("SELECT id FROM audit_logs");
  assert.ok(audits.length > 0);
  await app.close();
});

test("login failure does not reveal whether the account exists", async () => {
  const { app } = await fixture();
  const missing = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "nobody@example.invalid", password: "wrong-password-1" } });
  const wrong = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "admin@example.invalid", password: "wrong-password-1" } });
  assert.equal(missing.statusCode, 401);
  assert.equal(wrong.statusCode, 401);
  assert.equal(missing.json().error, wrong.json().error);
  await app.close();
});
