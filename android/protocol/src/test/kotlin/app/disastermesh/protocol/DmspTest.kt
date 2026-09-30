package app.disastermesh.protocol

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File

class DmspTest {
    private val now = 1_700_000_000_000L

    @Test
    fun nodeFixtureVerifiesAndRelayDoesNotBreakSignature() {
        val file = locateVectors()
        val json = file.readText()
        val valid = hexToBytes(field(json, "validHex"))
        val relayedHex = field(json, "relayedHex")
        val tampered = hexToBytes(field(json, "tamperedHex"))
        val verified = verifyPacket(valid, now)
        assertTrue(verified is VerifyResult.Ok, verified.toString())
        val packet = (verified as VerifyResult.Ok).packet
        assertTrue(packet.simulated)
        assertEquals(1, packet.priority)
        assertEquals(PayloadType.STATUS, packet.payloadType)
        assertEquals(186_298_000, packet.location?.latE7)
        val hopped = withRelayHop(valid)
        assertTrue(hopped != null)
        assertEquals(relayedHex, bytesToHex(hopped!!))
        assertTrue(verifyPacket(hopped, now) is VerifyResult.Ok)
        val bad = verifyPacket(tampered, now)
        assertTrue(bad is VerifyResult.Fail)
        assertEquals("bad_signature", (bad as VerifyResult.Fail).error)
    }

    @Test
    fun relayedIsNotAcknowledgedAndSilenceIsUnknown() {
        assertFalse(canTransition(DeliveryState.RELAYED_TO_PEER, DeliveryState.ACKNOWLEDGED_BY_OPERATOR))
        assertTrue(canTransition(DeliveryState.QUEUED_OFFLINE, DeliveryState.RECEIVED_BY_COMMAND_CENTER))
        assertEquals("unknown", statusOrUnknown(null))
        assertEquals("unknown", statusOrUnknown("quiet"))
    }

    @Test
    fun batteryAndSchedulerMatchPolicy() {
        assertFalse(mayRelay(3, 10, true).first)
        assertTrue(mayRelay(0, 10, true).first)
        assertEquals("battery_critical", mayRelay(0, 5, true).second)
        val q = PriorityScheduler<String>()
        q.enqueue(0, "a")
        q.enqueue(0, "b")
        q.enqueue(4, "c")
        assertEquals(0, q.next()?.first)
        assertEquals(0, q.next()?.first)
        assertEquals(4, q.next()?.first)
    }

    @Test
    fun extractorDoesNotInventOfficialSafety() {
        val mr = extractReport("पुरामुळे तीन लोक अडकले आहेत, मदत हवी")
        assertEquals("flood", mr.incidentType)
        assertEquals(3, mr.peopleCount)
        assertEquals("need_help", mr.claimedState)
        assertTrue(mr.requiresUserConfirmation)
        assertTrue(mr.confidence < 1.0)
        assertTrue(mr.notes.any { it.contains("not proof of safety") })
        val life = extractReport("two people unconscious")
        assertEquals(0, life.suggestedPriority)
        assertTrue(life.priorityRequiresConfirmation)
    }

    @Test
    fun kotlinEncoderProducesPacketsTheVerifierAccepts() {
        val signer = JvmSigner()
        val raw = encodePacket(
            PacketDraft(
                priority = 1,
                payloadType = PayloadType.STATUS,
                messageId = ByteArray(16) { 7 },
                originPseudonym = ByteArray(16) { 3 },
                incidentId = ByteArray(16) { 9 },
                eventTimestampMs = now,
                expiryTimestampMs = now + 3_600_000,
                nonce = ByteArray(12) { 1 },
                payload = statusJson("flood", "need_help", 2, "moderate", "assisted", 1, "help", "en"),
                location = LocationFix(186_300_000, 738_000_000, 8, 1),
            ),
            signer,
        )
        val verified = verifyPacket(raw, now)
        assertTrue(verified is VerifyResult.Ok)
        val hopped = withRelayHop(raw)!!
        assertTrue(verifyPacket(hopped, now) is VerifyResult.Ok)
    }

    @Test
    fun coarseAccuracyDoesNotCluster() {
        val decision = proximityDecision(
            ReportPoint("a", "flood", now, 18.63, 73.8, 120.0),
            ReportPoint("b", "flood", now, 18.6301, 73.8001, 120.0),
        )
        assertFalse(decision.cluster)
        assertEquals("accuracy_too_coarse", decision.reason)
    }

    private fun field(json: String, name: String): String {
        val match = Regex(""""$name"\s*:\s*"([^"]+)"""").find(json) ?: error("missing $name")
        return match.groupValues[1]
    }

    private fun locateVectors(): File {
        val candidates = listOf(
            File("shared-protocol/fixtures/vectors.json"),
            File("../shared-protocol/fixtures/vectors.json"),
            File("../../shared-protocol/fixtures/vectors.json"),
            File("../../../shared-protocol/fixtures/vectors.json"),
        )
        return candidates.firstOrNull { it.exists() } ?: error("vectors.json not found from ${File(".").absolutePath}")
    }
}
