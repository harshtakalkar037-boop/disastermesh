import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DedupCache,
  PriorityScheduler,
  Reassembler,
  RuleBasedReportModel,
  SimulatedMesh,
  TokenBucket,
  UnavailableImageTagger,
  UnavailableSpeechModel,
  buildFixtureObject,
  canTransition,
  clusterReports,
  diffGroups,
  encodePacket,
  encodeStatus,
  extractReport,
  findContradictions,
  fragmentPacket,
  generateIdentity,
  mayRelay,
  parseStatus,
  proximityDecision,
  randomId,
  statusOrUnknown,
  suggestDuplicates,
  suggestPriority,
  toHex,
  transition,
  verifyP256,
  verifyPacket,
  withRelayHop,
  GroupTracker,
} from "../src/index.js";
import { buildFixtureObject } from "../src/export-fixtures.js";

const now = 1_700_000_000_000;

function samplePacket(sim = false, event = now, expiry = now + 3_600_000) {
  const id = generateIdentity();
  const messageId = randomId(16);
  const raw = encodePacket(
    {
      priority: 1,
      payloadType: "status",
      messageId,
      originPseudonym: randomId(16),
      incidentId: randomId(16),
      eventTimestampMs: event,
      expiryTimestampMs: expiry,
      nonce: randomId(12),
      payload: encodeStatus({ t: "flood", s: "need_help", n: 2, txt: "need help", lang: "en", vl: "eyewitness" }),
      location: { latE7: 186_300_000, lonE7: 738_000_000, accuracyM: 8, ageSec: 1 },
      simulated: sim,
    },
    id,
  );
  return { id, messageId, raw };
}

test("round-trip signature and relay hop does not resign", () => {
  const { raw, id } = samplePacket(true);
  const verified = verifyPacket(raw, verifyP256, now);
  assert.equal(verified.ok, true);
  if (!verified.ok) return;
  assert.equal(verified.packet.simulated, true);
  assert.equal(verified.packet.hopCount, 0);
  assert.equal(verified.packet.location?.accuracyM, 8);
  const relayed = withRelayHop(raw);
  assert.equal(relayed.ok, true);
  if (!relayed.ok) return;
  const again = verifyPacket(relayed.bytes, verifyP256, now);
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.equal(again.packet.hopCount, 1);
  assert.equal(again.packet.hopLimit, 4);
  assert.equal(verifyP256(again.packet.signedBlob, again.packet.signature, id.publicKeyRaw), true);
});

test("tamper, expiry, future skew, bad magic, and oversized are rejected", () => {
  const { raw } = samplePacket(false);
  const tampered = raw.slice();
  tampered[20] ^= 0xff;
  const bad = verifyPacket(tampered, verifyP256, now);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.error, "bad_signature");

  const expired = samplePacket(false, now - 10_000, now - 1);
  const exp = verifyPacket(expired.raw, verifyP256, now);
  assert.equal(exp.ok, false);

  const future = samplePacket(false, now + 10 * 60_000, now + 60 * 60_000);
  const fut = verifyPacket(future.raw, verifyP256, now);
  assert.equal(fut.ok, false);
  if (!fut.ok) assert.equal(fut.error, "not_yet_valid");

  const magic = raw.slice();
  magic[6] ^= 0xff;
  const mag = verifyPacket(magic, verifyP256, now);
  assert.equal(mag.ok, false);

  const huge = new Uint8Array(2000);
  const over = verifyPacket(huge, verifyP256, now);
  assert.equal(over.ok, false);
  if (!over.ok) assert.equal(over.error, "oversized");
});

test("status payload rejects self-declared official and overlong text", () => {
  const badOfficial = parseStatus(JSON.stringify({ t: "flood", s: "need_help", vl: "official" }));
  assert.equal(badOfficial.ok, false);
  const long = parseStatus(JSON.stringify({ t: "flood", s: "safe", txt: "x".repeat(121) }));
  assert.equal(long.ok, false);
  const ok = parseStatus(JSON.stringify({ t: "medical", s: "unknown", n: 1 }));
  assert.equal(ok.ok, true);
});

