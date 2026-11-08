const SANDBOX_TARGET_DIRECTORY = "/freshell-test-artifacts/targets/46620d7db107"
const SANDBOX_CARGO_BUILD_JOBS=3, SANDBOX_RUST_TEST_THREADS=4, SANDBOX_TOKIO_WORKER_THREADS=2
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export function sandboxCommand(argv: string[]): string {
  // Fixed wrapper text owns only its two newly allocated temporary directories.
  // Arguments remain separately quoted words; none becomes shell code.
  return `set -e
owned_tmp="$(mktemp -d /freshell-test-artifacts/.freshell-rust-tests-XXXXXXXX)"
# Ordinary Rust fixtures append UUID-bearing Unix socket paths. Keep their
# actual root short; executable fixtures retain the separate artifact boundary.
owned_runtime_tmp="$owned_tmp"
runner_pid=
remove_owned_temps() {
  rm -rf -- "$owned_tmp" "$owned_runtime_tmp"
}
cleanup() {
  status=$?
  trap - EXIT
  remove_owned_temps || { [ "$status" -ne 0 ] || status=1; }
  exit "$status"
}
interrupt() {
  trap '' INT TERM HUP
  if [ -n "$runner_pid" ]; then
    kill -s "$1" "$runner_pid" 2>/dev/null || true
    # A child may ignore termination. Remove our artifacts before waiting;
    # the sandbox owner separately settles all remaining container work.
    remove_owned_temps
    wait "$runner_pid" || true
  fi
  exit "$2"
}
trap cleanup EXIT
trap 'interrupt INT 130' INT
trap 'interrupt TERM 143' TERM
trap 'interrupt HUP 129' HUP
# Three random characters leave room for tempfile/runtime/incarnation UUIDs
# under Linux sun_path, while this existing volume permits fixture execution.
owned_runtime_tmp="$(mktemp -d /freshell-test-artifacts/XXX)"
printf '{"severity":"info","event":"rust_test_temp_created","directory":"%s","runtimeDirectory":"%s"}\\n' "$owned_tmp" "$owned_runtime_tmp"
# Preserve every test while bounding independent libtest/Tokio runtimes within
# the sandbox's existing PID budget. Runtime construction precedes fixture locks.
export CARGO_TARGET_DIR=${shellQuote(SANDBOX_TARGET_DIRECTORY)}
export TMPDIR="$owned_runtime_tmp" FRESHELL_TEST_EXECUTABLE_TMP_DIR="$owned_tmp" FRESHELL_RUST_TEST_SANDBOX=0 CARGO_BUILD_JOBS=${SANDBOX_CARGO_BUILD_JOBS} RUST_TEST_THREADS=${SANDBOX_RUST_TEST_THREADS} TOKIO_WORKER_THREADS=${SANDBOX_TOKIO_WORKER_THREADS}
node --import tsx /workspace/scripts/testing/run-rust-tests.ts ${argv.map(shellQuote).join(' ')} &
runner_pid=$!
wait "$runner_pid"`
}

process.stdout.write(sandboxCommand([]))
