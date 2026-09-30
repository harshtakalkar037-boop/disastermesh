package app.disastermesh.mesh

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.wifi.p2p.WifiP2pConfig
import android.net.wifi.p2p.WifiP2pManager
import java.io.DataInputStream
import java.io.DataOutputStream
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket

/**
 * Wi-Fi Direct adapter. Not the default transport.
 * UNVERIFIED: no physical-device test was run in this environment.
 * Known issue: group owners are commonly assigned 192.168.49.1, so two groups cannot be bridged by IPv4.
 * This class does not invent a workaround and does not report success without a socket that actually transferred bytes.
 */
class WifiDirectTransport(private val context: Context) {
    private val manager = context.getSystemService(WifiP2pManager::class.java)
    private var channel: WifiP2pManager.Channel? = null
    var lastError: String = if (manager == null) "Wi-Fi Direct service missing." else "Not started."

    fun start(onPeers: (List<String>) -> Unit) {
        val mgr = manager ?: return
        channel = mgr.initialize(context, context.mainLooper) { lastError = "Wi-Fi Direct channel lost." }
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context, intent: Intent) {
                if (intent.action == WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION) {
                    mgr.requestPeers(channel) { peers ->
                        onPeers(peers.deviceList.map { "${it.deviceName ?: "unnamed"} ${it.deviceAddress} status=${it.status}" })
                    }
                }
            }
        }
        context.registerReceiver(receiver, IntentFilter(WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION))
        mgr.discoverPeers(channel, object : WifiP2pManager.ActionListener {
            override fun onSuccess() { lastError = "Discovery started. User confirmation may still be required. UNVERIFIED." }
            override fun onFailure(reason: Int) { lastError = "Wi-Fi Direct discovery failed, reason $reason." }
        })
    }

    fun connect(address: String, onResult: (String) -> Unit) {
        val mgr = manager ?: return onResult("Wi-Fi Direct missing.")
        val config = WifiP2pConfig().apply { deviceAddress = address }
        mgr.connect(channel, config, object : WifiP2pManager.ActionListener {
            override fun onSuccess() { onResult("Connection requested. This is not a completed transfer.") }
            override fun onFailure(reason: Int) { onResult("Connect failed, reason $reason.") }
        })
    }

    fun exchange(groupOwner: Boolean, ownerHost: String?, bytes: ByteArray, onResult: (Boolean, String) -> Unit) {
        Thread {
            try {
                if (groupOwner) {
                    ServerSocket(8988).use { server ->
                        val socket = server.accept()
                        DataOutputStream(socket.getOutputStream()).use { it.writeInt(bytes.size); it.write(bytes) }
                        socket.close()
                    }
                    onResult(true, "Group owner sent ${bytes.size} bytes. Still not command-center delivery. UNVERIFIED if this was a lab only.")
                } else {
                    val host = ownerHost ?: return@Thread onResult(false, "No group-owner address. Refusing to assume 192.168.49.1.")
                    Socket().use { socket ->
                        socket.connect(InetSocketAddress(host, 8988), 5000)
                        val input = DataInputStream(socket.getInputStream())
                        val size = input.readInt()
                        val buf = ByteArray(size)
                        input.readFully(buf)
                        onResult(true, "Client read $size bytes from $host.")
                    }
                }
            } catch (err: Exception) {
                onResult(false, err.message ?: "Wi-Fi Direct socket failed")
            }
        }.start()
    }
}
