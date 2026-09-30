package app.disastermesh.protocol

import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import java.util.Arrays

const val DMSP_VERSION = 1
const val FRAME_VERSION = 1
const val SIGNED_HEADER_LEN = 176
const val SIGNATURE_LEN = 64
const val MAX_PAYLOAD = 512
const val MAX_PACKET = 1400
const val MAX_HOP = 8
const val DEFAULT_HOP_LIMIT = 5
const val MAX_CLOCK_SKEW_MS = 120_000L
const val MAX_TTL_MS = 48L * 60L * 60L * 1000L
const val MAX_TEXT_CHARS = 120
const val GROUP_DISTANCE_M = 150.0
const val GROUP_WINDOW_MS = 30L * 60L * 1000L

object Flag {
    const val HAS_LOCATION = 0x01
    const val HAS_INCIDENT = 0x02
    const val ACK_REQUESTED = 0x08
    const val IS_ACK = 0x10
    const val GATEWAY_ORIGINATED = 0x20
    const val SIMULATED = 0x40
    const val KNOWN = HAS_LOCATION or HAS_INCIDENT or ACK_REQUESTED or IS_ACK or GATEWAY_ORIGINATED or SIMULATED
}

enum class PayloadType(val code: Int) {
    HELLO(1), STATUS(2), DISASTER_REPORT(3), SOS(4), GROUP(5), ALERT(6), ACK(7),
    RESCUE_UPDATE(8), TEXT_MESSAGE(9), PHOTO_META(10), CAPABILITY(11),
    WITNESS_DELTA(12), HEARD_DIGEST(13), EVIDENCE_REQUEST(14), EVIDENCE_RESPONSE(15),
    SCARCE_SLOT_DECISION(16);

    companion object {
        fun from(code: Int): PayloadType? = entries.firstOrNull { it.code == code }
    }
}

enum class DeliveryState {
    QUEUED_OFFLINE, RELAYED_TO_PEER, DELIVERED_TO_GATEWAY, RECEIVED_BY_COMMAND_CENTER,
    ACKNOWLEDGED_BY_OPERATOR, EXPIRED, REJECTED, LAB_LOOPBACK
}

fun deliveryLabel(state: DeliveryState): String = when (state) {
    DeliveryState.QUEUED_OFFLINE -> "Queued offline. Rescuers have NOT received this."
    DeliveryState.RELAYED_TO_PEER -> "Relayed to a nearby phone. This is NOT delivery to rescuers."
    DeliveryState.DELIVERED_TO_GATEWAY -> "A gateway accepted this for upload. Command center has NOT confirmed receipt."
    DeliveryState.RECEIVED_BY_COMMAND_CENTER -> "Command center stored this report. An operator has not necessarily seen it."
    DeliveryState.ACKNOWLEDGED_BY_OPERATOR -> "An operator marked this as seen. This is not a promise of rescue."
    DeliveryState.EXPIRED -> "Expired before delivery."
    DeliveryState.REJECTED -> "Rejected."
    DeliveryState.LAB_LOOPBACK -> "LAB LOOPBACK (simulated). Not a real peer and not a radio test."
}

private val NEXT = mapOf(
    DeliveryState.QUEUED_OFFLINE to setOf(DeliveryState.RELAYED_TO_PEER, DeliveryState.DELIVERED_TO_GATEWAY, DeliveryState.RECEIVED_BY_COMMAND_CENTER, DeliveryState.EXPIRED, DeliveryState.REJECTED, DeliveryState.LAB_LOOPBACK),
    DeliveryState.RELAYED_TO_PEER to setOf(DeliveryState.RELAYED_TO_PEER, DeliveryState.DELIVERED_TO_GATEWAY, DeliveryState.RECEIVED_BY_COMMAND_CENTER, DeliveryState.EXPIRED, DeliveryState.REJECTED),
    DeliveryState.DELIVERED_TO_GATEWAY to setOf(DeliveryState.RECEIVED_BY_COMMAND_CENTER, DeliveryState.QUEUED_OFFLINE, DeliveryState.EXPIRED, DeliveryState.REJECTED),
    DeliveryState.RECEIVED_BY_COMMAND_CENTER to setOf(DeliveryState.ACKNOWLEDGED_BY_OPERATOR),
    DeliveryState.ACKNOWLEDGED_BY_OPERATOR to emptySet(),
    DeliveryState.EXPIRED to emptySet(),
    DeliveryState.REJECTED to emptySet(),
    DeliveryState.LAB_LOOPBACK to setOf(DeliveryState.QUEUED_OFFLINE, DeliveryState.EXPIRED, DeliveryState.REJECTED),
)

