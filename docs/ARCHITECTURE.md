# Architecture

DisasterMesh is a prototype for offline reporting and later synchronization. It is not a certified emergency service.

```text
Android phone                         Command center
  civilian UI                         React desk
  responder UI (authenticated)        Fastify API
  SQLite outbox                       PostgreSQL or local PGlite
  DMSP/1 signer                       signature check + RBAC
  BLE GATT adapter (UNVERIFIED)       WebSocket live events
  Wi-Fi Direct adapter (UNVERIFIED)
        \                         /
         gateway sync when internet exists
                    |
              virtual simulator (separate, labeled SIMULATED)
```

## Transport decision

Ordinary phone BLE is not Bluetooth Mesh, and Wi-Fi Direct is not a mesh. The MVP radio path is **application-layer store-and-forward over pairwise BLE GATT**, with Wi-Fi Direct as a larger-payload adapter. Wi-Fi Aware is probed and not used for transfer. Google Nearby Connections is not used: it depends on Play services and is not a multi-hop mesh.

That choice is an engineering judgment from public platform limits, not a measurement on an iQOO phone. The capability screen must be read on the device. Multi-hop stays **UNVERIFIED** until `docs/PHYSICAL_DEVICE_TEST_PLAN.md` passes on three phones.

## What is simulated

- `SimulatedMesh` in `shared-protocol` proves hop, dedup, and reconnect **policy** on a fake topology. Its metrics say `radioKind: SIMULATED`.
- The scale simulator does the same for 10 to 10,000 logical nodes and says `notDeviceThroughput: true`. It does not sign every scale-model packet; cryptographic tests live in the protocol suite.
- Lab loopback in the Android app is off by default and never sets `RELAYED_TO_PEER`.

## What is real in this repository

- DMSP/1 binary codec, ECDSA P-256 signatures, replay/expiry checks.
- Delivery state machine that refuses to treat relay as operator acknowledgement.
- Conservative grouping that ignores RSSI.
- Offline deterministic extractor for English, Hindi, and Marathi text.
- Fastify API, role checks, idempotent sync, audit log, demo reset.
- Command-center pages bound to that API. Empty live data renders as zeros.
- Android UI actions that write SQLite and attempt gateway sync or a GATT write. A missing capability stays an error, not a success screen.

## Identity

Mesh packets carry a pseudonym and a P-256 public key. They do not carry a phone number or device name. The command center binds a pseudonym only to packets that verify. A different origin cannot overwrite another origin's NEED HELP. Responder mode requires an account token stored with Android Keystore AES-GCM when that API works.
