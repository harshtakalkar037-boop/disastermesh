# Upgrade report

Date: 2026-09-30. This is not a claim that DisasterMesh is fully functional. The prototype builds, and the desk can run a labeled software demo. Physical multi-hop was not tested. The upgraded source had to be restored in this session because it was not in the tree; tests and the APK were produced again after that restore.

## Result

| Check | Result |
| --- | --- |
| Android compile and debug APK | Built. `./gradlew :protocol:test :app:assembleDebug` exited 0. |
| APK | Rebuilt 2026-09-30 after the four add-ons. `artifacts/disastermesh-debug.apk`, 11,031,792 bytes. SHA-256 `0d8ce23f37c631909dd44eba6be60441a2f6f00cc3126f711ef0e745c3c52cf0`. Not installed on a phone. |
| Protocol tests | 22 passed. |
| Backend tests | 8 passed, PGlite. PostgreSQL was not started. |
| Simulator tests | 6 passed, including 10,000 logical nodes. `radioKind` is `SIMULATED`. |
| Command center | 3 tests passed. Vite production build succeeded. |
| Android JVM tests | 8 passed, 0 failures (`DmspTest` 6, `LinkTest` 2). |
| Two-phone exchange | NOT RUN. |
| Three-phone A→B→C | PHYSICAL MULTI-HOP: UNVERIFIED. |
| Screenshots | Not captured. |

## Files created

- `shared-protocol/src/crc.ts`, `transfer.ts`, `conflicts.ts`, `rescue.ts`, `sustained.ts`, `demo.ts`
- `shared-protocol/test/upgrade.test.ts`
- `backend/migrations/002_desk.sql`
- `backend/src/desk.ts`
- `backend/test/desk.test.ts`
- `command-center/src/topology.tsx`, `topology.test.tsx`
- `android/protocol/src/main/kotlin/app/disastermesh/protocol/LinkFragments.kt`
- `android/protocol/src/test/kotlin/app/disastermesh/protocol/LinkTest.kt`
- `android/gradlew`, `android/gradle/wrapper/gradle-wrapper.jar`, `android/gradle/wrapper/gradle-wrapper.properties`
- `artifacts/disastermesh-debug.apk`

## Files modified

- `shared-protocol/src/fragment.ts`, `index.ts`
- `backend/src/app.ts`, `domain.ts`
- `command-center/src/App.tsx`, `ui.tsx`, `pages.tsx`
- `android/app/src/main/java/app/disastermesh/mesh/MeshEngine.kt`
- `android/app/src/main/java/app/disastermesh/MainActivity.kt`
- `android/app/build.gradle.kts`, `android/gradle.properties`
- `README.md`, `android/README.md`
- `docs/IMPLEMENTATION_STATUS.md`, `KNOWN_LIMITATIONS.md`, `SETUP.md`, `PACKET_FORMAT.md`, `PHYSICAL_DEVICE_TEST_PLAN.md`

No product source file was removed. The unused Compose extended-icons dependency was dropped so the debug package could dex in this memory limit. `android/local.properties` was written for this machine and is gitignored.

## Commands

Backend and desk, from the repo root:

```bash
cp .env.example .env
npm ci
export DM_PGLITE_PATH="$PWD/data/pglite"
SEED_USE_DEV_DEFAULTS=1 DM_DEV=1 DM_ALLOW_PGLITE=1 npm run seed
DM_DEV=1 DM_ALLOW_PGLITE=1 npm run dev:api
npm run dev:web
```

Desk: `http://127.0.0.1:5173`. Dev accounts exist only if the seed flag is set. They are not for a shared network.

Android, the command that exited 0 here:

```bash
cd android
export JAVA_HOME=/home/user/jdk-17.0.20.1+1
export ANDROID_HOME=/home/user/android-sdk
./gradlew :protocol:test :app:assembleDebug
```

Install, on a machine with a phone attached. This was not run here:

```bash
adb install -r artifacts/disastermesh-debug.apk
```

## Three-phone procedure

Do not mark this passed from the simulator.

1. Use three Android 8+ phones. Record model and Android version. B is the only relay.
2. Keep A and C out of each other's BLE range. Confirm A does not list C, and C does not list A, before the send.
3. Turn off mobile data and Wi-Fi on A and C. Leave Bluetooth on. Do not set a command-center URL during the relay section.
4. Open Capability on each phone. If the BLE advertiser flag is false, stop. The test cannot pass.
5. Exempt the app from battery optimization and grant location permission. Some OEM stacks still gate scans on it.
6. On A, create NEED HELP with a manual location. Expected state: `queued_offline`. The screen must say rescuers have not received it.
7. B starts BLE advertise. A connects only to B. A sends.
8. B may show the packet only after every fragment is present and the signature verifies. C may show `relayed_to_peer` only if its confirmation read says reconstruction and signature validation succeeded. One GATT write is not that confirmation.
9. Turn Bluetooth off on B and send a new message id from A. C must not receive it. A's state stays queued.
10. Restore B. The update should arrive once. Sending the same packet again must not create a second copy.
11. Force-stop B and repeat one relay. Record whether the OEM killed the scan.
12. Only after that, set the command-center URL on one phone and sync. `received_by_command_center` requires HTTP acceptance. Operator "mark seen" is not a rescue.

Copy the result template in `docs/PHYSICAL_DEVICE_TEST_PLAN.md`. Leave every line `NOT RUN` until someone watches it.

## Five-minute demo

This changes stored software state. It does not move a packet between phones.

1. Start the API and desk with the commands above. Sign in as the operator.
2. Overview must show zeros if the database is empty. Those zeros are stored counts, not a census.
3. Open Simulated demo. Press the button. The API stores a `demo_runs` row with evidence `SIMULATED` and does not insert a live incident. Every step on screen is labeled `SIMULATED`.
4. Open Topology. It must say `PHYSICAL MULTI-HOP: UNVERIFIED` and `server device test: NOT_RUN`. An empty list is correct.
5. Open Groups. An empty list is correct until conservative GPS rules match stored reports. BLE proximity is not membership.
6. Create a team on the Teams page. That is a real row. It is not a rescue.
7. If a phone with the debug APK is available, create NEED HELP with no gateway URL. Expected state remains `queued_offline`. Do not describe that as delivered.

## Known limitations

- No phone was attached. BLE, Wi-Fi Direct, Wi-Fi Aware, and three-phone relay are UNVERIFIED.
- Compiling the fragment writer is not evidence that an iQOO or any other phone completed a hop.
- SAFE is a self-report. Silence is UNKNOWN. A signature means the source authenticated, not that the report is true.
- Rescue assignment is not proof a rescue happened. The API rejects status `rescued`.
- The extractor is deterministic English, Hindi, and Marathi text. Speech and image models are unavailable unless a model is actually installed. It does not publish official alerts. There is no SACHET integration.
- Docker and PostgreSQL were not started. PGlite passed the same migrations.
- This tree must not be submitted as in-event hackathon work unless the organizers allow prior work. See `docs/HACKATHON_COMPLIANCE.md`.
