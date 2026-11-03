#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
TEST_TMP="$(mktemp -d "${REPO_ROOT}/.test-tmp/sandbox-external-browser.XXXXXXXX")"
FAKE_BIN="${TEST_TMP}/bin"
DOCKER_CALLS="${TEST_TMP}/docker-calls.jsonl"
DESCRIPTOR_DIR="$(mktemp -d "${TMPDIR:-/tmp}/freshell-sandbox-external-handoff.XXXXXXXX")"
DESCRIPTOR="${DESCRIPTOR_DIR}/external-target.json"
export FRESHELL_TEST_WORKSPACE_ROOT="${REPO_ROOT}"
export DOCKER_CALLS
export FRESHELL_SANDBOX_CACHE_PREFIX="freshell-external-admission-${TEST_TMP##*.}"
trap 'rm -rf -- "${TEST_TMP}" "${DESCRIPTOR_DIR}"' EXIT

mkdir -p "${FAKE_BIN}"
chmod 0700 "${DESCRIPTOR_DIR}"

cat >"${FAKE_BIN}/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
python3 - "${DOCKER_CALLS}" "$@" <<'PY'
import json
import sys
with open(sys.argv[1], "a", encoding="utf-8") as stream:
    stream.write(json.dumps(sys.argv[2:]) + "\n")
PY

case "${1:-}" in
  image|network)
    exit 0
    ;;
  volume)
    case "${2:-}" in
      ls)
        for ((index = 1; index <= $#; index++)); do
          if [ "${!index}" = --filter ]; then
            next=$((index + 1))
            printf '%s\n' "${!next#name=}"
            exit 0
          fi
        done
        exit 0
        ;;
      inspect)
        hash="$(printf '%s' "${FRESHELL_TEST_WORKSPACE_ROOT}" | sha256sum)"
        hash="${hash%% *}"
        printf '{"com.freshell.cache.owner":"freshell","com.freshell.cache.purpose":"rust-target","com.freshell.cache.schema":"1","com.freshell.cache.worktree-sha256":"%s"}\n' "${hash}"
        exit 0
        ;;
    esac
    ;;
  run)
    for ((index = 1; index <= $#; index++)); do
      if [ "${!index}" = --cidfile ]; then
        next=$((index + 1))
        printf '%064d\n' 1 >"${!next}"
        exit 0
      fi
    done
    exit 1
    ;;
  container)
    if [ "${2:-}" = inspect ]; then exit 1; fi
    ;;
  ps)
    exit 0
    ;;
esac
exit 0
SH
chmod 0700 "${FAKE_BIN}/docker"

write_descriptor() {
  local target_path="$1" selector="$2"
  python3 - "${target_path}" "${selector}" <<'PY'
import json
import sys

descriptor = {
    "FRESHELL_E2E_TARGET_URL": "https://owned.example.invalid",
    "FRESHELL_E2E_TARGET_WS_URL": "wss://owned.example.invalid/ws",
    "FRESHELL_E2E_TARGET_TOKEN": "sandbox-test-bearer-sentinel",
    "FRESHELL_RUNTIME_EXTERNAL_RUN_ID": "7aab49a4-08ed-4ca7-a4b2-6501f4821a63",
    "FRESHELL_RUNTIME_EXTERNAL_CANDIDATE_SHA": "a" * 40,
    "FRESHELL_RUNTIME_EXTERNAL_SPEC": "test/e2e-browser/specs/runtime-terminal-continuity-rust.spec.ts",
    "FRESHELL_RUNTIME_EXTERNAL_GREP": sys.argv[2],
}
with open(sys.argv[1], "w", encoding="utf-8") as stream:
    json.dump(descriptor, stream)
    stream.write("\n")
PY
  chmod 0600 "${target_path}"
}

run_external() {
  PATH="${FAKE_BIN}:${PATH}" FRESHELL_SANDBOX_DEPENDENCIES_READY=1 \
    bash "${REPO_ROOT}/scripts/sandbox-test.sh" --workspace-root "${REPO_ROOT}" \
      --external-browser "${DESCRIPTOR}"
}

