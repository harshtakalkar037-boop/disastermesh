# Priority routing

| Priority | Meaning | Typical origin |
| --- | --- | --- |
| P0 | Immediate life threat | SOS, or critical injury after the sender confirms |
| P1 | Needs help | NEED HELP, unless the sender confirms P0 |
| P2 | Evacuation | EVACUATING |
| P3 | Routine status | SAFE or resolved. SAFE is still only a self-report. |
| P4 | General information | Other disaster notes |

The scheduler is weighted round-robin: 8, 4, 2, 1, 1 slots. Empty slots are skipped, so two P0 packets leave before a backlog of P4, and a queued P4 is still served. That behavior is unit-tested.

Relays also apply a token bucket (8 per second, burst 16) in the shared policy module. SOS origin is rate-limited in the product rules to one P0 per 10 seconds so a stuck button cannot fill the channel; the Android button sends one packet per press.

Battery: unknown battery is reported as unknown and does not pretend a measurement. Under 15%, only P0 and P1 are eligible to relay. Under 8%, the phone does not relay. The sender's own report is still stored.

None of this creates a route that is not physically there.
