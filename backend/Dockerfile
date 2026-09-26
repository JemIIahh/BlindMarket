FROM node:22-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps
COPY . .
# Separate verbose steps so Docker prints the exact failing command output.
RUN echo "[build] tsc version:" && npx tsc --version
RUN npx tsc -p tsconfig.json --outDir dist
RUN cp -r src/abi dist/abi && cp -r agents dist/agents && ls -la dist/

FROM node:22-slim
WORKDIR /app
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --legacy-peer-deps
COPY --from=builder /app/dist ./dist
COPY agents ./agents
EXPOSE 3001
CMD ["node", "dist/index.js"]
