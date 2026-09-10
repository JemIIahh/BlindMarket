#!/bin/bash
# Relay sponsorship check — runs Step 2 of the Base runbook in three forms and
# prints, for each, the backend's mapped error AND Privy's raw words from the
# backend log. Privy's SDK documents two distinct features:
#   app-pays  : sponsor:true                      (Privy fronts gas, app billed)
#   user-pays : sponsor:true + sponsor_options    (user pays gas in `asset`)
# They are configured separately, so each is tested on its own. The third form
# is the control that is already known to pass.
#
# Every form sends approve(escrow, 0) on USDC — a no-op on-chain. Only the
# control actually broadcasts (costs ~0.0000002 ETH); the first two fail at
# Privy before any transaction exists unless sponsorship is on.
#
# Usage: backend/scripts/relay-sponsorship-check.sh [API_BASE]
set -u
API=${1:-http://localhost:3001}
ENV=/Users/ram/Desktop/BlindBounty/backend/.env
LOG=/tmp/bm-run.log
KEY=$(grep '^BLINDMARKET_API_KEY=' "$ENV" | cut -d= -f2-)
W=0x86406368be315f02Fb36b319afF646341c0190c4
USDC=0x036CbD53842c5426634e7929541eC2318f3dCF7e
DATA=0x095ea7b3000000000000000000000000cca5ab873158b888158ad9dc36fb4ee683efbebf0000000000000000000000000000000000000000000000000000000000000000

run() { # label, json-tail
  local label=$1 tail=$2
  local before; before=$(grep -c "relay-tx] Full error" "$LOG" 2>/dev/null || echo 0)
  local out; out=$(curl -s --max-time 90 -X POST "$API/api/v1/tx/relay-tx" \
    -H "Content-Type: application/json" -H "X-API-Key: $KEY" \
    -d "{\"walletAddress\":\"$W\",\"to\":\"$USDC\",\"data\":\"$DATA\",\"chain\":\"base-sepolia\"$tail}")
  echo "── $label"
  echo "   backend : $(echo "$out" | head -c 220)"
  local gas; gas=$(echo "$out" | grep -oE '"gas":"[a-z-]+"' | head -1)
  [ -n "$gas" ] && echo "   paid via: $gas"
  sleep 1
  local after; after=$(grep -c "relay-tx] Full error" "$LOG" 2>/dev/null || echo 0)
  if [ "$after" -gt "$before" ]; then
    echo "   privy   : $(grep -A6 'relay-tx] Full error' "$LOG" | grep '"error"' | tail -1 | sed 's/^ *//')"
  else
    echo "   privy   : (no error logged — accepted)"
  fi
}

echo "relay sponsorship check — $(date -u +%FT%TZ) — $API"
run "A) app-pays   sponsor:true, no asset"        ""
run "B) user-pays  sponsor:true, asset:usdc"      ',"asset":"usdc"'
run "C) control    sponsor:false (wallet pays)"   ',"sponsor":false'
run "D) auto       gas:auto (what clients send)"  ',"asset":"usdc","gas":"auto"'
echo
echo "Reading D: gas=user-pays means USDC gas is live (the product claim);"
echo "gas=app-pays means sponsorship is on but USDC gas is not; gas=wallet-pays means"
echo "neither is on and the wallet paid its own ETH. A and B say which toggle is missing."
