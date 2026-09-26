#!/usr/bin/env bash
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "📦 Installing backend deps..."
cd "$ROOT/backend"
[ ! -d node_modules ] && npm install --legacy-peer-deps --silent
[ ! -d node_modules/ai ] && npm install ai @ai-sdk/openai @ai-sdk/anthropic @ai-sdk/google @ai-sdk/groq --legacy-peer-deps --silent

echo "📦 Installing dashboard deps..."
cd "$ROOT/dashboard"
[ ! -d node_modules ] && npm install --legacy-peer-deps --silent

echo "🚀 Starting backend + dashboard..."
# Stack select: ./dev.sh [local|testnet|production] (default local).
# testnet/production overlay backend/.env.<stack> via node's --env-file,
# before dotenv loads backend/.env: keys set in the overlay win, the rest
# falls back to backend/.env. (--env-file is refused in NODE_OPTIONS, so the
# tsx CLI is launched through node directly for those stacks.) Real deploys
# don't use this — the hosting dashboard provides the environment directly.
STACK="${1:-local}"
BACKEND_CMD="npm run dev"
case "$STACK" in
  local) ;;
  testnet|production)
    ENV_FILE="$ROOT/backend/.env.$STACK"
    [ -f "$ENV_FILE" ] || { echo "❌ missing $ENV_FILE"; exit 1; }
    BACKEND_CMD="node --env-file=$ENV_FILE ./node_modules/tsx/dist/cli.mjs watch src/index.ts"
    echo "   Stack     → $STACK ($ENV_FILE)"
    ;;
  *) echo "usage: ./dev.sh [local|testnet|production]"; exit 1 ;;
esac
# Start backend in background, dashboard in foreground
# shellcheck disable=SC2086
$BACKEND_CMD &
BACKEND_PID=$!

cd "$ROOT/dashboard"
npm run dev &
DASHBOARD_PID=$!

echo ""
echo "✅ Running:"
echo "   Backend   → http://localhost:3001"
echo "   Dashboard → http://localhost:5173"
echo "   Marketplace → http://localhost:5173/agents/marketplace"
echo "   Deploy    → http://localhost:5173/agents/deploy"
echo ""
echo "Press Ctrl+C to stop both."

# Kill both on exit
trap "kill $BACKEND_PID $DASHBOARD_PID 2>/dev/null" EXIT
wait