test("priority scheduler prefers P0 and still serves P4", () => {
  const q = new PriorityScheduler<string>();
  q.enqueue(0, "a");
  q.enqueue(0, "b");
  for (let i = 0; i < 20; i += 1) q.enqueue(4, `p4-${i}`);
  const first = [q.next()?.priority, q.next()?.priority, q.next()?.priority];
  assert.deepEqual(first, [0, 0, 4]);
});

test("battery policy and token bucket", () => {
  assert.equal(mayRelay(0, 10, true).allow, true);
  assert.equal(mayRelay(3, 10, true).allow, false);
  assert.equal(mayRelay(0, 5, true).reason, "battery_critical");
  assert.equal(mayRelay(1, null, true).reason, "battery_unknown_allow");
  assert.equal(mayRelay(0, 90, false).reason, "relay_disabled");
  let clock = 0;
  const bucket = new TokenBucket(1, 2, () => clock);
  assert.equal(bucket.tryTake(), true);
  assert.equal(bucket.tryTake(), true);
  assert.equal(bucket.tryTake(), false);
  clock = 1000;
  assert.equal(bucket.tryTake(), true);
});

test("dedup drops replays and forgets expiry", () => {
  const d = new DedupCache(10);
  assert.equal(d.add("m1", 100), true);
  assert.equal(d.has("m1", 50), true);
  assert.equal(d.add("m1", 100), false);
  assert.equal(d.has("m1", 100), false);
  assert.equal(d.add("m1", 200), true);
});

test("fragment reassembly", () => {
  const { raw, messageId } = samplePacket(true);
  const parts = fragmentPacket(raw, messageId);
  assert.ok(parts.length >= 2);
  const r = new Reassembler();
  let done = false;
  let packet = new Uint8Array();
  for (const part of parts) {
    const pushed = r.push(part.bytes, now);
    if ("error" in pushed) assert.fail(pushed.error);
    if (pushed.done) {
      done = true;
      packet = pushed.packet;
    }
  }
  assert.equal(done, true);
  assert.equal(toHex(packet), toHex(raw));
});

test("delivery transitions do not confuse relayed with acknowledged", () => {
  assert.equal(canTransition("relayed_to_peer", "acknowledged_by_operator"), false);
  assert.equal(canTransition("queued_offline", "received_by_command_center"), true);
  assert.equal(transition("delivered_to_gateway", "queued_offline").ok, true);
  assert.equal(statusOrUnknown(undefined), "unknown");
  assert.equal(statusOrUnknown("safe"), "safe");
  assert.notEqual(statusOrUnknown(null), "safe");
});

test("grouping is conservative and ignores RSSI", () => {
  const t = now;
  const close = clusterReports([
    { id: "a", incidentType: "flood", eventTimestampMs: t, lat: 18.63, lon: 73.8, accuracyM: 10 },
    { id: "b", incidentType: "flood", eventTimestampMs: t + 1000, lat: 18.6303, lon: 73.8002, accuracyM: 10 },
  ]);
  assert.equal(close.groups.length, 1);
  assert.equal(close.groups[0].confidence, "high");
  assert.equal(close.usedRadioProximity, false);

  const coarse = proximityDecision(
    { id: "a", incidentType: "flood", eventTimestampMs: t, lat: 18.63, lon: 73.8, accuracyM: 120, rssiDbm: -40 },
    { id: "b", incidentType: "flood", eventTimestampMs: t, lat: 18.6301, lon: 73.8001, accuracyM: 120, rssiDbm: -40 },
  );
  assert.equal(coarse.cluster, false);
  assert.equal(coarse.reason, "accuracy_too_coarse");

  const farRssi = proximityDecision(
    { id: "a", incidentType: "fire", eventTimestampMs: t, lat: 18.63, lon: 73.8, accuracyM: 5, rssiDbm: -30 },
    { id: "b", incidentType: "fire", eventTimestampMs: t, lat: 18.64, lon: 73.81, accuracyM: 5, rssiDbm: -30 },
  );
  assert.equal(farRssi.cluster, false);

  const chain = clusterReports([
    { id: "a", incidentType: "flood", eventTimestampMs: t, lat: 18.63, lon: 73.8, accuracyM: 5 },
    { id: "b", incidentType: "flood", eventTimestampMs: t, lat: 18.63115, lon: 73.8, accuracyM: 5 },
    { id: "c", incidentType: "flood", eventTimestampMs: t, lat: 18.6323, lon: 73.8, accuracyM: 5 },
  ]);
  assert.equal(chain.groups.some((g) => g.memberIds.includes("a") && g.memberIds.includes("b")), true);
  assert.equal(chain.groups.some((g) => g.memberIds.includes("a") && g.memberIds.includes("c")), false);

  const missing = clusterReports([
    { id: "a", incidentType: "medical", eventTimestampMs: t },
    { id: "b", incidentType: "medical", eventTimestampMs: t, lat: 18.63, lon: 73.8, accuracyM: 5 },
  ]);
  assert.equal(missing.groups.length, 0);
  assert.ok(missing.ungrouped.some((u) => u.reason === "location_missing"));
});

