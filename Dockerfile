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

# Install deps
COPY package*.json ./

RUN npm install

# Copy source and build (if a build script exists)
COPY . .

RUN npm run build 

COPY ./src/certs ./dist/certs
COPY ./src/protos ./dist/protos


# ENV REDIS_SERVER_URL=redis://host.docker.internal:6379

# Application port
EXPOSE 8000


CMD ["npm", "start"]