fun canTransition(from: DeliveryState, to: DeliveryState): Boolean = NEXT.getValue(from).contains(to)

fun statusOrUnknown(state: String?): String = when (state) {
    "need_help", "safe", "evacuating", "resolved" -> state
    else -> "unknown"
}

data class LocationFix(val latE7: Int, val lonE7: Int, val accuracyM: Int, val ageSec: Int)

data class ParsedPacket(
    val hopLimit: Int,
    val hopCount: Int,
    val relayFlags: Int,
    val flags: Int,
    val priority: Int,
    val payloadType: PayloadType,
    val messageId: ByteArray,
    val originPseudonym: ByteArray,
    val incidentId: ByteArray,
    val eventTimestampMs: Long,
    val expiryTimestampMs: Long,
    val nonce: ByteArray,
    val sequence: Int,
    val payload: ByteArray,
    val location: LocationFix?,
    val publicKey: ByteArray,
    val signerKeyId: ByteArray,
    val simulated: Boolean,
    val signedBlob: ByteArray,
    val signature: ByteArray,
)

sealed class VerifyResult {
    data class Ok(val packet: ParsedPacket) : VerifyResult()
    data class Fail(val error: String) : VerifyResult()
}

fun verifyPacket(bytes: ByteArray, nowMs: Long): VerifyResult {
    if (bytes.size > MAX_PACKET) return VerifyResult.Fail("oversized")
    if (bytes.size < 6 + SIGNED_HEADER_LEN + SIGNATURE_LEN) return VerifyResult.Fail("truncated")
    if (bytes[3].toInt() and 0xff != FRAME_VERSION) return VerifyResult.Fail("bad_frame")
    val hopLimit = bytes[0].toInt() and 0xff
    val hopCount = bytes[1].toInt() and 0xff
    if (hopLimit > MAX_HOP || hopCount > MAX_HOP) return VerifyResult.Fail("bad_hop")
    val signedLen = readU16(bytes, 4)
    if (signedLen < SIGNED_HEADER_LEN || signedLen > SIGNED_HEADER_LEN + MAX_PAYLOAD) return VerifyResult.Fail("bad_frame")
    if (bytes.size != 6 + signedLen + SIGNATURE_LEN) return VerifyResult.Fail("truncated")
    val signed = bytes.copyOfRange(6, 6 + signedLen)
    val signature = bytes.copyOfRange(6 + signedLen, bytes.size)
    if (!signed.copyOfRange(0, 4).contentEquals(byteArrayOf(0x44, 0x4d, 0x53, 0x50))) return VerifyResult.Fail("bad_magic")
    if (signed[4].toInt() and 0xff != DMSP_VERSION) return VerifyResult.Fail("bad_version")
    val flags = signed[5].toInt() and 0xff
    if (flags and Flag.KNOWN.inv() != 0) return VerifyResult.Fail("reserved_nonzero")
    if (signed[175].toInt() != 0) return VerifyResult.Fail("reserved_nonzero")
    val priority = signed[6].toInt() and 0xff
    if (priority > 4) return VerifyResult.Fail("bad_priority")
    val payloadType = PayloadType.from(signed[7].toInt() and 0xff) ?: return VerifyResult.Fail("bad_payload_type")
    val payloadLength = readU16(signed, 8)
    if (payloadLength > MAX_PAYLOAD || SIGNED_HEADER_LEN + payloadLength != signedLen) return VerifyResult.Fail("payload_too_large")
    val publicKey = signed.copyOfRange(102, 167)
    if (publicKey.size != 65 || publicKey[0] != 0x04.toByte()) return VerifyResult.Fail("bad_pubkey")
    val signerKeyId = signed.copyOfRange(167, 175)
    if (!sha256(publicKey).copyOfRange(0, 8).contentEquals(signerKeyId)) return VerifyResult.Fail("bad_key_id")
    if (!verifyP256(signed, signature, publicKey)) return VerifyResult.Fail("bad_signature")
    val eventTs = readU64(signed, 58)
    val expiryTs = readU64(signed, 66)
    if (eventTs > nowMs + MAX_CLOCK_SKEW_MS) return VerifyResult.Fail("not_yet_valid")
    if (expiryTs <= nowMs || eventTs < nowMs - MAX_TTL_MS) return VerifyResult.Fail("expired")
    if (expiryTs > eventTs + MAX_TTL_MS) return VerifyResult.Fail("ttl_too_long")
    val location = if (flags and Flag.HAS_LOCATION != 0) {
        LocationFix(readI32(signed, 90), readI32(signed, 94), readU16(signed, 98), readU16(signed, 100))
    } else null
    if (location == null && (readI32(signed, 90) != 0 || readI32(signed, 94) != 0)) return VerifyResult.Fail("location_invalid")
    if (location != null && (location.latE7 !in -900_000_000..900_000_000 || location.lonE7 !in -1_800_000_000..1_800_000_000)) {
        return VerifyResult.Fail("location_invalid")
    }
    return VerifyResult.Ok(
        ParsedPacket(
            hopLimit, hopCount, bytes[2].toInt() and 0xff, flags, priority, payloadType,
            signed.copyOfRange(10, 26), signed.copyOfRange(26, 42), signed.copyOfRange(42, 58),
            eventTs, expiryTs, signed.copyOfRange(74, 86), readU32(signed, 86),
            signed.copyOfRange(SIGNED_HEADER_LEN, signed.size), location, publicKey, signerKeyId,
            flags and Flag.SIMULATED != 0, signed, signature,
        ),
    )
}