test("group tracker records split without deleting reports", () => {
  const tracker = new GroupTracker();
  const t = now;
  tracker.upsert({ id: "a", incidentType: "flood", eventTimestampMs: t, lat: 18.63, lon: 73.8, accuracyM: 8, state: "need_help" });
  tracker.upsert({ id: "b", incidentType: "flood", eventTimestampMs: t, lat: 18.6302, lon: 73.8001, accuracyM: 8, state: "need_help" });
  assert.equal(tracker.snapshot().groups.length, 1);
  tracker.upsert({ id: "b", incidentType: "flood", eventTimestampMs: t + 1000, lat: 18.7, lon: 73.9, accuracyM: 8, state: "need_help" });
  const snap = tracker.snapshot();
  assert.equal(snap.groups.length, 0);
  assert.equal(snap.reports.length, 2);
  assert.ok(tracker.history.some((e) => e.type === "split" || e.type === "leave"));
  const previous = clusterReports([
    { id: "a", incidentType: "fire", eventTimestampMs: t, lat: 18.5, lon: 73.7, accuracyM: 5 },
    { id: "b", incidentType: "fire", eventTimestampMs: t, lat: 18.5001, lon: 73.7001, accuracyM: 5 },
    { id: "c", incidentType: "fire", eventTimestampMs: t, lat: 18.5002, lon: 73.7002, accuracyM: 5 },
  ]);
  const next = clusterReports([
    { id: "a", incidentType: "fire", eventTimestampMs: t, lat: 18.5, lon: 73.7, accuracyM: 5 },
    { id: "b", incidentType: "fire", eventTimestampMs: t, lat: 18.5001, lon: 73.7001, accuracyM: 5 },
    { id: "c", incidentType: "fire", eventTimestampMs: t, lat: 19.2, lon: 74.2, accuracyM: 5 },
  ]);
  const events = diffGroups(previous.groups, next.groups, t + 5);
  assert.equal(previous.groups.length, 1);
  assert.ok(events.some((e) => e.type === "split" || e.type === "leave"));
});

test("duplicate and contradiction hints do not auto-resolve", () => {
  const t = now;
  const dups = suggestDuplicates([
    { id: "a", incidentType: "fire", eventTimestampMs: t, lat: 18.63, lon: 73.8, accuracyM: 10 },
    { id: "b", incidentType: "fire", eventTimestampMs: t + 1000, lat: 18.6301, lon: 73.8001, accuracyM: 10 },
  ]);
  assert.equal(dups.length, 1);
  assert.match(dups[0].note, /Operator must confirm/);
  const contradictions = findContradictions([
    { id: "a", incidentType: "flood", eventTimestampMs: t, lat: 18.63, lon: 73.8, accuracyM: 10, state: "safe" },
    { id: "b", incidentType: "flood", eventTimestampMs: t, lat: 18.6301, lon: 73.8, accuracyM: 10, state: "need_help" },
  ]);
  assert.equal(contradictions.length, 1);
  assert.match(contradictions[0].note, /not proof|not verified|Silence/i);
});

