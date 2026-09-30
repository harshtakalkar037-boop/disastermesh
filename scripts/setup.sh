#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v node >/dev/null; then
  echo "Node.js 20+ is required." >&2
  exit 1
fi
node -e 'if (Number(process.versions.node.split(".")[0]) < 20) process.exit(1)'
if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example. Edit it before any non-local use."
fi
npm ci
echo "Setup complete. Start the API with: DM_DEV=1 DM_ALLOW_PGLITE=1 npm run dev:api"
echo "Start the desk with: npm run dev:web"
echo "This is a prototype, not a certified emergency service."
