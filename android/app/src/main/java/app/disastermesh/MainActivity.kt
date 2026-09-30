package app.disastermesh

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import app.disastermesh.protocol.deliveryLabel
import app.disastermesh.protocol.DeliveryState
import app.disastermesh.mesh.WifiDirectTransport
import app.disastermesh.ui.DeskViewModel
import app.disastermesh.ui.Screen

class MainActivity : ComponentActivity() {
    private val model by viewModels<DeskViewModel> {
        object : ViewModelProvider.Factory {
            override fun <T : ViewModel> create(modelClass: Class<T>): T {
                @Suppress("UNCHECKED_CAST")
                return DeskViewModel(application) as T
            }
        }
    }

    private val permissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { model.refresh() }
    private val stillCapture = registerForActivityResult(ActivityResultContracts.TakePicturePreview()) { bitmap ->
        if (bitmap == null) {
            model.witnessNote = "Camera returned no still. No image was invented."
            model.refresh()
            return@registerForActivityResult
        }
        val stream = java.io.ByteArrayOutputStream()
        bitmap.compress(android.graphics.Bitmap.CompressFormat.JPEG, 70, stream)
        val bytes = stream.toByteArray()
        val dir = java.io.File(filesDir, "evidence").apply { mkdirs() }
        val file = java.io.File(dir, "witness-still.jpg")
        file.writeBytes(bytes)
        model.attachEvidence(bytes, file.absolutePath)
    }
    private val evidencePicker = registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri == null) return@registerForActivityResult
        val bytes = contentResolver.openInputStream(uri)?.use { it.readBytes() }
        if (bytes == null || bytes.isEmpty()) {
            model.witnessNote = "Selected file could not be read. Nothing was hashed."
            model.refresh()
            return@registerForActivityResult
        }
        val dir = java.io.File(filesDir, "evidence").apply { mkdirs() }
        val file = java.io.File(dir, "witness-picked.bin")
        file.writeBytes(bytes)
        model.attachEvidence(bytes, file.absolutePath)
    }
    private var recorder: android.media.MediaRecorder? = null

    fun takeStill() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            model.witnessNote = "Camera permission denied. The draft can continue without a still."
            model.refresh()
            return
        }
        stillCapture.launch(null)
    }

    fun pickEvidence() { evidencePicker.launch("*/*") }

    fun captureAudio() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            model.witnessNote = "Microphone permission denied. Type the report. No transcript was invented."
            model.refresh()
            return
        }
        val dir = java.io.File(filesDir, "evidence").apply { mkdirs() }
        val file = java.io.File(dir, "witness-audio.m4a")
        val rec = if (android.os.Build.VERSION.SDK_INT >= 31) android.media.MediaRecorder(this) else @Suppress("DEPRECATION") android.media.MediaRecorder()
        try {
            rec.setAudioSource(android.media.MediaRecorder.AudioSource.MIC)
            rec.setOutputFormat(android.media.MediaRecorder.OutputFormat.MPEG_4)
            rec.setAudioEncoder(android.media.MediaRecorder.AudioEncoder.AAC)
            rec.setMaxDuration(8_000)
            rec.setOutputFile(file.absolutePath)
            rec.setOnInfoListener { _, what, _ ->
                if (what == android.media.MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED) finishAudio(file)
            }
            rec.prepare()
            rec.start()
            recorder = rec
            model.witnessNote = "Recording about 8 seconds. Audio stays on this phone."
            model.refresh()
            window.decorView.postDelayed({ finishAudio(file) }, 8_200)
        } catch (err: Exception) {
            recorder = null
            runCatching { rec.release() }
            model.witnessNote = "Microphone capture failed: ${err.message ?: err.javaClass.simpleName}. Type the report."
            model.refresh()
        }
    }

    private fun finishAudio(file: java.io.File) {
        val rec = recorder ?: return
        recorder = null
        runCatching { rec.stop() }
        rec.release()
        if (!file.exists() || file.length() == 0L) model.witnessNote = "Audio file was empty. Nothing was hashed."
        else model.attachEvidence(file.readBytes(), file.absolutePath)
        model.refresh()
    }

    fun sampleTilt() {
        val manager = getSystemService(android.hardware.SensorManager::class.java)
        val sensor = manager?.getDefaultSensor(android.hardware.Sensor.TYPE_ACCELEROMETER)
        if (manager == null || sensor == null) {
            model.noteTilt(null)
            return
        }
        val samples = mutableListOf<Double>()
        val listener = object : android.hardware.SensorEventListener {
            override fun onSensorChanged(event: android.hardware.SensorEvent) {
                val x = event.values[0]
                val y = event.values[1]
                val z = event.values[2]
                samples += Math.toDegrees(kotlin.math.atan2(kotlin.math.sqrt((x * x + y * y).toDouble()), z.toDouble()))
            }
            override fun onAccuracyChanged(sensor: android.hardware.Sensor?, accuracy: Int) = Unit
        }
        manager.registerListener(listener, sensor, android.hardware.SensorManager.SENSOR_DELAY_NORMAL)
        window.decorView.postDelayed({
            manager.unregisterListener(listener)
            model.noteTilt(if (samples.isEmpty()) null else samples.average())
        }, 2_000)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        permissions.launch(arrayOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION,
            Manifest.permission.BLUETOOTH_SCAN,
            Manifest.permission.BLUETOOTH_CONNECT,
            Manifest.permission.BLUETOOTH_ADVERTISE,
            Manifest.permission.POST_NOTIFICATIONS,
            Manifest.permission.CAMERA,
            Manifest.permission.RECORD_AUDIO,
        ))
        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize(), color = Color(0xFF10140F)) {
                    Desk(this, model)
                }
            }
        }
    }

    fun buzz() {
        val vibrator = getSystemService(Vibrator::class.java) ?: return
        if (!vibrator.hasVibrator()) return
        vibrator.vibrate(VibrationEffect.createOneShot(40, VibrationEffect.DEFAULT_AMPLITUDE))
    }
}

