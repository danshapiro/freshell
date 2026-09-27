# freshell-e2e — Cloud Run Jobs image for Playwright browser tests.
#
# Multi-stage build:
#   1. rust-builder: compiles the native freshell-server release binary
#   2. node-builder: installs JavaScript tooling and builds client/tools
#   3. runtime: Node + Playwright + Rust/client/tools artifacts
#
# Node remains in this image for Playwright and the retained JavaScript tooling.
# The application backend is always the Rust executable copied from stage one.

# An immutable artifact provenance input. It is deliberately an ARG rather
# than copied `.git` metadata; the build scripts validate it before use.
ARG FRESHELL_BUILD_COMMIT

# ---------------------------------------------------------------------------
# Stage 1: build the Rust server.
# ---------------------------------------------------------------------------
FROM rust:1-bookworm AS rust-builder

ARG FRESHELL_BUILD_COMMIT

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
COPY docker/runtime/provider-versions.json ./docker/runtime/provider-versions.json
RUN FRESHELL_BUILD_COMMIT="$FRESHELL_BUILD_COMMIT" cargo build --release -p freshell-server --locked

# ---------------------------------------------------------------------------
# Stage 2: build retained Node tooling and static artifacts.
# ---------------------------------------------------------------------------
FROM node:22-bookworm AS node-builder

ARG FRESHELL_BUILD_COMMIT

ENV DEBIAN_FRONTEND=noninteractive \
    NONINTERACTIVE=1

WORKDIR /app
# Workspace member manifests must precede the frozen install: pnpm resolves
# every importer listed in pnpm-workspace.yaml before touching the lock.
# Each member manifest needs its destination directory spelled out — a
# multi-file COPY into ./ flattens file sources by basename, which would
# overwrite the root package.json with the member's manifest.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY crates/freshell-claude-sidecar/package.json crates/freshell-claude-sidecar/
COPY packages/freshell-mcp-runtime/package.json packages/freshell-mcp-runtime/

# npm appears only as the pinned pnpm bootstrap (plan §7.2.2); dependency
# installation is pnpm against the workspace lock. Lifecycle scripts are
# disabled here; the final image needs only retained JS tooling and static
# artifacts around the Rust backend.
RUN npm install -g pnpm@10.34.5 \
  && pnpm install --frozen-lockfile --ignore-scripts

COPY . .
RUN FRESHELL_BUILD_COMMIT="$FRESHELL_BUILD_COMMIT" pnpm run build:client && pnpm run build:tools

# ---------------------------------------------------------------------------
# Stage 3: test runtime. Vitest behaviorally compiles isolated Rust build-script
# fixtures, so this test-only image retains the Rust toolchain. The shipped
# Freshell runtime boundary remains the staged Rust server/client/tools artifacts.
# ---------------------------------------------------------------------------
FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    NONINTERACTIVE=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:${PATH}

LABEL org.opencontainers.image.title="freshell-e2e" \
      org.opencontainers.image.description="Cloud Run Jobs image for Playwright browser tests" \
      org.opencontainers.image.source="https://github.com/danshapiro/freshell" \
      org.opencontainers.image.licenses="MIT"

RUN apt-get update && apt-get install -y --no-install-recommends \
      jq \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# The runtime entrypoint drives Vitest and Playwright with `pnpm exec`
# (plan §7.2.3), and the browser bootstrap below runs `pnpm dlx`, so the
# pinned pnpm must be installed before either can run. npm appears only as
# the pinned pnpm bootstrap (plan §7.2.2).
RUN npm install -g pnpm@10.34.5

# Must match the @playwright/test version in package.json.
RUN pnpm dlx playwright@1.58.2 install --with-deps chromium

WORKDIR /app
COPY --from=rust-builder /build/target/release/freshell-server /app/target/release/freshell-server
COPY --from=rust-builder /usr/local/cargo /usr/local/cargo
COPY --from=rust-builder /usr/local/rustup /usr/local/rustup
COPY --from=node-builder /app/dist/client ./dist/client
COPY --from=node-builder /app/dist/tools ./dist/tools
COPY --from=node-builder /app/node_modules ./node_modules

# Fail the image build if the copied test toolchain cannot execute in this
# Debian runtime. A container-level test checks the configured runtime user.
RUN cargo --version && rustc --version

# Preserve the source tree for local release checks. Build outputs and
# dependency directories are excluded by .dockerignore, so these copies cannot
# overwrite the staged artifacts.
COPY . .

# Check the assembled runtime tree after all staged artifacts are present.
# With --runtime-root the guard checks the required Rust/client/tools files and
# executable, scans only shipped dist/, target/, and node_modules/ roots,
# rejects retired artifact directories and direct top-level retired backend
# packages, and permits nested transitive packages retained by tooling.
RUN scripts/verify-container-layout.sh --fixture /app --runtime-root

ENV FRESHELL_E2E_RUST_SERVER_BIN=/app/target/release/freshell-server

# COPY's requested mode can still be narrowed by rootless build/ACL metadata.
# Normalize the copied artifact in the image layer so the final unprivileged
# runtime does not inherit host checkout permissions.
COPY --chmod=755 docker/cloud-run/entrypoint.sh /usr/local/bin/e2e-entrypoint.sh
RUN chmod 755 /usr/local/bin/e2e-entrypoint.sh \
    && chown root:root /usr/local/bin/e2e-entrypoint.sh

# The browser test harness needs an unprivileged user for permission checks.
RUN chown -R node:node /app
USER node

# Verify the final runtime user can read, syntax-check, and execute the exact
# entrypoint artifact. `--dry-run` exits before Playwright and exercises the
# image's configured ENTRYPOINT behavior without running a test workload.
RUN test -r /usr/local/bin/e2e-entrypoint.sh \
    && test -x /usr/local/bin/e2e-entrypoint.sh \
    && bash -n /usr/local/bin/e2e-entrypoint.sh \
    && /usr/local/bin/e2e-entrypoint.sh --dry-run

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD test -x /app/target/release/freshell-server \
    && test -f /app/dist/client/index.html \
    && test -f /app/dist/tools/freshell-mcp/server.js

ENTRYPOINT ["/usr/local/bin/e2e-entrypoint.sh"]
