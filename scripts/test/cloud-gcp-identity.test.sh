#!/usr/bin/env bash
# Test: cloud-gcp-identity — hermetic coverage for the gcloud-robot identity
# ladder (scripts/lib/gcp-identity.sh) adopted by scripts/e2e-cloud.sh and
# scripts/vitest-cloud.sh. Covers every ladder rung (rung-1 repo pin respect,
# rung-2 GCLOUD_IDENT bypass, rung-3 probe via GCLOUD_ROBOT_HOME, rung-4
# quiet ambient fallback and GCLOUD_ROBOT_REQUIRE=1 fail-closed), bridge/env
# forwarding, operator overrides, and single-probe idempotency.
#
# ALWAYS hermetic: the probe branch drives an inert fake selector under a
# fake GCLOUD_ROBOT_HOME and every wrapper run uses a stubbed gcloud — no
# network, no real credentials, no real IAM answers (skill trap 11).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT"

HELPER="$ROOT/scripts/lib/gcp-identity.sh"
WRAPPER_E2E="$ROOT/scripts/e2e-cloud.sh"
WRAPPER_VITEST="$ROOT/scripts/vitest-cloud.sh"

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

echo "=== Cloud GCP identity ladder test ==="

TDIR="$(mktemp -d /tmp/cloud-gcp-identity.XXXXXX)"
trap 'rm -rf "$TDIR"' EXIT

# Inert stand-in for the gcloud-robot selector: records every invocation
# (proves the probe branch ran) plus the env contract it observed, then
# prints the caller-chosen account or takes the zero-candidate exit-1 path
# with empty stdout (its documented failure shape — see skill known-issues
# trap 11). Touches nothing but $TDIR; real curl/gcloud never run.
FAKE_HOME="$TDIR/robot-home"
mkdir -p "$FAKE_HOME/scripts"
cat > "$FAKE_HOME/scripts/select-gcloud-identity.sh" <<'FAKE_SELECTOR'
#!/usr/bin/env bash
echo ran >> "${SELECTOR_MARKER:?set SELECTOR_MARKER}"
{
  echo "project=${GCLOUD_ROBOT_PROJECT:-} probe=${GCLOUD_ROBOT_PROBE_PERMISSION:-}"
  echo "account=${GCLOUD_ROBOT_ACCOUNT:-}"
  echo "prompts=${CLOUDSDK_CORE_DISABLE_PROMPTS:-unset}"
} >> "${SELECTOR_MARKER}.env"
if [ "${SELECTOR_FAIL:-0}" = "1" ]; then exit 1; fi
printf '%s\n' "${GCLOUD_ROBOT_ACCOUNT:-${SELECTOR_ACCOUNT:-}}"
FAKE_SELECTOR
chmod +x "$FAKE_HOME/scripts/select-gcloud-identity.sh"

# Controlled $HOME fixtures for well-known-path discovery (kata e83z): the
# candidates are all $HOME-relative, and this machine has REAL installs, so
# every probe-capable invocation must control HOME.
EMPTY_HOME="$TDIR/home-empty"
mkdir -p "$EMPTY_HOME"

# mk_robot_install <home> <relpath> [account] — a fake install under a
# controlled home. With an account: a fixed-account fake (deliberately
# marker-free — adoption is proven by the returned ident). Without one: a
# copy of the inert FAKE_HOME selector (marker + SELECTOR_FAIL semantics).
mk_robot_install() {
  local home="$1" rel="$2" acct="${3:-}"
  mkdir -p "$home/$rel/scripts"
  if [ -n "$acct" ]; then
    printf '#!/usr/bin/env bash\necho %s\n' "$acct" > "$home/$rel/scripts/select-gcloud-identity.sh"
  else
    cp "$FAKE_HOME/scripts/select-gcloud-identity.sh" "$home/$rel/scripts/select-gcloud-identity.sh"
  fi
  chmod +x "$home/$rel/scripts/select-gcloud-identity.sh"
}

export SELECTOR_MARKER="$TDIR/selector-ran"
LADDER_STDERR="$TDIR/stderr"

# Reads one "key=value" outcome line out of a run_ladder transcript.
field() {
  grep "^$2=" <<< "$1" | head -1 | cut -d= -f2-
}

# Identity/ladder knobs scrubbed out of the harness environment before every
# ladder/wrapper invocation — an operator machine may legitimately export any
# of these (FRESHELL_GCP_ACCOUNT, GCLOUD_ROBOT_REQUIRE=1, a real
# GCLOUD_ROBOT_HOME, ...), and any leak would silently change which rung a
# check exercises. Every ladder/wrapper call below applies this list, then
# layers only the knobs the check intends.
SCRUB=(-u GCLOUD_IDENT -u GCLOUD_ROBOT_HOME -u GCLOUD_ROBOT_REQUIRE
       -u GCLOUD_ROBOT_PROJECT -u GCLOUD_ROBOT_PROBE_PERMISSION
       -u FRESHELL_GCP_ACCOUNT -u CLOUDSDK_CORE_ACCOUNT -u CLOUDSDK_CORE_PROJECT
       -u SELECTOR_ACCOUNT -u SELECTOR_FAIL
       -u GCLOUD_IDENT_RESOLVED -u FRESHELL_GCP_IDENTITY_SOURCE
       -u FRESHELL_ROBOT_HOME_DISCOVERED
       -u GCLOUD_ROBOT_ACCOUNT -u CLOUDSDK_CORE_DISABLE_PROMPTS)

# Runs the identity ladder in a FRESH bash process over the scrubbed env;
# extra KEY=VALUE arguments are the check's intended knobs, forwarded to env.
# Stdout: rc/ident/account/pin/source outcome lines. Stderr from the ladder
# lands in $LADDER_STDERR. Resets the selector markers per run. Always
# returns 0: the ladder's own rc is reported as the rc= outcome line, so a
# subshell crash shows up as missing lines, not a set -e abort. HOME
# defaults to the controlled $EMPTY_HOME — later env assignments win, so a
# check's own HOME=... knob overrides it — because the well-known-path
# probe must never see the operator's real HOME.
run_ladder() {
  local probe="$1"
  shift
  rm -f "$LADDER_STDERR" "$SELECTOR_MARKER" "$SELECTOR_MARKER.env"
  env "${SCRUB[@]}" HOME="$EMPTY_HOME" "$@" bash -c '
    set -u
    . "$1"
    GCP_PROJECT="misc-puttering-project"
    GCP_ACCOUNT="${FRESHELL_GCP_ACCOUNT:-}"
    if freshell_resolve_cloud_identity "$2"; then rc=0; else rc=$?; fi
    printf "rc=%s\n" "$rc"
    printf "ident=%s\n" "${GCLOUD_IDENT:-}"
    printf "account=%s\n" "${CLOUDSDK_CORE_ACCOUNT:-}"
    printf "pin=%s\n" "$GCP_ACCOUNT"
    printf "source=%s\n" "${FRESHELL_GCP_IDENTITY_SOURCE:-}"
  ' _ "$HELPER" "$probe" 2>"$LADDER_STDERR" || true
}

# --- Check A: sourcing is silent and side-effect-free ---------------------
# help/local lanes source the helper unconditionally, so the source itself
# must never print, resolve, or require any env.
SRC_OUT=$(env "${SCRUB[@]}" bash -c \
  'set -u; . "$1" && declare -F resolve_gcp_identity >/dev/null && declare -F freshell_resolve_cloud_identity >/dev/null && echo sourced-ok' \
  _ "$HELPER" 2>&1 || true)
check "sourcing the helper defines both functions with zero output" \
  bash -c '[ "$1" = "sourced-ok" ]' _ "$SRC_OUT"

