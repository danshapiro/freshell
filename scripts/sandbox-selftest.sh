#!/usr/bin/env bash
# Isolation self-test for freshell-sandbox. This IS the acceptance test for
# docker/sandbox/** and scripts/sandbox-*.sh — run it after any change to
# either. It proves the sandbox cannot reach host processes, host ports, or
# host filesystem data it wasn't explicitly given read-only access to.
#
# Never touches a real host process/port: it launches its own decoy
# processes and listeners *inside* the container and only observes the
# host's :3001/:3002 dev servers via curl/pgrep from the HOST side.
#
# Robustness note: every fallible command substitution below is captured as
# `VAR="$(...)" || STATUS=$?` — never a bare `VAR="$(...)"`. Under
# `set -euo pipefail`, a bare assignment whose command substitution fails
# (non-zero exit, or a `grep` that finds no match) kills the WHOLE script on
# the spot: no PASS/FAIL verdict for that proof, no later proofs, and no
# final host-health section. Capturing the status via `||` keeps every
# proof's own pass/fail check (and the final host-health section) reachable
# no matter what happens inside it.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_TAG="freshell-sandbox:latest"
NETWORK_NAME="freshell-sandbox"

FAILED=0
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAILED=1; }

echo "=== freshell-sandbox isolation self-test ==="
echo

if ! docker image inspect "${IMAGE_TAG}" >/dev/null 2>&1; then
  echo "[selftest] image ${IMAGE_TAG} not found, building it first..." >&2
  "${REPO_ROOT}/scripts/sandbox-build.sh"
fi
if ! docker network inspect "${NETWORK_NAME}" >/dev/null 2>&1; then
  docker network create --driver bridge "${NETWORK_NAME}" >/dev/null
fi

# ---- host baseline and self-owned host sentinels ----
# Real Freshell processes are useful diagnostics but are NOT stable test
# fixtures: other agents legitimately start/stop worktree servers while this
# test runs. Create exact host-side sentinels that this self-test alone owns,
# then prove container operations cannot affect those sentinels.
_curl_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$1" 2>/dev/null || echo "ERR"; }
_host_check_with_retry() {
  local url="$1" attempt code
  for attempt in 1 2 3; do
    code="$(_curl_code "${url}")"
    if [ "${code}" = "200" ]; then
      echo "${code}"
      return 0
    fi
    [ "${attempt}" -lt 3 ] && sleep 1
  done
  echo "${code}"
}
host_3001() { _host_check_with_retry "http://localhost:3001/"; }
host_3002() { _host_check_with_retry "http://localhost:3002/"; }
host_freshell_pids() { pgrep -f freshell-server 2>/dev/null | sort | tr '\n' ',' || true; }

HOST_PID_SENTINEL_PID=""
HOST_PORT_SENTINEL_PID=""
HOST_PORT_FILE="$(mktemp)"
cleanup_selftest_decoys() {
  if [ -n "${HOST_PID_SENTINEL_PID}" ]; then
    kill "${HOST_PID_SENTINEL_PID}" 2>/dev/null || true
    wait "${HOST_PID_SENTINEL_PID}" 2>/dev/null || true
  fi
  if [ -n "${HOST_PORT_SENTINEL_PID}" ]; then
    kill "${HOST_PORT_SENTINEL_PID}" 2>/dev/null || true
    wait "${HOST_PORT_SENTINEL_PID}" 2>/dev/null || true
  fi
  rm -f "${HOST_PORT_FILE}"
}
trap cleanup_selftest_decoys EXIT

bash -c 'exec -a freshell-server-sandbox-host-sentinel sleep 300' &
HOST_PID_SENTINEL_PID=$!

python3 - "${HOST_PORT_FILE}" <<'PYHOST' &
import http.server
import socketserver
import sys

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"host-sandbox-sentinel"
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *_args):
        pass

with socketserver.TCPServer(("127.0.0.1", 0), Handler) as server:
    with open(sys.argv[1], "w", encoding="utf-8") as handle:
        handle.write(str(server.server_address[1]))
        handle.flush()
    server.serve_forever()
