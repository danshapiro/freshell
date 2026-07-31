#!/usr/bin/env bash
# Shared sandbox-image inputs. This file is sourced by sandbox-build.sh and
# sandbox-test.sh so cache validation always matches the image being built.

sandbox_playwright_version() {
  local repo_root="${1:?repository root is required}"

  node -e '
    const lock = require(process.argv[1])
    const version = lock.packages?.["node_modules/playwright"]?.version
    if (!version) throw new Error("package-lock.json does not resolve playwright")
    process.stdout.write(version)
  ' "${repo_root}/package-lock.json"
}

sandbox_image_definition_sha256() {
  local repo_root="${1:?repository root is required}"
  local playwright_version="${2:?Playwright version is required}"
  local sandbox_uid="${3:?sandbox UID is required}"
  local sandbox_gid="${4:?sandbox GID is required}"

  {
    sha256sum \
      "${repo_root}/docker/sandbox/Dockerfile" \
      "${repo_root}/docker/sandbox/entrypoint.sh" \
      "${repo_root}/docker/sandbox/ensure-playwright-cache.sh" \
      | awk '{print $1}'
    printf 'playwright=%s\nuid=%s\ngid=%s\n' \
      "${playwright_version}" \
      "${sandbox_uid}" \
      "${sandbox_gid}"
  } \
    | sha256sum \
    | awk '{print $1}'
}
