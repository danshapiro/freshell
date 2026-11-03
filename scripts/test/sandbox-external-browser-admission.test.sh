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
P2_G01_RUN_ID='7aab49a4-08ed-4ca7-a4b2-6501f4821a63'
P2_G01_PNPM_STORE_VOLUME="freshell-p2g01-pnpm-${P2_G01_RUN_ID}"
OUTER_PID=""
cleanup_test_artifacts() {
  local result=$?
  if [ -n "${OUTER_PID}" ] && kill -0 "${OUTER_PID}" 2>/dev/null; then
    kill -TERM "${OUTER_PID}" 2>/dev/null || true
    wait "${OUTER_PID}" 2>/dev/null || true
  fi
  rm -rf -- "${DESCRIPTOR_DIR}"
  if [ "${result}" -eq 0 ]; then
    rm -rf -- "${TEST_TMP}"
  else
    printf 'preserved P2 sandbox test evidence: %s\n' "${TEST_TMP}" >&2
  fi
}
trap cleanup_test_artifacts EXIT

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
            filter="${!next#name=}"
            if [ "${FRESHELL_TEST_DOCKER_FAIL_TARGET_CACHE_LIST:-0}" = 1 ] \
              && [[ "${filter}" == freshell-sandbox-rust-target-v1-* ]]; then
              exit 17
            fi
            python3 - "${DOCKER_CALLS}" "${filter}" <<'PY'
import json
import re
import sys

pattern = re.compile(sys.argv[2])
volumes = set()
for line in open(sys.argv[1], encoding="utf-8"):
    call = json.loads(line)
    if call[:2] == ["volume", "rm"]:
        volumes.discard(call[2])
    elif call and call[0] == "run":
        mounted = [value.split(":", 1)[0] for value in call
                   if value.startswith("freshell-p2g01-pnpm-")
                   and value.endswith(":/home/sandbox/.local/share/pnpm/store")]
        for volume in mounted:
            volumes.add(volume)
            volumes.add(f"{volume}-lookalike")
for volume in sorted(volumes):
    if pattern.search(volume):
        print(volume)
PY
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
        break
      fi
    done
    if [ "${FRESHELL_TEST_DOCKER_FAIL_PREPARATION:-0}" = 1 ] \
      && [ "${FRESHELL_SANDBOX_EXTERNAL_BROWSER_PHASE:-}" = preparation ]; then
      exit 23
    fi
    if [ "${FRESHELL_TEST_DOCKER_BLOCK_PREPARATION:-0}" = 1 ] \
      && [ "${FRESHELL_SANDBOX_EXTERNAL_BROWSER_PHASE:-}" = preparation ]; then
      : >"${FRESHELL_TEST_DOCKER_READY_FILE}"
      sleeper=""
      finish() {
        [ -z "${sleeper}" ] || kill "${sleeper}" 2>/dev/null || true
        [ -z "${sleeper}" ] || wait "${sleeper}" 2>/dev/null || true
        exit 143
      }
      trap finish INT TERM HUP
      sleep 60 &
      sleeper=$!
      wait "${sleeper}"
    fi
    exit 0
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

cat >"${FAKE_BIN}/bash" <<'PY'
#!/usr/bin/python3
import os
import signal
import sys
import time

ready = os.environ.get("FRESHELL_TEST_PREPARATION_READY_FILE")
signal_file = os.environ.get("FRESHELL_TEST_PREPARATION_SIGNAL_FILE")
if os.environ.get("FRESHELL_SANDBOX_PREPARE_ONLY") == "1" and ready and signal_file:
    def record(signum, _frame):
        with open(signal_file, "w", encoding="utf-8") as stream:
            stream.write(signal.Signals(signum).name)
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGINT, record)
    signal.signal(signal.SIGTERM, record)
    signal.signal(signal.SIGHUP, record)
    with open(ready, "w", encoding="utf-8"):
        pass
    while True:
        time.sleep(1)

os.execv("/bin/bash", ["bash", *sys.argv[1:]])
PY
chmod 0700 "${FAKE_BIN}/bash"

