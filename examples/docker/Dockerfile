# Minimal image demonstrating Freshell's Rust server and static client.
#
# Build:  docker build -t freshell-docker-test -f examples/docker/Dockerfile .
# Run:    docker run --rm -e AUTH_TOKEN=<at-least-16-characters> -p 3001:3001 freshell-docker-test
# Open:   http://localhost:3001/
#
# The example image intentionally contains no application Node dependency tree.
# Node is not the backend process; the final image starts the native server.

# ---------------------------------------------------------------------------
# Stage 1: compile the native backend.
# ---------------------------------------------------------------------------
FROM rust:1-bookworm AS rust-builder

WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY crates/ ./crates/
COPY extensions/ ./extensions/
RUN cargo build --release -p freshell-server --locked

# ---------------------------------------------------------------------------
# Stage 2: build the browser client with the retained JavaScript toolchain.
# ---------------------------------------------------------------------------
FROM node:24-slim AS client-builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build:client

# ---------------------------------------------------------------------------
# Stage 3: only the Rust executable and static client are shipped.
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=rust-builder /build/target/release/freshell-server /app/freshell-server
COPY --from=client-builder /app/dist/client /app/dist/client

ENV PORT=3001 \
    FRESHELL_BIND_HOST=0.0.0.0
EXPOSE 3001

CMD ["/app/freshell-server"]
