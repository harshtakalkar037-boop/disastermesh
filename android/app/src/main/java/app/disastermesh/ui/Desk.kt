package app.disastermesh.ui

import android.Manifest
import android.app.Application
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.net.Uri
import android.os.BatteryManager
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.activity.ComponentActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import app.disastermesh.DisasterMeshApp
import app.disastermesh.data.ReportRow
import app.disastermesh.protocol.DeliveryState
import app.disastermesh.protocol.EdgeResult
import app.disastermesh.protocol.GateFact
import app.disastermesh.protocol.HeardSet
import app.disastermesh.protocol.LocationFix
import app.disastermesh.protocol.PacketDraft
import app.disastermesh.protocol.PayloadType
import app.disastermesh.protocol.ReportPoint
import app.disastermesh.protocol.WitnessDraft
import app.disastermesh.protocol.batteryBucket
import app.disastermesh.protocol.bytesToHex
import app.disastermesh.protocol.confirmWitness
import app.disastermesh.protocol.deliveryLabel
import app.disastermesh.protocol.draftWitness
import app.disastermesh.protocol.encodeHeardDigest
import app.disastermesh.protocol.encodePacket
import app.disastermesh.protocol.estimateFragments
import app.disastermesh.protocol.extractReport
import app.disastermesh.protocol.localModelStatus
import app.disastermesh.protocol.officeKitStatus
import app.disastermesh.protocol.proximityDecision
import app.disastermesh.protocol.scarceSlotGate
import app.disastermesh.protocol.sha256Hex
import app.disastermesh.protocol.statusJson
import app.disastermesh.protocol.statusOrUnknown
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import java.security.SecureRandom
import java.util.UUID

sealed class Screen {
    data object Home : Screen()
    data object NeedHelp : Screen()
    data object Safe : Screen()
    data object Evacuating : Screen()
    data object Report : Screen()
    data object Find : Screen()
    data object Sos : Screen()
    data object Mesh : Screen()
    data object Groups : Screen()
    data object Alerts : Screen()
    data object Reports : Screen()
    data object Messages : Screen()
    data object Contacts : Screen()
    data object Settings : Screen()
    data object Rescue : Screen()
    data object Capability : Screen()
    data object Location : Screen()
    data object Witness : Screen()
}

class DeskViewModel(app: Application) : AndroidViewModel(app) {
    private val dm = app as DisasterMeshApp
    private val _screen = MutableStateFlow<Screen>(Screen.Home)
    val screen: StateFlow<Screen> = _screen
    private val _tick = MutableStateFlow(0)
    val tick: StateFlow<Int> = _tick
    var speechNote: String = ""
    var lastExtraction: String = ""
    var witnessNote: String = "No draft yet. If speech or a model is unavailable, use the manual form."
    var witnessDraft: String = ""
    private var pendingDraft: WitnessDraft? = null
    private var pendingEvidence: ByteArray? = null
    private var evidencePath: String? = null
    private var tiltDeg: Double? = null

    fun go(screen: Screen) { _screen.value = screen; refresh() }
    fun back() = go(Screen.Home)
    fun refresh() { _tick.value += 1 }

    fun lang(): String = dm.store.setting("lang", "en")
    fun t(key: String): String = copy(lang(), key)

    fun reports() = dm.store.reports()
    fun currentStatus(): String = statusOrUnknown(reports().firstOrNull { !it.cancelled }?.state)
    fun peers() = dm.mesh.peerCount()
    fun lastSync(): String = dm.store.setting("last_sync").ifBlank { "never" }
    fun battery(): Int? {
        val bm = getApplication<Application>().getSystemService(BatteryManager::class.java) ?: return null
        val level = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        return if (level < 0) null else level
    }