PYHOST
HOST_PORT_SENTINEL_PID=$!
for _attempt in $(seq 1 100); do
  [ -s "${HOST_PORT_FILE}" ] && break
  sleep 0.02
done
if [ ! -s "${HOST_PORT_FILE}" ]; then
  echo "FAIL: host port sentinel failed to publish its port"
  exit 1
fi
HOST_SENTINEL_PORT="$(cat "${HOST_PORT_FILE}")"
host_port_sentinel() { curl -fsS --max-time 2 "http://127.0.0.1:${HOST_SENTINEL_PORT}/" 2>/dev/null || true; }
host_pid_sentinel_alive() {
  kill -0 "${HOST_PID_SENTINEL_PID}" 2>/dev/null \
    && ps -p "${HOST_PID_SENTINEL_PID}" -o args= 2>/dev/null | grep -q 'freshell-server-sandbox-host-sentinel'
}

BEFORE_3001="$(host_3001)"
BEFORE_3002="$(host_3002)"
BEFORE_PIDS="$(host_freshell_pids)"
BEFORE_SENTINEL_HTTP="$(host_port_sentinel)"
echo "[diagnostic baseline] host :3001=${BEFORE_3001} :3002=${BEFORE_3002} freshell-server pids=[${BEFORE_PIDS}]"
echo "[owned sentinels] pid=${HOST_PID_SENTINEL_PID} http=127.0.0.1:${HOST_SENTINEL_PORT} response=${BEFORE_SENTINEL_HTTP}"
echo

# ---- Proof 1: PID isolation ----
echo "--- Proof 1: PID isolation ---"
# Piped via stdin (bash -s), NOT passed as a `bash -c "<script>"` argument:
# a -c argument becomes part of PID 1's own argv for the container's whole
# lifetime, and since the script text itself contains the literal string
# "freshell-server" (naming the decoy), pgrep -f would match PID 1 too. -s
# reads the script from stdin, which never appears in any process's argv.
P1_STATUS=0
P1_OUT="$(docker run --rm -i --network "${NETWORK_NAME}" "${IMAGE_TAG}" bash -s <<'EOF'
set -e
ps_count_before=$(ps aux | wc -l)
echo "container-ps-count=${ps_count_before}"
(exec -a freshell-server sleep 300 &)
sleep 0.3
decoy_before=$(pgrep -f freshell-server | wc -l)
echo "decoy-alive-before-kill=${decoy_before}"
pkill -f freshell-server
sleep 0.3
decoy_after=$(pgrep -f freshell-server | wc -l || true)
echo "decoy-alive-after-kill=${decoy_after}"
EOF
)" || P1_STATUS=$?
echo "${P1_OUT}"
AFTER_PIDS_P1="$(host_freshell_pids)"
PS_COUNT="$(echo "${P1_OUT}" | grep -oP 'container-ps-count=\K[0-9]+' || true)"
DECOY_BEFORE="$(echo "${P1_OUT}" | grep -oP 'decoy-alive-before-kill=\K[0-9]+' || true)"
DECOY_AFTER="$(echo "${P1_OUT}" | grep -oP 'decoy-alive-after-kill=\K[0-9]+' || true)"
if [ "${P1_STATUS}" -eq 0 ] && [ -n "${PS_COUNT}" ] && [ -n "${DECOY_BEFORE}" ] && [ -n "${DECOY_AFTER}" ] \
  && [ "${PS_COUNT}" -le 10 ] && [ "${DECOY_BEFORE}" -ge 1 ] && [ "${DECOY_AFTER}" -eq 0 ] \
  && host_pid_sentinel_alive; then
  pass "container killed its own freshell-server decoy (${DECOY_BEFORE}->${DECOY_AFTER}) while exact host sentinel pid ${HOST_PID_SENTINEL_PID} survived; observed real Freshell pids are diagnostic only"
else
  fail "PID isolation: container_exit=${P1_STATUS} ps_count=${PS_COUNT} decoy_before=${DECOY_BEFORE} decoy_after=${DECOY_AFTER} owned_host_sentinel_pid=${HOST_PID_SENTINEL_PID} host_pids_before=[${BEFORE_PIDS}] host_pids_after=[${AFTER_PIDS_P1}]"