fun withRelayHop(bytes: ByteArray): ByteArray? {
    if (bytes.size < 6 + SIGNED_HEADER_LEN + SIGNATURE_LEN || bytes[3].toInt() and 0xff != FRAME_VERSION) return null
    val hopLimit = bytes[0].toInt() and 0xff
    val hopCount = bytes[1].toInt() and 0xff
    if (hopLimit < 1 || hopCount >= MAX_HOP || hopLimit > MAX_HOP) return null
    val next = bytes.copyOf()
    next[0] = (hopLimit - 1).toByte()
    next[1] = (hopCount + 1).toByte()
    return next
}

fun verifyP256(data: ByteArray, signature: ByteArray, publicKeyRaw: ByteArray): Boolean = try {
    if (signature.size != 64 || publicKeyRaw.size != 65 || publicKeyRaw[0] != 0x04.toByte()) false
    else {
        val sig = Signature.getInstance("SHA256withECDSA")
        sig.initVerify(importUncompressed(publicKeyRaw))
        sig.update(data)
        sig.verify(p1363ToDer(signature))
    }
} catch (_: Exception) {
    false
}

private val ecParams by lazy {
    val kpg = KeyPairGenerator.getInstance("EC")
    kpg.initialize(ECGenParameterSpec("secp256r1"))
    (kpg.generateKeyPair().public as java.security.interfaces.ECPublicKey).params
}

private fun importUncompressed(raw: ByteArray): java.security.PublicKey {
    val x = BigInteger(1, raw.copyOfRange(1, 33))
    val y = BigInteger(1, raw.copyOfRange(33, 65))
    val spec = ECPublicKeySpec(ECPoint(x, y), ecParams)
    return KeyFactory.getInstance("EC").generatePublic(spec)
}

fun p1363ToDer(sig: ByteArray): ByteArray {
    require(sig.size == 64)
    val r = unsignedComponent(sig.copyOfRange(0, 32))
    val s = unsignedComponent(sig.copyOfRange(32, 64))
    val len = 2 + r.size + 2 + s.size
    val out = ByteArray(2 + len)
    out[0] = 0x30
    out[1] = len.toByte()
    var cursor = 2
    out[cursor++] = 0x02
    out[cursor++] = r.size.toByte()
    r.copyInto(out, cursor)
    cursor += r.size
    out[cursor++] = 0x02
    out[cursor++] = s.size.toByte()
    s.copyInto(out, cursor)
    return out
}