# --- Check B: rung 2 — explicit GCLOUD_IDENT bypass, no network -----------
OUT=$(run_ladder "run.jobs.run" GCLOUD_IDENT="fake-bypass@example.invalid" GCLOUD_ROBOT_HOME="$FAKE_HOME")
check "rung-2 bypass: GCLOUD_IDENT flows to pin + exports, selector never runs, silent" \
  bash -c '
    [ "$1" = "0" ] && [ "$2" = "fake-bypass@example.invalid" ] &&
    [ "$3" = "fake-bypass@example.invalid" ] && [ "$4" = "fake-bypass@example.invalid" ] &&
    [ ! -e "$5" ] && [ ! -s "$6" ]
  ' _ "$(field "$OUT" rc)" "$(field "$OUT" ident)" "$(field "$OUT" account)" "$(field "$OUT" pin)" \
      "$SELECTOR_MARKER" "$LADDER_STDERR"

# --- Check C: rung 3 — probe selects an account, env contract forwarded ---
OUT=$(run_ladder "run.jobs.run" GCLOUD_ROBOT_HOME="$FAKE_HOME" SELECTOR_ACCOUNT="gcloud-robot@example.invalid")
check "rung-3 probe: selector account adopted, project+probe env forwarded, silent" \
  bash -c '
    [ "$1" = "0" ] && [ "$2" = "gcloud-robot@example.invalid" ] &&
    [ "$3" = "gcloud-robot@example.invalid" ] && [ "$4" = "gcloud-robot@example.invalid" ] &&
    grep -q "project=misc-puttering-project probe=run.jobs.run" "$5.env" &&
    [ ! -s "$6" ]
  ' _ "$(field "$OUT" rc)" "$(field "$OUT" ident)" "$(field "$OUT" account)" "$(field "$OUT" pin)" \
      "$SELECTOR_MARKER" "$LADDER_STDERR"

# --- Check D: probe finds nothing — quiet ambient note, exit 0 ------------
OUT=$(run_ladder "run.jobs.run" GCLOUD_ROBOT_HOME="$FAKE_HOME" SELECTOR_FAIL=1)
check "probe-empty: one ambient-fallback stderr note, no identity, exit 0" \
  bash -c '
    [ "$1" = "0" ] && [ -z "$2" ] && [ -z "$3" ] && [ -z "$4" ] &&
    [ "$(wc -l < "$5")" = "1" ] &&
    grep -q "no probed identity; using ambient gcloud" "$5" &&
    [ -e "$6" ]
  ' _ "$(field "$OUT" rc)" "$(field "$OUT" ident)" "$(field "$OUT" account)" "$(field "$OUT" pin)" \
      "$LADDER_STDERR" "$SELECTOR_MARKER"

# --- Check E: skill absent — single quiet ambient note, exit 0 ------------
OUT=$(run_ladder "run.jobs.run")
check "skill-absent: exactly one ambient-fallback stderr note, exit 0" \
  bash -c '
    [ "$1" = "0" ] &&
    [ "$(wc -l < "$2")" = "1" ] &&
    grep -q "skill not found .* using ambient gcloud" "$2" &&
    [ ! -e "$3" ]
  ' _ "$(field "$OUT" rc)" "$LADDER_STDERR" "$SELECTOR_MARKER"

# --- Check F: strict mode fails closed when the skill is absent -----------
OUT=$(run_ladder "run.jobs.run" GCLOUD_ROBOT_REQUIRE=1)
check "GCLOUD_ROBOT_REQUIRE=1, skill absent: nonzero rc + strict-mode guidance" \
  bash -c '
    [ "$1" != "0" ] && grep -q "strict mode" "$2" && [ -z "$3" ]
  ' _ "$(field "$OUT" rc)" "$LADDER_STDERR" "$(field "$OUT" account)"

# --- Check G: strict mode fails closed when the probe finds nothing -------
OUT=$(run_ladder "run.jobs.run" GCLOUD_ROBOT_HOME="$FAKE_HOME" SELECTOR_FAIL=1 GCLOUD_ROBOT_REQUIRE=1)
check "GCLOUD_ROBOT_REQUIRE=1, probe empty: nonzero rc + probe failure named" \
  bash -c '
    [ "$1" != "0" ] && grep -q "no identity passes the probe" "$2"
  ' _ "$(field "$OUT" rc)" "$LADDER_STDERR"

# --- Check H: idempotent — a second resolve never re-runs the selector ----
rm -f "$SELECTOR_MARKER"
OUT=$(env "${SCRUB[@]}" GCLOUD_ROBOT_HOME="$FAKE_HOME" SELECTOR_ACCOUNT="once@example.invalid" \
      bash -c '
        set -u
        . "$1"
        GCP_PROJECT="misc-puttering-project"
        GCP_ACCOUNT=""
        freshell_resolve_cloud_identity "run.jobs.run"
        freshell_resolve_cloud_identity "cloudbuild.builds.create"
        printf "ident=%s\n" "$GCLOUD_IDENT"
      ' _ "$HELPER" 2>/dev/null || true)
check "two resolves in one process run the selector exactly once" \
  bash -c '
    [ "$1" = "once@example.invalid" ] && [ "$(wc -l < "$2")" = "1" ]
  ' _ "$(field "$OUT" ident)" "$SELECTOR_MARKER"

# --- Check I: operator-pinned GCLOUD_ROBOT_PROJECT survives the bridge ----
OUT=$(run_ladder "run.jobs.run" GCLOUD_ROBOT_HOME="$FAKE_HOME" SELECTOR_ACCOUNT="robot@example.invalid" \
      GCLOUD_ROBOT_PROJECT="other-project" GCLOUD_ROBOT_PROBE_PERMISSION="custom.perm.check")
check "operator overrides: project + probe pass through to the selector verbatim" \
  bash -c '
    grep -q "project=other-project probe=custom.perm.check" "$2.env" &&
    [ "$1" = "robot@example.invalid" ]
  ' _ "$(field "$OUT" ident)" "$SELECTOR_MARKER"

# --- Check J: rung 1 — a pinned GCP_ACCOUNT short-circuits the ladder -----
# A pin must win BEFORE any ladder work: no selector run (even with
# GCLOUD_ROBOT_HOME + GCLOUD_IDENT present), no CLOUDSDK exports, no stderr,
# and strict mode may not fail a pinned call. The ident transcript line still
# echoes the inherited env value — it is simply never consulted.
OUT=$(run_ladder "run.jobs.run" GCLOUD_IDENT="ident@example.invalid" \
      FRESHELL_GCP_ACCOUNT="pinned@example.invalid" GCLOUD_ROBOT_HOME="$FAKE_HOME" \
      GCLOUD_ROBOT_REQUIRE=1)
check "explicit account pin wins BEFORE the ladder (no probe, no exports, silent)" \
  bash -c '
    [ "$1" = "0" ] && [ "$2" = "pinned@example.invalid" ] && [ -z "$3" ] &&
    [ ! -e "$4" ] && [ ! -s "$5" ]
  ' _ "$(field "$OUT" rc)" "$(field "$OUT" pin)" "$(field "$OUT" account)" \
      "$SELECTOR_MARKER" "$LADDER_STDERR"

# --- Check K: well-known-path discovery (kata e83z) -------------------------
# K1: unset GCLOUD_ROBOT_HOME + a valid install at the .codex well-known path.
WK1_HOME="$TDIR/home-k1"; mkdir -p "$WK1_HOME"
mk_robot_install "$WK1_HOME" ".codex/skills/gcloud-robot" "discovered-robot@example.invalid"
OUT=$(run_ladder "run.jobs.run" HOME="$WK1_HOME")
check "K1 well-known .codex install is discovered and probed" \
  bash -c '
    [ "$1" = "0" ] && [ "$2" = "discovered-robot@example.invalid" ] &&
    [ "$3" = "discovered-robot@example.invalid" ] &&
    case "$4" in *"well-known install: "*) exit 0;; esac; exit 1
  ' _ "$(field "$OUT" rc)" "$(field "$OUT" ident)" "$(field "$OUT" pin)" "$(field "$OUT" source)"