fi
echo

# ---- Proof 2: port isolation ----
echo "--- Proof 2: port isolation ---"
P2_STATUS=0
P2_OUT="$(docker run --rm --network "${NETWORK_NAME}" -e TEST_PORT="${HOST_SENTINEL_PORT}" "${IMAGE_TAG}" bash -c '
  set -e
  node -e "require(\"http\").createServer((_,res)=>res.end(\"container-port-ok\")).listen(Number(process.env.TEST_PORT),\"0.0.0.0\")" &
  SERVER_PID=$!
  sleep 0.5
  curl -s --max-time 3 "http://127.0.0.1:${TEST_PORT}/"
  echo
  kill "${SERVER_PID}" 2>/dev/null || true
')" || P2_STATUS=$?
echo "container bind result: ${P2_OUT}"
AFTER_SENTINEL_HTTP_P2="$(host_port_sentinel)"
if [ "${P2_STATUS}" -eq 0 ] && echo "${P2_OUT}" | grep -q "container-port-ok" \
  && [ "${AFTER_SENTINEL_HTTP_P2}" = "host-sandbox-sentinel" ]; then
  pass "container bound its own :${HOST_SENTINEL_PORT} while the self-owned host listener on the same port stayed reachable"
else
  fail "port isolation: container_exit=${P2_STATUS} container_bind_output=[${P2_OUT}] host_sentinel_response=[${AFTER_SENTINEL_HTTP_P2}]"
fi
echo

# ---- Proof 3: filesystem isolation ----
echo "--- Proof 3: filesystem isolation ---"

# 3a: an explicit read-only bind mount really is read-only (EROFS on write).
# This is a synthetic mount (a scratch tempdir), not one of the wrapper's
# named paths, so there's no "production path" to route it through here.
RO_SRC="$(mktemp -d)"
# mktemp creates mode 0700; the sandbox runs as the matching numeric UID but
# user-namespace/remap setups can still make that directory unreadable. The
# corpus fixture is intentionally public-read, while the mount itself remains
# read-only and is what this proof is testing.
chmod 0755 "${RO_SRC}"
echo "readonly-marker" >"${RO_SRC}/marker.txt"
chmod 0644 "${RO_SRC}/marker.txt"
P3A_STATUS=0
P3A_OUT="$(docker run --rm --network "${NETWORK_NAME}" \
  -v "${RO_SRC}:/home/sandbox/ro-corpus:ro" \
  "${IMAGE_TAG}" bash -c '
    echo "read-ok:$(cat /home/sandbox/ro-corpus/marker.txt 2>&1)"
    if echo "tampered" > /home/sandbox/ro-corpus/marker.txt; then
      echo "write-result:unexpectedly-succeeded"
    else
      echo "write-result:blocked (see redirection error above)"
    fi
' 2>&1)" || P3A_STATUS=$?
rm -rf "${RO_SRC}"
echo "${P3A_OUT}"

# 3b: real user data (~/.freshell, ~/.claude, ~/.codex,
# ~/.local/share/opencode) is invisible by default. Exercised through the
# actual PRODUCTION wrapper (scripts/sandbox-test.sh) rather than a
# hand-rolled `docker run` here, so this proof and the shipped wrapper
# cannot silently drift apart — if the wrapper ever starts mounting one of
# these paths by default, this proof fails against the real behavior
# operators and agents actually get, not a stale reimplementation of it.
P3B_STATUS=0
# shellcheck disable=SC2016 # single-quoted on purpose: $HOME/$p must expand
# inside the container's bash -c, not on the host running this script.
P3B_OUT="$("${REPO_ROOT}/scripts/sandbox-test.sh" '
  for p in "$HOME/.freshell" "$HOME/.claude" "$HOME/.codex" "$HOME/.local/share/opencode"; do
    if [ -e "$p" ]; then
      echo "host-path-visible:$p"
    else
      echo "host-path-absent:$p"
    fi
  done