P2_G01_TITLE='P2-G01: real browser shell survives ten graceful/abrupt web replacements'
write_descriptor "${DESCRIPTOR}" "${P2_G01_TITLE}"
STATUS=0
run_external >"${TEST_TMP}/valid.stdout" 2>"${TEST_TMP}/valid.stderr" || STATUS=$?
if [ "${STATUS}" -ne 0 ]; then
  cat "${TEST_TMP}/valid.stdout" "${TEST_TMP}/valid.stderr" >&2
  echo 'FAIL: the fixed P2-G01 sandbox route did not settle successfully' >&2
  exit 1
fi
grep -q '"event":"sandbox_workload_finished"' "${TEST_TMP}/valid.stderr"

GIT_COMMON_DIR="$(git -C "${REPO_ROOT}" rev-parse --path-format=absolute --git-common-dir)"
GIT_COMMON_DIR="$(realpath -e "${GIT_COMMON_DIR}")"
python3 - "${DOCKER_CALLS}" "${DESCRIPTOR}" "${GIT_COMMON_DIR}" <<'PY'
import json
import sys

calls = [json.loads(line) for line in open(sys.argv[1], encoding="utf-8") if line.strip()]
runs = [call for call in calls if call and call[0] == "run"]
assert len(runs) == 1, f"expected one owned container invocation, saw {len(runs)}"
args = runs[0]
assert args.count("--network") == 1 and args[args.index("--network") + 1] == "freshell-sandbox"
assert "host" not in args and "none" not in args
assert "--read-only" in args
assert "--pids-limit" in args and args[args.index("--pids-limit") + 1] == "512"
assert "--memory" in args and args[args.index("--memory") + 1] == "8g"
assert "--security-opt" in args and "no-new-privileges" in args
assert f"type=bind,src={sys.argv[2]},dst=/run/freshell-external-target.json,readonly" in args
assert f"type=bind,src={sys.argv[3]},dst={sys.argv[3]},readonly" in args
assert "GIT_OPTIONAL_LOCKS=0" in args
assert "GIT_CONFIG_COUNT=1" in args
assert "GIT_CONFIG_KEY_0=safe.directory" in args
assert "GIT_CONFIG_VALUE_0=/workspace" in args
assert args[-1] == "pnpm exec tsx scripts/testing/external-browser-sandbox.ts"
joined = "\n".join(args)
for forbidden in ("sandbox-test-bearer-sentinel", "DOCKER_HOST", "/var/run/docker.sock",
                  "/run/docker.sock", ".claude", ".codex", ".config/opencode",
                  "GOOGLE_APPLICATION_CREDENTIALS"):
    assert forbidden not in joined, f"forbidden host authority reached Docker argv: {forbidden}"
assert not any(value.startswith(("FRESHELL_E2E_TARGET_", "FRESHELL_RUNTIME_EXTERNAL_")) for value in args)
PY

: >"${DOCKER_CALLS}"
write_descriptor "${DESCRIPTOR}" "${P2_G01_TITLE}|P2-G04"
STATUS=0
run_external >"${TEST_TMP}/invalid.stdout" 2>"${TEST_TMP}/invalid.stderr" || STATUS=$?
test "${STATUS}" -eq 2
grep -qi 'P2-G01' "${TEST_TMP}/invalid.stderr"
test ! -s "${DOCKER_CALLS}"

: >"${DOCKER_CALLS}"
STATUS=0
PATH="${FAKE_BIN}:${PATH}" FRESHELL_SANDBOX_DEPENDENCIES_READY=1 \
  bash "${REPO_ROOT}/scripts/sandbox-test.sh" --workspace-root "${REPO_ROOT}" \
    --runtime-suite true >"${TEST_TMP}/runtime.stdout" 2>"${TEST_TMP}/runtime.stderr" || STATUS=$?
test "${STATUS}" -eq 0
grep -q '"event":"sandbox_workload_finished"' "${TEST_TMP}/runtime.stderr"
python3 - "${DOCKER_CALLS}" <<'PY'
import json
import sys
calls = [json.loads(line) for line in open(sys.argv[1], encoding="utf-8") if line.strip()]
runs = [call for call in calls if call and call[0] == "run"]
assert len(runs) == 1
args = runs[0]
assert args.count("--network") == 1 and args[args.index("--network") + 1] == "none"
PY

echo 'PASS: P2-G01 external browser dispatch is fixed, bridge-only, read-only, and keeps runtime-suite networkless'