# K2: probe order — .codex wins when all three exist.
WK2_HOME="$TDIR/home-k2"; mkdir -p "$WK2_HOME"
mk_robot_install "$WK2_HOME" ".claude/skills/gcloud-robot" "claude-robot@example.invalid"
mk_robot_install "$WK2_HOME" "code/skill-gcloud-robot/gcloud-robot" "code-robot@example.invalid"
mk_robot_install "$WK2_HOME" ".codex/skills/gcloud-robot" "codex-robot@example.invalid"
OUT=$(run_ladder "run.jobs.run" HOME="$WK2_HOME")
check "K2 first well-known match (.codex) wins over .claude and ~/code" \
  bash -c '[ "$1" = "codex-robot@example.invalid" ]' _ "$(field "$OUT" ident)"

# K2b: .claude is second when .codex is absent.
WK2B_HOME="$TDIR/home-k2b"; mkdir -p "$WK2B_HOME"
mk_robot_install "$WK2B_HOME" ".claude/skills/gcloud-robot" "claude-robot@example.invalid"
mk_robot_install "$WK2B_HOME" "code/skill-gcloud-robot/gcloud-robot" "code-robot@example.invalid"
OUT=$(run_ladder "run.jobs.run" HOME="$WK2B_HOME")
check "K2b .claude wins when .codex absent" \
  bash -c '[ "$1" = "claude-robot@example.invalid" ]' _ "$(field "$OUT" ident)"

# K2c: the ~/code checkout alone is a valid third candidate (guards against
# the candidate list silently losing or misspelling its last entry).
WK2C_HOME="$TDIR/home-k2c"; mkdir -p "$WK2C_HOME"
mk_robot_install "$WK2C_HOME" "code/skill-gcloud-robot/gcloud-robot" "code-only-robot@example.invalid"
OUT=$(run_ladder "run.jobs.run" HOME="$WK2C_HOME")
check "K2c sole ~/code/skill-gcloud-robot install is discovered" \
  bash -c '[ "$1" = "code-only-robot@example.invalid" ]' _ "$(field "$OUT" ident)"

# K3: install present but selector NOT executable -> not a real install; the
# existing one-line no-match note must stay byte-identical and alone on stderr.
WK3_HOME="$TDIR/home-k3"
mkdir -p "$WK3_HOME/.codex/skills/gcloud-robot/scripts"
printf '#!/usr/bin/env bash\necho not-exec-robot@example.invalid\n' \
  > "$WK3_HOME/.codex/skills/gcloud-robot/scripts/select-gcloud-identity.sh"
chmod -x "$WK3_HOME/.codex/skills/gcloud-robot/scripts/select-gcloud-identity.sh"
OUT=$(run_ladder "run.jobs.run" HOME="$WK3_HOME")
check "K3 non-executable selector rejected; ambient note byte-identical, one stderr line, selector never ran" \
  bash -c '
    [ "$1" = "0" ] && [ -z "$2" ] &&
    [ "$(wc -l < "$3")" = "1" ] &&
    grep -qx "gcloud-robot: skill not found at <unset> — using ambient gcloud (set GCLOUD_ROBOT_HOME to get robot identity)" "$3" &&
    [ ! -e "$4" ]
  ' _ "$(field "$OUT" rc)" "$(field "$OUT" ident)" "$LADDER_STDERR" "$SELECTOR_MARKER"

# K4: select-gcloud-identity.sh being a DIRECTORY is not a real executable skill.
WK4_HOME="$TDIR/home-k4"
mkdir -p "$WK4_HOME/.codex/skills/gcloud-robot/scripts/select-gcloud-identity.sh"
OUT=$(run_ladder "run.jobs.run" HOME="$WK4_HOME")
check "K4 directory at the selector path is rejected (one ambient note only)" \
  bash -c '
    [ "$1" = "0" ] && [ -z "$2" ] && [ "$(wc -l < "$3")" = "1" ]
  ' _ "$(field "$OUT" rc)" "$(field "$OUT" ident)" "$LADDER_STDERR"

# K5: discovered install whose probe fails -> the explicit not-selected note
# accompanies the ladder's own probe-empty note; ambient still permitted (rc 0).
WK5_HOME="$TDIR/home-k5"; mkdir -p "$WK5_HOME"
mk_robot_install "$WK5_HOME" ".codex/skills/gcloud-robot"
OUT=$(run_ladder "run.jobs.run" HOME="$WK5_HOME" SELECTOR_FAIL=1)
check "K5 install exists but probe empty -> explicit not-selected note + ladder note, 2 stderr lines, rc 0" \
  bash -c '
    [ "$1" = "0" ] && [ -z "$2" ] &&
    [ "$(wc -l < "$3")" = "2" ] &&
    grep -q "no probed identity; using ambient gcloud" "$3" &&
    grep -q "^gcloud-robot: well-known install at .*/\.codex/skills/gcloud-robot produced no identity$" "$3" &&
    case "$4" in *"well-known install produced no identity"*) exit 0;; esac; exit 1
  ' _ "$(field "$OUT" rc)" "$(field "$OUT" ident)" "$LADDER_STDERR" "$(field "$OUT" source)"

# K6: discovery + strict mode fails closed, still saying the install existed.
OUT=$(run_ladder "run.jobs.run" HOME="$WK5_HOME" SELECTOR_FAIL=1 GCLOUD_ROBOT_REQUIRE=1)
check "K6 strict mode with discovered-but-failing install fails closed, not-selected note present" \
  bash -c '
    [ "$1" != "0" ] &&
    grep -q "no identity passes the probe" "$2" &&
    grep -q "well-known install at .* produced no identity" "$2"
  ' _ "$(field "$OUT" rc)" "$LADDER_STDERR"

# K7: an explicit GCLOUD_ROBOT_HOME suppresses discovery even with installs present.
OUT=$(run_ladder "run.jobs.run" HOME="$WK2_HOME" GCLOUD_ROBOT_HOME="$FAKE_HOME" \
      SELECTOR_ACCOUNT="explicit-home-robot@example.invalid")
check "K7 explicit GCLOUD_ROBOT_HOME wins over well-known paths (source names GCLOUD_ROBOT_HOME)" \
  bash -c '
    [ "$1" = "explicit-home-robot@example.invalid" ] &&
    case "$2" in "gcloud-robot probe (GCLOUD_ROBOT_HOME: "*) exit 0;; esac; exit 1
  ' _ "$(field "$OUT" ident)" "$(field "$OUT" source)"

# K7b: GCLOUD_ROBOT_ACCOUNT — the documented robot-first guarantee lever — is
# forwarded to the selector and selected (the selector probes the env account
# first; the bridge must not scrub or starve it). Uses the MARKER-install home
# (WK5_HOME), whose selector honors SELECTOR_* and records the env contract —
# the fixed-account mk_robot_install fakes ignore GCLOUD_ROBOT_ACCOUNT.
OUT=$(run_ladder "run.jobs.run" HOME="$WK5_HOME" GCLOUD_ROBOT_ACCOUNT="guaranteed-robot@example.invalid")
check "K7b GCLOUD_ROBOT_ACCOUNT is forwarded to the selector and wins the probe" \
  bash -c '
    [ "$1" = "guaranteed-robot@example.invalid" ] &&
    grep -q "^account=guaranteed-robot@example.invalid$" "$2.env"
  ' _ "$(field "$OUT" ident)" "$SELECTOR_MARKER"

