# Implementation status

Recorded after the commands in this environment on 2026-09-30. An earlier 2026-09-27 APK remained on disk, but the upgraded source had not persisted. The source was restored and the commands below were run again. A simulated result is not a phone result.

## Passed here

| Suite | Command | Result |
| --- | --- | --- |
| `@disastermesh/protocol` | `npm test` on 2026-09-30 after the four add-ons | 21 passed, 0 failed |
| `@disastermesh/backend` | same `npm test` | 8 passed, 0 failed, PGlite |
| `@disastermesh/simulator` | same `npm test` | 6 passed, 0 failed, including 1,000 and 10,000 logical nodes |
| `@disastermesh/command-center` | same `npm test` | 3 passed, 0 failed |
| Android JVM protocol | `JAVA_HOME=/home/user/jdk-17.0.20.1+1 ANDROID_HOME=/home/user/android-sdk /home/user/gradle-8.9/bin/gradle :protocol:test` | 10 passed (DmspTest 6, EdgeTest 4), 0 failed |
| Debug APK | `:app:assembleDebug` exit 0, on 2026-09-30, after the add-ons | `artifacts/disastermesh-debug.apk`, 11,031,792 bytes, SHA-256 `0d8ce23f37c631909dd44eba6be60441a2f6f00cc3126f711ef0e745c3c52cf0`. Not installed. |

The protocol suite includes a **simulated** three-node relay and a **simulated** five-node demo. `radioKind` is `SIMULATED`. That is not a phone test.

The backend suite checked empty dashboard zeros, idempotent sync, tamper, expiry, simulated-flag rejection, role denial, stale sequence, cross-origin SAFE not clearing NEED HELP, operator ack, extractor not creating an alert, demo reset retaining the audit log, a stored SIMULATED five-node demo that does not change live incidents, and rescue assignment that cannot be marked `rescued`.

## Not run here

| Item | Result |
| --- | --- |
| Physical phone, BLE advertise/scan/connect, or GATT write | NOT RUN. Capability on a real device is UNVERIFIED. |
| Two-phone signed exchange | NOT RUN. |
| Three-phone A→B→C relay | PHYSICAL MULTI-HOP: UNVERIFIED. |
| Wi-Fi Direct or Wi-Fi Aware transfer | UNVERIFIED. |
| Screenshots | Not captured. |
| Docker Compose / PostgreSQL | Not started. Backend tests used PGlite with the same SQL migrations. |

## Implemented versus simulated

Implemented as executable code: packet codec, signatures, priority scheduler, dedup, conservative grouping, sustained split proposals, CRC link fragments, conflict policy, rescue authorization, offline text extractor, API, desk topology and simulated-demo pages, Android UI, SQLite outbox, GATT fragment writer that does not claim relay until a confirmation read, Wi-Fi Direct adapter, gateway HTTP client.

Simulated only: `SimulatedMesh`, `runFiveNodeDemo`, the scale simulator, and the Android lab loopback (off until confirmed twice).

Unverified device capability: every radio success path. Compiling the GATT writer is not a radio test.

The four add-ons are in this tree: Witness Delta, Scarce-Slot Gate, Heard-Cut, and Hash-Pull. Office Kit SDK is absent, so the phone uses the system share sheet and the desk stays hash-only until an operator explicitly requests and verifies. NPU is not claimed. Inference is `MODEL_UNAVAILABLE` unless a device speech recognizer returns text, which is labeled `CPU_FALLBACK`, not NPU. No phone, camera, microphone, IMU, GPS, local model, or Office Kit transfer was run here.