@Composable
private fun Desk(activity: MainActivity, model: DeskViewModel) {
    val screen by model.screen.collectAsState()
    val tick by model.tick.collectAsState()
    Column(Modifier.fillMaxSize().background(Color(0xFF10140F)).padding(12.dp)) {
        Text(model.t("disclaimer"), color = Color(0xFF1A160F), modifier = Modifier.background(Color(0xFFF0C14B)).padding(8.dp).fillMaxWidth(), fontWeight = FontWeight.Bold)
        Text("tick $tick", color = Color.Transparent, fontSize = 1.sp)
        when (screen) {
            Screen.Home -> Home(activity, model)
            Screen.NeedHelp -> StatusForm(activity, model, "need_help", "flood")
            Screen.Safe -> StatusForm(activity, model, "safe", "other")
            Screen.Evacuating -> StatusForm(activity, model, "evacuating", "other")
            Screen.Report -> StatusForm(activity, model, "unknown", "blocked_road", disaster = true)
            Screen.Find -> Info(model, "Find nearby help", model.nearby(activity).joinToString("\n"))
            Screen.Sos -> Sos(activity, model)
            Screen.Mesh -> MeshScreen(activity, model)
            Screen.Groups -> Info(model, model.t("groups"), model.groups().joinToString("\n"))
            Screen.Alerts -> Info(model, model.t("alerts"), "No official warning is generated on this phone. Test alerts appear only after a signed alert packet or a command-center sync. SACHET is not integrated.")
            Screen.Reports -> Info(model, model.t("reports"), model.reports().joinToString("\n") { "${it.state} · ${it.delivery}\n${it.detail}" }.ifBlank { "No reports yet." })
            Screen.Messages -> Messages(model)
            Screen.Contacts -> Contacts(activity, model)
            Screen.Settings -> Settings(model)
            Screen.Rescue -> Rescue(model)
            Screen.Capability -> Info(model, "Device capability", capabilityText(model))
            Screen.Location -> Info(model, model.t("location"), locationText(activity, model))
            Screen.Witness -> Witness(activity, model)
        }
    }
}