# K9: a repeat resolve in the same process (e.g. cmd_run -> cmd_build) keeps
# the FIRST resolve's attribution even when the pin slot is now occupied.
OUT=$(env "${SCRUB[@]}" HOME="$EMPTY_HOME" GCLOUD_ROBOT_HOME="$FAKE_HOME" \
      SELECTOR_ACCOUNT="probe-robot@example.invalid" \
      bash -c '
        set -u
        . "$1"
        GCP_PROJECT="misc-puttering-project"
        GCP_ACCOUNT=""
        freshell_resolve_cloud_identity "run.jobs.run"
        first="${FRESHELL_GCP_IDENTITY_SOURCE:-}"
        GCP_ACCOUNT="later-pin@example.invalid"
        freshell_resolve_cloud_identity "cloudbuild.builds.create"
        printf "first=%s\nsecond=%s\n" "$first" "${FRESHELL_GCP_IDENTITY_SOURCE:-}"
      ' _ "$HELPER" 2>/dev/null || true)
check "K9 repeat resolve after a later pin keeps the first resolve's attribution" \
  bash -c '
    case "$1" in "gcloud-robot probe (GCLOUD_ROBOT_HOME: "*) ;; *) exit 1;; esac
    [ "$1" = "$2" ]
  ' _ "$(field "$OUT" first)" "$(field "$OUT" second)"

# K8: source attribution for the other rungs.
OUT=$(run_ladder "run.jobs.run" GCLOUD_IDENT="env-ident@example.invalid")
check "K8 GCLOUD_IDENT bypass attributes to the GCLOUD_IDENT source" \
  bash -c '
    [ "$1" = "env-ident@example.invalid" ] &&
    [ "$2" = "GCLOUD_IDENT (explicit env bypass)" ]
  ' _ "$(field "$OUT" ident)" "$(field "$OUT" source)"
OUT=$(run_ladder "run.jobs.run" FRESHELL_GCP_ACCOUNT="pin@example.invalid")
check "K8b pin attributes to the pin source" \
  bash -c '[ "$1" = "pin (--account flag or FRESHELL_GCP_ACCOUNT)" ]' _ "$(field "$OUT" source)"

# ---------------------------------------------------------------------------
# Wrapper-level: the ladder drives --account on REAL wrapper cloud runs
# (stubbed gcloud/docker; green-run shape mirrors cloud-exec-id-parse.test.sh).
# ---------------------------------------------------------------------------
echo "--- Wrapper-level identity checks ---"

GTDIR="$TDIR/gcloud-stub"
mkdir -p "$GTDIR"
# Exported: the fake gcloud/docker run as wrapper CHILD processes and read it.
export GREEN_LOG="$TDIR/green-gcloud.log"

# Green-run fake gcloud. images describe reports the image MISSING (exit 1)
# so every run also crosses the build lane (builds submit stubbed); the job
# lifecycle succeeds for any --shards value. Records every argv in $GREEN_LOG
# and every --account token (one per line) in $GREEN_LOG.accounts — an ABSENT
# accounts file is the proof that every call omitted --account.
cat > "$GTDIR/gcloud" <<'GREEN_FAKE'
#!/usr/bin/env bash
echo "GCLOUD_ARGS: $*" >> "${GREEN_LOG:?set GREEN_LOG}"
[ -n "${CLOUDSDK_CORE_DISABLE_PROMPTS:-}" ] && echo "PROMPTS_DISABLED=1" >> "${GREEN_LOG:?set GREEN_LOG}"
# Shell redirection creates its target eagerly, so `grep ... >> FILE` would
# materialize an EMPTY accounts file even when no --account token exists —
# breaking every "--account was omitted" assertion. Capture, write only when
# non-empty: an ABSENT accounts file therefore proves omission.
ACCT_TOKENS="$(grep -oP -- '--account=\S+' <<< "$*" 2>/dev/null || true)"
if [ -n "$ACCT_TOKENS" ]; then printf '%s\n' "$ACCT_TOKENS" >> "${GREEN_LOG}.accounts"; fi
if [[ "$*" == *"info"* ]]; then echo "/nonexistent-sdk-root"; exit 0; fi
if [[ "$*" == *"artifacts docker images describe"* ]]; then exit 1; fi
if [[ "$*" == *"artifacts repositories describe"* ]]; then exit 0; fi
if [[ "$*" == *"artifacts repositories create"* ]]; then exit 0; fi
if [[ "$*" == *"builds submit"* ]]; then exit 0; fi
if [[ "$*" == *"auth print-access-token"* ]]; then echo stub-token; exit 0; fi
# Substring-match order matters: "run jobs executions list|logs read" CONTAINS
# "run jobs execute" as a substring, so the specific execution subcommands are
# matched BEFORE the bare execute branch. (Nested-suite fakes use the same
# discipline.)
if [[ "$*" == *"executions list"* ]]; then echo "green-exec-1"; exit 0; fi
if [[ "$*" == *"logs read"* ]]; then echo "  1 passed (1.0s)"; exit 0; fi
if [[ "$*" == *"logging read"* ]]; then
  if [[ "$*" == *"textPayload =~"* ]]; then
    printf '[{"labels":{"run.googleapis.com/execution_name":"green-exec-1","run.googleapis.com/task_index":"0"},"textPayload":"  1 passed (1.0s)"}]\n'
    exit 0
  fi
  # Structured retry-receipt reconciliation for the green single-task
  # execution this stub reports. Without this branch the e2e wrapper fails
  # closed on receipt evidence before the identity-ladder behavior under
  # test can complete.
  printf '[{"jsonPayload":{"event":"e2e_playwright_task_complete","execution":"green-exec-1","taskIndex":0,"taskCount":1,"recoveredRetryCount":0}}]\n'
  exit 0
fi
if [[ "$*" == *"executions describe"* ]]; then
  if [[ "$*" == *"succeededCount"* ]]; then
    N=$(grep -oP -- '--tasks=\K[0-9]+' "${GREEN_LOG}" | tail -1)
    echo "${N:-1}"
  else
    echo "0"
  fi
  exit 0
fi
if [[ "$*" == *"run jobs execute"* ]]; then echo "Execution [green-exec-1] has successfully completed."; exit 0; fi
if [[ "$*" == *"run jobs"* ]]; then exit 0; fi
exit 0
GREEN_FAKE
cat > "$GTDIR/docker" <<'GREEN_DOCKER'
#!/usr/bin/env bash
if [ ! -t 0 ]; then cat >/dev/null 2>&1 || true; fi
exit 0
GREEN_DOCKER
chmod +x "$GTDIR/gcloud" "$GTDIR/docker"

# Distinctive values per rung and pin source so the accounts log proves
# WHICH token won, never just that some token appeared.
RUNG2_IDENT="rung2-bypass@example.invalid"
RUNG3_ROBOT="rung3-robot@example.invalid"
FLAG_ACCOUNT="flag-wins@example.invalid"
ENV_ACCOUNT="env-wins@example.invalid"

reset_green() {
  rm -f "$GREEN_LOG" "$GREEN_LOG.accounts" "$SELECTOR_MARKER" "$SELECTOR_MARKER.env"
  touch "$GREEN_LOG"
}

# Every gcloud invocation that COULD pin an account DID pin this exact one:
# the accounts log must contain one token per logged gcloud call (the bare
# `gcloud info` PATH-probe call takes no flags and is excluded), all equal to
# the expected value, and non-empty — an omit/present mix or an empty log
# both fail.
accounts_all_equal() {
  [ -s "$GREEN_LOG.accounts" ] || return 1
  local calls tokens
  calls=$(grep '^GCLOUD_ARGS:' "$GREEN_LOG" | grep -vc '^GCLOUD_ARGS: info ')
  tokens=$(wc -l < "$GREEN_LOG.accounts")
  [ "$calls" -gt 0 ] && [ "$calls" -eq "$tokens" ] && \
    [ "$(sort -u "$GREEN_LOG.accounts" | wc -l)" = "1" ] && \
    [ "$(sort -u "$GREEN_LOG.accounts" | head -1)" = "--account=$1" ]
}

