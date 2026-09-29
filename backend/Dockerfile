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
CMD ["node", "dist/index.js"]
