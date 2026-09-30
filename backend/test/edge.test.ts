import assert from "node:assert/strict";
import test from "node:test";
import { confirmWitness, draftWitness, encodeGateDecision, encodeHeardDigest, encodePacket, generateIdentity, randomId, sha256Hex, toHex } from "@disastermesh/protocol";
import { buildApp, insertUser } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { migrate, openDatabase } from "../src/db.js";

const now = 1_700_000_000_000;

async function fixture() {
  const config = loadConfig({ DM_DEV: "1", DM_ALLOW_PGLITE: "1", JWT_SECRET: "test-secret-123456", NODE_ENV: "test", HTTP_HOST: "127.0.0.1" });
  const db = await openDatabase(config);
  await migrate(db);
  const app = await buildApp({ db, config, now: () => now });
  await insertUser(db, { email: "operator@example.invalid", password: "dev-operator-pass", role: "operator", displayName: "Operator" }, now);
  await insertUser(db, { email: "responder@example.invalid", password: "dev-responder-pass", role: "responder", displayName: "Responder" }, now);
  async function token(email: string, password: string) {
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password } });
    assert.equal(res.statusCode, 200, res.body);
    return res.json().token as string;
  }
  return { app, token };
}

test("desk keeps disagreeing witness counts apart and verifies evidence only after an explicit request", async () => {
  const { app, token } = await fixture();
  const auth = await token("operator@example.invalid", "dev-operator-pass");
  const media = new TextEncoder().encode("phone-still");
  const drafted = draftWitness({ transcript: "बाढ़ में तीन लोग फंसे हैं, पानी दरवाजे तक", modelStatus: "MODEL_UNAVAILABLE" });
  assert.equal(drafted.ok, true);
  if (!drafted.ok) return;
  const confirmed = confirmWitness(drafted.draft, true, media);
  const other = confirmWitness({ ...drafted.draft, peopleCount: 9, sourceText: "बाढ़ में नौ लोग फंसे हैं" }, true, media);
  assert.equal(confirmed.ok && other.ok, true);
  if (!confirmed.ok || !other.ok) return;
  const signer = generateIdentity();
  const origin = randomId(16);
  const packet = (payload: Uint8Array) => toHex(encodePacket({
    priority: 1, payloadType: "witness_delta", messageId: randomId(16), originPseudonym: origin, incidentId: randomId(16),
    eventTimestampMs: now, expiryTimestampMs: now + 3_600_000, nonce: randomId(12), payload,
  }, signer));
  const synced = await app.inject({ method: "POST", url: "/api/v1/sync/packets", payload: { packets: [{ rawHex: packet(confirmed.payload) }, { rawHex: packet(other.payload) }] } });
  assert.equal(synced.json().results.every((row: { result: string }) => row.result === "accepted"), true);
  const body = (await app.inject({ method: "GET", url: "/api/v1/edge", headers: { authorization: `Bearer ${auth}` } })).json();
  assert.equal(body.averaged, false);
  assert.equal(body.conflicts.length > 0, true);
  assert.equal(JSON.stringify(body.witnesses).includes("phone-still"), false);
  const witnessId = body.witnesses[0].id as string;
  assert.equal((await app.inject({ method: "POST", url: "/api/v1/edge/evidence/request", headers: { authorization: `Bearer ${auth}` }, payload: { witnessId, explicit: false } })).statusCode, 403);
  const requested = await app.inject({ method: "POST", url: "/api/v1/edge/evidence/request", headers: { authorization: `Bearer ${auth}` }, payload: { witnessId, explicit: true } });
  assert.equal(requested.json().status, "hash_only");
  const checked = await app.inject({ method: "POST", url: "/api/v1/edge/evidence/verify", headers: { authorization: `Bearer ${auth}` }, payload: { requestId: requested.json().id, bytesBase64: Buffer.from(media).toString("base64") } });
  assert.equal(checked.json().ok, true);
  assert.equal(checked.json().storedMedia, false);
});

test("mesh evidence request is not a remote command and silence is unheard", async () => {
  const { app, token } = await fixture();
  const auth = await token("operator@example.invalid", "dev-operator-pass");
  const id = "cd".repeat(16);
  const heard = encodeHeardDigest({ windowStartMs: now - 20 * 60_000, batteryBucket: "low", pseudonyms: [id], heldMessageId: null });
  const later = encodeHeardDigest({ windowStartMs: now, batteryBucket: "low", pseudonyms: [], heldMessageId: null });
  const gate = encodeGateDecision({ decision: "defer", reason: "no_new_fact", newFields: [], fragmentsSaved: 3 });
  assert.equal(heard.ok && later.ok && gate.ok, true);
  if (!heard.ok || !later.ok || !gate.ok) return;
  const sign = (type: "heard_digest" | "scarce_slot_decision" | "evidence_request", payload: Uint8Array) => toHex(encodePacket({
    priority: 4, payloadType: type, messageId: randomId(16), originPseudonym: randomId(16), incidentId: randomId(16),
    eventTimestampMs: now, expiryTimestampMs: now + 3_600_000, nonce: randomId(12), payload,
  }, generateIdentity()));
  const synced = await app.inject({ method: "POST", url: "/api/v1/sync/packets", payload: { packets: [
    { rawHex: sign("heard_digest", heard.payload) },
    { rawHex: sign("heard_digest", later.payload) },
    { rawHex: sign("scarce_slot_decision", gate.payload) },
    { rawHex: sign("evidence_request", new TextEncoder().encode("{\"k\":\"pull\"}")) },
  ] } });
  assert.equal(synced.json().results[3].reason, "operator_channel_only");
  const body = (await app.inject({ method: "GET", url: "/api/v1/edge", headers: { authorization: `Bearer ${auth}` } })).json();
  assert.equal(body.unheardNote, "UNHEARD ≠ SAFE");
  assert.equal(body.unheard.some((row: { id: string; safe: boolean }) => row.id === id && row.safe === false), true);
  assert.equal(body.officeKit.officeKit, "UNAVAILABLE");
});
