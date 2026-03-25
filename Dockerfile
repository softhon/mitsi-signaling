# Multi-stage Dockerfile for a Node.js signaling server
FROM node:24-alpine AS build

# Install build dependencies for mediasoup (Python 3, pip, C++ tools, and kernel headers)
RUN apk add --no-cache \
    python3 \
    py3-pip \
    make \
    g++ \
    gcc \
    linux-headers && \
    ln -sf python3 /usr/bin/python

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build
COPY ./src/protos ./dist/protos

# Prune devDependencies so only production modules are copied to the runtime stage
RUN npm prune --omit=dev

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:24-alpine AS runtime

# mediasoup native bindings require these libs to load under musl at runtime
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    gcc \
    linux-headers && \
    ln -sf python3 /usr/bin/python

WORKDIR /usr/src/app

# Copy already-compiled node_modules (mediasoup worker built in build stage)
COPY --from=build /usr/src/app/node_modules ./node_modules
COPY --from=build /usr/src/app/dist ./dist
COPY package*.json ./

EXPOSE 8000

CMD ["node", "dist/app.js"]