' 2>&1)" || P3B_STATUS=$?
echo "${P3B_OUT}"

# 3c: managed-runtime lifecycle mode is stricter than the ordinary sandbox:
# no default route, no Docker socket, no real provider homes, read-only root.
P3C_STATUS=0
P3C_OUT="$("${REPO_ROOT}/scripts/sandbox-test.sh" --runtime-suite '
  set -e
  [ "${FRESHELL_SANDBOX_MODE:-}" = "runtime-suite" ]
  for sock in /var/run/docker.sock /run/docker.sock; do
    [ ! -S "$sock" ] || { echo "docker-socket-visible:$sock"; exit 1; }
  done
  for p in "$HOME/.freshell" "$HOME/.claude" "$HOME/.codex" "$HOME/.local/share/opencode"; do
    [ ! -e "$p" ] || { echo "provider-home-visible:$p"; exit 1; }
  done
  if grep -qE "^[^[:space:]]+[[:space:]]+00000000[[:space:]]" /proc/net/route; then
    echo "default-route-visible"
    exit 1
  fi
  if touch /runtime-suite-root-write-probe 2>/dev/null; then
    echo "root-writable"
    exit 1
  fi
  cap_eff=$(awk "/^CapEff:/ {print \$2}" /proc/self/status)
  [ "$cap_eff" = "0000000000000000" ] || { echo "effective-capabilities:$cap_eff"; exit 1; }
  echo "runtime-suite-isolated"
' 2>&1)" || P3C_STATUS=$?
echo "${P3C_OUT}"

if [ "${P3A_STATUS}" -eq 0 ] && [ "${P3B_STATUS}" -eq 0 ] && [ "${P3C_STATUS}" -eq 0 ] \
  && echo "${P3A_OUT}" | grep -q "read-ok:readonly-marker" \
  && echo "${P3A_OUT}" | grep -qi "Read-only file system" \
  && ! echo "${P3B_OUT}" | grep -q "host-path-visible:" \
  && echo "${P3C_OUT}" | grep -q "runtime-suite-isolated"; then
  pass "read-only mount enforcement works; ordinary sandbox hides provider homes; --runtime-suite also removes network/admin authority and makes the container root read-only"
else
  fail "filesystem isolation: ro_mount_exit=${P3A_STATUS} ordinary_exit=${P3B_STATUS} runtime_suite_exit=${P3C_STATUS} ro=[${P3A_OUT}] ordinary=[${P3B_OUT}] runtime_suite=[${P3C_OUT}]"
fi
echo

# ---- Proof 4: utility — a real crate test runs green in both environments ----
# Keep this proof deliberately small and deterministic. The sandbox self-test
# proves isolation; broad freshell-ws behavior belongs to the coordinated test
# suite and can include unrelated watcher concurrency that obscures this proof.
TEST_CRATE="freshell-runtime-protocol"
echo "--- Proof 4: cargo test -p ${TEST_CRATE} (sandbox vs host, warm caches both) ---"
"${REPO_ROOT}/scripts/sandbox-test.sh" "cargo test -p ${TEST_CRATE} --quiet" >/tmp/sandbox-selftest-warm.log 2>&1 || true

SANDBOX_STATUS=0
SANDBOX_START=$(date +%s.%N)
SANDBOX_OUT="$("${REPO_ROOT}/scripts/sandbox-test.sh" "cargo test -p ${TEST_CRATE}" 2>&1)" || SANDBOX_STATUS=$?
SANDBOX_END=$(date +%s.%N)
SANDBOX_SECS=$(echo "${SANDBOX_END} - ${SANDBOX_START}" | bc)

# The repo requires Rust 1.96 and this host intentionally leaves an older
# system cargo on PATH. Follow AGENTS.md and use mise for the host comparison.
HOST_CARGO=(cargo)
if command -v mise >/dev/null 2>&1; then
  HOST_CARGO=(mise exec rust@1.96 -- cargo)
