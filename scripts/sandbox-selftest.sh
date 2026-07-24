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

# ---- host baseline, captured before any proof runs ----
# This worktree is shared by multiple concurrently-active agents (see
# AGENTS.md "Many agents may be working in the worktree at the same time"),
# whose tsx-watch/nodemon dev servers can legitimately restart for reasons
# that have nothing to do with this sandbox (a file edit elsewhere in the
# repo). A single curl at the wrong instant can catch that ordinary blip.
# Retry a few times before declaring a code: a status that genuinely
# regressed BECAUSE of something this self-test did (the only thing we're
# actually trying to prove didn't happen) will not spontaneously recover in
# 3 seconds; an unrelated dev-server restart will.
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

BEFORE_3001="$(host_3001)"
BEFORE_3002="$(host_3002)"
BEFORE_PIDS="$(host_freshell_pids)"
echo "[baseline] host :3001=${BEFORE_3001} :3002=${BEFORE_3002} freshell-server pids=[${BEFORE_PIDS}]"
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
AFTER_3002_P1="$(host_3002)"
AFTER_PIDS_P1="$(host_freshell_pids)"
PS_COUNT="$(echo "${P1_OUT}" | grep -oP 'container-ps-count=\K[0-9]+' || true)"
DECOY_BEFORE="$(echo "${P1_OUT}" | grep -oP 'decoy-alive-before-kill=\K[0-9]+' || true)"
DECOY_AFTER="$(echo "${P1_OUT}" | grep -oP 'decoy-alive-after-kill=\K[0-9]+' || true)"
if [ "${P1_STATUS}" -eq 0 ] && [ -n "${PS_COUNT}" ] && [ -n "${DECOY_BEFORE}" ] && [ -n "${DECOY_AFTER}" ] \
  && [ "${PS_COUNT}" -le 10 ] && [ "${DECOY_BEFORE}" -ge 1 ] && [ "${DECOY_AFTER}" -eq 0 ] \
  && [ "${AFTER_PIDS_P1}" = "${BEFORE_PIDS}" ] && [ "${AFTER_3002_P1}" = "${BEFORE_3002}" ]; then
  pass "container has its own tiny PID namespace (ps count=${PS_COUNT}); killed its own decoy \"freshell-server\" (${DECOY_BEFORE}->${DECOY_AFTER}); host freshell-server pids unchanged [${AFTER_PIDS_P1}] and :3002 still ${AFTER_3002_P1}"
else
  fail "PID isolation: container_exit=${P1_STATUS} ps_count=${PS_COUNT} decoy_before=${DECOY_BEFORE} decoy_after=${DECOY_AFTER} host_pids_before=[${BEFORE_PIDS}] host_pids_after=[${AFTER_PIDS_P1}] host_3002_before=${BEFORE_3002} host_3002_after=${AFTER_3002_P1}"
fi
echo

# ---- Proof 2: port isolation ----
echo "--- Proof 2: port isolation ---"
P2_STATUS=0
P2_OUT="$(docker run --rm --network "${NETWORK_NAME}" "${IMAGE_TAG}" bash -c '
  set -e
  node -e "require(\"http\").createServer((_,res)=>res.end(\"container-3001-ok\")).listen(3001,\"0.0.0.0\")" &
  SERVER_PID=$!
  sleep 0.5
  curl -s --max-time 3 http://127.0.0.1:3001/
  echo
  kill "${SERVER_PID}" 2>/dev/null || true
')" || P2_STATUS=$?
echo "container bind result: ${P2_OUT}"
AFTER_3001_P2="$(host_3001)"
if [ "${P2_STATUS}" -eq 0 ] && echo "${P2_OUT}" | grep -q "container-3001-ok" && [ "${AFTER_3001_P2}" = "${BEFORE_3001}" ]; then
  pass "container bound its own :3001 in its own network namespace; host :3001 unaffected throughout (still ${AFTER_3001_P2})"
else
  fail "port isolation: container_exit=${P2_STATUS} container_bind_output=[${P2_OUT}] host_3001_before=${BEFORE_3001} host_3001_after=${AFTER_3001_P2}"
fi
echo

# ---- Proof 3: filesystem isolation ----
echo "--- Proof 3: filesystem isolation ---"