private fun unsignedComponent(buf: ByteArray): ByteArray {
    var i = 0
    while (i < buf.size - 1 && buf[i] == 0.toByte()) i++
    val sliced = buf.copyOfRange(i, buf.size)
    return if (sliced[0].toInt() and 0x80 != 0) byteArrayOf(0) + sliced else sliced
}

fun sha256(data: ByteArray): ByteArray = java.security.MessageDigest.getInstance("SHA-256").digest(data)

fun mayRelay(priority: Int, batteryPercent: Int?, relayEnabled: Boolean): Pair<Boolean, String> {
    if (!relayEnabled) return false to "relay_disabled"
    if (batteryPercent == null) return true to "battery_unknown_allow"
    if (batteryPercent < 8) return false to "battery_critical"
    if (batteryPercent < 15 && priority > 1) return false to "battery_low_priority_filtered"
    return true to "ok"
}

data class ReportPoint(
    val id: String,
    val incidentType: String,
    val eventTimestampMs: Long,
    val lat: Double? = null,
    val lon: Double? = null,
    val accuracyM: Double? = null,
)

fun haversineM(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Double {
    val r = 6_371_000.0
    val dLat = Math.toRadians(lat2 - lat1)
    val dLon = Math.toRadians(lon2 - lon1)
    val a = Math.sin(dLat / 2).pow() + Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2)) * Math.sin(dLon / 2).pow()
    return 2 * r * Math.asin(Math.min(1.0, Math.sqrt(a)))
}

private fun Double.pow() = this * this

data class Proximity(val cluster: Boolean, val confidence: String, val reason: String, val distanceM: Double?)

fun proximityDecision(a: ReportPoint, b: ReportPoint): Proximity {
    if (a.incidentType != b.incidentType) return Proximity(false, "unknown", "type_mismatch", null)
    if (kotlin.math.abs(a.eventTimestampMs - b.eventTimestampMs) > GROUP_WINDOW_MS) return Proximity(false, "unknown", "time_window", null)
    if (a.lat == null || a.lon == null || b.lat == null || b.lon == null) return Proximity(false, "unknown", "location_missing", null)
    if (a.accuracyM == null || b.accuracyM == null) return Proximity(false, "unknown", "accuracy_missing", null)
    val distance = haversineM(a.lat, a.lon, b.lat, b.lon)
    if (a.accuracyM > 100 || b.accuracyM > 100) return Proximity(false, "unknown", "accuracy_too_coarse", distance)
    if (distance + a.accuracyM + b.accuracyM <= GROUP_DISTANCE_M) {
        val confidence = if (a.accuracyM <= 30 && b.accuracyM <= 30) "high" else "low"
        return Proximity(true, confidence, "within_conservative_radius", distance)
    }
    return Proximity(false, "unknown", "too_far", distance)
}

data class Extraction(
    val incidentType: String,
    val claimedState: String,
    val peopleCount: Int?,
    val suggestedPriority: Int,
    val priorityRequiresConfirmation: Boolean,
    val confidence: Double,
    val languageHint: String,
    val requiresUserConfirmation: Boolean = true,
    val model: String = "deterministic-rules-v1",
    val notes: List<String>,
)

