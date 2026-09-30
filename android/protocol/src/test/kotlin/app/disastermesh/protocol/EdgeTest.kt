package app.disastermesh.protocol

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class EdgeTest {
    @Test
    fun witnessRequiresConfirmationAndHashesEvidence() {
        assertTrue(draftWitness("", "MODEL_UNAVAILABLE") is EdgeResult.Fail)
        val draft = draftWitness("बाढ़ में तीन लोग फंसे हैं, पानी दरवाजे तक", "MODEL_UNAVAILABLE", 18.0)
        val value = (draft as EdgeResult.Ok).value
        assertEquals("flood", value.incidentType)
        assertEquals("need_help", value.claimedState)
        assertEquals(3, value.peopleCount)
        assertTrue(confirmWitness(value, false) is EdgeResult.Fail)
        val media = "still-bytes".toByteArray()
        val confirmed = confirmWitness(value, true, media) as EdgeResult.Ok
        assertTrue(String(confirmed.value).contains(sha256Hex(media)))
        assertFalse(String(confirmed.value).contains("still-bytes"))
        assertTrue(draftWitness("need help", "NPU") is EdgeResult.Fail)
        assertEquals("MODEL_UNAVAILABLE", localModelStatus(false, false))
    }

    @Test
    fun gateDefersDuplicatesAndDoesNotDeferANewLifeThreat() {
        val first = GateFact("a".repeat(32), "flood", "need_help", 3, "unknown", false, 1, "same")
        assertEquals("admit", scarceSlotGate(first, emptyList(), emptyList(), 80, 3).decision)
        val duplicate = scarceSlotGate(first, listOf(first), emptyList(), 4, 3)
        assertEquals("defer", duplicate.decision)
        assertEquals("no_new_fact", duplicate.reason)
        assertEquals("replace_previous", scarceSlotGate(first.copy(waterlineBand = "high", text = "chest"), listOf(first), emptyList(), 90, 3).decision)
        assertEquals("admit", scarceSlotGate(first.copy(lifeThreat = true, priority = 0, text = "unconscious"), emptyList(), emptyList(), 4, 2).decision)
    }

    @Test
    fun silenceIsUnheardAndEvidenceNeedsAnOperator() {
        val id = "ab".repeat(16)
        assertTrue(encodeHeardDigest(HeardSet(1_700_000_000_000, "mid", listOf(id), null)) is EdgeResult.Ok)
        assertTrue(encodeHeardDigest(HeardSet(1L, "low", listOf("9876543210"), null)) is EdgeResult.Fail)
        val unheard = classifyUnheard(listOf(1_700_000_000_000 - 1_200_000 to listOf(id), 1_700_000_000_000 to emptyList()), 1_700_000_000_000)
        assertEquals("UNHEARD", unheard.single().second)
        assertFalse(unheard.single().third)
        assertEquals("unauthorized", authorizeEvidenceRequest("civilian", true).second)
        assertEquals("UNAVAILABLE", officeKitStatus(false).first)
    }

    @Test
    fun confirmedWitnessVerifiesAsDmsp() {
        val draft = draftWitness("three people trapped in flood", "CPU_FALLBACK", modelName = "rules")
        val payload = confirmWitness((draft as EdgeResult.Ok).value, true, byteArrayOf(4, 5, 6))
        val now = 1_700_000_000_000L
        val raw = encodePacket(PacketDraft(
            priority = 1,
            payloadType = PayloadType.WITNESS_DELTA,
            messageId = ByteArray(16) { 7 },
            originPseudonym = ByteArray(16) { 8 },
            incidentId = ByteArray(16) { 9 },
            eventTimestampMs = now,
            expiryTimestampMs = now + 3_600_000,
            nonce = ByteArray(12) { 3 },
            payload = (payload as EdgeResult.Ok).value,
        ), JvmSigner())
        assertTrue(verifyPacket(raw, now) is VerifyResult.Ok)
    }
}
