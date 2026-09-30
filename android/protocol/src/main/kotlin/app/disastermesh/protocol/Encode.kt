package app.disastermesh.protocol

import java.security.KeyPairGenerator
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec

data class PacketDraft(
    val hopLimit: Int = DEFAULT_HOP_LIMIT,
    val hopCount: Int = 0,
    val relayFlags: Int = 0,
    val flags: Int = 0,
    val priority: Int,
    val payloadType: PayloadType,
    val messageId: ByteArray,
    val originPseudonym: ByteArray,
    val incidentId: ByteArray = ByteArray(16),
    val eventTimestampMs: Long,
    val expiryTimestampMs: Long,
    val nonce: ByteArray,
    val sequence: Int = 1,
    val payload: ByteArray,
    val location: LocationFix? = null,
    val simulated: Boolean = false,
)

interface Signer {
    val publicKeyRaw: ByteArray
    fun sign(signedBlob: ByteArray): ByteArray
}

class JvmSigner : Signer {
    private val privateKey: java.security.PrivateKey
    override val publicKeyRaw: ByteArray

    init {
        val kpg = KeyPairGenerator.getInstance("EC")
        kpg.initialize(ECGenParameterSpec("secp256r1"))
        val pair = kpg.generateKeyPair()
        privateKey = pair.private
        val pub = pair.public as ECPublicKey
        publicKeyRaw = uncompressed(pub)
    }

    override fun sign(signedBlob: ByteArray): ByteArray {
        val sig = Signature.getInstance("SHA256withECDSA")
        sig.initSign(privateKey)
        sig.update(signedBlob)
        return derToP1363(sig.sign())
    }
}

fun encodePacket(draft: PacketDraft, signer: Signer): ByteArray {
    require(draft.payload.size <= MAX_PAYLOAD)
    require(draft.messageId.size == 16 && draft.originPseudonym.size == 16 && draft.nonce.size == 12)
    require(draft.priority in 0..4 && draft.hopLimit in 0..MAX_HOP && draft.hopCount in 0..MAX_HOP)
    var flags = draft.flags
    flags = if (draft.location != null) flags or Flag.HAS_LOCATION else flags and Flag.HAS_LOCATION.inv()
    flags = if (draft.incidentId.any { it != 0.toByte() }) flags or Flag.HAS_INCIDENT else flags
    flags = if (draft.simulated) flags or Flag.SIMULATED else flags and Flag.SIMULATED.inv()
    val signed = ByteArray(SIGNED_HEADER_LEN + draft.payload.size)
    signed[0] = 0x44; signed[1] = 0x4d; signed[2] = 0x53; signed[3] = 0x50
    signed[4] = DMSP_VERSION.toByte()
    signed[5] = flags.toByte()
    signed[6] = draft.priority.toByte()
    signed[7] = draft.payloadType.code.toByte()
    writeU16(signed, 8, draft.payload.size)
    draft.messageId.copyInto(signed, 10)
    draft.originPseudonym.copyInto(signed, 26)
    draft.incidentId.copyInto(signed, 42)
    writeU64(signed, 58, draft.eventTimestampMs)
    writeU64(signed, 66, draft.expiryTimestampMs)
    draft.nonce.copyInto(signed, 74)
    writeU32(signed, 86, draft.sequence)
    if (draft.location != null) {
        writeI32(signed, 90, draft.location.latE7)
        writeI32(signed, 94, draft.location.lonE7)
        writeU16(signed, 98, draft.location.accuracyM)
        writeU16(signed, 100, draft.location.ageSec)
    }
    signer.publicKeyRaw.copyInto(signed, 102)
    sha256(signer.publicKeyRaw).copyInto(signed, 167, 0, 8)
    draft.payload.copyInto(signed, SIGNED_HEADER_LEN)
    val signature = signer.sign(signed)
    require(signature.size == SIGNATURE_LEN)
    val raw = ByteArray(6 + signed.size + SIGNATURE_LEN)
    raw[0] = draft.hopLimit.toByte()
    raw[1] = draft.hopCount.toByte()
    raw[2] = draft.relayFlags.toByte()
    raw[3] = FRAME_VERSION.toByte()
    writeU16(raw, 4, signed.size)
    signed.copyInto(raw, 6)
    signature.copyInto(raw, 6 + signed.size)
    require(raw.size <= MAX_PACKET)
    return raw
}