write_descriptor() {
  local target_path="$1" selector="$2"
  if [ -e "${target_path}" ]; then
    chmod 0600 "${target_path}"
  fi
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
  chmod 0444 "${target_path}"
}

run_external() {
  PATH="${FAKE_BIN}:${PATH}" FRESHELL_SANDBOX_DEPENDENCIES_READY=1 FRESHELL_SANDBOX_EXTERNAL_BROWSER_PHASE=execution \
    FRESHELL_SANDBOX_P2_G01_RUN_ID="${P2_G01_RUN_ID}" \
    FRESHELL_SANDBOX_P2_G01_PNPM_STORE_VOLUME="${P2_G01_PNPM_STORE_VOLUME}" \
    bash "${REPO_ROOT}/scripts/sandbox-test.sh" --workspace-root "${REPO_ROOT}" \
      --external-browser "${DESCRIPTOR}"
}

run_external_with_preparation() {
  PATH="${FAKE_BIN}:${PATH}" FRESHELL_SANDBOX_P2_G01_RUN_ID="${P2_G01_RUN_ID}" \
    FRESHELL_SANDBOX_P2_G01_PNPM_STORE_VOLUME="${P2_G01_PNPM_STORE_VOLUME}" \
    bash "${REPO_ROOT}/scripts/sandbox-test.sh" --workspace-root "${REPO_ROOT}" \
      --external-browser "${DESCRIPTOR}"
}

