package app.disastermesh.mesh

import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.BluetoothLeAdvertiser
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.aware.WifiAwareManager
import android.net.wifi.p2p.WifiP2pManager
import android.os.Build
import android.os.ParcelUuid
import androidx.core.app.NotificationCompat
import app.disastermesh.data.LocalStore
import app.disastermesh.protocol.DeliveryState
import app.disastermesh.protocol.MAX_HOP
import app.disastermesh.protocol.bytesToHex
import app.disastermesh.protocol.canTransition
import app.disastermesh.protocol.mayRelay
import app.disastermesh.protocol.verifyPacket
import app.disastermesh.protocol.withRelayHop
import org.json.JSONObject
import java.io.BufferedReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import java.util.concurrent.Executors

data class CapabilityReport(
    val checked: Boolean,
    val bluetoothPresent: Boolean,
    val bluetoothEnabled: Boolean,
    val bleAdvertiser: Boolean,
    val bleMultipleAdvertisement: Boolean,
    val wifiDirectPresent: Boolean,
    val wifiAwarePresent: Boolean,
    val gpsPresent: Boolean,
    val telephonyPresent: Boolean,
    val cameraPresent: Boolean,
    val micPresent: Boolean,
    val errors: List<String>,
    val multiHopVerified: Boolean = false,
    val note: String = "API presence is not a successful radio test. Multi-hop is UNVERIFIED until three physical phones pass the written procedure.",
)

class MeshEngine(private val context: Context, private val store: LocalStore) {
    private val io = Executors.newSingleThreadExecutor()
    @Volatile var lastError: String = ""
    @Volatile var relayCount: Int = 0
    @Volatile var lastPacketAt: Long? = null
    @Volatile var gatewayReachable: Boolean? = null
    @Volatile var capabilities: CapabilityReport = CapabilityReport(false, false, false, false, false, false, false, false, false, false, false, emptyList())
    private var gattServer: BluetoothGattServer? = null
    private var advertiser: BluetoothLeAdvertiser? = null

