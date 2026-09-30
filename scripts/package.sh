#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist
OUT="${1:-dist/disastermesh-source.zip}"
rm -f "$OUT"
zip -r "$OUT" . \
  -x "node_modules/*" "node_modules/**" \
  -x "*/node_modules/*" "*/node_modules/**" \
  -x "dist/*" "dist/**" \
  -x "command-center/dist/*" "command-center/dist/**" \
  -x "android/.gradle/*" "android/.gradle/**" \
  -x "android/app/build/*" "android/app/build/**" \
  -x "android/protocol/build/*" "android/protocol/build/**" \
  -x ".env" \
  -x "data/*" "backend/data/*" \
  -x "*.apk" \
  -x ".git/*" ".git/**"
echo "Wrote $OUT"
unzip -t "$OUT" >/dev/null
ls -lh "$OUT"