fun derToP1363(der: ByteArray): ByteArray {
    var offset = 2
    if (der[1].toInt() and 0x80 != 0) offset = 2 + (der[1].toInt() and 0x7f)
    require(der[offset] == 0x02.toByte())
    val rLen = der[offset + 1].toInt() and 0xff
    val r = der.copyOfRange(offset + 2, offset + 2 + rLen)
    offset = offset + 2 + rLen
    require(der[offset] == 0x02.toByte())
    val sLen = der[offset + 1].toInt() and 0xff
    val s = der.copyOfRange(offset + 2, offset + 2 + sLen)
    val out = ByteArray(64)
    val rt = trim(r)
    val st = trim(s)
    rt.copyInto(out, 32 - rt.size)
    st.copyInto(out, 64 - st.size)
    return out
}

private fun trim(buf: ByteArray): ByteArray {
    var i = 0
    while (i < buf.size - 1 && buf[i] == 0.toByte()) i++
    return buf.copyOfRange(i, buf.size)
}

private fun uncompressed(pub: ECPublicKey): ByteArray {
    val x = pub.w.affineX.toUnsigned32()
    val y = pub.w.affineY.toUnsigned32()
    return byteArrayOf(0x04) + x + y
}

private fun java.math.BigInteger.toUnsigned32(): ByteArray {
    val raw = toByteArray()
    val out = ByteArray(32)
    val src = if (raw.size > 32) raw.copyOfRange(raw.size - 32, raw.size) else raw
    src.copyInto(out, 32 - src.size)
    return out
}

private fun writeU16(buf: ByteArray, offset: Int, value: Int) {
    buf[offset] = ((value shr 8) and 0xff).toByte()
    buf[offset + 1] = (value and 0xff).toByte()
}

private fun writeU32(buf: ByteArray, offset: Int, value: Int) {
    buf[offset] = ((value ushr 24) and 0xff).toByte()
    buf[offset + 1] = ((value ushr 16) and 0xff).toByte()
    buf[offset + 2] = ((value ushr 8) and 0xff).toByte()
    buf[offset + 3] = (value and 0xff).toByte()
}

private fun writeI32(buf: ByteArray, offset: Int, value: Int) = writeU32(buf, offset, value)

private fun writeU64(buf: ByteArray, offset: Int, value: Long) {
    writeU32(buf, offset, (value ushr 32).toInt())
    writeU32(buf, offset + 4, value.toInt())
}

fun statusJson(
    type: String,
    state: String,
    people: Int?,
    injury: String?,
    mobility: String?,
    vulnerable: Int?,
    text: String?,
    lang: String?,
    destination: String? = null,
    groupSize: Int? = null,
): ByteArray {
    val txt = text?.take(MAX_TEXT_CHARS)
    val parts = mutableListOf("\"t\":\"${esc(type)}\"", "\"s\":\"${esc(state)}\"")
    if (people != null) parts += "\"n\":$people"
    if (injury != null) parts += "\"inj\":\"${esc(injury)}\""
    if (mobility != null) parts += "\"mob\":\"${esc(mobility)}\""
    if (vulnerable != null) parts += "\"vul\":$vulnerable"
    if (!txt.isNullOrEmpty()) parts += "\"txt\":\"${esc(txt)}\""
    if (lang != null) parts += "\"lang\":\"${esc(lang)}\""
    if (!destination.isNullOrEmpty()) parts += "\"dest\":\"${esc(destination.take(80))}\""
    if (groupSize != null) parts += "\"gs\":$groupSize"
    parts += "\"vl\":\"eyewitness\""
    return "{${parts.joinToString(",")}}".encodeToByteArray()
}

private fun esc(value: String) = value.replace("\\", "\\\\").replace("\"", "\\\"")
