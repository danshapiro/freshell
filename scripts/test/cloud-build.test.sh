#!/usr/bin/env bash
# Test: cloud-build — process-level verification that the e2e/vitest cloud
# wrappers dispatch image building to Cloud Build by default and to a local
# `docker build` with --local-build, using fully stubbed gcloud/docker.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT"

# gcloud-robot hermeticity pin (skill trap 11): the wrappers now carry a live
# identity ladder. Pinning GCLOUD_IDENT forces the ladder's rung-2 bypass, so
# no wrapper invocation from this suite can reach the real probe/network —
# even if the harness environment happens to export GCLOUD_ROBOT_HOME. The
# value is deliberately fake; nothing in this suite depends on it.
export GCLOUD_IDENT="suite-pinned-identity@example.invalid"

FAILURES=0

check() {
  local desc="$1"
  shift
  if "$@"; then
    echo "PASS: $desc"
  else
    echo "FAIL: $desc"
    FAILURES=$((FAILURES + 1))
  fi
}

echo "=== Cloud Build Test ==="

FAKE_DIR=$(mktemp -d)
cat > "$FAKE_DIR/gcloud" << 'FAKE'
#!/usr/bin/env bash
echo "FAKE_GCLOUD: $@" >> "${FAKE_GCLOUD_LOG:-/dev/null}"
[ -n "${CLOUDSDK_CORE_DISABLE_PROMPTS:-}" ] && echo "PROMPTS_DISABLED=1" >> "${FAKE_GCLOUD_LOG:-/dev/null}"
[[ " $* " == *" --quiet "* ]] && echo "QUIET=1" >> "${FAKE_GCLOUD_LOG:-/dev/null}"
if [[ "$*" == *"artifacts docker images describe"* ]]; then exit 0; fi
if [[ "$*" == *"artifacts repositories describe"* ]]; then exit 0; fi
if [[ "$*" == *"auth print-access-token"* ]]; then echo "fake-token"; exit 0; fi
if [[ "$*" == *"info"* ]]; then echo "/usr/lib/google-cloud-sdk"; exit 0; fi
exit 0
FAKE
cat > "$FAKE_DIR/docker" << 'FAKE'
#!/usr/bin/env bash
echo "FAKE_DOCKER: $@" >> "${FAKE_DOCKER_LOG:-/dev/null}"
exit 0
FAKE
chmod +x "$FAKE_DIR/gcloud" "$FAKE_DIR/docker"

export FAKE_GCLOUD_LOG="$FAKE_DIR/gcloud.log"
export FAKE_DOCKER_LOG="$FAKE_DIR/docker.log"
touch "$FAKE_GCLOUD_LOG" "$FAKE_DOCKER_LOG"
export PATH="$FAKE_DIR:$PATH"

# Check 1: e2e-cloud.sh build (default) with fake gcloud dispatches to Cloud Build
bash scripts/e2e-cloud.sh build 2>&1 > /dev/null || true
check "e2e-cloud.sh build (default) calls gcloud builds submit" \
  grep -q 'builds submit' "$FAKE_GCLOUD_LOG"

# Check 2: vitest-cloud.sh build (default) with fake gcloud dispatches to Cloud Build
rm -f "$FAKE_GCLOUD_LOG"; touch "$FAKE_GCLOUD_LOG"
bash scripts/vitest-cloud.sh build 2>&1 > /dev/null || true
check "vitest-cloud.sh build (default) calls gcloud builds submit" \
  grep -q 'builds submit' "$FAKE_GCLOUD_LOG"

# Check 2b: the Cloud Build submission receives the immutable source commit
# that the Docker build stamps into the Rust and client artifacts. This is a
# process-level wrapper contract: the fake gcloud records the argv produced by
# the real wrapper, rather than inspecting wrapper source text.
EXPECTED_BUILD_COMMIT="$(git rev-parse HEAD)"
check "vitest-cloud.sh Cloud Build receives the exact HEAD build commit" \
  grep -q -- "_FRESHELL_BUILD_COMMIT=${EXPECTED_BUILD_COMMIT}" "$FAKE_GCLOUD_LOG"

# Check 3: e2e-cloud.sh build --local-build uses docker build (not Cloud Build)
rm -f "$FAKE_GCLOUD_LOG" "$FAKE_DOCKER_LOG"; touch "$FAKE_GCLOUD_LOG" "$FAKE_DOCKER_LOG"
bash scripts/e2e-cloud.sh build --local-build 2>&1 > /dev/null || true
check "e2e-cloud.sh build --local-build calls docker build" \
  grep -q 'build' "$FAKE_DOCKER_LOG"
if grep -q 'builds submit' "$FAKE_GCLOUD_LOG"; then
  echo "FAIL: e2e-cloud.sh build --local-build should NOT call gcloud builds submit"
  FAILURES=$((FAILURES + 1))
else
  echo "PASS: e2e-cloud.sh build --local-build does NOT call gcloud builds submit"
fi

# Check 4: vitest-cloud.sh build --local-build uses docker build (not Cloud Build)
rm -f "$FAKE_GCLOUD_LOG" "$FAKE_DOCKER_LOG"; touch "$FAKE_GCLOUD_LOG" "$FAKE_DOCKER_LOG"
bash scripts/vitest-cloud.sh build --local-build 2>&1 > /dev/null || true
check "vitest-cloud.sh build --local-build calls docker build" \
  grep -q 'build' "$FAKE_DOCKER_LOG"

