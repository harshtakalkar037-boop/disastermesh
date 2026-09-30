import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeEvidenceRequest,
  classifyUnheard,
  confirmWitness,
  draftWitness,
  encodeHeardDigest,
  encodePacket,
  estimateFragments,
  fragmentPacket,
  generateIdentity,
  localModelStatus,
  officeKitStatus,
  parseHeardDigest,
  parseWitness,
  randomId,
  scarceSlotGate,
  sha256Hex,
  verifyEvidence,
  verifyPacket,
  verifyP256,
  type GateFact,
} from "../src/index.js";

const now = 1_700_000_000_000;

function fact(overrides: Partial<GateFact> = {}): GateFact {
  return {
    origin: "a".repeat(32),
    incidentType: "flood",
    claimedState: "need_help",
    peopleCount: 3,
    waterlineBand: "unknown",
    lifeThreat: false,
    priority: 1,
    text: "बाढ़ में तीन लोग फंसे हैं",
    ...overrides,
  };
}

test("witness draft is bounded, unconfirmed, and falls back when no transcript exists", () => {
  assert.equal(draftWitness({ transcript: "", modelStatus: "MODEL_UNAVAILABLE" }).ok, false);
  const drafted = draftWitness({ transcript: "बाढ़ में तीन लोग फंसे हैं, पानी दरवाजे तक", modelStatus: "MODEL_UNAVAILABLE", tiltDeg: 18 });
  assert.equal(drafted.ok, true);
  if (!drafted.ok) return;
  assert.equal(drafted.draft.incidentType, "flood");
  assert.equal(drafted.draft.claimedState, "need_help");
  assert.equal(drafted.draft.peopleCount, 3);
  assert.equal(drafted.draft.waterlineBand, "high");
  assert.equal(drafted.draft.requiresUserConfirmation, true);
  assert.ok(drafted.draft.confidence < 1);
  assert.equal(draftWitness({ transcript: "need help", modelStatus: "NPU" }).ok, false);
  assert.equal(localModelStatus({}), "MODEL_UNAVAILABLE");
  assert.equal(localModelStatus({ npuDelegateLoaded: true }), "NPU");
});

test("confirmation is required and evidence hash is bound to the bytes", () => {
  const drafted = draftWitness({ transcript: "three people trapped in flood", modelStatus: "CPU_FALLBACK", modelName: "rules" });
  assert.equal(drafted.ok, true);
  if (!drafted.ok) return;
  assert.equal(confirmWitness(drafted.draft, false).ok, false);
  const media = new TextEncoder().encode("still-bytes");
  const confirmed = confirmWitness(drafted.draft, true, media);
  assert.equal(confirmed.ok, true);
  if (!confirmed.ok) return;
  assert.equal(confirmed.hash, sha256Hex(media));
  assert.equal(parseWitness(new TextDecoder().decode(confirmed.payload)).ok, true);
  assert.equal(parseWitness(JSON.stringify({ k: "wd", official: true })).ok, false);
});

test("scarce-slot gate defers duplicates and does not defer a new life threat", () => {
  const first = fact();
  assert.equal(scarceSlotGate({ fact: first, outbox: [], heard: [], batteryPercent: 80, fragmentCount: 3 }).decision, "admit");
  const duplicate = scarceSlotGate({ fact: first, outbox: [first], heard: [], batteryPercent: 4, fragmentCount: 3 });
  assert.equal(duplicate.decision, "defer");
  assert.equal(duplicate.fragmentsSaved, 3);
  const raised = scarceSlotGate({ fact: fact({ waterlineBand: "high", text: "water is now at chest level" }), outbox: [first], heard: [], batteryPercent: 90, fragmentCount: 3 });
  assert.equal(raised.decision, "replace_previous");
  assert.equal(scarceSlotGate({ fact: fact({ lifeThreat: true, priority: 0, text: "two people unconscious" }), outbox: [], heard: [], batteryPercent: 4, fragmentCount: 2 }).decision, "admit");
  assert.ok(estimateFragments(80) >= 2);
});

test("heard-cut never classifies silence as safe", () => {
  const id = "ab".repeat(16);
  const encoded = encodeHeardDigest({ windowStartMs: now, batteryBucket: "mid", pseudonyms: [id], heldMessageId: null });
  assert.equal(encoded.ok, true);
  if (!encoded.ok) return;
  assert.equal(parseHeardDigest(new TextDecoder().decode(encoded.payload)).ok, true);
  assert.equal(parseHeardDigest(JSON.stringify({ k: "hd", win: now, bat: "low", ids: ["9876543210"], hold: null })).ok, false);
  const unheard = classifyUnheard([{ atMs: now - 20 * 60_000, heard: [id] }, { atMs: now, heard: [] }], now);
  assert.equal(unheard[0]?.label, "UNHEARD");
  assert.equal(unheard[0]?.safe, false);
});

test("hash pull rejects unauthorized, implicit, and corrupt evidence", () => {
  const bytes = new Uint8Array([9, 8, 7]);
  const hash = sha256Hex(bytes);
  assert.equal(authorizeEvidenceRequest("civilian", true).ok, false);
  assert.equal(authorizeEvidenceRequest("operator", false).reason, "explicit_request_required");
  assert.equal(verifyEvidence(new Uint8Array([1]), hash).reason, "corrupt_evidence");
  assert.equal(officeKitStatus({}).officeKit, "UNAVAILABLE");
});

test("confirmed witness enters DMSP and a duplicate is not fragmented", () => {
  const drafted = draftWitness({ transcript: "बाढ़ में तीन लोग फंसे हैं", modelStatus: "MODEL_UNAVAILABLE" });
  assert.equal(drafted.ok, true);
  if (!drafted.ok) return;
  const confirmed = confirmWitness(drafted.draft, true, new Uint8Array([4, 5, 6]));
  assert.equal(confirmed.ok, true);
  if (!confirmed.ok) return;
  assert.equal(scarceSlotGate({ fact: fact(), outbox: [fact()], heard: [], batteryPercent: 40, fragmentCount: estimateFragments(confirmed.payload.length) }).decision, "defer");
  const raw = encodePacket({
    priority: 1,
    payloadType: "witness_delta",
    messageId: randomId(16),
    originPseudonym: randomId(16),
    incidentId: randomId(16),
    eventTimestampMs: now,
    expiryTimestampMs: now + 3_600_000,
    nonce: randomId(12),
    payload: confirmed.payload,
  }, generateIdentity());
  const verified = verifyPacket(raw, verifyP256, now);
  assert.equal(verified.ok, true);
  if (!verified.ok) return;
  assert.ok(fragmentPacket(raw, verified.packet.messageId).length >= 2);
});
