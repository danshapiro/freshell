#!/usr/bin/env bash
# Exercise the real wrapper and image with cold, test-owned volumes. No
# destructive command runs on the host; the tiny dependencies need the network
# during preparation but must work offline in the actual runtime container.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE_TAG=freshell-sandbox:latest
CALLER_UID="$(id -u)"
CALLER_GID="$(id -g)"
FIXTURE="$(mktemp -d -t freshell-sandbox-startup.XXXXXXXX)"
export FRESHELL_SANDBOX_CACHE_PREFIX="freshell-startup-${FIXTURE##*.}"
TARGET_CACHE_VOLUME=""
TARGET_CACHE_WORKTREE_SHA256=""
CACHE_VOLUMES=()
for suffix in cargo-registry cargo-git pnpm-store node-modules sidecar-node-modules mcp-node-modules playwright-cache; do
  CACHE_VOLUMES+=("${FRESHELL_SANDBOX_CACHE_PREFIX}-${suffix}")
done
target_volume_exists() {
  local names
  names="$(docker volume ls --format '{{.Name}}' --filter "name=${TARGET_CACHE_VOLUME}")" || return 2
  printf '%s\n' "${names}" | grep -Fxq -- "${TARGET_CACHE_VOLUME}"
}
target_cache_labels_match() {
  local labels
  labels="$(docker volume inspect --format '{{json .Labels}}' "${TARGET_CACHE_VOLUME}")" || return 1
  python3 - "${labels}" "${TARGET_CACHE_WORKTREE_SHA256}" <<'PY'
import json
import sys
try:
    labels = json.loads(sys.argv[1])
except (TypeError, json.JSONDecodeError):
    raise SystemExit(1)
expected = {
    "com.freshell.cache.owner": "freshell",
    "com.freshell.cache.purpose": "rust-target",
    "com.freshell.cache.schema": "1",
    "com.freshell.cache.worktree-sha256": sys.argv[2],
}
raise SystemExit(0 if isinstance(labels, dict) and all(labels.get(key) == value for key, value in expected.items()) else 1)
PY
}
cleanup() {
  local status=$? cleanup_failed=0 refs
  trap - EXIT
  if [ -n "${TARGET_CACHE_VOLUME}" ]; then
    if target_volume_exists; then
      if ! target_cache_labels_match; then
        printf '{"severity":"error","event":"sandbox_startup_target_cleanup_labels_unverified"}\n' >&2
        cleanup_failed=1
      elif ! refs="$(docker ps -aq --filter "volume=${TARGET_CACHE_VOLUME}")"; then
        printf '{"severity":"error","event":"sandbox_startup_target_cleanup_reference_check_failed"}\n' >&2
        cleanup_failed=1
      elif [ -n "${refs}" ]; then
        printf '{"severity":"error","event":"sandbox_startup_target_cleanup_still_referenced"}\n' >&2
        cleanup_failed=1
      elif ! docker volume rm "${TARGET_CACHE_VOLUME}" >/dev/null 2>&1; then
        printf '{"severity":"error","event":"sandbox_startup_target_cleanup_failed"}\n' >&2
        cleanup_failed=1
      fi
    else
      local volume_status=$?
      if [ "${volume_status}" -ne 1 ]; then
        printf '{"severity":"error","event":"sandbox_startup_target_cleanup_inspection_failed"}\n' >&2
        cleanup_failed=1
      fi
    fi
  fi
  docker volume rm "${CACHE_VOLUMES[@]}" >/dev/null 2>&1 || true
  rm -rf "${FIXTURE}"
  if [ "${status}" -eq 0 ] && [ "${cleanup_failed}" -ne 0 ]; then status=1; fi
  exit "${status}"
}
trap cleanup EXIT

# Match the wrapper's canonical working-copy identity, independently of the
# seven private dependency caches above. Only this temporary copy is owned.
FIXTURE="$(cd "${FIXTURE}" && pwd -P)"
if command -v sha256sum >/dev/null 2>&1; then
  TARGET_CACHE_WORKTREE_SHA256="$(printf '%s' "${FIXTURE}" | sha256sum)"
else
  TARGET_CACHE_WORKTREE_SHA256="$(printf '%s' "${FIXTURE}" | shasum -a 256)"
fi
TARGET_CACHE_WORKTREE_SHA256="${TARGET_CACHE_WORKTREE_SHA256%% *}"
[[ "${TARGET_CACHE_WORKTREE_SHA256}" =~ ^[a-f0-9]{64}$ ]]
TARGET_CACHE_VOLUME="freshell-sandbox-rust-target-v1-${TARGET_CACHE_WORKTREE_SHA256:0:24}"

assert_fixture_ownership() {
  local foreign_entry
  foreign_entry="$(find "${FIXTURE}" \( ! -uid "${CALLER_UID}" -o ! -gid "${CALLER_GID}" \) -printf '%p (%U:%G)\n' -quit)"
  if [ -n "${foreign_entry}" ]; then
    echo "FAIL: fixture preparation changed caller ownership: ${foreign_entry}" >&2
    exit 1
  fi
}

docker image inspect "${IMAGE_TAG}" >/dev/null
bash "${REPO_ROOT}/scripts/test/sandbox-readonly-root.test.sh"
if ! docker network inspect freshell-sandbox >/dev/null 2>&1; then
  docker network create --driver bridge freshell-sandbox >/dev/null
fi

