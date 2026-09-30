# DMSP/1 packet format

Magic `DMSP`, version 1. The mutable relay header is outside the signature so a relay can change hop fields without resigning. Payload integrity is the origin signature. Relays are not trusted to be honest forwarders; they cannot change the signed body without failing verification.

## Outer frame

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 1 | hopLimit, 0–8 |
| 1 | 1 | hopCount, 0–8 |
| 2 | 1 | relay flags |
| 3 | 1 | frame version = 1 |
| 4 | 2 | signed blob length, big-endian |
| 6 | N | signed blob |
| 6+N | 64 | ECDSA P-256 SHA-256 signature, IEEE P1363 r\|\|s |

## Signed blob

176-byte header, then payload.

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 4 | `DMSP` |
| 4 | 1 | version 1 |
| 5 | 1 | flags |
| 6 | 1 | priority 0–4 |
| 7 | 1 | payload type |
| 8 | 2 | payload length |
| 10 | 16 | message id |
| 26 | 16 | origin pseudonym |
| 42 | 16 | incident id, or zeros |
| 58 | 8 | event timestamp, unix ms |
| 66 | 8 | expiry timestamp |
| 74 | 12 | nonce |
| 86 | 4 | content sequence |
| 90 | 12 | location latE7, lonE7, accuracy, age; zeros if no location |
| 102 | 65 | uncompressed P-256 public key |
| 167 | 8 | first 8 bytes of SHA-256(public key) |
| 175 | 1 | reserved, must be 0 |
| 176 | N | payload, max 512 bytes |

Flags: location `0x01`, incident `0x02`, ack requested `0x08`, is ack `0x10`, gateway originated `0x20`, simulated `0x40`. Unknown flag bits are rejected.

## Limits

- Maximum encoded packet: 1400 bytes.
- Mesh text: 120 characters. Longer text stays on the phone until gateway HTTP sync.
- Photos are not sent as mesh payloads. The phone can store a photo and upload it with `POST /api/v1/sync/photo` when online.
- Default hop limit: 5. Hard maximum: 8.
- Clock skew: 2 minutes in the future. TTL maximum: 48 hours.
- Replay: `messageId` is unique. The backend `packets.message_id` primary key makes sync idempotent.
- Live sync rejects the simulated flag so simulator bytes cannot enter the live desk.

## Link fragmentation

BLE ATT payloads are often under 180 bytes after the MTU exchange, while an empty DMSP packet is already about 246 bytes. `shared-protocol/src/fragment.ts` splits a packet into 160-byte chunks with a 13-byte link header (flags, index, count, 8-byte message prefix, total length) and a CRC-16/CCITT-FALSE trailer. Reassembly times out after 8 seconds. The Android GATT writer sends those fragments and reads a 10-byte confirmation (`0xA1`, status, 8-byte message prefix). It marks `relayed_to_peer` only if every fragment write succeeds and the confirmation says the peer reconstructed a signature-valid packet. That writer is compiled and untested on hardware. A partial GATT write is not delivery.

## Cryptography

ECDSA P-256 with SHA-256, using Node `crypto` and Java `SHA256withECDSA`. No custom cipher. Android prefers Android Keystore. If Keystore signing is unavailable, a software key is stored in app-private files and the UI warning says it is not hardware-backed.

## Payload types

`hello=1`, `status=2`, `disaster_report=3`, `sos=4`, `group=5`, `alert=6`, `ack=7`, `rescue_update=8`, `text_message=9`, `photo_meta=10`, `capability=11`.

Status JSON uses short keys (`t`, `s`, `n`, `inj`, `mob`, `vul`, `txt`, `lang`, `dest`, `gs`, `vl`). A mesh status cannot set `vl` to `official`.

## Delivery words

`queued_offline`, `relayed_to_peer`, `delivered_to_gateway`, `received_by_command_center`, `acknowledged_by_operator`, `expired`, `rejected`. Relayed does not imply received. Acknowledged means an operator marked the row seen, not that a rescue is coming. `event_timestamp` is when the phone created the event. `received_at` is when the gateway stored it.