# 3a: an explicit read-only bind mount really is read-only (EROFS on write).
# This is a synthetic mount (a scratch tempdir), not one of the wrapper's
# named paths, so there's no "production path" to route it through here.
RO_SRC="$(mktemp -d)"
echo "readonly-marker" >"${RO_SRC}/marker.txt"
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

if [ "${P3A_STATUS}" -eq 0 ] && [ "${P3B_STATUS}" -eq 0 ] \
  && echo "${P3A_OUT}" | grep -q "read-ok:readonly-marker" \
  && echo "${P3A_OUT}" | grep -qi "Read-only file system" \
  && ! echo "${P3B_OUT}" | grep -q "host-path-visible:"; then
  pass "read-only corpus mount is readable but not writable (EROFS); production wrapper (scripts/sandbox-test.sh) does not expose \$HOME/.freshell, .claude, .codex, or .local/share/opencode without --corpus"
else
  fail "filesystem isolation: ro_mount_exit=${P3A_STATUS} ro_mount_output=[${P3A_OUT}] wrapper_exit=${P3B_STATUS} wrapper_output=[${P3B_OUT}]"
fi
echo

# ---- Proof 4: utility — real crate tests run green, timed vs host ----
echo "--- Proof 4: cargo test -p freshell-ws (sandbox vs host, warm caches both) ---"
# warm the sandbox cargo caches first so the timed run reflects steady-state,
# matching the honesty requirement for the host comparison (also warm).
"${REPO_ROOT}/scripts/sandbox-test.sh" "cargo test -p freshell-ws --quiet" >/tmp/sandbox-selftest-warm.log 2>&1 || true

SANDBOX_STATUS=0
SANDBOX_START=$(date +%s.%N)
SANDBOX_OUT="$("${REPO_ROOT}/scripts/sandbox-test.sh" "cargo test -p freshell-ws" 2>&1)" || SANDBOX_STATUS=$?
SANDBOX_END=$(date +%s.%N)
SANDBOX_SECS=$(echo "${SANDBOX_END} - ${SANDBOX_START}" | bc)

HOST_STATUS=0
HOST_START=$(date +%s.%N)
HOST_OUT="$(cd "${REPO_ROOT}" && cargo test -p freshell-ws 2>&1)" || HOST_STATUS=$?
HOST_END=$(date +%s.%N)
HOST_SECS=$(echo "${HOST_END} - ${HOST_START}" | bc)

echo "sandbox: exit=${SANDBOX_STATUS} wall=${SANDBOX_SECS}s"
echo "host:    exit=${HOST_STATUS} wall=${HOST_SECS}s"
if [ "${SANDBOX_STATUS}" -eq 0 ] && [ "${HOST_STATUS}" -eq 0 ] \
  && echo "${SANDBOX_OUT}" | grep -q "test result: ok" \
  && echo "${HOST_OUT}" | grep -q "test result: ok"; then
  pass "cargo test -p freshell-ws green in sandbox (${SANDBOX_SECS}s) and on host (${HOST_SECS}s)"
else
  fail "cargo test -p freshell-ws: sandbox_exit=${SANDBOX_STATUS} host_exit=${HOST_STATUS}"
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

# ---- final host health check ----
FINAL_3001="$(host_3001)"
FINAL_3002="$(host_3002)"
FINAL_PIDS="$(host_freshell_pids)"
echo "=== final host health ==="
echo "host :3001=${FINAL_3001} (was ${BEFORE_3001}) :3002=${FINAL_3002} (was ${BEFORE_3002}) freshell-server pids=[${FINAL_PIDS}] (was [${BEFORE_PIDS}])"
if [ "${FINAL_3001}" != "${BEFORE_3001}" ] || [ "${FINAL_3002}" != "${BEFORE_3002}" ] || [ "${FINAL_PIDS}" != "${BEFORE_PIDS}" ]; then
  fail "host health changed across the self-test run"
else
  pass "host health unchanged across the entire self-test run"
fi

echo
if [ "${FAILED}" -eq 0 ]; then
  echo "=== ALL PROOFS PASSED ==="
  exit 0
else
  echo "=== ONE OR MORE PROOFS FAILED ==="
  exit 1
fi
