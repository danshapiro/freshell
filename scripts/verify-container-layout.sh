#!/usr/bin/env bash
# Verify the small, explicit artifact layout used by Rust-only containers.
#
# This checker is intentionally independent of Docker. CI and local tests can
# run it against a staged directory before building an image, and its JSONL
# diagnostics make missing/forbidden paths straightforward to diagnose.
# Pass --runtime-root when the fixture also contains source-only files that are
# copied for test discovery; in that mode only shipped dist/, target/, and
# node_modules/ roots are inspected for forbidden artifacts.
set -euo pipefail

usage() {
  echo 'Usage: scripts/verify-container-layout.sh --fixture DIRECTORY [--runtime-root]' >&2
}

json_escape() {
  local value="$1"
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//$'\n'/\\n}
  value=${value//$'\r'/\\r}
  value=${value//$'\t'/\\t}
  printf '%s' "$value"
}

json_array() {
  local separator=''
  local value
  printf '['
  for value in "$@"; do
    printf '%s"%s"' "$separator" "$(json_escape "$value")"
    separator=','
  done
  printf ']'
}

emit() {
  local severity="$1"
  local event="$2"
  shift 2
  printf '{"severity":"%s","event":"%s"' "$(json_escape "$severity")" "$(json_escape "$event")"
  while (($# > 1)); do
    local key="$1"
    local value="$2"
    shift 2
    case "$key" in
      count|scanned_files)
        printf ',"%s":%s' "$(json_escape "$key")" "$value"
        ;;
      evidence_truncated)
        printf ',"%s":%s' "$(json_escape "$key")" "$value"
        ;;
      missing)
        printf ',"%s":%s' "$(json_escape "$key")" "$value"
        ;;
      *)
        printf ',"%s":"%s"' "$(json_escape "$key")" "$(json_escape "$value")"
        ;;
    esac
  done
  if (($# == 1)); then
    # The final argument is the evidence array encoded by the caller.
    printf ',"evidence":%s' "$1"
  fi
  printf '}\n'
}

fixture=''
runtime_root=false
while (($# > 0)); do
  case "$1" in
    --fixture)
      if (($# < 2)); then
        usage
        exit 2
      fi
      fixture="$2"
      shift 2
      ;;
    --runtime-root)
      runtime_root=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

# Normalize caller-supplied trailing separators before constructing scan roots;
# otherwise find emits paths with a leading slash after the prefix is stripped.
while [[ "$fixture" == */ && "$fixture" != "/" ]]; do
  fixture="${fixture%/}"
done

if [[ -z "$fixture" ]]; then
  usage
  exit 2
fi
if [[ ! -d "$fixture" ]]; then
  emit error container_layout_fixture_missing "path" "$fixture" '[]'
  exit 1
fi

find_roots=("$fixture")
if [[ "$runtime_root" == true ]]; then
  find_roots=()
  for relative_root in dist target node_modules; do
    if [[ -e "$fixture/$relative_root" ]]; then
      find_roots+=("$fixture/$relative_root")
    fi
  done
fi

evidence=()
if ((${#find_roots[@]} > 0)); then
  mapfile -t evidence < <(
    find "${find_roots[@]}" \( -type f -o -type l \) |
      sed "s#^${fixture%/}/##" |
      LC_ALL=C sort -u
  )
fi

required_paths=(
  'dist/client/index.html'
  'dist/tools/freshell-mcp/server.js'
)
missing_paths=()
for required in "${required_paths[@]}"; do
  if [[ ! -f "$fixture/$required" ]]; then
    missing_paths+=("$required")
  fi
done

server_candidates=(
  'freshell-server'
  'target/release/freshell-server'
)
server_binary=''
for candidate in "${server_candidates[@]}"; do
  if [[ -f "$fixture/$candidate" ]]; then
    server_binary="$fixture/$candidate"
    break
  fi
done
if [[ -z "$server_binary" ]]; then
  missing_paths+=("freshell-server (or target/release/freshell-server)")
fi

if ((${#missing_paths[@]} > 0)); then
  mapfile -t missing_paths < <(printf '%s\n' "${missing_paths[@]}" | LC_ALL=C sort -u)
  emit error container_layout_required_artifacts_missing \
    "path" "$fixture" \
    "missing" "$(json_array "${missing_paths[@]}")" \
    '[]'
  exit 1
fi

if [[ ! -x "$server_binary" ]]; then
  emit error container_layout_server_not_executable "path" "$server_binary" '[]'
  exit 1
fi

MAX_FORBIDDEN_EVIDENCE=20

RETIRED_BACKEND_PACKAGES=(
  '@ai-sdk/google'
  '@anthropic-ai/claude-agent-sdk'
  'ai'
  'cookie-parser'
  'express'
  'express-rate-limit'
  'pino'
  'rotating-file-stream'
  'is-port-reachable'
  '@types/cookie-parser'
  '@types/express'
  '@types/supertest'
  'supertest'
  'superwstest'
  'pino-pretty'
)
# node-gyp and glob are intentionally absent: the lockfile-installed Electron
# and transitive tooling may retain them. Only direct top-level copies of the
# retired backend package names above are forbidden; nested copies remain valid.

is_forbidden_direct_backend_package() {
  local relative="$1"
  case "$relative" in
    node_modules/*)
      ;;
    *)
      return 1
      ;;
  esac

  local package_path="${relative#node_modules/}"
  local package
  for package in "${RETIRED_BACKEND_PACKAGES[@]}"; do
    if [[ "$package_path" == "$package" || "$package_path" == "$package/"* ]]; then
      return 0
    fi
  done
  return 1
}

is_forbidden_runtime_path() {
  local relative="$1"
  case "/$relative" in
    */dist/server|*/dist/server/*|\
    */server-node-modules|*/server-node-modules/*|\
    */bundled-node|*/bundled-node/*|\
    */native-modules|*/native-modules/*|\
    */node-pty|*/node-pty/*)
      return 0
      ;;
  esac

  is_forbidden_direct_backend_package "$relative"
}

forbidden_paths=()
forbidden_count=0
for relative in "${evidence[@]}"; do
  if is_forbidden_runtime_path "$relative"; then
    ((forbidden_count += 1))
    if ((${#forbidden_paths[@]} < MAX_FORBIDDEN_EVIDENCE)); then
      forbidden_paths+=("$relative")
    fi
  fi
done

if ((forbidden_count > 0)); then
  mapfile -t forbidden_paths < <(printf '%s\n' "${forbidden_paths[@]}" | LC_ALL=C sort -u)
  evidence_truncated=false
  if ((forbidden_count > MAX_FORBIDDEN_EVIDENCE)); then
    evidence_truncated=true
  fi
  emit error container_layout_forbidden_artifacts \
    "path" "$fixture" \
    "count" "$forbidden_count" \
    "evidence_truncated" "$evidence_truncated" \
    "$(json_array "${forbidden_paths[@]}")"
  exit 1
fi

if [[ "$runtime_root" == true ]]; then
  # Runtime images can contain thousands of lockfile-installed files. A
  # successful guard emits only the bounded scalar count; failures above retain
  # a bounded, sorted sample and the total count.
  scanned_files=${#evidence[@]}
  emit info container_layout_verified \
    "path" "$fixture" \
    "scanned_files" "$scanned_files" \
    '[]'
else
  mapfile -t evidence < <(printf '%s\n' "${evidence[@]}" | LC_ALL=C sort -u)
  emit info container_layout_verified "path" "$fixture" "$(json_array "${evidence[@]}")"
fi
