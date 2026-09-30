package app.disastermesh

import android.app.Application
import app.disastermesh.data.LocalStore
import app.disastermesh.mesh.DeviceIdentity
import app.disastermesh.mesh.MeshEngine

class DisasterMeshApp : Application() {
    lateinit var store: LocalStore
        private set
    lateinit var mesh: MeshEngine
        private set
    lateinit var identity: DeviceIdentity
        private set

    override fun onCreate() {
        super.onCreate()
        store = LocalStore(this)
        mesh = MeshEngine(this, store)
        identity = DeviceIdentity(this)
        if (store.setting("origin").isBlank()) {
            store.putSetting("origin", app.disastermesh.protocol.bytesToHex(identity.publicKeyRaw.copyOfRange(1, 17)))
        }
    }
}
