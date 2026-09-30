#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
npm test
npm run build -w @disastermesh/command-center
echo "JavaScript tests and command-center build finished."
echo "Android unit tests and APK are not run here unless JDK 17 and Android SDK 35 are installed."
echo "See docs/SETUP.md."
