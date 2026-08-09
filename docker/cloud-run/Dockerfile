# freshell-e2e — Cloud Run Jobs image for Playwright e2e tests.
#
# Multi-stage build:
#   1. rust-builder: compiles the freshell-server release binary
#   2. node-builder: installs npm deps (native modules) + builds dist/client + dist/server
#   3. runtime: Node.js + Playwright chromium + pre-built artifacts (no build tools)
#
# The image is self-contained: no build steps run at test time (except the
# MCP bridge's incremental tsc rebuild, which is a no-op on unchanged source).
# The entrypoint translates CLOUD_RUN_TASK_INDEX/CLOUD_RUN_TASK_COUNT into
# Playwright --shard flags and forwards pass-through args.

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
# Stage 2: Build Node.js dependencies and dist artifacts
# ---------------------------------------------------------------------------
FROM node:22-bookworm AS node-builder

ENV DEBIAN_FRONTEND=noninteractive \
    NONINTERACTIVE=1

# Build-time dependencies for native modules (node-pty):
# - build-essential + python3: needed for node-gyp (node-pty native module)
# - pkg-config + libssl-dev: needed by native modules that link against OpenSSL
# These are NOT needed in the runtime stage — only for compilation.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      python3 \
      pkg-config \
      libssl-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package manifests first for npm ci layer caching.
COPY package.json package-lock.json ./

# Install all dependencies (including devDependencies for Playwright + tsc).
RUN npm ci

# Copy all source code (.dockerignore excludes node_modules, dist, target,
# .git, .worktrees, docs, etc.).
COPY . .

# Build the client and server.
RUN npm run build:client && npm run build:server

# ---------------------------------------------------------------------------
# Stage 3: Runtime image with Node, Playwright, and pre-built artifacts
# ---------------------------------------------------------------------------
FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    NONINTERACTIVE=1

LABEL org.opencontainers.image.title="freshell-e2e" \
      org.opencontainers.image.description="Cloud Run Jobs image for Playwright e2e tests" \
      org.opencontainers.image.source="https://github.com/danshapiro/freshell" \
      org.opencontainers.image.licenses="MIT"

# Runtime system dependencies:
# - jq: needed by scripts/deploy-tab-diff.sh (called by deploy-tab-diff-rust.spec.ts)
# - ca-certificates: TLS cert bundle (already in base, explicit for clarity)
# Note: bash, curl, git, procps, ssh, and wget are all already in node:22-bookworm.
# procps provides `ps --ppid` used by the RustServer fixture (helpers/rust-server.ts).
# The Rust server uses rustls (not OpenSSL), so libssl-dev/pkg-config are NOT
# needed at runtime — only in the build stages above.
RUN apt-get update && apt-get install -y --no-install-recommends \
      jq \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Playwright chromium browser and its system dependencies.
# Must match the @playwright/test version in package.json (1.58.2).
RUN npx --yes playwright@1.58.2 install --with-deps chromium

WORKDIR /app

# Copy the pre-built Rust server binary.
COPY --from=rust-builder /build/target/release/freshell-server /app/target/release/freshell-server

# Copy pre-built node_modules and dist from the builder stage.
# This lets the runtime stage skip build-essential/python3 (native modules
# like node-pty are already compiled; tsc is a pure JS tool).
COPY --from=node-builder /app/node_modules ./node_modules
COPY --from=node-builder /app/dist ./dist

# Copy all source code (.dockerignore excludes node_modules, dist, target,
# .git, .worktrees, docs, etc. — so the builder copies above are preserved).
COPY . .

# Point the Rust server fixture at the pre-built binary (fail-closed override).
ENV FRESHELL_E2E_RUST_SERVER_BIN=/app/target/release/freshell-server

# Copy the entrypoint script (after COPY . . so it's not overwritten by
# a stale copy in the source tree).
COPY docker/cloud-run/entrypoint.sh /usr/local/bin/e2e-entrypoint.sh
RUN chmod +x /usr/local/bin/e2e-entrypoint.sh

# Basic healthcheck: verify the Node.js runtime and key artifacts are present.
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -v && test -x /app/target/release/freshell-server

ENTRYPOINT ["/usr/local/bin/e2e-entrypoint.sh"]
