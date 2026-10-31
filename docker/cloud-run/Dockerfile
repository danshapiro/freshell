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
FROM rust:1.96.0-bookworm AS rust-builder

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
COPY docker/runtime/codex-native-sandbox.json ./docker/runtime/codex-native-sandbox.json
RUN rustc --version && cargo --version \
    && FRESHELL_BUILD_COMMIT="$FRESHELL_BUILD_COMMIT" cargo build --release -p freshell-server --locked
# Compile the real-client requirement guard before entering native test lanes.
RUN set -eu; cargo test --release -p freshell-codex --features native-policy-qualification --lib --no-run --locked \
    ; set -- target/release/deps/freshell_codex-* \
    ; count=0; for probe in "$@"; do \
         if [ -f "$probe" ] && [ -x "$probe" ]; then \
           cp "$probe" /build/codex-policy-client-probe; count=$((count + 1)); \
         fi; \
       done; test "$count" -eq 1 \
    && chmod 755 /build/codex-policy-client-probe \
    && sha256sum /build/codex-policy-client-probe > /build/codex-policy-client-probe.sha256

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
RUN node scripts/testing/prepare-codex-contract.mjs --output /opt/freshell-test-providers/codex/0.164.0-linux-x64
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
COPY --from=rust-builder /build/codex-policy-client-probe /opt/freshell-test-providers/codex/policy-client-probe
COPY --from=rust-builder /build/codex-policy-client-probe.sha256 /opt/freshell-test-providers/codex/policy-client-probe.sha256
COPY --from=rust-builder /usr/local/cargo /usr/local/cargo
COPY --from=rust-builder /usr/local/rustup /usr/local/rustup
COPY --from=node-builder /app/dist/client ./dist/client
COPY --from=node-builder /app/dist/tools ./dist/tools
COPY --from=node-builder /app/node_modules ./node_modules
# The pinned Claude contract exercises the isolated sidecar package directly.
# Its node_modules links back to the root pnpm store copied above.
COPY --from=node-builder /app/crates/freshell-claude-sidecar/node_modules ./crates/freshell-claude-sidecar/node_modules
COPY --from=node-builder /opt/freshell-test-providers/codex/0.164.0-linux-x64 /opt/freshell-test-providers/codex/0.164.0-linux-x64

# Fail the image build if the copied test toolchain cannot execute in this
# Debian runtime. A container-level test checks the configured runtime user.
RUN cargo --version && rustc --version

# Preserve the source tree for local release checks. Build outputs and
# dependency directories are excluded by .dockerignore, so these copies cannot
# overwrite the staged artifacts.
COPY . .

# This controlled test-only requirements layer enables the native network
# approval controller. No production runtime image receives it.
RUN node --input-type=module -e 'import fs from "node:fs"; import { CODEX_NETWORK_REQUIREMENTS } from "./test/integration/providers/codex-local-provider.mjs"; fs.mkdirSync("/etc/codex", { recursive: true }); fs.writeFileSync("/etc/codex/requirements.toml", CODEX_NETWORK_REQUIREMENTS, { mode: 0o644 })'

# Check the assembled runtime tree after all staged artifacts are present.
# With --runtime-root the guard checks the required Rust/client/tools files and
# executable, scans only shipped dist/, target/, and node_modules/ roots,
# rejects retired artifact directories and direct top-level retired backend
# packages, and permits nested transitive packages retained by tooling.
RUN scripts/verify-container-layout.sh --fixture /app --runtime-root

ENV FRESHELL_E2E_RUST_SERVER_BIN=/app/target/release/freshell-server
ENV FRESHELL_CODEX_CONTRACT_ROOT=/opt/freshell-test-providers/codex/0.164.0-linux-x64
ENV FRESHELL_CODEX_CONTRACT_CAPTURE_STDOUT=1
ENV FRESHELL_CODEX_POLICY_CLIENT_PROBE=/opt/freshell-test-providers/codex/policy-client-probe

# COPY's requested mode can still be narrowed by rootless build/ACL metadata.
# Normalize the copied artifact in the image layer so the final unprivileged
# runtime does not inherit host checkout permissions.
COPY --chmod=755 docker/cloud-run/entrypoint.sh /usr/local/bin/e2e-entrypoint.sh
RUN chmod 755 /usr/local/bin/e2e-entrypoint.sh \
    && chown root:root /usr/local/bin/e2e-entrypoint.sh

# The browser test harness needs an unprivileged user for permission checks.
RUN chown -R node:node /app
USER node

# Verify the complete copied native tree as the final runtime identity,
# including /opt ancestors outside /app's ownership adjustment.
RUN node --input-type=module -e 'import { verifyArtifact, verifyPolicyClientProbe } from "./scripts/testing/prepare-codex-contract.mjs"; await verifyArtifact(process.env.FRESHELL_CODEX_CONTRACT_ROOT); await verifyPolicyClientProbe(process.env.FRESHELL_CODEX_POLICY_CLIENT_PROBE)'

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