fi
HOST_STATUS=0
HOST_START=$(date +%s.%N)
HOST_OUT="$(cd "${REPO_ROOT}" && "${HOST_CARGO[@]}" test -p "${TEST_CRATE}" 2>&1)" || HOST_STATUS=$?
HOST_END=$(date +%s.%N)
HOST_SECS=$(echo "${HOST_END} - ${HOST_START}" | bc)

echo "sandbox: exit=${SANDBOX_STATUS} wall=${SANDBOX_SECS}s"
echo "host:    exit=${HOST_STATUS} wall=${HOST_SECS}s"
if [ "${SANDBOX_STATUS}" -eq 0 ] && [ "${HOST_STATUS}" -eq 0 ] \
  && echo "${SANDBOX_OUT}" | grep -q "test result: ok" \
  && echo "${HOST_OUT}" | grep -q "test result: ok"; then
  pass "cargo test -p ${TEST_CRATE} green in sandbox (${SANDBOX_SECS}s) and on host (${HOST_SECS}s)"
else
  fail "cargo test -p ${TEST_CRATE}: sandbox_exit=${SANDBOX_STATUS} host_exit=${HOST_STATUS}"
  echo "--- sandbox output tail ---"
  echo "${SANDBOX_OUT}" | tail -20
  echo "--- host output tail ---"
  echo "${HOST_OUT}" | tail -20
fi
echo

# ---- Proof 5: no root-owned mount-point droppings under the repo root ----
echo "--- Proof 5: no root-owned droppings under the repo root ---"
# scripts/sandbox-test.sh pre-creates every named-volume mount point nested
# under the bind-mounted repo (target/, node_modules/) as the invoking user,
# specifically so dockerd (which runs as root) never has to create them
# itself — which would leave root-owned stub dirs behind that break
# host-side cargo/npm in this worktree with EACCES. This proof independently
# verifies that guarantee actually held after every docker invocation above
# (Proofs 1-4 all ran at least one container), rather than only trusting the
# wrapper's own internal guard.
ROOT_DROPPINGS="$(find "${REPO_ROOT}" -maxdepth 1 -user root 2>/dev/null || true)"
if [ -z "${ROOT_DROPPINGS}" ]; then
  pass "no root-owned entries directly under ${REPO_ROOT}"
else
  fail "root-owned entries found directly under ${REPO_ROOT}: ${ROOT_DROPPINGS} (remediation: sudo chown -R \"\$(id -u):\$(id -g)\" <path>, then re-run)"
fi
echo

# ---- Proof 6: dependency prep — manager selection + fingerprint transitions ----
echo "--- Proof 6: dependency prep (manager selection + fingerprint transitions) ---"
# docker/sandbox/entrypoint.sh replaces the one-shot `.sandbox-npm-ci-done`
# marker with a fingerprinted, dual-manager dependency prep. These cases
# drive it through the real image entrypoint against hermetic fixture
# trees: host temp dirs bind-mounted at /workspace plus throwaway named
# volumes at /workspace/node_modules — the same mount topology
# scripts/sandbox-test.sh gives the real repo, so the purge path is
# exercised against a real volume mount. Nothing here touches this repo's
# working tree or its persistent named volumes:
#   6a: pnpm-era tree (packageManager pin, both lock styles present) with a
#       planted stale npm marker + stale npm node_modules → pnpm prep runs,
#       purges the stale volume, and writes the new state file.
#   6b: an unchanged fingerprint on a second container start skips the
#       install and leaves the state file untouched.
#   6c: a changed fingerprint input (package.json bytes) forces a
#       reinstall and records the new fingerprint.
#   6d: a legacy npm-era tree (package-lock.json, no packageManager field)
#       with the old npm marker planted selects npm and runs npm ci anyway —
#       the old one-shot marker never satisfies the new state.
P6_FIXTURE_PNPM="$(mktemp -d)"
P6_FIXTURE_NPM="$(mktemp -d)"
P6_VOL_PNPM="freshell-selftest-deps-pnpm-$$"
P6_VOL_NPM="freshell-selftest-deps-npm-$$"

