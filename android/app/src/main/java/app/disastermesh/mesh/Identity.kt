package app.disastermesh.mesh

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import app.disastermesh.protocol.Signer
import app.disastermesh.protocol.derToP1363
import java.io.File
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.PKCS8EncodedKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class DeviceIdentity(context: Context) : Signer {
    override val publicKeyRaw: ByteArray
    val hardwareBacked: Boolean
    val warning: String?
    private val privateKey: java.security.PrivateKey

    init {
        val loaded = loadKeystore() ?: loadSoftware(context)
        publicKeyRaw = loaded.publicKey
        privateKey = loaded.privateKey
        hardwareBacked = loaded.hardware
        warning = loaded.warning
    }

    override fun sign(signedBlob: ByteArray): ByteArray {
        val sig = Signature.getInstance("SHA256withECDSA")
        sig.initSign(privateKey)
        sig.update(signedBlob)
        return derToP1363(sig.sign())
    }

    private data class Loaded(val privateKey: java.security.PrivateKey, val publicKey: ByteArray, val hardware: Boolean, val warning: String?)

    private fun loadKeystore(): Loaded? = try {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val alias = "disastermesh-origin"
        if (!ks.containsAlias(alias)) {
            val kpg = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
            kpg.initialize(
                KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
                    .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                    .setDigests(KeyProperties.DIGEST_SHA256)
                    .setUserAuthenticationRequired(false)
                    .build(),
            )
            kpg.generateKeyPair()
        }
        val privateKey = ks.getKey(alias, null) as java.security.PrivateKey
        val pub = ks.getCertificate(alias).publicKey as ECPublicKey
        Loaded(privateKey, uncompressed(pub), true, null)
    } catch (err: Exception) {
        null
    }

    private fun loadSoftware(context: Context): Loaded {
        val file = File(context.filesDir, "software-origin.bin")
        if (file.exists() && file.length() > 65) {
            val bytes = file.readBytes()
            val publicKey = bytes.copyOfRange(0, 65)
            val privateKey = KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(bytes.copyOfRange(65, bytes.size)))
            return Loaded(privateKey, publicKey, false, "Using a persisted software key. It is not hardware-backed.")
        }
        val kpg = KeyPairGenerator.getInstance("EC")
        kpg.initialize(ECGenParameterSpec("secp256r1"))
        val pair = kpg.generateKeyPair()
        val pub = pair.public as ECPublicKey
        val raw = uncompressed(pub)
        file.writeBytes(raw + pair.private.encoded)
        return Loaded(pair.private, raw, false, "Android Keystore signing key was unavailable. Using a software key stored in app-private files. It is not hardware-backed.")
    }

    fun encrypt(context: Context, plain: ByteArray): ByteArray? = try {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, aes(context))
        cipher.iv + cipher.doFinal(plain)
    } catch (_: Exception) {
        null
    }

    fun decrypt(context: Context, blob: ByteArray): ByteArray? = try {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, aes(context), GCMParameterSpec(128, blob.copyOfRange(0, 12)))
        cipher.doFinal(blob.copyOfRange(12, blob.size))
    } catch (_: Exception) {
        null
    }

    private fun aes(context: Context): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val alias = "disastermesh-aes"
        if (!ks.containsAlias(alias)) {
            val kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
            kg.init(
                KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .build(),
            )
            kg.generateKey()
        }
        return ks.getKey(alias, null) as SecretKey
    }

    private fun uncompressed(pub: ECPublicKey): ByteArray {
        fun coord(value: java.math.BigInteger): ByteArray {
            val raw = value.toByteArray()
            val out = ByteArray(32)
            val src = if (raw.size > 32) raw.copyOfRange(raw.size - 32, raw.size) else raw
            src.copyInto(out, 32 - src.size)
            return out
        }
        return byteArrayOf(0x04) + coord(pub.w.affineX) + coord(pub.w.affineY)
    }
}
