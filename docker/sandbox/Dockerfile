# freshell-sandbox — disposable build/test environment for destructive and
# ops-style suites (process kills, config corruption, restart storms) and
# agent verification runs. See docs/development/test-sandbox.md.
#
# Base image decision: node:22-trixie, not mcr.microsoft.com/playwright:*.
# Rationale: the repo pins Node via .nvmrc/engines (>=22.5.0); the official
# Playwright image bundles whatever Node version Microsoft chose for that
# release, which is not guaranteed to satisfy our engines requirement. It is
# more reliable to pin Node ourselves and layer in Rust (via rustup, a single
# curl step) and Playwright's own `playwright install --with-deps` (which
# installs exactly the system libraries its pinned browser build needs) than
# to reverse-engineer what a third-party base image ships.
#
# Debian generation: TRIXIE (Debian 13, glibc 2.41), not bookworm (glibc
# 2.36). The packaged freshell-server binary this sandbox must run (the
# native agent-verification smoke stages the real electron-runtime build)
# needs glibc >= 2.38 — bookworm's loader rejected it with
# `/lib/x86_64-linux-gnu/libc.so.6: version GLIBC_2.38 not found`.
FROM node:22-trixie

ENV DEBIAN_FRONTEND=noninteractive \
    RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH

# Build tooling for the Rust workspace (cmake/clang/perl cover aws-lc-sys and
# similar TLS crates that need to compile native code + generate bindings)
# plus git/curl for rustup and cargo's own network operations. gosu drops
# root privileges cleanly (true exec, unlike su) once the entrypoint has
# fixed up ownership of freshly-created named volumes (see entrypoint.sh).
# DBus supports desktop integration; freshell-tauri's Linux webview and
# default tray feature need GTK3, WebKit2GTK 4.1 (including libsoup3), and
# Ayatana AppIndicator headers/link libraries for full-workspace tests.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      cmake \
      clang \
      libclang-dev \
      pkg-config \
      libssl-dev \
      libdbus-1-dev \
      libgtk-3-dev \
      libwebkit2gtk-4.1-dev \
      libayatana-appindicator3-dev \
      perl \
      git \
      curl \
      ca-certificates \
      gosu \
    && rm -rf /var/lib/apt/lists/*

# rustup + stable toolchain (the workspace has no rust-toolchain.toml; the
# host build machine tracks stable, so the sandbox does too).
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --default-toolchain stable --profile default \
    && rustup component add rustfmt clippy

# The pinned pnpm (plan §7.3.1), installed via the same npm bootstrap as
# docker/cloud-run/Dockerfile and examples/docker/Dockerfile. npm stays in
# the image for legacy npm-era branches: docker/sandbox/entrypoint.sh
# selects the manager per tree (packageManager field, else lock presence),
# so old package-lock.json-only branches keep their `npm ci` path. pnpm's
# per-user store and state land under the sandbox user's HOME
# (/home/sandbox, sandbox-owned by construction), so no extra chown or
# VOLUME entries are needed for it.
RUN npm install -g pnpm@10.34.5

# pnpm's default store-path resolution probes the project root's
# writability (it touches a temp file next to the root manifest); on the
# read-only bind-mounted repo that EACCES would fail any in-container pnpm
# invocation. Pin the store explicitly for ad-hoc commands — the
# entrypoint's install passes the same path on its command line.
ENV npm_config_store_dir=/home/sandbox/.local/share/pnpm/store

# Non-root user matching the invoking operator's UID/GID (passed as build
# args by scripts/sandbox-build.sh) so files written through the bind-mounted
# repo keep sane host-side ownership instead of ending up root-owned.
#
# node:22-trixie already ships a "node" user at UID/GID 1000 (the single-
# user Linux/WSL default, and this operator's UID too) — useradd would fail
# with "UID already in use" in that common case. So: if the requested UID is
# already taken, rename that existing user to "sandbox" instead of creating a
# duplicate; only fall back to a fresh useradd when the UID is free.
ARG UID=1000
ARG GID=1000
RUN if getent passwd "${UID}" >/dev/null 2>&1; then \
      EXISTING_NAME="$(getent passwd "${UID}" | cut -d: -f1)"; \
      if [ "${EXISTING_NAME}" != "sandbox" ]; then \
        usermod -l sandbox -g "${GID}" -d /home/sandbox -m "${EXISTING_NAME}"; \
      fi; \
    else \
      (getent group "${GID}" >/dev/null 2>&1 || groupadd -g "${GID}" sandbox); \
      useradd -m -u "${UID}" -g "${GID}" -s /bin/bash sandbox; \
    fi \
    && chown -R "${UID}:${GID}" /usr/local/cargo /usr/local/rustup

# Playwright's own installer needs its system dependency list resolved once
# a browser version is known (that happens per-run from package.json at
# runtime), so we only pre-install the OS libraries here as a cache-friendly
# base layer; browser binaries are fetched into a cache volume on first use.
#
# The pinned version must track package-lock.json's resolved @playwright/test
# (1.58.2 today): each Playwright release hardcodes the browser build + its
# distro package list, and the list is DISTRO-AWARE — an older Playwright
# (1.52) does not know Debian trixie and its install-deps FAILS here. The
# `|| true` that used to guard this step silently shipped a browser-less
# image on the bookworm->trixie rebase (libnspr4.so missing at launch);
# a failed dependency install must fail the BUILD loudly instead.
RUN npx --yes playwright@1.58.2 install-deps chromium

COPY --chmod=755 entrypoint.sh /usr/local/bin/sandbox-entrypoint.sh

WORKDIR /workspace

# The container starts as root (not USER sandbox): named volumes Docker
# creates fresh at runtime (cargo registry/git, the sandbox-owned
# node_modules/target under the bind-mounted /workspace) are root-owned by
# default, and a non-root PID 1 couldn't chown them. entrypoint.sh fixes
# ownership on first use of each volume, then drops to "sandbox" via gosu
# (a true exec, not su/sudo) before running the caller's command — the
# caller's command never runs as root.
ENTRYPOINT ["/usr/local/bin/sandbox-entrypoint.sh"]
CMD ["bash"]
