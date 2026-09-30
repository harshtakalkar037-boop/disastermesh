# Physical device test plan

No three-phone test was run in the build environment. Until this plan is executed and the results are written down by the people who ran it, multi-hop is **UNVERIFIED**. Do not paste simulator output into this record.

## Roles

- Phone A, B, and C. Android 8 or newer. Record manufacturer, model, and Android version.
- B is the only relay. A and C must not be in each other's BLE range. Put them in separate rooms or shield them until a scan from A does not list C and a scan from C does not list A.
- Disable mobile data and Wi-Fi on A and C for the relay section. Leave Bluetooth on.
- B may have Bluetooth only. No phone should have the command-center URL set during the relay section, or a gateway result will be confused with a relay result.

## Procedure

1. On each phone, open Capability and write down every flag. If BLE advertiser is false, stop. The test cannot pass.
2. Exempt all three apps from battery optimization. Confirm location permission is granted because some OEM stacks still gate scans on it.
3. A creates a NEED HELP report with a manual location. Expected state: `queued_offline`, with text that rescuers have not received it.
4. B starts relay. A and B become radio neighbors. C is not a neighbor of A.
5. A sends. B must log an inbound packet only after every fragment is present and the signature verifies. C must show the same message id, hop count at least 1, and state `relayed_to_peer` only if C's confirmation read said the packet was fully reconstructed and signature-valid. A GATT write of one fragment is not that confirmation. `relayed_to_peer` still does not mean the command center has it, and it does not mean a rescuer received it.
6. Turn Bluetooth off on B. A sends an update with a new message id. C must not receive it. A's state stays queued.
7. Turn Bluetooth on and restore B. The update should arrive once. Send the same packet again. C's copy count for that message id stays 1.
8. Force-stop the app on B and repeat one relay. Record whether the OEM killed the scan.
9. Deny Bluetooth permission, disable Bluetooth, and set battery under 8% (or use the battery policy with a low reading). Record the error text. None of these may show a success screen.
10. Inject a malformed and a replayed packet with the lab tools only if you have a debug build. Expected results: reject, no new incident.
11. Set a command-center URL, restore internet on C only, and sync. Expected state becomes `received_by_command_center` only after HTTP acceptance. Then an operator presses Mark seen. Expected state becomes `acknowledged_by_operator` on the next signed ack poll. Do not describe that as a rescue.

## Result template

Copy this into the team notes. Default every line to `NOT RUN`.

```text
date:
phones:
A model/android:
B model/android:
C model/android:
capability A:
capability B:
capability C:
A does not see C before relay: NOT RUN
C receives via B: NOT RUN
message id:
hop count:
disconnect B blocks update: NOT RUN
reconnect delivers once: NOT RUN
duplicate dropped: NOT RUN
process restart: NOT RUN
permission denied text:
bluetooth off text:
low battery text:
gateway sync message id:
operator ack seen: NOT RUN
tester names:
```

A pass is only the lines you personally observed. The in-app physical test log also defaults to not run and does not auto-pass.