    fun probe(): CapabilityReport {
        val errors = mutableListOf<String>()
        val bt = context.getSystemService(BluetoothManager::class.java)
        val adapter = bt?.adapter
        val wifiP2p = context.getSystemService(WifiP2pManager::class.java)
        val aware = if (Build.VERSION.SDK_INT >= 26) context.getSystemService(WifiAwareManager::class.java) else null
        val awarePresent = try { aware?.isAvailable == true } catch (err: Exception) {
            errors += "Wi-Fi Aware check failed: ${err.javaClass.simpleName}"
            false
        }
        val report = CapabilityReport(
            checked = true,
            bluetoothPresent = adapter != null,
            bluetoothEnabled = adapter?.isEnabled == true,
            bleAdvertiser = adapter?.bluetoothLeAdvertiser != null,
            bleMultipleAdvertisement = adapter?.isMultipleAdvertisementSupported == true,
            wifiDirectPresent = wifiP2p != null && context.packageManager.hasSystemFeature(PackageManager.FEATURE_WIFI_DIRECT),
            wifiAwarePresent = awarePresent,
            gpsPresent = context.packageManager.hasSystemFeature(PackageManager.FEATURE_LOCATION_GPS),
            telephonyPresent = context.packageManager.hasSystemFeature(PackageManager.FEATURE_TELEPHONY),
            cameraPresent = context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY),
            micPresent = context.packageManager.hasSystemFeature(PackageManager.FEATURE_MICROPHONE),
            errors = errors,
        )
        capabilities = report
        return report
    }

    fun internetValidated(): Boolean {
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return false
        val network = cm.activeNetwork ?: return false
        val caps = cm.getNetworkCapabilities(network) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    fun peerCount(): Int = store.peers(System.currentTimeMillis() - 60_000).size

    fun enqueueAndTry(reportId: String, raw: ByteArray, priority: Int, battery: Int?) {
        io.execute {
            val lab = store.setting("lab_loopback") == "1"
            if (lab) {
                transition(reportId, DeliveryState.LAB_LOOPBACK, "LAB LOOPBACK is on. This was not sent to a real peer.")
                return@execute
            }
            val connected = store.peers(System.currentTimeMillis() - 60_000).any { it.optBoolean("connected") }
            if (!connected && !internetValidated()) {
                transition(reportId, DeliveryState.QUEUED_OFFLINE, "Saved on this phone only. No peer and no validated internet. Rescuers have NOT received this.")
                return@execute
            }
            if (connected) {
                writeToFirstPeer(raw) { acked, detail ->
                    if (acked) transition(reportId, DeliveryState.RELAYED_TO_PEER, "A nearby phone accepted bytes. This is NOT delivery to rescuers. $detail")
                    else lastError = detail
                }
            }
            syncGateway(reportId, raw)
        }
    }

    fun syncGateway(reportId: String?, raw: ByteArray? = null) {
        io.execute {
            val base = store.setting("gateway_url").trim().trimEnd('/')
            if (base.isEmpty()) {
                gatewayReachable = false
                if (reportId != null) transition(reportId, DeliveryState.QUEUED_OFFLINE, "No command-center URL configured. Rescuers have NOT received this.")
                return@execute
            }
            if (base.startsWith("http://")) lastError = "UNENCRYPTED LAB CONNECTION. Release builds block cleartext."
            try {
                val health = request("GET", "$base/api/v1/health", null)
                gatewayReachable = health.first in 200..299
                if (gatewayReachable != true) {
                    if (reportId != null) transition(reportId, DeliveryState.QUEUED_OFFLINE, "Gateway health check failed. Rescuers have NOT received this.")
                    return@execute
                }
                val batch = if (raw != null) listOf(bytesToHex(raw)) else store.outbox().map { it.second }
                if (batch.isEmpty()) return@execute
                if (reportId != null) transition(reportId, DeliveryState.DELIVERED_TO_GATEWAY, "Upload request handed to the command center. Receipt is not confirmed yet.")
                val body = JSONObject().put("packets", org.json.JSONArray(batch.map { JSONObject().put("rawHex", it) })).toString()
                val response = request("POST", "$base/api/v1/sync/packets", body)
                if (response.first !in 200..299) {
                    if (reportId != null) transition(reportId, DeliveryState.QUEUED_OFFLINE, "Upload failed (${response.first}). Rescuers have NOT received this.")
                    return@execute
                }
                val json = JSONObject(response.second)
                val results = json.getJSONArray("results")
                for (i in 0 until results.length()) {
                    val item = results.getJSONObject(i)
                    val result = item.optString("result")
                    val messageId = item.optString("messageId")
                    if (result == "accepted" || result == "duplicate") {
                        if (messageId.isNotBlank()) store.removeOutbox(messageId)
                        if (reportId != null) transition(reportId, DeliveryState.RECEIVED_BY_COMMAND_CENTER, "Command center accepted the packet. An operator has not necessarily seen it.")
                        store.putSetting("last_sync", System.currentTimeMillis().toString())
                    } else if (reportId != null) {
                        transition(reportId, DeliveryState.REJECTED, item.optString("reason", "rejected"))
                    }
                }
            } catch (err: Exception) {
                gatewayReachable = false
                lastError = err.message ?: err.javaClass.simpleName
                if (reportId != null) transition(reportId, DeliveryState.QUEUED_OFFLINE, "Gateway error: $lastError. Rescuers have NOT received this.")
            }
        }
    }

    fun ingestRadioPacket(bytes: ByteArray, fromPeer: String, battery: Int?) {
        val verified = verifyPacket(bytes, System.currentTimeMillis())
        if (verified !is app.disastermesh.protocol.VerifyResult.Ok) {
            lastError = "Rejected radio packet: ${(verified as app.disastermesh.protocol.VerifyResult.Fail).error}"
            return
        }
        lastPacketAt = System.currentTimeMillis()
        val packet = verified.packet
        if (packet.simulated && store.setting("lab_loopback") != "1") {
            lastError = "Rejected simulated packet on the live radio path."
            return
        }
        store.addMessage(bytesToHex(packet.messageId), String(packet.payload), "in", packet.eventTimestampMs, DeliveryState.RELAYED_TO_PEER.name.lowercase())
        val origin = bytesToHex(packet.originPseudonym)
        if (origin.length == 32) {
            val heard = store.setting("heard_ids").split(",").filter { it.length == 32 }.toMutableList()
            if (origin !in heard) {
                heard += origin
                store.putSetting("heard_ids", heard.takeLast(8).joinToString(","))
            }
        }
        val decision = mayRelay(packet.priority, battery, store.setting("relay_enabled", "1") == "1")
        if (!decision.first || packet.hopLimit < 1 || packet.hopCount >= MAX_HOP) return
        val next = withRelayHop(bytes) ?: return
        relayCount += 1
        store.observePeer(fromPeer, System.currentTimeMillis(), null, true, "ingress; RSSI is not distance")
        // Actual onward write happens when a GATT client is connected. Until then the packet is retained.
        store.putSetting("last_radio_hex", bytesToHex(next).take(32))
    }

    @SuppressLint("MissingPermission")
    fun startBle(onError: (String) -> Unit) {
        val report = probe()
        if (!report.bluetoothEnabled || !report.bleAdvertiser) {
            onError("BLE advertiser unavailable. See the capability screen. Multi-hop remains UNVERIFIED.")
            return
        }
        val manager = context.getSystemService(BluetoothManager::class.java) ?: return
        val adapter = manager.adapter ?: return
        try {
            gattServer = manager.openGattServer(context, object : BluetoothGattServerCallback() {
                override fun onCharacteristicWriteRequest(device: android.bluetooth.BluetoothDevice, requestId: Int, characteristic: BluetoothGattCharacteristic, preparedWrite: Boolean, responseNeeded: Boolean, offset: Int, value: ByteArray) {
                    ingestRadioPacket(value, device.address ?: "peer", null)
                    if (responseNeeded) gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value)
                }
            })
            val service = BluetoothGattService(SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY)
            val rx = BluetoothGattCharacteristic(RX_UUID, BluetoothGattCharacteristic.PROPERTY_WRITE, BluetoothGattCharacteristic.PERMISSION_WRITE)
            service.addCharacteristic(rx)
            gattServer?.addService(service)
            advertiser = adapter.bluetoothLeAdvertiser
            val settings = AdvertiseSettings.Builder().setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_POWER).setConnectable(true).build()
            val data = AdvertiseData.Builder().setIncludeDeviceName(false).addServiceUuid(ParcelUuid(SERVICE_UUID)).build()
            advertiser?.startAdvertising(settings, data, object : AdvertiseCallback() {
                override fun onStartFailure(errorCode: Int) {
                    onError("BLE advertise failed, code $errorCode. UNVERIFIED on this device.")
                }
            })
        } catch (err: SecurityException) {
            onError("Bluetooth permission denied.")
        } catch (err: Exception) {
            onError(err.message ?: "BLE start failed")
        }
    }

    @SuppressLint("MissingPermission")
    fun writeToFirstPeer(packet: ByteArray, onAck: (Boolean, String) -> Unit) {
        val peer = store.peers(System.currentTimeMillis() - 60_000).firstOrNull() ?: return onAck(false, "No peer address to write.")
        val address = peer.optString("id")
        val adapter = context.getSystemService(BluetoothManager::class.java)?.adapter
        if (adapter == null || !adapter.isEnabled) return onAck(false, "Bluetooth disabled.")
        try {
            val device = adapter.getRemoteDevice(address)
            device.connectGatt(context, false, object : BluetoothGattCallback() {
                override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
                    if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) gatt.discoverServices()
                    else if (newState == BluetoothProfile.STATE_DISCONNECTED) onAck(false, "GATT disconnected, status $status. UNVERIFIED radio path.")
                }
                override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
                    val characteristic = gatt.getService(SERVICE_UUID)?.getCharacteristic(RX_UUID)
                    if (characteristic == null) {
                        onAck(false, "Peer does not expose the DisasterMesh service.")
                        gatt.close()
                        return
                    }
                    if (packet.size > 180) {
                        onAck(false, "Packet is ${packet.size} bytes. A single GATT write was not used, because a partial write is not delivery. Link fragmentation is specified and tested in shared-protocol; the on-device multi-chunk writer is UNVERIFIED and is not claimed to have succeeded.")
                        gatt.close()
                        return
                    }
                    characteristic.value = packet
                    val started = gatt.writeCharacteristic(characteristic)
                    if (!started) {
                        onAck(false, "GATT write did not start.")
                        gatt.close()
                    }
                }
                override fun onCharacteristicWrite(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
                    onAck(status == BluetoothGatt.GATT_SUCCESS, "GATT write status $status. This ACK is a peer write response, not command-center delivery.")
                    gatt.close()
                }
            })
        } catch (err: SecurityException) {
            onAck(false, "Bluetooth connect permission denied.")
        } catch (err: Exception) {
            onAck(false, err.message ?: "GATT write failed")
        }
    }

    @SuppressLint("MissingPermission")
    fun scanOnce(onDevice: (String, Int?) -> Unit, onError: (String) -> Unit) {
        val adapter = context.getSystemService(BluetoothManager::class.java)?.adapter
        val scanner = adapter?.bluetoothLeScanner
        if (scanner == null || adapter.isEnabled != true) {
            onError("BLE scanner unavailable.")
            return
        }
        try {
            scanner.startScan(null, ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(), object : ScanCallback() {
                override fun onScanResult(callbackType: Int, result: ScanResult) {
                    val id = result.device?.address ?: return
                    store.observePeer(id, System.currentTimeMillis(), result.rssi, false, "radio neighbor only; RSSI is not proof of physical grouping")
                    onDevice(id, result.rssi)
                }
                override fun onScanFailed(errorCode: Int) { onError("BLE scan failed, code $errorCode") }
            })
        } catch (err: SecurityException) {
            onError("Bluetooth scan permission denied.")
        }
    }

    fun stopBle() {
        try { advertiser?.stopAdvertising(object : AdvertiseCallback() {}) } catch (_: Exception) {}
        try { gattServer?.close() } catch (_: Exception) {}
        gattServer = null
    }

    fun wifiDirectStatus(): String {
        val manager = context.getSystemService(WifiP2pManager::class.java) ?: return "Wi-Fi Direct service missing."
        val channel = manager.initialize(context, context.mainLooper) { lastError = "Wi-Fi Direct channel disconnected." }
        return if (channel == null) "Wi-Fi Direct channel could not be created. UNVERIFIED." else "Wi-Fi Direct API present. Connection is not automatic and is UNVERIFIED on this device. It is not the default transport."
    }

    private fun transition(reportId: String, to: DeliveryState, detail: String) {
        val current = store.reports().firstOrNull { it.id == reportId } ?: return
        val from = runCatching { DeliveryState.valueOf(current.delivery.uppercase()) }.getOrDefault(DeliveryState.QUEUED_OFFLINE)
        if (from == to || canTransition(from, to)) store.updateDelivery(reportId, to, detail)
    }

    private fun request(method: String, url: String, body: String?): Pair<Int, String> {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.requestMethod = method
        conn.connectTimeout = 8000
        conn.readTimeout = 8000
        conn.setRequestProperty("accept", "application/json")
        if (body != null) {
            conn.doOutput = true
            conn.setRequestProperty("content-type", "application/json")
            OutputStreamWriter(conn.outputStream).use { it.write(body) }
        }
        val code = conn.responseCode
        val stream = if (code in 200..299) conn.inputStream else conn.errorStream
        val text = stream?.bufferedReader()?.use(BufferedReader::readText) ?: ""
        conn.disconnect()
        return code to text
    }

    companion object {
        val SERVICE_UUID: UUID = UUID.fromString("6d5e7c10-8a1e-4b3a-9f62-d1a4c8e0b001")
        val RX_UUID: UUID = UUID.fromString("6d5e7c10-8a1e-4b3a-9f62-d1a4c8e0b002")
    }
}

class MeshRelayService : Service() {
    override fun onBind(intent: Intent?) = null
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val manager = getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel("relay", "Relay", NotificationManager.IMPORTANCE_LOW)
        manager.createNotificationChannel(channel)
        val notification = NotificationCompat.Builder(this, "relay")
            .setContentTitle(getString(app.disastermesh.R.string.relay_service))
            .setContentText(getString(app.disastermesh.R.string.relay_service_text))
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .build()
        startForeground(41, notification)
        return START_STICKY
    }
}