# --- W1: e2e rung 2 — GCLOUD_IDENT drives every pinned call ----------------
reset_green
W1_ERR="$TDIR/w1.err"
W1_OUT=$(env "${SCRUB[@]}" HOME="$EMPTY_HOME" PATH="$GTDIR:$PATH" \
         GCLOUD_IDENT="$RUNG2_IDENT" GCLOUD_ROBOT_HOME="$FAKE_HOME" \
         "$WRAPPER_E2E" run --cloud --shards=1 2>"$W1_ERR") && W1_RC=0 || W1_RC=$?
check "W1 e2e rung-2: run succeeds with GCLOUD_IDENT pinned on every call, selector untouched, silent" \
  bash -c '
    [ "$1" = "0" ] && grep -q "All tasks completed successfully" <<<"$2" &&
    [ ! -s "$3" ]
  ' _ "$W1_RC" "$W1_OUT" "$W1_ERR"
check "W1 e2e rung-2: every gcloud call pinned to the GCLOUD_IDENT value" \
  accounts_all_equal "$RUNG2_IDENT"
check "W1 e2e rung-2: selector never ran and no hardcoded human account appeared" \
  bash -c '[ ! -e "$1" ] && ! grep -q "dan@danshapiro" "$2"' _ "$SELECTOR_MARKER" "$GREEN_LOG"

# --- W2: e2e rung 1 — a flag pin wins BEFORE the ladder runs --------------
reset_green
W2_OUT=$(env "${SCRUB[@]}" HOME="$EMPTY_HOME" PATH="$GTDIR:$PATH" \
         GCLOUD_IDENT="$RUNG2_IDENT" FRESHELL_GCP_ACCOUNT="$ENV_ACCOUNT" GCLOUD_ROBOT_HOME="$FAKE_HOME" \
         "$WRAPPER_E2E" run --cloud --shards=1 --account="$FLAG_ACCOUNT" 2>/dev/null) && W2_RC=0 || W2_RC=$?
check "W2 e2e rung-1: --account= flag wins over env and ladder" \
  bash -c '[ "$1" = "0" ]' _ "$W2_RC"
check "W2 e2e rung-1: every gcloud call pinned to the flag value" \
  accounts_all_equal "$FLAG_ACCOUNT"
check "W2 e2e rung-1: the ladder never ran for a pinned call (no probe, even with HOME set)" \
  bash -c '[ ! -e "$1" ]' _ "$SELECTOR_MARKER"

# --- W3: e2e rung 1b — FRESHELL_GCP_ACCOUNT wins BEFORE the ladder --------
reset_green
W3_OUT=$(env "${SCRUB[@]}" HOME="$EMPTY_HOME" PATH="$GTDIR:$PATH" \
         GCLOUD_IDENT="$RUNG2_IDENT" FRESHELL_GCP_ACCOUNT="$ENV_ACCOUNT" GCLOUD_ROBOT_HOME="$FAKE_HOME" \
         "$WRAPPER_E2E" run --cloud --shards=1 2>/dev/null) && W3_RC=0 || W3_RC=$?
check "W3 e2e env-pin: FRESHELL_GCP_ACCOUNT wins over the ladder" \
  bash -c '[ "$1" = "0" ]' _ "$W3_RC"
check "W3 e2e env-pin: every gcloud call pinned to the env value" \
  accounts_all_equal "$ENV_ACCOUNT"
check "W3 e2e env-pin: the ladder never ran for a pinned call" \
  bash -c '[ ! -e "$1" ]' _ "$SELECTOR_MARKER"

# --- W4: e2e rung 3 — the probe result takes the pinned slot ---------------
reset_green
W4_OUT=$(env "${SCRUB[@]}" HOME="$EMPTY_HOME" PATH="$GTDIR:$PATH" \
         GCLOUD_ROBOT_HOME="$FAKE_HOME" SELECTOR_ACCOUNT="$RUNG3_ROBOT" \
         "$WRAPPER_E2E" run --cloud --shards=1 2>/dev/null) && W4_RC=0 || W4_RC=$?
check "W4 e2e rung-3: probed identity pins every call; selector ran once w/ lane probe" \
  bash -c '
    [ "$1" = "0" ] &&
    [ "$(wc -l < "$2")" = "1" ] &&
    grep -q "project=misc-puttering-project probe=run.jobs.run" "$2.env"
  ' _ "$W4_RC" "$SELECTOR_MARKER"
check "W4 e2e rung-3: every gcloud call pinned to the probed robot" \
  accounts_all_equal "$RUNG3_ROBOT"

# --- W5: e2e rung 4 — nothing resolves: --account omitted, one note ---------
reset_green
W5_ERR="$TDIR/w5.err"
W5_OUT=$(env "${SCRUB[@]}" HOME="$EMPTY_HOME" \
         PATH="$GTDIR:$PATH" "$WRAPPER_E2E" run --cloud --shards=1 2>"$W5_ERR") && W5_RC=0 || W5_RC=$?
check "W5 e2e ambient: run succeeds, --account omitted everywhere, one ambient note" \
  bash -c '
    [ "$1" = "0" ] && grep -q "All tasks completed successfully" <<<"$2" &&
    [ ! -e "$3" ] &&
    [ "$(wc -l < "$4")" = "1" ] &&
    grep -q "skill not found .* using ambient gcloud" "$4"
  ' _ "$W5_RC" "$W5_OUT" "$GREEN_LOG.accounts" "$W5_ERR"

# --- W6: vitest parity — rung-2 pin and rung-4 omission -------------------
reset_green
W6A_ERR="$TDIR/w6a.err"
W6A_OUT=$(env "${SCRUB[@]}" HOME="$EMPTY_HOME" PATH="$GTDIR:$PATH" \
           GCLOUD_IDENT="$RUNG2_IDENT" GCLOUD_ROBOT_HOME="$FAKE_HOME" \
           "$WRAPPER_VITEST" run --cloud --config=default --shards=2 2>"$W6A_ERR") && W6A_RC=0 || W6A_RC=$?
check "W6a vitest rung-2: succeeds, every call pinned to GCLOUD_IDENT, selector untouched" \
  bash -c '
    [ "$1" = "0" ] && grep -q "All tasks completed successfully" <<<"$2" &&
    [ ! -e "$3" ] && [ ! -s "$4" ]
  ' _ "$W6A_RC" "$W6A_OUT" "$SELECTOR_MARKER" "$W6A_ERR"
check "W6a vitest rung-2: every gcloud call pinned to the GCLOUD_IDENT value" \
  accounts_all_equal "$RUNG2_IDENT"

reset_green
W6B_ERR="$TDIR/w6b.err"
W6B_OUT=$(env "${SCRUB[@]}" HOME="$EMPTY_HOME" \
           PATH="$GTDIR:$PATH" "$WRAPPER_VITEST" run --cloud --config=default --shards=2 2>"$W6B_ERR") && W6B_RC=0 || W6B_RC=$?
check "W6b vitest ambient: run succeeds, --account omitted everywhere, one ambient note" \
  bash -c '
    [ "$1" = "0" ] && grep -q "All tasks completed successfully" <<<"$2" &&
    [ ! -e "$3" ] &&
    [ "$(wc -l < "$4")" = "1" ] &&
    grep -q "skill not found .* using ambient gcloud" "$4"
  ' _ "$W6B_RC" "$W6B_OUT" "$GREEN_LOG.accounts" "$W6B_ERR"

