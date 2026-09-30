package app.disastermesh.protocol

import java.security.MessageDigest
import java.util.Locale

sealed class EdgeResult<out T> {
    data class Ok<T>(val value: T) : EdgeResult<T>()
    data class Fail(val error: String) : EdgeResult<Nothing>()
}

data class WitnessDraft(
    val incidentType: String,
    val claimedState: String,
    val peopleCount: Int?,
    val language: String,
    val waterlineBand: String,
    val tiltDeg: Double?,
    val confidence: Double,
    val evidenceHash: String?,
    val inference: String,
    val selfConflict: Boolean,
    val lifeThreat: Boolean,
    val sourceText: String,
    val requiresUserConfirmation: Boolean = true,
    val model: String,
)

data class GateFact(
    val origin: String,
    val incidentType: String,
    val claimedState: String,
    val peopleCount: Int?,
    val waterlineBand: String,
    val lifeThreat: Boolean,
    val priority: Int,
    val text: String,
)

data class GateDecision(val decision: String, val reason: String, val newFields: List<String>, val fragmentsSaved: Int)
data class HeardSet(val windowStartMs: Long, val batteryBucket: String, val pseudonyms: List<String>, val heldMessageId: String?)

fun sha256Hex(bytes: ByteArray): String = bytesToHex(MessageDigest.getInstance("SHA-256").digest(bytes))
fun estimateFragments(payloadBytes: Int): Int = maxOf(1, kotlin.math.ceil((246 + payloadBytes) / 160.0).toInt())
fun batteryBucket(percent: Int?): String = when {
    percent == null -> "unknown"
    percent < 15 -> "low"
    percent < 50 -> "mid"
    else -> "high"
}

fun localModelStatus(modelFilePresent: Boolean, npuDelegateLoaded: Boolean): String = when {
    npuDelegateLoaded -> "NPU"
    modelFilePresent -> "CPU_FALLBACK"
    else -> "MODEL_UNAVAILABLE"
}

fun draftWitness(transcript: String?, modelStatus: String, tiltDeg: Double? = null, frameCue: String? = null, modelName: String? = null): EdgeResult<WitnessDraft> {
    val text = transcript?.trim().orEmpty()
    if (text.isEmpty() || (modelStatus == "NPU" && modelName == null)) return EdgeResult.Fail("manual_form_required")
    val extracted = extractReport(text)
    val trapped = Regex("फंस|फँस|trapped|stuck|अडक", RegexOption.IGNORE_CASE).containsMatchIn(text)
    val claimed = if (extracted.claimedState == "unknown" && trapped) "need_help" else extracted.claimedState
    val band = when {
        listOf("chest", "door", "छाती", "दरवाज", "उरा").any { text.contains(it, ignoreCase = true) } -> "high"
        listOf("knee", "waist", "घुटना", "कमर", "गुडघा").any { text.contains(it, ignoreCase = true) } -> "mid"
        listOf("ankle", "feet", "foot", "टखना", "पाय", "पैर").any { text.contains(it, ignoreCase = true) } -> "low"
        else -> "unknown"
    }
    val conflict = (extracted.incidentType == "flood" || band != "unknown") && frameCue == "no_water_cue"
    var confidence = minOf(0.99, extracted.confidence)
    if (conflict) confidence = minOf(confidence, 0.49)
    if (modelStatus == "MODEL_UNAVAILABLE") confidence = minOf(confidence, 0.74)
    return EdgeResult.Ok(WitnessDraft(
        extracted.incidentType, claimed, extracted.peopleCount, extracted.languageHint, band, tiltDeg, confidence,
        null, modelStatus, conflict, extracted.suggestedPriority == 0, text.take(120), true,
        modelName ?: if (modelStatus == "MODEL_UNAVAILABLE") "deterministic-rules-v1" else "local-rules",
    ))
}

fun confirmWitness(draft: WitnessDraft, confirmed: Boolean, evidence: ByteArray? = null): EdgeResult<ByteArray> {
    if (!confirmed) return EdgeResult.Fail("user_confirmation_required")
    if (draft.confidence >= 1.0) return EdgeResult.Fail("confidence_must_stay_below_one")
    var hash = draft.evidenceHash
    if (evidence != null && evidence.isNotEmpty()) {
        val actual = sha256Hex(evidence)
        if (hash != null && hash != actual) return EdgeResult.Fail("evidence_hash_mismatch")
        hash = actual
    }
    val compact = witnessJson(draft, hash)
    if (compact.toByteArray(Charsets.UTF_8).size > MAX_PAYLOAD) return EdgeResult.Fail("witness payload too large")
    return if (parseWitness(compact) is EdgeResult.Fail) EdgeResult.Fail("bad witness") else EdgeResult.Ok(compact.toByteArray(Charsets.UTF_8))
}

fun parseWitness(json: String): EdgeResult<Unit> {
    if (json.length > MAX_PAYLOAD) return EdgeResult.Fail("witness payload too large")
    if (json.contains("\"official\"") || json.contains("\"assign\"") || json.contains("\"teamId\"")) return EdgeResult.Fail("model_output_rejected")
    if (!json.contains("\"k\":\"wd\"")) return EdgeResult.Fail("not_a_witness_delta")
    return EdgeResult.Ok(Unit)
}

