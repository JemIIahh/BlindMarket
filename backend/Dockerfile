FROM node:22-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps
COPY . .
RUN echo "[build] tsc version:" && npx tsc --version
# Capture tsc output to a file and print it; BuildKit sometimes swallows stderr of failed RUNs.
RUN npx tsc -p tsconfig.json --outDir dist > /tmp/tsc.log 2>&1; if [ $? -ne 0 ]; then echo "[build] tsc failed with:"; cat /tmp/tsc.log; exit 1; fi; cat /tmp/tsc.log
RUN cp -r src/abi dist/abi && cp -r agents dist/agents && ls -la dist/

FROM node:22-slim
WORKDIR /app
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --legacy-peer-deps
COPY --from=builder /app/dist ./dist
COPY agents ./agents
# agents/worker.js (forked per deployed agent) imports ../src/services/crypto.js
# and ../src/services/egressGuard.js. In dev tsx resolves those to the .ts
# sources; the image ships no src/, so plant the compiled modules at the path
# the worker expects. Both modules are self-contained (node builtins + prod
# deps only), so no other dist files need to follow them.
COPY --from=builder /app/dist/services/crypto.js ./src/services/crypto.js
COPY --from=builder /app/dist/services/egressGuard.js ./src/services/egressGuard.js
# The worker also reads ../src/abi/BlindEscrow.json. Without it verifier duty
# never settles ("signer/escrow not configured") and escrow reverts go undecoded.
COPY src/abi/BlindEscrow.json ./src/abi/BlindEscrow.json
# Fail the build, not every agent at runtime, if something the worker loads
# from outside agents/ is missing: each ../ module it imports, and the ABI.
RUN node --import tsx/esm --input-type=module -e "import { readFileSync } from 'node:fs'; import { pathToFileURL } from 'node:url'; const worker = pathToFileURL('agents/worker.js'); for (const [, spec] of readFileSync('agents/worker.js', 'utf8').matchAll(/from '(\.\.\/[^']+)'/g)) { await import(new URL(spec, worker)); console.log('[build] worker import resolves:', spec); } JSON.parse(readFileSync('src/abi/BlindEscrow.json', 'utf8')); console.log('[build] worker escrow ABI present');"
CMD ["node", "dist/index.js"]
