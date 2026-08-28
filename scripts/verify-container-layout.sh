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
  for value in "$@"; do
    printf '%s"%s"' "$separator" "$(json_escape "$value")"
    separator=','
  done
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
    printf ',"%s":"%s"' "$(json_escape "$key")" "$(json_escape "$value")"
  done
  if (($# == 1)); then
    # The final argument is the sorted evidence array encoded by the caller.
    printf ',"evidence":[%s]' "$1"
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
  emit error container_layout_required_artifacts_missing "path" "$fixture" "$(json_array "${missing_paths[@]}")"
  exit 1
fi

if [[ ! -x "$server_binary" ]]; then
  emit error container_layout_server_not_executable "path" "$server_binary" '[]'
  exit 1
fi

forbidden_prefixes=(
  '/dist/server'
  '/server-node-modules'
  '/bundled-node'
  '/native-modules'
  '/node-pty'
  '/node-gyp'
  '/node_modules/@ai-sdk/google'
  '/node_modules/@anthropic-ai/claude-agent-sdk'
  '/node_modules/ai'
  '/node_modules/cookie-parser'
  '/node_modules/express'
  '/node_modules/express-rate-limit'
  '/node_modules/glob'
  '/node_modules/node-pty'
  '/node_modules/pino'
  '/node_modules/rotating-file-stream'
  '/node_modules/is-port-reachable'
  '/node_modules/@types/cookie-parser'
  '/node_modules/@types/express'
  '/node_modules/@types/supertest'
  '/node_modules/supertest'
  '/node_modules/superwstest'
  '/node_modules/pino-pretty'
)

forbidden_paths=()
for relative in "${evidence[@]}"; do
  candidate="/$relative"
  for prefix in "${forbidden_prefixes[@]}"; do
    case "$candidate" in
      "$prefix"|"$prefix"/*)
        forbidden_paths+=("$relative")
        break
        ;;
    esac
  done
done

if ((${#forbidden_paths[@]} > 0)); then
  mapfile -t forbidden_paths < <(printf '%s\n' "${forbidden_paths[@]}" | LC_ALL=C sort -u)
  emit error container_layout_forbidden_artifacts "path" "$fixture" "$(json_array "${forbidden_paths[@]}")"
  exit 1
fi

mapfile -t evidence < <(printf '%s\n' "${evidence[@]}" | LC_ALL=C sort -u)
emit info container_layout_verified "path" "$fixture" "$(json_array "${evidence[@]}")"
