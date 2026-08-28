# freshell-e2e — Cloud Run Jobs image for Playwright browser tests.
#
# Multi-stage build:
#   1. rust-builder: compiles the native freshell-server release binary
#   2. node-builder: installs JavaScript tooling and builds client/tools
#   3. runtime: Node + Playwright + Rust/client/tools artifacts
#
# Node remains in this image for Playwright and the retained JavaScript tooling.
# The application backend is always the Rust executable copied from stage one.

# ---------------------------------------------------------------------------
# Stage 1: build the Rust server.
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
COPY Cargo.toml Cargo.lock ./
COPY crates/ ./crates/
COPY extensions/ ./extensions/
RUN cargo build --release -p freshell-server --locked

# ---------------------------------------------------------------------------
# Stage 2: build retained Node tooling and static artifacts.
# ---------------------------------------------------------------------------
FROM node:22-bookworm AS node-builder

ENV DEBIAN_FRONTEND=noninteractive \
    NONINTERACTIVE=1

WORKDIR /app
COPY package.json package-lock.json ./

# Lifecycle scripts are disabled here; the final image needs only retained JS
# tooling and static artifacts around the Rust backend.
RUN npm ci --ignore-scripts

COPY . .
RUN npm run build:client && npm run build:tools

# ---------------------------------------------------------------------------
# Stage 3: test runtime with no compiler toolchain.
# ---------------------------------------------------------------------------
FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    NONINTERACTIVE=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

LABEL org.opencontainers.image.title="freshell-e2e" \
      org.opencontainers.image.description="Cloud Run Jobs image for Playwright browser tests" \
      org.opencontainers.image.source="https://github.com/danshapiro/freshell" \
      org.opencontainers.image.licenses="MIT"

RUN apt-get update && apt-get install -y --no-install-recommends \
      jq \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Must match the @playwright/test version in package.json.
RUN npx --yes playwright@1.58.2 install --with-deps chromium

WORKDIR /app
COPY --from=rust-builder /build/target/release/freshell-server /app/target/release/freshell-server
COPY --from=node-builder /app/dist/client ./dist/client
COPY --from=node-builder /app/dist/tools ./dist/tools
COPY --from=node-builder /app/node_modules ./node_modules

# Preserve the source tree for local release checks. Build outputs and
# dependency directories are excluded by .dockerignore, so these copies cannot
# overwrite the staged artifacts.
COPY . .

# Check the assembled runtime tree after all staged artifacts are present.
# With --runtime-root the guard checks the required Rust/client/tools files and
# executable, scans only shipped dist/, target/, and node_modules/ roots,
# rejects retired artifact directories, node-pty, and direct top-level retired
# backend packages, and permits nested transitive packages retained by tooling.
RUN scripts/verify-container-layout.sh --fixture /app --runtime-root

ENV FRESHELL_E2E_RUST_SERVER_BIN=/app/target/release/freshell-server

COPY docker/cloud-run/entrypoint.sh /usr/local/bin/e2e-entrypoint.sh
RUN chmod +x /usr/local/bin/e2e-entrypoint.sh

# The browser test harness needs an unprivileged user for permission checks.
RUN chown -R node:node /app
USER node

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD test -x /app/target/release/freshell-server \
    && test -f /app/dist/client/index.html \
    && test -f /app/dist/tools/freshell-mcp/server.js

ENTRYPOINT ["/usr/local/bin/e2e-entrypoint.sh"]
