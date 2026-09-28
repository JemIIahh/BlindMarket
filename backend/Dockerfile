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
CMD ["node", "dist/index.js"]