# Check 20 (kata e83z): the build lanes run non-interactive under agents —
# the Vitest wrapper passes `--quiet` and explicit project/account flags, and
# mints an identity preflight token BEFORE any build/submit work. The e2e
# wrapper still uses its existing TTY-gated prompt environment.
rm -f "$FAKE_GCLOUD_LOG"; touch "$FAKE_GCLOUD_LOG"
env -u CLOUDSDK_CORE_DISABLE_PROMPTS PATH="$FAKE_DIR:$PATH" bash scripts/vitest-cloud.sh build >/dev/null 2>&1 </dev/null || true
check "vitest build lane: every gcloud call supplies --quiet, project, and account" \
  awk '
    /^FAKE_GCLOUD:/ {
      seen = 1
      if ($0 !~ /--project=[^ ]+/ || $0 !~ /--account=[^ ]+/ || $0 !~ /--quiet/) bad = 1
    }
    END { exit !(seen && !bad) }
  ' "$FAKE_GCLOUD_LOG"
check "vitest build lane: preflight token precedes builds submit" \
  bash -c '
    tok="$(grep -n "auth print-access-token" "$1" | head -1 | cut -d: -f1)"
    sub="$(grep -n "builds submit" "$1" | head -1 | cut -d: -f1)"
    [ -n "$tok" ] && [ -n "$sub" ] && [ "$tok" -lt "$sub" ]
  ' _ "$FAKE_GCLOUD_LOG"

rm -f "$FAKE_GCLOUD_LOG"; touch "$FAKE_GCLOUD_LOG"
env -u CLOUDSDK_CORE_DISABLE_PROMPTS PATH="$FAKE_DIR:$PATH" bash scripts/e2e-cloud.sh build >/dev/null 2>&1 </dev/null || true
check "e2e build lane: prompts disabled (non-TTY) + preflight token mint precedes builds submit" \
  bash -c '
    grep -q "PROMPTS_DISABLED=1" "$1" || exit 1
    tok="$(grep -n "auth print-access-token" "$1" | head -1 | cut -d: -f1)"
    sub="$(grep -n "builds submit" "$1" | head -1 | cut -d: -f1)"
    [ -n "$tok" ] && [ -n "$sub" ] && [ "$tok" -lt "$sub" ]
  ' _ "$FAKE_GCLOUD_LOG"

rm -f "$FAKE_GCLOUD_LOG"; touch "$FAKE_GCLOUD_LOG"
check "e2e build lane under a real TTY leaves prompts enabled" \
  bash -c '
    script -qec "env -u CLOUDSDK_CORE_DISABLE_PROMPTS PATH=\"$1:\$PATH\" bash scripts/e2e-cloud.sh build" /dev/null >/dev/null 2>&1 || true
    ! grep -q "PROMPTS_DISABLED=1" "$2"
  ' _ "$FAKE_DIR" "$FAKE_GCLOUD_LOG"

# Check 21 (kata e83z delta review F2): the DIRECT build lane must surface
# loud dirty-tree state when the -dirty image path is taken. `build` computes
# the same `-dirty` sentinel tag the run lane warns about, and a direct
# `npm run test:cloud:build` on a dirty tree must lead the build work with the
# same WARNING shape (the run lane's own WARNING is pinned by V10/W15c).
# Hermetic dirty-forcing: a temporary untracked file (untracked counts as
# dirty — the image bakes the working tree), removed right after the runs.
BUILD_DIRTY_MARKER="$ROOT/.cloud-build-dirty-check-$$"
touch "$BUILD_DIRTY_MARKER"

rm -f "$FAKE_GCLOUD_LOG"; touch "$FAKE_GCLOUD_LOG"
VITEST_BUILD_DIRTY_OUT=$(env PATH="$FAKE_DIR:$PATH" bash scripts/vitest-cloud.sh build 2>&1 </dev/null) && VB_RC=0 || VB_RC=$?
check "vitest build lane on a dirty tree: loud WARNING precedes the build work" \
  bash -c '
    [ "$1" = "0" ] &&
    grep -q "WARNING: dirty worktree" <<<"$2" &&
    grep -q "not content-addressed" <<<"$2" &&
    warn="$(grep -n "WARNING: dirty worktree" <<<"$2" | head -1 | cut -d: -f1)" &&
    build="$(grep -n "Building Docker image" <<<"$2" | head -1 | cut -d: -f1)" &&
    [ -n "$warn" ] && [ -n "$build" ] && [ "$warn" -lt "$build" ]
  ' _ "$VB_RC" "$VITEST_BUILD_DIRTY_OUT"

rm -f "$FAKE_GCLOUD_LOG"; touch "$FAKE_GCLOUD_LOG"
E2E_BUILD_DIRTY_OUT=$(env PATH="$FAKE_DIR:$PATH" bash scripts/e2e-cloud.sh build 2>&1 </dev/null) && EB_RC=0 || EB_RC=$?
check "e2e build lane on a dirty tree: loud WARNING precedes the build work" \
  bash -c '
    [ "$1" = "0" ] &&
    grep -q "WARNING: dirty worktree" <<<"$2" &&
    grep -q "not content-addressed" <<<"$2" &&
    warn="$(grep -n "WARNING: dirty worktree" <<<"$2" | head -1 | cut -d: -f1)" &&
    build="$(grep -n "Building Docker image" <<<"$2" | head -1 | cut -d: -f1)" &&
    [ -n "$warn" ] && [ -n "$build" ] && [ "$warn" -lt "$build" ]
  ' _ "$EB_RC" "$E2E_BUILD_DIRTY_OUT"

rm -f "$BUILD_DIRTY_MARKER"

# Cleanup
rm -rf "$FAKE_DIR"

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "=== All checks passed ==="
  exit 0
else
  echo "=== $FAILURES check(s) failed ==="
  exit 1
fi
