FROM node:22-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps
COPY . .
# Verbose build: if tsc fails, print the exact diagnostics before failing.
RUN npx tsc --version && \
    npx tsc -p tsconfig.json --outDir dist 2>&1 || (echo "[build] tsc failed" && cat tsconfig.json && exit 1) && \
    cp -r src/abi dist/abi && \
    cp -r agents dist/agents && \
    echo "[build] compiled successfully" && \
    ls -la dist/

FROM node:22-slim
WORKDIR /app
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --legacy-peer-deps
COPY --from=builder /app/dist ./dist
COPY agents ./agents
EXPOSE 3001
CMD ["node", "dist/index.js"]