    fun location(activity: ComponentActivity): Location? {
        val fine = ContextCompat.checkSelfPermission(activity, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        if (!fine) return null
        val lm = activity.getSystemService(LocationManager::class.java) ?: return null
        val providers = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
        return providers.mapNotNull { runCatching { lm.getLastKnownLocation(it) }.getOrNull() }.maxByOrNull { it.time }
    }

    fun sendStatus(kind: String, state: String, type: String, people: Int?, injury: String?, mobility: String?, vulnerable: Int?, text: String?, dest: String?, groupSize: Int?, lat: Double?, lon: Double?, accuracy: Float?, photo: String?) {
        val now = System.currentTimeMillis()
        val priority = when {
            kind == "sos" -> 0
            state == "need_help" && injury == "critical" -> 0
            state == "need_help" -> 1
            state == "evacuating" -> 2
            state == "safe" -> 3
            else -> 4
        }
        val messageId = random(16)
        val origin = hexToBytes(dm.store.setting("origin").ifBlank { bytesToHex(random(16)) }.padEnd(32, '0').take(32))
        val incident = random(16)
        val payload = statusJson(type, state, people, injury, mobility, vulnerable, text, lang(), dest, groupSize)
        val fix = if (lat != null && lon != null) LocationFix((lat * 1e7).toInt(), (lon * 1e7).toInt(), (accuracy ?: 0f).toInt().coerceIn(0, 65535), 0) else null
        val raw = encodePacket(
            PacketDraft(priority = priority, payloadType = if (kind == "sos") PayloadType.SOS else if (kind == "disaster") PayloadType.DISASTER_REPORT else PayloadType.STATUS, messageId = messageId, originPseudonym = origin, incidentId = incident, eventTimestampMs = now, expiryTimestampMs = now + 6 * 3600_000, nonce = random(12), payload = payload, location = fix),
            dm.identity,
        )
        val id = UUID.randomUUID().toString()
        dm.store.insertReport(
            ReportRow(id, bytesToHex(messageId), kind, state, priority, people, text, lat, lon, accuracy?.toInt(), now, DeliveryState.QUEUED_OFFLINE.name.lowercase(), deliveryLabel(DeliveryState.QUEUED_OFFLINE), photo, false, type),
            bytesToHex(raw),
        )
        dm.mesh.enqueueAndTry(id, raw, priority, battery())
        refresh()
    }

    fun cancel(id: String) { dm.store.cancel(id); refresh() }
    fun extract(text: String) { lastExtraction = extractReport(text).let { "${it.incidentType} / ${it.claimedState} / people=${it.peopleCount ?: "?"} / p${it.suggestedPriority} / confidence ${it.confidence}. Confirm before send. ${it.notes.first()}" }; refresh() }

    fun nearby(activity: ComponentActivity): List<String> {
        val here = location(activity) ?: return listOf("Location unavailable. Enter a place manually. BLE neighbors are not treated as people nearby.")
        return reports().filter { !it.cancelled && it.lat != null }.map { row ->
            val decision = proximityDecision(
                ReportPoint("me", row.incidentType, System.currentTimeMillis(), here.latitude, here.longitude, here.accuracy.toDouble()),
                ReportPoint(row.id, row.incidentType, row.eventTime, row.lat, row.lon, row.accuracyM?.toDouble()),
            )
            "${row.incidentType} ${row.state}: ${decision.reason} (${decision.distanceM?.toInt() ?: "?"} m). Not proof a responder is coming."
        }.ifEmpty { listOf("No local reports in range.") }
    }

    fun groups(): List<String> {
        val rows = reports().filter { !it.cancelled && it.lat != null }
        if (rows.size < 2) return listOf("No group. One report is not a group, and missing location stays UNKNOWN.")
        val lines = mutableListOf<String>()
        for (i in rows.indices) for (j in i + 1 until rows.size) {
            val d = proximityDecision(
                ReportPoint(rows[i].id, rows[i].incidentType, rows[i].eventTime, rows[i].lat, rows[i].lon, rows[i].accuracyM?.toDouble()),
                ReportPoint(rows[j].id, rows[j].incidentType, rows[j].eventTime, rows[j].lat, rows[j].lon, rows[j].accuracyM?.toDouble()),
            )
            if (d.cluster) lines += "Possible group ${rows[i].incidentType}: confidence ${d.confidence}. Individual reports kept."
        }
        return lines.ifEmpty { listOf("No pair met the conservative 150 m rule.") }
    }

    fun addContact(name: String, phone: String) { dm.store.addContact(UUID.randomUUID().toString(), name, phone); refresh() }
    fun contacts() = dm.store.contacts()
    fun deleteContact(id: String) { dm.store.deleteContact(id); refresh() }
    fun messages() = dm.store.messages()
    fun sendMessage(body: String) {
        dm.store.addMessage(UUID.randomUUID().toString(), body, "out", System.currentTimeMillis(), DeliveryState.QUEUED_OFFLINE.name.lowercase())
        refresh()
    }
    fun setLang(lang: String) { dm.store.putSetting("lang", lang); refresh() }
    fun toggleRelay() { dm.store.putSetting("relay_enabled", if (dm.store.setting("relay_enabled", "1") == "1") "0" else "1"); refresh() }
    fun relayOn() = dm.store.setting("relay_enabled", "1") == "1"
    fun setGateway(url: String) { dm.store.putSetting("gateway_url", url); refresh() }
    fun gateway() = dm.store.setting("gateway_url")
    fun enableLabLoopback() { dm.store.putSetting("lab_loopback", "1"); refresh() }
    fun labOn() = dm.store.setting("lab_loopback") == "1"
    fun wipe() { dm.store.wipe(); refresh() }
    fun export() = dm.store.exportJson()
    fun probe() = dm.mesh.probe()
    fun wifiNote() = dm.mesh.wifiDirectStatus()
    fun meshError() = dm.mesh.lastError
    fun startListen(activity: ComponentActivity) {
        if (!SpeechRecognizer.isRecognitionAvailable(activity)) {
            speechNote = "Offline speech recognition is unavailable on this device. Type the report."
            refresh(); return
        }
        val recognizer = SpeechRecognizer.createSpeechRecognizer(activity)
        recognizer.setRecognitionListener(object : RecognitionListener {
            override fun onResults(results: android.os.Bundle?) {
                val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
                speechNote = text ?: "No transcript returned. Type the report."
                if (text != null) extract(text)
            }
            override fun onError(error: Int) {
                speechNote = "Speech error $error. If this device has no offline recognizer, type the report. No transcript was invented."
                refresh()
            }
            override fun onReadyForSpeech(params: android.os.Bundle?) {}
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onPartialResults(partialResults: android.os.Bundle?) {}
            override fun onEvent(eventType: Int, params: android.os.Bundle?) {}
        })
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, if (lang() == "hi") "hi-IN" else if (lang() == "mr") "mr-IN" else "en-IN")
        }
        recognizer.startListening(intent)
    }

    fun dial112(activity: ComponentActivity): String {
        if (!activity.packageManager.hasSystemFeature(PackageManager.FEATURE_TELEPHONY)) return "Telephony unavailable. 112 was not dialed."
        val intent = Intent(Intent.ACTION_DIAL, Uri.parse("tel:112"))
        return if (intent.resolveActivity(activity.packageManager) == null) "No dialer installed. 112 was not dialed."
        else { activity.startActivity(intent); "Opened the dialer for 112. You must confirm the call. This is not a mesh delivery." }
    }

    fun openMap(activity: ComponentActivity, lat: Double, lon: Double): String {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("geo:$lat,$lon?q=$lat,$lon(Emergency)"))
        return if (intent.resolveActivity(activity.packageManager) == null) "No mapping app installed."
        else { activity.startActivity(intent); "Handed to an installed mapping app. Route quality is that app's, not ours." }
    }

    fun loginResponder(email: String, password: String) {
        viewModelScope.launch {
            val base = gateway().trim().trimEnd('/')
            if (base.isEmpty()) { speechNote = "Set a command-center URL first. Civilian mode cannot become a responder locally."; refresh(); return@launch }
            // Network call stays off the main thread.
            kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                runCatching {
                    val conn = java.net.URL("$base/api/v1/auth/login").openConnection() as java.net.HttpURLConnection
                    conn.requestMethod = "POST"
                    conn.doOutput = true
                    conn.setRequestProperty("content-type", "application/json")
                    conn.outputStream.use { it.write("""{"email":"$email","password":"$password"}""".encodeToByteArray()) }
                    val code = conn.responseCode
                    val body = (if (code in 200..299) conn.inputStream else conn.errorStream)?.readBytes()?.decodeToString().orEmpty()
                    if (code !in 200..299) speechNote = "Responder login failed. An ordinary account is not an authority."
                    else {
                        val token = org.json.JSONObject(body).optString("token")
                        val role = org.json.JSONObject(body).getJSONObject("user").optString("role")
                        if (role != "responder" && role != "admin" && role != "operator") speechNote = "This account cannot access rescue mode."
                        else {
                            val encrypted = dm.identity.encrypt(getApplication(), token.encodeToByteArray())
                            if (encrypted == null) speechNote = "Could not store the responder token in Android Keystore. Rescue mode was not unlocked."
                            else {
                                dm.store.putSetting("responder_token", android.util.Base64.encodeToString(encrypted, android.util.Base64.NO_WRAP))
                                dm.store.putSetting("responder_role", role)
                                speechNote = "Rescue mode unlocked for $role. Offline updates still sync later. This is not a rescue promise."
                            }
                        }
                    }
                }.onFailure { speechNote = it.message ?: "Login failed" }
            }
            refresh()
        }
    }

    fun responderUnlocked(): Boolean = dm.store.setting("responder_token").isNotBlank()

    fun inferenceStatus(): String = localModelStatus(false, false)

    fun noteTilt(value: Double?) {
        tiltDeg = value
        witnessNote = if (value == null) "IMU returned no sample. Tilt was not invented." else "IMU tilt ${"%.1f".format(value)} degrees over about 2 seconds. This is not a location."
        refresh()
    }

    fun attachEvidence(bytes: ByteArray, path: String? = null) {
        if (bytes.isEmpty()) {
            witnessNote = "Evidence file was empty. Nothing was hashed."
            refresh()
            return
        }
        pendingEvidence = bytes
        evidencePath = path ?: saveEvidence(bytes, "still.jpg")
        witnessNote = "Local evidence hashed ${sha256Hex(bytes)}. The original stays on this phone and is not placed on the mesh."
        refresh()
    }

    fun draftFromCapture(transcript: String, lat: Double?, lon: Double?, accuracy: Float?) {
        val status = inferenceStatus()
        val drafted = draftWitness(transcript, status, tiltDeg)
        if (drafted is EdgeResult.Fail) {
            pendingDraft = null
            witnessDraft = ""
            witnessNote = "MODEL_UNAVAILABLE. No usable transcript. Use the manual form. Nothing was signed and nobody was marked SAFE."
            refresh()
            return
        }
        val draft = (drafted as EdgeResult.Ok).value
        pendingDraft = draft
        val hash = pendingEvidence?.let { sha256Hex(it) } ?: "none"
        val place = if (lat == null || lon == null) "location unavailable" else "$lat, $lon ± ${accuracy ?: 0f} m"
        witnessDraft = "Draft only. ${draft.incidentType} / ${draft.claimedState} / people ${draft.peopleCount ?: "unstated"} / water ${draft.waterlineBand} / confidence ${draft.confidence} / ${draft.inference}. $place. Evidence hash $hash. Media is not in this draft."
        witnessNote = "Confirm or edit before this becomes a signed DMSP/1 message. The draft cannot assign rescue or declare another person SAFE."
        refresh()
    }

    fun editDraft(text: String) {
        val current = pendingDraft
        if (current == null) {
            draftFromCapture(text, null, null, null)
            return
        }
        pendingDraft = current.copy(sourceText = text.take(120))
        witnessNote = "Edited locally. Still a draft. Not signed."
        refresh()
    }

    fun confirmWitnessSend(lat: Double?, lon: Double?, accuracy: Float?) {
        lastLon = lon
        val draft = pendingDraft
        if (draft == null) {
            witnessNote = "No draft to confirm. Use the manual form."
            refresh()
            return
        }
        val confirmed = confirmWitness(draft, true, pendingEvidence)
        if (confirmed is EdgeResult.Fail) {
            witnessNote = confirmed.error
            refresh()
            return
        }
        val payload = (confirmed as EdgeResult.Ok).value
        val origin = originHex()
        val priority = if (draft.lifeThreat) 0 else if (draft.claimedState == "need_help") 1 else 3
        val fact = GateFact(origin, draft.incidentType, draft.claimedState, draft.peopleCount, draft.waterlineBand, draft.lifeThreat, priority, draft.sourceText)
        val prior = lastFact()
        val queued = reports().any { it.kind == "witness" && it.delivery == "queued_offline" && !it.cancelled }
        val decision = scarceSlotGate(fact, if (queued && prior != null) listOf(prior) else emptyList(), if (!queued && prior != null) listOf(prior) else emptyList(), battery(), estimateFragments(payload.size))
        rememberFact(fact)
        dm.store.putSetting("last_gate", "${decision.decision}|${decision.reason}|${decision.fragmentsSaved}|${decision.newFields.joinToString(",")}")
        queuePacket(PayloadType.SCARCE_SLOT_DECISION, gatePayload(decision), 4, "gate", decision.decision, null, null, null, null)
        if (decision.decision == "defer") {
            witnessNote = "DEFERRED: ${decision.reason}. New fields: ${decision.newFields.ifEmpty { listOf("none") }.joinToString()}. Fragments not sent: ${decision.fragmentsSaved}. The draft was not signed onto the mesh."
            refresh()
            return
        }
        if (decision.decision == "replace_previous") {
            reports().filter { it.kind == "witness" && it.delivery == "queued_offline" }.forEach { dm.store.dropQueued(it.id, it.messageId) }
        }
        val id = queuePacket(PayloadType.WITNESS_DELTA, payload, priority, "witness", draft.claimedState, draft.peopleCount, draft.sourceText, lat, accuracy, evidencePath, draft.incidentType)
        witnessNote = "${decision.decision.uppercase()}: ${decision.reason}. Fields ${decision.newFields.joinToString().ifBlank { "new report" }}. ${reports().firstOrNull { it.id == id }?.detail ?: "Queued offline."} Hash ${confirmed.hash ?: "none"}. Original media was not attached to the packet."
        pendingDraft = null
        refresh()
    }

    fun heardText(): String {
        val ids = dm.store.setting("heard_ids").split(",").filter { it.length == 32 }
        val encoded = encodeHeardDigest(HeardSet(System.currentTimeMillis(), batteryBucket(battery()), ids.take(8), reports().firstOrNull { it.delivery == "queued_offline" }?.messageId))
        val body = if (encoded is EdgeResult.Ok) "Heard-cut ready: ${ids.size} pseudonyms, battery ${batteryBucket(battery())}. No phone numbers and no coverage map." else "Heard-cut not queued: ${(encoded as EdgeResult.Fail).error}"
        return "UNHEARD ≠ SAFE\n$body\nA missing id is UNHEARD. It is not SAFE, MISSING, or DEAD.\nLast gate: ${dm.store.setting("last_gate").ifBlank { "none" }}"
    }

    fun queueHeardCut(): String {
        val ids = dm.store.setting("heard_ids").split(",").filter { it.length == 32 }.take(8)
        val held = reports().firstOrNull { it.delivery == "queued_offline" }?.messageId
        val encoded = encodeHeardDigest(HeardSet(System.currentTimeMillis(), batteryBucket(battery()), ids, held))
        if (encoded is EdgeResult.Fail) return encoded.error
        queuePacket(PayloadType.HEARD_DIGEST, (encoded as EdgeResult.Ok).value, 4, "heard", "unknown", null, "heard-cut", null, null, null, "other")
        refresh()
        return "Heard-cut signed and queued. UNHEARD ≠ SAFE. This is not a coverage map."
    }

    fun shareLocalEvidence(activity: ComponentActivity): String {
        val path = evidencePath ?: reports().firstOrNull { it.photoPath != null }?.photoPath
        val file = path?.let { java.io.File(it) }?.takeIf { it.exists() }
        val status = officeKitStatus(false)
        if (file == null) return "No local media to share. Office Kit is ${status.first}. The mesh was not given the original."
        val uri = androidx.core.content.FileProvider.getUriForFile(activity, "app.disastermesh.files", file)
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "application/octet-stream"
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        val chooser = Intent.createChooser(intent, "Share local evidence")
        return if (chooser.resolveActivity(activity.packageManager) == null) {
            "No share target installed. Office Kit is ${status.first}. Media stayed on this phone."
        } else {
            activity.startActivity(chooser)
            "Opened the Android share sheet. Office Kit is ${status.first}; this is ${status.second}, not an Office Kit transfer."
        }
    }

    private fun queuePacket(type: PayloadType, payload: ByteArray, priority: Int, kind: String, state: String, people: Int?, text: String?, lat: Double?, accuracy: Float?, photo: String? = null, incidentType: String = "other"): String {
        val now = System.currentTimeMillis()
        val messageId = random(16)
        val origin = hexToBytes(originHex())
        val location = if (lat != null) {
            val lon = lastLon
            if (lon == null) null else LocationFix((lat * 1e7).toInt(), (lon * 1e7).toInt(), (accuracy ?: 0f).toInt().coerceIn(0, 65535), 0)
        } else null
        val raw = encodePacket(PacketDraft(priority = priority, payloadType = type, messageId = messageId, originPseudonym = origin, incidentId = random(16), eventTimestampMs = now, expiryTimestampMs = now + 6 * 3600_000, nonce = random(12), payload = payload, location = location), dm.identity)
        val id = UUID.randomUUID().toString()
        dm.store.insertReport(ReportRow(id, bytesToHex(messageId), kind, state, priority, people, text, lat, lastLon, accuracy?.toInt(), now, DeliveryState.QUEUED_OFFLINE.name.lowercase(), deliveryLabel(DeliveryState.QUEUED_OFFLINE), photo, false, incidentType), bytesToHex(raw))
        dm.mesh.enqueueAndTry(id, raw, priority, battery())
        return id
    }

    private var lastLon: Double? = null

    fun rememberPlace(lat: Double?, lon: Double?) { lastLon = lon; if (lat == null) lastLon = null }

    private fun originHex(): String {
        val existing = dm.store.setting("origin")
        if (existing.length == 32 && existing.all { it in '0'..'9' || it in 'a'..'f' }) return existing
        val created = bytesToHex(random(16))
        dm.store.putSetting("origin", created)
        return created
    }

    private fun rememberFact(fact: GateFact) {
        dm.store.putSetting("last_witness_fact", listOf(fact.origin, fact.incidentType, fact.claimedState, fact.peopleCount?.toString() ?: "", fact.waterlineBand, fact.lifeThreat.toString(), fact.priority.toString(), fact.text.replace("\u001f", " ")).joinToString("\u001f"))
    }

    private fun lastFact(): GateFact? {
        val parts = dm.store.setting("last_witness_fact").split("\u001f")
        if (parts.size < 8) return null
        return GateFact(parts[0], parts[1], parts[2], parts[3].toIntOrNull(), parts[4], parts[5] == "true", parts[6].toIntOrNull() ?: 4, parts[7])
    }

    private fun gatePayload(decision: app.disastermesh.protocol.GateDecision): ByteArray {
        val fields = decision.newFields.joinToString(",") { "\"${it.filter { ch -> ch.isLetter() || ch == '_' }}\"" }
        return "{\"k\":\"gs\",\"d\":\"${decision.decision}\",\"r\":\"${decision.reason.take(40)}\",\"nf\":[$fields],\"fs\":${decision.fragmentsSaved}}".toByteArray(Charsets.UTF_8)
    }

    private fun saveEvidence(bytes: ByteArray, name: String): String {
        val dir = java.io.File(getApplication<Application>().filesDir, "evidence").apply { mkdirs() }
        val file = java.io.File(dir, name)
        file.writeBytes(bytes)
        return file.absolutePath
    }

    private fun random(n: Int) = ByteArray(n).also { SecureRandom().nextBytes(it) }
    private fun hexToBytes(hex: String) = app.disastermesh.protocol.hexToBytes(hex)
}