fun scarceSlotGate(fact: GateFact, outbox: List<GateFact>, heard: List<GateFact>, batteryPercent: Int?, fragmentCount: Int): GateDecision {
    val prior = (outbox + heard).lastOrNull { it.origin == fact.origin }
    val fields = if (prior == null) listOf("incidentType", "claimedState") else newFields(prior, fact)
    val life = fact.lifeThreat || fact.priority == 0
    if (prior == null) return GateDecision("admit", "new_fact", fields, 0)
    if (fields.isEmpty()) return GateDecision("defer", "no_new_fact", emptyList(), fragmentCount)
    if (!life && fact.priority >= 3 && batteryPercent != null && batteryPercent < 15) return GateDecision("defer", "battery_low_routine", fields, fragmentCount)
    if (outbox.any { it.origin == fact.origin }) return GateDecision("replace_previous", "new_fact_replaces_unsent", fields, maxOf(0, fragmentCount - 1))
    return GateDecision("admit", "new_fact", fields, 0)
}

fun encodeHeardDigest(set: HeardSet): EdgeResult<ByteArray> {
    if (set.pseudonyms.size > 8) return EdgeResult.Fail("too_many_heard_ids")
    if (set.pseudonyms.any { !it.matches(Regex("^[0-9a-fA-F]{32}$")) }) return EdgeResult.Fail("pseudonym_required")
    if (set.batteryBucket !in setOf("unknown", "low", "mid", "high")) return EdgeResult.Fail("bad battery bucket")
    val json = buildString {
        append("{\"k\":\"hd\",\"win\":").append(set.windowStartMs).append(",\"bat\":\"").append(set.batteryBucket).append("\",\"ids\":[")
        append(set.pseudonyms.joinToString(",") { "\"${it.lowercase()}\"" })
        append("],\"hold\":").append(if (set.heldMessageId == null) "null" else "\"${set.heldMessageId}\"").append("}")
    }
    return EdgeResult.Ok(json.toByteArray(Charsets.UTF_8))
}

fun classifyUnheard(digests: List<Pair<Long, List<String>>>, nowMs: Long, windowMs: Long = 600_000): List<Triple<String, String, Boolean>> {
    val current = mutableSetOf<String>()
    val previous = mutableSetOf<String>()
    for ((at, ids) in digests) (if (at >= nowMs - windowMs) current else previous).addAll(ids)
    return previous.filter { it !in current }.map { Triple(it, "UNHEARD", false) }
}

fun verifyEvidence(bytes: ByteArray, expectedHash: String): Pair<Boolean, String> {
    if (!expectedHash.matches(Regex("^[0-9a-fA-F]{64}$"))) return false to "bad_hash"
    return if (sha256Hex(bytes) == expectedHash.lowercase()) true to "hash_matches" else false to "corrupt_evidence"
}

fun authorizeEvidenceRequest(role: String, explicit: Boolean): Pair<Boolean, String> {
    if (!explicit) return false to "explicit_request_required"
    if (role != "admin" && role != "operator") return false to "unauthorized"
    return true to "operator_requested"
}

fun officeKitStatus(sdkPresent: Boolean): Pair<String, String> = if (!sdkPresent) "UNAVAILABLE" to "os_share" else "UNVERIFIED" to "office_kit"

private fun newFields(prior: GateFact, next: GateFact): List<String> {
    val fields = mutableListOf<String>()
    if (prior.claimedState != next.claimedState) fields += "claimedState"
    if (prior.peopleCount != next.peopleCount) fields += "peopleCount"
    if (prior.waterlineBand != next.waterlineBand) fields += "waterlineBand"
    if (!prior.lifeThreat && next.lifeThreat) fields += "lifeThreat"
    if (prior.incidentType != next.incidentType) fields += "incidentType"
    if (prior.text.trim().lowercase() != next.text.trim().lowercase()) fields += "text"
    return fields
}

private fun witnessJson(draft: WitnessDraft, hash: String?): String = buildString {
    append("{\"k\":\"wd\",\"t\":\"").append(jsonEscape(draft.incidentType))
    append("\",\"s\":\"").append(jsonEscape(draft.claimedState))
    append("\",\"n\":").append(draft.peopleCount?.toString() ?: "null")
    if (draft.language == "en" || draft.language == "hi" || draft.language == "mr") append(",\"lang\":\"").append(draft.language).append("\"")
    append(",\"wb\":\"").append(draft.waterlineBand)
    append("\",\"tilt\":").append(draft.tiltDeg?.let { String.format(Locale.US, "%.1f", it) } ?: "null")
    append(",\"c\":").append(String.format(Locale.US, "%.2f", draft.confidence))
    append(",\"eh\":").append(if (hash == null) "null" else "\"$hash\"")
    append(",\"inf\":\"").append(draft.inference)
    append("\",\"cf\":").append(draft.selfConflict)
    append(",\"lt\":").append(draft.lifeThreat)
    append(",\"txt\":\"").append(jsonEscape(draft.sourceText.take(72)))
    append("\",\"model\":\"").append(jsonEscape(draft.model.take(40)))
    append("\",\"gd\":\"admit\",\"gr\":\"confirmed\",\"fs\":0}")
}

private fun jsonEscape(value: String): String = buildString {
    for (ch in value) when (ch) {
        '\\' -> append("\\\\")
        '"' -> append("\\\"")
        '\n' -> append("\\n")
        else -> append(ch)
    }
}
