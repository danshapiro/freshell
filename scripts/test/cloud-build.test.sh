#!/usr/bin/env bash
# Test: cloud-build — verify cloudbuild.yaml, .gcloudignore, and --local-build flag.
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

CLOUDBUILD="$ROOT/docker/cloud-run/cloudbuild.yaml"
GCLOUDIGNORE="$ROOT/.gcloudignore"

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

# Check 1: cloudbuild.yaml exists
check "cloudbuild.yaml exists" test -f "$CLOUDBUILD"

# Check 2: cloudbuild.yaml is valid YAML (using Node yaml package)
check "cloudbuild.yaml is valid YAML" \
  node -e "const yaml = require('yaml'); yaml.parse(require('fs').readFileSync('$CLOUDBUILD', 'utf8'))" 2>/dev/null

# Check 3: cloudbuild.yaml references the correct Dockerfile path
check "cloudbuild.yaml references docker/cloud-run/Dockerfile" \
  grep -q 'docker/cloud-run/Dockerfile' "$CLOUDBUILD"

# Check 4: cloudbuild.yaml uses buildx build with --push
check "cloudbuild.yaml uses buildx build" \
  grep -q 'buildx' "$CLOUDBUILD"
check "cloudbuild.yaml uses --push" \
  grep -q -- '--push' "$CLOUDBUILD"

# Check 5: cloudbuild.yaml uses E2_HIGHCPU_32 under options
check "cloudbuild.yaml uses E2_HIGHCPU_32" \
  grep -q 'E2_HIGHCPU_32' "$CLOUDBUILD"

# Check 6: cloudbuild.yaml has timeout at top level (not under options)
check "cloudbuild.yaml has timeout at top level" \
  node -e "const yaml = require('yaml'); const d = yaml.parse(require('fs').readFileSync('$CLOUDBUILD', 'utf8')); if (!d.timeout) process.exit(1); if (d.options && d.options.timeout) process.exit(1)"

# Check 7: cloudbuild.yaml uses ${_IMAGE} substitution (not a hard-coded URL)
check "cloudbuild.yaml uses \${_IMAGE} substitution" \
  grep -q '${_IMAGE}' "$CLOUDBUILD"

# Check 8: cloudbuild.yaml enables BuildKit
check "cloudbuild.yaml enables BuildKit" \
  grep -q 'DOCKER_BUILDKIT=1' "$CLOUDBUILD"

# Check 9: cloudbuild.yaml uses mode=max in cache-to reference
check "cloudbuild.yaml uses mode=max in cache-to" \
  grep -q 'mode=max' "$CLOUDBUILD"

# Check 10: .gcloudignore exists
check ".gcloudignore exists" test -f "$GCLOUDIGNORE"

# Check 11: .gcloudignore excludes .git, node_modules, target, dist, .worktrees/
for pattern in '.git' 'node_modules' 'target' 'dist' '.worktrees'; do
  check ".gcloudignore excludes '$pattern'" grep -q "$pattern" "$GCLOUDIGNORE"
done

# Check 12: .gcloudignore does NOT exclude docs/ wholesale (needed for docs/skills/testing.md)
if grep -q '^docs/$' "$GCLOUDIGNORE"; then
  echo "FAIL: .gcloudignore excludes docs/ wholesale (breaks docs/skills/testing.md)"
  FAILURES=$((FAILURES + 1))
else
  echo "PASS: .gcloudignore does not exclude docs/ wholesale"
fi

# Check 13: .gcloudignore has !AGENTS.md exception
check ".gcloudignore has !AGENTS.md" grep -q '!AGENTS.md' "$GCLOUDIGNORE"

# Check 14: e2e-cloud.sh help mentions --local-build
check "e2e-cloud.sh help mentions --local-build" \
  bash -c "bash scripts/e2e-cloud.sh help 2>&1 | grep -q -- '--local-build'"

# Check 15: vitest-cloud.sh help mentions --local-build
check "vitest-cloud.sh help mentions --local-build" \
  bash -c "bash scripts/vitest-cloud.sh help 2>&1 | grep -q -- '--local-build'"

# Check 16: e2e-cloud.sh build (default) with fake gcloud dispatches to Cloud Build
FAKE_DIR=$(mktemp -d)
# Fake Cloud Build: an async submit whose first status poll reports SUCCESS
# and whose step output carries the pushed digest (sha256:0…01).
cat > "$FAKE_DIR/gcloud" << 'FAKE'
#!/usr/bin/env bash
echo "FAKE_GCLOUD: $@" >> "${FAKE_GCLOUD_LOG:-/dev/null}"
if [[ "$*" == "meta list-files-for-upload"* ]]; then printf '%s\n' package.json docker/cloud-run/Dockerfile docker/cloud-run/cloudbuild.yaml; exit 0; fi
if [[ "$*" == "builds submit"* ]]; then echo "fake-build-1"; exit 0; fi
if [[ "$*" == "builds list"* ]]; then exit 0; fi
if [[ "$*" == "builds describe"* ]]; then
  if [[ "$*" == *"buildStepOutputs"* ]]; then
    printf '{"results":{"buildStepOutputs":["","%s"]}}\n' "$(printf 'sha256:%064d' 1 | base64 -w0)"
  else
    echo SUCCESS
  fi
  exit 0