mkdir -p "${FIXTURE}/scripts/testing" "${FIXTURE}/src"
cp "${REPO_ROOT}/scripts/sandbox-test.sh" "${FIXTURE}/scripts/"
cp "${REPO_ROOT}/scripts/testing/sandbox-owner-guard.py" "${FIXTURE}/scripts/testing/"
cp "${REPO_ROOT}/scripts/test/assert-sandbox-readonly-root.sh" "${FIXTURE}/scripts/"
write_node_manifest() {
  printf '{"name":"sandbox-startup-test","version":"1.0.0","private":true,"packageManager":"pnpm@10.34.5","dependencies":{"ms":"%s"}}\n' "$1" >"${FIXTURE}/package.json"
}
write_node_manifest 2.1.3
cat >"${FIXTURE}/Cargo.toml" <<'TOML'
[package]
name = "sandbox-startup-test"
version = "1.0.0"
edition = "2021"

[dependencies]
memchr = "=2.7.4"
TOML
cat >"${FIXTURE}/src/lib.rs" <<'RUST'
#[test]
fn dependency_is_available_offline() {
    assert_eq!(memchr::memchr(b'x', b"fixture"), Some(2));
}
RUST

# Match the caller's bind-mount ownership inside this daemon's user namespace.
# In rootless Docker the host caller maps to container 0, while a rootful
# daemon preserves the host UID/GID. The probe cannot write the fixture.
FIXTURE_CONTAINER_OWNER="$(docker run --rm --network none --user sandbox \
  --cap-drop ALL --security-opt no-new-privileges --entrypoint stat \
  -v "${FIXTURE}:/fixture:ro" "${IMAGE_TAG}" -c '%u:%g' /fixture)"

# Lock generation is separate from the empty caches given to the wrapper.
# Bypassing the entrypoint requires an explicit owner and writable, private
# package/cache locations; otherwise a rootful daemon leaves root-owned locks.
generate_fixture_locks() {
  docker run --rm --network freshell-sandbox --entrypoint bash \
    --user "${FIXTURE_CONTAINER_OWNER}" --cap-drop ALL --security-opt no-new-privileges \
    -e HOME=/tmp -e CARGO_HOME=/tmp/cargo -e npm_config_store_dir=/tmp/pnpm-store \
    -v "${FIXTURE}:/fixture" --workdir /fixture "${IMAGE_TAG}" -euc "$1"
  assert_fixture_ownership
  chmod -R a+rX "${FIXTURE}"
}
generate_fixture_locks 'pnpm install --lockfile-only && cargo generate-lockfile'

cat >"${FIXTURE}/check-runtime.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
test "${FRESHELL_SANDBOX_MODE:-}" = runtime-suite
test "$(id -u)" != 0
test "$(awk '/^CapEff:/ {print $2}' /proc/self/status)" = 0000000000000000
test ! -S /var/run/docker.sock
test ! -S /run/docker.sock
for directory in .freshell .claude .codex .local/share/opencode; do
  test ! -e "${HOME}/${directory}"
done
if grep -qE '^[^[:space:]]+[[:space:]]+00000000[[:space:]]' /proc/net/route; then
  echo 'FAIL: runtime command has a default network route' >&2
  exit 1
fi
bash scripts/assert-sandbox-readonly-root.sh
node - "$1" <<'JS'
const assert = require('node:assert/strict')
assert.equal(require('ms')('2s'), 2000)
assert.equal(require('ms/package.json').version, process.argv[2])
JS
cargo test --offline --locked
echo runtime-command-passed
SH
chmod a+r "${FIXTURE}/check-runtime.sh"

run_runtime() {
  bash "${FIXTURE}/scripts/sandbox-test.sh" --runtime-suite "$1"
}

STATUS=0
FRESHELL_SANDBOX_CACHE_PREFIX="${FIXTURE}/invalid" run_runtime true || STATUS=$?
test "${STATUS}" -eq 2
echo 'PASS: a cache prefix cannot become a host bind mount'

run_runtime 'bash check-runtime.sh 2.1.3'
echo 'PASS: cold dependency preparation and restricted execution'

# A marker in the install volume survives unchanged inputs, then disappears
# when the real manifest changes and preparation replaces stale dependencies.
run_runtime 'touch node_modules/reuse-marker'
run_runtime 'test -f node_modules/reuse-marker && bash check-runtime.sh 2.1.3'
echo 'PASS: warm dependencies are reused'

write_node_manifest 2.1.2
generate_fixture_locks 'pnpm install --lockfile-only'
run_runtime 'test ! -e node_modules/reuse-marker && bash check-runtime.sh 2.1.2'
echo 'PASS: stale dependencies are refreshed before restricted execution'

# A frozen-install failure must stop before the caller command. Its side effect
# would be visible even if the wrapper accidentally masked a command failure.
write_node_manifest 2.1.3
STATUS=0
run_runtime 'echo CALLED-AFTER-FAILED-PREP; touch target/unexpected-command' >"${FIXTURE}/failure.log" 2>&1 || STATUS=$?
cat "${FIXTURE}/failure.log"
test "${STATUS}" -ne 0
grep -q ERR_PNPM_OUTDATED_LOCKFILE "${FIXTURE}/failure.log"
if grep -q CALLED-AFTER-FAILED-PREP "${FIXTURE}/failure.log"; then
  echo 'FAIL: the caller ran after dependency preparation failed' >&2
  exit 1
fi
target_cache_labels_match
docker run --rm --network none --entrypoint bash \
  -v "${TARGET_CACHE_VOLUME}:/target:ro" \
  "${IMAGE_TAG}" -c 'test ! -e /target/unexpected-command'
echo 'PASS: dependency preparation failure prevents caller execution'

write_node_manifest 2.1.2
STATUS=0
run_runtime 'exit 23' || STATUS=$?
test "${STATUS}" -eq 23
assert_fixture_ownership
echo 'PASS: caller exit status is preserved'
