# Android app

Package `app.disastermesh`. Minimum SDK 26. Compile SDK 35. JDK 17.

The phone app is the civilian and responder client. Primary buttons write a signed DMSP/1 packet into SQLite and then try a real GATT write or an HTTP sync. If neither is possible, the report stays `queued_offline` and the screen says rescuers have not received it.

## Build

Compiled in this environment on 2026-09-27 with JDK 17 and SDK 35. Exact command:

```bash
cd android
export JAVA_HOME=/path/to/jdk-17
export ANDROID_HOME=/path/to/android-sdk
./gradlew :protocol:test :app:assembleDebug
```

That command exited 0 here. Debug APK: `app/build/outputs/apk/debug/app-debug.apk`, also copied to `artifacts/disastermesh-debug.apk`. A built APK is not a device test.

`protocol` tests load `shared-protocol/fixtures/vectors.json` and must be run from the repo so the relative path resolves. They check that the Kotlin verifier accepts packets produced by the Node codec, including a relay hop that does not resign.

## Unverified

BLE, Wi-Fi Direct, and three-phone relay were not executed in the authoring environment. The capability screen starts as a live probe, not a hardcoded "supported". Multi-hop stays UNVERIFIED until `docs/PHYSICAL_DEVICE_TEST_PLAN.md` is filled in from observation.
