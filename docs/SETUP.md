# Setup

Requires Node.js 20 or newer for the API, desk, and simulator. Android builds require JDK 17 and Android SDK 35. On 2026-09-27 this environment used JDK 17.0.20.1+1 and SDK 35, and `./gradlew :protocol:test :app:assembleDebug` exited 0. The resulting debug APK is `artifacts/disastermesh-debug.apk`. Installing it on a phone was not done here.

## Local demo without Docker

```bash
cd disastermesh
cp .env.example .env
# For a local demo only:
# set SEED_USE_DEV_DEFAULTS=1 and DM_DEV=1 and DM_ALLOW_PGLITE=1
npm ci
export DM_PGLITE_PATH="$PWD/data/pglite"
SEED_USE_DEV_DEFAULTS=1 DM_DEV=1 DM_ALLOW_PGLITE=1 npm run seed
DM_DEV=1 DM_ALLOW_PGLITE=1 npm run dev:api
```

In another terminal:

```bash
npm run dev:web
```

Without `DM_PGLITE_PATH`, PGlite is in-memory and a separate seed process does not reach the API. Use the same path for seed and the API. Open `http://127.0.0.1:5173`. Dev-only accounts, if you opted into the seed flag:

- `admin@example.invalid` / `dev-admin-pass`
- `operator@example.invalid` / `dev-operator-pass`
- `responder@example.invalid` / `dev-responder-pass`
- `publisher@example.invalid` / `dev-publisher-pass`

Do not expose those passwords. They are refused unless `SEED_USE_DEV_DEFAULTS=1`. The API binds to `127.0.0.1` unless `HTTP_HOST` says otherwise. PGlite is a local demo store. Set `DATABASE_URL` for PostgreSQL.

## Docker

Docker was not available in the build environment. The compose file is still the PostgreSQL path:

```bash
export POSTGRES_PASSWORD='replace-with-a-database-password'
export JWT_SECRET='replace-with-a-long-random-string'
docker compose up --build
```

## Tests

```bash
npm test
npm run build -w @disastermesh/command-center
```

## Android

From a machine with JDK 17 and Android SDK 35:

```bash
cd android
sdkmanager "platforms;android-35" "build-tools;35.0.0"
gradle :protocol:test :app:assembleDebug
```

The debug APK path, after a successful build, is `android/app/build/outputs/apk/debug/app-debug.apk`. GitHub Actions workflow `.github/workflows/android-apk.yml` runs those commands and uploads the APK. Do not invent a download link if the workflow has not run.

Install on a device with `adb install -r app-debug.apk`. Then follow `docs/PHYSICAL_DEVICE_TEST_PLAN.md`.

## Simulator

```bash
npm run simulate -- list
npm run simulate -- run --scenario baseline-10 --seed 42 --out /tmp/baseline.json
```

The JSON says `radioKind: SIMULATED`. Do not quote it as phone throughput.

## Git

```bash
cd disastermesh
git init
git add .
git status
git commit -m "Initial DisasterMesh prototype"
git remote add origin git@github.com:YOUR_ORG/disastermesh.git
git push -u origin main
```

Review `git status` before committing. Do not add `.env`, `data/`, or real emergency reports.
