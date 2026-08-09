# freshell-e2e — Cloud Run Jobs image for Playwright e2e tests.
#
# Multi-stage build:
#   1. rust-builder: compiles the freshell-server release binary
#   2. runtime: Node.js + Playwright chromium + built dist/ + Rust binary
#
# The image is self-contained: no build steps run at test time. The entrypoint
# translates CLOUD_RUN_TASK_INDEX/CLOUD_RUN_TASK_COUNT into Playwright --shard
# flags and forwards pass-through args.

# ---------------------------------------------------------------------------
# Stage 1: Build the Rust server binary
# ---------------------------------------------------------------------------
FROM rust:1-bookworm AS rust-builder

ENV DEBIAN_FRONTEND=noninteractive \
    RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      cmake \
      clang \
      libclang-dev \
      pkg-config \
      libssl-dev \
      perl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Copy Cargo manifests first for layer caching (dependencies build only when
# Cargo.toml/Cargo.lock change). Also copy extensions/ — some crates use
# include_str! to embed extension files at compile time.
COPY Cargo.toml Cargo.lock ./
COPY crates/ ./crates/
COPY extensions/ ./extensions/

# Build only the server binary (release profile).
RUN cargo build --release -p freshell-server

# ---------------------------------------------------------------------------
# Stage 2: Runtime image with Node, Playwright, and built artifacts
# ---------------------------------------------------------------------------
FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive

# System dependencies:
# - build-essential + python3: needed for node-gyp (node-pty native module)
# - procps: needed by the RustServer fixture (uses `ps --ppid`)
# - libssl-dev + pkg-config: needed by the server at runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      python3 \
      procps \
      pkg-config \
      libssl-dev \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Playwright chromium browser and its system dependencies.
# Must match the @playwright/test version in package.json (1.58.2).
RUN npx --yes playwright@1.58.2 install --with-deps chromium

WORKDIR /app

# Copy the pre-built Rust server binary.
COPY --from=rust-builder /build/target/release/freshell-server /app/target/release/freshell-server

# Copy package manifests first for npm ci layer caching.
COPY package.json package-lock.json ./

# Install all dependencies (including devDependencies for Playwright + tsc).
RUN npm ci

# Copy all source code (.dockerignore excludes node_modules, dist, target,
# .git, .worktrees, docs, etc.).
COPY . .

# Build the client and server.
RUN npm run build:client && npm run build:server

# Point the Rust server fixture at the pre-built binary (fail-closed override).
ENV FRESHELL_E2E_RUST_SERVER_BIN=/app/target/release/freshell-server

# Copy the entrypoint script (after COPY . . so it's not overwritten by
# a stale copy in the source tree).
COPY docker/cloud-run/entrypoint.sh /usr/local/bin/e2e-entrypoint.sh
RUN chmod +x /usr/local/bin/e2e-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/e2e-entrypoint.sh"]
