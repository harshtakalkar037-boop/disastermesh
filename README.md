# DisasterMesh

Offline-first disaster reporting prototype. Phones keep a signed report when the network is gone, can try to hand that report to a nearby phone, and can upload it when a command center is reachable. The desk shows stored records, not a story about how many people were saved.

**This is not a certified emergency service. It does not guarantee delivery, rescue, or safety. A self-report of SAFE is not proof. Silence is UNKNOWN.**

## Do not submit this tree as in-event hackathon work

The iQOO Hackathon 2026 guide, checked on 2026-09-27, says original work must be written during the event window and that a pre-built product must not be shipped. Details and dates are in [docs/HACKATHON_COMPLIANCE.md](docs/HACKATHON_COMPLIANCE.md).

## What you can run now

| Piece | State in this environment |
| --- | --- |
| DMSP/1 codec, signatures, relay policy, dedup, grouping, extractor, fragment CRC, conflict and rescue policy | Tested. 22 protocol tests passed. |
| API, roles, idempotent sync, audit, simulated demo, rescue assignment | Tested on PGlite. 8 backend tests passed. |
| Command center | Vite build succeeded. 3 component tests passed. Counts come from the API. Topology is labeled UNVERIFIED. |
| Simulator, 10 to 10,000 logical nodes | Tested. Labeled `SIMULATED`. Not device throughput. 6 tests passed. |
| Android app | Debug APK built here. See `artifacts/disastermesh-debug.apk`. JVM protocol tests: 8 passed. |
| Three-phone relay | **UNVERIFIED.** No phone was attached. The five-node demo is simulated. |

## Layout

```text
android/            Kotlin app and JVM protocol module
command-center/     React, TypeScript, Vite, Tailwind
backend/            Fastify, PostgreSQL or local PGlite, WebSocket
shared-protocol/    DMSP/1 codec and policies
simulator/          Logical disaster simulator
docs/               Format, threat model, device test plan, limits
```

## Quick start

```bash
cp .env.example .env
npm ci
export DM_PGLITE_PATH="$PWD/data/pglite"
SEED_USE_DEV_DEFAULTS=1 DM_DEV=1 DM_ALLOW_PGLITE=1 npm run seed
DM_DEV=1 DM_ALLOW_PGLITE=1 npm run dev:api
npm run dev:web
```

Desk: `http://127.0.0.1:5173`. Local demo accounts are printed by the seed command and only exist if you set `SEED_USE_DEV_DEFAULTS=1`. They are not for a shared network.

PostgreSQL path: [docker-compose.yml](docker-compose.yml). Docker was not available when this tree was built, so that path is untested here.

Android:

```bash
cd android
export JAVA_HOME=/path/to/jdk-17
export ANDROID_HOME=/path/to/android-sdk
./gradlew :protocol:test :app:assembleDebug
```

The command that succeeded in this environment on 2026-09-30 was:

```bash
JAVA_HOME=/home/user/jdk-17.0.20.1+1 ANDROID_HOME=/home/user/android-sdk ./gradlew :protocol:test :app:assembleDebug
```

It exited 0. The debug APK is copied to `artifacts/disastermesh-debug.apk` because `app/build/` is a generated directory. That file is a compiled package, not a device test. CI: `.github/workflows/android-apk.yml`.

## How a report moves

1. `queued_offline` — on this phone only. Rescuers have not received it.
2. `relayed_to_peer` — a nearby phone accepted bytes. Still not the command center.
3. `delivered_to_gateway` — an upload was handed off. Receipt is not confirmed.
4. `received_by_command_center` — the API accepted the signed packet.
5. `acknowledged_by_operator` — a person pressed Mark seen. Not a rescue promise.

The state machine rejects relayed → acknowledged. Priority is P0 life threat, P1 needs help, P2 evacuation, P3 routine, P4 information. Low priority still gets a slot. Below 15% battery the relay policy keeps only P0/P1; below 8% it does not relay.

## Radio

Default attempt is application-layer store-and-forward over BLE GATT. It is not Bluetooth Mesh. Wi-Fi Direct is a separate adapter, not a mesh. Neither was executed on hardware here. The phone does not mark a packet relayed until the peer confirms full fragment reassembly and a valid signature. Multi-hop stays UNVERIFIED. Read [docs/PHYSICAL_DEVICE_TEST_PLAN.md](docs/PHYSICAL_DEVICE_TEST_PLAN.md) before claiming a relay.

## Offline text extraction

The extractor is a deterministic English, Hindi, and Marathi rule set. It returns a confidence below 1 and always requires confirmation. It does not declare someone safe and it does not publish an official warning. Speech and image models are explicit unavailable interfaces when no model is installed. There is no cloud inference on the report path.

## Security

ECDSA P-256 via Node crypto and Java `SHA256withECDSA`. Android Keystore when it works. Threat notes: [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md). Packet layout: [docs/PACKET_FORMAT.md](docs/PACKET_FORMAT.md).

## Tests that were actually run

See [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md). Summary: protocol 22, backend 8, simulator 6, command-center 3, Android JVM 8. Debug APK built. No screenshot. Physical relay is UNVERIFIED.

## Git

```bash
git init
git add .
git commit -m "Initial DisasterMesh prototype"
git remote add origin git@github.com:YOUR_ORG/disastermesh.git
git push -u origin main
```

Do not commit `.env` or real incident data.

## License

Apache-2.0. Third-party components are listed in `NOTICE`.