cat > "${P6_FIXTURE_PNPM}/package.json" <<'EOF'
{
  "name": "sandbox-deps-fixture-pnpm",
  "version": "0.0.0",
  "private": true,
  "packageManager": "pnpm@10.34.5",
  "dependencies": { "ms": "2.1.3" }
}
EOF
# One tiny real dependency: an empty-deps tree makes the frozen install a
# no-op ("Already up to date"), and that no-op path rewrites the wanted
# lockfile through a temp file in the project root — which the read-only
# bind mount cannot host. The real repo flow links real packages and never
# writes the root, so the fixture mirrors it with ms@2.1.3.
# A stale npm lock is planted alongside the pnpm lock (as on this branch
# while package-lock.json is still carried): packageManager must win.
echo '{"name":"sandbox-deps-fixture-pnpm","version":"0.0.0","lockfileVersion":3,"packages":{"":{"name":"sandbox-deps-fixture-pnpm","version":"0.0.0"}}}' > "${P6_FIXTURE_PNPM}/package-lock.json"

cat > "${P6_FIXTURE_NPM}/package.json" <<'EOF'
{
  "name": "sandbox-deps-fixture-npm",
  "version": "0.0.0",
  "private": true
}
EOF

# Generate each fixture's lock with the image's own pinned manager. The
# pnpm fixture carries a real dependency (ms@2.1.3), so lock generation
# resolves from the registry; the npm fixture's lock stays dependency-free.
# Lock-only generation keeps the case runs below exercising the entrypoint's
# real frozen-install path.
# The generators run as the container's root user: under this host's
# rootless docker mapping, bind-mounted files keep the invoking user's
# ownership, so root-created locks come back out as the invoking user's
# own files — readable and chmod-able host-side for the steps below.
P6_GEN_STATUS=0
docker run --rm --network "${NETWORK_NAME}" --entrypoint bash \
  -v "${P6_FIXTURE_PNPM}:/fixture" "${IMAGE_TAG}" \
  -c 'bash -c "cd /fixture && pnpm install --lockfile-only"' \
  >/dev/null 2>&1 || P6_GEN_STATUS=$?
docker run --rm --network "${NETWORK_NAME}" --entrypoint bash \
  -v "${P6_FIXTURE_NPM}:/fixture" "${IMAGE_TAG}" \
  -c 'bash -c "cd /fixture && npm install --package-lock-only"' \
  >/dev/null 2>&1 || P6_GEN_STATUS=$?

# The entrypoint's gosu drop means the container reads the fixture as the
# "sandbox" user, while bind-mounted host files appear inside the container
# as root-owned — they must be world-readable for the install to work.
# chmod after creation so the invoking shell's umask cannot break the proof.
chmod -R a+rX "${P6_FIXTURE_PNPM}" "${P6_FIXTURE_NPM}"

# Plant the stale npm-era node_modules (one-shot marker + junk) INTO each
# throwaway volume, exactly as a legacy npm-era container would have left
# it. Runs as the container's root with the volume mounted at its wrapper
# path over the bind-mounted fixture.
for _fx in "${P6_FIXTURE_PNPM}" "${P6_FIXTURE_NPM}"; do
  if [ "${_fx}" = "${P6_FIXTURE_NPM}" ]; then
    _vol="${P6_VOL_NPM}"
  else
    _vol="${P6_VOL_PNPM}"
  fi
  docker run --rm --entrypoint bash \
    -v "${_fx}:/workspace" -v "${_vol}:/workspace/node_modules" \
    "${IMAGE_TAG}" -c '
      mkdir -p /workspace/node_modules/.bin
      : > /workspace/node_modules/.sandbox-npm-ci-done
      echo stale > /workspace/node_modules/stale-npm-junk.js
    ' >/dev/null 2>&1 || P6_GEN_STATUS=$?
done
unset _fx _vol