fun extractReport(raw: String): Extraction {
    val text = raw.replace(Regex("[०-९]")) { "०१२३४५६७८९".indexOf(it.value).toString() }.trim()
    val lower = text.lowercase()
    val type = when {
        listOf("flood", "बाढ़", "बाढ़", "पूर", "पुरामुळे", "पाणी").any { lower.contains(it) || text.contains(it) } -> "flood"
        listOf("earthquake", "भूकंप", "भुकंप").any { lower.contains(it) || text.contains(it) } -> "earthquake"
        listOf("smoke", "धुआं", "धूर").any { lower.contains(it) || text.contains(it) } -> "smoke"
        listOf("fire", "आग").any { lower.contains(it) || text.contains(it) } -> "fire"
        listOf("landslide", "भूस्खलन", "दरड").any { lower.contains(it) || text.contains(it) } -> "landslide"
        listOf("trapped", "अडक", "फंस").any { lower.contains(it) || text.contains(it) } -> "trapped"
        listOf("medical", "injured", "घायल", "जखम").any { lower.contains(it) || text.contains(it) } -> "medical"
        else -> "other"
    }
    val people = Regex("(\\d{1,4})").find(lower)?.groupValues?.get(1)?.toIntOrNull()?.takeIf { it in 1..10000 }
        ?: mapOf("one" to 1, "two" to 2, "three" to 3, "four" to 4, "five" to 5, "एक" to 1, "दो" to 2, "तीन" to 3, "चार" to 4, "दोन" to 2, "पाच" to 5)
            .entries.firstOrNull { text.contains(it.key) && Regex("people|लोक|लोग|जण|व्यक्ती|family").containsMatchIn(text) }?.value
    val life = listOf("unconscious", "not breathing", "बेहोश", "बेशुद्ध", "श्वास नाही").any { lower.contains(it) || text.contains(it) }
    val claimed = when {
        listOf("i am safe", "i'm safe", "मी सुरक्षित", "मैं सुरक्षित").any { lower.contains(it) || text.contains(it) } -> "safe"
        listOf("evacuat", "बाहेर पड").any { lower.contains(it) || text.contains(it) } -> "evacuating"
        life || type == "trapped" || text.contains("मदद") || text.contains("मदत") || lower.contains("need help") -> "need_help"
        else -> "unknown"
    }
    val priority = if (life) 0 else if (claimed == "need_help") 1 else if (claimed == "evacuating") 2 else if (claimed == "safe") 3 else 4
    var confidence = 0.15
    if (type != "other") confidence += 0.25
    if (people != null) confidence += 0.2
    if (claimed != "unknown") confidence += 0.2
    confidence = minOf(0.95, confidence)
    val lang = when {
        text.contains("आहे") || text.contains("हवी") || text.contains("मदत") -> "mr"
        text.any { it.code in 0x0900..0x097F } -> "hi"
        text.any { it.isLetter() && it.code < 128 } -> "en"
        else -> "unknown"
    }
    return Extraction(
        type, claimed, people, priority, life, if (text.isBlank()) 0.0 else confidence, lang,
        notes = listOf(
            "Deterministic rules only. Not a medical or safety determination.",
            "A claimed SAFE status is a self-report, not proof of safety.",
        ),
    )
}

class PriorityScheduler<T> {
    private val queues = mutableMapOf<Int, ArrayDeque<T>>(0 to ArrayDeque(), 1 to ArrayDeque(), 2 to ArrayDeque(), 3 to ArrayDeque(), 4 to ArrayDeque())
    private val pattern = listOf(0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 4)
    private var cursor = 0
    fun enqueue(priority: Int, item: T) { queues.getValue(priority).addLast(item) }
    fun next(): Pair<Int, T>? {
        if (queues.values.all { it.isEmpty() }) return null
        repeat(pattern.size) {
            val priority = pattern[cursor]
            cursor = (cursor + 1) % pattern.size
            val queue = queues.getValue(priority)
            if (queue.isNotEmpty()) return priority to queue.removeFirst()
        }
        return null
    }
}

fun readU16(buf: ByteArray, offset: Int): Int = ((buf[offset].toInt() and 0xff) shl 8) or (buf[offset + 1].toInt() and 0xff)
fun readU32(buf: ByteArray, offset: Int): Int =
    ((buf[offset].toInt() and 0xff) shl 24) or ((buf[offset + 1].toInt() and 0xff) shl 16) or ((buf[offset + 2].toInt() and 0xff) shl 8) or (buf[offset + 3].toInt() and 0xff)
fun readI32(buf: ByteArray, offset: Int): Int = readU32(buf, offset)
fun readU64(buf: ByteArray, offset: Int): Long = (readU32(buf, offset).toLong() and 0xffffffffL) shl 32 or (readU32(buf, offset + 4).toLong() and 0xffffffffL)

fun hexToBytes(hex: String): ByteArray {
    val out = ByteArray(hex.length / 2)
    for (i in out.indices) out[i] = hex.substring(i * 2, i * 2 + 2).toInt(16).toByte()
    return out
}

fun bytesToHex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

fun constantTimeEquals(a: ByteArray, b: ByteArray): Boolean = a.size == b.size && Arrays.equals(a, b)
