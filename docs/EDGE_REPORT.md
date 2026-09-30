# DisasterMesh edge add-ons

Date: 2026-09-30. This is an upgrade of the existing tree. No second protocol. No physical radio test was run.

## 1. Files changed

- `shared-protocol/src/constants.ts` — payload codes 12–16
- `shared-protocol/src/index.ts` — exports the edge module
- `backend/src/domain.ts` — signed edge packets are stored or rejected before the generic accept path
- `backend/src/app.ts` — `/api/v1/edge` and evidence routes
- `command-center/src/App.tsx`, `command-center/src/ui.tsx` — Edge page
- `android/protocol/src/main/kotlin/app/disastermesh/protocol/Dmsp.kt` — same payload codes
- `android/app/src/main/java/app/disastermesh/mesh/MeshEngine.kt` — records verified origin pseudonyms, not BLE addresses
- `android/app/src/main/java/app/disastermesh/ui/Desk.kt` — Witness flow, gate, heard digest, share sheet
- `android/app/src/main/java/app/disastermesh/MainActivity.kt` — Witness screen, still and file pickers
- `android/app/build.gradle.kts` — removed unused `material-icons-extended` so the debug dex merge could finish in this memory limit

## 2. Files added

- `shared-protocol/src/edge.ts`
- `shared-protocol/test/edge.test.ts`
- `backend/migrations/002_edge.sql`
- `backend/src/edge.ts`
- `backend/test/edge.test.ts`
- `command-center/src/edge.tsx`
- `command-center/src/edge.test.tsx`
- `android/protocol/src/main/kotlin/app/disastermesh/protocol/Edge.kt`
- `android/protocol/src/test/kotlin/app/disastermesh/protocol/EdgeTest.kt`

## 3. Architecture changes

The phone path is now: sensors or manual text, Witness draft, user confirm, Scarce-Slot Gate, existing DMSP/1 sign, existing enqueue, existing fragmentation and relay. Heard-Cut is a separate signed digest. The desk receives the fact and hash. Original media stays on the phone until an operator explicitly requests it. Priority routing, signing, nonce, TTL, dedup, and replay checks were not replaced.

## 4. Witness Delta

`draftWitness` uses the existing deterministic extractor. Output is bounded: type, self-claimed state, people count, language, waterline band, optional tilt, confidence below 1, evidence hash, inference status. Empty text, or an NPU label with no named delegate, returns `manual_form_required`. A flood phrase plus `no_water_cue` sets self-conflict and caps confidence. `official`, assignment, and team id are rejected. Confirmation is required before bytes exist. `confirmWitness` hashes the local bytes and puts only the hash in the payload. The phone can try about 8 seconds of audio, one still, a 2-second accelerometer window, and the existing GPS read. A failed sensor is labeled `UNAVAILABLE`. No file or tilt is invented.

## 5. Scarce-Slot Gate

`scarceSlotGate` runs in the phone confirm path before `enqueueAndTry`. Decisions are `admit`, `defer`, and `replace_previous`, with reason, new fields, and fragments saved. A repeat with no new fact is deferred and not fragmented. A new waterline or text replaces an unsent report from the same origin. A new life-threat fact is admitted even at low battery. A routine priority-3-or-lower update can be deferred under 15 percent battery. The existing priority scheduler remains the router. The gate does not mark anyone SAFE.

## 6. Heard-Cut

A signed digest carries a time window, a battery bucket, up to eight 32-hex pseudonyms, and an optional held message id. Phone numbers and device names fail parsing. The phone records origin pseudonyms only from packets that already verified. An unchanged set is not sent. Silence classifies as `UNHEARD` with `safe: false`. The desk prints `UNHEARD ≠ SAFE`. There is no coverage map and no RSSI-as-distance. No AI is used.

## 7. Hash-Pull Bridge

The desk stores the fact, metadata, location from the signed packet header, and hash. `mediaOnMesh` is false. `POST /api/v1/edge/evidence/request` requires operator or admin and `explicit: true`. A responder is rejected. A public sync of `evidence_request` or `evidence_response` is rejected as `operator_channel_only`. Paste is untrusted. A `command` field is rejected. SHA-256 mismatch is `corrupt_evidence` and is audited. Matching bytes are not stored by the verify route. Conflicting people counts stay on separate witness rows and are not averaged into the incident total.

## 8. Local AI model/delegate status

`MODEL_UNAVAILABLE`. No Whisper Tiny, sherpa-onnx, or NPU delegate is bundled or loaded. `localModelStatus` returns `NPU` only if a caller reports that a delegate actually loaded. A model file without that delegate is `CPU_FALLBACK`. The phone labels device speech `CPU_FALLBACK` only after `SpeechRecognizer` returns text. Otherwise the manual form remains.

## 9. Office Kit integration status

`UNAVAILABLE`. No Office Kit SDK is in this tree. The phone opens the system share sheet for a local evidence file and says that is not an Office Kit transfer. The desk does not pretend a laptop receipt happened.

## 10. Tests passed

`npm test` on 2026-09-30: protocol 21, backend 8, simulator 6, command-center 3, failed 0.

