# DisasterMesh add-on plan for iQOO Hackathon 2026

Checked against the public guide on 2026-09-30: [iqoo.reskilll.com/guide](https://iqoo.reskilll.com/guide).

This is an architectural plan for the existing product. It is not a new project. It does not replace DMSP/1, signatures, fragmentation, confirmation-before-relay, dedup, expiry, priority, states, groups, rescue assignment, gateway sync, or the desk.

Secondary prep pages restate the score as Office Kit 25% and phone-first 25%. Those weights are not on the official guide. This plan uses only the published rubric:

| Criterion | Weight | Who scores it |
| --- | --- | --- |
| End product quality | 30% | Jury |
| Novelty and impact | 20% | Jury |
| HackTracker / creative phone use | 15% | Device data: camera, voice, on-device AI |
| Technical depth | 15% | Jury |
| HackTracker / Office Kit usage | 10% | Device data: phone–laptop bridge |
| Demo and presentation | 10% | Jury, 3–5 minutes, on the iQOO phone |

Official constraints used here, and no others: the phone is the build and demo surface; a local or open-source model at the core earns brownie points; on-device inference targets the Snapdragon NPU; Office Kit is screen mirror, clipboard, file transfer, and remote control; Green Light is both devices; Red Light is phone-only through Office Kit; the product must stay useful on the phone; HackTracker records counts and durations, not keystrokes or screenshots.

One rule sits above the plan. The same guide says original work must be written during the event window and a pre-built product must not be shipped. This repository is prior work. Do not submit it as the entry unless the organisers allow it in writing. The add-ons below are what to write in the window, on top of ideas already proven here.

## A. Current DisasterMesh

What the tree actually does:

- A phone can sign a DMSP/1 packet, keep it in SQLite, fragment it, and refuse to mark it relayed until the peer confirms full reassembly and a valid signature.
- Priority, dedup, expiry, and battery policy decide *whether a signed packet may move*. They do not decide *which facts inside it are new*.
- States stay separate: queued offline, relayed to peer, gateway received, command center received, operator acknowledged. SAFE is a self-report. Silence is UNKNOWN. A signature means the key said it, not that it happened.
- Groups use conservative GPS. RSSI is not distance and not membership.
- Rescue assignment is an authorized status, not proof a rescue happened. A civilian cannot assign a team or clear another person's NEED HELP.
- The desk shows stored records. The simulator is labeled `SIMULATED`. Physical multi-hop is `UNVERIFIED`.
- English, Hindi, and Marathi text can be extracted by a deterministic rule set, and the user must confirm before send. Speech and image models are explicit unavailable states. There is no Snapdragon NPU path and no Office Kit path.

That is a serious mesh prototype. Against this rubric it is a laptop-shaped disaster app with a phone client.

## B. Missing iQOO-specific capabilities

| Rubric | What the current tree fails |
| --- | --- |
| End product quality, 30% | A judge can file a report and see an honest state. They cannot watch the phone turn a messy scene into a packet the mesh could not have carried as a form. Radio success is still unverified, so the product story dies if the demo is "trust the simulator." |
| Novelty and impact, 20% | Store-and-forward SOS is a known shape. The honesty rules are unusual, but they are invisible in a 4-minute pitch unless the mesh produces a fact a normal app cannot. |
| Creative phone use, 15% | HackTracker wants camera, voice, and on-device AI counts and durations. The app probes the camera and microphone and then tells the user to type. A capability flag is not use. |
| Technical depth, 15% | The protocol is deep. The phone is a form, a signer, and a GATT writer. Sensors do not change a packet. The model slot is empty. |
| Office Kit, 10% | The desk is a browser on a laptop. Nothing in the product calls mirror, clipboard, file transfer, or remote control. A side-channel HTTP sync will not show up as Office Kit use. |
| Demo, 10% | The five-node demo is software. It does not survive Red Light, because the interesting screen is not the phone. |

The gap is not "add AI." The gap is that the phone observes things the command center cannot, then throws that observation away and sends a form. The mesh moves bytes. It does not say which bytes were worth a 160-byte fragment, and it does not treat a failed path as information.

## C. Proposed add-on architecture

Four add-ons. They are one layer, called the **edge layer**, around the existing packet. DisasterMesh still functions if the layer is off: the form, the signer, the queue, and the desk remain. With the layer on, the phone emits a bounded delta, the mesh admits or defers that delta, neighboring phones contribute a heard-set, and the laptop may pull raw evidence only by hash.

```text
PHONE (always sufficient)
  mic + camera + IMU + GPS + battery
        |
        v
  Witness Delta          local model, user must confirm
        |
        v
  Scarce-Slot Gate       changes the outbox, not the truth
        |
        v
  existing DMSP/1        sign, fragment, confirm, dedup, expire
        |
        +---- Heard-Cut digest, priority 4, only if the heard-set changed
        |
        v
  peer / gateway

OFFICE KIT (Green Light extension, not the product)
  Hash-Pull Bridge
    file transfer  = raw evidence for a hash the operator opened
    clipboard      = audited operator note, not a new authority
    remote control = Red Light keyboard into the phone
    mirror         = pitch only, never the data path
```

Rejected near-misses, so they do not creep back in: a chatbot, a flood forecast, generic translation, generic object detection, RSSI-as-distance, face recognition, a cloud vision model on the send path, SACHET, and a digital twin that invents positions.

### 1. Witness Delta

1. **Name.** Witness Delta.
2. **Problem.** A disaster report starts as speech and a look at the scene, not as fields. The current phone either has a typed form or it has nothing. The photo, if taken, stays a blob and never changes the packet.
3. **Why the current system cannot.** The extractor accepts text the user already typed. Speech and image interfaces return unavailable. A photo upload is a later HTTP blob, not a mesh fact. Nothing fuses tilt, a frame, and a sentence into one signed claim.
4. **How it works.** The user holds the phone on the scene for one capture: up to 8 seconds of audio, one still, a 2-second IMU window, and the GPS fix with its accuracy. A local model emits a bounded JSON delta: incident type, claimed state, people count if spoken, language, a waterline *band in the frame* (`low` / `mid` / `high` / `unknown`), tilt, and a confidence below 1. The user sees the draft and must confirm or edit. Confirming signs a DMSP status packet plus a 32-byte hash of the raw clip and still. The JPEG and audio stay on the phone.
5. **Why on-device AI is necessary.** The deterministic extractor already structures clean text. It cannot hear a noisy Hindi or Marathi sentence, and it cannot say whether the frame agrees with "water at the door." That disagreement is the point. A rules-only edge detector can find a line; it cannot compare the line to the spoken claim. The model is not allowed to emit SAFE for another person, an official warning, or a team assignment.
6. **Hardware.** Microphone, camera, gyroscope and accelerometer, GPS, local storage, CPU, and the Snapdragon NPU if the delegate loads. Battery level is read but not inferred. Vibration fires only after the user must confirm, so a queued send is felt, not assumed delivered.
7. **Mesh.** The signed packet is smaller than the evidence. Peers relay the delta and the hash. They do not relay the JPEG. Two phones whose bands or people-counts disagree stay `conflicting`. Neither packet clears NEED HELP. The hash is how the desk later asks for the file.
8. **Office Kit.** Not on the capture path. The laptop never needs the live camera. It receives the hash inside the signed packet, then file-transfer pulls the still only if an operator opens that hash.
9. **Offline.** Capture, inference, confirm, sign, and queue all work with no gateway. If the model is missing, the phone says so and offers the existing typed form. It does not invent a transcript.
10. **Security.** The model output is not a signature and not a fact. The user confirmation is the send. Raw audio and the still are not flooded onto BLE. A stolen phone can still sign new packets; that limit already exists. The hash lets an operator request evidence without every relay seeing the face or the room. Do not run face recognition. Do not store a gallery scan.
11. **Complexity.** Medium if the model is one small ASR plus one small frame classifier. High if it is a custom vision-language model. Do not build the latter.
12. **Physical demo.** Speak one Hindi or Marathi sentence, tilt the phone at a door or a drawn waterline, confirm the draft, and show the packet queued while the still remains in the phone's private store.
13. **Buildable in the window.** Yes, if the model is Whisper Tiny or sherpa-onnx for speech, the existing extractor for the text, and a tiny on-device classifier or a clearly labeled classical tilt correction for the band. NPU execution is attempted through the QNN or NNAPI delegate and reported as `NPU` or `CPU_FALLBACK`. Never claim the NPU if the delegate did not load.
14. **Not a gimmick.** The mesh payload changes. A conventional app would upload the video. This one sends a confirmed delta and keeps the evidence local until asked.

### 2. Scarce-Slot Gate

1. **Name.** Scarce-Slot Gate.
2. **Problem.** A BLE fragment is about 160 bytes of payload. An empty DMSP packet is already about 246 bytes, so one report is several fragments. The current scheduler sends the next signed packet by priority. It will happily spend the next three fragments repeating a story the neighbor already accepted.
3. **Why the current system cannot.** Dedup drops the same message id. It does not notice that a new message id carries no new fact. Battery policy drops low-priority relays. It does not shrink a packet. Priority is a user or extractor hint, not a comparison against what this phone and its neighbors have already heard.
4. **How it works.** Before fragmentation, the gate sees the confirmed delta, the local outbox, the last heard neighbor digests, battery, and the fragment count. It returns only `admit`, `defer`, or `replace_previous`, plus fields to omit (a GPS fix no better than the last one, repeated text). It cannot raise a packet to life-threat unless the user confirms that raise. It cannot mark anyone safe. `replace_previous` supersedes this origin's own unsent or unacknowledged delta; it does not overwrite another origin.
5. **Why on-device AI is necessary.** For typed duplicates, a hash of the structured fields is enough, and that part should stay deterministic. The model is necessary when the new input is another noisy sentence that means the same NEED HELP with one new fact ("the child cannot walk"). A keyword rule will either resend everything or drop the new fact. The gate's model job is a diff, not a chatbot.
6. **Hardware.** CPU or NPU for the diff, battery API, local outbox. No camera on this step.
7. **Mesh.** This is the intelligent-mesh layer. Routing still uses the existing priority and hop limit. The gate changes *what is offered to that router*. A relay running the same gate prefers a new life-threat delta over a repeated self-report when battery is low, and it still does not bounce a packet to the peer it came from. A partial GATT write remains not delivery. The gate never marks `relayed_to_peer`.
8. **Office Kit.** None. This must run on the phone during Red Light.
9. **Offline.** The gate is local. If the model is unavailable, it falls back to the existing priority queue and shows `GATE_OFF`. It does not pretend a packet was compressed.
10. **Security.** A malicious model cannot clear NEED HELP or assign a team, because those actions are not in its output schema, and the signer still signs only the user-confirmed packet. A relay that drops a packet can still drop it. The gate does not create a path.
11. **Complexity.** Low for the deterministic omit-and-replace rules. Medium for the spoken-diff model. Ship the rules on day one and add the model only if Witness Delta is already producing text.
12. **Physical demo.** Send the same plea twice and show one fragment sequence. Then add one new fact and show a short delta admitted while the old text is not resent. Turn on lab battery-low and show a routine packet deferred and a confirmed NEED HELP still admitted.
13. **Buildable in the window.** The deterministic half, yes. The spoken diff, only after Witness Delta. Do not block the demo on it.
14. **Not a gimmick.** It is the difference between a mesh that moves forms and a mesh that spends scarce slots on new facts. That is a measurable outbox change.

### 3. Heard-Cut

1. **Name.** Heard-Cut.
2. **Problem.** Disaster systems treat silence as either "safe" or "missing person." Both are wrong. They also throw away the only signal a phone mesh has when a path dies: who could hear whom, and when that set changed.
3. **Why the current system cannot.** Peers are stored as radio neighbors. RSSI is correctly not turned into distance or a group. Unknown zones are a desk query, not a signed observation from the phones. A failed relay is an error string, not a fact other phones can forward.
4. **How it works.** Each phone keeps a heard-set: pseudonyms heard in the last window, a battery bucket, and the highest-priority undelivered message id it still holds. It does not include RSSI, device name, or phone number. When the set changes, it signs a small P4 digest and offers it to the gate. The desk joins digests into a heard-graph. A pseudonym that was heard, then absent from every digest on this side of a break, is `UNHEARD`. That is not SAFE, not a missing-person declaration, and not a coverage map. One bad GPS point still does not split a group. A cut is about packets, not about people standing together.
5. **Why on-device AI is necessary.** It is not. Do not put a model here. Inventing an AI "partition predictor" would be a gimmick. The intelligence is the collective heard-set. Say that in the pitch so the model stays where unstructured input is.
6. **Hardware.** Bluetooth scan and GATT, local storage, battery bucket. GPS is not required for a cut.
7. **Mesh.** The digest is an ordinary signed packet. It uses the existing dedup, expiry, and fragment confirmation. Relays forward it only if the gate admits it. The structure of the mesh becomes a payload.
8. **Office Kit.** The phone can show "last heard, now unheard" by itself. The laptop is where the graph of many digests is laid out, because a phone screen cannot hold a partition. The digests arrive as packets. Office Kit is not required to compute the cut.
9. **Offline.** Digests propagate with the mesh. With no peer, the phone shows only its own heard-set and does not draw a region.
10. **Security.** Heard-sets are pseudonyms, not identities. A malicious phone can omit a neighbor; absence is therefore not proof someone left. The UI must say `UNHEARD`, never "gone" or "safe." Do not infer that two phones which hear each other are a rescue group.
11. **Complexity.** Medium. The packet is small. The honest UI is the hard part. Do not draw inferred distances.
12. **Physical demo.** A hears B. Turn Bluetooth off on B. A's heard-set changes. The phone says B is unheard. It does not say B is safe. If a third phone is out of range, show that C did not receive the update. If the venue cannot separate the radios, say `PHYSICAL MULTI-HOP: UNVERIFIED` and do not simulate the cut on stage as if it were the radio.
13. **Buildable in the window.** Yes, as a signed digest and a desk panel. Three-phone proof is a test, not a feature you can promise.
14. **Not a gimmick.** Every disaster app loses the cut. This one signs it. That is the line a judge has not seen a SOS form draw.

### 4. Hash-Pull Bridge

1. **Name.** Hash-Pull Bridge.
2. **Problem.** The laptop has the screen and the keyboard. The phone has the scene. Today's desk ignores that split: it is a website the phone uploads into when the network exists. During Red Light the website is the wrong product. A mirrored phone screen is also the wrong product, because the operator learns nothing the phone did not already show.
3. **Why the current system cannot.** Gateway sync is HTTP. Office Kit is unused. Raw evidence has no request path other than "upload the photo." There is no way for the laptop to ask for one hash, and no way for the phone to remain the operator surface when the laptop is forbidden.
4. **How it works.** Green Light: the phone is paired in Office Kit. Signed packets and heard-digests are file-transferred as a small log, or mirrored only so the jury can see the phone. The desk renders the deltas, the conflicts, and the cut. When an operator opens a hash, Office Kit file transfer pulls that still or clip and no other. Clipboard from laptop to phone becomes an operator note on an assignment, audited, and it does not change role or mark anyone rescued. Red Light: the phone UI is the product. Remote control and clipboard let a keyboard drive that UI. The laptop app may keep running, but the judge is looking at the phone, which is what the guide requires.
5. **Why on-device AI is necessary.** It is not, on the bridge itself. The bridge exists so the model output and the raw evidence do not take the same path. If you mirror the screen and call it architecture, Office Kit points are cosmetic.
6. **Hardware.** The phone's radio and storage, plus Office Kit on the laptop. Wi-Fi or the Office Kit link, whichever the loaner actually pairs. Do not assume Wi-Fi Direct.
7. **Mesh.** The bridge is not a hop and not a relay. A file that arrives on the laptop is `received_by_command_center` only after the existing signature check accepts the packet. A dragged JPEG without a signed packet is evidence in a tray, not an incident. The mesh state machine does not gain a new "delivered to rescuer" state.
8. **Office Kit.** File transfer for the hash pull. Clipboard for the operator note. Remote control for Red Light input. Screen mirror for the pitch camera, not for the data path. HackTracker counts durations, so the demo must actually perform these actions, not describe them.
9. **Offline.** With no pair, the phone keeps the queue, the delta, and the evidence. The desk shows nothing new. That is the correct empty state. Pairing later pulls the log; it does not rewrite history.
10. **Security.** File transfer of a still is a disclosure. It happens only after an operator opens a hash, and it is audited. Clipboard text is untrusted until the phone user or the signed-in operator confirms the note. Do not let a pasted string assign a team or publish an official alert. Office Kit pairing is a trust boundary the Saturday teach-in must confirm; until then label the bridge `UNVERIFIED` on hardware.
11. **Complexity.** Medium, and externally risky, because the Office Kit developer surface is not specified on the guide beyond the four user features. Build the phone side so a share-sheet and a clipboard paste are enough. Do not depend on an unpublished SDK.
12. **Physical demo.** Open one hash on the laptop and show the still arrive by Office Kit, not by a browser upload. Paste a note. Then cover the laptop keyboard, drive the phone's "mark seen" through remote control, and show the state change on the phone.
13. **Buildable in the window.** The phone share and paste, yes. A custom Office Kit SDK integration, only if the teach-in provides one. Practice pairing before Saturday.
14. **Not a gimmick.** The laptop sees the collective cut and the one frame the operator asked for. The phone still works when the laptop is taken away. That is the Green Light / Red Light split the rubric is built around.

## D. Updated end-to-end data flow

1. The phone records speech, one still, IMU, GPS accuracy, and battery. No packet yet.
2. Witness Delta drafts a bounded claim. Confidence stays below 1. If the frame disagrees with the speech, the draft is marked conflicting with itself.
3. The user confirms or edits. Cancel sends nothing.
4. Scarce-Slot Gate compares the confirmed delta with the local outbox and heard digests. It admits, defers, or replaces this origin's previous unsent delta.
5. The existing signer emits DMSP/1. The still and audio stay local, addressed by hash.
6. Fragmentation and peer confirmation work as they do now. Relayed is not command-center delivery.
7. Neighbors may forward under the existing hop, battery, and no-bounce rules. The gate on a relay may defer a repeated self-report. It may not drop a confirmed P0 or P1 that has not expired.
8. Heard-Cut digests move as P4 packets when the set changes.
9. A phone with a gateway, or a paired laptop, submits signed packets through the existing sync. Simulated packets stay out of live records.
10. Hash-Pull transfers a still only for an opened hash. The desk shows the delta, the conflict, and `UNHEARD` where the digests support it. Assignment remains a human operator action.

No step declares a person safe because a model, a neighbor, or a laptop said so.

## E. On-device AI architecture

One model role, not a suite.

| | |
| --- | --- |
| Model | Open-source speech model small enough for the loaner: Whisper Tiny or sherpa-onnx. Optional second model: a tiny frame classifier with labels `water_cue`, `no_water_cue`, `unknown`. No chatbot. No 2B assistant in the send path. |
| Input | 8 seconds of audio; one still; IMU tilt; GPS accuracy; the last confirmed delta from this pseudonym. |
| On-device processing | ASR, then the existing English/Hindi/Marathi extractor. The frame classifier only answers whether a water cue is present. Tilt is measured, not guessed. Run on the NPU delegate if it loads; otherwise CPU, labeled `CPU_FALLBACK`. |
| Output | A draft the user must confirm: type, claimed state, people count, language, waterline band or `unknown`, self-disagreement flag, confidence, evidence hash. Schema refuses `official_alert`, `assign_team`, and `mark_other_safe`. |
| How it changes the mesh | The signed payload is the confirmed draft plus hash, not the media. The gate then admits or replaces. A self-disagreement flag forces `conflicting` and does not clear NEED HELP. |

Measurable effect, which the demo should show as numbers from the phone, not as a slide: fragment count before and after the gate, and whether a second sentence added a field or was deferred.

If the loaner has no offline recognizer and the NPU delegate fails, the phone says so. The typed form remains. Do not call cloud credits for the send path. Weekend AI credits, if used at all, are for a laptop rehearsal, never for the packet that enters the mesh.

## F. Phone and Office Kit architecture

| Concern | Phone, always | Laptop, Green Light only |
| --- | --- | --- |
| Sensing | Mic, camera, IMU, GPS, battery, BLE | None |
| Local model | Witness Delta and the gate | None on the send path |
| Mesh | Sign, queue, fragment, confirm, heard-set | Not a radio hop |
| Truth | User confirms their own claim | Operator may mark seen, assign, or note. Cannot invent SAFE from silence |
| Evidence | Keeps the still and audio | Pulls one hash via Office Kit file transfer |
| Collective view | Own heard-set and own queue | Heard-graph, conflicts, assignment |
| Red Light | Full product. Remote control and clipboard are input devices | Screen may be dark. Mirror is not required for the action |

Office Kit actions that must actually happen in the pitch, because HackTracker stores durations:

- File transfer of one still after a hash is opened.
- Clipboard of one operator note, confirmed on the phone.
- Remote control of one phone button while the laptop keyboard is the thing the judge sees moving.
- Mirror only so the room can see the phone. Say that out loud so it is not mistaken for the architecture.

Do not build a second command center that only runs in the browser. Extend the existing desk so it can render a pulled log. If the log did not come through Office Kit, label the path.

## G. Killer demo: "The sentence, the slot, the cut"

Three to five minutes. One story. The phone is in the judge's hand or on the mirror of that phone. Multi-hop is a stretch, not the spine, because it is still unverified on hardware.

1. **0:00.** Airplane mode. No gateway URL. Phone shows `queued_offline` for nothing yet, and says rescuers have not received anything.
2. **0:20.** Speak: "बाढ़ में तीन लोग फंसे हैं, पानी दरवाजे तक." Witness Delta drafts flood, NEED HELP, people 3, a language tag, confidence below 1. The user confirms. The still is captured against a door with the phone tilted. IMU is on screen as degrees, not as a fake depth. The JPEG does not leave the phone. The packet is signed.
3. **1:10.** Scarce-Slot Gate shows the fragment count. Repeat the same sentence. The gate defers it. Add "बच्चा चल नहीं सकता." The gate admits a short delta. The queue still says rescuers have not received it.
4. **1:50.** A second phone is a neighbor. It confirms reassembly. The first phone may then say relayed to a peer, and the screen still says this is not the command center. If that GATT confirmation does not happen, stop and read the error. Do not play the simulator.
5. **2:30.** The second phone has a different people count. Both claims remain. The desk, once connected, shows `conflicting`, not a blended number.
6. **3:10.** Turn Bluetooth off on the relay. The heard-set changes to `UNHEARD`. Nobody is marked safe.
7. **3:40.** Green Light. Office Kit file transfer: the operator opens the hash, and the still arrives on the laptop. They assign a team. The phone shows assigned, not rescued.
8. **4:20.** Red Light. Cover the laptop app. Clipboard or remote control marks the report seen on the phone. The state becomes operator acknowledged. Say that this is not a rescue.

If only one phone and a laptop are reliable, cut steps 4 and 6 rather than fake them. The sentence, the slot, the hash pull, and the Red Light ack are enough to hit voice, camera, on-device inference, mesh honesty, and Office Kit.

## H. What to actually build

In the event window, in this order:

1. Witness capture and confirm-before-send, with an explicit unavailable state if the model does not load.
2. Whisper Tiny or sherpa-onnx, then the existing extractor. NPU delegate if it loads.
3. Deterministic Scarce-Slot Gate: omit repeated fields, replace this origin's unsent delta, never clear another origin.
4. Evidence hash in the signed packet. JPEG stays local.
5. Office Kit file transfer of one opened hash, clipboard note, and one remote-controlled button. Practice the pair before Saturday.
6. Heard-Cut digest and an `UNHEARD` row on the phone and the desk.
7. Only then, a third phone. Record the result in the physical test plan. Leave it `NOT RUN` if it was not watched.

Do not spend the window on UI polish, a custom vision-language model, or a new codec.

## I. What not to build

- A chatbot, a summarizer, or an "assistant" on the desk.
- Any model that can emit SAFE for another person, an official warning, or a team assignment.
- Cloud inference on the path that creates a mesh packet.
- Generic object detection, face recognition, or a weather widget.
- RSSI as distance, BLE proximity as a group, or one GPS point as a split.
- A coverage map or a count that did not come from stored packets.
- Screen mirror as the Office Kit story.
- A laptop-only desk that the phone cannot survive without.
- Blockchain, a new radio, or a claim that BLE GATT is Bluetooth Mesh.
- Submitting this pre-event tree as in-event work.
- A demo that uses the simulator and calls it a phone result.

## J. Final architecture

DisasterMesh remains the product: signed store-and-forward over BLE GATT, honest delivery states, groups, rescue assignment, and a desk.

The new layer is edge intelligence around that packet.

- The phone is the sensor, the model, the signer, and the queue.
- The model turns one messy capture into a confirmed delta and a hash.
- The gate spends fragment slots on new facts.
- The heard-set makes a cut visible without calling anyone safe.
- Office Kit is how the laptop pulls one piece of evidence and how a keyboard reaches the phone when the laptop app is not allowed to be the product.

If the model is off and Office Kit is unpaired, what remains is the DisasterMesh that already exists. That is the test these four add-ons pass.