@Composable
private fun Home(activity: MainActivity, model: DeskViewModel) {
    val loc = model.location(activity)
    val battery = model.battery()
    Column(Modifier.fillMaxSize()) {
        Text(model.t("title"), color = Color(0xFFF6F1E7), fontSize = 28.sp, fontWeight = FontWeight.Black)
        Text("Status ${model.currentStatus()} · peers ${model.peers()} · battery ${battery?.toString() ?: "unavailable"} · sync ${model.lastSync()}", color = Color(0xFFB7AD9E))
        Text(if (loc == null) "Location unavailable or permission denied" else "Location ${loc.latitude}, ${loc.longitude} ± ${loc.accuracy} m", color = Color(0xFFF6F1E7))
        Text(if (model.meshError().isBlank()) "Internet ${if ((activity.application as DisasterMeshApp).mesh.internetValidated()) "validated" else "not validated"}" else model.meshError(), color = Color(0xFFF0C14B))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Big(model.t("need"), Color(0xFFD90429), Modifier.weight(1f)) { activity.buzz(); model.go(Screen.NeedHelp) }
                Big(model.t("safe"), Color(0xFF087F3B), Modifier.weight(1f)) { activity.buzz(); model.go(Screen.Safe) }
            }
            Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Big(model.t("evac"), Color(0xFFE07A00), Modifier.weight(1f)) { activity.buzz(); model.go(Screen.Evacuating) }
                Big(model.t("report"), Color(0xFF0B5FFF), Modifier.weight(1f)) { activity.buzz(); model.go(Screen.Report) }
            }
            Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Big(model.t("find"), Color(0xFF6D28D9), Modifier.weight(1f)) { model.go(Screen.Find) }
                Big(model.t("sos"), Color(0xFFFFE500), Modifier.weight(1f), Color.Black) { activity.buzz(); model.go(Screen.Sos) }
            }
        }
        Column(Modifier.height(150.dp).verticalScroll(rememberScrollState())) {
            listOf(
                model.t("status") to Screen.Reports,
                model.t("groups") to Screen.Groups,
                model.t("alerts") to Screen.Alerts,
                model.t("reports") to Screen.Reports,
                model.t("mesh") to Screen.Mesh,
                model.t("location") to Screen.Location,
                model.t("messages") to Screen.Messages,
                model.t("contacts") to Screen.Contacts,
                model.t("language") to Screen.Settings,
                model.t("settings") to Screen.Settings,
                model.t("rescue") to Screen.Rescue,
                "Capability" to Screen.Capability,
                model.t("witness") to Screen.Witness,
            ).forEach { (label, dest) ->
                Button(onClick = { model.go(dest) }, modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp)) { Text(label) }
            }
        }
    }
}

@Composable
private fun Big(label: String, color: Color, modifier: Modifier, contentColor: Color = Color.White, onClick: () -> Unit) {
    Button(onClick = onClick, modifier = modifier.fillMaxSize(), colors = ButtonDefaults.buttonColors(containerColor = color, contentColor = contentColor)) {
        Text(label, fontSize = 18.sp, fontWeight = FontWeight.Black)
    }
}

