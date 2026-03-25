# Multi-stage Dockerfile for a Node.js signaling server
FROM node:24-alpine AS build

# Install build dependencies for mediasoup (Python 3, C++ tools, and kernel headers)
RUN apk add --no-cache \
    python3 \
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

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:24-alpine AS runtime

# Keep native build tools so mediasoup bindings load under musl
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    gcc \
    linux-headers && \
    ln -sf python3 /usr/bin/python

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /usr/src/app/dist ./dist

EXPOSE 8000

CMD ["node", "dist/app.js"]