assert_preparation_store_removed() {
  local output_path="$1"
  grep -q '"event":"sandbox_external_pnpm_store_settled".*"phase":"preparation".*"absent":true.*"removed":true' "${output_path}"
  python3 - "${DOCKER_CALLS}" "${P2_G01_PNPM_STORE_VOLUME}" <<'PY'
import json
import sys
calls = [json.loads(line) for line in open(sys.argv[1], encoding="utf-8") if line.strip()]
assert [call for call in calls if call[:2] == ["volume", "rm"]] == [["volume", "rm", sys.argv[2]]]
PY
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
grep -q '"phase":"execution"' "${TEST_TMP}/valid.stderr"
grep -q '"event":"sandbox_container_settled"' "${TEST_TMP}/valid.stderr"
grep -q '"event":"sandbox_external_pnpm_store_settled"' "${TEST_TMP}/valid.stderr"

GIT_COMMON_DIR="$(git -C "${REPO_ROOT}" rev-parse --path-format=absolute --git-common-dir)"
GIT_COMMON_DIR="$(realpath -e "${GIT_COMMON_DIR}")"
python3 - "${DOCKER_CALLS}" "${DESCRIPTOR}" "${GIT_COMMON_DIR}" "${P2_G01_PNPM_STORE_VOLUME}" <<'PY'
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
assert f"{sys.argv[4]}:/home/sandbox/.local/share/pnpm/store" in args
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
assert not any(value.startswith(("FRESHELL_E2E_TARGET_", "FRESHELL_RUNTIME_EXTERNAL_",
                                "FRESHELL_SANDBOX_P2_G01_")) for value in args)
PY
python3 - "${DOCKER_CALLS}" "${P2_G01_PNPM_STORE_VOLUME}" <<'PY'
import json
import sys

calls = [json.loads(line) for line in open(sys.argv[1], encoding="utf-8") if line.strip()]
removals = [call for call in calls if call[:2] == ["volume", "rm"]]
assert removals == [["volume", "rm", sys.argv[2]]], removals
PY

: >"${DOCKER_CALLS}"
STATUS=0
run_external_with_preparation >"${TEST_TMP}/prepared.stdout" 2>"${TEST_TMP}/prepared.stderr" || STATUS=$?
if [ "${STATUS}" -ne 0 ]; then
  cat "${TEST_TMP}/prepared.stdout" "${TEST_TMP}/prepared.stderr" >&2
  echo 'FAIL: the P2-G01 preparation plus execution phases did not settle successfully' >&2
  exit 1
fi
python3 - "${DOCKER_CALLS}" "${DESCRIPTOR}" "${P2_G01_PNPM_STORE_VOLUME}" "${TEST_TMP}/prepared.stderr" <<'PY'
import json
import sys

calls = [json.loads(line) for line in open(sys.argv[1], encoding="utf-8") if line.strip()]
runs = [call for call in calls if call and call[0] == "run"]
assert len(runs) == 2, f"expected separate preparation and execution containers, saw {len(runs)}"
prepared, executed = runs
assert prepared.count("--network") == 1 and prepared[prepared.index("--network") + 1] == "freshell-sandbox"
assert executed.count("--network") == 1 and executed[executed.index("--network") + 1] == "freshell-sandbox"
assert not any("/run/freshell-external-target.json" in arg for arg in prepared)
assert f"type=bind,src={sys.argv[2]},dst=/run/freshell-external-target.json,readonly" in executed
assert f"{sys.argv[3]}:/home/sandbox/.local/share/pnpm/store" in prepared
assert f"{sys.argv[3]}:/home/sandbox/.local/share/pnpm/store" in executed
events = [json.loads(line) for line in open(sys.argv[4], encoding="utf-8")
          if line.strip().startswith("{")]
finished = [row for row in events if row.get("event") == "sandbox_workload_finished"]
assert [row.get("phase") for row in finished] == ["preparation", "execution"], finished
assert all(row.get("code") == 0 for row in finished)
assert len({row.get("container") for row in finished}) == 2
settled = [row for row in events if row.get("event") == "sandbox_container_settled"]
assert [row.get("phase") for row in settled] == ["preparation", "execution"], settled
assert all(row.get("code") == 0 and row.get("severity") == "info" for row in settled)
store_cleanup = [row for row in events if row.get("event") == "sandbox_external_pnpm_store_settled"]
assert store_cleanup == [{"severity": "info", "event": "sandbox_external_pnpm_store_settled",
                          "runId": "7aab49a4-08ed-4ca7-a4b2-6501f4821a63",
                          "volume": sys.argv[3], "phase": "execution", "absent": True,
                          "removed": True}], store_cleanup
assert [call for call in calls if call[:2] == ["volume", "rm"]] == [["volume", "rm", sys.argv[3]]]
PY

: >"${DOCKER_CALLS}"
STATUS=0
PATH="${FAKE_BIN}:${PATH}" FRESHELL_TEST_DOCKER_FAIL_PREPARATION=1 \
  run_external_with_preparation >"${TEST_TMP}/prep-failed.stdout" 2>"${TEST_TMP}/prep-failed.stderr" || STATUS=$?
test "${STATUS}" -ne 0
assert_preparation_store_removed "${TEST_TMP}/prep-failed.stderr"

: >"${DOCKER_CALLS}"
READY_FILE="${TEST_TMP}/preparation-docker-started"
STATUS=0
PATH="${FAKE_BIN}:${PATH}" FRESHELL_TEST_DOCKER_BLOCK_PREPARATION=1 \
  FRESHELL_TEST_DOCKER_READY_FILE="${READY_FILE}" \
  FRESHELL_SANDBOX_P2_G01_RUN_ID="${P2_G01_RUN_ID}" \
  FRESHELL_SANDBOX_P2_G01_PNPM_STORE_VOLUME="${P2_G01_PNPM_STORE_VOLUME}" \
  bash "${REPO_ROOT}/scripts/sandbox-test.sh" --workspace-root "${REPO_ROOT}" \
    --external-browser "${DESCRIPTOR}" >"${TEST_TMP}/prep-signalled.stdout" 2>"${TEST_TMP}/prep-signalled.stderr" &
OUTER_PID=$!
python3 - "${READY_FILE}" "${OUTER_PID}" <<'PY'
import os
import sys
import time

ready, pid = sys.argv[1], int(sys.argv[2])
deadline = time.monotonic() + 15
while time.monotonic() < deadline:
    if os.path.exists(ready):
        raise SystemExit(0)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        break
    time.sleep(0.05)
raise SystemExit("preparation Docker fixture did not reach its blocking run")
PY
test -f "${READY_FILE}"
kill -TERM "${OUTER_PID}"
wait "${OUTER_PID}" || STATUS=$?
OUTER_PID=""
test "${STATUS}" -eq 143
assert_preparation_store_removed "${TEST_TMP}/prep-signalled.stderr"

: >"${DOCKER_CALLS}"
python3 - "${DOCKER_CALLS}" "${P2_G01_PNPM_STORE_VOLUME}" <<'PY'
import json
import sys
with open(sys.argv[1], "a", encoding="utf-8") as stream:
    stream.write(json.dumps(["run", f"{sys.argv[2]}:/home/sandbox/.local/share/pnpm/store"]) + "\n")
PY
write_descriptor "${DESCRIPTOR}" "${P2_G01_TITLE}|P2-G04"
STATUS=0
run_external >"${TEST_TMP}/execution-invalid-descriptor.stdout" \
  2>"${TEST_TMP}/execution-invalid-descriptor.stderr" || STATUS=$?
test "${STATUS}" -eq 2
grep -q '"event":"sandbox_external_pnpm_store_settled".*"phase":"execution".*"absent":true.*"removed":true' \
  "${TEST_TMP}/execution-invalid-descriptor.stderr"
python3 - "${DOCKER_CALLS}" "${P2_G01_PNPM_STORE_VOLUME}" <<'PY'
import json
import sys
calls = [json.loads(line) for line in open(sys.argv[1], encoding="utf-8") if line.strip()]
assert [call for call in calls if call[:2] == ["volume", "rm"]] == [["volume", "rm", sys.argv[2]]]
PY
write_descriptor "${DESCRIPTOR}" "${P2_G01_TITLE}"

run_ordinary_preparation_signal_case() {
  local signal_name="$1" expected_status="$2" suffix="$3"
  python3 - "${REPO_ROOT}" "${FAKE_BIN}" "${TEST_TMP}" "${signal_name}" "${expected_status}" "${suffix}" <<'PY'
import os
import pathlib
import signal
import subprocess
import sys
import time

repo, fake_bin, test_tmp, signal_name, expected_code, suffix = sys.argv[1:]
expected_code = int(expected_code)
ready = pathlib.Path(test_tmp, f"runtime-{suffix}-ready")
signal_file = pathlib.Path(test_tmp, f"runtime-{suffix}-signal")
stdout_file = open(pathlib.Path(test_tmp, f"runtime-{suffix}.stdout"), "w", encoding="utf-8")
stderr_file = open(pathlib.Path(test_tmp, f"runtime-{suffix}.stderr"), "w", encoding="utf-8")
environment = os.environ.copy()
environment.update({
    "PATH": f"{fake_bin}:{environment.get('PATH', '')}",
    "FRESHELL_TEST_PREPARATION_READY_FILE": str(ready),
    "FRESHELL_TEST_PREPARATION_SIGNAL_FILE": str(signal_file),
})

def reset_test_signals():
    signal.signal(signal.SIGINT, signal.SIG_DFL)
    signal.signal(signal.SIGHUP, signal.SIG_DFL)

process = subprocess.Popen(
    [str(pathlib.Path(fake_bin, "bash")), str(pathlib.Path(repo, "scripts/sandbox-test.sh")),
     "--workspace-root", repo, "--runtime-suite", "true"],
    env=environment, stdout=stdout_file, stderr=stderr_file, preexec_fn=reset_test_signals,
)
try:
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if ready.exists(): break
        if process.poll() is not None: raise AssertionError("outer runtime preparation exited before signal fixture")
        time.sleep(0.05)
    if not ready.exists(): raise AssertionError("ordinary runtime preparation did not reach signal fixture")
    process.send_signal(getattr(signal, signal_name))
    status = process.wait(timeout=15)
    assert status == expected_code, f"{signal_name} produced exit {status}, expected {expected_code}"
    assert signal_file.read_text(encoding="utf-8") == signal_name, "ordinary prep child received the wrong signal"
finally:
    if process.poll() is None:
        process.send_signal(signal.SIGTERM)
        process.wait(timeout=15)
    stdout_file.close()
    stderr_file.close()
PY
}

run_ordinary_preparation_signal_case SIGINT 130 int
run_ordinary_preparation_signal_case SIGTERM 143 term
run_ordinary_preparation_signal_case SIGHUP 129 hup

# Pause the parent Bash in a deterministic pre-launch window after its DEBUG
# hook installs but before the asynchronous preparation command is forked.
# The ordinary runtime-suite signal handler must remember TERM with no child
# PID yet, then forward it immediately after assigning that PID.
python3 - "${REPO_ROOT}" "${FAKE_BIN}" "${TEST_TMP}" <<'PY'
import os
import pathlib
import signal
import subprocess
import sys
import time

repo, fake_bin, test_tmp = sys.argv[1:]
barrier_entered = pathlib.Path(test_tmp, "prepid-barrier-entered")
barrier_release = pathlib.Path(test_tmp, "prepid-barrier-release")
bash_env = pathlib.Path(test_tmp, "prepid-bash-env")
bash_env.write_text('''if [ "${FRESHELL_SANDBOX_PREPARE_ONLY:-}" != 1 ]; then
  trap '\n    if [[ "${BASH_COMMAND}" == *"FRESHELL_SANDBOX_PREPARE_ONLY=1"* ]] && [ ! -e "${FRESHELL_TEST_PREPID_BARRIER_ENTERED}" ]; then
      : >"${FRESHELL_TEST_PREPID_BARRIER_ENTERED}"
      while [ ! -e "${FRESHELL_TEST_PREPID_BARRIER_RELEASE}" ]; do sleep 0.01; done
    fi\n  ' DEBUG
fi
''', encoding="utf-8")
stdout_file = open(pathlib.Path(test_tmp, "prepid.stdout"), "w", encoding="utf-8")
stderr_path = pathlib.Path(test_tmp, "prepid.stderr")
stderr_file = open(stderr_path, "w", encoding="utf-8")
environment = os.environ.copy()
environment.update({
    "PATH": f"{fake_bin}:{environment.get('PATH', '')}",
    "BASH_ENV": str(bash_env),
    "FRESHELL_TEST_PREPID_BARRIER_ENTERED": str(barrier_entered),
    "FRESHELL_TEST_PREPID_BARRIER_RELEASE": str(barrier_release),
})
process = subprocess.Popen(
    [str(pathlib.Path(fake_bin, "bash")), str(pathlib.Path(repo, "scripts/sandbox-test.sh")),
     "--workspace-root", repo, "--runtime-suite", "true"],
    env=environment, stdout=stdout_file, stderr=stderr_file,
)
try:
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if barrier_entered.exists(): break
        if process.poll() is not None: raise AssertionError("outer runtime preparation exited before its pre-PID barrier")
        time.sleep(0.01)
    if not barrier_entered.exists(): raise AssertionError("ordinary preparation missed the pre-PID barrier")
    process.send_signal(signal.SIGTERM)
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        stderr_file.flush()
        if '"event":"sandbox_preparation_signal_deferred"' in stderr_path.read_text(encoding="utf-8"):
            break
        if process.poll() is not None: raise AssertionError("pre-PID TERM exited without recording a deferred signal")
        time.sleep(0.01)
    else:
        raise AssertionError("pre-PID TERM was not deferred while the child PID was unset")
    barrier_release.touch()
    status = process.wait(timeout=15)
    assert status == 143, f"pre-PID TERM produced exit {status}, expected 143"
    events = [line for line in stderr_path.read_text(encoding="utf-8").splitlines()
              if '"event":"sandbox_preparation_signal_deferred"' in line]
    assert len(events) == 1 and '"signal":"TERM"' in events[0]
finally:
    if process.poll() is None:
        barrier_release.touch()
        process.send_signal(signal.SIGTERM)
        process.wait(timeout=15)
    stdout_file.close()
    stderr_file.close()
PY

: >"${DOCKER_CALLS}"
python3 - "${DOCKER_CALLS}" "${P2_G01_PNPM_STORE_VOLUME}" <<'PY'
import json
import sys
with open(sys.argv[1], "a", encoding="utf-8") as stream:
    stream.write(json.dumps(["run", f"{sys.argv[2]}:/home/sandbox/.local/share/pnpm/store"]) + "\n")
PY
STATUS=0
PATH="${FAKE_BIN}:${PATH}" FRESHELL_TEST_DOCKER_FAIL_TARGET_CACHE_LIST=1 \
  FRESHELL_SANDBOX_DEPENDENCIES_READY=1 FRESHELL_SANDBOX_EXTERNAL_BROWSER_PHASE=execution \
  FRESHELL_SANDBOX_P2_G01_RUN_ID="${P2_G01_RUN_ID}" \
  FRESHELL_SANDBOX_P2_G01_PNPM_STORE_VOLUME="${P2_G01_PNPM_STORE_VOLUME}" \
  bash "${REPO_ROOT}/scripts/sandbox-test.sh" --workspace-root "${REPO_ROOT}" \
    --external-browser "${DESCRIPTOR}" >"${TEST_TMP}/execution-preflight-failed.stdout" \
    2>"${TEST_TMP}/execution-preflight-failed.stderr" || STATUS=$?
test "${STATUS}" -eq 1
grep -q '"event":"sandbox_external_pnpm_store_settled".*"phase":"execution".*"absent":true.*"removed":true' \
  "${TEST_TMP}/execution-preflight-failed.stderr"
python3 - "${DOCKER_CALLS}" "${P2_G01_PNPM_STORE_VOLUME}" <<'PY'
import json
import sys
calls = [json.loads(line) for line in open(sys.argv[1], encoding="utf-8") if line.strip()]
assert [call for call in calls if call[:2] == ["volume", "rm"]] == [["volume", "rm", sys.argv[2]]]
PY

: >"${DOCKER_CALLS}"
write_descriptor "${DESCRIPTOR}" "${P2_G01_TITLE}|P2-G04"
STATUS=0
run_external >"${TEST_TMP}/invalid.stdout" 2>"${TEST_TMP}/invalid.stderr" || STATUS=$?
test "${STATUS}" -eq 2
grep -qi 'P2-G01' "${TEST_TMP}/invalid.stderr"
python3 - "${DOCKER_CALLS}" <<'PY'
import json
import sys
calls = [json.loads(line) for line in open(sys.argv[1], encoding="utf-8") if line.strip()]
assert not any(call and call[0] == "run" for call in calls), calls
assert not any(call[:2] == ["volume", "rm"] for call in calls), calls
PY

write_descriptor "${DESCRIPTOR}" "${P2_G01_TITLE}"
: >"${DOCKER_CALLS}"
STATUS=0
PATH="${FAKE_BIN}:${PATH}" FRESHELL_SANDBOX_P2_G01_RUN_ID="${P2_G01_RUN_ID}" \
  FRESHELL_SANDBOX_P2_G01_PNPM_STORE_VOLUME="freshell-p2g01-pnpm-00000000-0000-0000-0000-000000000000" \
  bash "${REPO_ROOT}/scripts/sandbox-test.sh" --workspace-root "${REPO_ROOT}" \
    --external-browser "${DESCRIPTOR}" >"${TEST_TMP}/wrong-store.stdout" 2>"${TEST_TMP}/wrong-store.stderr" || STATUS=$?
test "${STATUS}" -eq 2
grep -q 'owner run-bound disposable pnpm store' "${TEST_TMP}/wrong-store.stderr"
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
import os
import sys
calls = [json.loads(line) for line in open(sys.argv[1], encoding="utf-8") if line.strip()]
runs = [call for call in calls if call and call[0] == "run"]
assert len(runs) == 1
args = runs[0]
assert args.count("--network") == 1 and args[args.index("--network") + 1] == "none"
assert f"{os.environ['FRESHELL_SANDBOX_CACHE_PREFIX']}-pnpm-store:/home/sandbox/.local/share/pnpm/store" in args
PY

if python3 - "${DOCKER_CALLS}" <<'PY'
import json
import sys
calls = [json.loads(line) for line in open(sys.argv[1], encoding="utf-8") if line.strip()]
raise SystemExit(0 if any(call[:2] == ["volume", "rm"] for call in calls) else 1)
PY
then
  echo 'FAIL: ordinary --runtime-suite removed a shared cache volume' >&2
  exit 1
fi
echo 'PASS: P2-G01 external browser dispatch is fixed, bridge-only, read-only, and keeps runtime-suite networkless'