@Composable
private fun StatusForm(activity: MainActivity, model: DeskViewModel, state: String, defaultType: String, disaster: Boolean = false) {
    var type by remember { mutableStateOf(defaultType) }
    var people by remember { mutableStateOf("1") }
    var injury by remember { mutableStateOf("unknown") }
    var mobility by remember { mutableStateOf("unknown") }
    var text by remember { mutableStateOf("") }
    var dest by remember { mutableStateOf("") }
    var manualLat by remember { mutableStateOf("") }
    var sent by remember { mutableStateOf("") }
    val loc = model.location(activity)
    Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(if (disaster) model.t("report") else state, color = Color.White, fontSize = 28.sp, fontWeight = FontWeight.Black)
        Text("SAFE is a self-report, not proof of safety. Silence stays UNKNOWN.", color = Color(0xFFF0C14B))
        OutlinedTextField(type, { type = it }, label = { Text("Type: flood, fire, earthquake, landslide, medical, trapped, missing_person, other") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(people, { people = it }, label = { Text("People") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(injury, { injury = it }, label = { Text("Injury: none, minor, moderate, severe, critical, unknown") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(mobility, { mobility = it }, label = { Text("Mobility: walking, assisted, immobile, unknown") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(text, { text = it }, label = { Text("Short text, max 120 characters on mesh") }, modifier = Modifier.fillMaxWidth())
        if (state == "evacuating") OutlinedTextField(dest, { dest = it }, label = { Text("Intended destination, optional") }, modifier = Modifier.fillMaxWidth())
        Text(if (loc == null) "GPS unavailable. Enter coordinates or send without location." else "GPS ${loc.latitude}, ${loc.longitude} ± ${loc.accuracy} m", color = Color.White)
        OutlinedTextField(manualLat, { manualLat = it }, label = { Text("Manual lat,lon optional") }, modifier = Modifier.fillMaxWidth())
        Button(onClick = { model.startListen(activity) }) { Text("Voice report") }
        Text(model.speechNote, color = Color(0xFFB7AD9E))
        Button(onClick = { model.extract(text) }) { Text("Structure text offline") }
        Text(model.lastExtraction, color = Color(0xFFB7AD9E))
        Button(onClick = {
            val manual = manualLat.split(",").map { it.trim() }
            val lat = manual.getOrNull(0)?.toDoubleOrNull() ?: loc?.latitude
            val lon = manual.getOrNull(1)?.toDoubleOrNull() ?: loc?.longitude
            model.sendStatus(if (disaster) "disaster" else state, if (disaster) "unknown" else state, type, people.toIntOrNull(), injury, mobility, null, text, dest.ifBlank { null }, if (state == "evacuating") people.toIntOrNull() else null, lat, lon, loc?.accuracy, null)
            val latest = model.reports().firstOrNull()
            sent = if (latest == null) "Not saved." else "${latest.delivery}\n${latest.detail}"
        }, modifier = Modifier.fillMaxWidth().height(72.dp), colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFD90429))) {
            Text(model.t("send"), fontWeight = FontWeight.Black)
        }
        Text(sent, color = Color.White)
        Button(onClick = { model.back() }) { Text("Back") }
    }
}

@Composable
private fun Witness(activity: MainActivity, model: DeskViewModel) {
    var text by remember { mutableStateOf("") }
    var manual by remember { mutableStateOf("") }
    val loc = model.location(activity)
    Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(model.t("witness"), color = Color.White, fontSize = 28.sp, fontWeight = FontWeight.Black)
        Text("CAPTURE → DRAFT → CONFIRM → ADMITTED/DEFERRED → SIGNED → QUEUED. Inference ${model.inferenceStatus()}. Office Kit is UNAVAILABLE. UNHEARD ≠ SAFE.", color = Color(0xFFF0C14B))
        Text(if (loc == null) "GPS unavailable. No coordinates were invented." else "GPS ${loc.latitude}, ${loc.longitude} ± ${loc.accuracy} m at ${loc.time}", color = Color.White)
        OutlinedTextField(text, { text = it }, label = { Text("What you saw, or the manual form") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(manual, { manual = it }, label = { Text("Manual lat,lon optional") }, modifier = Modifier.fillMaxWidth())
        Button(onClick = { activity.captureAudio() }) { Text("Record about 8s audio") }
        Button(onClick = { model.startListen(activity) }) { Text("Offline speech, if the device has it") }
        Button(onClick = { activity.takeStill() }) { Text("Take one still") }
        Button(onClick = { activity.pickEvidence() }) { Text("Pick a local file") }
        Button(onClick = { activity.sampleTilt() }) { Text("Sample IMU for about 2s") }
        Button(onClick = {
            val parts = manual.split(",").map { it.trim() }
            model.draftFromCapture(text.ifBlank { model.speechNote }, parts.getOrNull(0)?.toDoubleOrNull() ?: loc?.latitude, parts.getOrNull(1)?.toDoubleOrNull() ?: loc?.longitude, loc?.accuracy)
        }) { Text("Make draft") }
        Button(onClick = { model.editDraft(text) }) { Text("Edit draft") }
        Text(model.witnessDraft, color = Color(0xFFF6F1E7))
        Text(model.witnessNote, color = Color(0xFFB7AD9E))
        Text(model.speechNote, color = Color(0xFFB7AD9E))
        Button(onClick = {
            val parts = manual.split(",").map { it.trim() }
            model.confirmWitnessSend(parts.getOrNull(0)?.toDoubleOrNull() ?: loc?.latitude, parts.getOrNull(1)?.toDoubleOrNull() ?: loc?.longitude, loc?.accuracy)
        }, modifier = Modifier.fillMaxWidth().height(64.dp), colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFD90429))) { Text("Confirm and sign") }
        Button(onClick = { model.witnessNote = model.queueHeardCut(); model.refresh() }) { Text("Queue heard-cut") }
        Text(model.heardText(), color = Color.White)
        Button(onClick = { model.witnessNote = model.shareLocalEvidence(activity); model.refresh() }) { Text("Share original from this phone") }
        Button(onClick = { model.back() }) { Text("Back") }
    }
}

@Composable
private fun Sos(activity: MainActivity, model: DeskViewModel) {
    var note by remember { mutableStateOf("SOS sends a P0 packet. It does not call 112 until you confirm the dialer.") }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(model.t("sos"), color = Color.Black, modifier = Modifier.background(Color(0xFFFFE500)).padding(12.dp).fillMaxWidth(), fontSize = 32.sp, fontWeight = FontWeight.Black)
        Button(onClick = {
            val loc = model.location(activity)
            model.sendStatus("sos", "need_help", "other", 1, "unknown", "unknown", null, "SOS", null, null, loc?.latitude, loc?.longitude, loc?.accuracy, null)
            note = model.reports().firstOrNull()?.detail ?: model.t("not_reached")
        }, modifier = Modifier.fillMaxWidth().height(80.dp), colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFD90429))) { Text("SEND SOS") }
        Button(onClick = { note = model.dial112(activity) }) { Text("Open dialer for 112") }
        Text(note, color = Color.White)
        Button(onClick = { model.back() }) { Text("Stop and go back") }
    }
}

@Composable
private fun Info(model: DeskViewModel, title: String, body: String) {
    Column(Modifier.verticalScroll(rememberScrollState())) {
        Text(title, color = Color.White, fontSize = 28.sp, fontWeight = FontWeight.Black)
        Text(body, color = Color(0xFFF6F1E7))
        Button(onClick = { model.back() }) { Text("Back") }
    }
}

@Composable
private fun Messages(model: DeskViewModel) {
    var body by remember { mutableStateOf("") }
    Column {
        Text(model.t("messages"), color = Color.White, fontSize = 28.sp)
        OutlinedTextField(body, { body = it }, modifier = Modifier.fillMaxWidth())
        Button(onClick = { model.sendMessage(body); body = "" }) { Text("Queue message") }
        Text(model.messages().joinToString("\n") { it.toString() }.ifBlank { "No offline messages." }, color = Color.White)
        Button(onClick = { model.back() }) { Text("Back") }
    }
}

@Composable
private fun Contacts(activity: MainActivity, model: DeskViewModel) {
    var name by remember { mutableStateOf("") }
    var phone by remember { mutableStateOf("") }
    var note by remember { mutableStateOf("SMS is not sent automatically.") }
    Column {
        Text(model.t("contacts"), color = Color.White, fontSize = 28.sp)
        OutlinedTextField(name, { name = it }, label = { Text("Name") })
        OutlinedTextField(phone, { phone = it }, label = { Text("Phone") })
        Button(onClick = { model.addContact(name, phone); name = ""; phone = "" }) { Text("Save contact") }
        model.contacts().forEach { (id, n, p) ->
            Text("$n $p", color = Color.White)
            Button(onClick = {
                val intent = android.content.Intent(android.content.Intent.ACTION_SENDTO, android.net.Uri.parse("smsto:$p"))
                note = if (intent.resolveActivity(activity.packageManager) == null) "No SMS app. Message was not sent." else { activity.startActivity(intent); "Opened the SMS app. You must press send." }
            }) { Text("Open SMS") }
            Button(onClick = { model.deleteContact(id) }) { Text("Delete") }
        }
        Text(note, color = Color(0xFFF0C14B))
        Button(onClick = { model.back() }) { Text("Back") }
    }
}

@Composable
private fun Settings(model: DeskViewModel) {
    var url by remember { mutableStateOf(model.gateway()) }
    var confirmLab by remember { mutableStateOf(false) }
    var confirmWipe by remember { mutableStateOf(false) }
    Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(model.t("settings"), color = Color.White, fontSize = 28.sp)
        Row {
            Button(onClick = { model.setLang("en") }) { Text("English") }
            Button(onClick = { model.setLang("hi") }) { Text("हिन्दी") }
            Button(onClick = { model.setLang("mr") }) { Text("मराठी") }
        }
        Button(onClick = { model.toggleRelay() }) { Text(if (model.relayOn()) "Relay on" else "Relay off") }
        OutlinedTextField(url, { url = it }, label = { Text("Command center URL") }, modifier = Modifier.fillMaxWidth())
        Button(onClick = { model.setGateway(url) }) { Text("Save URL") }
        Text(if (url.startsWith("http://")) "UNENCRYPTED LAB CONNECTION" else "HTTPS preferred.", color = Color(0xFFF0C14B))
        Button(onClick = { confirmLab = true }) { Text(if (model.labOn()) "Lab loopback is ON" else "Enable lab loopback") }
        if (confirmLab) {
            Text("Lab loopback is simulated. It is not a radio test. Confirm again to enable.")
            Button(onClick = { model.enableLabLoopback(); confirmLab = false }) { Text("I understand, enable simulated loopback") }
        }
        Button(onClick = { confirmWipe = true }) { Text("Delete local reports") }
        if (confirmWipe) Button(onClick = { model.wipe(); confirmWipe = false }) { Text("Confirm delete") }
        Text(model.export(), color = Color(0xFFB7AD9E))
        Button(onClick = { model.back() }) { Text("Back") }
    }
}