P6_FIXTURES_OK=true
if [ "${P6_GEN_STATUS}" -ne 0 ] \
  || [ ! -f "${P6_FIXTURE_PNPM}/pnpm-lock.yaml" ] \
  || [ ! -f "${P6_FIXTURE_NPM}/package-lock.json" ]; then
  fail "dependency prep fixtures could not be generated (gen_exit=${P6_GEN_STATUS}, pnpm lock $([ -f "${P6_FIXTURE_PNPM}/pnpm-lock.yaml" ] && echo present || echo missing), npm lock $([ -f "${P6_FIXTURE_NPM}/package-lock.json" ] && echo present || echo missing))"
  P6_FIXTURES_OK=false
fi

# Every case command reports from INSIDE the container: the state file
# lives in the volume, which the host cannot read through the fixture dir.
P6_CASE_SCRIPT='
  cat node_modules/.sandbox-deps-state 2>/dev/null || echo "STATE-MISSING"
  test -e node_modules/stale-npm-junk.js && echo "junk:present" || echo "junk:purged"
  test -e node_modules/.sandbox-npm-ci-done && echo "old-marker:present" || echo "old-marker:purged"
'

if [ "${P6_FIXTURES_OK}" = true ]; then
  # -- 6a: pnpm tree + stale npm marker/volume → pnpm prep, purge, state --
  P6A_STATUS=0
  P6A_OUT="$(docker run --rm --network "${NETWORK_NAME}" \
    -v "${P6_FIXTURE_PNPM}:/workspace" -v "${P6_VOL_PNPM}:/workspace/node_modules" \
    "${IMAGE_TAG}" bash -c "${P6_CASE_SCRIPT}" 2>&1)" || P6A_STATUS=$?
  echo "${P6A_OUT}"
  P6A_FP="$(grep '^fingerprint=' <<<"${P6A_OUT}" | cut -d= -f2 || true)"
  if [ "${P6A_STATUS}" -eq 0 ] \
    && echo "${P6A_OUT}" | grep -q "deps: installing via pnpm install --frozen-lockfile" \
    && echo "${P6A_OUT}" | grep -q "manager=pnpm" \
    && [ "${#P6A_FP}" -eq 64 ] \
    && echo "${P6A_OUT}" | grep -q "junk:purged" \
    && echo "${P6A_OUT}" | grep -q "old-marker:purged" \
    && ! echo "${P6A_OUT}" | grep -q "STATE-MISSING"; then
    pass "6a: pnpm-era tree with stale npm marker/node_modules triggered the pnpm prep; stale volume purged; state written (fingerprint ${P6A_FP:0:12}...)"
  else
    fail "6a: pnpm transition: exit=${P6A_STATUS} state_fingerprint=${P6A_FP:-none} output=[${P6A_OUT}]"
  fi
  echo

  # -- 6b: unchanged fingerprint on a second start → skip, state untouched --
  P6B_STATUS=0
  P6B_OUT="$(docker run --rm --network "${NETWORK_NAME}" \
    -v "${P6_FIXTURE_PNPM}:/workspace" -v "${P6_VOL_PNPM}:/workspace/node_modules" \
    "${IMAGE_TAG}" bash -c 'cat node_modules/.sandbox-deps-state' 2>&1)" || P6B_STATUS=$?
  echo "${P6B_OUT}"
  P6B_FP="$(grep '^fingerprint=' <<<"${P6B_OUT}" | cut -d= -f2 || true)"
  if [ "${P6B_STATUS}" -eq 0 ] \
    && echo "${P6B_OUT}" | grep -q "deps: reusing" \
    && ! echo "${P6B_OUT}" | grep -q "deps: installing" \
    && [ -n "${P6B_FP}" ] && [ "${P6B_FP}" = "${P6A_FP}" ]; then
    pass "6b: unchanged fingerprint skipped the install and left the recorded state untouched"
  else
    fail "6b: reuse path: exit=${P6B_STATUS} fingerprint_before=${P6A_FP:-none} fingerprint_after=${P6B_FP:-none} output=[${P6B_OUT}]"
  fi
  echo

  # -- 6c: changed fingerprint input → forced reinstall + new state --
  # Appending one newline changes package.json's bytes (a fingerprint
  # input) while keeping the JSON valid and lock-consistent for the frozen
  # install.
  printf '\n' >> "${P6_FIXTURE_PNPM}/package.json"
  P6C_STATUS=0
  P6C_OUT="$(docker run --rm --network "${NETWORK_NAME}" \
    -v "${P6_FIXTURE_PNPM}:/workspace" -v "${P6_VOL_PNPM}:/workspace/node_modules" \
    "${IMAGE_TAG}" bash -c 'cat node_modules/.sandbox-deps-state' 2>&1)" || P6C_STATUS=$?
  echo "${P6C_OUT}"
  P6C_FP="$(grep '^fingerprint=' <<<"${P6C_OUT}" | cut -d= -f2 || true)"
  if [ "${P6C_STATUS}" -eq 0 ] \
    && echo "${P6C_OUT}" | grep -q "deps: installing via pnpm install --frozen-lockfile" \
    && [ "${#P6C_FP}" -eq 64 ] \
    && [ "${P6C_FP}" != "${P6A_FP}" ]; then
    pass "6c: changed package.json forced a reinstall and recorded a new fingerprint (${P6A_FP:0:12}... → ${P6C_FP:0:12}...)"
  else
    fail "6c: reinstall on changed fingerprint: exit=${P6C_STATUS} before=${P6A_FP:-none} after=${P6C_FP:-none} output=[${P6C_OUT}]"
  fi
  echo

  # -- 6d: legacy npm tree + old marker → npm ci runs anyway, state written --
  P6D_STATUS=0
  P6D_OUT="$(docker run --rm --network "${NETWORK_NAME}" \
    -v "${P6_FIXTURE_NPM}:/workspace" -v "${P6_VOL_NPM}:/workspace/node_modules" \
    "${IMAGE_TAG}" bash -c "${P6_CASE_SCRIPT}" 2>&1)" || P6D_STATUS=$?
  echo "${P6D_OUT}"
  if [ "${P6D_STATUS}" -eq 0 ] \
    && echo "${P6D_OUT}" | grep -q "deps: installing via npm ci --no-audit --no-fund" \
    && echo "${P6D_OUT}" | grep -q "manager=npm" \
    && echo "${P6D_OUT}" | grep -q "junk:purged" \
    && echo "${P6D_OUT}" | grep -q "old-marker:purged" \
    && ! echo "${P6D_OUT}" | grep -q "STATE-MISSING"; then
    pass "6d: legacy npm-era tree selected npm and ran npm ci despite the planted old marker; state written"
  else
    fail "6d: legacy npm path: exit=${P6D_STATUS} output=[${P6D_OUT}]"
  fi
  echo
