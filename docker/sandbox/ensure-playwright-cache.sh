#!/usr/bin/env bash
# Keep the persistent Playwright browser cache aligned with the exact
# Playwright package installed by `npm ci`. The cache is deliberately outside
# node_modules, so lockfile refresh and browser refresh need separate stamps.
set -euo pipefail

WORKSPACE="${FRESHELL_SANDBOX_WORKSPACE:-/workspace}"
PLAYWRIGHT_CACHE="${PLAYWRIGHT_BROWSERS_PATH:-/home/sandbox/.cache/ms-playwright}"
PLAYWRIGHT_PACKAGE="${WORKSPACE}/node_modules/playwright/package.json"
PLAYWRIGHT_CLI="${WORKSPACE}/node_modules/.bin/playwright"
STAMP="${PLAYWRIGHT_CACHE}/.freshell-playwright-version"

if [ ! -f "${PLAYWRIGHT_PACKAGE}" ]; then
  exit 0
fi
if [ ! -x "${PLAYWRIGHT_CLI}" ]; then
  echo "[sandbox] ERROR: lockfile-installed Playwright CLI is missing at ${PLAYWRIGHT_CLI}" >&2
  exit 1
fi

PLAYWRIGHT_VERSION="$(
  cd "${WORKSPACE}"
  node -p "require('./node_modules/playwright/package.json').version"
)"
INSTALLED_VERSION="$(cat "${STAMP}" 2>/dev/null || true)"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_CACHE}"

run_as_sandbox() {
  if [ "$(id -u)" -eq 0 ] && id sandbox >/dev/null 2>&1; then
    gosu sandbox "$@"
  else
    "$@"
  fi
}

browser_is_executable() {
  run_as_sandbox bash -c '
    cd "$1"
    node -e '"'"'
      const fs = require("node:fs")
      const { chromium } = require("playwright")
      fs.accessSync(chromium.executablePath(), fs.constants.X_OK)
    '"'"'
  ' _ "${WORKSPACE}"
}

if [ "${INSTALLED_VERSION}" = "${PLAYWRIGHT_VERSION}" ] && browser_is_executable; then
  exit 0
fi

echo "[sandbox] refreshing Chromium for lockfile Playwright ${PLAYWRIGHT_VERSION}..." >&2
run_as_sandbox "${PLAYWRIGHT_CLI}" install chromium

if ! browser_is_executable; then
  echo "[sandbox] ERROR: Playwright ${PLAYWRIGHT_VERSION} Chromium is not executable after install" >&2
  exit 1
fi
printf '%s\n' "${PLAYWRIGHT_VERSION}" \
  | run_as_sandbox tee "${STAMP}" >/dev/null