@Composable
private fun Rescue(model: DeskViewModel) {
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    Column {
        Text(model.t("rescue"), color = Color.White, fontSize = 28.sp)
        if (!model.responderUnlocked()) {
            Text("Authenticated responder accounts only. A civilian switch cannot grant this.", color = Color(0xFFF0C14B))
            OutlinedTextField(email, { email = it }, label = { Text("Email") })
            OutlinedTextField(password, { password = it }, label = { Text("Password") })
            Button(onClick = { model.loginResponder(email, password) }) { Text("Sign in") }
        } else {
            Text("Rescue mode is unlocked on this phone. Assignments require the command center. Offline status updates stay queued until sync. States you may record later: rescue in progress, partially resolved, resolved, handoff requested. None of these are a guarantee.")
        }
        Text(model.speechNote, color = Color.White)
        Button(onClick = { model.back() }) { Text("Back") }
    }
}

@Composable
private fun MeshScreen(activity: MainActivity, model: DeskViewModel) {
    var note by remember { mutableStateOf(meshText(activity, model)) }
    Column(Modifier.verticalScroll(rememberScrollState())) {
        Text(model.t("mesh"), color = Color.White, fontSize = 28.sp, fontWeight = FontWeight.Black)
        Text(note, color = Color(0xFFF6F1E7))
        Button(onClick = {
            (activity.application as DisasterMeshApp).mesh.scanOnce(
                { id, rssi -> note = "Seen $id rssi=$rssi. This is a radio neighbor, not a connection and not a distance." },
                { err -> note = err },
            )
        }) { Text("Scan BLE once") }
        Button(onClick = {
            val mesh = (activity.application as DisasterMeshApp).mesh
            var syncError: String? = null
            mesh.startBle { err -> syncError = err; note = err }
            if (syncError == null) note = "BLE advertise requested. A later failure replaces this line. Multi-hop remains UNVERIFIED."
        }) { Text("Start BLE advertise") }
        Button(onClick = {
            val transport = WifiDirectTransport(activity)
            transport.start { peers ->
                note = if (peers.isEmpty()) transport.lastError else peers.joinToString("\n")
            }
            note = transport.lastError
        }) { Text("Start Wi-Fi Direct discovery") }
        Button(onClick = { model.back() }) { Text("Back") }
    }
}

