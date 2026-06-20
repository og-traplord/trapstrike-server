# One image for the whole backend. The match-manager runs as the entrypoint and
# spawns game-server processes (one per match) inside this container, on ports in
# the exposed range. Run via tsx — no separate build step.

FROM node:22-bookworm-slim

# openssl: WebTransport (QUIC) needs a real OpenSSL cert (not LibreSSL).
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable
WORKDIR /app

# Copy the repo (node_modules excluded via .dockerignore) and install.
COPY . .
RUN corepack pnpm install

ENV MM_HOST=0.0.0.0 \
    MM_PORT=9000 \
    PORT_BASE=8100 \
    PORT_COUNT=20 \
    MATCH_SIZE=10

EXPOSE 9000
# Game-server port range is published by docker-compose (TCP for WS, UDP for WT).

CMD ["corepack", "pnpm", "mm"]
