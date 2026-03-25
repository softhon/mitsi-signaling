# Multi-stage Dockerfile for a Node.js signaling server
FROM node:24-slim AS build

# Install build dependencies for mediasoup (Python 3, pip, C++ tools)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build
COPY ./src/protos ./dist/protos

# Prune devDependencies so only production modules are copied to the runtime stage
RUN npm prune --omit=dev

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:24-slim AS runtime

WORKDIR /usr/src/app

# Copy already-compiled node_modules (mediasoup worker built in build stage)
COPY --from=build /usr/src/app/node_modules ./node_modules
COPY --from=build /usr/src/app/dist ./dist
COPY package*.json ./

EXPOSE 8000

CMD ["node", "dist/app.js"]