private fun meshText(activity: MainActivity, model: DeskViewModel): String {
    val cap = model.probe()
    return """
        Nearby devices: ${model.peers()}
        Connected peers: see capability log. A scan result is not a connection.
        Last packet: ${model.lastSync()}
        Queued outgoing: ${model.reports().count { it.delivery == "queued_offline" }}
        Relay count: ${(activity.application as DisasterMeshApp).mesh.relayCount}
        Gateway: ${model.gateway().ifBlank { "not configured" }}
        Battery-aware relay: ${if (model.relayOn()) "enabled" else "disabled"} · battery ${model.battery()?.toString() ?: "unknown"}
        Errors: ${model.meshError().ifBlank { "none" }}
        Wi-Fi Direct: ${model.wifiNote()}
        BLE advertiser present: ${cap.bleAdvertiser}. Multi-hop verified: false (UNVERIFIED).
        Troubleshooting: enable Bluetooth, location, and exempt the app from battery optimization. One GATT connection at a time is the safe assumption on many phones, including iQOO.
    """.trimIndent()
}

private fun capabilityText(model: DeskViewModel): String {
    val c = model.probe()
    return """
        Checked: ${c.checked}
        Bluetooth present/enabled: ${c.bluetoothPresent} / ${c.bluetoothEnabled}
        BLE advertiser: ${c.bleAdvertiser}
        Multiple advertisement: ${c.bleMultipleAdvertisement}
        Wi-Fi Direct API: ${c.wifiDirectPresent}
        Wi-Fi Aware: ${c.wifiAwarePresent}
        GPS feature: ${c.gpsPresent}
        Telephony: ${c.telephonyPresent}
        Camera: ${c.cameraPresent}
        Microphone: ${c.micPresent}
        Multi-hop: UNVERIFIED
        ${c.note}
        ${c.errors.joinToString()}
    """.trimIndent()
}

private fun locationText(activity: MainActivity, model: DeskViewModel): String {
    val denied = ContextCompat.checkSelfPermission(activity, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED
    val loc = model.location(activity)
    return when {
        denied -> "Location permission denied. Reports can still be queued with a manually entered place."
        loc == null -> "Location unavailable. No fake coordinates were generated."
        else -> "${loc.latitude}, ${loc.longitude}\naccuracy ${loc.accuracy} m\ntime ${loc.time}\nprovider ${loc.provider}"
    }
}