Android JVM, JDK 17, SDK 35: DmspTest 6 and EdgeTest 4, failed 0. `:app:assembleDebug` exited 0.

## 11. Physical tests passed

None.

## 12. Physical tests NOT performed

Camera, microphone, IMU, GPS, speech recognizer, NPU, BLE advertise/scan/connect, GATT write, Wi-Fi Direct, Wi-Fi Aware, two-phone signed exchange, three-phone A→B→C, Office Kit or share-sheet transfer, APK install. `PHYSICAL MULTI-HOP: UNVERIFIED`.

## 13. Known limitations

The local model slot is a status probe, not a running speech or vision model. Device speech is optional and untested. Deferred gate decisions reach the desk only if a signed `scarce_slot_decision` packet is later synced. The phone keeps them locally until then. Evidence retrieval is hash verification of an operator paste or an OS share, not a tested Office Kit pull. Fragment savings in tests are estimates from payload size, not measured airtime. The debug APK is not installed. After the recorded compile, the add-on sources had to be restored. The file later found at `artifacts/disastermesh-debug.apk` was a valid APK archive, but it was 11,015,408 bytes with SHA-256 `51004911e16b4d462a1690fd4c92557a781a8138a935db5029e55d9727a46094`. That does not match the recorded compile, so it is not that APK and is not in the source zip. The restored phone UI was not recompiled. `npm test` and Gradle were not rerun after the restore.

## 14. Exact commands

```
cd /home/user/disastermesh
npm test
```

```
cd /home/user/disastermesh/android
export JAVA_HOME=/home/user/jdk-17.0.20.1+1
export ANDROID_HOME=/home/user/android-sdk
export ANDROID_SDK_ROOT=/home/user/android-sdk
export GRADLE_USER_HOME=/home/user/.gradle-android
/home/user/gradle-8.9/bin/gradle :protocol:test :app:assembleDebug --no-daemon
```

Local desk, after seeding a PGlite directory:

```
DM_PGLITE_PATH=/home/user/disastermesh/data/pglite-edge DM_DEV=1 DM_ALLOW_PGLITE=1 SEED_USE_DEV_DEFAULTS=1 npm run seed -w @disastermesh/backend
DM_PGLITE_PATH=/home/user/disastermesh/data/pglite-edge DM_DEV=1 DM_ALLOW_PGLITE=1 npm run dev -w @disastermesh/backend
npm run dev -w @disastermesh/command-center -- --host 0.0.0.0 --port 5173
```

Operator login for the local demo is `operator@example.invalid` / `dev-operator-pass`. That password is a local seed, not a production secret.

## 15. Finale demo, about 4–5 minutes

Say first: prototype, not a certified emergency service, no rescue guaranteed, `PHYSICAL MULTI-HOP: UNVERIFIED`.

0:00–0:40. Open the desk, sign in, open Edge. Read empty counts and `UNHEARD ≠ SAFE`. Say the zeros are stored records. Point at Office Kit `UNAVAILABLE` and local model `MODEL_UNAVAILABLE`.

0:40–1:30. On a phone with the new APK, open Witness. If speech, camera, or motion fails, read the unavailable line and type `बाढ़ में तीन लोग फंसे हैं, पानी दरवाजे तक`. Tap Make draft. Do not confirm yet. Say the draft is not on the mesh.

1:30–2:20. Tap Confirm and queue. The line must say signed and queued offline, not delivered to a rescuer. Confirm the same sentence again. It should say DEFERRED and `no_new_fact`. Change it to water at chest level and confirm again. That one should admit or replace. Do not defer a life-threat to save bandwidth.

2:20–3:10. If a second phone has exchanged a verified packet, sign a heard digest and show the pseudonym count. Turn Bluetooth off on the heard phone and show UNHEARD. Say that is not SAFE. If the radios cannot be separated, stop and say the cut was not physically shown.

3:10–4:00. After a signed witness sync, open the desk card. The hash is present and the image bytes are not. Click Request original. Paste the wrong text and show `corrupt_evidence`. A mesh packet must not pull the file.

4:00–4:40. Close on the sentence, the slot, and the cut. The simulator is not the radio. Three phones have not shown A to B to C.

## 16. Still simulated or unverified

| Item | Label |
| --- | --- |
| Protocol, gate, hash, heard rules | TESTED in Node and Android JVM |
| Desk conflict and evidence routes | TESTED by API tests, not by a phone |
| Debug APK | TESTED compile on the earlier tree, not installed. Recorded size 11,031,792 bytes, SHA-256 `fbc6f0cd6a2d3246c06607efd2fd40db4d6ccf4cf3f62d80f4c188de927395cd`. Those bytes are not in this zip. A different 11,015,408-byte archive was present and was excluded. |
| Camera, mic, IMU, GPS, speech, NPU | UNVERIFIED |
| Office Kit transfer | UNAVAILABLE |
| BLE, Wi-Fi Direct, two-phone exchange | UNVERIFIED |
| Three-phone A→B→C | PHYSICAL MULTI-HOP: UNVERIFIED |
| Simulator relay | SIMULATED, not physical proof |

No latency, radio fragment count, battery, or transfer number was invented.