# --- W7: the four pre-existing stubbed suites are probe-proof (trap 11) ----
# Each pins GCLOUD_IDENT, so running them under a marker-trap
# GCLOUD_ROBOT_HOME whose selector would FAIL must leave the marker untouched
# AND the suites green: no nested wrapper invocation may reach the probe.
# The scrub keeps any harness-level ladder knobs from leaking in and
# invalidating the pin experiment.
for nested in scripts/test/cloud-build.test.sh \
              scripts/test/cloud-exec-id-parse.test.sh \
              scripts/test/cloud-vitest-wrapper.test.sh \
              scripts/test/cloud-run-wrapper.test.sh; do
  rm -f "$SELECTOR_MARKER"
  env "${SCRUB[@]}" GCLOUD_ROBOT_HOME="$FAKE_HOME" SELECTOR_FAIL=1 \
    bash "$nested" >"$TDIR/nested.log" 2>&1 && NESTED_RC=0 || NESTED_RC=$?
  check "W7 trap-11: $nested green and probe-free under hostile GCLOUD_ROBOT_HOME" \
    bash -c '[ "$1" = "0" ] && [ ! -e "$2" ]' _ "$NESTED_RC" "$SELECTOR_MARKER"
done

# --- W7b: the pre-existing stubbed suites are probe-proof against
# well-known-path discovery too (trap 11): each pins GCLOUD_IDENT internally,
# and the bridge must never even discover when GCLOUD_IDENT is set — so a
# hostile HOME full of marker-writing failing installs must stay untouched.
# cloud-run-wrapper is deliberately NOT in this loop: its real cargo +
# Playwright local legs need ~/.rustup and ~/.cache/ms-playwright, so it dies
# at check 4 under a hostile HOME — BEFORE any bridge-relevant invocation —
# making a marker-only assertion here vacuous. It stays covered by W7
# (hostile GCLOUD_ROBOT_HOME under real HOME, green at base — verified
# 2026-09-21) plus its top-of-file GCLOUD_IDENT pin.
HOSTILE_HOME="$TDIR/home-w7b"; mkdir -p "$HOSTILE_HOME"
mk_robot_install "$HOSTILE_HOME" ".codex/skills/gcloud-robot"
for nested in scripts/test/cloud-build.test.sh \
              scripts/test/cloud-exec-id-parse.test.sh \
              scripts/test/cloud-vitest-wrapper.test.sh; do
  rm -f "$SELECTOR_MARKER"
  env "${SCRUB[@]}" HOME="$HOSTILE_HOME" SELECTOR_FAIL=1 \
    bash "$nested" >"$TDIR/nested-w7b.log" 2>&1 && NESTED_RC=0 || NESTED_RC=$?
  check "W7b trap-11: $nested green and probe-free under hostile well-known HOME" \
    bash -c '[ "$1" = "0" ] && [ ! -e "$2" ]' _ "$NESTED_RC" "$SELECTOR_MARKER"
done

# --- W8: help works with no gcloud, no account, fake HOME — and silently ---
# The silence assertion matches ONLY the ladder's runtime diagnostic prefixes
# ("gcloud-robot: skill not found", "gcloud-robot: no probed identity"); the
# help text itself legitimately documents the ladder by name, so a bare
# "gcloud-robot" match would forbid the docs and break the suite by design.
CLEAN_PATH="$PATH"
if GCLOUD_PATH_RESOLVED=$(command -v gcloud 2>/dev/null); then
  GCLOUD_DIRNAME="$(cd "$(dirname "$GCLOUD_PATH_RESOLVED")" && pwd)"
  CLEAN_PATH="$(echo "$PATH" | tr ':' '\n' | grep -vx "$GCLOUD_DIRNAME" | paste -sd:)"
  if [ "$CLEAN_PATH" = "$PATH" ]; then
    echo "FAIL: could not construct a gcloud-free PATH (gcloud dir not on PATH?)"
    FAILURES=$((FAILURES + 1))
    CLEAN_PATH=""
  fi
fi
if [ -n "$CLEAN_PATH" ]; then
  # NOTE: `command -v` is a shell builtin; it must run INSIDE a shell (`env
  # PATH=... bash -c ...`) — `env PATH=... command -v gcloud` tries to exec
  # a program named "command", returns 127 unconditionally, and would
  # certify a non-clean PATH. (The same latent bug exists in
  # cloud-run-wrapper.test.sh check 12 — pre-existing, out of scope here.)
  if env PATH="$CLEAN_PATH" bash -c 'command -v gcloud >/dev/null 2>&1'; then
    echo "FAIL: gcloud still resolvable on the filtered PATH"
    FAILURES=$((FAILURES + 1))
  else
    for wrapper_pair in "E2E:$WRAPPER_E2E" "VITEST:$WRAPPER_VITEST"; do
      lane="${wrapper_pair%%:*}"
      wrapper="${wrapper_pair#*:}"
      rm -f "$SELECTOR_MARKER"
      HELP_OUT=$(env "${SCRUB[@]}" HOME="$EMPTY_HOME" PATH="$CLEAN_PATH" \
        GCLOUD_ROBOT_HOME="$FAKE_HOME" \
        "$wrapper" help 2>&1) && HELP_RC=0 || HELP_RC=$?
      check "W8 $lane help: exit 0, no identity activity, silent" \
        bash -c '
          [ "$1" = "0" ] &&
          ! grep -qE "gcloud-robot: (skill not found|no probed identity)" <<<"$2" && [ ! -e "$3" ]
        ' _ "$HELP_RC" "$HELP_OUT" "$SELECTOR_MARKER"
    done
  fi
fi

# --- W9: the vitest local lane never wakes the ladder ----------------------
rm -f "$SELECTOR_MARKER"
W9_OUT=$(env "${SCRUB[@]}" HOME="$EMPTY_HOME" \
         GCLOUD_ROBOT_HOME="$FAKE_HOME" \
         "$WRAPPER_VITEST" run --local --config=default test/unit/lib/pane-utils.test.ts 2>&1) \
  && W9_RC=0 || W9_RC=$?
check "W9 vitest --local: runs real local vitest, no selector, no ladder output" \
  bash -c '
    [ "$1" = "0" ] &&
    grep -qE "Test Files|passed" <<<"$2" &&
    ! grep -qE "gcloud-robot: (skill not found|no probed identity)" <<<"$2" && [ ! -e "$3" ]
  ' _ "$W9_RC" "$W9_OUT" "$SELECTOR_MARKER"

# --- W12: e2e standalone lanes (build / push / logs) run their OWN ladder ---
# cmd_run populates GCP_ACCOUNT before delegating to cmd_build/cmd_push, so
# run-based checks can NEVER catch a missing resolver or a missing pin-parse
# loop on the standalone lanes. These exercise them directly.

# W12a: standalone build — probe selects, with the BUILD-lane probe permission.
reset_green
W12A_OUT=$(env "${SCRUB[@]}" HOME="$EMPTY_HOME" PATH="$GTDIR:$PATH" \
  GCLOUD_ROBOT_HOME="$FAKE_HOME" SELECTOR_ACCOUNT="$RUNG3_ROBOT" \
  "$WRAPPER_E2E" build 2>/dev/null) && W12A_RC=0 || W12A_RC=$?
check "W12a e2e standalone build: probe identity selected once, build-lane probe permission" \
  bash -c '
    [ "$1" = "0" ] &&
    [ "$(wc -l < "$2")" = "1" ] &&
    grep -q "project=misc-puttering-project probe=cloudbuild.builds.create" "$2.env"
  ' _ "$W12A_RC" "$SELECTOR_MARKER"
check "W12a e2e standalone build: every gcloud call pinned to the probed robot" \
  accounts_all_equal "$RUNG3_ROBOT"

