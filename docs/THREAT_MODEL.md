# Threat model

This is a prototype threat model, not a certification. Source authentication is not factual verification: a valid signature means "this key said this," not "this happened."

## Assets

- Emergency reports and locations.
- Responder credentials.
- Operator acknowledgement, which people may over-trust.
- The audit log.

## Assumptions

- Phones can be stolen, lost, or malicious.
- Relays can drop, delay, duplicate, or reorder packets.
- There may be no path to a gateway.
- Clocks can be wrong by minutes.
- The command-center host in a demo may be plain HTTP. That is a lab limitation, not a production posture.

## Cases

| Threat | What the prototype does | What it does not do |
| --- | --- | --- |
| Fake report | Signature required. Unsigned packets are rejected. Verification level stays unverified or eyewitness unless an operator changes it. | It cannot prove the event happened. |
| Stolen phone | Responder token is stored with Keystore AES-GCM when available. Software mesh keys are labeled. Demo reset and local wipe exist. | It cannot remotely revoke a stolen mesh key in the current build. |
| Malicious relay | Signed body is not mutable. Hop fields are unsigned and bounded to 8. Relays can still drop packets. | It does not provide end-to-end delivery guarantees. |
| Replay | `messageId` dedup, expiry, and a 2-minute future skew check. | A stolen key can still create new valid packets. |
| Denial of service | Login lockout after 8 failures, sync token bucket, max 50 packets per request, 512-byte mesh payload. | A radio jammer is out of scope. Battery policy stops low-battery relays but cannot create a path. |
| Lost gateway | Reports stay `queued_offline` and the UI says rescuers have not received them. Unknown zones are communication uncertainty, not missing people. | It cannot route around a missing physical path. |
| Cross-origin overwrite | Incident identity includes the origin pseudonym. A SAFE packet from another key does not clear NEED HELP. Stale sequences are rejected. | Operators can still correct a row; that action is audited. |
| Official-warning forgery | AI cannot publish alerts. `alert_publisher` can publish only `test`. `official` requires admin plus the exact confirmation phrase. | There is no government feed. SACHET is not integrated. |
| Impersonating a responder | Rescue mode requires a server role. A local toggle cannot grant it. | A stolen responder password still can, until the account is disabled. |

## Privacy

Mesh advertisements do not include the device name. Location is included only when the sender has a fix. The command center stores it for operators. There is no contact-book permission; emergency contacts are typed in. Photos stay on the phone until an explicit upload.