test("multilingual extractor confirms before send and never emits official warnings", () => {
  const mr = extractReport("पुरामुळे तीन लोक अडकले आहेत, मदत हवी");
  assert.equal(mr.incidentType, "flood");
  assert.equal(mr.peopleCount, 3);
  assert.equal(mr.claimedState, "need_help");
  assert.equal(mr.languageHint, "mr");
  assert.equal(mr.requiresUserConfirmation, true);
  assert.ok(mr.confidence < 1);

  const hi = extractReport("बाढ़ में चार लोग फंसे हैं");
  assert.equal(hi.incidentType, "flood");
  assert.equal(hi.peopleCount, 4);
  assert.equal(hi.languageHint, "hi");

  const life = extractReport("smoke in the building, two people unconscious");
  assert.equal(life.peopleCount, 2);
  assert.equal(life.suggestedPriority, 0);
  assert.equal(life.priorityRequiresConfirmation, true);
  assert.equal(life.model, "deterministic-rules-v1");
  assert.ok(!JSON.stringify(life).includes("official warning"));

  const safe = extractReport("I am safe near the school");
  assert.equal(safe.claimedState, "safe");
  assert.ok(safe.notes.some((n) => /not proof of safety/i.test(n)));
  assert.equal(statusOrUnknown(null), "unknown");

  const model = new RuleBasedReportModel();
  assert.equal(model.extract("earthquake, five people trapped").incidentType, "earthquake");
  assert.equal(suggestPriority({ state: "evacuating" }).priority, 2);
  assert.equal(suggestPriority({ payloadType: "sos" }).priority, 0);
});

test("speech and image interfaces report unavailable instead of fake success", async () => {
  const speech = await new UnavailableSpeechModel().transcribe(new Uint8Array(), "hi");
  assert.equal("unavailable" in speech && speech.unavailable, true);
  const image = await new UnavailableImageTagger().tag(new Uint8Array());
  assert.equal("unavailable" in image && image.unavailable, true);
});

test("simulated three-node relay is labeled simulated and dedups after reconnect", () => {
  const mesh = new SimulatedMesh(["A", "B", "C"], (bytes) => {
    const v = verifyPacket(bytes, verifyP256, now);
    return v.ok ? { ok: true, packet: v.packet } : { ok: false, error: v.error };
  }, () => now);
  mesh.connect("A", "B");
  mesh.connect("B", "C");
  assert.equal(mesh.hasDirectLink("A", "C"), false);
  const first = samplePacket(true);
  mesh.originate("A", first.raw);
  mesh.runUntilQuiet();
  const atC = mesh.acceptedAt("C").filter((p) => toHex(p.messageId) === toHex(first.messageId));
  assert.equal(atC.length, 1);
  assert.ok(atC[0].hopCount >= 1);
  assert.equal(mesh.receivedVia("C", first.messageId), "B");
  assert.equal(mesh.radioKind, "SIMULATED");
  assert.match(mesh.metrics.note, /Not a measured/);

  mesh.disconnectNode("B");
  const second = samplePacket(true);
  mesh.originate("A", second.raw);
  mesh.tick();
  assert.equal(mesh.acceptedAt("C").some((p) => toHex(p.messageId) === toHex(second.messageId)), false);
  mesh.reconnectNode("B");
  mesh.runUntilQuiet();
  const delivered = mesh.acceptedAt("C").filter((p) => toHex(p.messageId) === toHex(second.messageId));
  assert.equal(delivered.length, 1);
  mesh.originate("A", second.raw);
  mesh.runUntilQuiet();
  const afterDup = mesh.acceptedAt("C").filter((p) => toHex(p.messageId) === toHex(second.messageId));
  assert.equal(afterDup.length, 1);
  assert.ok(mesh.metrics.duplicatesDropped >= 1);
});

test("fixtures file is written for the Kotlin codec", () => {
  const fixture = buildFixtureObject(now);
  assert.ok(fixture.validHex.length > 100);
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures");
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "vectors.json"), JSON.stringify(fixture, null, 2));
});