# W12b: strict mode + absent skill must NOT fail an explicitly pinned
# standalone build (rung-1 immunity — guards the short-circuit itself).
reset_green
W12B_ERR="$TDIR/w12b.err"
W12B_OUT=$(env "${SCRUB[@]}" HOME="$EMPTY_HOME" PATH="$GTDIR:$PATH" GCLOUD_ROBOT_REQUIRE=1 \
  "$WRAPPER_E2E" build --account="$FLAG_ACCOUNT" 2>"$W12B_ERR") && W12B_RC=0 || W12B_RC=$?
check "W12b e2e standalone build: --account pin wins, strict mode cannot fail it, silent" \
  bash -c '
    [ "$1" = "0" ] && grep -q "Cloud Build complete" <<<"$2" &&
    [ ! -e "$3" ] && [ ! -s "$4" ]
  ' _ "$W12B_RC" "$W12B_OUT" "$SELECTOR_MARKER" "$W12B_ERR"
check "W12b e2e standalone build: every gcloud call pinned to the flag value" \
  accounts_all_equal "$FLAG_ACCOUNT"

# W12c: standalone push — rung-2 pin must reach describe/print-access-token.
reset_green
W12C_OUT=$(env "${SCRUB[@]}" HOME="$EMPTY_HOME" PATH="$GTDIR:$PATH" GCLOUD_IDENT="$RUNG2_IDENT" \
  "$WRAPPER_E2E" push 2>/dev/null) && W12C_RC=0 || W12C_RC=$?
check "W12c e2e standalone push: succeeds under rung-2 pin" \
  bash -c '[ "$1" = "0" ] && [ ! -e "$3" ]' _ "$W12C_RC" "$W12C_OUT" "$SELECTOR_MARKER"
check "W12c e2e standalone push: every gcloud call pinned to the GCLOUD_IDENT value" \
  accounts_all_equal "$RUNG2_IDENT"
check "W12c e2e standalone push: preflight token mint precedes all lane work" \
  bash -c '
    tok="$(grep -n "auth print-access-token" "$1" | head -1 | cut -d: -f1)"
    work="$(grep -nE "GCLOUD_ARGS:.*(artifacts repositories describe|builds submit)" "$1" | head -1 | cut -d: -f1)"
    [ -n "$tok" ] && [ -n "$work" ] && [ "$tok" -lt "$work" ]
  ' _ "$GREEN_LOG"

# W12d: standalone logs — rung-2 pin on BOTH calls, non-pin args passed through.
reset_green
W12D_OUT=$(env "${SCRUB[@]}" HOME="$EMPTY_HOME" PATH="$GTDIR:$PATH" GCLOUD_IDENT="$RUNG2_IDENT" \
  "$WRAPPER_E2E" logs --limit=3 --freshness=1d 2>/dev/null) && W12D_RC=0 || W12D_RC=$?
check "W12d e2e standalone logs: list+read share the pinned identity, pass-through args preserved" \
  bash -c '
    [ "$1" = "0" ] && [ ! -e "$4" ] &&
    grep "logs read" "$2" | grep -q -- "--limit=3" &&
    grep "logs read" "$2" | grep -q -- "--freshness=1d"
  ' _ "$W12D_RC" "$GREEN_LOG" "$W12D_OUT" "$SELECTOR_MARKER"
check "W12d e2e standalone logs: every gcloud call pinned to the GCLOUD_IDENT value" \
  accounts_all_equal "$RUNG2_IDENT"
check "W12d e2e standalone logs: preflight token mint precedes the executions list" \
  bash -c '
    tok="$(grep -n "auth print-access-token" "$1" | head -1 | cut -d: -f1)"
    work="$(grep -n "GCLOUD_ARGS:.*executions list" "$1" | head -1 | cut -d: -f1)"
    [ -n "$tok" ] && [ -n "$work" ] && [ "$tok" -lt "$work" ]
  ' _ "$GREEN_LOG"

# W12e: standalone logs — flag pin wins on the logs lane (rung 1 there too).
reset_green
W12E_OUT=$(env "${SCRUB[@]}" HOME="$EMPTY_HOME" PATH="$GTDIR:$PATH" GCLOUD_ROBOT_REQUIRE=1 \
  "$WRAPPER_E2E" logs --account="$FLAG_ACCOUNT" 2>/dev/null) && W12E_RC=0 || W12E_RC=$?
check "W12e e2e standalone logs: --account pin honored (rung 1), strict-mode immune" \
  bash -c '[ "$1" = "0" ] && [ ! -e "$3" ]' _ "$W12E_RC" "$W12E_OUT" "$SELECTOR_MARKER"
check "W12e e2e standalone logs: every gcloud call pinned to the flag value" \
  accounts_all_equal "$FLAG_ACCOUNT"

# --- W13: vitest standalone lanes (build / push / logs) — parity pins -------
# W13a: standalone build via probe.
reset_green
W13A_OUT=$(env "${SCRUB[@]}" HOME="$EMPTY_HOME" PATH="$GTDIR:$PATH" \
  GCLOUD_ROBOT_HOME="$FAKE_HOME" SELECTOR_ACCOUNT="$RUNG3_ROBOT" \
  "$WRAPPER_VITEST" build 2>/dev/null) && W13A_RC=0 || W13A_RC=$?
check "W13a vitest standalone build: probe identity selected once, build-lane probe permission" \
  bash -c '
    [ "$1" = "0" ] &&
    [ "$(wc -l < "$2")" = "1" ] &&
    grep -q "project=misc-puttering-project probe=cloudbuild.builds.create" "$2.env"
  ' _ "$W13A_RC" "$SELECTOR_MARKER"
check "W13a vitest standalone build: every gcloud call pinned to the probed robot" \
  accounts_all_equal "$RUNG3_ROBOT"

# W13b: standalone push under rung-2 pin.
reset_green
W13B_OUT=$(env "${SCRUB[@]}" HOME="$EMPTY_HOME" PATH="$GTDIR:$PATH" GCLOUD_IDENT="$RUNG2_IDENT" \
  "$WRAPPER_VITEST" push 2>/dev/null) && W13B_RC=0 || W13B_RC=$?
check "W13b vitest standalone push: succeeds, every gcloud call pinned to GCLOUD_IDENT" \
  bash -c '[ "$1" = "0" ] && [ ! -e "$3" ]' _ "$W13B_RC" "$W13B_OUT" "$SELECTOR_MARKER"
check "W13b vitest standalone push: every gcloud call pinned to the GCLOUD_IDENT value" \
  accounts_all_equal "$RUNG2_IDENT"
check "W13b vitest standalone push: preflight token mint precedes all lane work" \
  bash -c '
    tok="$(grep -n "auth print-access-token" "$1" | head -1 | cut -d: -f1)"
    work="$(grep -nE "GCLOUD_ARGS:.*(artifacts repositories describe|builds submit)" "$1" | head -1 | cut -d: -f1)"
    [ -n "$tok" ] && [ -n "$work" ] && [ "$tok" -lt "$work" ]
  ' _ "$GREEN_LOG"

# W13c: standalone logs under rung-2 pin, pass-through preserved.
reset_green
W13C_OUT=$(env "${SCRUB[@]}" HOME="$EMPTY_HOME" PATH="$GTDIR:$PATH" GCLOUD_IDENT="$RUNG2_IDENT" \
  "$WRAPPER_VITEST" logs --limit=2 2>/dev/null) && W13C_RC=0 || W13C_RC=$?
check "W13c vitest standalone logs: pinned identity on both calls, pass-through preserved" \
  bash -c '
    [ "$1" = "0" ] && [ ! -e "$4" ] &&
    grep "logs read" "$2" | grep -q -- "--limit=2"
  ' _ "$W13C_RC" "$GREEN_LOG" "$W13C_OUT" "$SELECTOR_MARKER"