fi

# Throwaway volumes first (they shadow the fixtures' node_modules), then the
# fixture dirs themselves (all host-owned once the volumes are gone).
docker volume rm "${P6_VOL_PNPM}" "${P6_VOL_NPM}" >/dev/null 2>&1 || true
rm -rf "${P6_FIXTURE_PNPM}" "${P6_FIXTURE_NPM}" 2>/dev/null || true

# ---- final host isolation check ----
FINAL_3001="$(host_3001)"
FINAL_3002="$(host_3002)"
FINAL_PIDS="$(host_freshell_pids)"
FINAL_SENTINEL_HTTP="$(host_port_sentinel)"
echo "=== final host isolation ==="
echo "[diagnostic] host :3001=${FINAL_3001} (was ${BEFORE_3001}) :3002=${FINAL_3002} (was ${BEFORE_3002})"
echo "[diagnostic] observed Freshell pids now=[${FINAL_PIDS}] baseline=[${BEFORE_PIDS}] (concurrent activity allowed)"
if host_pid_sentinel_alive && [ "${FINAL_SENTINEL_HTTP}" = "host-sandbox-sentinel" ]; then
  pass "both exact host sentinels created by this self-test survived every container operation"
else
  fail "self-owned host sentinel changed: pid=${HOST_PID_SENTINEL_PID} http=[${FINAL_SENTINEL_HTTP}]"
fi

echo
if [ "${FAILED}" -eq 0 ]; then
  echo "=== ALL PROOFS PASSED ==="
  exit 0
else
  echo "=== ONE OR MORE PROOFS FAILED ==="
  exit 1
fi