fi
if [[ "$*" == *"artifacts docker images describe"* ]]; then exit 1; fi
if [[ "$*" == *"artifacts repositories describe"* ]]; then exit 0; fi
if [[ "$*" == *"auth print-access-token"* ]]; then echo "fake-token"; exit 0; fi
if [[ "$*" == *"info"* ]]; then echo "/usr/lib/google-cloud-sdk"; exit 0; fi
exit 0
FAKE
# Fake docker: build records an image id, push reports digest sha256:0…03.
cat > "$FAKE_DIR/docker" << 'FAKE'
#!/usr/bin/env bash
echo "FAKE_DOCKER: $@" >> "${FAKE_DOCKER_LOG:-/dev/null}"
case "${1:-}" in
  login) cat >/dev/null ;;
  build)
    prev=""
    for a in "$@"; do
      if [ "$prev" = "--iidfile" ]; then printf 'sha256:%064d' 2 > "$a"; fi
      prev="$a"
    done ;;
  push) printf '%s: digest: sha256:%064d size: 1\n' "${2##*:}" 3 ;;
esac
exit 0
FAKE
chmod +x "$FAKE_DIR/gcloud" "$FAKE_DIR/docker"

export FAKE_GCLOUD_LOG="$FAKE_DIR/gcloud.log"
export FAKE_DOCKER_LOG="$FAKE_DIR/docker.log"
touch "$FAKE_GCLOUD_LOG" "$FAKE_DOCKER_LOG"
export PATH="$FAKE_DIR:$PATH"
# Keep the wrappers' same-machine image lock inside this suite's sandbox.
export FRESHELL_CLOUD_IMAGE_LOCK_DIR="$FAKE_DIR/locks"
CLOUD_DIGEST_RE='@sha256:0\{63\}1'
LOCAL_DIGEST_RE='@sha256:0\{63\}3'

# Default build should use Cloud Build (gcloud builds submit)
E2E_BUILD_OUT=$(bash scripts/e2e-cloud.sh build 2>&1) || true
check "e2e-cloud.sh build (default) calls gcloud builds submit" \
  grep -q 'builds submit' "$FAKE_GCLOUD_LOG"
check "e2e-cloud.sh build (default) reports the digest the Cloud Build recorded" \
  grep -q "Cloud Build complete: .*${CLOUD_DIGEST_RE}" <<< "$E2E_BUILD_OUT"

# Check 17: vitest-cloud.sh build (default) with fake gcloud dispatches to Cloud Build
rm -f "$FAKE_GCLOUD_LOG"; touch "$FAKE_GCLOUD_LOG"
VITEST_BUILD_OUT=$(bash scripts/vitest-cloud.sh build 2>&1) || true
check "vitest-cloud.sh build (default) calls gcloud builds submit" \
  grep -q 'builds submit' "$FAKE_GCLOUD_LOG"
check "vitest-cloud.sh build (default) reports the digest the Cloud Build recorded" \
  grep -q "Cloud Build complete: .*${CLOUD_DIGEST_RE}" <<< "$VITEST_BUILD_OUT"

# Check 17b: the Cloud Build submission receives the immutable source commit
# that the Docker build stamps into the Rust and client artifacts. This is a
# process-level wrapper contract: the fake gcloud records the argv produced by
# the real wrapper, rather than inspecting wrapper source text.
EXPECTED_BUILD_COMMIT="$(git rev-parse HEAD)"
check "vitest-cloud.sh Cloud Build receives the exact HEAD build commit" \
  grep -q -- "_FRESHELL_BUILD_COMMIT=${EXPECTED_BUILD_COMMIT}" "$FAKE_GCLOUD_LOG"

# Check 18: e2e-cloud.sh build --local-build uses docker build (not Cloud Build)
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

# Check 19: vitest-cloud.sh build --local-build uses docker build (not Cloud Build)
rm -f "$FAKE_GCLOUD_LOG" "$FAKE_DOCKER_LOG"; touch "$FAKE_GCLOUD_LOG" "$FAKE_DOCKER_LOG"
bash scripts/vitest-cloud.sh build --local-build 2>&1 > /dev/null || true
check "vitest-cloud.sh build --local-build calls docker build" \
  grep -q 'build' "$FAKE_DOCKER_LOG"

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