check "W13c vitest standalone logs: every gcloud call pinned to the GCLOUD_IDENT value" \
  accounts_all_equal "$RUNG2_IDENT"
check "W13c vitest standalone logs: preflight token mint precedes the executions list" \
  bash -c '
    tok="$(grep -n "auth print-access-token" "$1" | head -1 | cut -d: -f1)"
    work="$(grep -n "GCLOUD_ARGS:.*executions list" "$1" | head -1 | cut -d: -f1)"
    [ -n "$tok" ] && [ -n "$work" ] && [ "$tok" -lt "$work" ]
  ' _ "$GREEN_LOG"

# --- W14: e2e run lane — preflight + prompts env reach the green fake -------
reset_green
W14_OUT=$(env "${SCRUB[@]}" PATH="$GTDIR:$PATH" HOME="$EMPTY_HOME" \
  GCLOUD_IDENT="$RUNG2_IDENT" \
  "$WRAPPER_E2E" run --cloud --shards=1 2>/dev/null < /dev/null) && W14_RC=0 || W14_RC=$?
check "W14 e2e run: preflight token mint precedes run jobs create; prompts disabled on non-TTY stdin" \
  bash -c '
    [ "$1" = "0" ] || exit 1
    tok="$(grep -n "auth print-access-token" "$2" | head -1 | cut -d: -f1)"
    create="$(grep -n "run jobs create" "$2" | head -1 | cut -d: -f1)"
    [ -n "$tok" ] && [ -n "$create" ] && [ "$tok" -lt "$create" ] &&
    grep -q "PROMPTS_DISABLED=1" "$2"
  ' _ "$W14_RC" "$GREEN_LOG"
check "W14 e2e run: every gcloud call still pinned (preflight included)" \
  accounts_all_equal "$RUNG2_IDENT"

# --- W15: e2e run-lane banner attribution (stdout) + untouched stderr proof --
reset_green
W15_ERR="$TDIR/w15.err"
W15_OUT=$(env "${SCRUB[@]}" PATH="$GTDIR:$PATH" HOME="$EMPTY_HOME" \
  GCLOUD_IDENT="$RUNG2_IDENT" \
  "$WRAPPER_E2E" run --cloud --shards=1 2>"$W15_ERR" < /dev/null) && W15_RC=0 || W15_RC=$?
check "W15 e2e banner: pinned identity + GCLOUD_IDENT source on stdout" \
  bash -c '
    grep -q "\[e2e-cloud\] Identity: rung2-bypass@example.invalid (source: GCLOUD_IDENT (explicit env bypass))" <<<"$2"
  ' _ "$W15_RC" "$W15_OUT"
check "W15 e2e banner: identity line precedes the first build work and the banner" \
  bash -c '
    ident="$(grep -n "\[e2e-cloud\] Identity:" <<<"$2" | head -1 | cut -d: -f1)"
    [ -n "$ident" ] || exit 1
    firstwork="$(grep -nE "Building Docker image|Running on Cloud Run Jobs" <<<"$2" | head -1 | cut -d: -f1)"
    [ -n "$firstwork" ] && [ "$ident" -lt "$firstwork" ]
  ' _ "$W15_RC" "$W15_OUT"

reset_green
W15B_ERR="$TDIR/w15b.err"
W15B_OUT=$(env "${SCRUB[@]}" PATH="$GTDIR:$PATH" HOME="$EMPTY_HOME" \
  "$WRAPPER_E2E" run --cloud --shards=1 2>"$W15B_ERR" < /dev/null) && W15B_RC=0 || W15B_RC=$?
check "W15b e2e ambient banner: (ambient gcloud) identity + no-robot-skill source; stderr still exactly the one ambient note" \
  bash -c '
    [ "$1" = "0" ] &&
    grep -q "\[e2e-cloud\] Identity: (ambient gcloud) (source: ambient gcloud (no robot skill found))" <<<"$2" &&
    [ "$(wc -l < "$3")" = "1" ] &&
    grep -q "skill not found .* using ambient gcloud" "$3"
  ' _ "$W15B_RC" "$W15B_OUT" "$W15B_ERR"

W15C_ERR="$TDIR/w15c.err"
W15C_DIRTY="$ROOT/.e2e-cloud-dirty-w15c"
touch "$W15C_DIRTY"
W15C_OUT=$(env "${SCRUB[@]}" PATH="$GTDIR:$PATH" HOME="$EMPTY_HOME" \
  "$WRAPPER_E2E" run --cloud --shards=1 2>"$W15C_ERR" < /dev/null) && W15C_RC=0 || W15C_RC=$?
rm -f "$W15C_DIRTY"
check "W15c e2e dirty tree: loud WARNING before the rebuild work itself" \
  bash -c '
    grep -q "\[e2e-cloud\] WARNING: dirty worktree" <<<"$2" &&
    grep -q "not content-addressed" <<<"$2" &&
    warn="$(grep -n "WARNING: dirty worktree" <<<"$2" | head -1 | cut -d: -f1)"
    build="$(grep -n "Building Docker image" <<<"$2" | head -1 | cut -d: -f1)"
    [ -n "$build" ] && [ "$warn" -lt "$build" ]
  ' _ "$W15C_RC" "$W15C_OUT"

# --- W16: the TTY-gated export reaches the selector's environment, before
# the preflight — the selector is the only pre-preflight component that can
# prompt (every other prompt check pins GCLOUD_IDENT and bypasses the probe).
reset_green
W16_HOME="$TDIR/home-w16"; mkdir -p "$W16_HOME"
mk_robot_install "$W16_HOME" ".codex/skills/gcloud-robot"
W16_OUT=$(env "${SCRUB[@]}" PATH="$GTDIR:$PATH" HOME="$W16_HOME" \
  "$WRAPPER_E2E" run --cloud --shards=1 2>/dev/null < /dev/null) && W16_RC=0 || W16_RC=$?
check "W16 non-TTY run: the selector observes CLOUDSDK_CORE_DISABLE_PROMPTS=1 (export precedes the probe)" \
  bash -c '
    [ "$1" = "0" ] &&
    [ -e "$2" ] &&
    grep -q "^prompts=1$" "$2.env"
  ' _ "$W16_RC" "$SELECTOR_MARKER"
rm -f "$SELECTOR_MARKER" "$SELECTOR_MARKER.env"
check "W16b TTY run: the selector observes prompts unset (humans keep interactive reauth)" \
  bash -c '
    script -qec "env -u GCLOUD_IDENT -u GCLOUD_ROBOT_HOME -u GCLOUD_ROBOT_REQUIRE -u GCLOUD_ROBOT_PROJECT -u GCLOUD_ROBOT_PROBE_PERMISSION -u FRESHELL_GCP_ACCOUNT -u CLOUDSDK_CORE_ACCOUNT -u CLOUDSDK_CORE_PROJECT -u CLOUDSDK_CORE_DISABLE_PROMPTS -u SELECTOR_ACCOUNT -u SELECTOR_FAIL -u GCLOUD_IDENT_RESOLVED -u FRESHELL_GCP_IDENTITY_SOURCE -u FRESHELL_ROBOT_HOME_DISCOVERED -u GCLOUD_ROBOT_ACCOUNT PATH=\"$1:\$PATH\" HOME=\"$2\" bash \"$3\" run --cloud --shards=1" /dev/null >/dev/null 2>&1 || true
    [ -e "$4" ] &&
    grep -q "^prompts=unset$" "$4.env"
  ' _ "$GTDIR" "$W16_HOME" "$WRAPPER_E2E" "$SELECTOR_MARKER"

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "=== All checks passed ==="
  exit 0
else
  echo "=== $FAILURES check(s) failed ==="
  exit 1
fi
