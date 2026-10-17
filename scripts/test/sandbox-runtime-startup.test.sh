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
CACHE_VOLUMES=()
for suffix in cargo-registry cargo-git cargo-target node-modules sidecar-node-modules mcp-node-modules playwright-cache; do
  CACHE_VOLUMES+=("${FRESHELL_SANDBOX_CACHE_PREFIX}-${suffix}")
done
cleanup() {
  docker volume rm "${CACHE_VOLUMES[@]}" >/dev/null 2>&1 || true
  rm -rf "${FIXTURE}"
}
trap cleanup EXIT

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

mkdir -p "${FIXTURE}/scripts" "${FIXTURE}/src"
cp "${REPO_ROOT}/scripts/sandbox-test.sh" "${FIXTURE}/scripts/"
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
docker run --rm --network none --entrypoint bash \
  -v "${FRESHELL_SANDBOX_CACHE_PREFIX}-cargo-target:/target:ro" \
  "${IMAGE_TAG}" -c 'test ! -e /target/unexpected-command'
echo 'PASS: dependency preparation failure prevents caller execution'

write_node_manifest 2.1.2
STATUS=0
run_runtime 'exit 23' || STATUS=$?
test "${STATUS}" -eq 23
assert_fixture_ownership
echo 'PASS: caller exit status is preserved'