fun copy(lang: String, key: String): String {
    val en = mapOf(
        "title" to "DISASTERMESH",
        "need" to "NEED HELP NOW",
        "safe" to "I'M SAFE",
        "evac" to "EVACUATING",
        "report" to "REPORT DISASTER",
        "find" to "FIND NEARBY HELP",
        "sos" to "EMERGENCY SOS",
        "disclaimer" to "Prototype. Not a certified emergency service. No rescue is guaranteed.",
        "status" to "My emergency status",
        "groups" to "Nearby emergency groups",
        "alerts" to "Local alerts",
        "reports" to "My reports",
        "mesh" to "Mesh network",
        "location" to "Last known location",
        "messages" to "Offline messages",
        "contacts" to "Emergency contacts",
        "language" to "Accessibility and language",
        "settings" to "Settings",
        "rescue" to "Rescue team mode",
        "send" to "SEND EMERGENCY REPORT",
        "not_reached" to "This report has NOT reached rescuers.",
        "witness" to "WITNESS DRAFT",
    )
    val hi = mapOf(
        "title" to "DISASTERMESH",
        "need" to "अभी मदद चाहिए",
        "safe" to "मैं सुरक्षित हूँ",
        "evac" to "निकासी जारी है",
        "report" to "आपदा की सूचना दें",
        "find" to "आस-पास मदद खोजें",
        "sos" to "आपातकालीन SOS",
        "disclaimer" to "प्रोटोटाइप। प्रमाणित आपातकालीन सेवा नहीं। बचाव की गारंटी नहीं।",
        "status" to "मेरी आपात स्थिति",
        "groups" to "आस-पास के आपात समूह",
        "alerts" to "स्थानीय चेतावनियाँ",
        "reports" to "मेरी रिपोर्ट",
        "mesh" to "मेश नेटवर्क",
        "location" to "अंतिम ज्ञात स्थान",
        "messages" to "ऑफ़लाइन संदेश",
        "contacts" to "आपात संपर्क",
        "language" to "पहुँच और भाषा",
        "settings" to "सेटिंग्स",
        "rescue" to "रेस्क्यू टीम मोड",
        "send" to "आपात रिपोर्ट भेजें",
        "not_reached" to "यह रिपोर्ट बचाव दल तक नहीं पहुँची है।",
        "witness" to "गवाह मसौदा",
    )
    val mr = mapOf(
        "title" to "DISASTERMESH",
        "need" to "आत्ता मदत हवी",
        "safe" to "मी सुरक्षित आहे",
        "evac" to "स्थलांतर सुरू आहे",
        "report" to "आपत्तीची माहिती द्या",
        "find" to "जवळची मदत शोधा",
        "sos" to "आणीबाणी SOS",
        "disclaimer" to "प्रायोगिक आवृत्ती. प्रमाणित आपत्कालीन सेवा नाही. बचावाची हमी नाही.",
        "status" to "माझी आपत्स्थिती",
        "groups" to "जवळचे आपत् समूह",
        "alerts" to "स्थानिक सूचना",
        "reports" to "माझे अहवाल",
        "mesh" to "मेश नेटवर्क",
        "location" to "शेवटचे ज्ञात ठिकाण",
        "messages" to "ऑफलाइन संदेश",
        "contacts" to "आपत् संपर्क",
        "language" to "सुगमता आणि भाषा",
        "settings" to "सेटिंग्ज",
        "rescue" to "बचाव पथक मोड",
        "send" to "आपत् अहवाल पाठवा",
        "not_reached" to "ही माहिती बचावकर्त्यांपर्यंत पोहोचलेली नाही.",
        "witness" to "साक्षी मसुदा",
    )
    val table = when (lang) { "hi" -> hi; "mr" -> mr; else -> en }
    return table[key] ?: en[key] ?: key
}
