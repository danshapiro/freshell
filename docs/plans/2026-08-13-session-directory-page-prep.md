# Session Directory Page-Bounded Preparation Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Gate 0, Tasks 1-7, and Gate 8 are nine
> independent execution units. Every unit starts its own persistent Bash
> session, evaluates the complete Command and Evidence Harness in that
> session before its first Bash command, and runs every Bash fence in that
> unit in the same session. No plan-created variable, function, shell option,
> array, or trap is assumed to survive an execution-unit boundary; durable
> plan state crosses boundaries only through committed Git state and files
> under `$LOG_ROOT`. Externally persisted environment configuration remains
> available where the plan explicitly requires it. Steps use checkbox
> (`- [ ]`) syntax for tracking.

**Goal:** Preserve the current Rust `GET /api/session-directory` contract while limiting full `DirItem` construction, override/metadata/running output decoration, and serialization to returned rows, and limiting owned search annotations to the retained `limit + 1` match descriptors.

**Architecture:** Capture one `Arc<Vec<IndexedSession>>`, complete every await, then borrow its rows only inside one narrow synchronous derivation that returns owned page JSON; explicitly release the snapshot owner immediately afterward. One shallow candidate corpus preserves current override/live membership, revision, stable order, visibility, cursor, and search semantics for every tier. Candidate traversal may inspect the full corpus or the existing deep-search budget, but the final selector retains at most `limit + 1` matches and owned `SearchAnnotation` values; only the first `limit` descriptors become full `DirItem` values and receive returned-output decoration and serialization. Before production cutover, compare the candidate path with the independently executable eager composition over one deterministic 516-case differential; afterward delete the eager composition, with no production flag, canary, or strategy switch.

**Structural objective and non-goals:** This is not an O(`limit`) traversal or allocation claim. Full-corpus shallow keys/candidates, stable sorting, visibility/cursor/title inspection, bounded deep-search traversal, and up to `limit + 1` owned search annotations remain allowed. Borrowed requests may pin obsolete snapshot generations until synchronous derivation completes. No fixed generation-memory, allocator, peak-allocation, or total-RSS non-increase bound is claimed; total RSS requires a separate paired implementation measurement. Task 6 and the Task-7 RED checkpoint may temporarily retain/materialize more work solely to establish behavior equivalence and the failing proof; the final Task-7 and Gate-8 state may not.

**Tech Stack:** Rust 1.96, Axum, Tokio, `freshell-sessions`, `freshell-ws`, Serde JSON, Cargo, Vitest/npm test coordinator.

## Global Constraints

- The only execution worktree is `/home/dan/code/freshell/.worktrees/session-directory-page-prep` on branch `the-usual/session-directory-page-prep`.
- The branch began at the exact reviewed `origin/main` commit `225a91db3e4d48d4b6a7e8bc0987afad8ff31917`. Preserve that SHA as `BASE_SHA` in every scope and unrelated-failure comparison.
- The execute stage begins after this plan has been committed. Gate 0 therefore requires a clean worktree, `BASE_SHA` as an ancestor of `HEAD`, application source identical to `BASE_SHA`, and exactly this committed plan as the sole `BASE_SHA..HEAD` path.
- `/home/dan/code/freshell/.worktrees/session-directory-page-bound` is reference-only. Never edit, format, build through, commit in, or generate evidence inside it.
- The only implementation file an implementation task may stage or commit is `crates/freshell-server/src/session_directory.rs`.
- Final `BASE_SHA..HEAD` scope must contain exactly two paths: this committed plan and `crates/freshell-server/src/session_directory.rs`.
- Do not modify any `Cargo.toml`, crate manifest, `.kata.toml`, dependency, feature, project setting, environment file, `crates/freshell-sessions/**`, `crates/freshell-ws/**`, `crates/freshell-server/src/main.rs`, Node/TypeScript/client/browser file, shared schema, fixture, index refresh/sweep path, session index/search implementation, or WebSocket behavior.
- Do not add a `SessionIndex` paging API. Call `snapshot().await` at most once per indexed request. Preserve the current capture order, but do not derive an `&[IndexedSession]` until after the final await. Borrow only inside the synchronous `derive_directory_page` call, return owned JSON, and explicitly `drop(snapshot)` before project-color lookup and response conversion.
- Final production has exactly one candidate pipeline for override survival/effective fields, exact-pair live matching, full-key synth dedupe, live synthesis, visibility, stable HTTP ordering, strict cursor relation, title precedence, deep-search traversal, and page selection. Task 6 may temporarily keep the eager path and a `#[cfg(test)]` differential wrapper only until old-vs-new evidence, handler compilation, and cutover are complete. Final source has no production `Fast`, `Materialized`, old/new, feature-flag, canary, rollback, or strategy selection.
- For the one identity vector supplied to candidate normalization, the first exact `(provider, session_id)` match and the first synthesized formatted-key occurrence win. `TerminalIdentityRegistry::list()` order and cross-request/process winners are unspecified. Do not sort identities in the route, candidate pipeline, tests, or registry, and do not promise a stable winner beyond the supplied vector.
- Preserve current Rust ordering exactly: `lastActivityAt` descending, then the complete formatted UTF-8 `provider:sessionId` key descending. `archived` stays output-only; unrelated Node archived-last behavior is outside this change.
- Preserve stable ordering for exact duplicate `(lastActivityAt, key)` tuples and the current strict-cursor gap for such duplicates.
- Preserve all current query validation, auth, accessor order, visibility flags, override/live interactions, response fields and omissions, whole-map project colors, strict cursor bytes, search budgets, I/O partial semantics, and revision max semantics.
- Preserve the exact current `DirItem::to_value` insertion order because workspace `serde_json` uses `preserve_order`; field cleanup and Task-7 ledger instrumentation must not reorder raw JSON object bytes.
- Preserve rejection of a syntactically valid cursor whose JSON `key` is empty.
- Preserve deep-search loop order after shared visibility and cursor handling: `rows.len() > limit`, then `scanned_files >= max_scan` with `budget`, then source-file presence, supported provider, increment, and I/O.
- Do not add `total`, `totalCount`, `totalSessions`, `checkoutPath`, or any response field. Exact corpus preservation is proved by all-page union tests.
- Missing, empty, and whitespace-only queries remain no-search requests for every tier. Nonblank title search remains title, summary, then first-user-message precedence with a 140-Unicode-scalar whole-field prefix. Nonblank `userMessages` and `fullText` keep `search_session_file`, `limit * 10`, provider/source eligibility, match roles, I/O handling, and `limit + 1` behavior.
- As a final Task-7/Gate-8 invariant, full `DirItem` construction, cloning of returned output fields, override/metadata/running output decoration, and `DirItem::to_value` occur only for the first `limit` returned descriptors; the lookahead is never materialized or serialized. Title and frozen deep search may create one owned `SearchAnnotation { matched_in, snippet }` for each retained match, including lookahead, so retained descriptors and owned search annotations are each bounded by `limit + 1`. The named Task-6 coexistence checkpoint and Task-7 RED checkpoint may violate these final bounds temporarily; no unbounded state survives the Task-7 commit.
- The structural work proof uses `#[cfg(test)]` thread-local counters only inside one explicitly non-overlapped `#[tokio::test(flavor = "current_thread")]` measurement interval. It directly records full-row/decorator/serializer calls, retained-descriptor peak, and owned search annotations, and is paired with a lexical static source audit. It does not identify arbitrary async requests, attribute overlapping work, observe allocator activity, or prove all allocations. Do not use timing, sleeps, an allocator, a process-global counter, source parse counts, or a release A/B benchmark.
- All new page-bound tests are colocated in `#[cfg(test)] mod page_bound_tests` in `session_directory.rs`. Use the real Axum route wherever policy composition is under test.
- Eager-policy deletion is blocked until the deterministic seeded old-vs-new differential performs exactly 516 comparisons of exact page `Value` and serialized bytes while the eager composition is independently executable. Record the latest passing representation's ancestral `TASK6_PROOF_COMMIT` and log outside the worktree. Migrated new-internal tests are cleanup coverage, not deletion authority.
- The borrowed model intentionally accepts snapshot-generation pinning for this narrow one-file structural optimization: concurrent or long requests may retain one or more obsolete generations beyond the eager baseline. No fixed generation-count, generation-byte, allocator, or RSS bound is claimed. The index/provenance compile fallback has the same retained-`Arc` lifecycle and is not an A07 remedy.
- All command logs and exit-code files go under `/home/dan/code/freshell/.worktrees/.the-usual-logs/session-directory-page-prep/implementation`; no evidence file is written into the worktree.
- Relevant focused Rust failures and functional failures in the focused Rust-backed Playwright matrix block implementation. An eligible broad failure—or a Playwright bootstrap/environment failure before functional assertions—may be classified as pre-existing only after fresh paired reruns in a newly created direct-child detached `BASE_SHA` worktree under `/home/dan/code/freshell/.worktrees/`, with all command-class actual-path manifest/lock, dependency-resolution, toolchain, backend, environment, coordinator when applicable, and positive-execution attestations. If any attestation differs or cannot be produced, the waiver is revoked.
- Final broad acceptance is GREEN or exact recorded matching unchanged-`BASE_SHA` evidence for a genuinely unrelated failure. A session-directory Rust assertion failure or any named `session-directory-matrix.spec.ts` functional test failure never qualifies.
- Run `test/e2e-browser/specs/session-directory-matrix.spec.ts` locally with Playwright project `rust-chromium` at committed-plan baseline and final acceptance. This focused command is independent of `FRESHELL_E2E_BACKEND`; set it explicitly to `local` and require exit zero with exactly one final `7 passed` marker.
- `README.md` is the only end-user Markdown documentation file. This optimization is behavior-neutral, so do not edit it or any other documentation file during implementation.
- Do not create a PR until the user explicitly approves PR creation. Local atomic task commits are required; stop after final local verification.

---

## File Structure Map

### Implementation target

- `crates/freshell-server/src/session_directory.rs:1-38` — module rustdoc; update stale provider/pipeline descriptions during atomic cutover.
- `crates/freshell-server/src/session_directory.rs:70-94` — `SessionDirectoryState` rustdoc and request inputs.
- `crates/freshell-server/src/session_directory.rs:96-207` — full selected-row `DirItem`, obsolete internal fields, obsolete `DirItem::key`, and sole wire serializer.
- `crates/freshell-server/src/session_directory.rs:210-371` — `Tier`, `DirQuery`, query validation, and limit coercion; behavior is frozen, rustdoc is updated.
- `crates/freshell-server/src/session_directory.rs:374-455` — authenticated route and eager capture/decorate/derive sequence; Task 6 stages candidate+differential, actual-handler cutover, and eager cleanup as three source-only commits.
- `crates/freshell-server/src/session_directory.rs:555-583` — eager indexed-row full constructor; remove after selected-only materialization exists.
- `crates/freshell-server/src/session_directory.rs:736-938` — full-item override, metadata, display, running, and live synthesis chain; replace with borrowed candidate normalization. Change the existing `provider_display_name` in place rather than adding a second helper.
- `crates/freshell-server/src/session_directory.rs:940-1147` — display/join tests and their `DirItem` fixture; migrate to `IndexedSession` and candidates.
- `crates/freshell-server/src/session_directory.rs:1149-1391` — cursor codec, revision/order/visibility/search/page policy, `FileSearchOutcome` struct, deep search, and title search; consolidate into the shared candidate pipeline.
- `crates/freshell-server/src/session_directory.rs:1392-3353` — existing fixtures and tests. Migrate every named direct-helper test, retain the parser/index oracle, and leave the nine named route tests unchanged.
- New colocated section in the same file: `#[cfg(test)] mod page_bound_tests`, containing exactly 27 final tests by Task 7. Count progression is `15 -> 20 -> 21 -> 20 -> 27`: Task 6 adds four shared tests and one supplied-vector winner, adds one temporary differential, removes that temporary test with the eager oracle, and Task 7 adds seven retained tests.

### Read-only contracts

- `crates/freshell-server/Cargo.toml` — proves existing `tower` util and `tempfile` support; never edit.
- `crates/freshell-sessions/src/directory_index.rs` — `IndexedSession`, `SessionSource`, and `SessionIndex::snapshot() -> Arc<Vec<IndexedSession>>`; never edit.
- `crates/freshell-sessions/src/search.rs` — `search_session_file`, `FileSearchTier`, and `FileSearchMatch { matched_in: &'static str, snippet: String }`; never edit.
- `crates/freshell-ws/src/identity.rs` — `TerminalIdentity` and unordered `TerminalIdentityRegistry::list()`; never edit.
- `crates/freshell-server/src/settings_store.rs` — overrides and project colors; never edit.
- `crates/freshell-server/src/session_metadata.rs` — captured metadata map; never edit.
- `shared/read-models.ts` — wire contract confirming there is no total field; never edit.
- `server/session-directory/service.ts` — read-only reference for existing deep-search check order; never edit.
- `test/e2e-browser/specs/session-directory-matrix.spec.ts` — existing seven-test real Rust server/browser/provider/sidebar composition gate; never edit.
- `test/e2e-browser/playwright.config.ts` — selects the local `rust-chromium` project and includes the matrix spec; never edit.
- `package.json` and `package-lock.json` — local Playwright/npm command and dependency identity; never edit.
- Root `Cargo.toml`, `Cargo.lock`, and relevant crate manifests — Rust command/dependency identity for unchanged-base comparison; never edit.

### Final internal flow

```text
validate request
-> capture one optional Arc<Vec<IndexedSession>>
-> capture overrides
-> await metadata (the final await)
-> capture identities without sorting
-> enter one narrow synchronous block and derive the indexed slice
-> decode a nonempty-key cursor
-> build all shallow effective candidates with supplied-vector first-winner semantics
-> compute corpus revision over every candidate and every identity update
-> stable-sort shallow candidates by current Rust response order
-> shared visibility
-> shared strict cursor relation
-> shared title or frozen deep-search traversal
-> retain at most limit + 1 descriptors and owned annotations in the final selector
-> materialize, decorate, and serialize only first limit descriptors
-> leave the borrow scope with owned page JSON
-> explicitly drop the snapshot owner
-> append project colors after successful derivation
```

The sufficient page state is corpus-wide `revision`, the first `limit + 1` operational match descriptors (each optionally carrying one owned search annotation), the deep-search `(partial, partialReason)` aggregate, and project colors. `limit + 1` is a retained-match cap, not a candidate-traversal cap; sparse title/deep queries may inspect more candidates, and deep search may continue until exhaustion, budget, or lookahead under the preserved check order. Revision is computed before sort, visibility, cursor, search, retention, and materialization.

## Command and Evidence Harness

Evaluate this complete block once at the start of every execution unit's persistent Bash session (Gate 0, Tasks 1-7, and Gate 8), not once for the whole implementation. Re-evaluating it in each fresh session is required and safe: it applies shell options, sets task-local variables, creates only the external evidence directory with idempotent `mkdir -p`, and defines ten task-local helper functions. Do not execute an execution unit's later Bash fences in isolated replacement shells.

```bash
set -euo pipefail
WT=/home/dan/code/freshell/.worktrees/session-directory-page-prep
REFERENCE_ONLY=/home/dan/code/freshell/.worktrees/session-directory-page-bound
BASE_SHA=225a91db3e4d48d4b6a7e8bc0987afad8ff31917
MANIFEST="$WT/Cargo.toml"
STAGE_LOG_ROOT=/home/dan/code/freshell/.worktrees/.the-usual-logs/session-directory-page-prep
LOG_ROOT="$STAGE_LOG_ROOT/implementation"
PLAN_REL=docs/plans/2026-08-13-session-directory-page-prep.md
SOURCE_REL=crates/freshell-server/src/session_directory.rs
PLAYWRIGHT_CLI=/home/dan/code/freshell/node_modules/@playwright/test/cli.js
BASE_WORKTREE_PARENT=/home/dan/code/freshell/.worktrees
mkdir -p "$LOG_ROOT"

run_logged() {
  local name=$1
  shift
  {
    printf 'cwd=%s\n' "$PWD"
    printf 'command='
    printf '%q ' "$@"
    printf '\n'
  } >"$LOG_ROOT/$name.command"
  printf '%s\0' "$@" >"$LOG_ROOT/$name.argv0"

  set +e
  "$@" 2>&1 | tee "$LOG_ROOT/$name.log"
  local status=${PIPESTATUS[0]}
  set -e
  printf 'exit_code=%s\n' "$status" | tee "$LOG_ROOT/$name.exit"
  return "$status"
}

run_rust_session_directory_matrix() {
  local name=$1
  local checkout=$2
  local output_dir=$3
  run_logged "$name" \
    env --chdir="$checkout" \
      FRESHELL_E2E_BACKEND=local \
      node "$PLAYWRIGHT_CLI" test \
        --config "$checkout/test/e2e-browser/playwright.config.ts" \
        --project=rust-chromium \
        --workers=1 \
        --reporter=line \
        --output="$output_dir" \
        "$checkout/test/e2e-browser/specs/session-directory-matrix.spec.ts"
}

record_comparison_context() {
  local name=$1
  local checkout=$2
  local command_class=$3
  local command_name=$4
  local command_phase=$5
  local variable
  local digest
  local digest_line
  local env_names
  local checkout_real
  local head
  local uname_value
  local cargo_bin cargo_version rustc_bin rustc_verbose
  local node_bin node_version npm_bin npm_version
  local gcloud_bin gcloud_account gcloud_project
  local playwright_cli playwright_version chromium_line
  local -a dynamic_lines=()
  local out="$LOG_ROOT/$name-context.txt"

  if ! checkout_real=$(realpath "$checkout"); then return 1; fi
  if ! head=$(git -C "$checkout" rev-parse HEAD); then return 1; fi
  if ! uname_value=$(uname -srm); then return 1; fi

  case "$command_class" in
    cargo)
      if ! cargo_bin=$(command -v cargo); then return 1; fi
      if ! cargo_version=$(cargo --version); then return 1; fi
      if ! rustc_bin=$(command -v rustc); then return 1; fi
      if ! rustc_verbose=$(rustc -Vv); then return 1; fi
      if ! env_names=$(compgen -e); then return 1; fi
      if ! env_names=$(printf '%s\n' "$env_names" | sort); then return 1; fi
      while IFS= read -r variable; do
        case "$variable" in
          CARGO_TARGET_*|CC_*|CXX_*|AR_*|CFLAGS_*|CXXFLAGS_*|PKG_CONFIG_*)
            case "$variable" in
              *TOKEN*|*SECRET*|*PASSWORD*|*CREDENTIAL*|*AUTH*|*PRIVATE*|*KEY*)
                continue
                ;;
            esac
            if ! digest_line=$(printf '%s' "${!variable-}" | sha256sum); then
              return 1
            fi
            digest=${digest_line%% *}
            [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || return 1
            dynamic_lines+=("env_digest.$variable=$digest")
            ;;
        esac
      done <<<"$env_names"
      ;;
    coordinated-npm)
      if ! node_bin=$(command -v node); then return 1; fi
      if ! node_version=$(node --version); then return 1; fi
      if ! npm_bin=$(command -v npm); then return 1; fi
      if ! npm_version=$(npm --version); then return 1; fi
      if [[ "${FRESHELL_VITEST_BACKEND:-}" == cloud ]]; then
        if ! gcloud_bin=$(command -v gcloud); then return 1; fi
        if ! gcloud_account=$(gcloud config get-value account 2>/dev/null); then
          return 1
        fi
        if ! gcloud_project=$(gcloud config get-value project 2>/dev/null); then
          return 1
        fi
        if ! gcloud auth application-default print-access-token >/dev/null; then
          return 1
        fi
      fi
      ;;
    playwright-environment)
      if ! node_bin=$(command -v node); then return 1; fi
      if ! node_version=$(node --version); then return 1; fi
      if ! playwright_cli=$(realpath "$PLAYWRIGHT_CLI"); then return 1; fi
      if ! playwright_version=$(node "$PLAYWRIGHT_CLI" --version); then
        return 1
      fi
      if ! chromium_line=$(node - "$checkout/package.json" <<'NODE'
const fs = require('node:fs')
const { createRequire } = require('node:module')
const manifest = process.argv[2]
const playwright = createRequire(manifest)('playwright')
console.log(`chromium_executable=${fs.realpathSync(playwright.chromium.executablePath())}`)
NODE
      ); then
        return 1
      fi
      [[ "$chromium_line" == chromium_executable=* ]] || return 1
      ;;
    *)
      printf 'unsupported comparison class: %s\n' "$command_class" >&2
      return 1
      ;;
  esac

  {
    printf 'checkout=%s\n' "$checkout_real"
    printf 'head=%s\n' "$head"
    printf 'command_class=%s\n' "$command_class"
    printf 'command_name=%s\n' "$command_name"
    printf 'command_phase=%s\n' "$command_phase"
    printf '%s\n' "$uname_value"
    case "$command_class" in
      cargo)
        printf 'cargo_bin=%s\ncargo_version=%s\n' \
          "$cargo_bin" "$cargo_version"
        printf 'rustc_bin=%s\n%s\n' "$rustc_bin" "$rustc_verbose"
        for variable in \
          PATH HOME TMPDIR LANG LC_ALL TZ \
          CARGO_TERM_COLOR CARGO_HOME CARGO_TARGET_DIR CARGO_BUILD_TARGET \
          RUSTFLAGS RUSTDOCFLAGS RUSTC RUSTC_WRAPPER \
          RUSTUP_HOME RUSTUP_TOOLCHAIN \
          CC CXX AR CFLAGS CXXFLAGS PKG_CONFIG_PATH
        do
          printf '%s=%q\n' "$variable" "${!variable-}"
        done
        printf '%s\n' "${dynamic_lines[@]}"
        ;;
      coordinated-npm)
        printf 'node_bin=%s\nnode_version=%s\n' "$node_bin" "$node_version"
        printf 'npm_bin=%s\nnpm_version=%s\n' "$npm_bin" "$npm_version"
        for variable in \
          PATH HOME TMPDIR LANG LC_ALL TZ CI NODE_OPTIONS NODE_PATH \
          FRESHELL_VITEST_BACKEND
        do
          printf '%s=%q\n' "$variable" "${!variable-}"
        done
        if [[ "${FRESHELL_VITEST_BACKEND:-}" == cloud ]]; then
          printf 'gcloud_bin=%s\n' "$gcloud_bin"
          printf 'gcloud_account=%s\n' "$gcloud_account"
          printf 'gcloud_project=%s\n' "$gcloud_project"
          printf 'gcloud_region=%s\n' "${FRESHELL_CLOUD_RUN_REGION-}"
          printf 'gcloud_image=%s\n' "${FRESHELL_VITEST_CLOUD_IMAGE-}"
          printf 'gcloud_adc_available=true\n'
        fi
        ;;
      playwright-environment)
        printf 'node_bin=%s\nnode_version=%s\n' "$node_bin" "$node_version"
        printf 'playwright_cli=%s\n' "$playwright_cli"
        printf '%s\n%s\n' "$playwright_version" "$chromium_line"
        for variable in \
          PATH HOME TMPDIR LANG LC_ALL TZ CI NODE_OPTIONS NODE_PATH \
          PLAYWRIGHT_BROWSERS_PATH DISPLAY WAYLAND_DISPLAY
        do
          printf '%s=%q\n' "$variable" "${!variable-}"
        done
        printf 'effective_FRESHELL_E2E_BACKEND=local\n'
        ;;
    esac
  } >"$out" || return 1
}

# This is the complete permitted context. Do not replace it with env/printenv,
# a cross-class tool probe, or a raw dynamically discovered namespace value.
record_node_resolution() {
  local name=$1
  local target_checkout=$2
  local base_checkout=$3
  node - "$target_checkout/package.json" "$base_checkout/package.json" <<'NODE' \
    | tee "$LOG_ROOT/$name-node-resolution.txt"
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')

const [targetManifestPath, baseManifestPath] = process.argv.slice(2)
const manifests = [targetManifestPath, baseManifestPath].map((manifestPath) => ({
  manifestPath,
  manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
  lock: JSON.parse(fs.readFileSync(path.join(path.dirname(manifestPath), 'package-lock.json'), 'utf8')),
  requireFrom: createRequire(manifestPath),
}))
const direct = manifests.map(({ manifest }) => ({
  ...(manifest.dependencies ?? {}),
  ...(manifest.devDependencies ?? {}),
}))
assert.deepEqual(direct[1], direct[0])
for (const entry of manifests) {
  assert.deepEqual(entry.lock.packages[''].dependencies ?? {}, manifests[0].lock.packages[''].dependencies ?? {})
  assert.deepEqual(entry.lock.packages[''].devDependencies ?? {}, manifests[0].lock.packages[''].devDependencies ?? {})
}

function nearestNamedPackageJson(start, packageName) {
  let directory = path.dirname(start)
  while (directory !== path.dirname(directory)) {
    const candidate = path.join(directory, 'package.json')
    if (fs.existsSync(candidate)) {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'))
      if (parsed.name === packageName) return candidate
    }
    directory = path.dirname(directory)
  }
  return undefined
}

function packageJsonFor(requireFrom, packageName) {
  try {
    const exported = requireFrom.resolve(`${packageName}/package.json`)
    const parsed = JSON.parse(fs.readFileSync(exported, 'utf8'))
    if (parsed.name === packageName) return exported
    const root = nearestNamedPackageJson(exported, packageName)
    if (root) return root
  } catch (packageJsonError) {
    const root = nearestNamedPackageJson(requireFrom.resolve(packageName), packageName)
    if (root) return root
    throw packageJsonError
  }
  throw new Error(`package root not found for ${packageName}`)
}

const names = Object.keys(direct[0]).sort()
assert.equal(names.length, 85)
let missing = 0
let resolutionMismatch = 0
let lockEntryMissing = 0
let installedVersionMismatch = 0
for (const name of names) {
  try {
    const packageJsons = manifests.map(({ requireFrom }) => fs.realpathSync(packageJsonFor(requireFrom, name)))
    if (packageJsons[0] !== packageJsons[1]) resolutionMismatch += 1
    const installed = packageJsons.map((file) => JSON.parse(fs.readFileSync(file, 'utf8')).version)
    const lockEntries = manifests.map(({ lock }) => lock.packages[`node_modules/${name}`])
    if (lockEntries.some((entry) => !entry)) {
      lockEntryMissing += 1
      continue
    }
    if (installed[0] !== installed[1] || installed.some((version, index) => version !== lockEntries[index].version)) {
      installedVersionMismatch += 1
    }
    console.log(`${name}\ttarget_installed=${installed[0]}\ttarget_locked=${lockEntries[0].version}\ttarget_realpath=${packageJsons[0]}\tbase_installed=${installed[1]}\tbase_locked=${lockEntries[1].version}\tbase_realpath=${packageJsons[1]}`)
  } catch (error) {
    missing += 1
    console.error(`${name}: ${error.code ?? error.message}`)
  }
}
let exactEntrypointMismatch = 0
for (const request of ['tsx/package.json', 'vitest/vitest.mjs', 'electron/package.json', '@playwright/test/cli']) {
  const resolved = manifests.map(({ requireFrom }) => fs.realpathSync(requireFrom.resolve(request)))
  if (resolved[0] !== resolved[1]) exactEntrypointMismatch += 1
}
console.log(`direct_count=${names.length}`)
console.log(`missing=${missing}`)
console.log(`resolution_mismatch=${resolutionMismatch}`)
console.log(`lock_entry_missing=${lockEntryMissing}`)
console.log(`installed_version_mismatch=${installedVersionMismatch}`)
console.log(`exact_entrypoint_mismatch=${exactEntrypointMismatch}`)
assert.deepEqual(
  [missing, resolutionMismatch, lockEntryMissing, installedVersionMismatch, exactEntrypointMismatch],
  [0, 0, 0, 0, 0],
)
NODE
}

assert_exact_cargo_summary() {
  local expected=$1
  local log=$2
  test "$(grep -Fc "$expected" "$log")" -eq 1
}

run_task6_representation_checkpoint() {
  local prefix=$1
  local differential_filter
  differential_filter='session_directory::page_bound_tests::candidate_path_matches_'
  differential_filter+='eager_oracle_across_seeded_cross_product'
  run_logged "$prefix-differential" \
    env CARGO_TERM_COLOR=never \
    cargo test --manifest-path "$MANIFEST" \
      -p freshell-server --bin freshell-server \
      "$differential_filter" -- \
      --exact --color=never --test-threads=1 --nocapture
  test "$(grep -Fc 'differential comparisons: 516' \
    "$LOG_ROOT/$prefix-differential.log")" -eq 1

  run_logged "$prefix-page-bound-21" \
    env CARGO_TERM_COLOR=never \
    cargo test --manifest-path "$MANIFEST" \
      -p freshell-server --bin freshell-server \
      'session_directory::page_bound_tests' -- --color=never --test-threads=1
  assert_exact_cargo_summary \
    'test result: ok. 21 passed; 0 failed; 0 ignored; 0 measured' \
    "$LOG_ROOT/$prefix-page-bound-21.log"

  for test_name in \
    no_search_deleted_head_backfills_page_before_cut \
    no_search_title_override_promotes_row_outside_raw_page \
    no_search_running_join_promotes_row_outside_raw_page \
    no_search_newer_live_only_row_interleaves_and_drives_cursor \
    no_search_deleted_indexed_live_row_reappears_as_synthesized \
    no_search_visibility_flags_restore_only_their_exclusion_class \
    no_search_cursor_chain_covers_effective_rows_exactly_once \
    no_search_limit_boundary_emits_cursor_only_for_limit_plus_one \
    no_search_equal_activity_uses_descending_full_key_for_order_and_cursor \
    revision_is_equal_across_pages_flags_and_title_search \
    providerless_live_identity_changes_revision_without_creating_item \
    duplicate_equal_order_tuples_preserve_stable_order_and_strict_cursor_gap \
    title_search_matches_effective_title_summary_and_first_message_beyond_raw_page \
    no_search_exact_response_shape_preserves_all_fields_and_no_totals \
    rust_http_order_remains_recency_first_when_newer_row_is_archived
  do
    run_logged "$prefix-characterization-$test_name" \
      env CARGO_TERM_COLOR=never \
      cargo test --manifest-path "$MANIFEST" \
        -p freshell-server --bin freshell-server \
        "session_directory::page_bound_tests::$test_name" -- \
        --exact --color=never --test-threads=1
    assert_exact_cargo_summary \
      'test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured' \
      "$LOG_ROOT/$prefix-characterization-$test_name.log"
  done

  for test_name in \
    b_t7_router_get_session_directory_is_backed_by_the_session_index \
    session_metadata_session_type_is_joined_onto_directory_items \
    session_directory_page_embeds_config_project_colors \
    session_directory_page_omits_project_colors_key_when_empty \
    b_t8_no_session_index_yields_empty_page \
    override_no_rebuild \
    codex_exec_session_hidden_by_default_surfaced_with_flag \
    session_override_applies_to_codex_and_opencode_keys \
    global_project_session_reports_real_directory_as_project_path
  do
    run_logged "$prefix-route-$test_name" \
      env CARGO_TERM_COLOR=never \
      cargo test --manifest-path "$MANIFEST" \
        -p freshell-server --bin freshell-server \
        "session_directory::tests::$test_name" -- \
        --exact --color=never --test-threads=1
    assert_exact_cargo_summary \
      'test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured' \
      "$LOG_ROOT/$prefix-route-$test_name.log"
  done

  run_logged "$prefix-focused-session-directory" \
    env CARGO_TERM_COLOR=never \
    cargo test --manifest-path "$MANIFEST" \
      -p freshell-server --bin freshell-server \
      session_directory -- --color=never --test-threads=1
  grep -Eq 'test result: ok\. [1-9][0-9]* passed; 0 failed;' \
    "$LOG_ROOT/$prefix-focused-session-directory.log"
}

run_task6_fallback_compiler_checkpoint() {
  local prefix=$1
  run_logged "$prefix-shared-four" \
    env CARGO_TERM_COLOR=never \
    cargo test --manifest-path "$MANIFEST" \
      -p freshell-server --bin freshell-server \
      'session_directory::page_bound_tests::shared_' -- \
      --color=never --test-threads=1
  assert_exact_cargo_summary \
    'test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured' \
    "$LOG_ROOT/$prefix-shared-four.log"
  run_logged "$prefix-winner" \
    env CARGO_TERM_COLOR=never \
    cargo test --manifest-path "$MANIFEST" \
      -p freshell-server --bin freshell-server \
      'session_directory::page_bound_tests::candidate_normalization_preserves_first_winner_from_supplied_identity_vector' -- \
      --exact --color=never --test-threads=1
  assert_exact_cargo_summary \
    'test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured' \
    "$LOG_ROOT/$prefix-winner.log"
  run_logged "$prefix-handler-check" \
    env CARGO_TERM_COLOR=never \
    cargo check --manifest-path "$MANIFEST" \
      -p freshell-server --bin freshell-server
  run_logged "$prefix-handler-test-no-run" \
    env CARGO_TERM_COLOR=never \
    cargo test --manifest-path "$MANIFEST" \
      -p freshell-server --bin freshell-server --no-run
}

classify_task6_handler_failure() {
  local name=$1
  local status=$2
  local report="$LOG_ROOT/$name.fallback-classification.txt"
  if [[ "$status" -eq 0 ]]; then
    printf 'classifier called for successful command: %s\n' "$name" >&2
    return 1
  fi
  python3 -I - \
    "$WT/$SOURCE_REL" \
    "$LOG_ROOT/$name.log" \
    "$report" <<'PY'
from pathlib import Path
import json
import re
import sys

source_path = Path(sys.argv[1]).resolve()
log_path = Path(sys.argv[2])
report_path = Path(sys.argv[3])
source_text = source_path.read_text(encoding="utf-8")
source_bytes = source_text.encode("utf-8")

allowed_borrow_codes = {
    "E0106", "E0373", "E0382", "E0491", "E0499", "E0500", "E0501",
    "E0502", "E0503", "E0504", "E0505", "E0506", "E0507", "E0509",
    "E0515", "E0521", "E0581", "E0597", "E0621", "E0700", "E0716",
    "E0726",
}
allowed_borrow_text = re.compile(
    r"(lifetime may not live long enough|does not live long enough|"
    r"missing lifetime specifier|explicit lifetime required|"
    r"hidden type .* captures .* lifetime|unconstrained lifetime|"
    r"borrowed data escapes|cannot return value referencing|"
    r"returns a value referencing|closure may outlive|cannot move .*borrowed|"
    r"borrow of moved value|use of moved value|"
    r"cannot borrow .* more than once|cannot borrow .* also borrowed|"
    r"self[- ]referential)",
    re.IGNORECASE,
)
explicit_send_text = re.compile(
    r"(future cannot be sent between threads safely|"
    r"future (?:created|returned).* is not .*Send|"
    r"future .* is not .*Send|"
    r"implementation of .*Send.* is not general enough)",
    re.IGNORECASE,
)
candidate_type_symbols = {
    "DirectoryInputs",
    "DirectoryCandidate",
    "DirectoryCandidateSource",
    "DirectoryOrderKey",
    "IndexedOverlay",
    "SynthesizedSessionId",
    "SelectedCandidate",
    "CandidatePage",
}
candidate_function_symbols = {
    "resolve_indexed_overlay",
    "first_identity_by_exact_session",
    "build_directory_candidates",
    "compare_directory_order",
    "candidate_is_strictly_after_cursor",
    "candidate_is_visible",
    "title_search_annotation",
    "select_page_candidates",
    "materialize_selected_candidate",
    "derive_directory_page",
}
representation_lexeme = re.compile(
    r"\b(?:IndexedSession|snapshot|indexed|overrides|metadata|identities|"
    r"DirectoryInputs|DirectoryCandidate|DirectoryCandidateSource|"
    r"DirectoryOrderKey|IndexedOverlay|SynthesizedSessionId|"
    r"SelectedCandidate|CandidatePage|build_directory_candidates|"
    r"select_page_candidates|title_search_annotation|"
    r"materialize_selected_candidate|derive_directory_page|"
    r"row|overlay|running_identity|identity|candidate|selected|annotation)\b"
)


def mask_for_braces(source: str) -> str:
    result = list(source)
    index = 0
    length = len(source)

    def blank(start: int, end: int) -> None:
        for position in range(start, end):
            if result[position] != "\n":
                result[position] = " "

    while index < length:
        if source.startswith("//", index):
            end = source.find("\n", index)
            end = length if end < 0 else end
            blank(index, end)
            index = end
            continue
        if source.startswith("/*", index):
            start = index
            depth = 1
            index += 2
            while index < length and depth:
                if source.startswith("/*", index):
                    depth += 1
                    index += 2
                elif source.startswith("*/", index):
                    depth -= 1
                    index += 2
                else:
                    index += 1
            if depth:
                raise RuntimeError(f"unterminated block comment at {start}")
            blank(start, index)
            continue
        raw = re.match(r'(?:br|rb|r)(?P<hashes>#+)?"', source[index:])
        if raw:
            start = index
            hashes = raw.group("hashes") or ""
            index += raw.end()
            terminator = '"' + hashes
            end = source.find(terminator, index)
            if end < 0:
                raise RuntimeError(f"unterminated raw string at {start}")
            index = end + len(terminator)
            blank(start, index)
            continue
        quote_start = index + 1 if source[index:index + 2] in {'b"', "b'"} else index
        quote = source[quote_start] if quote_start < length else ""
        if quote == '"':
            start = index
            index = quote_start + 1
            while index < length:
                if source[index] == "\\":
                    index += 2
                elif source[index] == '"':
                    index += 1
                    break
                else:
                    index += 1
            else:
                raise RuntimeError(f"unterminated string at {start}")
            blank(start, index)
            continue
        if quote == "'":
            cursor = quote_start + 1
            if cursor < length and source[cursor] == "\\":
                if source.startswith("\\u{", cursor):
                    close = source.find("}", cursor + 3)
                    if close < 0:
                        raise RuntimeError(
                            f"unterminated unicode character escape at {index}"
                        )
                    cursor = close + 1
                elif source.startswith("\\x", cursor):
                    cursor += 4
                else:
                    cursor += 2
            else:
                cursor += 1
            if cursor < length and source[cursor] == "'":
                start = index
                index = cursor + 1
                blank(start, index)
                continue
        index += 1
    return "".join(result)


masked_source = mask_for_braces(source_text)


def balanced_definition(match: re.Match[str], label: str) -> tuple[int, int, str]:
    brace = masked_source.find("{", match.end())
    if brace < 0:
        raise RuntimeError(f"missing body for {label}")
    depth = 0
    end = None
    for offset in range(brace, len(masked_source)):
        if masked_source[offset] == "{":
            depth += 1
        elif masked_source[offset] == "}":
            depth -= 1
            if depth == 0:
                end = offset + 1
                break
    if end is None:
        raise RuntimeError(f"unterminated body for {label}")
    return match.start(), end, label


def unique_definition(pattern: str, label: str) -> tuple[int, int, str]:
    matches = list(re.finditer(pattern, masked_source))
    if len(matches) != 1:
        raise RuntimeError(f"expected one {label} definition, got {len(matches)}")
    return balanced_definition(matches[0], label)


candidate_owner_ranges: list[tuple[int, int, str]] = []
for symbol in sorted(candidate_type_symbols):
    candidate_owner_ranges.append(
        unique_definition(
            rf"(?m)^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?"
            rf"(?:struct|enum)[ \t]+{re.escape(symbol)}\b",
            symbol,
        )
    )
for symbol in sorted(candidate_function_symbols):
    candidate_owner_ranges.append(
        unique_definition(
            rf"(?m)^fn[ \t]+{re.escape(symbol)}\b",
            symbol,
        )
    )
candidate_owner_ranges.append(
    unique_definition(
        r"(?m)^impl[ \t]+DirectoryCandidate(?:\s*<[^>{}]*>)?[ \t]*\{",
        "impl DirectoryCandidate",
    )
)
handler_start, handler_end, _ = unique_definition(
    r"(?m)^async[ \t]+fn[ \t]+session_directory\b",
    "async fn session_directory",
)
handler_masked = masked_source[handler_start:handler_end]
handler_anchors = [
    "let snapshot: Option<Arc<Vec<IndexedSession>>>",
    "let result = {",
    "let indexed = snapshot",
    "derive_directory_page(",
    "DirectoryInputs {",
    "drop(snapshot);",
]
handler_positions: list[int] = []
for anchor in handler_anchors:
    if handler_masked.count(anchor) != 1:
        raise RuntimeError(f"hardened handler anchor count: {anchor}")
    handler_positions.append(handler_start + handler_masked.index(anchor))
if handler_positions != sorted(handler_positions):
    raise RuntimeError(f"hardened handler anchor order: {handler_positions}")
handler_region_start = handler_positions[0]
handler_region_end = handler_positions[-1] + len(handler_anchors[-1])


def byte_offset(character_offset: int) -> int:
    return len(source_text[:character_offset].encode("utf-8"))


def source_line_range(offset: int) -> tuple[int, int]:
    start = masked_source.rfind("\n", 0, offset) + 1
    end = masked_source.find("\n", offset)
    return start, len(masked_source) if end < 0 else end + 1


authorization_ranges: set[tuple[int, int, str]] = set()


def authorize_lexeme_lines(start: int, end: int, label: str) -> None:
    for match in representation_lexeme.finditer(masked_source, start, end):
        line_start, line_end = source_line_range(match.start())
        clipped_start = max(start, line_start)
        clipped_end = min(end, line_end)
        if clipped_start < clipped_end:
            authorization_ranges.add(
                (byte_offset(clipped_start), byte_offset(clipped_end), label)
            )


authorize_lexeme_lines(
    handler_region_start,
    handler_region_end,
    "hardened-handler-region",
)
for owner_start, owner_end, owner_label in candidate_owner_ranges:
    authorize_lexeme_lines(owner_start, owner_end, f"candidate:{owner_label}")
if not authorization_ranges:
    raise RuntimeError("no hardened handler/candidate authorization ranges")


def fail(message: str, records: list[str]) -> None:
    report_path.write_text(
        "FAIL\n" + "\n".join(records + [message]) + "\n",
        encoding="utf-8",
    )
    raise RuntimeError(message)


def file_matches(file_name: str) -> bool:
    candidate = Path(file_name)
    if candidate.is_absolute():
        return candidate.resolve() == source_path
    normalized = file_name.replace("\\", "/")
    return normalized.endswith(
        "/crates/freshell-server/src/session_directory.rs"
    ) or normalized == "crates/freshell-server/src/session_directory.rs"


def authorization_label(span: dict) -> str | None:
    if span.get("is_primary") is not True:
        return None
    if not file_matches(str(span.get("file_name", ""))):
        return None
    span_start = span.get("byte_start")
    span_end = span.get("byte_end")
    if (
        not isinstance(span_start, int)
        or not isinstance(span_end, int)
        or span_start < 0
        or span_end <= span_start
        or span_end > len(source_bytes)
    ):
        return None
    matches = {
        label
        for start, end, label in authorization_ranges
        if start < span_end and span_start < end
    }
    if len(matches) != 1:
        return None
    return next(iter(matches))


def diagnostic_nodes(root: dict):
    yield root
    children = root.get("children")
    if not isinstance(children, list):
        return
    for child in children:
        if isinstance(child, dict):
            yield from diagnostic_nodes(child)


generic_trailer = re.compile(
    r"^(?:aborting due to \d+ previous errors?|could not compile\b)",
    re.IGNORECASE,
)
records: list[str] = []
errors: list[dict] = []
for raw_line in log_path.read_text(
    encoding="utf-8", errors="replace"
).splitlines():
    try:
        event = json.loads(raw_line)
    except json.JSONDecodeError:
        continue
    if event.get("reason") != "compiler-message":
        continue
    message = event.get("message")
    if not isinstance(message, dict) or message.get("level") != "error":
        continue
    spans = message.get("spans")
    if generic_trailer.search(str(message.get("message", ""))) and not spans:
        records.append(f"ignored_trailer={message.get('message', '')}")
        continue
    errors.append(message)

if not errors:
    fail(
        "no substantive rustc JSON error diagnostic; "
        "Cargo trailers cannot authorize fallback",
        records,
    )

for index, message in enumerate(errors, 1):
    evidence: list[tuple[str, str, str]] = []
    for node in diagnostic_nodes(message):
        node_code_object = node.get("code")
        node_code = (
            node_code_object.get("code")
            if isinstance(node_code_object, dict)
            else None
        )
        node_text = "\n".join(
            [
                str(node.get("message", "")),
                str(node.get("rendered", "")),
            ]
        )
        send_class = bool(explicit_send_text.search(node_text))
        borrow_class = node_code in allowed_borrow_codes or bool(
            allowed_borrow_text.search(node_text)
        )
        if not (send_class or borrow_class):
            continue
        for span in node.get("spans", []):
            if not isinstance(span, dict):
                continue
            label = authorization_label(span)
            if label is not None:
                evidence.append(
                    (
                        "send" if send_class else "borrow",
                        node_code or "-",
                        label,
                    )
                )
    records.append(
        f"diagnostic={index} "
        f"authorized_evidence={evidence!r} "
        f"message={message.get('message', '')}"
    )
    if not evidence:
        fail(
            f"diagnostic {index} has no explicit lifetime/move/future-Send "
            "evidence with a primary byte span inside an exact hardened "
            "handler/candidate authorization line",
            records,
        )

report_path.write_text(
    "PASS\n" + "\n".join(records) + "\n",
    encoding="utf-8",
)
PY
}

capture_coordinator_state() {
  local name=$1
  local checkout=$2
  local common_dir
  local source
  if ! common_dir=$(git -C "$checkout" \
    rev-parse --path-format=absolute --git-common-dir)
  then
    return 1
  fi
  source="$common_dir/freshell-test-coordinator/command-runs.json"
  if [[ -f "$source" ]]; then
    cp "$source" "$LOG_ROOT/$name-command-runs.json"
  else
    printf '%s\n' '{"schemaVersion":1,"byKey":{}}' \
      >"$LOG_ROOT/$name-command-runs.json"
  fi
}

build_paired_argv() {
  local checkout=$1
  local cargo_target=$2
  local playwright_output=$3
  local result_name=$4
  local arg
  local rewritten
  local last_byte
  local -a original=()
  local -n result=$result_name
  if ! last_byte=$(tail -c 1 "$FAILED_ARGV_FILE" | od -An -t u1); then
    return 1
  fi
  last_byte=${last_byte//[[:space:]]/}
  [[ "$last_byte" == 0 ]] || return 1
  if ! mapfile -d '' -t original <"$FAILED_ARGV_FILE"; then
    return 1
  fi
  [[ "${#original[@]}" -gt 0 ]] || return 1
  result=()
  for arg in "${original[@]}"; do
    rewritten=${arg//"$WT"/"$checkout"}
    if [[ "$FAILED_COMMAND_CLASS" == playwright-environment \
       && "$rewritten" == --output=* ]]; then
      rewritten="--output=$playwright_output"
    fi
    result+=("$rewritten")
  done
  if [[ "$FAILED_COMMAND_CLASS" == cargo ]]; then
    for arg in "${original[@]}"; do
      if [[ "$arg" == CARGO_TARGET_DIR=* ]]; then
        return 1
      fi
    done
    result=(env "CARGO_TARGET_DIR=$cargo_target" "${result[@]}")
  fi
}
```

`classify_task6_handler_failure` consumes the complete structured rustc diagnostic tree. The generic Axum `Handler` bound is never a class predicate. Each top-level error needs an explicit lifetime/borrow/move/self-reference or future-non-`Send` message in itself or a child, and that same evidence node needs a primary `byte_start`/`byte_end` span in this exact source file. The span must overlap a representation-bearing source line inside either (a) the unique hardened handler sequence from the exact snapshot declaration through `drop(snapshot)`, or (b) one of the uniquely local candidate type/function/impl definitions. The route registration, `use` imports, other lines in an otherwise relevant owner, response/color code, secondary spans, spans in another file, and generic `Handler` text are not authorization ranges. Non-JSON progress and Cargo trailers are ignored and can never authorize fallback. Missing byte locations, ambiguous/overlapping owner labels, an unrelated same-class diagnostic, or a trailer-only log stops execution.

Every expected-GREEN command must return 0. Every intentional RED command must return nonzero and contain the stated failure marker. An exit-zero filtered run with zero executed tests is a failure.

### Gate 0: Prove Committed-Plan Identity and the Unchanged Application Baseline

**Fresh-shell precondition:** Start this execution unit in a new persistent Bash session and evaluate the complete `Command and Evidence Harness` block before Step 1. Run every Bash fence in this unit in that session; do not reuse shell state from a prior unit.

**Files:**
- Modify: none
- Read only: repository metadata and test outputs
- Generated evidence: `$LOG_ROOT/**`

**Interfaces:**

```text
Worktree identity = canonical prep path + expected branch
Planning state = clean worktree with the plan already committed
Base relation = BASE_SHA is an ancestor of HEAD
Initial BASE_SHA..HEAD path set = committed plan only
Application baseline = session_directory.rs and all non-plan paths identical to BASE_SHA
```

- [ ] **Step 1: Prove the target and reference worktrees are distinct.**

Run:

```bash
test "$(realpath "$WT")" = /home/dan/code/freshell/.worktrees/session-directory-page-prep
test "$(realpath "$WT")" != "$(realpath "$REFERENCE_ONLY")"
test "$(git -C "$WT" rev-parse --show-toplevel)" = "$WT"
test "$(git -C "$WT" branch --show-current)" = the-usual/session-directory-page-prep
```

Expected: no output and exit 0.

- [ ] **Step 2: Prove the execute stage starts clean with the committed plan only.**

Run:

```bash
test -z "$(git -C "$WT" status --porcelain=v1 --untracked-files=all)"
git -C "$WT" merge-base --is-ancestor "$BASE_SHA" HEAD
printf '%s\n' "$PLAN_REL" >"$LOG_ROOT/expected-initial-paths.txt"
git -C "$WT" diff --name-only "$BASE_SHA" HEAD | sort \
  >"$LOG_ROOT/actual-initial-paths.txt"
diff -u "$LOG_ROOT/expected-initial-paths.txt" \
  "$LOG_ROOT/actual-initial-paths.txt"
git -C "$WT" diff --exit-code "$BASE_SHA" HEAD -- "$SOURCE_REL"
```

Expected: clean worktree, ancestor check exit 0, only the committed plan in `BASE_SHA..HEAD`, and no application-source diff.

- [ ] **Step 3: Record immutable baseline identity.**

Run:

```bash
{
  git -C "$WT" show -s --format='base_commit=%H%nbase_subject=%s%nbase_tree=%T' "$BASE_SHA"
  printf 'plan_head=%s\n' "$(git -C "$WT" rev-parse HEAD)"
  printf 'branch=%s\n' "$(git -C "$WT" branch --show-current)"
  printf 'worktree=%s\n' "$(realpath "$WT")"
} | tee "$LOG_ROOT/origin-main-identity.txt"
```

Expected: `base_commit=225a91db3e4d48d4b6a7e8bc0987afad8ff31917` and exit 0.

- [ ] **Step 4: Resolve Vitest backend policy before coordinated testing.**

Run:

```bash
if [[ -z "${FRESHELL_VITEST_BACKEND:-}" ]]; then
  printf '%s\n' 'STOP: ask the user to choose local/free or cloud/paid for FRESHELL_VITEST_BACKEND and persist the choice before continuing.'
  exit 1
fi
printf 'FRESHELL_VITEST_BACKEND=%s\n' "$FRESHELL_VITEST_BACKEND" \
  | tee "$LOG_ROOT/vitest-backend.txt"
```

Expected: a recorded nonempty backend. Do not silently select paid cloud execution.

- [ ] **Step 5: Inspect the coordinator and wait for any foreign holder.**

Run:

```bash
run_logged baseline-test-status npm --prefix "$WT" run test:status
```

Expected: exit 0. Wait rather than killing or bypassing another holder.

- [ ] **Step 6: Run the relevant focused Rust baseline.**

Run:

```bash
run_logged baseline-session-directory \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    session_directory -- --color=never --test-threads=1
```

Expected GREEN: exit 0; at least one test executes; every summary reports zero failures. Any failure here blocks implementation and cannot be waived as unrelated.

- [ ] **Step 7: Run the existing focused Rust-backed Playwright baseline locally.**

```bash
BASELINE_MATRIX_DISPOSITION=pending
BASELINE_MATRIX_DISPOSITION_FILE=
if run_rust_session_directory_matrix \
  baseline-rust-session-directory-matrix \
  "$WT" \
  "$LOG_ROOT/baseline-playwright-output"
then
  BASELINE_MATRIX_STATUS=0
  test "$(grep -Ec '(^|[^0-9])7 passed([^0-9]|$)' \
    "$LOG_ROOT/baseline-rust-session-directory-matrix.log")" -eq 1
  if grep -Eq '(^|[^0-9])(failed|skipped|interrupted|did not run)([^0-9]|$)' \
    "$LOG_ROOT/baseline-rust-session-directory-matrix.log"
  then
    printf '%s\n' 'STOP: baseline Rust Playwright matrix has a non-GREEN result summary.' >&2
    exit 1
  fi
  BASELINE_MATRIX_DISPOSITION=matrix_green
else
  BASELINE_MATRIX_STATUS=$?
  BASELINE_MATRIX_DISPOSITION=recovery_required
  FAILED_COMMAND_NAME=baseline-rust-session-directory-matrix
  printf '%s\n' \
    "RECOVERY REQUIRED: baseline Rust Playwright matrix exited $BASELINE_MATRIX_STATUS; Gate 0 Step 8 and Task 1 remain closed." \
    'If the Step-7 entry conditions are met, keep this Gate-0 shell open, set FAILURE_SEQUENCE to the next canonical value, and execute every Gate-8 Step-7 Bash fence through its final handoff assignment in this same shell.' \
    'Only paired_candidate_recovered_green or matching_BASE_SHA_playwright_environment_failure may reopen the gate; functional, timeout, route/API, DOM, and live-flow failures remain non-waivable.' >&2
fi
```

Required GREEN: exit 0, exactly one final `7 passed` marker, and no failed, skipped, interrupted, or did-not-run count. Direct GREEN sets `BASELINE_MATRIX_DISPOSITION=matrix_green`. A nonzero command remains a failed gate: `run_logged` has persisted the original command, argv, log, and exit evidence; the fence sets `FAILED_COMMAND_NAME=baseline-rust-session-directory-matrix` and `BASELINE_MATRIX_DISPOSITION=recovery_required`, but intentionally leaves the owning Gate-0 shell alive solely for the existing Step-7 protocol. It does not authorize Step 8. If the Step-7 entry conditions are met, set the next canonical `FAILURE_SEQUENCE` and execute every Step-7 Bash fence in this same shell. The final Step-7 fence may replace `recovery_required` only with `paired_candidate_recovered_green` or `matching_BASE_SHA_playwright_environment_failure` after verified cleanup; the latter is a waiver, never a pass. The Step-8 Bash guard then permits the sole resume point. A named assertion, route/API or DOM mismatch, timeout after server startup, or live create/search/delete failure is terminal and non-waivable.

- [ ] **Step 8: Run the canonical broad baseline through the coordinator.**

Run:

```bash
case "${BASELINE_MATRIX_DISPOSITION-}" in
  matrix_green)
    ;;
  paired_candidate_recovered_green|matching_BASE_SHA_playwright_environment_failure)
    test -n "${BASELINE_MATRIX_DISPOSITION_FILE-}"
    test -s "$BASELINE_MATRIX_DISPOSITION_FILE"
    grep -Fx "disposition=$BASELINE_MATRIX_DISPOSITION" \
      "$BASELINE_MATRIX_DISPOSITION_FILE" >/dev/null
    grep -Fx 'command_name=baseline-rust-session-directory-matrix' \
      "$BASELINE_MATRIX_DISPOSITION_FILE" >/dev/null
    grep -Fx 'command_phase=gate0-baseline' \
      "$BASELINE_MATRIX_DISPOSITION_FILE" >/dev/null
    ;;
  *)
    printf 'STOP: Gate 0 Step 8 is closed; baseline matrix disposition=%q\n' \
      "${BASELINE_MATRIX_DISPOSITION-unset}" >&2
    exit 1
    ;;
esac
if run_logged baseline-npm-test \
  env FRESHELL_TEST_SUMMARY='session-directory page-bound committed-plan baseline' \
  npm --prefix "$WT" test
then
  BASELINE_NPM_STATUS=0
else
  BASELINE_NPM_STATUS=$?
fi
run_logged baseline-test-status-after npm --prefix "$WT" run test:status
```

Expected normal result: client, server, and Electron exits are `code: 0`, positive test counts are printed, and status records success.

- [ ] **Step 9: Classify any baseline failure before proceeding.**

If `BASELINE_MATRIX_DISPOSITION=recovery_required`, Gate 0 Step 8 and Task 1 remain closed. For an eligible matrix failure, complete the same-shell Step-7 handoff described above and resume only at Step 8 after the final cleanup fence assigns one exact permitted disposition and its file. If `BASELINE_NPM_STATUS` is nonzero, run the existing coordinated-npm paired protocol. Proceed to Task 1 only after every failed baseline command has either recovered GREEN or produced its exact permitted matching-`BASE_SHA` disposition under all required attestations. Otherwise stop. Never edit unrelated files to repair the baseline.

---

### Task 1: Add the Complete Route Harness and Five Boundary Characterizations

**Fresh-shell precondition:** Start this execution unit in a new persistent Bash session and evaluate the complete `Command and Evidence Harness` block before Step 1. Run every Bash fence in this unit in that session; do not reuse shell state from a prior unit.

**Files:**
- Modify: `crates/freshell-server/src/session_directory.rs`
- Test: `crates/freshell-server/src/session_directory.rs`

**Interfaces:**

```text
StaticSessionSource::new(rows) -> deterministic in-memory SessionSource
DirectoryRouteHarness = real Router + SettingsStore + TerminalIdentityRegistry + TempDir
indexed_row/provider_row = complete IndexedSession fixtures
get_page = authenticated real-route JSON helper
item_ids/page_cursor = response inspectors
```

- [ ] **Step 1: Add the complete route harness before any test that uses it.**

Append this module to `crates/freshell-server/src/session_directory.rs`:

```rust
#[cfg(test)]
mod page_bound_tests {
    use super::*;
    use axum::{
        body::{to_bytes, Body},
        http::{Request, StatusCode},
        Router,
    };
    use freshell_sessions::directory_index::{
        FileStat, IndexedSession, SessionIndex, SessionSource,
    };
    use serde_json::{json, Value};
    use std::{
        collections::HashSet,
        path::{Path, PathBuf},
        sync::Arc,
        time::Duration,
    };
    use tower::ServiceExt;

    struct StaticSessionSource {
        entries: Vec<(PathBuf, IndexedSession)>,
    }

    impl StaticSessionSource {
        fn new(rows: Vec<IndexedSession>) -> Self {
            Self {
                entries: rows
                    .into_iter()
                    .enumerate()
                    .map(|(index, row)| {
                        (PathBuf::from(format!("/synthetic/{index}.jsonl")), row)
                    })
                    .collect(),
            }
        }
    }

    impl SessionSource for StaticSessionSource {
        fn discover(&self) -> Vec<FileStat> {
            self.entries
                .iter()
                .map(|(path, _)| FileStat {
                    path: path.clone(),
                    mtime_ms: 1,
                    size: 1,
                })
                .collect()
        }

        fn parse(&self, path: &Path) -> Option<IndexedSession> {
            self.entries
                .iter()
                .find(|(candidate, _)| candidate == path)
                .map(|(_, row)| row.clone())
        }
    }

    struct DirectoryRouteHarness {
        app: Router,
        settings: crate::settings_store::SettingsStore,
        identity: freshell_ws::identity::TerminalIdentityRegistry,
        _home: tempfile::TempDir,
    }

    fn indexed_row(session_id: &str, at: i64, title: Option<&str>) -> IndexedSession {
        IndexedSession {
            session_id: session_id.to_string(),
            provider: "claude".to_string(),
            project_path: "/repo".to_string(),
            title: title.map(str::to_string),
            title_provider_generated: false,
            summary: None,
            first_user_message: None,
            title_source: None,
            last_activity_at: at,
            created_at: Some(at),
            cwd: Some("/repo".to_string()),
            git_branch: None,
            is_subagent: false,
            is_non_interactive: false,
            source_file: None,
        }
    }

    fn provider_row(
        provider: &str,
        session_id: &str,
        at: i64,
        title: Option<&str>,
    ) -> IndexedSession {
        let mut row = indexed_row(session_id, at, title);
        row.provider = provider.to_string();
        row
    }

    fn directory_route_harness(rows: Vec<IndexedSession>) -> DirectoryRouteHarness {
        let home = tempfile::tempdir().expect("temporary home");
        let settings = crate::settings_store::SettingsStore::load(
            Some(home.path()),
            vec!["claude".into(), "codex".into(), "opencode".into()],
        );
        let identity = freshell_ws::identity::TerminalIdentityRegistry::new();
        let index = Arc::new(SessionIndex::with_ttl_and_cache_path(
            vec![Arc::new(StaticSessionSource::new(rows)) as Arc<dyn SessionSource>],
            Duration::from_secs(60),
            None,
        ));
        let app = router(SessionDirectoryState {
            auth_token: Arc::new("tok".into()),
            settings: settings.clone(),
            session_index: Some(index),
            identity: identity.clone(),
            metadata: crate::session_metadata::SessionMetadataStore::new(
                home.path().join(".freshell"),
            ),
        });
        DirectoryRouteHarness {
            app,
            settings,
            identity,
            _home: home,
        }
    }

    async fn get_page(app: Router, suffix: &str) -> Value {
        let response = app
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/session-directory?priority=visible{suffix}"
                    ))
                    .header("x-auth-token", "tok")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("route response");
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("response body");
        serde_json::from_slice(&bytes).expect("JSON response")
    }

    fn item_ids(page: &Value) -> Vec<String> {
        page["items"]
            .as_array()
            .expect("items array")
            .iter()
            .map(|item| {
                item["sessionId"]
                    .as_str()
                    .expect("sessionId")
                    .to_string()
            })
            .collect()
    }

    fn page_cursor(page: &Value) -> Option<String> {
        page["nextCursor"].as_str().map(str::to_string)
    }
```

- [ ] **Step 2: Add five current-route boundary tests in the same module.**

```rust
    #[tokio::test]
    async fn no_search_deleted_head_backfills_page_before_cut() {
        let harness = directory_route_harness(vec![
            indexed_row("raw-head", 300, Some("head")),
            indexed_row("backfill", 200, Some("backfill")),
            indexed_row("tail", 100, Some("tail")),
        ]);
        harness
            .settings
            .patch_session_override(
                "claude:raw-head",
                &[("deleted", Some(json!(true)))],
            )
            .await;
        let page = get_page(harness.app.clone(), "&limit=1").await;
        assert_eq!(item_ids(&page), vec!["backfill"]);
        assert!(page_cursor(&page).is_some());
        assert_eq!(page["revision"], json!(200));
    }

    #[tokio::test]
    async fn no_search_title_override_promotes_row_outside_raw_page() {
        let harness = directory_route_harness(vec![
            indexed_row("raw-head", 300, Some("head")),
            indexed_row("promoted", 200, None),
            indexed_row("tail", 100, Some("tail")),
        ]);
        harness
            .settings
            .patch_session_override(
                "claude:raw-head",
                &[("deleted", Some(json!(true)))],
            )
            .await;
        harness
            .settings
            .patch_session_override(
                "claude:promoted",
                &[
                    ("titleOverride", Some(json!("override title"))),
                    ("titleSource", Some(json!("user"))),
                ],
            )
            .await;
        let page = get_page(harness.app.clone(), "&limit=1").await;
        assert_eq!(item_ids(&page), vec!["promoted"]);
        assert_eq!(page["items"][0]["title"], json!("override title"));
        assert!(page_cursor(&page).is_some());
    }

    #[tokio::test]
    async fn no_search_running_join_promotes_row_outside_raw_page() {
        let harness = directory_route_harness(vec![
            indexed_row("raw-head", 300, Some("head")),
            indexed_row("running", 200, None),
            indexed_row("tail", 100, Some("tail")),
        ]);
        harness
            .settings
            .patch_session_override(
                "claude:raw-head",
                &[("deleted", Some(json!(true)))],
            )
            .await;
        harness.identity.upsert(
            "terminal-running",
            Some("claude"),
            Some("running"),
            Some("/repo"),
            900,
        );
        let page = get_page(harness.app.clone(), "&limit=1").await;
        assert_eq!(item_ids(&page), vec!["running"]);
        assert_eq!(page["items"][0]["lastActivityAt"], json!(200));
        assert_eq!(page["items"][0]["isRunning"], json!(true));
        assert_eq!(
            page["items"][0]["runningTerminalId"],
            json!("terminal-running")
        );
        assert_eq!(page["revision"], json!(900));
    }

    #[tokio::test]
    async fn no_search_newer_live_only_row_interleaves_and_drives_cursor() {
        let harness = directory_route_harness(vec![indexed_row(
            "indexed",
            200,
            Some("indexed"),
        )]);
        harness.identity.upsert(
            "terminal-live",
            Some("claude"),
            Some("live"),
            Some("/live"),
            300,
        );
        let first = get_page(harness.app.clone(), "&limit=1").await;
        assert_eq!(item_ids(&first), vec!["live"]);
        assert_eq!(first["items"][0]["lastActivityAt"], json!(300));
        assert_eq!(first["items"][0]["title"], json!("Claude CLI"));
        let cursor = page_cursor(&first).expect("first-page cursor");
        let second = get_page(
            harness.app.clone(),
            &format!("&limit=1&cursor={cursor}"),
        )
        .await;
        assert_eq!(item_ids(&second), vec!["indexed"]);
        assert!(page_cursor(&second).is_none());
    }

    #[tokio::test]
    async fn no_search_deleted_indexed_live_row_reappears_as_synthesized() {
        let harness = directory_route_harness(vec![indexed_row(
            "deleted-live",
            200,
            Some("indexed title"),
        )]);
        harness
            .settings
            .patch_session_override(
                "claude:deleted-live",
                &[
                    ("deleted", Some(json!(true))),
                    ("archived", Some(json!(true))),
                    ("titleOverride", Some(json!("must not survive"))),
                    ("summaryOverride", Some(json!("must not survive"))),
                ],
            )
            .await;
        harness.identity.upsert(
            "terminal-deleted-live",
            Some("claude"),
            Some("deleted-live"),
            Some("/live"),
            300,
        );
        let page = get_page(harness.app.clone(), "&limit=1").await;
        assert_eq!(item_ids(&page), vec!["deleted-live"]);
        let item = &page["items"][0];
        assert_eq!(item["title"], json!("Claude CLI"));
        assert_eq!(item["archived"], json!(false));
        assert_eq!(item["sessionType"], json!("claude"));
        assert_eq!(item["isRunning"], json!(true));
        assert!(item.get("summary").is_none());
        assert!(item.get("liveTerminalOnly").is_none());
    }
}
```

- [ ] **Step 3: Run five current-GREEN tests and the complete focused family.**

```bash
run_logged task1-page-bound \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    'session_directory::page_bound_tests' -- \
    --color=never --test-threads=1
run_logged task1-session-directory \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    session_directory -- --color=never --test-threads=1
```

Expected GREEN: page-bound module reports `5 passed; 0 failed; 0 ignored; 0 measured`; the focused family has a positive count and zero failures.

- [ ] **Step 4: Commit only the source file.**

```bash
git -C "$WT" diff --check
git -C "$WT" add -- "$SOURCE_REL"
test "$(git -C "$WT" diff --cached --name-only)" = "$SOURCE_REL"
git -C "$WT" commit \
  -m "test(session-directory): characterize effective page boundaries" \
  -m "Add the real-route synthetic index harness and pin deletion, override, running, live synthesis, and deleted-live page interactions before restructuring production policy." \
  -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)" \
  -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 2: Characterize Visibility, Cursor Union, Limits, Ordering, and Revision

**Fresh-shell precondition:** Start this execution unit in a new persistent Bash session and evaluate the complete `Command and Evidence Harness` block before Step 1. Run every Bash fence in this unit in that session; do not reuse shell state from a prior unit.

**Files:**
- Modify: `crates/freshell-server/src/session_directory.rs`
- Test: `crates/freshell-server/src/session_directory.rs`

**Interfaces:**

```text
Input = Task-1 real-route harness
Visibility matrix = all eight include-flag combinations
Pagination authority = opaque nextCursor chain and exact item union
Order authority = activity descending, complete formatted key descending
Revision authority = effective corpus and every identity, before filters/search
```

- [ ] **Step 1: Add six route tests inside `page_bound_tests`.**

Insert before the module's closing brace:

```rust
    #[tokio::test]
    async fn no_search_visibility_flags_restore_only_their_exclusion_class() {
        let mut subagent = indexed_row("subagent", 700, Some("subagent"));
        subagent.is_subagent = true;
        let mut noninteractive = indexed_row("noninteractive", 600, Some("noninteractive"));
        noninteractive.is_non_interactive = true;
        let harness = directory_route_harness(vec![
            indexed_row("visible", 800, Some("visible")),
            subagent,
            noninteractive,
            indexed_row("idle-empty", 500, None),
            indexed_row("whitespace", 400, Some("   ")),
            indexed_row("running-empty", 300, None),
        ]);
        harness.identity.upsert(
            "terminal-running-empty",
            Some("claude"),
            Some("running-empty"),
            Some("/repo"),
            350,
        );

        for include_subagents in [false, true] {
            for include_noninteractive in [false, true] {
                for include_empty in [false, true] {
                    let mut suffix = String::new();
                    if include_subagents {
                        suffix.push_str("&includeSubagents=1");
                    }
                    if include_noninteractive {
                        suffix.push_str("&includeNonInteractive=1");
                    }
                    if include_empty {
                        suffix.push_str("&includeEmpty=1");
                    }
                    let page = get_page(harness.app.clone(), &suffix).await;
                    let mut expected = vec!["visible"];
                    if include_subagents {
                        expected.push("subagent");
                    }
                    if include_noninteractive {
                        expected.push("noninteractive");
                    }
                    if include_empty {
                        expected.extend(["idle-empty", "whitespace"]);
                    }
                    expected.push("running-empty");
                    assert_eq!(item_ids(&page), expected, "suffix={suffix}");
                }
            }
        }
    }

    #[tokio::test]
    async fn no_search_cursor_chain_covers_effective_rows_exactly_once() {
        let mut hidden = indexed_row("hidden-newest", 900, Some("hidden"));
        hidden.is_subagent = true;
        let harness = directory_route_harness(vec![
            hidden,
            indexed_row("s5", 500, Some("five")),
            indexed_row("s4", 400, Some("four")),
            indexed_row("s3", 300, Some("three")),
            indexed_row("s2", 200, Some("two")),
            indexed_row("s1", 100, Some("one")),
        ]);
        let mut cursor = None;
        let mut seen = Vec::new();
        let mut page_count = 0usize;
        loop {
            page_count += 1;
            assert!(page_count <= 3);
            let suffix = match &cursor {
                Some(cursor) => format!("&limit=2&cursor={cursor}"),
                None => "&limit=2".to_string(),
            };
            let page = get_page(harness.app.clone(), &suffix).await;
            assert_eq!(page["revision"], json!(900));
            assert!(page.get("total").is_none());
            assert!(page.get("totalCount").is_none());
            assert!(page.get("totalSessions").is_none());
            seen.extend(item_ids(&page));
            cursor = page_cursor(&page);
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(seen, vec!["s5", "s4", "s3", "s2", "s1"]);
        let unique: HashSet<_> = seen.iter().collect();
        assert_eq!(unique.len(), seen.len());
    }

    #[tokio::test]
    async fn no_search_limit_boundary_emits_cursor_only_for_limit_plus_one() {
        for (count, limit, expected_len, expect_cursor) in [
            (0usize, 1usize, 0usize, false),
            (1, 1, 1, false),
            (2, 1, 1, true),
            (50, 50, 50, false),
            (51, 50, 50, true),
        ] {
            let rows = (0..count)
                .map(|index| {
                    indexed_row(
                        &format!("s-{index:03}"),
                        10_000 - index as i64,
                        Some("visible"),
                    )
                })
                .collect();
            let harness = directory_route_harness(rows);
            let page = get_page(harness.app.clone(), &format!("&limit={limit}")).await;
            assert_eq!(
                page["items"].as_array().expect("items").len(),
                expected_len,
                "count={count} limit={limit}"
            );
            assert_eq!(
                page_cursor(&page).is_some(),
                expect_cursor,
                "count={count} limit={limit}"
            );
        }
    }

    #[tokio::test]
    async fn no_search_equal_activity_uses_descending_full_key_for_order_and_cursor() {
        let harness = directory_route_harness(vec![
            provider_row("claude", "a", 500, Some("claude a")),
            provider_row("codex", "z", 500, Some("codex z")),
            provider_row("claude", "z", 500, Some("claude z")),
        ]);
        let first = get_page(harness.app.clone(), "&limit=2").await;
        let first_keys: Vec<String> = first["items"]
            .as_array()
            .expect("items")
            .iter()
            .map(|item| {
                format!(
                    "{}:{}",
                    item["provider"].as_str().expect("provider"),
                    item["sessionId"].as_str().expect("sessionId")
                )
            })
            .collect();
        assert_eq!(first_keys, vec!["codex:z", "claude:z"]);
        let cursor = page_cursor(&first).expect("cursor");
        let second = get_page(
            harness.app.clone(),
            &format!("&limit=2&cursor={cursor}"),
        )
        .await;
        let second_keys: Vec<String> = second["items"]
            .as_array()
            .expect("items")
            .iter()
            .map(|item| {
                format!(
                    "{}:{}",
                    item["provider"].as_str().expect("provider"),
                    item["sessionId"].as_str().expect("sessionId")
                )
            })
            .collect();
        assert_eq!(second_keys, vec!["claude:a"]);
        assert!(page_cursor(&second).is_none());
    }

    #[tokio::test]
    async fn revision_is_equal_across_pages_flags_and_title_search() {
        let harness = directory_route_harness(vec![
            indexed_row("hidden-newest", 900, None),
            indexed_row("match", 800, Some("needle title")),
            indexed_row("other", 700, Some("other")),
        ]);
        let first = get_page(harness.app.clone(), "&limit=1").await;
        assert_eq!(first["revision"], json!(900));
        let cursor = page_cursor(&first).expect("first cursor");
        let second = get_page(
            harness.app.clone(),
            &format!("&limit=1&cursor={cursor}"),
        )
        .await;
        assert_eq!(second["revision"], json!(900));
        let including_empty =
            get_page(harness.app.clone(), "&limit=1&includeEmpty=1").await;
        assert_eq!(including_empty["revision"], json!(900));
        let title_search = get_page(
            harness.app.clone(),
            "&query=needle&tier=title&limit=1",
        )
        .await;
        assert_eq!(title_search["revision"], json!(900));
        assert_eq!(item_ids(&title_search), vec!["match"]);
    }

    #[tokio::test]
    async fn providerless_live_identity_changes_revision_without_creating_item() {
        let harness = directory_route_harness(Vec::new());
        harness.identity.upsert(
            "providerless",
            None,
            None,
            Some("/repo"),
            900,
        );
        let page = get_page(harness.app.clone(), "").await;
        assert!(item_ids(&page).is_empty());
        assert!(page_cursor(&page).is_none());
        assert_eq!(page["revision"], json!(900));
    }
```

- [ ] **Step 2: Run eleven current-GREEN tests and the focused family.**

```bash
run_logged task2-page-bound \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    'session_directory::page_bound_tests' -- \
    --color=never --test-threads=1
run_logged task2-session-directory \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    session_directory -- --color=never --test-threads=1
```

Expected GREEN: `11 passed; 0 failed; 0 ignored; 0 measured`; complete focused family positive and zero failures.

- [ ] **Step 3: Commit only the source file.**

```bash
git -C "$WT" diff --check
git -C "$WT" add -- "$SOURCE_REL"
test "$(git -C "$WT" diff --cached --name-only)" = "$SOURCE_REL"
git -C "$WT" commit \
  -m "test(session-directory): pin paging totals and revisions" \
  -m "Characterize every visibility flag combination, exact cursor-chain union, page limits, full-key ties, corpus-wide revision stability, and providerless identity revision behavior." \
  -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)" \
  -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 3: Pin Empty Cursor Keys, Deep-Search Partials, and Stable Duplicate Semantics

**Fresh-shell precondition:** Start this execution unit in a new persistent Bash session and evaluate the complete `Command and Evidence Harness` block before Step 1. Run every Bash fence in this unit in that session; do not reuse shell state from a prior unit.

**Files:**
- Modify: `crates/freshell-server/src/session_directory.rs`
- Test: `crates/freshell-server/src/session_directory.rs`

**Interfaces:**

```text
Pre-refactor cursor authority = apply_query rejects invalid base64 and valid JSON with empty key
Pre-refactor deep authority = apply_query over ordered DirItem values with real transcript paths
Pre-refactor duplicate authority = apply_query over a caller-owned ordered Vec<DirItem>
Post-refactor migration target = derive_directory_page over ordered Vec<IndexedSession>
```

- [ ] **Step 1: Add complete pre-refactor test helpers before their tests.**

Inside `page_bound_tests`, add:

```rust
    fn test_query(
        query: Option<&str>,
        tier: Tier,
        cursor: Option<String>,
        limit: usize,
    ) -> DirQuery {
        DirQuery {
            query: query.map(str::to_string),
            tier,
            cursor,
            limit: Some(limit),
            include_subagents: false,
            include_non_interactive: false,
            include_empty: false,
        }
    }

    fn legacy_duplicate_items() -> Vec<DirItem> {
        [
            ("first", "/first"),
            ("second", "/second"),
        ]
        .into_iter()
        .map(|(title, project_path)| DirItem {
            session_id: "duplicate".to_string(),
            provider: "claude".to_string(),
            project_path: project_path.to_string(),
            title: Some(title.to_string()),
            summary: None,
            first_user_message: None,
            last_activity_at: 500,
            created_at: Some(500),
            cwd: Some(project_path.to_string()),
            is_subagent: false,
            is_non_interactive: false,
            is_running: false,
            archived: false,
            matched_in: None,
            snippet: None,
            running_terminal_id: None,
            live_terminal_only: false,
            session_type: None,
            title_source: None,
            source_file: None,
        })
        .collect()
    }
```

Inside the existing main `tests` module, before the deep-search tests, add:

```rust
    fn deep_search_dir_item(
        session_id: &str,
        at: i64,
        source_file: Option<PathBuf>,
    ) -> DirItem {
        DirItem {
            session_id: session_id.to_string(),
            provider: "claude".to_string(),
            project_path: "/repo".to_string(),
            title: Some("visible".to_string()),
            summary: None,
            first_user_message: None,
            last_activity_at: at,
            created_at: Some(at),
            cwd: Some("/repo".to_string()),
            is_subagent: false,
            is_non_interactive: false,
            is_running: false,
            archived: false,
            matched_in: None,
            snippet: None,
            running_terminal_id: None,
            live_terminal_only: false,
            session_type: None,
            title_source: None,
            source_file,
        }
    }

    fn write_nonmatching_claude_transcript(path: &Path) {
        std::fs::write(
            path,
            format!(
                "{}\n",
                json!({
                    "type": "user",
                    "message": {"content": "ordinary text"}
                })
            ),
        )
        .expect("write transcript");
    }

    fn deep_search_query() -> DirQuery {
        DirQuery {
            query: Some("needle".to_string()),
            tier: Tier::UserMessages,
            cursor: None,
            limit: Some(1),
            include_subagents: false,
            include_non_interactive: false,
            include_empty: false,
        }
    }
```

- [ ] **Step 2: Replace the nondeterministic route duplicate test with direct ordered-vector characterization.**

Add this as test 12 in `page_bound_tests`; do not route it through `SessionIndex`:

```rust
    #[test]
    fn duplicate_equal_order_tuples_preserve_stable_order_and_strict_cursor_gap() {
        let one_page = apply_query(
            legacy_duplicate_items(),
            &test_query(None, Tier::Title, None, 2),
            &[],
        )
        .expect("one page");
        let titles: Vec<&str> = one_page["items"]
            .as_array()
            .expect("items")
            .iter()
            .map(|item| item["title"].as_str().expect("title"))
            .collect();
        assert_eq!(titles, vec!["first", "second"]);
        assert!(one_page["nextCursor"].is_null());

        let first_page = apply_query(
            legacy_duplicate_items(),
            &test_query(None, Tier::Title, None, 1),
            &[],
        )
        .expect("first page");
        assert_eq!(first_page["items"][0]["title"], json!("first"));
        let cursor = first_page["nextCursor"]
            .as_str()
            .expect("duplicate cursor")
            .to_string();
        let second_page = apply_query(
            legacy_duplicate_items(),
            &test_query(None, Tier::Title, Some(cursor), 1),
            &[],
        )
        .expect("second page");
        assert!(second_page["items"].as_array().expect("items").is_empty());
        assert!(second_page["nextCursor"].is_null());
    }
```

This pins both stable sort over an explicitly ordered input vector and the current inability of a strict `{lastActivityAt,key}` cursor to distinguish the second exact duplicate.

- [ ] **Step 3: Extend `invalid_cursor_is_rejected` before changing the decoder.**

Replace its body with:

```rust
    #[test]
    fn invalid_cursor_is_rejected() {
        let empty_key_cursor = encode_cursor(1, "");
        for cursor in ["!!!not-base64!!!".to_string(), empty_key_cursor] {
            let query = DirQuery {
                query: None,
                tier: Tier::Title,
                cursor: Some(cursor),
                limit: Some(1),
                include_subagents: false,
                include_non_interactive: false,
                include_empty: false,
            };
            assert_eq!(
                apply_query(Vec::new(), &query, &[]).expect_err("invalid cursor"),
                "Invalid session-directory cursor"
            );
        }
    }
```

- [ ] **Step 4: Add three pre-refactor deep-search edge tests.**

Inside the existing deep-search test module, add:

```rust
    #[test]
    fn tier_search_reports_io_error_for_missing_source_file() {
        let home = tempfile::tempdir().expect("tempdir");
        let missing = home.path().join("missing.jsonl");
        let page = apply_query(
            vec![deep_search_dir_item("missing", 100, Some(missing))],
            &deep_search_query(),
            &[],
        )
        .expect("page");
        assert!(page["items"].as_array().expect("items").is_empty());
        assert_eq!(page["partial"], json!(true));
        assert_eq!(page["partialReason"], json!("io_error"));
    }

    #[test]
    fn tier_search_budget_overwrites_prior_io_error() {
        let home = tempfile::tempdir().expect("tempdir");
        let mut items = vec![deep_search_dir_item(
            "missing",
            1_000,
            Some(home.path().join("missing.jsonl")),
        )];
        for index in 0..9 {
            let path = home.path().join(format!("valid-{index}.jsonl"));
            write_nonmatching_claude_transcript(&path);
            items.push(deep_search_dir_item(
                &format!("valid-{index}"),
                999 - index as i64,
                Some(path),
            ));
        }
        let tail = home.path().join("eligible-tail.jsonl");
        write_nonmatching_claude_transcript(&tail);
        items.push(deep_search_dir_item("eligible-tail", 900, Some(tail)));

        let page = apply_query(items, &deep_search_query(), &[]).expect("page");
        assert!(page["items"].as_array().expect("items").is_empty());
        assert_eq!(page["partial"], json!(true));
        assert_eq!(page["partialReason"], json!("budget"));
    }

    #[test]
    fn tier_search_budget_is_checked_before_no_source_tail() {
        let home = tempfile::tempdir().expect("tempdir");
        let mut items = Vec::new();
        for index in 0..10 {
            let path = home.path().join(format!("valid-{index}.jsonl"));
            write_nonmatching_claude_transcript(&path);
            items.push(deep_search_dir_item(
                &format!("valid-{index}"),
                1_000 - index as i64,
                Some(path),
            ));
        }
        items.push(deep_search_dir_item("no-source-tail", 900, None));

        let page = apply_query(items, &deep_search_query(), &[]).expect("page");
        assert!(page["items"].as_array().expect("items").is_empty());
        assert_eq!(page["partial"], json!(true));
        assert_eq!(page["partialReason"], json!("budget"));
    }
```

- [ ] **Step 5: Run exact current-GREEN edge evidence.**

```bash
run_logged task3-duplicate \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    'session_directory::page_bound_tests::duplicate_equal_order_tuples_preserve_stable_order_and_strict_cursor_gap' -- \
    --exact --color=never --test-threads=1
run_logged task3-invalid-cursor \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    'session_directory::tests::invalid_cursor_is_rejected' -- \
    --exact --color=never --test-threads=1
for test_name in \
  tier_user_messages_matches_only_the_user_turn \
  tier_full_text_matches_assistant_turn_too \
  tier_search_is_case_insensitive \
  tier_search_empty_no_match_returns_empty_items_without_partial \
  tier_search_combined_with_cursor_pagination \
  tier_search_reports_partial_budget_when_scan_budget_exceeded \
  title_tier_search_matches_a_renamed_sessions_override_title \
  tier_search_reports_io_error_for_missing_source_file \
  tier_search_budget_overwrites_prior_io_error \
  tier_search_budget_is_checked_before_no_source_tail
do
  run_logged "task3-deep-$test_name" \
    env CARGO_TERM_COLOR=never \
    cargo test --manifest-path "$MANIFEST" \
      -p freshell-server --bin freshell-server \
      "session_directory::tests::$test_name" -- \
      --exact --color=never --test-threads=1
done
run_logged task3-page-bound \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    'session_directory::page_bound_tests' -- \
    --color=never --test-threads=1
```

Expected GREEN: duplicate and invalid-cursor filters each report `1 passed`; each of the ten named deep/title exact filters reports `1 passed`; page-bound module reports `12 passed; 0 failed; 0 ignored; 0 measured`.

- [ ] **Step 6: Commit only the source file.**

```bash
git -C "$WT" diff --check
git -C "$WT" add -- "$SOURCE_REL"
test "$(git -C "$WT" diff --cached --name-only)" = "$SOURCE_REL"
git -C "$WT" commit \
  -m "test(session-directory): pin cursor and deep partial edges" \
  -m "Characterize empty cursor-key rejection, stable supplied-vector duplicate order and cursor gaps, I/O partials, budget precedence, and budget checks before ineligible tails." \
  -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)" \
  -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 4: Characterize Search, Wire Shape, and Archived Recency

**Fresh-shell precondition:** Start this execution unit in a new persistent Bash session and evaluate the complete `Command and Evidence Harness` block before Step 1. Run every Bash fence in this unit in that session; do not reuse shell state from a prior unit.

**Files:**
- Modify: `crates/freshell-server/src/session_directory.rs`
- Test: `crates/freshell-server/src/session_directory.rs`

**Interfaces:**

```text
Title route authority = effective title, effective summary, first user message, precedence, 140 scalars
Wire authority = exact item/page fields and omissions, no total, no checkoutPath
Archived authority = current Rust recency/key ordering and strict cursor continuation
```

- [ ] **Step 1: Add three final pre-refactor route tests.**

Insert before the `page_bound_tests` closing brace:

```rust
    #[tokio::test]
    async fn title_search_matches_effective_title_summary_and_first_message_beyond_raw_page() {
        let long_title = format!("needle{}", "λ".repeat(150));
        let mut rows: Vec<IndexedSession> = (0..105)
            .map(|index| {
                indexed_row(
                    &format!("nonmatch-{index:03}"),
                    2_000 - index as i64,
                    Some("visible nonmatch"),
                )
            })
            .collect();
        let mut precedence = indexed_row("precedence", 500, Some(&long_title));
        precedence.summary = Some("needle summary".to_string());
        precedence.first_user_message = Some("needle first".to_string());
        rows.push(precedence);
        let mut summary = indexed_row("summary", 400, Some("visible"));
        summary.summary = Some("needle in summary".to_string());
        rows.push(summary);
        let mut first = indexed_row("first", 300, Some("visible"));
        first.first_user_message = Some("needle in first message".to_string());
        rows.push(first);
        rows.push(indexed_row("override-title", 200, None));
        rows.push(indexed_row("override-summary", 100, Some("visible")));
        let harness = directory_route_harness(rows);
        harness
            .settings
            .patch_session_override(
                "claude:override-title",
                &[
                    ("titleOverride", Some(json!("needle override title"))),
                    ("titleSource", Some(json!("user"))),
                ],
            )
            .await;
        harness
            .settings
            .patch_session_override(
                "claude:override-summary",
                &[("summaryOverride", Some(json!("needle override summary")))],
            )
            .await;
        let page = get_page(
            harness.app.clone(),
            "&query=needle&tier=title&limit=5",
        )
        .await;
        assert_eq!(
            item_ids(&page),
            vec![
                "precedence",
                "summary",
                "first",
                "override-title",
                "override-summary",
            ]
        );
        assert!(page_cursor(&page).is_none());
        let items = page["items"].as_array().expect("items");
        assert_eq!(items[0]["matchedIn"], json!("title"));
        assert_eq!(
            items[0]["snippet"],
            json!(long_title.chars().take(140).collect::<String>())
        );
        assert_eq!(
            items[0]["snippet"]
                .as_str()
                .expect("snippet")
                .chars()
                .count(),
            140
        );
        assert_eq!(items[1]["matchedIn"], json!("summary"));
        assert_eq!(items[2]["matchedIn"], json!("firstUserMessage"));
        assert_eq!(items[3]["matchedIn"], json!("title"));
        assert_eq!(items[4]["matchedIn"], json!("summary"));
    }

    #[tokio::test]
    async fn no_search_exact_response_shape_preserves_all_fields_and_no_totals() {
        let mut indexed = indexed_row("shape", 200, Some("base title"));
        indexed.project_path = "/project".to_string();
        indexed.summary = Some("base summary".to_string());
        indexed.first_user_message = Some("first user".to_string());
        indexed.created_at = Some(150);
        indexed.cwd = Some("/cwd".to_string());
        indexed.title_source = Some("user".to_string());
        indexed.source_file = Some(PathBuf::from("/internal/source.jsonl"));
        let harness = directory_route_harness(vec![indexed]);
        harness
            .settings
            .patch_session_override(
                "claude:shape",
                &[
                    ("titleOverride", Some(json!("effective title"))),
                    ("summaryOverride", Some(json!("effective summary"))),
                    ("archived", Some(json!(true))),
                ],
            )
            .await;
        harness.identity.upsert(
            "terminal-indexed",
            Some("claude"),
            Some("shape"),
            Some("/cwd"),
            250,
        );
        harness.identity.upsert(
            "terminal-fallback",
            Some("claude"),
            None,
            Some("/live"),
            300,
        );
        let page = get_page(harness.app.clone(), "&limit=2").await;
        assert_eq!(
            page,
            json!({
                "items": [
                    {
                        "sessionId": "terminal:terminal-fallback",
                        "provider": "claude",
                        "projectPath": "/live",
                        "title": "Claude CLI",
                        "lastActivityAt": 300,
                        "createdAt": 300,
                        "cwd": "/live",
                        "isRunning": true,
                        "archived": false,
                        "runningTerminalId": "terminal-fallback",
                        "liveTerminalOnly": true,
                        "sessionType": "claude"
                    },
                    {
                        "sessionId": "shape",
                        "provider": "claude",
                        "projectPath": "/project",
                        "title": "effective title",
                        "summary": "effective summary",
                        "firstUserMessage": "first user",
                        "lastActivityAt": 200,
                        "createdAt": 150,
                        "cwd": "/cwd",
                        "isRunning": true,
                        "archived": true,
                        "runningTerminalId": "terminal-indexed"
                    }
                ],
                "nextCursor": null,
                "revision": 300
            })
        );
        for forbidden in ["total", "totalCount", "totalSessions"] {
            assert!(page.get(forbidden).is_none());
        }
        for item in page["items"].as_array().expect("items") {
            assert!(item.get("checkoutPath").is_none());
            assert!(item.get("titleSource").is_none());
            assert!(item.get("sourceFile").is_none());
        }
    }

    #[tokio::test]
    async fn rust_http_order_remains_recency_first_when_newer_row_is_archived() {
        let harness = directory_route_harness(vec![
            indexed_row("newer-archived", 300, Some("newer")),
            indexed_row("older-active", 200, Some("older")),
        ]);
        harness
            .settings
            .patch_session_override(
                "claude:newer-archived",
                &[("archived", Some(json!(true)))],
            )
            .await;
        let first = get_page(harness.app.clone(), "&limit=1").await;
        assert_eq!(item_ids(&first), vec!["newer-archived"]);
        assert_eq!(first["items"][0]["archived"], json!(true));
        let cursor = page_cursor(&first).expect("cursor");
        let second = get_page(
            harness.app.clone(),
            &format!("&limit=1&cursor={cursor}"),
        )
        .await;
        assert_eq!(item_ids(&second), vec!["older-active"]);
        assert_eq!(second["items"][0]["archived"], json!(false));
        assert!(page_cursor(&second).is_none());
    }
```

- [ ] **Step 2: Run all 15 pre-refactor page-bound characterizations and the focused family.**

```bash
run_logged task4-page-bound \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    'session_directory::page_bound_tests' -- \
    --color=never --test-threads=1
run_logged task4-session-directory \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    session_directory -- --color=never --test-threads=1
```

Expected GREEN: `15 passed; 0 failed; 0 ignored; 0 measured`; focused family positive and zero failures. This is the final eager-policy authority.

- [ ] **Step 3: Commit only the source file.**

```bash
git -C "$WT" diff --check
git -C "$WT" add -- "$SOURCE_REL"
test "$(git -C "$WT" diff --cached --name-only)" = "$SOURCE_REL"
git -C "$WT" commit \
  -m "test(session-directory): freeze search and response semantics" \
  -m "Pin effective title-tier matching, exact wire fields and omissions, and current Rust archived recency behavior before replacing the eager policy." \
  -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)" \
  -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 5: Normalize the Existing Provider Display Helper In Place

**Fresh-shell precondition:** Start this execution unit in a new persistent Bash session and evaluate the complete `Command and Evidence Harness` block before Step 1. Run every Bash fence in this unit in that session; do not reuse shell state from a prior unit.

**Files:**
- Modify: `crates/freshell-server/src/session_directory.rs`
- Test: `crates/freshell-server/src/session_directory.rs`

**Interfaces:**

```text
provider_display_name(provider: &str) -> &str
Existing eager synth caller converts the borrowed display name to String
Final candidate search and materialization reuse the same helper
No provider_display_name_borrowed symbol exists
```

- [ ] **Step 1: Change the existing helper and its current caller atomically.**

Replace the existing helper with:

```rust
fn provider_display_name(provider: &str) -> &str {
    match provider {
        "claude" => "Claude CLI",
        "codex" => "Codex CLI",
        "opencode" => "OpenCode",
        _ => provider,
    }
}
```

In the existing eager `build_live_terminal_session_item`, `provider` is an owned `String`; replace its title expression with:

```rust
        title: Some(provider_display_name(&provider).to_string()),
```

- [ ] **Step 2: Migrate the existing display-helper test to the borrowed return type.**

Replace its body with:

```rust
    #[test]
    fn provider_display_name_matches_known_providers_and_falls_back_to_raw() {
        assert_eq!(provider_display_name("claude"), "Claude CLI");
        assert_eq!(provider_display_name("codex"), "Codex CLI");
        assert_eq!(provider_display_name("opencode"), "OpenCode");
        assert_eq!(provider_display_name("amplifier"), "amplifier");
    }
```

- [ ] **Step 3: Run focused GREEN evidence and reject duplicate display policy.**

```bash
run_logged task5-display \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    'session_directory::join_tests::provider_display_name_matches_known_providers_and_falls_back_to_raw' -- \
    --exact --color=never --test-threads=1
run_logged task5-session-directory \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    session_directory -- --color=never --test-threads=1
! grep -n 'provider_display_name_borrowed' "$WT/$SOURCE_REL"
test "$(grep -Ec '^fn provider_display_name\(' "$WT/$SOURCE_REL")" -eq 1
```

Expected GREEN: exact display test executes 1 and passes; focused family has zero failures; static checks exit 0.

- [ ] **Step 4: Commit only the source file.**

```bash
git -C "$WT" diff --check
git -C "$WT" add -- "$SOURCE_REL"
test "$(git -C "$WT" diff --cached --name-only)" = "$SOURCE_REL"
git -C "$WT" commit \
  -m "refactor(session-directory): borrow provider display names" \
  -m "Change the existing display policy in place so eager and candidate paths share one borrowed helper without a duplicate implementation." \
  -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)" \
  -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 6: Stage, Differentially Validate, Cut Over, and Remove the Eager Policy

**Fresh-shell precondition:** Start this execution unit in a new persistent Bash session and evaluate the complete `Command and Evidence Harness` block before Step 1. Run every Bash fence in this unit in that session; do not reuse shell state from a prior unit.

**Files:**
- Modify: `crates/freshell-server/src/session_directory.rs`
- Test: `crates/freshell-server/src/session_directory.rs`

**Interfaces:**

```text
DirectoryInputs<'a> = indexed + overrides + metadata + identities borrows
Default DirectoryCandidateSource<'a> = borrowed Indexed or Synthesized source
Permitted A02 fallback DirectoryCandidateSource = row/identity indices + exact provenance, no source borrows
DirectoryOrderKey<'a> = last_activity_at + full key
DecodedCursor = typed nonempty cursor data
SearchAnnotation = owned matched_in and snippet
SelectedCandidate/CandidatePage = lifetime-bearing only in the default profile; reference-free in fallback
Temporary test-only eager oracle = exact composition of current eager helpers
Differential authority = exact Value + serialized-byte equality over 516 deterministic comparisons
Borrowed-handler gate = actual Axum handler compiled after final await/narrow borrow/explicit drop
Fallback = reference-free row/identity indices plus overlay provenance, only on relevant rustc failure
Task-6 commits = candidate+differential, handler cutover, eager cleanup
Final production entry = derive_directory_page(inputs, query)
One full constructor = materialize_selected_candidate(selected, metadata) by default, or materialize_selected_candidate(selected, inputs) in fallback
One serializer = DirItem::to_value
```

This is documentation of one source-selected representation, not two compiled strategies. The coexistence checkpoint is test-only, reversible evidence, not a production strategy. The route remains on eager composition for the first Task-6 commit; after differential success it moves once to the candidate path; the third commit deletes eager production/helpers and the temporary oracle. No enum, feature flag, runtime selector, duplicate production derivation, or fallback residue is introduced. Every non-RED checkpoint must compile; the only intentional compile failures are the named shared-test RED and Task-7 work-bound REDs.

#### Phase A: Candidate RED/GREEN while the production route stays eager

- [ ] **Step 1: Add five shared-policy tests and record compile-RED.**

Inside `page_bound_tests`, add the shared tests using the representation selected for this phase. The fence is a two-profile editing template, not a block to copy wholesale. Before Phase C, the default borrowed profile is mandatory: omit `test_directory_inputs`; retain the borrowed `order_key()`, visibility, materializer-with-`&metadata`, and title-annotation calls already shown; and use this exact borrowed resolver test instead of the provenance-method body later in the fence:

    #[test]
    fn shared_override_resolver_preserves_provider_generated_title_guard() {
        let mut row = indexed_row("overlay", 100, Some("base title"));
        row.summary = Some("base summary".to_string());
        row.title_source = Some("provider-generated".to_string());
        let accepted = json!({
            "titleOverride": "accepted",
            "titleSource": "user",
            "summaryOverride": "",
            "archived": true
        });
        let overlay = resolve_indexed_overlay(&row, Some(&accepted)).expect("accepted overlay");
        assert_eq!(overlay.effective_title, Some("accepted"));
        assert_eq!(overlay.effective_summary, Some(""));
        assert!(overlay.archived);
        for source in ["dir", "first-message"] {
            let suppressed = json!({
                "titleOverride": "suppressed",
                "titleSource": source
            });
            let overlay = resolve_indexed_overlay(&row, Some(&suppressed)).expect("overlay");
            assert_eq!(overlay.effective_title, Some("base title"));
            assert_eq!(overlay.effective_summary, Some("base summary"));
            assert!(!overlay.archived);
        }
        let empty = json!({"titleOverride": ""});
        let overlay = resolve_indexed_overlay(&row, Some(&empty)).expect("overlay");
        assert_eq!(overlay.effective_title, Some("base title"));
        let deleted = json!({"deleted": true});
        assert!(resolve_indexed_overlay(&row, Some(&deleted)).is_none());
    }

Only if Phase C later authorizes fallback, revisit this same fence: add `test_directory_inputs`, use the provenance resolver body shown, and apply the exhaustive fallback call-site mapping after the fallback profile. Never apply those substitutions during the Phase-A borrowed GREEN gate.

```rust
    fn test_directory_inputs<'a>(
        indexed: &'a [IndexedSession],
        overrides: &'a Map<String, Value>,
        metadata: &'a HashMap<String, Value>,
        identities: &'a [TerminalIdentity],
    ) -> DirectoryInputs<'a> {
        DirectoryInputs {
            indexed,
            overrides,
            metadata,
            identities,
        }
    }

    #[test]
    fn shared_order_comparator_and_cursor_relation_are_exact_inverses() {
        let cases = [
            (20, "claude", "new", 10, "claude:old"),
            (10, "claude", "z", 10, "claude:a"),
            (10, "a", "b:c", 10, "a:b:c"),
            (10, "provider", "prefix", 10, "provider:prefix-long"),
            (10, "λ", "会話", 10, "λ:会話a"),
            (i64::MAX, "max", "id", i64::MIN, "min:id"),
            (i64::MIN, "min", "id", i64::MAX, "max:id"),
        ];
        for (left_at, provider, session_id, right_at, right_key) in cases {
            let row = provider_row(provider, session_id, left_at, Some("visible"));
            let overrides = Map::new();
            let identities = Vec::new();
            let mut candidates =
                build_directory_candidates(std::slice::from_ref(&row), &overrides, &identities);
            let candidate = candidates.pop().expect("candidate");
            let cursor = DecodedCursor {
                last_activity_at: right_at,
                key: right_key.to_string(),
            };
            let expected = right_at
                .cmp(&left_at)
                .then_with(|| right_key.cmp(candidate.key.as_ref()));
            assert_eq!(
                compare_directory_order(
                    candidate.order_key(),
                    DirectoryOrderKey {
                        last_activity_at: right_at,
                        key: right_key,
                    },
                ),
                expected
            );
            assert_eq!(
                candidate_is_strictly_after_cursor(&candidate, &cursor),
                expected == Ordering::Greater
            );
        }
    }

    #[test]
    fn shared_visibility_predicate_preserves_running_empty_exception() {
        let whitespace = indexed_row("whitespace", 100, Some("   "));
        let overrides = Map::new();
        let no_identities = Vec::new();
        let mut candidates = build_directory_candidates(
            std::slice::from_ref(&whitespace),
            &overrides,
            &no_identities,
        );
        let candidate = candidates.pop().expect("candidate");
        assert!(!candidate_is_visible(
            &candidate,
            &test_query(None, Tier::Title, None, 50)
        ));
        let mut include_empty = test_query(None, Tier::Title, None, 50);
        include_empty.include_empty = true;
        assert!(candidate_is_visible(&candidate, &include_empty));

        let running = indexed_row("running", 90, None);
        let registry = freshell_ws::identity::TerminalIdentityRegistry::new();
        registry.upsert(
            "terminal-running",
            Some("claude"),
            Some("running"),
            Some("/repo"),
            900,
        );
        let identities = registry.list();
        let mut running_candidates = build_directory_candidates(
            std::slice::from_ref(&running),
            &overrides,
            &identities,
        );
        assert!(candidate_is_visible(
            &running_candidates.pop().expect("running candidate"),
            &test_query(None, Tier::Title, None, 50)
        ));
    }

    #[test]
    fn shared_override_resolver_preserves_provider_generated_title_guard() {
        let mut row = indexed_row("overlay", 100, Some("base title"));
        row.summary = Some("base summary".to_string());
        row.title_source = Some("provider-generated".to_string());
        let accepted = json!({
            "titleOverride": "accepted",
            "titleSource": "user",
            "summaryOverride": "",
            "archived": true
        });
        let overlay = resolve_indexed_overlay(&row, Some(&accepted)).expect("accepted overlay");
        assert_eq!(
            overlay.resolved_title(&row, Some(&accepted)),
            Some("accepted")
        );
        assert_eq!(overlay.resolved_summary(&row, Some(&accepted)), Some(""));
        assert!(overlay.archived);
        for source in ["dir", "first-message"] {
            let suppressed = json!({
                "titleOverride": "suppressed",
                "titleSource": source
            });
            let overlay = resolve_indexed_overlay(&row, Some(&suppressed)).expect("overlay");
            assert_eq!(
                overlay.resolved_title(&row, Some(&suppressed)),
                Some("base title")
            );
            assert_eq!(
                overlay.resolved_summary(&row, Some(&suppressed)),
                Some("base summary")
            );
            assert!(!overlay.archived);
        }
        let empty = json!({"titleOverride": ""});
        let overlay = resolve_indexed_overlay(&row, Some(&empty)).expect("overlay");
        assert_eq!(
            overlay.resolved_title(&row, Some(&empty)),
            Some("base title")
        );
        let deleted = json!({"deleted": true});
        assert!(resolve_indexed_overlay(&row, Some(&deleted)).is_none());
    }

    #[test]
    fn candidate_normalization_preserves_first_winner_from_supplied_identity_vector() {
        let indexed = provider_row("claude", "same", 100, None);
        let registry = freshell_ws::identity::TerminalIdentityRegistry::new();
        registry.upsert("z-running-first", Some("claude"), Some("same"), Some("/first"), 401);
        registry.upsert("a-running-second", Some("claude"), Some("same"), Some("/second"), 402);
        registry.upsert("y-collision-first", Some("a"), Some("b:c"), Some("/collision-first"), 403);
        registry.upsert("b-collision-second", Some("a:b"), Some("c"), Some("/collision-second"), 404);
        let supplied = vec![
            registry.get("z-running-first").expect("z-running-first"),
            registry.get("a-running-second").expect("a-running-second"),
            registry.get("y-collision-first").expect("y-collision-first"),
            registry.get("b-collision-second").expect("b-collision-second"),
        ];
        let permuted = vec![
            registry.get("a-running-second").expect("a-running-second"),
            registry.get("z-running-first").expect("z-running-first"),
            registry.get("b-collision-second").expect("b-collision-second"),
            registry.get("y-collision-first").expect("y-collision-first"),
        ];
        let winners = |identities: &[TerminalIdentity]| {
            let overrides = Map::new();
            let candidates = build_directory_candidates(
                std::slice::from_ref(&indexed),
                &overrides,
                identities,
            );
            assert_eq!(candidates.len(), 2);
            let metadata = HashMap::new();
            let items = candidates
                .into_iter()
                .map(|candidate| materialize_selected_candidate(
                    &SelectedCandidate { candidate, annotation: None },
                    &metadata,
                ))
                .collect::<Vec<_>>();
            let indexed_item = items.iter().find(|item| item.session_id == "same").expect("indexed");
            let synth_item = items.iter().find(|item| item.session_id != "same").expect("synth");
            (
                indexed_item.running_terminal_id.clone(),
                synth_item.running_terminal_id.clone(),
                synth_item.provider.clone(),
                synth_item.session_id.clone(),
            )
        };
        assert_eq!(
            winners(&supplied),
            (Some("z-running-first".into()), Some("y-collision-first".into()), "a".into(), "b:c".into())
        );
        assert_eq!(
            winners(&permuted),
            (Some("a-running-second".into()), Some("b-collision-second".into()), "a:b".into(), "c".into())
        );
    }

    #[test]
    fn shared_title_match_preserves_field_precedence_and_140_scalar_snippet() {
        let mut row = indexed_row("precedence", 100, Some("needle title"));
        row.summary = Some("needle summary".to_string());
        row.first_user_message = Some("needle first".to_string());
        let overrides = Map::new();
        let identities = Vec::new();
        let mut candidates = build_directory_candidates(
            std::slice::from_ref(&row),
            &overrides,
            &identities,
        );
        let annotation = title_search_annotation(
            &candidates.pop().expect("candidate"),
            "needle",
        )
        .expect("title match");
        assert_eq!(annotation.matched_in, "title");
        assert_eq!(annotation.snippet, "needle title");
        for scalar_count in [139usize, 140, 141] {
            let field = format!("needle{}", "界".repeat(scalar_count - 6));
            let row = indexed_row("scalar", 90, Some(&field));
            let mut candidates = build_directory_candidates(
                std::slice::from_ref(&row),
                &overrides,
                &identities,
            );
            let annotation = title_search_annotation(
                &candidates.pop().expect("candidate"),
                "needle",
            )
            .expect("match");
            assert_eq!(annotation.snippet.chars().count(), scalar_count.min(140));
            assert_eq!(annotation.snippet, field.chars().take(140).collect::<String>());
        }

        let mut summary_row = indexed_row("summary", 80, Some("visible"));
        summary_row.summary = Some("needle summary".to_string());
        let mut summary_candidates = build_directory_candidates(
            std::slice::from_ref(&summary_row),
            &overrides,
            &identities,
        );
        assert_eq!(
            title_search_annotation(
                &summary_candidates.pop().expect("summary candidate"),
                "needle",
            )
            .expect("summary match")
            .matched_in,
            "summary"
        );

        let mut first_row = indexed_row("first", 70, Some("visible"));
        first_row.first_user_message = Some("needle first".to_string());
        let mut first_candidates = build_directory_candidates(
            std::slice::from_ref(&first_row),
            &overrides,
            &identities,
        );
        assert_eq!(
            title_search_annotation(
                &first_candidates.pop().expect("first candidate"),
                "needle",
            )
            .expect("first match")
            .matched_in,
            "firstUserMessage"
        );
    }
```

Run intentional RED:

```bash
set +e
env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    'session_directory::page_bound_tests::shared_' -- \
    --color=never --test-threads=1 \
  2>&1 | tee "$LOG_ROOT/task6-shared-red.log"
RED_STATUS=${PIPESTATUS[0]}
printf 'exit_code=%s\n' "$RED_STATUS" | tee "$LOG_ROOT/task6-shared-red.exit"
set -e
test "$RED_STATUS" -ne 0
grep -Eq 'cannot find (function|type|struct).*(compare_directory_order|resolve_indexed_overlay|build_directory_candidates|title_search_annotation)' \
  "$LOG_ROOT/task6-shared-red.log"
```

Expected RED: missing new candidate symbols, not malformed test syntax.

- [ ] **Step 2: Recover GREEN by adding the complete imports, candidate policy, selector, and materializer in one checkpoint.**

Complete both parts of Step 2 below before handing off or treating this checkbox as finished.

Replace the current top import region through the boot import with this complete block. It preserves every production import and the retained parser/oracle imports while adding the candidate-pipeline names:

```rust
use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::Arc,
};

use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use freshell_sessions::{
    directory_index::{IndexedSession, SessionIndex},
    search::{search_session_file, FileSearchTier},
};
#[cfg(test)]
use freshell_sessions::meta::ParsedSessionMeta;
#[cfg(test)]
use freshell_sessions::{parse_session_content, ParseSessionOptions};
use freshell_ws::identity::TerminalIdentity;
use serde_json::{json, Map, Value};

use crate::boot::{is_authed, unauthorized};
```

This block explicitly preserves `PathBuf`, `SessionIndex`, `json`, `ParsedSessionMeta`, `parse_session_content`, `ParseSessionOptions`, and the boot imports while adding `Ordering`, `HashSet`, `IndexedSession`, and `TerminalIdentity`.

**Step 2, part A — Add candidate types and shared normalization/accessor policy.**

Add before the handler:

```rust
#[derive(Clone, Copy)]
struct DirectoryInputs<'a> {
    indexed: &'a [IndexedSession],
    overrides: &'a Map<String, Value>,
    metadata: &'a HashMap<String, Value>,
    identities: &'a [TerminalIdentity],
}

#[derive(Clone, Copy, Debug)]
struct IndexedOverlay<'a> {
    effective_title: Option<&'a str>,
    effective_summary: Option<&'a str>,
    archived: bool,
}

#[derive(Clone, Copy, Debug)]
enum SynthesizedSessionId<'a> {
    Existing(&'a str),
    TerminalFallback(&'a str),
}

#[derive(Debug)]
enum DirectoryCandidateSource<'a> {
    Indexed {
        row: &'a IndexedSession,
        overlay: IndexedOverlay<'a>,
        running_identity: Option<&'a TerminalIdentity>,
    },
    Synthesized {
        identity: &'a TerminalIdentity,
        provider: &'a str,
        session_id: SynthesizedSessionId<'a>,
    },
}

#[derive(Debug)]
struct DirectoryCandidate<'a> {
    key: Arc<str>,
    source: DirectoryCandidateSource<'a>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DirectoryOrderKey<'a> {
    last_activity_at: i64,
    key: &'a str,
}

#[derive(Debug, PartialEq, Eq)]
struct DecodedCursor {
    last_activity_at: i64,
    key: String,
}

#[derive(Debug, PartialEq, Eq)]
struct SearchAnnotation {
    matched_in: String,
    snippet: String,
}

#[derive(Debug)]
struct SelectedCandidate<'a> {
    candidate: DirectoryCandidate<'a>,
    annotation: Option<SearchAnnotation>,
}

#[derive(Debug)]
struct CandidatePage<'a> {
    rows: Vec<SelectedCandidate<'a>>,
    partial: bool,
    partial_reason: Option<&'static str>,
}

fn resolve_indexed_overlay<'a>(
    row: &'a IndexedSession,
    override_value: Option<&'a Value>,
) -> Option<IndexedOverlay<'a>> {
    let Some(override_row) = override_value.and_then(Value::as_object) else {
        return Some(IndexedOverlay {
            effective_title: row.title.as_deref(),
            effective_summary: row.summary.as_deref(),
            archived: false,
        });
    };
    if override_row.get("deleted").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let suppress_title_override = row.title_source.as_deref() == Some("provider-generated")
        && matches!(
            override_row.get("titleSource").and_then(Value::as_str),
            Some("dir" | "first-message")
        );
    let effective_title = override_row
        .get("titleOverride")
        .and_then(Value::as_str)
        .filter(|title| !title.is_empty() && !suppress_title_override)
        .or(row.title.as_deref());
    let effective_summary = override_row
        .get("summaryOverride")
        .and_then(Value::as_str)
        .or(row.summary.as_deref());
    Some(IndexedOverlay {
        effective_title,
        effective_summary,
        archived: override_row
            .get("archived")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

fn first_identity_by_exact_session<'a>(
    identities: &'a [TerminalIdentity],
) -> HashMap<(&'a str, &'a str), usize> {
    let mut first = HashMap::new();
    for (index, identity) in identities.iter().enumerate() {
        if let (Some(provider), Some(session_id)) =
            (identity.provider.as_deref(), identity.session_id.as_deref())
        {
            first.entry((provider, session_id)).or_insert(index);
        }
    }
    first
}

fn build_directory_candidates<'a>(
    indexed: &'a [IndexedSession],
    overrides: &'a Map<String, Value>,
    identities: &'a [TerminalIdentity],
) -> Vec<DirectoryCandidate<'a>> {
    let first_live = first_identity_by_exact_session(identities);
    let mut existing_keys: HashSet<Arc<str>> = HashSet::new();
    let mut candidates = Vec::with_capacity(indexed.len() + identities.len());
    for row in indexed {
        let key: Arc<str> = Arc::from(
            format!("{}:{}", row.provider, row.session_id).into_boxed_str(),
        );
        let Some(overlay) = resolve_indexed_overlay(row, overrides.get(key.as_ref())) else {
            continue;
        };
        let running_identity = first_live
            .get(&(row.provider.as_str(), row.session_id.as_str()))
            .map(|index| &identities[*index]);
        existing_keys.insert(Arc::clone(&key));
        candidates.push(DirectoryCandidate {
            key,
            source: DirectoryCandidateSource::Indexed {
                row,
                overlay,
                running_identity,
            },
        });
    }
    for identity in identities {
        let Some(provider) = identity.provider.as_deref() else {
            continue;
        };
        let session_id = match identity.session_id.as_deref() {
            Some(session_id) => SynthesizedSessionId::Existing(session_id),
            None => SynthesizedSessionId::TerminalFallback(&identity.terminal_id),
        };
        let key: Arc<str> = Arc::from(match session_id {
            SynthesizedSessionId::Existing(session_id) => {
                format!("{provider}:{session_id}").into_boxed_str()
            }
            SynthesizedSessionId::TerminalFallback(terminal_id) => {
                format!("{provider}:terminal:{terminal_id}").into_boxed_str()
            }
        });
        if !existing_keys.insert(Arc::clone(&key)) {
            continue;
        }
        candidates.push(DirectoryCandidate {
            key,
            source: DirectoryCandidateSource::Synthesized {
                identity,
                provider,
                session_id,
            },
        });
    }
    candidates
}

impl DirectoryCandidate<'_> {
    fn order_key(&self) -> DirectoryOrderKey<'_> {
        DirectoryOrderKey {
            last_activity_at: match &self.source {
                DirectoryCandidateSource::Indexed { row, .. } => row.last_activity_at,
                DirectoryCandidateSource::Synthesized { identity, .. } => identity.updated_at,
            },
            key: &self.key,
        }
    }

    fn provider(&self) -> &str {
        match &self.source {
            DirectoryCandidateSource::Indexed { row, .. } => &row.provider,
            DirectoryCandidateSource::Synthesized { provider, .. } => provider,
        }
    }

    fn effective_title(&self) -> Option<&str> {
        match &self.source {
            DirectoryCandidateSource::Indexed { overlay, .. } => overlay.effective_title,
            DirectoryCandidateSource::Synthesized { provider, .. } => {
                Some(provider_display_name(provider))
            }
        }
    }

    fn effective_summary(&self) -> Option<&str> {
        match &self.source {
            DirectoryCandidateSource::Indexed { overlay, .. } => overlay.effective_summary,
            DirectoryCandidateSource::Synthesized { .. } => None,
        }
    }

    fn first_user_message(&self) -> Option<&str> {
        match &self.source {
            DirectoryCandidateSource::Indexed { row, .. } => row.first_user_message.as_deref(),
            DirectoryCandidateSource::Synthesized { .. } => None,
        }
    }

    fn is_subagent(&self) -> bool {
        match &self.source {
            DirectoryCandidateSource::Indexed { row, .. } => row.is_subagent,
            DirectoryCandidateSource::Synthesized { identity, .. } => {
                identity.is_subagent.unwrap_or(false)
            }
        }
    }

    fn is_non_interactive(&self) -> bool {
        match &self.source {
            DirectoryCandidateSource::Indexed { row, .. } => row.is_non_interactive,
            DirectoryCandidateSource::Synthesized { .. } => false,
        }
    }

    fn is_running(&self) -> bool {
        match &self.source {
            DirectoryCandidateSource::Indexed {
                running_identity, ..
            } => running_identity.is_some(),
            DirectoryCandidateSource::Synthesized { .. } => true,
        }
    }

    fn source_file(&self) -> Option<&Path> {
        match &self.source {
            DirectoryCandidateSource::Indexed { row, .. } => row.source_file.as_deref(),
            DirectoryCandidateSource::Synthesized { .. } => None,
        }
    }
}

fn compare_directory_order(
    left: DirectoryOrderKey<'_>,
    right: DirectoryOrderKey<'_>,
) -> Ordering {
    right
        .last_activity_at
        .cmp(&left.last_activity_at)
        .then_with(|| right.key.cmp(left.key))
}

fn candidate_is_strictly_after_cursor(
    candidate: &DirectoryCandidate<'_>,
    cursor: &DecodedCursor,
) -> bool {
    compare_directory_order(
        candidate.order_key(),
        DirectoryOrderKey {
            last_activity_at: cursor.last_activity_at,
            key: &cursor.key,
        },
    ) == Ordering::Greater
}

fn candidate_is_visible(candidate: &DirectoryCandidate<'_>, q: &DirQuery) -> bool {
    (q.include_subagents || !candidate.is_subagent())
        && (q.include_non_interactive || !candidate.is_non_interactive())
        && (q.include_empty
            || candidate.is_running()
            || candidate
                .effective_title()
                .map(str::trim)
                .is_some_and(|title| !title.is_empty()))
}

fn title_search_annotation(
    candidate: &DirectoryCandidate<'_>,
    lowercase_query: &str,
) -> Option<SearchAnnotation> {
    for (matched_in, field) in [
        ("title", candidate.effective_title()),
        ("summary", candidate.effective_summary()),
        ("firstUserMessage", candidate.first_user_message()),
    ] {
        let Some(field) = field else {
            continue;
        };
        if field.to_lowercase().contains(lowercase_query) {
            return Some(SearchAnnotation {
                matched_in: matched_in.to_string(),
                snippet: field.chars().take(140).collect(),
            });
        }
    }
    None
}

fn file_search_tier(tier: &Tier) -> Option<FileSearchTier> {
    match tier {
        Tier::Title => None,
        Tier::UserMessages => Some(FileSearchTier::UserMessages),
        Tier::FullText => Some(FileSearchTier::FullText),
    }
}
```

Continue directly to Step 2, part B without running or handing off; the shared tests also require the selector and materializer.

**Step 2, part B — Add the shared selector and sole full constructor, preserving deep-search order exactly.**

Add:

```rust
fn select_page_candidates<'a>(
    mut candidates: Vec<DirectoryCandidate<'a>>,
    q: &DirQuery,
    cursor: Option<&DecodedCursor>,
    limit: usize,
) -> CandidatePage<'a> {
    candidates.sort_by(|left, right| {
        compare_directory_order(left.order_key(), right.order_key())
    });
    let query = q
        .query
        .as_deref()
        .map(str::trim)
        .filter(|query| !query.is_empty());
    let lowercase_title_query = if query.is_some() && matches!(&q.tier, Tier::Title) {
        Some(query.expect("query exists").to_lowercase())
    } else {
        None
    };
    let mut rows = Vec::new();
    let mut partial = false;
    let mut partial_reason = None;
    let mut scanned_files = 0usize;
    let max_scan = limit * 10;

    for candidate in candidates {
        if !candidate_is_visible(&candidate, q) {
            continue;
        }
        if cursor.is_some_and(|cursor| {
            !candidate_is_strictly_after_cursor(&candidate, cursor)
        }) {
            continue;
        }

        let annotation = match (query, &q.tier) {
            (None, _) => None,
            (Some(_), Tier::Title) => {
                let Some(annotation) = title_search_annotation(
                    &candidate,
                    lowercase_title_query.as_deref().expect("lowercase title query"),
                ) else {
                    continue;
                };
                Some(annotation)
            }
            (Some(query), Tier::UserMessages | Tier::FullText) => {
                if rows.len() > limit {
                    break;
                }
                if scanned_files >= max_scan {
                    partial = true;
                    partial_reason = Some("budget");
                    break;
                }
                let Some(path) = candidate.source_file() else {
                    continue;
                };
                if !matches!(candidate.provider(), "claude" | "codex") {
                    continue;
                }
                scanned_files += 1;
                let tier = file_search_tier(&q.tier).expect("file search tier");
                match search_session_file(path, candidate.provider(), query, tier) {
                    Ok(Some(found)) => Some(SearchAnnotation {
                        matched_in: found.matched_in.to_string(),
                        snippet: found.snippet,
                    }),
                    Ok(None) => continue,
                    Err(_) => {
                        partial = true;
                        if partial_reason.is_none() {
                            partial_reason = Some("io_error");
                        }
                        continue;
                    }
                }
            }
        };
        rows.push(SelectedCandidate {
            candidate,
            annotation,
        });
    }

    CandidatePage {
        rows,
        partial,
        partial_reason,
    }
}

fn materialize_selected_candidate(
    selected: &SelectedCandidate<'_>,
    metadata: &HashMap<String, Value>,
) -> DirItem {
    match &selected.candidate.source {
        DirectoryCandidateSource::Indexed {
            row,
            overlay,
            running_identity,
        } => {
            let session_type = metadata
                .get(selected.candidate.key.as_ref())
                .and_then(Value::as_object)
                .and_then(|entry| entry.get("sessionType"))
                .and_then(Value::as_str)
                .filter(|session_type| !session_type.is_empty())
                .map(str::to_string);
            DirItem {
                session_id: row.session_id.clone(),
                provider: row.provider.clone(),
                project_path: row.project_path.clone(),
                title: overlay.effective_title.map(str::to_string),
                summary: overlay.effective_summary.map(str::to_string),
                first_user_message: row.first_user_message.clone(),
                last_activity_at: row.last_activity_at,
                created_at: row.created_at,
                cwd: row.cwd.clone(),
                is_subagent: row.is_subagent,
                is_non_interactive: row.is_non_interactive,
                is_running: running_identity.is_some(),
                archived: overlay.archived,
                matched_in: selected
                    .annotation
                    .as_ref()
                    .map(|annotation| annotation.matched_in.clone()),
                snippet: selected
                    .annotation
                    .as_ref()
                    .map(|annotation| annotation.snippet.clone()),
                running_terminal_id: running_identity
                    .map(|identity| identity.terminal_id.clone()),
                live_terminal_only: false,
                session_type,
                title_source: row.title_source.clone(),
                source_file: row.source_file.clone(),
            }
        }
        DirectoryCandidateSource::Synthesized {
            identity,
            provider,
            session_id,
        } => {
            let (session_id, live_terminal_only) = match session_id {
                SynthesizedSessionId::Existing(session_id) => {
                    ((*session_id).to_string(), false)
                }
                SynthesizedSessionId::TerminalFallback(terminal_id) => {
                    (format!("terminal:{terminal_id}"), true)
                }
            };
            let terminal_fallback = format!("terminal:{}", identity.terminal_id);
            DirItem {
                session_id,
                provider: (*provider).to_string(),
                project_path: identity
                    .cwd
                    .clone()
                    .unwrap_or_else(|| terminal_fallback.clone()),
                title: Some(provider_display_name(provider).to_string()),
                summary: None,
                first_user_message: None,
                last_activity_at: identity.updated_at,
                created_at: Some(identity.updated_at),
                cwd: identity.cwd.clone(),
                is_subagent: identity.is_subagent.unwrap_or(false),
                is_non_interactive: false,
                is_running: true,
                archived: false,
                matched_in: selected
                    .annotation
                    .as_ref()
                    .map(|annotation| annotation.matched_in.clone()),
                snippet: selected
                    .annotation
                    .as_ref()
                    .map(|annotation| annotation.snippet.clone()),
                running_terminal_id: Some(identity.terminal_id.clone()),
                live_terminal_only,
                session_type: Some((*provider).to_string()),
                title_source: None,
                source_file: None,
            }
        }
    }
}
```

Task 6 intentionally leaves no-search/title descriptor retention unbounded so Task 7 can observe RED full-preparation counts. Deep search retains current `limit + 1` and budget behavior.

Finish Step 2 by running:

```bash
run_logged task6-shared-green \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    'session_directory::page_bound_tests::shared_' -- \
    --color=never --test-threads=1
run_logged task6-winner-green \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    'session_directory::page_bound_tests::candidate_normalization_preserves_first_winner_from_supplied_identity_vector' -- \
    --exact --color=never --test-threads=1
```

Expected GREEN: shared filter executes 4 tests; winner filter executes 1; both commands exit 0. Step 2 now ends compiling and GREEN.

The typed decoder and intentionally unbounded candidate derivation in Step 6 are part of Phase A and must be completed immediately after Step 2, before the temporary differential. Steps 3-5 below are retained code-ready Phase-D migration references and must not be executed until the Phase-C handler-cutover commit is complete.

- [ ] **Step 3 (Phase-D reference): Add complete migration fixtures before changing existing tests.**

In `join_tests`, replace the `file_item` helper that returns `DirItem`. This is also a two-profile template. On the default borrowed profile, retain `indexed_file_item` from the fence but use these exact borrowed helper forms:

    fn materialize_test_candidate(candidate: DirectoryCandidate<'_>) -> DirItem {
        materialize_selected_candidate(
            &SelectedCandidate {
                candidate,
                annotation: None,
            },
            &HashMap::new(),
        )
    }

    fn overlaid_title(row: IndexedSession, override_value: Value) -> Option<String> {
        resolve_indexed_overlay(&row, Some(&override_value))
            .and_then(|overlay| overlay.effective_title.map(str::to_string))
    }

Only after fallback authorization replace those two borrowed helpers with the input-aware `materialize_test_candidate` and provenance-resolving `overlaid_title` shown in the existing Task-6 Rust fences below. Do not compile both representations or both helper definitions together.

```rust
    fn indexed_file_item(provider: &str, session_id: &str, title: Option<&str>) -> IndexedSession {
        IndexedSession {
            session_id: session_id.to_string(),
            provider: provider.to_string(),
            project_path: "/repo".to_string(),
            title: title.map(str::to_string),
            title_provider_generated: false,
            summary: None,
            first_user_message: None,
            title_source: None,
            last_activity_at: 100,
            created_at: Some(90),
            cwd: Some("/repo".to_string()),
            git_branch: None,
            is_subagent: false,
            is_non_interactive: false,
            source_file: None,
        }
    }

    fn materialize_test_candidate(
        candidate: DirectoryCandidate,
        indexed: &[IndexedSession],
        overrides: &Map<String, Value>,
        identities: &[TerminalIdentity],
    ) -> DirItem {
        let metadata = HashMap::new();
        materialize_selected_candidate(
            &SelectedCandidate {
                candidate,
                annotation: None,
            },
            DirectoryInputs {
                indexed,
                overrides,
                metadata: &metadata,
                identities,
            },
        )
    }
```

In the main `tests` module, move the existing directory-index import to the module top and add the scanner/helpers before migrated page tests:

```rust
    use freshell_sessions::directory_index::{ClaudeSource, SessionIndex, SessionSource};

    fn scan_indexed_claude_sessions(home: &Path) -> Vec<IndexedSession> {
        ClaudeSource::new(claude_home(home)).scan()
    }

    fn indexed_test_item(session_id: &str, at: i64, title: Option<&str>) -> IndexedSession {
        IndexedSession {
            session_id: session_id.to_string(),
            provider: "claude".to_string(),
            project_path: "/repo".to_string(),
            title: title.map(str::to_string),
            title_provider_generated: false,
            summary: None,
            first_user_message: None,
            title_source: None,
            last_activity_at: at,
            created_at: Some(at),
            cwd: Some("/repo".to_string()),
            git_branch: None,
            is_subagent: false,
            is_non_interactive: false,
            source_file: None,
        }
    }

    fn deep_search_indexed_item(
        session_id: &str,
        at: i64,
        source_file: Option<PathBuf>,
    ) -> IndexedSession {
        let mut row = indexed_test_item(session_id, at, Some("visible"));
        row.source_file = source_file;
        row
    }

    fn guard_row(title_source: Option<&str>, title: Option<&str>) -> IndexedSession {
        let mut row = indexed_test_item("guard", 100, title);
        row.title_source = title_source.map(str::to_string);
        row
    }

    fn overlaid_title(row: IndexedSession, override_value: Value) -> Option<String> {
        let overlay = resolve_indexed_overlay(&row, Some(&override_value))?;
        overlay
            .resolved_title(&row, Some(&override_value))
            .map(str::to_string)
    }
```

Step 6 adds `derive_test_page` immediately after `derive_directory_page` exists. It is a thin call to the sole production derivation, not an old-policy or full-item adapter. `list_claude_sessions` and `item_from_meta` remain only for their parser/index oracle tests and are never fed into `derive_directory_page`.

Compile the newly added scanner and fixture helpers before migrating tests:

```bash
run_logged task6-fixtures-no-run \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server --no-run
```

Expected GREEN: exit 0; `ClaudeSource`, parser/oracle imports, candidate fixtures, and existing tests all compile.

- [ ] **Step 4 (Phase-D reference): Migrate the display/join batch with the exact candidate pattern.**

Use the concrete replacement pattern below only on the fallback branch. On the borrowed branch retain the same candidate construction and use these exact final lines:

    assert!(candidates[0].is_running());
    let item = materialize_test_candidate(candidates.pop().expect("candidate"));
    assert_eq!(item.running_terminal_id.as_deref(), Some("terminal-1"));

The fallback form is:

```rust
    let indexed = indexed_file_item("claude", "s1", None);
    let registry = freshell_ws::identity::TerminalIdentityRegistry::new();
    registry.upsert(
        "terminal-1",
        Some("claude"),
        Some("s1"),
        Some("/repo"),
        200,
    );
    let identities = registry.list();
    let overrides = Map::new();
    let mut candidates = build_directory_candidates(
        std::slice::from_ref(&indexed),
        &overrides,
        &identities,
    );
    assert_eq!(candidates.len(), 1);
    let metadata = HashMap::new();
    let inputs = DirectoryInputs {
        indexed: std::slice::from_ref(&indexed),
        overrides: &overrides,
        metadata: &metadata,
        identities: &identities,
    };
    assert!(candidates[0].is_running(inputs));
    let item = materialize_test_candidate(
        candidates.pop().expect("candidate"),
        std::slice::from_ref(&indexed),
        &overrides,
        &identities,
    );
    assert_eq!(item.running_terminal_id.as_deref(), Some("terminal-1"));
```

Use `TerminalIdentityRegistry::new()`, `upsert`, and `list` for registry-backed fixtures. Where a current test already constructs a `TerminalIdentity` value directly to set `is_subagent`, retain that compiling fixture verbatim and bind `let identities = vec![identity];`; do not invent a constructor or change its values.

For every synthesized-row test on the fallback branch, replace the deleted helper call with this candidate/materializer sequence after the existing `identity` fixture:

```rust
    let identities = vec![identity];
    let overrides = Map::new();
    let mut candidates = build_directory_candidates(&[], &overrides, &identities);
    assert_eq!(candidates.len(), 1);
    let item = materialize_test_candidate(
        candidates.pop().expect("candidate"),
        &[],
        &overrides,
        &identities,
    );
```

On the borrowed branch, the exact synthesized materialization line is:

    let item = materialize_test_candidate(candidates.pop().expect("candidate"));

For a providerless identity, use the same first three lines and replace the last two lines with:

```rust
    assert!(candidates.is_empty());
```

Apply this exact per-test migration ledger; constructor arguments and existing field-level assertions remain byte-for-byte unchanged unless an assertion replacement is stated:

```text
join_running_state_matches_live_terminal_and_sets_running_fields
  Rename its Vec<DirItem> binding to `indexed`, change only `file_item` to
  `indexed_file_item`, and replace `join_running_state` with the complete
  indexed candidate block above. Retain the candidate `is_running()` and
  materialized `running_terminal_id == Some("terminal-1")` assertions.
join_running_state_no_match_leaves_not_running
  Make the same constructor/binding replacement, retain the existing
  nonmatching identity, build candidates once, assert one candidate,
  `!candidates[0].is_running()`, then materialize and assert
  `running_terminal_id.is_none()`.
build_live_terminal_session_item_none_without_a_provider
  Retain the existing providerless identity fixture and use the providerless
  sequence above; assert the candidate vector is empty.
build_live_terminal_session_item_with_session_id_is_not_live_terminal_only
  Retain the identity fixture and use the synthesized-row sequence above;
  keep every existing session id, provider, project path, title, activity,
  running-terminal id, live-terminal-only, and session-type assertion.
live_terminal_item_mirrors_identity_subagent_flag
  Run the synthesized-row sequence separately for the retained `Some(true)`
  and `None` identity fixtures; keep both existing `to_value()["isSubagent"]`
  assertions.
build_live_terminal_session_item_without_session_id_is_live_terminal_only
  Retain the no-session identity and use the synthesized-row sequence; keep
  the existing exact fallback session-id assertion, fallback project path,
  provider display title, running terminal id, `live_terminal_only`, and
  session type assertions.
join_live_terminals_matched_session_yields_one_running_item
  Rename its indexed vector and constructor as in the first migration, retain
  the exact matching identity, build once, assert one candidate, materialize,
  and keep all running field assertions.
join_live_terminals_unmatched_terminal_synthesizes_one_live_only_item
  Retain the identity, use empty indexed input and the synthesized-row
  sequence, then keep all synthesized/live-only field assertions.
join_live_terminals_matched_terminal_is_never_double_emitted
  Rename its indexed vector and constructor, retain the matching identity,
  call `build_directory_candidates`, and replace the old joined-vector count
  assertion with `assert_eq!(candidates.len(), 1)`.
codex_fresh_terminal_pre_adoption_duplicate_is_transient_pending_locator_adoption
  Rename its indexed vector and constructor, retaining provider `codex`; retain
  the no-session Codex identity, call `build_directory_candidates`, and replace
  the old joined-vector count assertion with `assert_eq!(candidates.len(), 2)`.
```

No migrated join test may call a compatibility wrapper that returns a full vector of `DirItem`; only the selected candidate under assertion is passed to `materialize_test_candidate`.

The display-helper test was already migrated in Task 5. After this batch, run:

```bash
run_logged task6-join-no-run \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server --no-run
run_logged task6-join-batch \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    'session_directory::join_tests' -- \
    --color=never --test-threads=1
```

Expected GREEN: `--no-run` exits 0; the join module executes a positive count with zero failures.

- [ ] **Step 5 (Phase-D reference): Migrate narrow override tests and all seven transitive guard tests.**

Use `resolve_indexed_overlay` directly for effective-field policy. For wire assertions, use `derive_test_page` after Step 6 adds `derive_directory_page`. Before Step 6, migrate and run only the direct resolver cases.

Exact resolver pattern on the fallback branch; on the borrowed branch retain the direct `effective_title`/`effective_summary` field assertions:

```rust
    let row = guard_row(Some("provider-generated"), Some("provider title"));
    let override_value = json!({
        "titleOverride": "suppressed",
        "titleSource": "dir",
        "summaryOverride": "summary",
        "archived": true
    });
    let overlay =
        resolve_indexed_overlay(&row, Some(&override_value)).expect("surviving overlay");
    assert_eq!(
        overlay.resolved_title(&row, Some(&override_value)),
        Some("provider title")
    );
    assert_eq!(
        overlay.resolved_summary(&row, Some(&override_value)),
        Some("summary")
    );
    assert!(overlay.archived);
```

Migrate these direct override tests:

```text
overrides_overlay_applies_title_summary_archived_and_filters_deleted
  -> two IndexedSession rows; resolver asserts deletion/effective fields; Step 8 derives retained wire JSON
overlay_shape_unchanged_when_no_overrides_archived_always_present
  -> Step 8 derives one row and asserts archived:false plus title
suppressed_title_row_still_overlays_summary_and_archived
  -> resolver asserts effective title, summary, archived
title_tier_search_matches_a_renamed_sessions_override_title
  -> Step 8 derives with override map and title query; this is also apply_query obligation 15
```

Replace `guard_item` with `guard_row`, replace `overlaid_title` with the complete helper from Step 3, and migrate these seven transitive tests to construct `IndexedSession`:

```text
provider_generated_session_suppresses_dir_override_row
provider_generated_session_suppresses_first_message_override_row
provider_generated_session_still_applies_ai_override_row
provider_generated_session_still_applies_user_override_row
provider_generated_session_still_applies_absent_source_override_row
empty_string_title_override_never_applies
non_provider_generated_session_still_applies_dir_override_row
```

Compile the complete test target, then run the resolver/transitive batch exactly:

```bash
run_logged task6-resolver-no-run \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server --no-run
for test_name in \
  suppressed_title_row_still_overlays_summary_and_archived \
  provider_generated_session_suppresses_dir_override_row \
  provider_generated_session_suppresses_first_message_override_row \
  provider_generated_session_still_applies_ai_override_row \
  provider_generated_session_still_applies_user_override_row \
  provider_generated_session_still_applies_absent_source_override_row \
  empty_string_title_override_never_applies \
  non_provider_generated_session_still_applies_dir_override_row
do
  run_logged "task6-resolver-$test_name" \
    env CARGO_TERM_COLOR=never \
    cargo test --manifest-path "$MANIFEST" \
      -p freshell-server --bin freshell-server \
      "session_directory::tests::$test_name" -- \
      --exact --color=never --test-threads=1
done
```

Expected GREEN: `--no-run` exits 0 and each of the eight exact filters reports `1 passed`.

- [ ] **Step 6 (execute immediately after Step 2): Change the decoder return type, adapt its only tuple consumer, and add the intentionally unbounded derivation in one compiling checkpoint.**

Replace `decode_cursor` in place with:

```rust
fn decode_cursor(cursor: &str) -> Result<DecodedCursor, String> {
    let bytes = URL_SAFE_NO_PAD
        .decode(cursor)
        .map_err(|_| "Invalid session-directory cursor".to_string())?;
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "Invalid session-directory cursor".to_string())?;
    let last_activity_at = value
        .get("lastActivityAt")
        .and_then(Value::as_i64)
        .ok_or_else(|| "Invalid session-directory cursor".to_string())?;
    let key = value
        .get("key")
        .and_then(Value::as_str)
        .filter(|key| !key.is_empty())
        .ok_or_else(|| "Invalid session-directory cursor".to_string())?
        .to_string();
    Ok(DecodedCursor {
        last_activity_at,
        key,
    })
}
```

In the still-temporary old `apply_query`, atomically replace tuple destructuring with this compiling typed adaptation:

```rust
    if let Some(cursor) = cursor.as_ref() {
        items.retain(|item| {
            item.last_activity_at < cursor.last_activity_at
                || (item.last_activity_at == cursor.last_activity_at
                    && item.key().as_str() < cursor.key.as_str())
        });
    }
```

Add the behavior-equivalent, intentionally unbounded derivation:

```rust
fn derive_directory_page(
    inputs: DirectoryInputs<'_>,
    q: &DirQuery,
) -> Result<Value, String> {
    let limit = q
        .limit
        .unwrap_or(MAX_DIRECTORY_PAGE_ITEMS)
        .min(MAX_DIRECTORY_PAGE_ITEMS);
    let cursor = q.cursor.as_deref().map(decode_cursor).transpose()?;
    let candidates = build_directory_candidates(
        inputs.indexed,
        inputs.overrides,
        inputs.identities,
    );
    let revision = candidates
        .iter()
        .map(|candidate| candidate.order_key().last_activity_at)
        .chain(inputs.identities.iter().map(|identity| identity.updated_at))
        .max()
        .unwrap_or(0)
        .max(0);
    let selected = select_page_candidates(candidates, q, cursor.as_ref(), limit);
    let materialized: Vec<DirItem> = selected
        .rows
        .iter()
        .map(|selected| materialize_selected_candidate(selected, inputs.metadata))
        .collect();
    let has_more = selected.rows.len() > limit;
    let next_cursor = has_more.then(|| {
        let tail = selected.rows[limit - 1].candidate.order_key();
        encode_cursor(tail.last_activity_at, tail.key)
    });
    let items = materialized
        .iter()
        .take(limit)
        .map(DirItem::to_value)
        .collect::<Vec<_>>();
    let mut page = json!({
        "items": items,
        "nextCursor": next_cursor,
        "revision": revision,
    });
    if selected.partial {
        page["partial"] = Value::Bool(true);
        if let Some(reason) = selected.partial_reason {
            page["partialReason"] = Value::String(reason.to_string());
        }
    }
    Ok(page)
}
```

#### Phase B: Add one temporary 516-comparison differential and commit the reversible proof checkpoint

The route remains on eager composition in this phase. `derive_eager_oracle_page` directly composes the old full-item override, metadata, live-join, and query helpers and never calls candidate normalization, selection, or materialization:

```rust
#[cfg(test)]
fn derive_eager_oracle_page(
    indexed: &[IndexedSession],
    overrides: &Map<String, Value>,
    metadata: &HashMap<String, Value>,
    identities: &[TerminalIdentity],
    query: &DirQuery,
) -> Result<Value, String> {
    let items = indexed.iter().map(dir_item_from_indexed).collect();
    let items = apply_session_overrides(items, overrides);
    let items = apply_session_metadata(items, metadata);
    let items = join_live_terminals(items, identities);
    apply_query(items, query, identities)
}
```

The typed cursor adaptation is separately guarded by the already-GREEN cursor characterizations. The frozen `search_session_file` primitive and `DirItem::to_value` serializer are separately guarded by the deep-search and exact-wire tests. This differential independently covers candidate normalization, order, visibility, cursor relation, search traversal, and materialization composition; it does not claim to reimplement those frozen primitives.

Add this complete deterministic helper set inside `page_bound_tests`. Mandatory archetypes are inserted before Fisher-Yates permutation. The supplied identity vector is explicit and is never sorted:

```rust
    struct DifferentialFixture {
        _home: tempfile::TempDir,
        indexed: Vec<IndexedSession>,
        overrides: Map<String, Value>,
        metadata: HashMap<String, Value>,
        identities: Vec<TerminalIdentity>,
    }

    struct DeterministicLcg(u64);

    impl DeterministicLcg {
        fn new(seed: u64) -> Self {
            Self(seed)
        }

        fn next_u64(&mut self) -> u64 {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            self.0
        }

        fn permute<T>(&mut self, values: &mut [T]) {
            for upper in (1..values.len()).rev() {
                let selected = (self.next_u64() as usize) % (upper + 1);
                values.swap(upper, selected);
            }
        }
    }

    const DIFFERENTIAL_SEEDS: [u64; 2] = [0x5EED_0001_u64, 0x5EED_0002_u64];

    fn seeded_differential_fixture(seed: u64) -> DifferentialFixture {
        let home = tempfile::tempdir().expect("differential home");
        let write_transcript = |name: &str, user: &str, assistant: &str| {
            let path = home.path().join(format!("{name}.jsonl"));
            std::fs::write(
                &path,
                format!(
                    "{{\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":\"{user}\"}}}}\n\
                     {{\"type\":\"assistant\",\"message\":{{\"role\":\"assistant\",\"content\":\"{assistant}\"}}}}\n"
                ),
            )
            .expect("write transcript");
            path
        };
        let user_hit = write_transcript("user-hit", "needle-user", "ordinary");
        let assistant_hit = write_transcript("assistant-hit", "ordinary", "needle-assistant");
        let no_hit = write_transcript("no-hit", "ordinary", "ordinary");
        let missing = home.path().join("missing.jsonl");

        let mut indexed = vec![
            provider_row("claude", "ordinary", 900, Some("ordinary")),
            provider_row("claude", "duplicate", 800, Some("duplicate")),
            provider_row("claude", "duplicate", 800, Some("duplicate")),
            provider_row("claude", "deleted", 700, Some("deleted")),
            provider_row("claude", "deleted-live", 690, Some("deleted live")),
            provider_row("claude", "override-title", 680, Some("raw")),
            provider_row("claude", "override-summary", 670, Some("raw")),
            provider_row("claude", "provider-generated", 660, Some("provider title")),
            provider_row("claude", "empty-override", 650, Some("raw")),
            provider_row("claude", "empty", 640, None),
            provider_row("claude", "whitespace", 630, Some("   ")),
            provider_row("claude", "running-empty", 620, None),
            provider_row("claude", "title-hit", 610, Some("needle-title")),
            provider_row("claude", "summary-hit", 600, Some("visible")),
            provider_row("claude", "first-hit", 590, Some("visible")),
            provider_row("claude", "user-hit", 580, Some("visible")),
            provider_row("claude", "assistant-hit", 570, Some("visible")),
            provider_row("claude", "no-hit", 560, Some("visible")),
            provider_row("claude", "missing-source", 550, Some("visible")),
            provider_row("other", "unsupported", 540, Some("visible")),
            provider_row("claude", "no-source", 530, Some("visible")),
            provider_row("claude", "negative", -5, Some("visible")),
        ];
        indexed[12].summary = Some("needle-summary".into());
        indexed[13].summary = Some("needle-summary".into());
        indexed[14].first_user_message = Some("needle-first".into());
        indexed[15].source_file = Some(user_hit);
        indexed[16].source_file = Some(assistant_hit);
        indexed[17].source_file = Some(no_hit);
        indexed[18].source_file = Some(missing);
        indexed[19].source_file = Some(home.path().join("unsupported.jsonl"));
        indexed[20].source_file = None;
        indexed[9].is_subagent = true;
        indexed[10].is_non_interactive = true;
        indexed[7].title_source = Some("provider-generated".into());

        let mut overrides = Map::new();
        overrides.insert("claude:deleted".into(), json!({"deleted": true}));
        overrides.insert("claude:deleted-live".into(), json!({"deleted": true}));
        overrides.insert(
            "claude:override-title".into(),
            json!({"titleOverride": "needle-title-override", "titleSource": "user"}),
        );
        overrides.insert(
            "claude:override-summary".into(),
            json!({"summaryOverride": "needle-summary-override", "archived": true}),
        );
        overrides.insert(
            "claude:provider-generated".into(),
            json!({"titleOverride": "suppressed", "titleSource": "dir"}),
        );
        overrides.insert("claude:empty-override".into(), json!({"titleOverride": ""}));

        let mut metadata = HashMap::new();
        metadata.insert("claude:ordinary".into(), json!({"sessionType": "claude"}));
        metadata.insert("claude:duplicate".into(), json!({}));

        let registry = freshell_ws::identity::TerminalIdentityRegistry::new();
        registry.upsert("z-exact-first", Some("claude"), Some("running-empty"), Some("/running"), 1_100);
        registry.upsert("a-exact-second", Some("claude"), Some("running-empty"), Some("/second"), 1_101);
        registry.upsert("y-alias-first", Some("a"), Some("b:c"), Some("/alias-first"), 1_102);
        registry.upsert("b-alias-second", Some("a:b"), Some("c"), Some("/alias-second"), 1_103);
        registry.upsert("deleted-resynth", Some("claude"), Some("deleted-live"), Some("/live"), 1_104);
        registry.upsert("providerless", None, Some("ignored"), Some("/ignored"), 1_105);
        registry.upsert("live-fallback", Some("claude"), None, None, 1_106);
        let mut identities = [
            "z-exact-first",
            "a-exact-second",
            "y-alias-first",
            "b-alias-second",
            "deleted-resynth",
            "providerless",
            "live-fallback",
        ]
        .into_iter()
        .map(|id| registry.get(id).expect("identity"))
        .collect::<Vec<_>>();

        let mut random = DeterministicLcg::new(seed);
        random.permute(&mut indexed);
        random.permute(&mut identities);
        DifferentialFixture {
            _home: home,
            indexed,
            overrides,
            metadata,
            identities,
        }
    }

    fn differential_visibility_cases() -> [(bool, bool, bool); 8] {
        [
            (false, false, false),
            (false, false, true),
            (false, true, false),
            (false, true, true),
            (true, false, false),
            (true, false, true),
            (true, true, false),
            (true, true, true),
        ]
    }

    fn differential_query_cases() -> [(Option<&'static str>, Tier); 8] {
        [
            (None, Tier::Title),
            (Some("   "), Tier::Title),
            (Some("needle-title"), Tier::Title),
            (Some("absent-title"), Tier::Title),
            (Some("needle-user"), Tier::UserMessages),
            (Some("needle-assistant"), Tier::UserMessages),
            (Some("needle-assistant"), Tier::FullText),
            (Some("absent-transcript"), Tier::FullText),
        ]
    }

    fn differential_limits() -> [usize; 2] {
        [1, 2]
    }

    fn differential_cursors() -> [Option<String>; 2] {
        [None, Some(encode_cursor(650, "claude:empty-override"))]
    }

    fn fixed_deep_partial_cases() -> Vec<(DifferentialFixture, DirQuery, &'static str)> {
        let mut io_only = seeded_differential_fixture(DIFFERENTIAL_SEEDS[0]);
        io_only.indexed.retain(|row| row.session_id == "missing-source");
        let mut io_budget = seeded_differential_fixture(DIFFERENTIAL_SEEDS[1]);
        io_budget.indexed.retain(|row| {
            matches!(row.session_id.as_str(), "missing-source" | "no-hit" | "ordinary")
        });
        while io_budget.indexed.len() < 11 {
            let mut row = provider_row(
                "claude",
                &format!("budget-{}", io_budget.indexed.len()),
                500 - io_budget.indexed.len() as i64,
                Some("visible"),
            );
            row.source_file = io_budget
                .indexed
                .iter()
                .find(|candidate| candidate.session_id == "no-hit")
                .and_then(|candidate| candidate.source_file.clone());
            io_budget.indexed.push(row);
        }
        let mut budget_tail = seeded_differential_fixture(DIFFERENTIAL_SEEDS[0]);
        budget_tail.indexed.retain(|row| row.session_id == "no-hit");
        while budget_tail.indexed.len() < 10 {
            let mut row = budget_tail.indexed[0].clone();
            row.session_id = format!("budget-tail-{}", budget_tail.indexed.len());
            budget_tail.indexed.push(row);
        }
        budget_tail.indexed.push(provider_row("claude", "no-source-tail", 1, Some("visible")));
        let mut lookahead = seeded_differential_fixture(DIFFERENTIAL_SEEDS[1]);
        lookahead.indexed.retain(|row| {
            matches!(row.session_id.as_str(), "user-hit" | "missing-source" | "no-hit")
        });
        let mut second_hit = lookahead
            .indexed
            .iter()
            .find(|row| row.session_id == "user-hit")
            .expect("first lookahead hit")
            .clone();
        second_hit.session_id = "user-hit-lookahead".into();
        second_hit.last_activity_at = 570;
        lookahead.indexed.push(second_hit);
        let query = || DirQuery {
            query: Some("needle-user".into()),
            tier: Tier::UserMessages,
            limit: Some(1),
            include_subagents: true,
            include_non_interactive: true,
            include_empty: true,
            ..DirQuery::default()
        };
        vec![
            (io_only, query(), "io-only"),
            (io_budget, query(), "io-then-budget"),
            (budget_tail, query(), "budget-before-no-source"),
            (lookahead, query(), "lookahead-before-later-partial"),
        ]
    }
```

The two seeds and the exact helper cardinalities produce `2 * 8 * 8 * 2 * 2 = 512` cross-product comparisons; the same four fixed deep-partial cases bring the sole temporary oracle to exactly 516. Do not add another seed, case axis, fixed case, or differential test.

Add the one temporary test:

```rust
    #[test]
    fn candidate_path_matches_eager_oracle_across_seeded_cross_product() {
        let mut comparisons = 0usize;
        for seed in DIFFERENTIAL_SEEDS {
            let fixture = seeded_differential_fixture(seed);
            for (include_subagents, include_non_interactive, include_empty) in
                differential_visibility_cases()
            {
                for (query, tier) in differential_query_cases() {
                    for limit in differential_limits() {
                        for cursor in differential_cursors() {
                            let query_value = DirQuery {
                                query: query.map(str::to_string),
                                tier,
                                limit: Some(limit),
                                cursor,
                                include_subagents,
                                include_non_interactive,
                                include_empty,
                                ..DirQuery::default()
                            };
                            let label = format!(
                                "seed={seed:x}/flags={include_subagents},{include_non_interactive},{include_empty}/query={query:?}/{tier:?}/limit={limit}/cursor={:?}",
                                query_value.cursor
                            );
                            let eager = derive_eager_oracle_page(
                                &fixture.indexed,
                                &fixture.overrides,
                                &fixture.metadata,
                                &fixture.identities,
                                &query_value,
                            )
                            .expect("eager page");
                            let candidate = derive_directory_page(
                                DirectoryInputs {
                                    indexed: &fixture.indexed,
                                    overrides: &fixture.overrides,
                                    metadata: &fixture.metadata,
                                    identities: &fixture.identities,
                                },
                                &query_value,
                            )
                            .expect("candidate page");
                            assert_eq!(candidate, eager, "case={label}");
                            assert_eq!(
                                serde_json::to_vec(&candidate).expect("candidate bytes"),
                                serde_json::to_vec(&eager).expect("eager bytes"),
                                "serialized case={label}",
                            );
                            comparisons += 1;
                        }
                    }
                }
            }
        }
        for (fixture, query, label) in fixed_deep_partial_cases() {
            let eager = derive_eager_oracle_page(
                &fixture.indexed,
                &fixture.overrides,
                &fixture.metadata,
                &fixture.identities,
                &query,
            )
            .expect("eager page");
            let candidate = derive_directory_page(
                DirectoryInputs {
                    indexed: &fixture.indexed,
                    overrides: &fixture.overrides,
                    metadata: &fixture.metadata,
                    identities: &fixture.identities,
                },
                &query,
            )
            .expect("candidate page");
            assert_eq!(candidate, eager, "case={label}");
            assert_eq!(
                serde_json::to_vec(&candidate).expect("candidate bytes"),
                serde_json::to_vec(&eager).expect("eager bytes"),
                "serialized case={label}",
            );
            comparisons += 1;
        }
        assert_eq!(comparisons, 516);
        println!("differential comparisons: 516");
    }
```

Run the temporary differential, all 21 temporary page-bound tests, and the focused family while the production route remains eager:

```bash
run_logged task6-seeded-differential \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    'session_directory::page_bound_tests::candidate_path_matches_eager_oracle_across_seeded_cross_product' -- \
    --exact --color=never --test-threads=1 --nocapture
test "$(grep -Fc 'differential comparisons: 516' \
  "$LOG_ROOT/task6-seeded-differential.log")" -eq 1
run_logged task6-temporary-page-bound \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    'session_directory::page_bound_tests' -- --color=never --test-threads=1
grep -F '21 passed' "$LOG_ROOT/task6-temporary-page-bound.log"
run_logged task6-staged-session-directory \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    session_directory -- --color=never --test-threads=1
git -C "$WT" diff --check
git -C "$WT" add -- "$SOURCE_REL"
test "$(git -C "$WT" diff --cached --name-only)" = "$SOURCE_REL"
git -C "$WT" commit \
  -m "refactor(session-directory): stage candidate policy for differential" \
  -m "Add candidate derivation beside the eager route and prove exact page and byte equality over the deterministic 516-case cross-product." \
  -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)" \
  -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
TASK6_PROOF_COMMIT=$(git -C "$WT" rev-parse HEAD)
printf '%s\n' "$TASK6_PROOF_COMMIT" | tee "$LOG_ROOT/task6-proof-commit.txt"
```

Expected GREEN: exactly one differential test, one marker, `21 passed` for the temporary module, positive focused count, and one source-only commit. The route is still eager.

#### Phase C: Compile the actual handler, apply only the exact conditional fallback if needed, and commit cutover

Replace only the real handler composition with this order while eager helpers and the temporary differential still exist:

```rust
    let snapshot: Option<Arc<Vec<IndexedSession>>> = match &state.session_index {
        Some(index) => Some(index.snapshot().await),
        None => None,
    };
    let overrides = state.settings.session_overrides();
    let metadata = state.metadata.get_all().await;
    let identities = state.identity.list();
    let result = {
        let indexed = snapshot
            .as_deref()
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        derive_directory_page(
            DirectoryInputs {
                indexed,
                overrides: &overrides,
                metadata: &metadata,
                identities: &identities,
            },
            &query,
        )
    };
    drop(snapshot);

    match result {
        Ok(mut page) => {
            let project_colors = state.settings.project_colors();
            if !project_colors.is_empty() {
                page["projectColors"] = json!(project_colors);
            }
            Json(page).into_response()
        }
        Err(_) => (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "Invalid session-directory cursor"})),
        )
            .into_response(),
    }
```

`indexed` is created after the final await, lives only in the synchronous block, and is dead before `drop(snapshot)`. The drop precedes project colors and response conversion. Identities remain in captured order.

```bash
if run_logged task6-hardened-handler-check \
  env CARGO_TERM_COLOR=never \
  cargo check --manifest-path "$MANIFEST" \
    --message-format=json \
    -p freshell-server --bin freshell-server
then
  TASK6_HANDLER_CHECK_STATUS=0
else
  TASK6_HANDLER_CHECK_STATUS=$?
fi
if run_logged task6-hardened-handler-test-no-run \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    --message-format=json \
    -p freshell-server --bin freshell-server --no-run
then
  TASK6_HANDLER_NO_RUN_STATUS=0
else
  TASK6_HANDLER_NO_RUN_STATUS=$?
fi

TASK6_FALLBACK_REQUIRED=0
if [[ "$TASK6_HANDLER_CHECK_STATUS" -ne 0 \
   || "$TASK6_HANDLER_NO_RUN_STATUS" -ne 0 ]]; then
  if [[ "$TASK6_HANDLER_CHECK_STATUS" -ne 0 ]]; then
    classify_task6_handler_failure \
      task6-hardened-handler-check "$TASK6_HANDLER_CHECK_STATUS"
  fi
  if [[ "$TASK6_HANDLER_NO_RUN_STATUS" -ne 0 ]]; then
    classify_task6_handler_failure \
      task6-hardened-handler-test-no-run "$TASK6_HANDLER_NO_RUN_STATUS"
  fi
  TASK6_FALLBACK_REQUIRED=1
fi
printf 'fallback_required=%s\n' "$TASK6_FALLBACK_REQUIRED" \
  | tee "$LOG_ROOT/task6-fallback-decision.txt"
```

Both commands compile the actual Axum handler and capture status without letting `set -e` preempt classification. If `TASK6_FALLBACK_REQUIRED=1`, implement only the already-specified reference-free index/provenance profile before continuing; if it is `0`, changing candidate representation is forbidden. The classifier does not authorize import, syntax, fixture, assertion, or unrelated diagnostics. Candidate-helper compilation while the route remains eager is insufficient.

Fallback is permitted only for a relevant rustc candidate lifetime, move/self-reference, or Axum future-`Send` error after applying the exact block above. Import, syntax, fixture, assertion, or unrelated errors do not authorize it. The implementation worker uses the following fence only when both compiler statuses have been captured and the classifier authorizes fallback. If fallback is not authorized, none of this replacement is applied to source.

The fence is the complete Phase-C source profile. Atomically replace the default block beginning at `#[derive(Clone, Copy)] struct DirectoryInputs<'a>` through `file_search_tier`, then replace `select_page_candidates`, `materialize_selected_candidate`, and the Phase-A unbounded `derive_directory_page` with the definitions below. `DirQuery`, `DirItem`, `encode_cursor`, `decode_cursor`, `provider_display_name`, `record_preparation`, and frozen search/serializer primitives remain single definitions. The indexed overlay stores provenance only; all returned values are re-resolved from the same immutable `DirectoryInputs`. The materializer receives those inputs, so every index can be resolved without owned corpus rows or hidden ambient state.

```rust
#[derive(Clone, Copy)]
struct DirectoryInputs<'a> {
    indexed: &'a [IndexedSession],
    overrides: &'a Map<String, Value>,
    metadata: &'a HashMap<String, Value>,
    identities: &'a [TerminalIdentity],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum IndexedValueSource {
    Absent,
    Row,
    Override,
}

#[derive(Clone, Copy, Debug)]
struct IndexedOverlayIndex {
    title_source: IndexedValueSource,
    summary_source: IndexedValueSource,
    archived: bool,
}

impl IndexedOverlayIndex {
    fn resolved_title<'a>(
        &self,
        row: &'a IndexedSession,
        override_value: Option<&'a Value>,
    ) -> Option<&'a str> {
        match self.title_source {
            IndexedValueSource::Absent => None,
            IndexedValueSource::Row => row.title.as_deref(),
            IndexedValueSource::Override => override_value
                .and_then(Value::as_object)
                .and_then(|entry| entry.get("titleOverride"))
                .and_then(Value::as_str),
        }
    }

    fn resolved_summary<'a>(
        &self,
        row: &'a IndexedSession,
        override_value: Option<&'a Value>,
    ) -> Option<&'a str> {
        match self.summary_source {
            IndexedValueSource::Absent => None,
            IndexedValueSource::Row => row.summary.as_deref(),
            IndexedValueSource::Override => override_value
                .and_then(Value::as_object)
                .and_then(|entry| entry.get("summaryOverride"))
                .and_then(Value::as_str),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SynthesizedSessionIdSource {
    IdentitySessionId,
    TerminalId,
}

#[derive(Clone, Copy, Debug)]
enum DirectoryCandidateSource {
    Indexed {
        row_index: usize,
        overlay: IndexedOverlayIndex,
        running_identity_index: Option<usize>,
    },
    Synthesized {
        identity_index: usize,
        session_id_source: SynthesizedSessionIdSource,
    },
}

#[derive(Debug)]
struct DirectoryCandidate {
    key: Arc<str>,
    source: DirectoryCandidateSource,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DirectoryOrderKey<'a> {
    last_activity_at: i64,
    key: &'a str,
}

#[derive(Debug, PartialEq, Eq)]
struct DecodedCursor {
    last_activity_at: i64,
    key: String,
}

#[derive(Debug, PartialEq, Eq)]
struct SearchAnnotation {
    matched_in: String,
    snippet: String,
}

#[derive(Debug)]
struct SelectedCandidate {
    candidate: DirectoryCandidate,
    annotation: Option<SearchAnnotation>,
}

#[derive(Debug)]
struct CandidatePage {
    rows: Vec<SelectedCandidate>,
    partial: bool,
    partial_reason: Option<&'static str>,
}

fn resolve_indexed_overlay(
    row: &IndexedSession,
    override_value: Option<&Value>,
) -> Option<IndexedOverlayIndex> {
    let Some(override_row) = override_value.and_then(Value::as_object) else {
        return Some(IndexedOverlayIndex {
            title_source: if row.title.is_some() {
                IndexedValueSource::Row
            } else {
                IndexedValueSource::Absent
            },
            summary_source: if row.summary.is_some() {
                IndexedValueSource::Row
            } else {
                IndexedValueSource::Absent
            },
            archived: false,
        });
    };
    if override_row.get("deleted").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let suppress_title_override = row.title_source.as_deref() == Some("provider-generated")
        && matches!(
            override_row.get("titleSource").and_then(Value::as_str),
            Some("dir" | "first-message")
        );
    let title_source = if override_row
        .get("titleOverride")
        .and_then(Value::as_str)
        .is_some_and(|title| !title.is_empty() && !suppress_title_override)
    {
        IndexedValueSource::Override
    } else if row.title.is_some() {
        IndexedValueSource::Row
    } else {
        IndexedValueSource::Absent
    };
    let summary_source = if override_row
        .get("summaryOverride")
        .and_then(Value::as_str)
        .is_some()
    {
        IndexedValueSource::Override
    } else if row.summary.is_some() {
        IndexedValueSource::Row
    } else {
        IndexedValueSource::Absent
    };
    Some(IndexedOverlayIndex {
        title_source,
        summary_source,
        archived: override_row
            .get("archived")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

fn first_identity_by_exact_session<'a>(
    identities: &'a [TerminalIdentity],
) -> HashMap<(&'a str, &'a str), usize> {
    let mut first = HashMap::new();
    for (index, identity) in identities.iter().enumerate() {
        if let (Some(provider), Some(session_id)) =
            (identity.provider.as_deref(), identity.session_id.as_deref())
        {
            first.entry((provider, session_id)).or_insert(index);
        }
    }
    first
}

fn build_directory_candidates(
    indexed: &[IndexedSession],
    overrides: &Map<String, Value>,
    identities: &[TerminalIdentity],
) -> Vec<DirectoryCandidate> {
    let first_live = first_identity_by_exact_session(identities);
    let mut existing_keys: HashSet<Arc<str>> = HashSet::new();
    let mut candidates = Vec::with_capacity(indexed.len() + identities.len());
    for (row_index, row) in indexed.iter().enumerate() {
        let key: Arc<str> =
            Arc::from(format!("{}:{}", row.provider, row.session_id).into_boxed_str());
        let Some(overlay) = resolve_indexed_overlay(row, overrides.get(key.as_ref())) else {
            continue;
        };
        let running_identity_index = first_live
            .get(&(row.provider.as_str(), row.session_id.as_str()))
            .copied();
        existing_keys.insert(Arc::clone(&key));
        candidates.push(DirectoryCandidate {
            key,
            source: DirectoryCandidateSource::Indexed {
                row_index,
                overlay,
                running_identity_index,
            },
        });
    }
    for (identity_index, identity) in identities.iter().enumerate() {
        let Some(provider) = identity.provider.as_deref() else {
            continue;
        };
        let (session_id, session_id_source) = match identity.session_id.as_deref() {
            Some(session_id) => (session_id, SynthesizedSessionIdSource::IdentitySessionId),
            None => (
                identity.terminal_id.as_str(),
                SynthesizedSessionIdSource::TerminalId,
            ),
        };
        let key: Arc<str> = Arc::from(match session_id_source {
            SynthesizedSessionIdSource::IdentitySessionId => {
                format!("{provider}:{session_id}").into_boxed_str()
            }
            SynthesizedSessionIdSource::TerminalId => {
                format!("{provider}:terminal:{session_id}").into_boxed_str()
            }
        });
        if !existing_keys.insert(Arc::clone(&key)) {
            continue;
        }
        candidates.push(DirectoryCandidate {
            key,
            source: DirectoryCandidateSource::Synthesized {
                identity_index,
                session_id_source,
            },
        });
    }
    candidates
}

impl DirectoryCandidate {
    fn order_key<'a>(&'a self, inputs: DirectoryInputs<'_>) -> DirectoryOrderKey<'a> {
        DirectoryOrderKey {
            last_activity_at: match self.source {
                DirectoryCandidateSource::Indexed { row_index, .. } => {
                    inputs.indexed[row_index].last_activity_at
                }
                DirectoryCandidateSource::Synthesized { identity_index, .. } => {
                    inputs.identities[identity_index].updated_at
                }
            },
            key: &self.key,
        }
    }

    fn provider<'a>(&self, inputs: DirectoryInputs<'a>) -> &'a str {
        match self.source {
            DirectoryCandidateSource::Indexed { row_index, .. } => {
                &inputs.indexed[row_index].provider
            }
            DirectoryCandidateSource::Synthesized { identity_index, .. } => inputs.identities
                [identity_index]
                .provider
                .as_deref()
                .expect("synthesized candidate provider"),
        }
    }

    fn effective_title<'a>(&self, inputs: DirectoryInputs<'a>) -> Option<&'a str> {
        match self.source {
            DirectoryCandidateSource::Indexed {
                row_index, overlay, ..
            } => overlay.resolved_title(
                &inputs.indexed[row_index],
                inputs.overrides.get(self.key.as_ref()),
            ),
            DirectoryCandidateSource::Synthesized { .. } => {
                Some(provider_display_name(self.provider(inputs)))
            }
        }
    }

    fn effective_summary<'a>(&self, inputs: DirectoryInputs<'a>) -> Option<&'a str> {
        match self.source {
            DirectoryCandidateSource::Indexed {
                row_index, overlay, ..
            } => overlay.resolved_summary(
                &inputs.indexed[row_index],
                inputs.overrides.get(self.key.as_ref()),
            ),
            DirectoryCandidateSource::Synthesized { .. } => None,
        }
    }

    fn first_user_message<'a>(&self, inputs: DirectoryInputs<'a>) -> Option<&'a str> {
        match self.source {
            DirectoryCandidateSource::Indexed { row_index, .. } => {
                inputs.indexed[row_index].first_user_message.as_deref()
            }
            DirectoryCandidateSource::Synthesized { .. } => None,
        }
    }

    fn is_subagent(&self, inputs: DirectoryInputs<'_>) -> bool {
        match self.source {
            DirectoryCandidateSource::Indexed { row_index, .. } => {
                inputs.indexed[row_index].is_subagent
            }
            DirectoryCandidateSource::Synthesized { identity_index, .. } => inputs.identities
                [identity_index]
                .is_subagent
                .unwrap_or(false),
        }
    }

    fn is_non_interactive(&self, inputs: DirectoryInputs<'_>) -> bool {
        match self.source {
            DirectoryCandidateSource::Indexed { row_index, .. } => {
                inputs.indexed[row_index].is_non_interactive
            }
            DirectoryCandidateSource::Synthesized { .. } => false,
        }
    }

    fn is_running(&self, inputs: DirectoryInputs<'_>) -> bool {
        match self.source {
            DirectoryCandidateSource::Indexed {
                running_identity_index,
                ..
            } => running_identity_index.is_some(),
            DirectoryCandidateSource::Synthesized { .. } => true,
        }
    }

    fn source_file<'a>(&self, inputs: DirectoryInputs<'a>) -> Option<&'a Path> {
        match self.source {
            DirectoryCandidateSource::Indexed { row_index, .. } => {
                inputs.indexed[row_index].source_file.as_deref()
            }
            DirectoryCandidateSource::Synthesized { .. } => None,
        }
    }
}

fn compare_directory_order(left: DirectoryOrderKey<'_>, right: DirectoryOrderKey<'_>) -> Ordering {
    right
        .last_activity_at
        .cmp(&left.last_activity_at)
        .then_with(|| right.key.cmp(left.key))
}

fn candidate_is_strictly_after_cursor(
    candidate: &DirectoryCandidate,
    inputs: DirectoryInputs<'_>,
    cursor: &DecodedCursor,
) -> bool {
    compare_directory_order(
        candidate.order_key(inputs),
        DirectoryOrderKey {
            last_activity_at: cursor.last_activity_at,
            key: &cursor.key,
        },
    ) == Ordering::Greater
}

fn candidate_is_visible(
    candidate: &DirectoryCandidate,
    inputs: DirectoryInputs<'_>,
    q: &DirQuery,
) -> bool {
    (q.include_subagents || !candidate.is_subagent(inputs))
        && (q.include_non_interactive || !candidate.is_non_interactive(inputs))
        && (q.include_empty
            || candidate.is_running(inputs)
            || candidate
                .effective_title(inputs)
                .map(str::trim)
                .is_some_and(|title| !title.is_empty()))
}

fn title_search_annotation(
    candidate: &DirectoryCandidate,
    inputs: DirectoryInputs<'_>,
    lowercase_query: &str,
) -> Option<SearchAnnotation> {
    for (matched_in, field) in [
        ("title", candidate.effective_title(inputs)),
        ("summary", candidate.effective_summary(inputs)),
        ("firstUserMessage", candidate.first_user_message(inputs)),
    ] {
        let Some(field) = field else {
            continue;
        };
        if field.to_lowercase().contains(lowercase_query) {
            return Some(SearchAnnotation {
                matched_in: matched_in.to_string(),
                snippet: field.chars().take(140).collect(),
            });
        }
    }
    None
}

fn file_search_tier(tier: &Tier) -> Option<FileSearchTier> {
    match tier {
        Tier::Title => None,
        Tier::UserMessages => Some(FileSearchTier::UserMessages),
        Tier::FullText => Some(FileSearchTier::FullText),
    }
}

fn select_page_candidates(
    mut candidates: Vec<DirectoryCandidate>,
    inputs: DirectoryInputs<'_>,
    q: &DirQuery,
    cursor: Option<&DecodedCursor>,
    limit: usize,
) -> CandidatePage {
    candidates.sort_by(|left, right| {
        compare_directory_order(left.order_key(inputs), right.order_key(inputs))
    });
    let query = q
        .query
        .as_deref()
        .map(str::trim)
        .filter(|query| !query.is_empty());
    let lowercase_title_query = if query.is_some() && matches!(&q.tier, Tier::Title) {
        Some(query.expect("query exists").to_lowercase())
    } else {
        None
    };
    let mut rows = Vec::new();
    let mut partial = false;
    let mut partial_reason = None;
    let mut scanned_files = 0usize;
    let max_scan = limit * 10;

    for candidate in candidates {
        if !candidate_is_visible(&candidate, inputs, q) {
            continue;
        }
        if cursor
            .is_some_and(|cursor| !candidate_is_strictly_after_cursor(&candidate, inputs, cursor))
        {
            continue;
        }

        let annotation = match (query, &q.tier) {
            (None, _) => None,
            (Some(_), Tier::Title) => {
                let Some(annotation) = title_search_annotation(
                    &candidate,
                    inputs,
                    lowercase_title_query
                        .as_deref()
                        .expect("lowercase title query"),
                ) else {
                    continue;
                };
                Some(annotation)
            }
            (Some(query), Tier::UserMessages | Tier::FullText) => {
                if rows.len() > limit {
                    break;
                }
                if scanned_files >= max_scan {
                    partial = true;
                    partial_reason = Some("budget");
                    break;
                }
                let Some(path) = candidate.source_file(inputs) else {
                    continue;
                };
                if !matches!(candidate.provider(inputs), "claude" | "codex") {
                    continue;
                }
                scanned_files += 1;
                let tier = file_search_tier(&q.tier).expect("file search tier");
                match search_session_file(path, candidate.provider(inputs), query, tier) {
                    Ok(Some(found)) => {
                        let annotation = SearchAnnotation {
                            matched_in: found.matched_in.to_string(),
                            snippet: found.snippet,
                        };
                        Some(annotation)
                    }
                    Ok(None) => continue,
                    Err(_) => {
                        partial = true;
                        if partial_reason.is_none() {
                            partial_reason = Some("io_error");
                        }
                        continue;
                    }
                }
            }
        };
        rows.push(SelectedCandidate {
            candidate,
            annotation,
        });
    }

    CandidatePage {
        rows,
        partial,
        partial_reason,
    }
}

fn materialize_selected_candidate(
    selected: &SelectedCandidate,
    inputs: DirectoryInputs<'_>,
) -> DirItem {
    match selected.candidate.source {
        DirectoryCandidateSource::Indexed {
            row_index,
            overlay,
            running_identity_index,
        } => {
            let row = &inputs.indexed[row_index];
            let running_identity =
                running_identity_index.map(|identity_index| &inputs.identities[identity_index]);
            let session_type = inputs
                .metadata
                .get(selected.candidate.key.as_ref())
                .and_then(Value::as_object)
                .and_then(|entry| entry.get("sessionType"))
                .and_then(Value::as_str)
                .filter(|session_type| !session_type.is_empty())
                .map(str::to_string);
            DirItem {
                session_id: row.session_id.clone(),
                provider: row.provider.clone(),
                project_path: row.project_path.clone(),
                title: selected
                    .candidate
                    .effective_title(inputs)
                    .map(str::to_string),
                summary: selected
                    .candidate
                    .effective_summary(inputs)
                    .map(str::to_string),
                first_user_message: row.first_user_message.clone(),
                last_activity_at: row.last_activity_at,
                created_at: row.created_at,
                cwd: row.cwd.clone(),
                is_subagent: row.is_subagent,
                is_non_interactive: row.is_non_interactive,
                is_running: running_identity.is_some(),
                archived: overlay.archived,
                matched_in: selected
                    .annotation
                    .as_ref()
                    .map(|annotation| annotation.matched_in.clone()),
                snippet: selected
                    .annotation
                    .as_ref()
                    .map(|annotation| annotation.snippet.clone()),
                running_terminal_id: running_identity.map(|identity| identity.terminal_id.clone()),
                live_terminal_only: false,
                session_type,
                title_source: row.title_source.clone(),
                source_file: row.source_file.clone(),
            }
        }
        DirectoryCandidateSource::Synthesized {
            identity_index,
            session_id_source,
        } => {
            let identity = &inputs.identities[identity_index];
            let provider = identity
                .provider
                .as_deref()
                .expect("synthesized candidate provider");
            let (session_id, live_terminal_only) = match session_id_source {
                SynthesizedSessionIdSource::IdentitySessionId => (
                    identity
                        .session_id
                        .as_deref()
                        .expect("synthesized candidate session id")
                        .to_string(),
                    false,
                ),
                SynthesizedSessionIdSource::TerminalId => {
                    (format!("terminal:{}", identity.terminal_id), true)
                }
            };
            let terminal_fallback = format!("terminal:{}", identity.terminal_id);
            DirItem {
                session_id,
                provider: provider.to_string(),
                project_path: identity
                    .cwd
                    .clone()
                    .unwrap_or_else(|| terminal_fallback.clone()),
                title: Some(provider_display_name(provider).to_string()),
                summary: None,
                first_user_message: None,
                last_activity_at: identity.updated_at,
                created_at: Some(identity.updated_at),
                cwd: identity.cwd.clone(),
                is_subagent: identity.is_subagent.unwrap_or(false),
                is_non_interactive: false,
                is_running: true,
                archived: false,
                matched_in: selected
                    .annotation
                    .as_ref()
                    .map(|annotation| annotation.matched_in.clone()),
                snippet: selected
                    .annotation
                    .as_ref()
                    .map(|annotation| annotation.snippet.clone()),
                running_terminal_id: Some(identity.terminal_id.clone()),
                live_terminal_only,
                session_type: Some(provider.to_string()),
                title_source: None,
                source_file: None,
            }
        }
    }
}

fn derive_directory_page(inputs: DirectoryInputs<'_>, q: &DirQuery) -> Result<Value, String> {
    let limit = q
        .limit
        .unwrap_or(MAX_DIRECTORY_PAGE_ITEMS)
        .min(MAX_DIRECTORY_PAGE_ITEMS);
    let cursor = q.cursor.as_deref().map(decode_cursor).transpose()?;
    let candidates =
        build_directory_candidates(inputs.indexed, inputs.overrides, inputs.identities);
    let revision = candidates
        .iter()
        .map(|candidate| candidate.order_key(inputs).last_activity_at)
        .chain(inputs.identities.iter().map(|identity| identity.updated_at))
        .max()
        .unwrap_or(0)
        .max(0);
    let selected = select_page_candidates(candidates, inputs, q, cursor.as_ref(), limit);
    let materialized: Vec<DirItem> = selected
        .rows
        .iter()
        .map(|selected| materialize_selected_candidate(selected, inputs))
        .collect();
    let has_more = selected.rows.len() > limit;
    let next_cursor = has_more.then(|| {
        let tail = selected.rows[limit - 1].candidate.order_key(inputs);
        encode_cursor(tail.last_activity_at, tail.key)
    });
    let items = materialized
        .iter()
        .take(limit)
        .map(DirItem::to_value)
        .collect::<Vec<_>>();
    let mut page = json!({
        "items": items,
        "nextCursor": next_cursor,
        "revision": revision,
    });
    if selected.partial {
        page["partial"] = Value::Bool(true);
        if let Some(reason) = selected.partial_reason {
            page["partialReason"] = Value::String(reason.to_string());
        }
    }
    Ok(page)
}
```

This profile has these invariants, all enforced by the supplied code rather than prose: every stored index is `usize`; candidates own only their existing `Arc<str>` key and small enums/indices; title/summary provenance is `Absent | Row | Override`; synthesized session provenance is `IdentitySessionId | TerminalId`; first supplied exact identity wins; all key collisions and deletion/re-synthesis behavior are unchanged; accessors receive `DirectoryInputs`; the selector and materializer receive the same inputs; no candidate/full row/title/summary/path/terminal ID/source path is cloned into a descriptor; and output is still owned before the handler drops the snapshot. If this exact code does not compile after the authorized diagnostic, execution stops with a design gap—there is no broader fallback. This profile retains the same snapshot `Arc`; it does not address snapshot-generation pinning and creates no A07 memory/RSS claim.

The Phase-C fence intentionally remains Task-6-unbounded and has no Task-7 counters. It therefore preserves the required Task-7 RED observation. Task 7 later applies the exact fallback-only Step-2 selector and Step-6 derivation below.

The fallback-only `test_directory_inputs`, provenance-resolver test body, `materialize_test_candidate`, and `overlaid_title` forms shown inside the existing Task-6 Rust fences are conditional implementation instructions, not additional source on the borrowed path. If fallback is not selected, retain the corresponding borrowed forms. On fallback, every `inputs` value borrows the same indexed slice, overrides map, metadata map, and supplied identity vector used to build its candidate; never rebuild, sort, or clone those collections.

Apply this exhaustive signature/call-site mapping on the fallback branch:

| Stable owner/call | Exact fallback form |
|---|---|
| `shared_order_comparator_and_cursor_relation_are_exact_inverses` | Bind `let metadata = HashMap::new(); let inputs = test_directory_inputs(std::slice::from_ref(&row), &overrides, &metadata, &identities);`; use `candidate.order_key(inputs)` and `candidate_is_strictly_after_cursor(&candidate, inputs, &cursor)`. |
| `shared_visibility_predicate_preserves_running_empty_exception` | Bind one inputs value for `whitespace/no_identities` and one for `running/identities`; use `candidate_is_visible(&candidate, inputs, &query)` for all three calls. |
| `candidate_normalization_preserves_first_winner_from_supplied_identity_vector` closure | After `metadata`, bind inputs over the closure's `identities`; use `materialize_selected_candidate(&SelectedCandidate { candidate, annotation: None }, inputs)`. |
| `shared_title_match_preserves_field_precedence_and_140_scalar_snippet` | For each of the precedence, scalar, summary, and first-message rows, bind inputs over the exact one-row slice used by `build_directory_candidates`; call `title_search_annotation(&candidate, inputs, "needle")`. The four production-helper references remain exactly four. |
| Production `candidate_is_strictly_after_cursor` | `(candidate, inputs, cursor)` as supplied in the complete fallback fence. |
| Production `candidate_is_visible` | `(candidate, inputs, q)` as supplied in the complete fallback fence. |
| Production `title_search_annotation` | `(candidate, inputs, lowercase_query)` as supplied in the complete fallback fence. |
| Production `select_page_candidates` | `(candidates, inputs, q, cursor, limit)` as supplied in the complete fallback fence. |
| Production materializer | `(selected, inputs)`; metadata is read as `inputs.metadata`. |
| Phase-A/Task-7 derivations | Pass `inputs` to every order-key, selector, and materializer call exactly as shown in the complete fallback and Task-7 fallback fences. |

Every join-test materializer call uses the exact slice that built its candidate: `materialize_test_candidate(candidate, &indexed, &overrides, &identities)` when `indexed` is a `Vec<IndexedSession>`, `materialize_test_candidate(candidate, std::slice::from_ref(&indexed), &overrides, &identities)` when it is one row, and `materialize_test_candidate(candidate, &[], &overrides, &identities)` for synthesized-only input. Every direct running assertion first binds a stable local `metadata = HashMap::new()` and the matching `DirectoryInputs`, then calls `candidate.is_running(inputs)`; use `&indexed`, `std::slice::from_ref(&indexed)`, or `&[]` by the same rule. The Step-5 exact resolver example similarly uses `overlay.resolved_title(&row, Some(&override_value))` and `overlay.resolved_summary(&row, Some(&override_value))`. These are all direct resolver/accessor/materializer call sites named by the plan; derivation-based tests continue to call `derive_directory_page` unchanged.

**Same-shell dependency:** `TASK6_FALLBACK_REQUIRED` was set by the Phase-C compiler fence and is consumed below. Run both fences in this Task-6 shell; do not start a replacement shell between them.

> If `TASK6_FALLBACK_REQUIRED=1`, first apply exactly the documented reference-free profile. The first command below then proves its four shared tests, supplied-vector winner, actual-handler `cargo check`, and complete test-target `--no-run`. Both representations then execute the same 516/21/15/nine/focused checkpoint. Only after every required command passes is the persisted marker written. The marker always exists and contains exactly one of `fallback_used=0` or `fallback_used=1`; file existence is never treated as fallback evidence.

```bash
if [[ "$TASK6_FALLBACK_REQUIRED" -eq 1 ]]; then
  run_task6_fallback_compiler_checkpoint task6-fallback-cutover
elif [[ "$TASK6_FALLBACK_REQUIRED" -ne 0 ]]; then
  printf 'invalid TASK6_FALLBACK_REQUIRED=%s\n' \
    "$TASK6_FALLBACK_REQUIRED" >&2
  exit 1
fi

run_task6_representation_checkpoint task6-cutover

git -C "$WT" diff --check
git -C "$WT" add -- "$SOURCE_REL"
test "$(git -C "$WT" diff --cached --name-only)" = "$SOURCE_REL"
git -C "$WT" commit \
  -m "refactor(session-directory): cut route over to candidate policy" \
  -m "Compile the real post-await narrow borrow and release the snapshot before response decoration while retaining the eager oracle for cleanup." \
  -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)" \
  -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"

TASK6_CUTOVER_COMMIT=$(git -C "$WT" rev-parse HEAD)
printf '%s\n' "$TASK6_CUTOVER_COMMIT" \
  | tee "$LOG_ROOT/task6-cutover-commit.txt"
printf 'fallback_used=%s\n' "$TASK6_FALLBACK_REQUIRED" \
  | tee "$LOG_ROOT/task6-fallback-used.txt"
grep -Eq '^fallback_used=[01]$' "$LOG_ROOT/task6-fallback-used.txt"
test "$(wc -l <"$LOG_ROOT/task6-fallback-used.txt")" -eq 1
case "$(cat "$LOG_ROOT/task6-fallback-used.txt")" in
  fallback_used=1)
    TASK6_PROOF_COMMIT=$TASK6_CUTOVER_COMMIT
    ;;
  fallback_used=0)
    TASK6_PROOF_COMMIT=$(cat "$LOG_ROOT/task6-proof-commit.txt")
    test "$TASK6_PROOF_COMMIT" != "$TASK6_CUTOVER_COMMIT"
    ;;
  *)
    printf 'invalid fallback marker\n' >&2
    exit 1
    ;;
esac
printf '%s\n' "$TASK6_PROOF_COMMIT" \
  | tee "$LOG_ROOT/task6-proof-commit.txt"
git -C "$WT" merge-base --is-ancestor "$TASK6_PROOF_COMMIT" HEAD
```

On `fallback_used=1`, the four shared tests and winner compile with the F2 signatures, the real handler and complete test target compile with F1, and the common 516/21/15/nine/focused checkpoint proves this exact indexed representation. The second Task-6 commit therefore becomes `TASK6_PROOF_COMMIT`. On `fallback_used=0`, the borrowed profile remains unchanged. No temporary generator is a final-state A08 dependency; it exists only in the recorded proof commit and is deleted in Step 11.

This keeps exactly three Task-6 commits. On fallback, the second commit becomes the persisted latest-representation proof commit; without fallback, the first commit remains the persisted proof commit.

#### Phase D: Migrate consumers, rerun the latest proof, delete eager residue, and commit cleanup

Only after Phase C is committed execute the retained Steps 3-5 and 7-14 migration/cleanup blocks. Preserve the 28 unique direct-helper tests / 29 obligations and seven transitive override tests as cleanup coverage, not deletion authority.

Now add the derivation fixture before any migrated test uses it:

```rust
    fn derive_test_page(
        indexed: &[IndexedSession],
        overrides: &Map<String, Value>,
        identities: &[TerminalIdentity],
        query: &DirQuery,
    ) -> Value {
        let metadata = HashMap::new();
        derive_directory_page(
            DirectoryInputs {
                indexed,
                overrides,
                metadata: &metadata,
                identities,
            },
            query,
        )
        .expect("directory page")
    }
```

Compile the complete test target, not only the non-test binary:

```bash
run_logged task6-derive-no-run \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server --no-run
```

Expected GREEN: exit 0. This checkpoint proves the decoder cutover, temporary tuple-consumer adaptation, parser/oracle imports, and new test helper all compile together.

- [ ] **Step 7: Migrate the ordinary `apply_query` tests, including the duplicate and cursor cases.**

The exact replacement call is:

```rust
    let metadata = HashMap::new();
    let page = derive_directory_page(
        DirectoryInputs {
            indexed: &indexed,
            overrides: &overrides,
            metadata: &metadata,
            identities: &identities,
        },
        &query,
    )
    .expect("page");
```

Convert the five parser-backed ordinary tests mechanically with `scan_indexed_claude_sessions`; never convert `Vec<DirItem>` back into indexed rows:

| Test | Exact fixture replacement | Assertions retained exactly |
|---|---|---|
| `default_query_hides_non_interactive_fixtures` | `let indexed = scan_indexed_claude_sessions(&home);` | indexed length 1; returned length 0; null cursor; revision `1_769_753_759_234`. |
| `include_non_interactive_surfaces_titled_session` | `let indexed = scan_indexed_claude_sessions(&home);` | returned length 1; title `Test Session 1`; provider `claude`. |
| `include_empty_surfaces_untitled_sessions_sorted_desc` | `let indexed = scan_indexed_claude_sessions(&home);` | returned length 1; session id `b7936c10-4935-441c-837c-c1f33cafec2d`. |
| `r10b_cwdless_repair_fixture_never_surfaces_under_any_flags` | `let indexed = scan_indexed_claude_sessions(&home);` over its custom home | `indexed.is_empty()`; returned length 0; revision 0. |
| `title_search_matches_and_annotates` | `let indexed = scan_indexed_claude_sessions(&home);` once, reused as `&indexed` for both derivations | hit length 1 with `matchedIn=title` and snippet `Test Session 1`; no-match length 0. |

Use this complete conversion for the first test:

```rust
#[test]
fn default_query_hides_non_interactive_fixtures() {
    let home = claude_home_with(&["real-corrupted.jsonl", "healthy.jsonl"]);
    let indexed = scan_indexed_claude_sessions(&home);
    assert_eq!(
        indexed.len(),
        1,
        "the cwd-less repair fixture is never indexed (R10b)"
    );

    let page = derive_test_page(&indexed, &Map::new(), &[], &default_query());
    assert_eq!(page["items"].as_array().unwrap().len(), 0);
    assert_eq!(page["nextCursor"], Value::Null);
    assert_eq!(page["revision"], json!(1_769_753_759_234i64));

    std::fs::remove_dir_all(&home).ok();
}
```

For the other four parser-backed tests, retain their current home construction, query mutations, cleanup, and assertions byte-for-byte; replace only `list_claude_sessions(&home)` with `scan_indexed_claude_sessions(&home)` and each `apply_query(items, &query, &[])` with `derive_test_page(&indexed, &Map::new(), &[], &query)`.

Migrate `cursor_paging_splits_and_round_trips`, `invalid_cursor_is_rejected`, and `badcursor_still_400s_with_original_message_r9_parity_untouched` by replacing their `Vec<DirItem>` fixtures with `Vec<IndexedSession>` built by `indexed_test_item` and replacing `apply_query` with `derive_directory_page`. Cursor round trips must consume encoded `nextCursor` and set `DirQuery.cursor`; both invalid-cursor tests must retain invalid base64 plus `encode_cursor(1, "")` and must not construct `DecodedCursor` directly.

Replace the Task-3 duplicate test and delete `legacy_duplicate_items` with:

```rust
    #[test]
    fn duplicate_equal_order_tuples_preserve_stable_order_and_strict_cursor_gap() {
        let mut first = indexed_row("duplicate", 500, Some("first"));
        first.project_path = "/first".to_string();
        let mut second = indexed_row("duplicate", 500, Some("second"));
        second.project_path = "/second".to_string();
        let indexed = vec![first, second];
        let overrides = Map::new();
        let metadata = HashMap::new();
        let identities = Vec::new();

        let one_page = derive_directory_page(
            DirectoryInputs {
                indexed: &indexed,
                overrides: &overrides,
                metadata: &metadata,
                identities: &identities,
            },
            &test_query(None, Tier::Title, None, 2),
        )
        .expect("one page");
        let titles: Vec<&str> = one_page["items"]
            .as_array()
            .expect("items")
            .iter()
            .map(|item| item["title"].as_str().expect("title"))
            .collect();
        assert_eq!(titles, vec!["first", "second"]);

        let first_page = derive_directory_page(
            DirectoryInputs {
                indexed: &indexed,
                overrides: &overrides,
                metadata: &metadata,
                identities: &identities,
            },
            &test_query(None, Tier::Title, None, 1),
        )
        .expect("first page");
        let cursor = first_page["nextCursor"]
            .as_str()
            .expect("cursor")
            .to_string();
        let second_page = derive_directory_page(
            DirectoryInputs {
                indexed: &indexed,
                overrides: &overrides,
                metadata: &metadata,
                identities: &identities,
            },
            &test_query(None, Tier::Title, Some(cursor), 1),
        )
        .expect("second page");
        assert!(second_page["items"].as_array().expect("items").is_empty());
        assert!(second_page["nextCursor"].is_null());
    }
```

Compile the complete test target, then run every migrated ordinary/cursor/duplicate test exactly:

```bash
run_logged task6-ordinary-no-run \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server --no-run
for full_name in \
  session_directory::tests::default_query_hides_non_interactive_fixtures \
  session_directory::tests::include_non_interactive_surfaces_titled_session \
  session_directory::tests::include_empty_surfaces_untitled_sessions_sorted_desc \
  session_directory::tests::r10b_cwdless_repair_fixture_never_surfaces_under_any_flags \
  session_directory::tests::title_search_matches_and_annotates \
  session_directory::tests::cursor_paging_splits_and_round_trips \
  session_directory::tests::invalid_cursor_is_rejected \
  session_directory::tests::badcursor_still_400s_with_original_message_r9_parity_untouched \
  session_directory::page_bound_tests::duplicate_equal_order_tuples_preserve_stable_order_and_strict_cursor_gap
do
  run_logged "task6-ordinary-${full_name//::/-}" \
    env CARGO_TERM_COLOR=never \
    cargo test --manifest-path "$MANIFEST" \
      -p freshell-server --bin freshell-server \
      "$full_name" -- --exact --color=never --test-threads=1
done
```

Expected GREEN: `--no-run` exits 0 and each of the nine exact filters reports `1 passed`.

- [ ] **Step 8: Complete override wire migrations and all seven transitive tests.**

Apply these mechanical edits to the two wire-shape tests:

```text
overrides_overlay_applies_title_summary_archived_and_filters_deleted:
  replace each DirItem fixture with indexed_test_item using the same session id,
  activity, and parsed title; copy the test's summary/title_source mutations to
  the corresponding IndexedSession; leave the existing override Map unchanged;
  replace apply_session_overrides plus per-item to_value with one
  derive_test_page(&indexed, &overrides, &[], &default_query()); retain every
  existing item-count, deleted-id absence, title, summary, and archived assertion.

overlay_shape_unchanged_when_no_overrides_archived_always_present:
  replace its DirItem fixture with indexed_test_item using the same values;
  derive with Map::new(), no identities, and default_query(); retain the exact
  title and archived:false JSON assertions.
```

Replace `title_tier_search_matches_a_renamed_sessions_override_title` completely with the appendix's code-ready body:

```rust
#[test]
fn title_tier_search_matches_a_renamed_sessions_override_title() {
    let indexed = vec![indexed_test_item(
        "s1",
        100,
        Some("original parsed title"),
    )];
    let overrides = Map::from_iter([(
        "claude:s1".to_string(),
        json!({"titleOverride": "My Renamed Special Project"}),
    )]);
    let query = DirQuery {
        query: Some("Renamed Special".into()),
        ..DirQuery::default()
    };

    let page = derive_test_page(&indexed, &overrides, &[], &query);
    let arr = page["items"].as_array().unwrap();
    assert_eq!(arr.len(), 1, "search must match the OVERRIDE title");
    assert_eq!(arr[0]["title"], json!("My Renamed Special Project"));
    assert_eq!(arr[0]["matchedIn"], json!("title"));
}
```

Compile the test target and run the complete resolver/override batch exactly:

```bash
run_logged task6-override-no-run \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server --no-run
for test_name in \
  overrides_overlay_applies_title_summary_archived_and_filters_deleted \
  overlay_shape_unchanged_when_no_overrides_archived_always_present \
  suppressed_title_row_still_overlays_summary_and_archived \
  title_tier_search_matches_a_renamed_sessions_override_title \
  provider_generated_session_suppresses_dir_override_row \
  provider_generated_session_suppresses_first_message_override_row \
  provider_generated_session_still_applies_ai_override_row \
  provider_generated_session_still_applies_user_override_row \
  provider_generated_session_still_applies_absent_source_override_row \
  empty_string_title_override_never_applies \
  non_provider_generated_session_still_applies_dir_override_row
do
  run_logged "task6-override-$test_name" \
    env CARGO_TERM_COLOR=never \
    cargo test --manifest-path "$MANIFEST" \
      -p freshell-server --bin freshell-server \
      "session_directory::tests::$test_name" -- \
      --exact --color=never --test-threads=1
done
```

Expected GREEN: `--no-run` exits 0 and each of the eleven exact filters reports `1 passed`.

- [ ] **Step 9: Migrate all deep-search tests to `IndexedSession` with real `source_file`.**

Convert the seven original deep/title tests with these exact fixture sources and retained assertions:

| Test | Exact indexed fixture | Assertions retained exactly |
|---|---|---|
| `tier_user_messages_matches_only_the_user_turn` | build `home` with `synthetic_claude_home_with_turns`, then `let indexed = scan_indexed_claude_sessions(&home);` once | indexed length 1; `source_file.is_some()`; user hit length 1, `matchedIn=userMessage`, exact snippet; assistant-only query length 0. |
| `tier_full_text_matches_assistant_turn_too` | `let indexed = scan_indexed_claude_sessions(&home);` over its existing synthetic home | result length 1; `matchedIn=assistantMessage`. |
| `tier_search_is_case_insensitive` | `let indexed = scan_indexed_claude_sessions(&home);` over its existing synthetic home | result length 1. |
| `tier_search_empty_no_match_returns_empty_items_without_partial` | `let indexed = scan_indexed_claude_sessions(&home);` over its existing synthetic home | items length 0; cursor null; `partial` omitted. |
| `tier_search_combined_with_cursor_pagination` | after building the existing custom three-file home, execute `let indexed = scan_indexed_claude_sessions(&home);` once before the loop and reuse `&indexed` | each page length 1; third cursor `None`; exact newest-first three-id vector. |
| `tier_search_reports_partial_budget_when_scan_budget_exceeded` | after building the existing custom eleven-file home, execute `let indexed = scan_indexed_claude_sessions(&home);` | indexed length 11; items length 0; `partial=true`; `partialReason=budget`. |
| `title_tier_search_matches_a_renamed_sessions_override_title` | `indexed_test_item("s1", 100, Some("original parsed title"))` plus the Step 8 override map | result length 1; effective title `My Renamed Special Project`; `matchedIn=title`. |

Replace `tier_user_messages_matches_only_the_user_turn` completely with the scanner-backed body:

```rust
#[test]
fn tier_user_messages_matches_only_the_user_turn() {
    let home = synthetic_claude_home_with_turns(
        "bbbbbbbb-0000-4000-8000-000000000001",
        "unique-search-term-alpha",
        "unique-search-term-alpha-assistant-only",
    );
    let indexed = scan_indexed_claude_sessions(&home);
    assert_eq!(indexed.len(), 1);
    assert!(
        indexed[0].source_file.is_some(),
        "a real session file must carry a source_file for tier search"
    );

    let q_user_hit = DirQuery {
        include_non_interactive: true,
        tier: Tier::UserMessages,
        query: Some("unique-search-term-alpha".into()),
        ..DirQuery::default()
    };
    let page = derive_test_page(&indexed, &Map::new(), &[], &q_user_hit);
    let arr = page["items"].as_array().unwrap();
    assert_eq!(arr.len(), 1, "userMessages tier must match the user turn");
    assert_eq!(arr[0]["matchedIn"], json!("userMessage"));
    assert_eq!(arr[0]["snippet"], json!("unique-search-term-alpha"));

    let q_assistant_only = DirQuery {
        include_non_interactive: true,
        tier: Tier::UserMessages,
        query: Some("assistant-only".into()),
        ..DirQuery::default()
    };
    let page2 = derive_test_page(&indexed, &Map::new(), &[], &q_assistant_only);
    assert_eq!(
        page2["items"].as_array().unwrap().len(),
        0,
        "userMessages tier must never match assistant-only text"
    );

    std::fs::remove_dir_all(&home).ok();
}
```

For `tier_full_text_matches_assistant_turn_too`, `tier_search_is_case_insensitive`, and `tier_search_empty_no_match_returns_empty_items_without_partial`, keep each current synthetic-home constructor, query, cleanup, and assertions; replace only `list_claude_sessions(&home)` with `scan_indexed_claude_sessions(&home)` and `apply_query` with `derive_test_page`.

For pagination, replace the per-iteration `list_claude_sessions(&home)` with one pre-loop `let indexed = scan_indexed_claude_sessions(&home);`, then call `derive_test_page(&indexed, &Map::new(), &[], &query)` in every loop iteration. For the budget test, replace `items` with `indexed`, retain `assert_eq!(indexed.len(), 11)`, and derive once. The renamed-title test is the 29th helper-to-test obligation and is replaced once by the complete Step 8 body.

Replace the three Task-3 edge tests with these `IndexedSession` calls:

```rust
    #[test]
    fn tier_search_reports_io_error_for_missing_source_file() {
        let home = tempfile::tempdir().expect("tempdir");
        let indexed = vec![deep_search_indexed_item(
            "missing",
            100,
            Some(home.path().join("missing.jsonl")),
        )];
        let page = derive_test_page(&indexed, &Map::new(), &[], &deep_search_query());
        assert!(page["items"].as_array().expect("items").is_empty());
        assert_eq!(page["partial"], json!(true));
        assert_eq!(page["partialReason"], json!("io_error"));
    }

    #[test]
    fn tier_search_budget_overwrites_prior_io_error() {
        let home = tempfile::tempdir().expect("tempdir");
        let mut indexed = vec![deep_search_indexed_item(
            "missing",
            1_000,
            Some(home.path().join("missing.jsonl")),
        )];
        for index in 0..9 {
            let path = home.path().join(format!("valid-{index}.jsonl"));
            write_nonmatching_claude_transcript(&path);
            indexed.push(deep_search_indexed_item(
                &format!("valid-{index}"),
                999 - index as i64,
                Some(path),
            ));
        }
        let tail = home.path().join("eligible-tail.jsonl");
        write_nonmatching_claude_transcript(&tail);
        indexed.push(deep_search_indexed_item("eligible-tail", 900, Some(tail)));
        let page = derive_test_page(&indexed, &Map::new(), &[], &deep_search_query());
        assert_eq!(page["partialReason"], json!("budget"));
    }

    #[test]
    fn tier_search_budget_is_checked_before_no_source_tail() {
        let home = tempfile::tempdir().expect("tempdir");
        let mut indexed = Vec::new();
        for index in 0..10 {
            let path = home.path().join(format!("valid-{index}.jsonl"));
            write_nonmatching_claude_transcript(&path);
            indexed.push(deep_search_indexed_item(
                &format!("valid-{index}"),
                1_000 - index as i64,
                Some(path),
            ));
        }
        indexed.push(deep_search_indexed_item("no-source-tail", 900, None));
        let page = derive_test_page(&indexed, &Map::new(), &[], &deep_search_query());
        assert_eq!(page["partialReason"], json!("budget"));
    }
```

Do not pass `list_claude_sessions()` output to `derive_directory_page`. Keep `list_claude_sessions` only for its separate parser/index differential tests. Delete `deep_search_dir_item` after all deep migrations.

Compile the complete test target and run all ten original/edge deep-title tests exactly:

```bash
run_logged task6-deep-no-run \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server --no-run
for test_name in \
  tier_user_messages_matches_only_the_user_turn \
  tier_full_text_matches_assistant_turn_too \
  tier_search_is_case_insensitive \
  tier_search_empty_no_match_returns_empty_items_without_partial \
  tier_search_combined_with_cursor_pagination \
  tier_search_reports_partial_budget_when_scan_budget_exceeded \
  title_tier_search_matches_a_renamed_sessions_override_title \
  tier_search_reports_io_error_for_missing_source_file \
  tier_search_budget_overwrites_prior_io_error \
  tier_search_budget_is_checked_before_no_source_tail
do
  run_logged "task6-deep-$test_name" \
    env CARGO_TERM_COLOR=never \
    cargo test --manifest-path "$MANIFEST" \
      -p freshell-server --bin freshell-server \
      "session_directory::tests::$test_name" -- \
      --exact --color=never --test-threads=1
done
```

Expected GREEN: `--no-run` exits 0 and each of the ten exact filters reports `1 passed`.

- [ ] **Step 10: Verify the complete 28-test/29-obligation migration ledger.**

The named ledger is:

```text
10 join direct-helper tests:
  join_running_state_matches_live_terminal_and_sets_running_fields
  join_running_state_no_match_leaves_not_running
  build_live_terminal_session_item_none_without_a_provider
  build_live_terminal_session_item_with_session_id_is_not_live_terminal_only
  live_terminal_item_mirrors_identity_subagent_flag
  build_live_terminal_session_item_without_session_id_is_live_terminal_only
  join_live_terminals_matched_session_yields_one_running_item
  join_live_terminals_unmatched_terminal_synthesizes_one_live_only_item
  join_live_terminals_matched_terminal_is_never_double_emitted
  codex_fresh_terminal_pre_adoption_duplicate_is_transient_pending_locator_adoption

4 override direct-helper tests:
  overrides_overlay_applies_title_summary_archived_and_filters_deleted
  overlay_shape_unchanged_when_no_overrides_archived_always_present
  suppressed_title_row_still_overlays_summary_and_archived
  title_tier_search_matches_a_renamed_sessions_override_title

15 apply_query direct-helper tests:
  default_query_hides_non_interactive_fixtures
  include_non_interactive_surfaces_titled_session
  include_empty_surfaces_untitled_sessions_sorted_desc
  r10b_cwdless_repair_fixture_never_surfaces_under_any_flags
  title_search_matches_and_annotates
  cursor_paging_splits_and_round_trips
  invalid_cursor_is_rejected
  badcursor_still_400s_with_original_message_r9_parity_untouched
  tier_user_messages_matches_only_the_user_turn
  tier_full_text_matches_assistant_turn_too
  tier_search_is_case_insensitive
  tier_search_empty_no_match_returns_empty_items_without_partial
  tier_search_combined_with_cursor_pagination
  tier_search_reports_partial_budget_when_scan_budget_exceeded
  title_tier_search_matches_a_renamed_sessions_override_title

Unique direct-helper tests = 10 + 4 + 15 - 1 overlap = 28
Helper-to-test obligations = 10 + 4 + 15 = 29

7 transitive overlaid_title tests:
  provider_generated_session_suppresses_dir_override_row
  provider_generated_session_suppresses_first_message_override_row
  provider_generated_session_still_applies_ai_override_row
  provider_generated_session_still_applies_user_override_row
  provider_generated_session_still_applies_absent_source_override_row
  empty_string_title_override_never_applies
  non_provider_generated_session_still_applies_dir_override_row

1 display-helper test migrated in Task 5:
  provider_display_name_matches_known_providers_and_falls_back_to_raw
```

Compile the complete test target one final time before deleting any old policy:

```bash
run_logged task6-predelete-no-run \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server --no-run
```

Expected GREEN: exit 0 after every display/join, resolver, ordinary/cursor, override, and deep migration.

Run semantic residue search before deleting old definitions:

```bash
for symbol in \
  apply_session_overrides \
  join_running_state \
  build_live_terminal_session_item \
  join_live_terminals \
  apply_query
do
  grep -n "$symbol(" "$WT/$SOURCE_REL" \
    | tee "$LOG_ROOT/task6-predelete-$symbol.txt"
done
```

At this point, references must be only old production definitions/callers scheduled for Step 11, not tests. If any named test still appears, finish that migration before cutover.

- [ ] **Step 11: Delete the eager policy, temporary differential, obsolete fields, and adapters; clean `DirItem` and rustdoc.**

The production handler was already cut over and compiler-proved in Phase C. Do not rewrite its ownership order during cleanup. Reload the latest proof commit, prove it is ancestral and contains both temporary symbols, and rerun the 516-case differential immediately before deletion:

```bash
TASK6_PROOF_COMMIT=$(cat "$LOG_ROOT/task6-proof-commit.txt")
test "$(wc -l <"$LOG_ROOT/task6-proof-commit.txt")" -eq 1
git -C "$WT" merge-base --is-ancestor "$TASK6_PROOF_COMMIT" HEAD
git -C "$WT" show "$TASK6_PROOF_COMMIT:$SOURCE_REL" \
  | grep -F 'fn derive_eager_oracle_page('
git -C "$WT" show "$TASK6_PROOF_COMMIT:$SOURCE_REL" \
  | grep -F 'fn candidate_path_matches_eager_oracle_across_seeded_cross_product('

case "$(cat "$LOG_ROOT/task6-fallback-used.txt")" in
  fallback_used=1)
    test "$TASK6_PROOF_COMMIT" = \
      "$(cat "$LOG_ROOT/task6-cutover-commit.txt")"
    run_task6_fallback_compiler_checkpoint task6-fallback-predelete
    ;;
  fallback_used=0)
    ;;
  *)
    printf 'invalid fallback marker\n' >&2
    exit 1
    ;;
esac

run_task6_representation_checkpoint task6-predelete
```

Deletion begins immediately after this block, without an intervening edit or command. Now delete the eager helpers and temporary oracle/generator/test together while retaining the Phase-C handler unchanged. The later post-deletion nine-route and 20-test gates are post-cleanup regression evidence and do not replace this deletion authority.

Delete these old production definitions together:

```text
dir_item_from_indexed
apply_session_overrides
apply_session_metadata
join_running_state
build_live_terminal_session_item
join_live_terminals
apply_query
FileSearchOutcome
apply_file_search
apply_title_search
```

Retain `provider_display_name` with its Task-5 borrowed signature, retain `decode_cursor` with its new typed return, and retain `DirItem::to_value` as the sole serializer.

Remove only the obsolete `DirItem` fields and `DirItem::key`, then preserve the current `DirItem::to_value` insertion order/body exactly as shown below. Do not reorder the raw JSON object; Task 7 later inserts only ledger instrumentation as the first statement:

```rust
/// Fully materialized session-directory output row. Candidate-only policy data
/// remains in compact `DirectoryCandidate` descriptors and is never stored here.
#[derive(Debug, Clone)]
struct DirItem {
    session_id: String,
    provider: String,
    project_path: String,
    title: Option<String>,
    summary: Option<String>,
    first_user_message: Option<String>,
    last_activity_at: i64,
    created_at: Option<i64>,
    cwd: Option<String>,
    is_subagent: bool,
    is_non_interactive: bool,
    is_running: bool,
    archived: bool,
    matched_in: Option<String>,
    snippet: Option<String>,
    running_terminal_id: Option<String>,
    live_terminal_only: bool,
    session_type: Option<String>,
}

impl DirItem {
    fn to_value(&self) -> Value {
        let mut o = Map::new();
        o.insert("sessionId".into(), json!(self.session_id));
        o.insert("provider".into(), json!(self.provider));
        o.insert("projectPath".into(), json!(self.project_path));
        o.insert("lastActivityAt".into(), json!(self.last_activity_at));
        o.insert("isRunning".into(), json!(self.is_running));
        // R10a: the original always emits `archived` (a `SessionOverride` field
        // defaulted to `false`, `shared/read-models.ts:51`); overlaid from
        // `config.sessionOverrides` by `resolve_indexed_overlay`.
        o.insert("archived".into(), json!(self.archived));
        if let Some(v) = &self.title {
            o.insert("title".into(), json!(v));
        }
        if let Some(v) = &self.summary {
            o.insert("summary".into(), json!(v));
        }
        if let Some(v) = &self.first_user_message {
            o.insert("firstUserMessage".into(), json!(v));
        }
        if let Some(v) = self.created_at {
            o.insert("createdAt".into(), json!(v));
        }
        if let Some(v) = &self.cwd {
            o.insert("cwd".into(), json!(v));
        }
        if self.is_subagent {
            o.insert("isSubagent".into(), json!(true));
        }
        if self.is_non_interactive {
            o.insert("isNonInteractive".into(), json!(true));
        }
        if let Some(v) = &self.matched_in {
            o.insert("matchedIn".into(), json!(v));
        }
        if let Some(v) = &self.snippet {
            o.insert("snippet".into(), json!(v));
        }
        if let Some(v) = &self.running_terminal_id {
            o.insert("runningTerminalId".into(), json!(v));
        }
        if self.live_terminal_only {
            o.insert("liveTerminalOnly".into(), json!(true));
        }
        if let Some(v) = &self.session_type {
            o.insert("sessionType".into(), json!(v));
        }
        Value::Object(o)
    }
}
```

This removes `DirItem::key`, `DirItem.title_source`, and `DirItem.source_file`. Replace both remaining test-only `item.key()` assertions with `format!("{}:{}", item.provider, item.session_id)`; do not add a test-only key method. In the indexed materializer arm delete `title_source: row.title_source.clone()` and `source_file: row.source_file.clone()`; in the synthesized arm delete `title_source: None` and `source_file: None`. Remove the same two fields from every other remaining `DirItem` literal. Do not remove `IndexedSession.title_source` or `IndexedSession.source_file`.

Remove `item_from_meta`'s obsolete source-file parameter rather than leaving an unused warnings-denied argument. Replace its function header exactly; retain the existing body after the opening brace:

```text
fn item_from_meta(
    meta: &ParsedSessionMeta,
    provider: &str,
    fallback_session_id: &str,
    force_subagent: bool,
) -> DirItem {
```

In `parse_claude_file`, replace the call with:

```rust
Some(item_from_meta(
    &meta,
    "claude",
    &fallback,
    force_subagent,
))
```

Replace the two direct-test calls with:

```rust
let item = item_from_meta(&meta, "claude", "real-corrupted", false);
let item = item_from_meta(&meta, "claude", "healthy", false);
```

Inside `item_from_meta`'s `DirItem` literal, delete both `title_source: meta.title_source.clone()` and `source_file`. These are the only three call sites; do not retain an `_source_file` parameter. Deep-search source ownership now lives only on `IndexedSession.source_file`.

Replace stale source documentation with these exact blocks:

```rust
//! Rust implementation of `GET /api/session-directory`.
//!
//! Each request captures one index snapshot plus request-local override,
//! metadata, and terminal-identity snapshots. A shared compact-candidate
//! pipeline owns effective membership, ordering, visibility, cursor, and search
//! policy for every tier; only returned descriptors become `DirItem` values.
```

```rust
/// Request dependencies for the Rust session-directory route. `session_index`
/// may be absent; provider-bearing live identities can still synthesize rows.
```

```rust
/// Search tier. A nonblank query selects title metadata or transcript search;
/// a missing or blank query uses the same no-search candidate pipeline for all
/// tier values.
```

Update any field comments that claim metadata never decorates indexed rows or that `None` index always means an empty page. Remove rustdoc links to deleted helper names.

- [ ] **Step 12: Verify the nine route tests remain unchanged and GREEN.**

Do not edit these call sites:

```text
b_t7_router_get_session_directory_is_backed_by_the_session_index
session_metadata_session_type_is_joined_onto_directory_items
session_directory_page_embeds_config_project_colors
session_directory_page_omits_project_colors_key_when_empty
b_t8_no_session_index_yields_empty_page
override_no_rebuild
codex_exec_session_hidden_by_default_surfaced_with_flag
session_override_applies_to_codex_and_opencode_keys
global_project_session_reports_real_directory_as_project_path
```

Compile after destructive cutover, then run all nine route tests exactly:

```bash
run_logged task6-post-cutover-no-run \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server --no-run
for test_name in \
  b_t7_router_get_session_directory_is_backed_by_the_session_index \
  session_metadata_session_type_is_joined_onto_directory_items \
  session_directory_page_embeds_config_project_colors \
  session_directory_page_omits_project_colors_key_when_empty \
  b_t8_no_session_index_yields_empty_page \
  override_no_rebuild \
  codex_exec_session_hidden_by_default_surfaced_with_flag \
  session_override_applies_to_codex_and_opencode_keys \
  global_project_session_reports_real_directory_as_project_path
do
  run_logged "task6-route-$test_name" \
    env CARGO_TERM_COLOR=never \
    cargo test --manifest-path "$MANIFEST" \
      -p freshell-server --bin freshell-server \
      "session_directory::tests::$test_name" -- \
      --exact --color=never --test-threads=1
done
```

Expected GREEN: `--no-run` exits 0 and each of the nine route filters reports `1 passed`.

- [ ] **Step 13: Run the four shared-prefixed tests, the winner test, all 20 page-bound tests, and the complete focused family.**

```bash
run_logged task6-shared-four \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    'session_directory::page_bound_tests::shared_' -- \
    --color=never --test-threads=1
run_logged task6-winner \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    'session_directory::page_bound_tests::candidate_normalization_preserves_first_winner_from_supplied_identity_vector' -- \
    --exact --color=never --test-threads=1
run_logged task6-page-bound \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    'session_directory::page_bound_tests' -- \
    --color=never --test-threads=1
run_logged task6-session-directory \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    session_directory -- --color=never --test-threads=1
```

Expected GREEN: shared filter reports `4 passed`; winner exact filter reports `1 passed`; page-bound module reports `20 passed; 0 failed; 0 ignored; 0 measured`; focused family positive and zero failures.

- [ ] **Step 14: Run strengthened static residue checks.**

```bash
! grep -n 'provider_display_name_borrowed' "$WT/$SOURCE_REL"
test "$(grep -Ec '^fn provider_display_name\(' "$WT/$SOURCE_REL")" -eq 1
test "$(grep -Ec '^fn compare_directory_order\(' "$WT/$SOURCE_REL")" -eq 1
test "$(grep -Ec '^fn candidate_is_visible\(' "$WT/$SOURCE_REL")" -eq 1
test "$(grep -Ec '^fn resolve_indexed_overlay' "$WT/$SOURCE_REL")" -eq 1
test "$(grep -Ec '^fn derive_directory_page\(' "$WT/$SOURCE_REL")" -eq 1
test "$(grep -Ec '^fn materialize_selected_candidate\(' "$WT/$SOURCE_REL")" -eq 1
! grep -En '^fn (dir_item_from_indexed|apply_session_overrides|apply_session_metadata|join_running_state|build_live_terminal_session_item|join_live_terminals|apply_query|apply_file_search|apply_title_search)\(' \
  "$WT/$SOURCE_REL"
! grep -En '^struct FileSearchOutcome' "$WT/$SOURCE_REL"
! grep -En '^\s*fn key\(&self\)' "$WT/$SOURCE_REL"
! grep -En '(DirectoryStrategy|ComparisonStrategy|Materialized|FastPath|OldStrategy|NewStrategy)' \
  "$WT/$SOURCE_REL"
! sed -n '1,260p' "$WT/$SOURCE_REL" \
  | grep -E '(apply_query|apply_session_overrides|join_live_terminals|build_live_terminal_session_item)'
python3 -I - "$WT/$SOURCE_REL" <<'PY'
from pathlib import Path
import sys


class ResidueAuditFailure(RuntimeError):
    pass


def require(condition: bool, message: object) -> None:
    if not condition:
        raise ResidueAuditFailure(str(message))


text = Path(sys.argv[1]).read_text(encoding="utf-8")
start = text.index("struct DirItem {")
end = text.index("\n}\n\nimpl DirItem", start)
body = text[start:end]
require("title_source" not in body, "DirItem retains title_source")
require("source_file" not in body, "DirItem retains source_file")

item_from_meta_start = text.index("fn item_from_meta(")
item_from_meta_signature_end = text.index(") -> DirItem", item_from_meta_start)
item_from_meta_signature = text[
    item_from_meta_start:item_from_meta_signature_end
]
require(
    "source_file" not in item_from_meta_signature,
    "item_from_meta retains source_file parameter",
)
require(text.count("item_from_meta(") == 4, "item_from_meta reference count")

serializer_start = text.index("fn to_value(&self) -> Value {")
serializer_end = text.index("Value::Object(o)", serializer_start)
serializer = text[serializer_start:serializer_end]
ordered_fields = [
    '"sessionId"',
    '"provider"',
    '"projectPath"',
    '"lastActivityAt"',
    '"isRunning"',
    '"archived"',
    '"title"',
    '"summary"',
    '"firstUserMessage"',
    '"createdAt"',
    '"cwd"',
    '"isSubagent"',
    '"isNonInteractive"',
    '"matchedIn"',
    '"snippet"',
    '"runningTerminalId"',
    '"liveTerminalOnly"',
    '"sessionType"',
]
positions = [serializer.index(field) for field in ordered_fields]
require(positions == sorted(positions), "serializer field order changed")

cursor = 0
while True:
    begin = text.find("DirItem {", cursor)
    if begin < 0:
        break
    brace = text.find("{", begin)
    depth = 0
    finish = None
    for index in range(brace, len(text)):
        if text[index] == "{":
            depth += 1
        elif text[index] == "}":
            depth -= 1
            if depth == 0:
                finish = index + 1
                break
    require(finish is not None, f"unterminated DirItem literal at {begin}")
    literal = text[begin:finish]
    require("title_source:" not in literal, "DirItem literal retains title_source")
    require("source_file:" not in literal, "DirItem literal retains source_file")
    cursor = finish
PY
```

Expected: no output and exit 0.

- [ ] **Step 15: Commit only the eager-policy cleanup.**

```bash
git -C "$WT" diff --check
git -C "$WT" add -- "$SOURCE_REL"
test "$(git -C "$WT" diff --cached --name-only)" = "$SOURCE_REL"
git -C "$WT" commit \
  -m "refactor(session-directory): remove eager policy residue" \
  -m "Migrate semantic consumers after differential and handler gates, then delete the eager policy and temporary oracle so production has one path." \
  -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)" \
  -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
TASK6_PROOF_COMMIT=$(cat "$LOG_ROOT/task6-proof-commit.txt")
git -C "$WT" merge-base --is-ancestor "$TASK6_PROOF_COMMIT" HEAD
! grep -n 'derive_eager_oracle_page' "$WT/$SOURCE_REL"
! grep -n 'candidate_path_matches_eager_oracle_across_seeded_cross_product' "$WT/$SOURCE_REL"
! grep -En 'identities.*sort|sort_by.*terminal_id' "$WT/$SOURCE_REL"
```

Expected: Task 6 now has exactly three source-only commits: candidate plus differential, actual-handler cutover, and eager cleanup. The final page-bound inventory is back to `20 passed` after deleting the temporary differential.

---

### Task 7: Observe RED Full-Row Work, Then Prove Returned-Row and Lookahead Bounds

**Fresh-shell precondition:** Start this execution unit in a new persistent Bash session and evaluate the complete `Command and Evidence Harness` block before Step 1. Run every Bash fence in this unit in that session; do not reuse shell state from a prior unit.

**Files:**
- Modify: `crates/freshell-server/src/session_directory.rs`
- Test: `crates/freshell-server/src/session_directory.rs`

**Interfaces:**

```text
PreparationCounts = full materializations + output-decorator sites + serialization + retained descriptor peak + owned search annotations
PreparationScope = one non-overlapped current-thread test interval, with reset and panic cleanup
Dynamic instrumentation = named work only; not arbitrary async request identity and not allocator coverage
Static audit = all production full-row constructor/clone/decorator/serializer and annotation sites
Final descriptor/search bound = retained_descriptor_peak <= limit + 1 and search_annotations <= limit + 1
Final full-preparation bound = materialization/decorator/serialization counts never exceed returned limit
```

- [ ] **Step 1: Add the single-interval current-thread ledger implementation.**

```rust
#[cfg(test)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct PreparationCounts {
    indexed_full: usize,
    synthesized_full: usize,
    override_decoration: usize,
    metadata_decoration: usize,
    running_decoration: usize,
    serialization: usize,
    retained_descriptor_peak: usize,
    search_annotations: usize,
}

#[cfg(test)]
thread_local! {
    static PREPARATION_COUNTS: std::cell::Cell<PreparationCounts> =
        const { std::cell::Cell::new(PreparationCounts {
            indexed_full: 0,
            synthesized_full: 0,
            override_decoration: 0,
            metadata_decoration: 0,
            running_decoration: 0,
            serialization: 0,
            retained_descriptor_peak: 0,
            search_annotations: 0,
        }) };
    static PREPARATION_SCOPE_ACTIVE: std::cell::Cell<bool> =
        const { std::cell::Cell::new(false) };
}

#[cfg(test)]
struct PreparationScope {
    finished: bool,
}

#[cfg(test)]
fn begin_preparation_scope() -> PreparationScope {
    PREPARATION_SCOPE_ACTIVE.with(|active| {
        assert!(!active.get(), "nested preparation scopes are forbidden");
        active.set(true);
    });
    PREPARATION_COUNTS.with(|counts| counts.set(PreparationCounts::default()));
    PreparationScope { finished: false }
}

#[cfg(test)]
fn record_preparation(update: impl FnOnce(&mut PreparationCounts)) {
    PREPARATION_SCOPE_ACTIVE.with(|active| {
        if !active.get() {
            return;
        }
        PREPARATION_COUNTS.with(|cell| {
            let mut counts = cell.get();
            update(&mut counts);
            cell.set(counts);
        });
    });
}

#[cfg(test)]
impl PreparationScope {
    fn finish(mut self) -> PreparationCounts {
        PREPARATION_SCOPE_ACTIVE.with(|active| {
            assert!(active.get(), "preparation scope is not active");
            active.set(false);
        });
        let counts = PREPARATION_COUNTS.with(std::cell::Cell::get);
        PREPARATION_COUNTS.with(|cell| cell.set(PreparationCounts::default()));
        self.finished = true;
        counts
    }
}

#[cfg(test)]
impl Drop for PreparationScope {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        PREPARATION_SCOPE_ACTIVE.with(|active| active.set(false));
        PREPARATION_COUNTS.with(|cell| cell.set(PreparationCounts::default()));
    }
}
```

- [ ] **Step 2: Instrument the sole full constructor and serializer.**

Insert as the first statement of the indexed materializer arm:

```rust
            #[cfg(test)]
            record_preparation(|counts| {
                counts.indexed_full += 1;
                counts.override_decoration += 1;
                counts.metadata_decoration += 1;
                counts.running_decoration += 1;
            });
```

Insert as the first statement of the synthesized arm:

```rust
            #[cfg(test)]
            record_preparation(|counts| {
                counts.synthesized_full += 1;
            });
```

Insert as the first statement in `DirItem::to_value`, immediately before the unchanged `let mut o = Map::new();` line:

```rust
        #[cfg(test)]
        record_preparation(|counts| {
            counts.serialization += 1;
        });
```

No other function increments the full-materialization, decorator, or serializer counters. Dynamic values prove calls only at these named sites; the lexical source audit below proves the complete syntactic inventory and that equivalent named work was not moved.

Replace the sole selected-row push with the complete push-plus-observation block below. This is the Task-6-unbounded form; Step 5 adds the final bound after the observation without removing it.

```rust
        rows.push(SelectedCandidate {
            candidate,
            annotation,
        });
        #[cfg(test)]
        record_preparation(|counts| {
            counts.retained_descriptor_peak =
                counts.retained_descriptor_peak.max(rows.len());
        });
```

Replace the complete title and deep match arms with the following compilable forms. The title increment occurs only after a title annotation is accepted; the deep increment occurs only for `Ok(Some(found))`. Nonmatches, errors, and no-query descriptors are not counted.

```rust
            (Some(_), Tier::Title) => {
                let Some(annotation) = title_search_annotation(
                    &candidate,
                    lowercase_title_query.as_deref().expect("lowercase title query"),
                ) else {
                    continue;
                };
                #[cfg(test)]
                record_preparation(|counts| counts.search_annotations += 1);
                Some(annotation)
            }
            (Some(query), Tier::UserMessages | Tier::FullText) => {
                if rows.len() > limit {
                    break;
                }
                if scanned_files >= max_scan {
                    partial = true;
                    partial_reason = Some("budget");
                    break;
                }
                let Some(path) = candidate.source_file() else {
                    continue;
                };
                if !matches!(candidate.provider(), "claude" | "codex") {
                    continue;
                }
                scanned_files += 1;
                let tier = file_search_tier(&q.tier).expect("file search tier");
                match search_session_file(path, candidate.provider(), query, tier) {
                    Ok(Some(found)) => {
                        let annotation = SearchAnnotation {
                            matched_in: found.matched_in.to_string(),
                            snippet: found.snippet,
                        };
                        #[cfg(test)]
                        record_preparation(|counts| counts.search_annotations += 1);
                        Some(annotation)
                    }
                    Ok(None) => continue,
                    Err(_) => {
                        partial = true;
                        if partial_reason.is_none() {
                            partial_reason = Some("io_error");
                        }
                        continue;
                    }
                }
            }
```

If `fallback_used=1`, use the following as the complete Step-2 selector replacement. It is instrumented but still unbounded, so it preserves the required RED before Step 5. If `fallback_used=0`, retain the borrowed snippets above.

```rust
fn select_page_candidates(
    mut candidates: Vec<DirectoryCandidate>,
    inputs: DirectoryInputs<'_>,
    q: &DirQuery,
    cursor: Option<&DecodedCursor>,
    limit: usize,
) -> CandidatePage {
    candidates.sort_by(|left, right| {
        compare_directory_order(left.order_key(inputs), right.order_key(inputs))
    });
    let query = q
        .query
        .as_deref()
        .map(str::trim)
        .filter(|query| !query.is_empty());
    let lowercase_title_query = if query.is_some() && matches!(&q.tier, Tier::Title) {
        Some(query.expect("query exists").to_lowercase())
    } else {
        None
    };
    let mut rows = Vec::new();
    let mut partial = false;
    let mut partial_reason = None;
    let mut scanned_files = 0usize;
    let max_scan = limit * 10;

    for candidate in candidates {
        if !candidate_is_visible(&candidate, inputs, q) {
            continue;
        }
        if cursor
            .is_some_and(|cursor| !candidate_is_strictly_after_cursor(&candidate, inputs, cursor))
        {
            continue;
        }

        let annotation = match (query, &q.tier) {
            (None, _) => None,
            (Some(_), Tier::Title) => {
                let Some(annotation) = title_search_annotation(
                    &candidate,
                    inputs,
                    lowercase_title_query
                        .as_deref()
                        .expect("lowercase title query"),
                ) else {
                    continue;
                };
                #[cfg(test)]
                record_preparation(|counts| counts.search_annotations += 1);
                Some(annotation)
            }
            (Some(query), Tier::UserMessages | Tier::FullText) => {
                if rows.len() > limit {
                    break;
                }
                if scanned_files >= max_scan {
                    partial = true;
                    partial_reason = Some("budget");
                    break;
                }
                let Some(path) = candidate.source_file(inputs) else {
                    continue;
                };
                if !matches!(candidate.provider(inputs), "claude" | "codex") {
                    continue;
                }
                scanned_files += 1;
                let tier = file_search_tier(&q.tier).expect("file search tier");
                match search_session_file(path, candidate.provider(inputs), query, tier) {
                    Ok(Some(found)) => {
                        let annotation = SearchAnnotation {
                            matched_in: found.matched_in.to_string(),
                            snippet: found.snippet,
                        };
                        #[cfg(test)]
                        record_preparation(|counts| counts.search_annotations += 1);
                        Some(annotation)
                    }
                    Ok(None) => continue,
                    Err(_) => {
                        partial = true;
                        if partial_reason.is_none() {
                            partial_reason = Some("io_error");
                        }
                        continue;
                    }
                }
            }
        };
        rows.push(SelectedCandidate {
            candidate,
            annotation,
        });
        #[cfg(test)]
        record_preparation(|counts| {
            counts.retained_descriptor_peak = counts.retained_descriptor_peak.max(rows.len());
        });
    }

    CandidatePage {
        rows,
        partial,
        partial_reason,
    }
}
```

Task 7 Step 5 applies its existing exact push/counter/bound replacement to either representation. Do not install the bound before the five named RED observations.

The deep API's owned `snippet: String` is intentionally counted as soon as it exists.

- [ ] **Step 3: Add five deterministic work-bound route tests.**

Inside `page_bound_tests`, add:

```rust
    #[tokio::test(flavor = "current_thread")]
    async fn no_search_materializes_only_returned_indexed_rows_not_lookahead() {
        let rows = (0..100)
            .map(|index| {
                indexed_row(
                    &format!("s-{index:03}"),
                    10_000 - index as i64,
                    Some("visible"),
                )
            })
            .collect();
        let harness = directory_route_harness(rows);
        let scope = begin_preparation_scope();
        let page = get_page(harness.app.clone(), "&limit=2").await;
        let counts = scope.finish();
        assert_eq!(page["items"].as_array().expect("items").len(), 2);
        assert!(page_cursor(&page).is_some());
        assert_eq!(
            counts,
            PreparationCounts {
                indexed_full: 2,
                synthesized_full: 0,
                override_decoration: 2,
                metadata_decoration: 2,
                running_decoration: 2,
                serialization: 2,
                retained_descriptor_peak: 3,
                search_annotations: 0,
            }
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn no_search_materializes_only_returned_synthesized_rows_not_lookahead() {
        let harness = directory_route_harness(Vec::new());
        for index in 0..100 {
            harness.identity.upsert(
                &format!("terminal-{index:03}"),
                Some("claude"),
                Some(&format!("live-{index:03}")),
                Some("/live"),
                10_000 - index as i64,
            );
        }
        let scope = begin_preparation_scope();
        let page = get_page(harness.app.clone(), "&limit=2").await;
        let counts = scope.finish();
        assert_eq!(page["items"].as_array().expect("items").len(), 2);
        assert!(page_cursor(&page).is_some());
        assert_eq!(
            counts,
            PreparationCounts {
                indexed_full: 0,
                synthesized_full: 2,
                override_decoration: 0,
                metadata_decoration: 0,
                running_decoration: 0,
                serialization: 2,
                retained_descriptor_peak: 3,
                search_annotations: 0,
            }
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn no_search_long_deleted_and_hidden_prefix_materializes_only_backfilled_rows() {
        let mut rows = Vec::new();
        for index in 0..20 {
            rows.push(indexed_row(
                &format!("deleted-{index:02}"),
                5_000 - index as i64,
                Some("deleted"),
            ));
        }
        for index in 0..20 {
            let mut row = indexed_row(
                &format!("subagent-{index:02}"),
                4_000 - index as i64,
                Some("subagent"),
            );
            row.is_subagent = true;
            rows.push(row);
        }
        for index in 0..20 {
            let mut row = indexed_row(
                &format!("noninteractive-{index:02}"),
                3_000 - index as i64,
                Some("noninteractive"),
            );
            row.is_non_interactive = true;
            rows.push(row);
        }
        for index in 0..20 {
            rows.push(indexed_row(
                &format!("empty-{index:02}"),
                2_000 - index as i64,
                None,
            ));
        }
        for index in 0..12 {
            rows.push(indexed_row(
                &format!("visible-{index:02}"),
                1_000 - index as i64,
                Some("visible"),
            ));
        }
        let harness = directory_route_harness(rows);
        for index in 0..20 {
            harness
                .settings
                .patch_session_override(
                    &format!("claude:deleted-{index:02}"),
                    &[("deleted", Some(json!(true)))],
                )
                .await;
        }
        let first = get_page(harness.app.clone(), "&limit=1").await;
        assert_eq!(item_ids(&first), vec!["visible-00"]);
        let cursor = page_cursor(&first).expect("cursor");
        let scope = begin_preparation_scope();
        let page = get_page(
            harness.app.clone(),
            &format!("&limit=2&cursor={cursor}"),
        )
        .await;
        let counts = scope.finish();
        assert_eq!(item_ids(&page), vec!["visible-01", "visible-02"]);
        assert!(page_cursor(&page).is_some());
        assert_eq!(
            counts,
            PreparationCounts {
                indexed_full: 2,
                synthesized_full: 0,
                override_decoration: 2,
                metadata_decoration: 2,
                running_decoration: 2,
                serialization: 2,
                retained_descriptor_peak: 3,
                search_annotations: 0,
            }
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn no_search_all_filtered_corpus_materializes_zero_rows() {
        let rows = (0..100)
            .map(|index| {
                let mut row = indexed_row(
                    &format!("hidden-{index:03}"),
                    10_000 - index as i64,
                    Some("hidden"),
                );
                row.is_subagent = true;
                row
            })
            .collect();
        let harness = directory_route_harness(rows);
        let scope = begin_preparation_scope();
        let page = get_page(harness.app.clone(), "&limit=2").await;
        let counts = scope.finish();
        assert!(item_ids(&page).is_empty());
        assert!(page_cursor(&page).is_none());
        assert_eq!(page["revision"], json!(10_000));
        assert_eq!(counts, PreparationCounts::default());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn title_search_scans_sparse_corpus_but_materializes_only_returned_rows() {
        let mut rows: Vec<IndexedSession> = (0..101)
            .map(|index| {
                indexed_row(
                    &format!("nonmatch-{index:03}"),
                    20_000 - index as i64,
                    Some("visible nonmatch"),
                )
            })
            .collect();
        for index in 0..3 {
            rows.push(indexed_row(
                &format!("match-{index:02}"),
                1_000 - index as i64,
                Some("sparse needle match"),
            ));
        }
        let harness = directory_route_harness(rows);
        let scope = begin_preparation_scope();
        let page = get_page(
            harness.app.clone(),
            "&query=needle&tier=title&limit=1",
        )
        .await;
        let counts = scope.finish();
        assert_eq!(item_ids(&page), vec!["match-00"]);
        assert!(page_cursor(&page).is_some());
        assert_eq!(
            counts,
            PreparationCounts {
                indexed_full: 1,
                synthesized_full: 0,
                override_decoration: 1,
                metadata_decoration: 1,
                running_decoration: 1,
                serialization: 1,
                retained_descriptor_peak: 2,
                search_annotations: 2,
            }
        );
    }
```

Add the two retained tests that make the final Task-7 addition count seven:

```rust
    #[tokio::test(flavor = "current_thread")]
    async fn deep_search_owns_only_limit_plus_one_annotations_and_materializes_only_returned_rows() {
        let home = tempfile::tempdir().expect("transcript home");
        let mut rows = Vec::new();
        for index in 0..3 {
            let path = home.path().join(format!("match-{index}.jsonl"));
            std::fs::write(
                &path,
                format!(
                    "{{\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":\"needle deep {index}\"}}}}\n"
                ),
            )
            .expect("write matching transcript");
            let mut row = indexed_row(
                &format!("deep-{index}"),
                1_000 - index,
                Some("visible"),
            );
            row.source_file = Some(path);
            rows.push(row);
        }
        let harness = directory_route_harness(rows);
        let scope = begin_preparation_scope();
        let page = get_page(
            harness.app.clone(),
            "&query=needle&tier=userMessages&limit=1",
        )
        .await;
        let counts = scope.finish();
        assert_eq!(item_ids(&page), vec!["deep-0"]);
        assert!(page_cursor(&page).is_some());
        assert_eq!(page["items"][0]["matchedIn"], json!("userMessage"));
        assert_eq!(page["items"][0]["snippet"], json!("needle deep 0"));
        assert_eq!(
            counts,
            PreparationCounts {
                indexed_full: 1,
                synthesized_full: 0,
                override_decoration: 1,
                metadata_decoration: 1,
                running_decoration: 1,
                serialization: 1,
                retained_descriptor_peak: 2,
                search_annotations: 2,
            }
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn preparation_scope_ignores_unscoped_requests_and_resets_between_current_thread_intervals() {
        let harness = directory_route_harness(vec![indexed_row(
            "measured",
            100,
            Some("visible"),
        )]);
        let _ = get_page(harness.app.clone(), "&limit=1").await;

        let scope = begin_preparation_scope();
        let page = get_page(harness.app.clone(), "&limit=1").await;
        assert_eq!(item_ids(&page), vec!["measured"]);
        assert_eq!(
            scope.finish(),
            PreparationCounts {
                indexed_full: 1,
                synthesized_full: 0,
                override_decoration: 1,
                metadata_decoration: 1,
                running_decoration: 1,
                serialization: 1,
                retained_descriptor_peak: 1,
                search_annotations: 0,
            }
        );

        let _ = get_page(harness.app.clone(), "&limit=1").await;
        assert_eq!(begin_preparation_scope().finish(), PreparationCounts::default());

        let outer = begin_preparation_scope();
        assert!(std::panic::catch_unwind(begin_preparation_scope).is_err());
        assert_eq!(outer.finish(), PreparationCounts::default());

        assert!(
            std::panic::catch_unwind(|| {
                let _scope = begin_preparation_scope();
                panic!("exercise guard cleanup");
            })
            .is_err()
        );
        assert_eq!(begin_preparation_scope().finish(), PreparationCounts::default());
    }
```

This narrow scope observes one non-overlapped current-thread interval only. Candidate derivation is synchronous after the final await; the proof does not attribute arbitrary or overlapping async requests.

Final counter ledger:

| Scenario | Descriptor peak | Annotations | Full materializations |
|---|---:|---:|---:|
| indexed, limit 2 | 3 | 0 | 2 indexed |
| synthesized, limit 2 | 3 | 0 | 2 synthesized |
| filtered/cursor, limit 2 | 3 | 0 | 2 indexed |
| all hidden | 0 | 0 | 0 |
| sparse title, limit 1 | 2 | 2 | 1 indexed |
| deep lookahead, limit 1 | 2 | 2 | 1 indexed |
| scope measured one-row request | 1 | 0 | 1 indexed |

- [ ] **Step 4: Record the required RED counts against Task 6 and the GREEN scope control.**

```bash
for test_name in \
  no_search_materializes_only_returned_indexed_rows_not_lookahead \
  no_search_materializes_only_returned_synthesized_rows_not_lookahead \
  no_search_long_deleted_and_hidden_prefix_materializes_only_backfilled_rows \
  title_search_scans_sparse_corpus_but_materializes_only_returned_rows \
  deep_search_owns_only_limit_plus_one_annotations_and_materializes_only_returned_rows
do
  set +e
  env CARGO_TERM_COLOR=never \
    cargo test --manifest-path "$MANIFEST" \
      -p freshell-server --bin freshell-server \
      "session_directory::page_bound_tests::$test_name" -- \
      --exact --color=never --test-threads=1 \
    2>&1 | tee "$LOG_ROOT/task7-red-$test_name.log"
  status=${PIPESTATUS[0]}
  printf 'exit_code=%s\n' "$status" \
    | tee "$LOG_ROOT/task7-red-$test_name.exit"
  set -e
  test "$status" -ne 0
done
run_logged task7-scope-reset-control \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    'session_directory::page_bound_tests::preparation_scope_ignores_unscoped_requests_and_resets_between_current_thread_intervals' -- \
    --exact --color=never --test-threads=1
```

Expected RED:

```text
indexed corpus: indexed_full 100 and retained peak 100; expected 2 and 3
synthesized corpus: synthesized_full 100 and retained peak 100; expected 2 and 3
long filtered/cursor corpus: indexed_full 11 and retained peak 11; expected 2 and 3
sparse title search: indexed_full 3, retained peak 3, annotations 3; expected 1, 2, 2
deep lookahead: indexed_full 2; expected 1; retained peak and annotations are correctly 2
```

The all-hidden test may already pass at zero because visibility precedes materialization. The scope reset/negative-control test must be GREEN before the bound change.

- [ ] **Step 5: Bound retained descriptors for no-search and title while preserving deep loop order.**

After pushing a no-search or title match, add the descriptor bound; retain the deep branch's pre-source `rows.len() > limit` check exactly:

```rust
        rows.push(SelectedCandidate {
            candidate,
            annotation,
        });
        #[cfg(test)]
        record_preparation(|counts| {
            counts.retained_descriptor_peak =
                counts.retained_descriptor_peak.max(rows.len());
        });
        if !matches!(&q.tier, Tier::UserMessages | Tier::FullText) || query.is_none() {
            if rows.len() > limit {
                break;
            }
        }
```

The deep branch remains:

```rust
                if rows.len() > limit {
                    break;
                }
                if scanned_files >= max_scan {
                    partial = true;
                    partial_reason = Some("budget");
                    break;
                }
```

This avoids moving budget behind source/provider checks.

- [ ] **Step 6: Materialize only returned descriptors.**

Replace `derive_directory_page` with:

```rust
fn derive_directory_page(
    inputs: DirectoryInputs<'_>,
    q: &DirQuery,
) -> Result<Value, String> {
    let limit = q
        .limit
        .unwrap_or(MAX_DIRECTORY_PAGE_ITEMS)
        .min(MAX_DIRECTORY_PAGE_ITEMS);
    let cursor = q.cursor.as_deref().map(decode_cursor).transpose()?;
    let candidates = build_directory_candidates(
        inputs.indexed,
        inputs.overrides,
        inputs.identities,
    );
    let revision = candidates
        .iter()
        .map(|candidate| candidate.order_key().last_activity_at)
        .chain(inputs.identities.iter().map(|identity| identity.updated_at))
        .max()
        .unwrap_or(0)
        .max(0);
    let selected = select_page_candidates(candidates, q, cursor.as_ref(), limit);
    let has_more = selected.rows.len() > limit;
    let next_cursor = has_more.then(|| {
        let tail = selected.rows[limit - 1].candidate.order_key();
        encode_cursor(tail.last_activity_at, tail.key)
    });
    let items = selected
        .rows
        .iter()
        .take(limit)
        .map(|selected| {
            materialize_selected_candidate(selected, inputs.metadata).to_value()
        })
        .collect::<Vec<_>>();
    let mut page = json!({
        "items": items,
        "nextCursor": next_cursor,
        "revision": revision,
    });
    if selected.partial {
        page["partial"] = Value::Bool(true);
        if let Some(reason) = selected.partial_reason {
            page["partialReason"] = Value::String(reason.to_string());
        }
    }
    Ok(page)
}
```

If `fallback_used=1`, use the following as the complete Step-6 replacement; otherwise use the borrowed definition above:

```rust
fn derive_directory_page(inputs: DirectoryInputs<'_>, q: &DirQuery) -> Result<Value, String> {
    let limit = q
        .limit
        .unwrap_or(MAX_DIRECTORY_PAGE_ITEMS)
        .min(MAX_DIRECTORY_PAGE_ITEMS);
    let cursor = q.cursor.as_deref().map(decode_cursor).transpose()?;
    let candidates =
        build_directory_candidates(inputs.indexed, inputs.overrides, inputs.identities);
    let revision = candidates
        .iter()
        .map(|candidate| candidate.order_key(inputs).last_activity_at)
        .chain(inputs.identities.iter().map(|identity| identity.updated_at))
        .max()
        .unwrap_or(0)
        .max(0);
    let selected = select_page_candidates(candidates, inputs, q, cursor.as_ref(), limit);
    let has_more = selected.rows.len() > limit;
    let next_cursor = has_more.then(|| {
        let tail = selected.rows[limit - 1].candidate.order_key(inputs);
        encode_cursor(tail.last_activity_at, tail.key)
    });
    let items = selected
        .rows
        .iter()
        .take(limit)
        .map(|selected| {
            materialize_selected_candidate(selected, inputs).to_value()
        })
        .collect::<Vec<_>>();
    let mut page = json!({
        "items": items,
        "nextCursor": next_cursor,
        "revision": revision,
    });
    if selected.partial {
        page["partial"] = Value::Bool(true);
        if let Some(reason) = selected.partial_reason {
            page["partialReason"] = Value::String(reason.to_string());
        }
    }
    Ok(page)
}
```

The fallback materializer accepts `inputs`, so this definition is type-consistent and materializes only `.take(limit)` descriptors.

- [ ] **Step 7: Run the lexical source-wide work-site audit.**

The audit inventories final source after Task-6 deletion and selects exactly one persisted representation profile. It retains the exact constructor/helper/decorator/annotation/serializer/order checks. In addition, it inventories every syntactic `clone`, `clone_from`, `clone_into`, `to_owned`, `to_vec`, `cloned`, `collect`, qualified `clone`/`to_owned`/`to_vec`, `Vec::from`, `from_iter`, and qualified collect site in every recursively reachable production policy function, with exact owner/kind/canonical-expression allowlists. A second typed-binding pass runs across every production, oracle, and test function. It tracks `IndexedSession`, `Vec<IndexedSession>`, and `[IndexedSession]` category plus reference depth through explicit types, unary borrow/deref, aliases, closure parameters, direct `for row in rows` sources, and `.iter()`/`.iter_mut()`/`.into_iter()` loop sources. Operation-sensitive classification rejects row/vector value clones and every enumerated slice/vector materialization, including inherent/trait-qualified `<[IndexedSession]>::to_vec(rows)` and `to_owned` forms, while explicitly accepting clones whose result is only an already-borrowed row/container reference (for example `rows.clone()` for `rows: &[IndexedSession]` and `Clone::clone(&rows)`). The sole genuine full-row-copy exception is the existing `StaticSessionSource::parse` fixture expression `row.clone()`; the oracle exception set is empty. This is a masked-source syntactic proof over explicit bindings and enumerated standard forms. It is not a Rust typechecker, macro-expansion proof, arbitrary custom-wrapper detector, semantic equivalence proof, or allocator proof.

```bash
case "$(cat "$LOG_ROOT/task6-fallback-used.txt")" in
  fallback_used=0) A08_PROFILE=borrowed ;;
  fallback_used=1) A08_PROFILE=indexed-provenance ;;
  *)
    printf 'invalid or missing Task-6 representation marker\n' >&2
    exit 1
    ;;
esac
python3 -I - "$WT/$SOURCE_REL" "$A08_PROFILE" <<'PY' \
  | tee "$LOG_ROOT/task7-work-sites.txt"
from pathlib import Path
import re
import sys
from collections import Counter, deque
from dataclasses import dataclass


class AuditFailure(RuntimeError):
    pass


def require(condition: bool, message: object) -> None:
    if not condition:
        raise AuditFailure(str(message))


path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
profile = sys.argv[2]
require(profile in {"borrowed", "indexed-provenance"}, f"unknown profile: {profile}")


def blank(buffer: list[str], start: int, end: int) -> None:
    for index in range(start, end):
        if buffer[index] != "\n":
            buffer[index] = " "


def mask_rust(source: str) -> str:
    masked = list(source)
    index = 0
    length = len(source)
    while index < length:
        if source.startswith("//", index):
            end = source.find("\n", index)
            end = length if end < 0 else end
            blank(masked, index, end)
            index = end
            continue
        if source.startswith("/*", index):
            start = index
            depth = 1
            index += 2
            while index < length and depth:
                if source.startswith("/*", index):
                    depth += 1
                    index += 2
                elif source.startswith("*/", index):
                    depth -= 1
                    index += 2
                else:
                    index += 1
            require(depth == 0, f"unterminated block comment at {start}")
            blank(masked, start, index)
            continue
        raw = re.match(r"(?:br|rb|r)(?P<hashes>#+)?\"", source[index:])
        if raw:
            start = index
            hashes = raw.group("hashes") or ""
            index += raw.end()
            terminator = '"' + hashes
            end = source.find(terminator, index)
            require(end >= 0, f"unterminated raw string at {start}")
            index = end + len(terminator)
            blank(masked, start, index)
            continue
        quote_start = index + 1 if source[index:index + 2] in {'b"', 'b\''} else index
        quote = source[quote_start] if quote_start < length else ""
        if quote == '"':
            start = index
            index = quote_start + 1
            while index < length:
                if source[index] == "\\":
                    index += 2
                elif source[index] == '"':
                    index += 1
                    break
                else:
                    index += 1
            else:
                raise AuditFailure(f"unterminated string at {start}")
            blank(masked, start, index)
            continue
        if quote == "'":
            # Parse exactly one Rust character escape/scalar followed by a quote;
            # lifetimes such as 'a have no closing quote at that position.
            cursor = quote_start + 1
            if cursor < length and source[cursor] == "\\":
                if source.startswith("\\u{", cursor):
                    close = source.find("}", cursor + 3)
                    require(
                        close >= 0,
                        f"unterminated unicode character escape at {index}",
                    )
                    cursor = close + 1
                elif source.startswith("\\x", cursor):
                    cursor += 4
                else:
                    cursor += 2
            else:
                cursor += 1
            if cursor < length and source[cursor] == "'":
                start = index
                index = cursor + 1
                blank(masked, start, index)
                continue
        index += 1
    result = "".join(masked)
    require(len(result) == len(source), "mask changed character length")
    require(
        [i for i, char in enumerate(result) if char == "\n"]
        == [i for i, char in enumerate(source) if char == "\n"],
        "mask changed newline positions",
    )
    return result


masked = mask_rust(text)


def line_number(offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def balanced_block(open_brace: int) -> tuple[int, int]:
    depth = 0
    for offset in range(open_brace, len(masked)):
        if masked[offset] == "{":
            depth += 1
        elif masked[offset] == "}":
            depth -= 1
            if depth == 0:
                return open_brace, offset + 1
    raise AuditFailure(f"unterminated block at character offset {open_brace}")


def anchored_block(anchor: str) -> tuple[int, int, str, str]:
    require(masked.count(anchor) == 1, f"anchor count: {anchor}")
    start = masked.index(anchor)
    brace = masked.index("{", start)
    _, end = balanced_block(brace)
    return start, end, text[start:end], masked[start:end]


@dataclass(frozen=True)
class FunctionDef:
    name: str
    declaration_start: int
    name_start: int
    body_start: int
    end: int
    original: str
    masked: str
    test_only: bool
    oracle_only: bool


oracle_function_names = {
    "item_from_meta",
    "parse_claude_file",
    "list_claude_sessions",
}
test_ranges = [
    anchored_block("mod join_tests {")[:2],
    anchored_block("mod tests {")[:2],
    anchored_block("mod page_bound_tests {")[:2],
]
function_pattern = re.compile(
    r"(?m)^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?"
    r"(?:const[ \t]+)?(?:async[ \t]+)?(?:unsafe[ \t]+)?"
    r"fn[ \t]+(?P<name>[A-Za-z_][A-Za-z0-9_]*)\b"
)


def definition_body_start(signature_end: int) -> int | None:
    parentheses = 0
    brackets = 0
    angles = 0
    for offset in range(signature_end, len(masked)):
        character = masked[offset]
        if character == "(":
            parentheses += 1
        elif character == ")":
            require(parentheses > 0, f"unbalanced function signature at {offset}")
            parentheses -= 1
        elif character == "[":
            brackets += 1
        elif character == "]":
            require(brackets > 0, f"unbalanced function signature at {offset}")
            brackets -= 1
        elif character == "<":
            angles += 1
        elif character == ">" and angles:
            angles -= 1
        elif character == "{" and not (parentheses or brackets or angles):
            return offset
        elif character == ";" and not (parentheses or brackets or angles):
            return None
    return None


def has_cfg_test_attribute(declaration_start: int) -> bool:
    prefix_start = masked.rfind("\n\n", 0, declaration_start)
    prefix = masked[prefix_start + 2:declaration_start]
    return re.search(r"#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]", prefix) is not None


functions: list[FunctionDef] = []
for match in function_pattern.finditer(masked):
    brace = definition_body_start(match.end())
    if brace is None:
        continue
    _, end = balanced_block(brace)
    name = match.group("name")
    cfg_test_gated = has_cfg_test_attribute(match.start())
    oracle_only = name in oracle_function_names
    if oracle_only:
        require(
            cfg_test_gated,
            f"parser oracle must retain #[cfg(test)]: {name}",
        )
    test_only = not oracle_only and (
        cfg_test_gated
        or any(
            start <= match.start() < module_end
            for start, module_end in test_ranges
        )
    )
    functions.append(
        FunctionDef(
            name=name,
            declaration_start=match.start(),
            name_start=match.start("name"),
            body_start=brace,
            end=end,
            original=text[match.start():end],
            masked=masked[match.start():end],
            test_only=test_only,
            oracle_only=oracle_only,
        )
    )


def owner(offset: int) -> FunctionDef:
    owners = [
        function
        for function in functions
        if function.body_start <= offset < function.end
    ]
    require(bool(owners), f"site at line {line_number(offset)} has no owner")
    return min(owners, key=lambda function: function.end - function.body_start)


def declaration_offset(offset: int) -> bool:
    return any(
        function.declaration_start <= offset < function.body_start
        for function in functions
    )


def classify(offsets: list[int]) -> Counter[str]:
    result: Counter[str] = Counter()
    for offset in sorted(set(offsets)):
        function = owner(offset)
        if function.test_only:
            scope = "test"
        elif function.oracle_only:
            scope = "oracle"
        else:
            scope = "production"
        key = f"{scope}:{function.name}"
        result[key] += 1
        print(f"site owner={key} line={line_number(offset)}")
    return result


def symbol_references(symbol: str) -> list[int]:
    definition_names = {function.name_start for function in functions}
    return [
        match.start()
        for match in re.finditer(rf"\b{re.escape(symbol)}\b", masked)
        if not declaration_offset(match.start())
        and match.start() not in definition_names
    ]


def function_named(
    name: str,
    *,
    test_only: bool | None = None,
    oracle_only: bool | None = None,
) -> FunctionDef:
    matches = [
        function
        for function in functions
        if function.name == name
        and (test_only is None or function.test_only == test_only)
        and (oracle_only is None or function.oracle_only == oracle_only)
    ]
    require(len(matches) == 1, f"function count for {name}: {len(matches)}")
    return matches[0]


handler = function_named("session_directory", test_only=False)
builder = function_named("build_directory_candidates", test_only=False)
selector = function_named("select_page_candidates", test_only=False)
title = function_named("title_search_annotation", test_only=False)
materializer = function_named("materialize_selected_candidate", test_only=False)
derive = function_named("derive_directory_page", test_only=False)
serializer = function_named("to_value", test_only=False)
parser_oracle = function_named(
    "item_from_meta", test_only=False, oracle_only=True
)
representation_markers = {
    "borrowed": {
        "required": {
            "struct IndexedOverlay<'a>",
            "enum SynthesizedSessionId<'a>",
            "enum DirectoryCandidateSource<'a>",
            "struct DirectoryCandidate<'a>",
            "struct SelectedCandidate<'a>",
            "struct CandidatePage<'a>",
        },
        "forbidden": {
            "enum IndexedValueSource",
            "struct IndexedOverlayIndex",
            "enum SynthesizedSessionIdSource",
        },
    },
    "indexed-provenance": {
        "required": {
            "enum IndexedValueSource",
            "struct IndexedOverlayIndex",
            "enum SynthesizedSessionIdSource",
            "enum DirectoryCandidateSource {",
            "struct DirectoryCandidate {",
            "struct SelectedCandidate {",
            "struct CandidatePage {",
        },
        "forbidden": {
            "struct IndexedOverlay<'a>",
            "enum SynthesizedSessionId<'a>",
            "enum DirectoryCandidateSource<'a>",
        },
    },
}
for marker in representation_markers[profile]["required"]:
    require(masked.count(marker) == 1, f"required {profile} marker: {marker}")
for marker in representation_markers[profile]["forbidden"]:
    require(marker not in masked, f"forbidden {profile} marker: {marker}")

for oracle_name in oracle_function_names:
    function_named(oracle_name, test_only=False, oracle_only=True)
item_from_meta_references = classify(symbol_references("item_from_meta"))
require(
    item_from_meta_references == Counter({
        "oracle:parse_claude_file": 1,
        "test:item_from_meta_maps_fields_and_fallback_session_id": 1,
        "test:no_uuid_item_falls_back_to_file_basename": 1,
    }),
    f"item_from_meta oracle-reference allowlist: {item_from_meta_references}",
)
parse_claude_references = classify(symbol_references("parse_claude_file"))
require(
    parse_claude_references == Counter({"oracle:list_claude_sessions": 2}),
    f"parse_claude_file oracle-reference allowlist: {parse_claude_references}",
)
list_claude_references = classify(symbol_references("list_claude_sessions"))
require(
    list_claude_references == Counter({
        "test:invalid_utf8_transcript_is_indexed_lossily_like_node": 1,
        "test:missing_home_projects_yields_empty_list": 1,
        "test:b_t1_claude_source_matches_list_claude_sessions_reference_scan": 1,
    }),
    f"list_claude_sessions parser/index-test allowlist: {list_claude_references}",
)

require(masked.count("fn materialize_selected_candidate(") == 1, "materializer definition")
require(masked.count("fn to_value(&self) -> Value {") == 1, "serializer definition")

type_declarations: list[tuple[str, int, int]] = []
for match in re.finditer(
    r"(?m)^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?"
    r"(?:struct|enum|impl)[ \t]+(?P<name>DirItem|SearchAnnotation)\b",
    masked,
):
    brace = masked.find("{", match.end())
    semicolon = masked.find(";", match.end())
    require(
        brace >= 0 and (semicolon < 0 or brace < semicolon),
        f"target type is not braced: {match.group('name')}",
    )
    type_declarations.append((match.group("name"), match.start(), brace))


def type_declaration_offset(offset: int) -> bool:
    return any(start <= offset < brace for _name, start, brace in type_declarations)


def constructor_spans(type_name: str) -> list[tuple[int, int]]:
    spans: list[tuple[int, int]] = []
    for match in re.finditer(rf"\b{re.escape(type_name)}\s*\{{", masked):
        if type_declaration_offset(match.start()) or declaration_offset(match.start()):
            continue
        brace = masked.index("{", match.start())
        _, end = balanced_block(brace)
        spans.append((match.start(), end))
    return spans


def canonical(source: str) -> str:
    return re.sub(r"\s+", "", mask_rust(source))


borrowed_indexed_constructor = canonical(r'''
DirItem {
    session_id: row.session_id.clone(),
    provider: row.provider.clone(),
    project_path: row.project_path.clone(),
    title: overlay.effective_title.map(str::to_string),
    summary: overlay.effective_summary.map(str::to_string),
    first_user_message: row.first_user_message.clone(),
    last_activity_at: row.last_activity_at,
    created_at: row.created_at,
    cwd: row.cwd.clone(),
    is_subagent: row.is_subagent,
    is_non_interactive: row.is_non_interactive,
    is_running: running_identity.is_some(),
    archived: overlay.archived,
    matched_in: selected.annotation.as_ref()
        .map(|annotation| annotation.matched_in.clone()),
    snippet: selected.annotation.as_ref()
        .map(|annotation| annotation.snippet.clone()),
    running_terminal_id: running_identity
        .map(|identity| identity.terminal_id.clone()),
    live_terminal_only: false,
    session_type,
}
''')
borrowed_synthesized_constructor = canonical(r'''
DirItem {
    session_id,
    provider: (*provider).to_string(),
    project_path: identity.cwd.clone()
        .unwrap_or_else(|| terminal_fallback.clone()),
    title: Some(provider_display_name(provider).to_string()),
    summary: None,
    first_user_message: None,
    last_activity_at: identity.updated_at,
    created_at: Some(identity.updated_at),
    cwd: identity.cwd.clone(),
    is_subagent: identity.is_subagent.unwrap_or(false),
    is_non_interactive: false,
    is_running: true,
    archived: false,
    matched_in: selected.annotation.as_ref()
        .map(|annotation| annotation.matched_in.clone()),
    snippet: selected.annotation.as_ref()
        .map(|annotation| annotation.snippet.clone()),
    running_terminal_id: Some(identity.terminal_id.clone()),
    live_terminal_only,
    session_type: Some((*provider).to_string()),
}
''')
indexed_indexed_constructor = canonical(r'''
DirItem {
    session_id: row.session_id.clone(),
    provider: row.provider.clone(),
    project_path: row.project_path.clone(),
    title: selected.candidate.effective_title(inputs).map(str::to_string),
    summary: selected.candidate.effective_summary(inputs).map(str::to_string),
    first_user_message: row.first_user_message.clone(),
    last_activity_at: row.last_activity_at,
    created_at: row.created_at,
    cwd: row.cwd.clone(),
    is_subagent: row.is_subagent,
    is_non_interactive: row.is_non_interactive,
    is_running: running_identity.is_some(),
    archived: overlay.archived,
    matched_in: selected.annotation.as_ref()
        .map(|annotation| annotation.matched_in.clone()),
    snippet: selected.annotation.as_ref()
        .map(|annotation| annotation.snippet.clone()),
    running_terminal_id: running_identity
        .map(|identity| identity.terminal_id.clone()),
    live_terminal_only: false,
    session_type,
}
''')
indexed_synthesized_constructor = canonical(r'''
DirItem {
    session_id,
    provider: provider.to_string(),
    project_path: identity.cwd.clone()
        .unwrap_or_else(|| terminal_fallback.clone()),
    title: Some(provider_display_name(provider).to_string()),
    summary: None,
    first_user_message: None,
    last_activity_at: identity.updated_at,
    created_at: Some(identity.updated_at),
    cwd: identity.cwd.clone(),
    is_subagent: identity.is_subagent.unwrap_or(false),
    is_non_interactive: false,
    is_running: true,
    archived: false,
    matched_in: selected.annotation.as_ref()
        .map(|annotation| annotation.matched_in.clone()),
    snippet: selected.annotation.as_ref()
        .map(|annotation| annotation.snippet.clone()),
    running_terminal_id: Some(identity.terminal_id.clone()),
    live_terminal_only,
    session_type: Some(provider.to_string()),
}
''')
expected_constructors = {
    "borrowed": (
        borrowed_indexed_constructor,
        borrowed_synthesized_constructor,
    ),
    "indexed-provenance": (
        indexed_indexed_constructor,
        indexed_synthesized_constructor,
    ),
}[profile]
expected_indexed_constructor, expected_synthesized_constructor = expected_constructors

dir_item_spans = constructor_spans("DirItem")
dir_item_offsets = [start for start, _end in dir_item_spans]
require(
    classify(dir_item_offsets) == Counter({
        "production:materialize_selected_candidate": 2,
        "oracle:item_from_meta": 1,
    }),
    "DirItem constructor owner allowlist",
)
production_constructor_bodies = Counter(
    canonical(text[start:end])
    for start, end in dir_item_spans
    if not owner(start).test_only and not owner(start).oracle_only
)
require(
    production_constructor_bodies == Counter({
        expected_indexed_constructor: 1,
        expected_synthesized_constructor: 1,
    }),
    "complete production DirItem initializer expressions changed",
)
for start, end in dir_item_spans:
    print(
        f"DirItem initializer owner={owner(start).name} "
        f"line={line_number(start)} expression={canonical(text[start:end])}"
    )

production_functions = [
    function
    for function in functions
    if not function.test_only and not function.oracle_only
]
production_names = {function.name for function in production_functions}


def production_function(name: str) -> FunctionDef:
    matches = [function for function in production_functions if function.name == name]
    require(len(matches) == 1, f"production function count for {name}: {len(matches)}")
    return matches[0]


def local_references(function: FunctionDef) -> set[str]:
    result: set[str] = set()
    base = function.declaration_start
    for match in re.finditer(r"\b([A-Za-z_][A-Za-z0-9_]*)\b", function.masked):
        global_offset = base + match.start(1)
        if declaration_offset(global_offset):
            continue
        name = match.group(1)
        if name not in production_names:
            continue
        before = function.masked[:match.start(1)].rstrip()
        after = function.masked[match.end(1):].lstrip()
        call_or_method = after.startswith("(")
        path_function_item = (
            before.endswith("::")
            and (not after or after[0] in ",;)]}")
        )
        bare_function_item = (
            bool(before)
            and (
                before.endswith("=")
                or re.search(
                    r"\.(?:map|and_then|or_else|then|filter|find|position)"
                    r"\(\s*$",
                    before,
                )
                is not None
            )
            and (not after or after[0] in ",;)]}")
        )
        if call_or_method or path_function_item or bare_function_item:
            result.add(name)
    return result


bounded_work_owners = {
    "build_directory_candidates",
    "title_search_annotation",
    "select_page_candidates",
    "materialize_selected_candidate",
    "derive_directory_page",
    "encode_cursor",
    "decode_cursor",
    "to_value",
}
bounded_functions = {
    name: production_function(name)
    for name in bounded_work_owners
}

borrowed_local_references = {
    "build_directory_candidates": {
        "first_identity_by_exact_session", "resolve_indexed_overlay",
    },
    "title_search_annotation": {
        "effective_title", "effective_summary", "first_user_message",
    },
    "select_page_candidates": {
        "compare_directory_order", "order_key",
        "candidate_is_visible", "candidate_is_strictly_after_cursor",
        "title_search_annotation", "source_file", "provider",
        "file_search_tier",
    },
    "materialize_selected_candidate": {"provider_display_name"},
    "derive_directory_page": {
        "decode_cursor", "build_directory_candidates", "order_key",
        "select_page_candidates", "encode_cursor",
        "materialize_selected_candidate", "to_value",
    },
    "encode_cursor": set(),
    "decode_cursor": set(),
    "to_value": set(),
    "first_identity_by_exact_session": set(),
    "resolve_indexed_overlay": set(),
    "order_key": set(),
    "provider": set(),
    "effective_title": {"provider_display_name"},
    "effective_summary": set(),
    "first_user_message": set(),
    "is_subagent": set(),
    "is_non_interactive": set(),
    "is_running": set(),
    "source_file": set(),
    "compare_directory_order": set(),
    "candidate_is_strictly_after_cursor": {
        "compare_directory_order", "order_key",
    },
    "candidate_is_visible": {
        "is_subagent", "is_non_interactive", "is_running", "effective_title",
    },
    "file_search_tier": set(),
    "provider_display_name": set(),
}
indexed_local_references = {
    **borrowed_local_references,
    "effective_title": {
        "provider_display_name", "provider", "resolved_title",
    },
    "effective_summary": {"resolved_summary"},
    "materialize_selected_candidate": {
        "provider_display_name", "effective_title", "effective_summary",
    },
    "resolved_title": set(),
    "resolved_summary": set(),
}
expected_local_references = {
    "borrowed": borrowed_local_references,
    "indexed-provenance": indexed_local_references,
}[profile]

reachable_functions: set[FunctionDef] = set(bounded_functions.values())
queue = deque(bounded_functions.values())
while queue:
    source_function = queue.popleft()
    for referenced_name in local_references(source_function):
        for target in production_functions:
            if target.name == referenced_name and target not in reachable_functions:
                reachable_functions.add(target)
                queue.append(target)
reachable_names = {function.name for function in reachable_functions}
require(
    reachable_names == set(expected_local_references),
    f"{profile} reachable production helper allowlist: {reachable_names}",
)
for name, expected in expected_local_references.items():
    actual = local_references(production_function(name))
    require(
        actual == expected,
        f"{profile} local helper/reference allowlist for {name}: {actual}",
    )
require(
    local_references(handler) == {"validate_query", "derive_directory_page"},
    f"handler local helper/reference allowlist: {local_references(handler)}",
)

common_external_calls = {
    "resolve_indexed_overlay": {"Some"},
    "first_identity_by_exact_session": {"Some"},
    "build_directory_candidates": {"Some"},
    "order_key": set(),
    "provider": set(),
    "effective_title": {"Some"},
    "effective_summary": set(),
    "first_user_message": set(),
    "is_subagent": set(),
    "is_non_interactive": set(),
    "is_running": set(),
    "source_file": set(),
    "compare_directory_order": set(),
    "candidate_is_strictly_after_cursor": set(),
    "candidate_is_visible": set(),
    "title_search_annotation": {"Some"},
    "file_search_tier": {"Some"},
    "select_page_candidates": {
        "search_session_file", "record_preparation", "Some", "Ok", "Err",
    },
    "materialize_selected_candidate": {"record_preparation", "Some"},
    "derive_directory_page": {"Some", "Ok"},
    "encode_cursor": set(),
    "decode_cursor": {"Ok"},
    "to_value": {"record_preparation", "Some"},
    "provider_display_name": set(),
}
allowed_external_free_calls = dict(common_external_calls)
if profile == "indexed-provenance":
    allowed_external_free_calls["resolved_title"] = set()
    allowed_external_free_calls["resolved_summary"] = set()
free_call_pattern = re.compile(
    r"(?<![A-Za-z0-9_:.!])(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*\("
)
rust_syntax_names = {
    "async", "cfg", "for", "if", "let", "loop", "match", "move",
    "return", "unsafe", "while",
}
require(
    set(allowed_external_free_calls) == reachable_names,
    f"{profile} recursive external-call owner allowlist",
)
for function in reachable_functions:
    name = function.name
    calls = {
        match.group("name")
        for match in free_call_pattern.finditer(function.masked)
        if not declaration_offset(
            function.declaration_start + match.start("name")
        )
        and match.group("name") not in production_names
        and match.group("name") not in rust_syntax_names
    }
    require(
        calls == allowed_external_free_calls[name],
        f"{profile} exact external free calls in {name}: {calls}",
    )

operation_patterns = {
    "clone_method": r"\.clone\s*\(",
    "clone_from": r"\.clone_from\s*\(",
    "clone_into": r"\.clone_into\s*\(",
    "clone_ufcs": r"\bClone::clone\b",
    "qualified_type_clone": (
        r"\b(?!(?:Arc|Rc|Clone)\s*::)[A-Z][A-Za-z0-9_]*"
        r"(?:::\s*<[^>]*>)?\s*::\s*clone\b"
    ),
    "as_clone": r"<[^>]*\bas\s+Clone\s*>::\s*clone\b",
    "cloned": r"\.cloned\s*\(",
    "to_owned": r"\.to_owned\s*\(",
    "to_owned_ufcs": r"\b(?:ToOwned|str)::to_owned\b",
    "as_to_owned": r"<[^>]*\bas\s+ToOwned\s*>::\s*to_owned\b",
    "to_string_method": r"\.to_string\s*\(",
    "str_to_string": r"\b(?:ToString|str)::to_string\b",
    "string_from": r"\bString::from\b",
    "from_ufcs": r"\bFrom::from\b",
    "into_ufcs": r"\bInto::into\b",
    "as_into": r"<[^>]*\bas\s+Into(?:<[^>]*>)?\s*>::\s*into\b",
    "into_owned": r"\.into_owned\s*\(",
    "to_vec": r"\.to_vec\s*\(",
    "vec_from": r"\bVec::from\b",
    "box_from": r"\bBox::from\b",
    "cow_owned": r"\bCow::Owned\b",
    "arc_clone": r"\bArc::clone\b",
    "arc_from": r"\bArc::from\b",
    "rc_clone": r"\bRc::clone\b",
    "rc_from": r"\bRc::from\b",
    "format": r"\bformat!\s*\(",
    "json_macro": r"\bjson!\s*\(",
    "collect": r"\.collect(?:\s*::\s*<[^;()]*>)?\s*\(",
    "into_method": r"\.into\s*\(",
    "into_boxed_str": r"\.into_boxed_str\s*\(",
    "to_lowercase": r"\.to_lowercase\s*\(",
    "serde_serializer": (
        r"\bserde_json::(?:to_value|to_string|to_vec|to_writer)\b"
    ),
}
operation_inventory: Counter[str] = Counter()
for function in sorted(
    reachable_functions,
    key=lambda item: (item.name, item.declaration_start),
):
    name = function.name
    for operation, pattern in operation_patterns.items():
        for match in re.finditer(pattern, function.masked):
            operation_inventory[f"{name}:{operation}"] += 1
            print(
                f"owned-operation owner=production:{name} "
                f"kind={operation} line={line_number(function.declaration_start + match.start())}"
            )

expected_operations = Counter({
    "build_directory_candidates:format": 3,
    "build_directory_candidates:into_boxed_str": 3,
    "build_directory_candidates:arc_from": 2,
    "build_directory_candidates:arc_clone": 2,
    "title_search_annotation:to_lowercase": 1,
    "title_search_annotation:to_string_method": 1,
    "title_search_annotation:collect": 1,
    "select_page_candidates:to_lowercase": 1,
    "select_page_candidates:to_string_method": 1,
    "materialize_selected_candidate:clone_method": 14,
    "materialize_selected_candidate:to_string_method": 4,
    "materialize_selected_candidate:str_to_string": 3,
    "materialize_selected_candidate:format": 2,
    "derive_directory_page:collect": 1,
    "derive_directory_page:to_string_method": 1,
    "derive_directory_page:json_macro": 1,
    "encode_cursor:to_string_method": 1,
    "encode_cursor:json_macro": 1,
    "decode_cursor:to_string_method": 5,
    "to_value:into_method": 18,
    "to_value:json_macro": 18,
})
expected_operations_by_profile = {
    "borrowed": expected_operations,
    "indexed-provenance": expected_operations,
}
require(
    operation_inventory == expected_operations_by_profile[profile],
    f"{profile} clone/conversion/decorator allowlist mismatch: "
    f"{operation_inventory}",
)
handler_snapshot_anchor = "let snapshot: Option<Arc<Vec<IndexedSession>>>"
handler_drop_anchor = "drop(snapshot);"
require(
    handler.masked.count(handler_snapshot_anchor) == 1
    and handler.masked.count(handler_drop_anchor) == 1,
    "handler snapshot/drop anchor cardinality",
)
handler_region_start = handler.masked.index(handler_snapshot_anchor)
handler_region_end = handler.masked.index(handler_drop_anchor) + len(handler_drop_anchor)
require(handler_region_start < handler_region_end, "handler snapshot/drop anchor order")
handler_snapshot_region = handler.masked[handler_region_start:handler_region_end]
require(
    not any(
        re.search(pattern, handler_snapshot_region) is not None
        for pattern in operation_patterns.values()
    ),
    "handler performs owned clone/conversion work while the snapshot is retained",
)

def function_scope(function: FunctionDef) -> str:
    if function.test_only:
        return "test"
    if function.oracle_only:
        return "oracle"
    return "production"


def function_signature(function: FunctionDef) -> str:
    width = function.body_start - function.declaration_start
    return function.masked[:width]


expected_materializer_signature = {
    "borrowed": canonical(r'''
        fn materialize_selected_candidate(
            selected: &SelectedCandidate<'_>,
            metadata: &HashMap<String, Value>,
        ) -> DirItem
    '''),
    "indexed-provenance": canonical(r'''
        fn materialize_selected_candidate(
            selected: &SelectedCandidate,
            inputs: DirectoryInputs<'_>,
        ) -> DirItem
    '''),
}[profile]
require(
    canonical(function_signature(materializer)) == expected_materializer_signature,
    f"{profile} materializer signature",
)
if profile == "indexed-provenance":
    for name in [
        "order_key", "provider", "effective_title", "effective_summary",
        "first_user_message", "is_subagent", "is_non_interactive",
        "is_running", "source_file",
    ]:
        signature = canonical(function_signature(production_function(name)))
        require("DirectoryInputs" in signature, f"indexed accessor lacks inputs: {name}")
    for name in [
        "candidate_is_strictly_after_cursor", "candidate_is_visible",
        "title_search_annotation", "select_page_candidates",
    ]:
        signature = canonical(function_signature(production_function(name)))
        require("DirectoryInputs" in signature, f"indexed helper lacks inputs: {name}")
    require(
        "DirectoryInputs" in canonical(derive.original)
        and "materialize_selected_candidate(selected,inputs)" in canonical(derive.original),
        "indexed derive/materializer inputs flow",
    )
else:
    require(
        "materialize_selected_candidate(selected,inputs)" not in canonical(derive.original),
        "borrowed derive unexpectedly uses indexed materializer profile",
    )


row_factory_names = {
    function.name
    for function in functions
    if re.search(
        r"->\s*(?:[A-Za-z_][A-Za-z0-9_]*\s*::\s*)*IndexedSession\b",
        function_signature(function),
    )
}


def strip_outer_parentheses(value: str) -> str:
    value = value.strip()
    while value.startswith("("):
        depth = 0
        close = None
        for index, character in enumerate(value):
            if character == "(":
                depth += 1
            elif character == ")":
                depth -= 1
                require(depth >= 0, f"unbalanced expression: {value}")
                if depth == 0:
                    close = index
                    break
        require(close is not None, f"unterminated expression: {value}")
        if close != len(value) - 1:
            break
        value = value[1:close].strip()
    return value


def normalize_unary_expression(source: str) -> str:
    value = canonical(source)
    changed = True
    while changed:
        changed = False
        unwrapped = strip_outer_parentheses(value)
        if unwrapped != value:
            value = unwrapped
            changed = True
            continue
        if value.startswith("&mut"):
            value = value[len("&mut"):]
            changed = True
        elif value.startswith("&") or value.startswith("*"):
            value = value[1:]
            changed = True
    return strip_outer_parentheses(value)


@dataclass(frozen=True)
class CopyBinding:
    category: str
    reference_depth: int


REFERENCE_PREFIX = r"&\s*(?:'[A-Za-z_][A-Za-z0-9_]*\s*)?(?:mut\s+)?"
ROW_BINDING_PATTERN = re.compile(
    rf"\b(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*:\s*"
    rf"(?P<refs>(?:{REFERENCE_PREFIX})*)"
    r"(?:mut\s+)?(?:[A-Za-z_][A-Za-z0-9_]*\s*::\s*)*"
    r"IndexedSession\b"
)
CONTAINER_BINDING_PATTERN = re.compile(
    rf"\b(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*:\s*"
    rf"(?P<refs>(?:{REFERENCE_PREFIX})*)"
    r"(?:mut\s+)?(?:"
    r"(?P<vec>(?:[A-Za-z_][A-Za-z0-9_]*\s*::\s*)*"
    r"Vec\s*<\s*(?:[A-Za-z_][A-Za-z0-9_]*\s*::\s*)*"
    r"IndexedSession\s*>)|"
    r"(?P<slice>\[\s*(?:[A-Za-z_][A-Za-z0-9_]*\s*::\s*)*"
    r"IndexedSession\s*\])"
    r")"
)


def binding_reference_depth(reference_source: str) -> int:
    return reference_source.count("&")


def peel_unary_expression(source: str) -> tuple[str, list[str]]:
    value = canonical(source)
    operations: list[str] = []
    changed = True
    while changed:
        changed = False
        unwrapped = strip_outer_parentheses(value)
        if unwrapped != value:
            value = unwrapped
            changed = True
            continue
        if value.startswith("&mut"):
            operations.append("borrow")
            value = value[len("&mut"):]
            changed = True
        elif value.startswith("&"):
            operations.append("borrow")
            value = value[1:]
            changed = True
        elif value.startswith("*"):
            operations.append("deref")
            value = value[1:]
            changed = True
    return strip_outer_parentheses(value), operations


def apply_reference_operations(
    binding: CopyBinding,
    operations: list[str],
) -> CopyBinding | None:
    depth = binding.reference_depth
    for operation in reversed(operations):
        if operation == "borrow":
            depth += 1
        else:
            depth -= 1
            if depth < 0:
                return None
    return CopyBinding(binding.category, depth)


def expression_copy_binding(
    source: str,
    bindings: dict[str, CopyBinding],
) -> CopyBinding | None:
    value, operations = peel_unary_expression(source)
    binding = bindings.get(value)
    if binding is not None:
        return apply_reference_operations(binding, operations)

    slice_match = re.fullmatch(r"(?P<base>.+)\[(?P<index>[^\]]+)\]", value)
    if slice_match:
        base = normalize_unary_expression(slice_match.group("base"))
        base_binding = bindings.get(base)
        if base_binding is not None and base_binding.category in {"vec", "slice"}:
            category = (
                "slice" if ".." in slice_match.group("index") else "row"
            )
            return apply_reference_operations(
                CopyBinding(category, 0), operations
            )

    if value.endswith(".as_slice()"):
        base = normalize_unary_expression(value[:-len(".as_slice()")])
        base_binding = bindings.get(base)
        if base_binding is not None and base_binding.category in {"vec", "slice"}:
            return apply_reference_operations(CopyBinding("slice", 1), operations)

    if value.endswith(".indexed"):
        return apply_reference_operations(CopyBinding("slice", 1), operations)
    return None


def container_names(bindings: dict[str, CopyBinding]) -> set[str]:
    return {
        name
        for name, binding in bindings.items()
        if binding.category in {"vec", "slice"}
    }


def row_names(bindings: dict[str, CopyBinding]) -> set[str]:
    return {
        name
        for name, binding in bindings.items()
        if binding.category == "row"
    }


def container_expression(
    value: str,
    containers: set[str],
) -> bool:
    value = normalize_unary_expression(value)
    if value in containers or value.endswith(".indexed"):
        return True
    if value.endswith(".as_slice()"):
        return container_expression(value[:-len(".as_slice()")], containers)
    slice_match = re.fullmatch(r"(?P<base>.+)\[(?:\.\.|[^\]]+)\]", value)
    if slice_match:
        return container_expression(slice_match.group("base"), containers)
    return False


def iterator_from_container(value: str, containers: set[str]) -> bool:
    value = normalize_unary_expression(value)
    for marker in [".iter()", ".iter_mut()", ".into_iter()"]:
        marker_offset = value.find(marker)
        if marker_offset >= 0 and container_expression(
            value[:marker_offset], containers
        ):
            return True
    for container in containers:
        if re.search(
            rf"(?<![A-Za-z0-9_]){re.escape(container)}"
            r"\.(?:iter|iter_mut|into_iter)\(\)",
            value,
        ):
            return True
    return re.search(
        r"\.indexed\.(?:iter|iter_mut|into_iter)\(\)", value
    ) is not None


def iteration_row_binding(
    source: str,
    bindings: dict[str, CopyBinding],
) -> CopyBinding | None:
    containers = container_names(bindings)
    value = normalize_unary_expression(source)
    for marker in [".iter()", ".iter_mut()", ".into_iter()"]:
        marker_offset = value.find(marker)
        if marker_offset < 0:
            continue
        base_source = value[:marker_offset]
        if not container_expression(base_source, containers):
            continue
        base_binding = expression_copy_binding(base_source, bindings)
        if (
            marker == ".into_iter()"
            and base_binding is not None
            and base_binding.category == "vec"
            and base_binding.reference_depth == 0
        ):
            return CopyBinding("row", 0)
        return CopyBinding("row", 1)

    if container_expression(source, containers):
        source_binding = expression_copy_binding(source, bindings)
        if (
            source_binding is not None
            and source_binding.category == "vec"
            and source_binding.reference_depth == 0
        ):
            return CopyBinding("row", 0)
        return CopyBinding("row", 1)
    return None


def row_and_container_bindings(
    function: FunctionDef,
) -> dict[str, CopyBinding]:
    bindings: dict[str, CopyBinding] = {}
    binding_source = function_signature(function) + function.masked
    for match in ROW_BINDING_PATTERN.finditer(binding_source):
        bindings.setdefault(
            match.group("name"),
            CopyBinding(
                "row", binding_reference_depth(match.group("refs"))
            ),
        )
    for match in CONTAINER_BINDING_PATTERN.finditer(binding_source):
        bindings.setdefault(
            match.group("name"),
            CopyBinding(
                "vec" if match.group("vec") else "slice",
                binding_reference_depth(match.group("refs")),
            ),
        )

    for match in re.finditer(
        r"DirectoryCandidateSource::Indexed\s*\{(?P<fields>[^{}]*)\}",
        function.masked,
        re.DOTALL,
    ):
        row_match = re.search(
            r"\brow(?:\s*:\s*(?P<alias>[A-Za-z_][A-Za-z0-9_]*))?\b",
            match.group("fields"),
        )
        if row_match:
            bindings.setdefault(
                row_match.group("alias") or "row",
                CopyBinding("row", 1),
            )

    changed = True
    while changed:
        changed = False
        for match in re.finditer(
            r"\blet\s+(?:mut\s+)?(?P<name>[A-Za-z_][A-Za-z0-9_]*)"
            r"(?:\s*:[^=;]+)?\s*=\s*(?P<rhs>[^;]+);",
            function.masked,
            re.DOTALL,
        ):
            name = match.group("name")
            raw_rhs = match.group("rhs")
            rhs = normalize_unary_expression(raw_rhs)
            inferred = expression_copy_binding(raw_rhs, bindings)
            factory = re.match(
                r"(?P<factory>[A-Za-z_][A-Za-z0-9_]*)\(", rhs
            )
            indexed_row = (
                re.search(r"\.indexed\[[^\]]+\]$", rhs) is not None
                or (
                    ".indexed." in rhs
                    and re.search(r"\.(?:expect|unwrap)\(\)$", rhs) is not None
                )
            )
            if inferred is None and factory and factory.group("factory") in row_factory_names:
                inferred = CopyBinding("row", 0)
            if inferred is None and indexed_row:
                inferred = CopyBinding("row", 1 if raw_rhs.strip().startswith("&") else 0)
            if inferred is not None and bindings.get(name) != inferred:
                bindings[name] = inferred
                changed = True

        closure_pattern = re.compile(
            r"(?P<source>[A-Za-z_][A-Za-z0-9_.]*"
            r"(?:\.(?:iter|iter_mut|into_iter)\(\))?)"
            r"\s*\.\s*(?:map|filter|filter_map|find|position|for_each)\s*"
            r"\(\s*\|(?P<parameters>[^|]*)\|"
        )
        for match in closure_pattern.finditer(function.masked):
            inferred = iteration_row_binding(match.group("source"), bindings)
            if inferred is None:
                continue
            for parameter in match.group("parameters").split(","):
                parameter = parameter.strip()
                pattern_borrows = 1 if parameter.startswith("&") else 0
                parameter = re.sub(
                    r"^(?:&\s*)?(?:mut\s+)?", "", parameter
                )
                parameter_match = re.match(
                    r"(?P<name>[A-Za-z_][A-Za-z0-9_]*)\b", parameter
                )
                if parameter_match:
                    parameter_binding = CopyBinding(
                        "row", max(0, inferred.reference_depth - pattern_borrows)
                    )
                    name = parameter_match.group("name")
                    if bindings.get(name) != parameter_binding:
                        bindings[name] = parameter_binding
                        changed = True

        loop_pattern = re.compile(
            r"\bfor\s+(?P<pattern_ref>&\s*)?(?:mut\s+)?"
            r"(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s+in\s+"
            r"(?P<source>[^\{;]+)"
        )
        for match in loop_pattern.finditer(function.masked):
            inferred = iteration_row_binding(match.group("source"), bindings)
            if inferred is None:
                continue
            pattern_borrows = 1 if match.group("pattern_ref") else 0
            loop_binding = CopyBinding(
                "row", max(0, inferred.reference_depth - pattern_borrows)
            )
            name = match.group("name")
            if bindings.get(name) != loop_binding:
                bindings[name] = loop_binding
                changed = True
    return bindings


def expression_start_before(dot: int, lower_bound: int) -> int:
    round_depth = 0
    square_depth = 0
    brace_depth = 0
    for offset in range(dot - 1, lower_bound - 1, -1):
        character = masked[offset]
        if character == ")":
            round_depth += 1
        elif character == "]":
            square_depth += 1
        elif character == "}":
            brace_depth += 1
        elif character == "(" and round_depth:
            round_depth -= 1
        elif character == "[" and square_depth:
            square_depth -= 1
        elif character == "{" and brace_depth:
            brace_depth -= 1
        elif (
            not (round_depth or square_depth or brace_depth)
            and character in "=;,{|(:"
        ):
            return offset + 1
    return lower_bound


def matching_parenthesis(open_parenthesis: int, upper_bound: int) -> int:
    require(masked[open_parenthesis] == "(", f"not an open parenthesis: {open_parenthesis}")
    depth = 0
    for offset in range(open_parenthesis, upper_bound):
        if masked[offset] == "(":
            depth += 1
        elif masked[offset] == ")":
            depth -= 1
            if depth == 0:
                return offset + 1
    raise AuditFailure(f"unterminated call at line {line_number(open_parenthesis)}")


copy_method_pattern = re.compile(
    r"\.(?P<method>clone|clone_from|clone_into|to_owned|to_vec|cloned|collect)\b"
    r"(?:\s*::\s*<[^;()]*>)?\s*\("
)
qualified_copy_call_pattern = re.compile(
    r"(?P<path>"
    r"(?:\b[A-Za-z_][A-Za-z0-9_]*"
    r"(?:\s*::\s*<[^;{}()]*>)?\s*::\s*)+"
    r"(?P<terminal>clone|to_owned|to_vec|cloned|from|from_iter|collect)"
    r"|<[^;{}()]*>\s*::\s*"
    r"(?P<typed_terminal>clone|to_owned|to_vec|cloned|from|from_iter|collect)"
    r")\s*\("
)
qualified_copy_item_pattern = re.compile(
    r"(?P<path>"
    r"(?:\b[A-Za-z_][A-Za-z0-9_]*"
    r"(?:\s*::\s*<[^;{}()]*>)?\s*::\s*)+"
    r"(?P<terminal>clone|to_owned)"
    r"|<[^;{}()]*\bas\s+(?:Clone|ToOwned)\b[^>]*>"
    r"\s*::\s*(?P<typed_terminal>clone|to_owned)"
    r")\b"
)


def vec_from_path(path_value: str) -> bool:
    return (
        re.search(r"(?:^|::)Vec(?:::<[^>]*>)?::from$", path_value)
        is not None
        or "asFrom" in path_value
    )


def copy_conversion_sites(function: FunctionDef) -> list[dict[str, object]]:
    sites: list[dict[str, object]] = []
    for match in copy_method_pattern.finditer(
        masked, function.body_start, function.end
    ):
        open_parenthesis = masked.index("(", match.start("method"), match.end())
        end = matching_parenthesis(open_parenthesis, function.end)
        start = expression_start_before(match.start(), function.body_start)
        sites.append({
            "kind": f"method:{match.group('method')}",
            "start": start,
            "end": end,
            "receiver": text[start:match.start()],
            "argument": text[open_parenthesis + 1:end - 1],
            "path": None,
        })
    for match in qualified_copy_call_pattern.finditer(
        masked, function.body_start, function.end
    ):
        terminal = match.group("terminal") or match.group("typed_terminal")
        path_value = canonical(match.group("path"))
        if terminal == "from" and not vec_from_path(path_value):
            continue
        open_parenthesis = masked.index("(", match.start("path"), match.end())
        end = matching_parenthesis(open_parenthesis, function.end)
        sites.append({
            "kind": f"qualified:{terminal}",
            "start": match.start("path"),
            "end": end,
            "receiver": None,
            "argument": text[open_parenthesis + 1:end - 1],
            "path": path_value,
        })
    for match in qualified_copy_item_pattern.finditer(
        masked, function.body_start, function.end
    ):
        after = masked[match.end():function.end].lstrip()
        if after.startswith("("):
            continue
        sites.append({
            "kind": "qualified:item",
            "start": match.start("path"),
            "end": match.end("path"),
            "receiver": None,
            "argument": None,
            "path": canonical(match.group("path")),
        })
    unique: dict[tuple[str, int, int], dict[str, object]] = {}
    for site in sites:
        key = (str(site["kind"]), int(site["start"]), int(site["end"]))
        unique[key] = site
    return sorted(unique.values(), key=lambda site: (int(site["start"]), str(site["kind"])))


def policy_copy_key(function: FunctionDef, site: dict[str, object]) -> tuple[str, str, str]:
    start = int(site["start"])
    end = int(site["end"])
    return function.name, str(site["kind"]), canonical(text[start:end])


policy_copy_inventory: Counter[tuple[str, str, str]] = Counter()
for function in sorted(
    reachable_functions,
    key=lambda item: (item.name, item.declaration_start),
):
    for site in copy_conversion_sites(function):
        key = policy_copy_key(function, site)
        policy_copy_inventory[key] += 1
        print(
            f"policy-copy owner=production:{key[0]} kind={key[1]} "
            f"line={line_number(int(site['start']))} expression={key[2]}"
        )

expected_policy_copy_common: Counter[tuple[str, str, str]] = Counter({
    (
        "build_directory_candidates",
        "qualified:clone",
        canonical("Arc::clone(&key)"),
    ): 2,
    (
        "title_search_annotation",
        "method:collect",
        canonical("field.chars().take(140).collect()"),
    ): 1,
    (
        "materialize_selected_candidate",
        "method:clone",
        canonical("row.session_id.clone()"),
    ): 1,
    (
        "materialize_selected_candidate",
        "method:clone",
        canonical("row.provider.clone()"),
    ): 1,
    (
        "materialize_selected_candidate",
        "method:clone",
        canonical("row.project_path.clone()"),
    ): 1,
    (
        "materialize_selected_candidate",
        "method:clone",
        canonical("row.first_user_message.clone()"),
    ): 1,
    (
        "materialize_selected_candidate",
        "method:clone",
        canonical("row.cwd.clone()"),
    ): 1,
    (
        "materialize_selected_candidate",
        "method:clone",
        canonical("annotation.matched_in.clone()"),
    ): 2,
    (
        "materialize_selected_candidate",
        "method:clone",
        canonical("annotation.snippet.clone()"),
    ): 2,
    (
        "materialize_selected_candidate",
        "method:clone",
        canonical("identity.terminal_id.clone()"),
    ): 2,
    (
        "materialize_selected_candidate",
        "method:clone",
        canonical("identity.cwd.clone()"),
    ): 2,
    (
        "materialize_selected_candidate",
        "method:clone",
        canonical("terminal_fallback.clone()"),
    ): 1,
})
expected_derive_collect = {
    "borrowed": canonical(r'''
        selected.rows.iter().take(limit).map(|selected| {
            materialize_selected_candidate(selected, inputs.metadata).to_value()
        }).collect::<Vec<_>>()
    '''),
    "indexed-provenance": canonical(r'''
        selected.rows.iter().take(limit).map(|selected| {
            materialize_selected_candidate(selected, inputs).to_value()
        }).collect::<Vec<_>>()
    '''),
}[profile]
expected_policy_copy_inventory = expected_policy_copy_common.copy()
expected_policy_copy_inventory[(
    "derive_directory_page",
    "method:collect",
    expected_derive_collect,
)] += 1
require(
    policy_copy_inventory == expected_policy_copy_inventory,
    f"{profile} exact production policy copy/conversion sites: "
    f"{policy_copy_inventory}",
)


def is_full_row_expression(
    source: str,
    function: FunctionDef,
    bindings: dict[str, CopyBinding],
) -> bool:
    binding = expression_copy_binding(source, bindings)
    if binding is not None and binding.category == "row":
        return True
    value = normalize_unary_expression(source)
    if function.name == "parse" and value == "row":
        return "Option<IndexedSession>" in canonical(function_signature(function))
    containers = container_names(bindings)
    if re.fullmatch(r".+\.indexed\[[^\]]+\]", value):
        return True
    for container in containers:
        if re.fullmatch(rf"{re.escape(container)}\[[^\]]+\]", value):
            return True
    if iterator_from_container(value, containers) and re.search(
        r"\.(?:next|nth|find)\([^)]*\)"
        r"(?:\.(?:expect|unwrap)\([^)]*\))*$",
        value,
    ):
        return True
    return False


def clone_operation_copies_rows(
    source: str,
    bindings: dict[str, CopyBinding],
) -> bool | None:
    binding = expression_copy_binding(source, bindings)
    if binding is None:
        return None
    if binding.category == "slice":
        # `[T]` itself has no `Clone` implementation. A valid clone call at
        # reference depth >= 1 therefore clones only a slice reference.
        return False
    # `IndexedSession` and `Vec<IndexedSession>` clones copy row data when the
    # clone operand denotes the value or its ordinary `&self` argument. One
    # additional reference level (for example `Clone::clone(&row)` where row is
    # already `&IndexedSession`) clones only that reference.
    return binding.reference_depth <= 1


def first_top_level_argument(source: str) -> str:
    round_depth = 0
    square_depth = 0
    brace_depth = 0
    angle_depth = 0
    for index, character in enumerate(source):
        if character == "(":
            round_depth += 1
        elif character == ")":
            round_depth -= 1
        elif character == "[":
            square_depth += 1
        elif character == "]":
            square_depth -= 1
        elif character == "{":
            brace_depth += 1
        elif character == "}":
            brace_depth -= 1
        elif character == "<":
            angle_depth += 1
        elif character == ">" and angle_depth:
            angle_depth -= 1
        elif character == "," and not (
            round_depth or square_depth or brace_depth or angle_depth
        ):
            return source[:index]
    return source


def enclosing_map_receiver(
    function: FunctionDef,
    item_start: int,
) -> str | None:
    candidates: list[tuple[int, str]] = []
    method_map_pattern = re.compile(r"\.(?:map|filter_map)\s*\(")
    for match in method_map_pattern.finditer(
        masked,
        function.body_start,
        item_start,
    ):
        open_parenthesis = masked.index("(", match.start(), match.end())
        end = matching_parenthesis(open_parenthesis, function.end)
        if open_parenthesis < item_start < end:
            start = expression_start_before(match.start(), function.body_start)
            candidates.append((match.start(), text[start:match.start()]))
    qualified_map_pattern = re.compile(
        r"(?:\b[A-Za-z_][A-Za-z0-9_]*\s*::\s*)+"
        r"(?:map|filter_map)\s*\("
    )
    for match in qualified_map_pattern.finditer(
        masked,
        function.body_start,
        item_start,
    ):
        open_parenthesis = masked.index("(", match.start(), match.end())
        end = matching_parenthesis(open_parenthesis, function.end)
        if open_parenthesis < item_start < end:
            arguments = text[open_parenthesis + 1:end - 1]
            candidates.append(
                (match.start(), first_top_level_argument(arguments))
            )
    if not candidates:
        return None
    return max(candidates, key=lambda value: value[0])[1]


def clone_marker(source: str) -> bool:
    value = canonical(source)
    return (
        re.search(
            r"(?:^|[.:<])(?:clone|to_owned|cloned)(?:\(|\b)", value
        )
        is not None
        or re.search(r"::(?:clone|to_owned)\b", value) is not None
        or re.search(
            r"<[^>]*IndexedSession[^>]*as(?:Clone|ToOwned)>::"
            r"(?:clone|to_owned)\b",
            value,
        )
        is not None
    )


def full_row_copy_sites(function: FunctionDef) -> list[tuple[int, int, str]]:
    bindings = row_and_container_bindings(function)
    containers = container_names(bindings)
    result: set[tuple[int, int, str]] = set()
    for site in copy_conversion_sites(function):
        kind = str(site["kind"])
        start = int(site["start"])
        end = int(site["end"])
        receiver = site["receiver"]
        argument = site["argument"]
        path_value = str(site["path"] or "")
        if kind in {
            "method:clone",
            "method:clone_from",
            "method:clone_into",
        } and receiver is not None:
            copies_rows = clone_operation_copies_rows(str(receiver), bindings)
            if copies_rows is True or (
                copies_rows is None
                and (
                    is_full_row_expression(str(receiver), function, bindings)
                    or container_expression(str(receiver), containers)
                )
            ):
                result.add((start, end, kind))
            elif copies_rows is False:
                print(
                    f"harmless-reference-copy owner={function_scope(function)}:"
                    f"{function.name} kind={kind} line={line_number(start)} "
                    f"expression={canonical(text[start:end])}"
                )
        elif kind == "method:to_owned" and receiver is not None:
            if is_full_row_expression(
                str(receiver), function, bindings
            ) or container_expression(str(receiver), containers):
                result.add((start, end, kind))
        elif kind == "method:to_vec" and receiver is not None:
            if container_expression(str(receiver), containers):
                result.add((start, end, kind))
        elif kind == "method:cloned" and receiver is not None:
            if iterator_from_container(str(receiver), containers):
                result.add((start, end, kind))
        elif kind == "method:collect" and receiver is not None:
            receiver_value = str(receiver)
            expression = text[start:end]
            if iterator_from_container(receiver_value, containers) and (
                clone_marker(receiver_value)
                or "Vec<IndexedSession>" in canonical(expression)
            ):
                result.add((start, end, kind))
        elif kind.startswith("qualified:") and kind != "qualified:item":
            argument_value = first_top_level_argument(str(argument or ""))
            terminal = kind.removeprefix("qualified:")
            if terminal == "clone":
                copies_rows = clone_operation_copies_rows(argument_value, bindings)
                if copies_rows is True or (
                    copies_rows is None
                    and (
                        is_full_row_expression(argument_value, function, bindings)
                        or container_expression(argument_value, containers)
                    )
                ):
                    result.add((start, end, kind))
                elif copies_rows is False:
                    print(
                        f"harmless-reference-copy owner={function_scope(function)}:"
                        f"{function.name} kind={kind} line={line_number(start)} "
                        f"expression={canonical(text[start:end])}"
                    )
            elif terminal == "to_owned":
                if is_full_row_expression(
                    argument_value, function, bindings
                ) or container_expression(argument_value, containers):
                    result.add((start, end, kind))
            elif terminal == "to_vec":
                if container_expression(argument_value, containers):
                    result.add((start, end, kind))
            elif terminal == "cloned":
                if iterator_from_container(argument_value, containers):
                    result.add((start, end, kind))
            elif terminal == "from" and vec_from_path(path_value):
                if container_expression(argument_value, containers):
                    result.add((start, end, kind))
            elif terminal in {"from_iter", "collect"}:
                if iterator_from_container(argument_value, containers) and (
                    clone_marker(argument_value)
                    or "IndexedSession" in path_value
                ):
                    result.add((start, end, kind))
        elif kind == "qualified:item":
            receiver_value = enclosing_map_receiver(function, start)
            if receiver_value is not None and iterator_from_container(
                receiver_value, containers
            ):
                if clone_marker(path_value):
                    result.add((start, end, kind))
    return sorted(result)


full_row_copy_inventory: Counter[tuple[str, str, str]] = Counter()
for function in functions:
    for start, end, kind in full_row_copy_sites(function):
        key = (
            f"{function_scope(function)}:{function.name}",
            kind,
            canonical(text[start:end]),
        )
        full_row_copy_inventory[key] += 1
        print(
            f"full-row-copy owner={key[0]} kind={kind} "
            f"line={line_number(start)} expression={key[2]}"
        )

expected_test_full_row_copy_exceptions = Counter({
    (
        "test:parse",
        "method:clone",
        canonical("row.clone()"),
    ): 1,
})
expected_oracle_full_row_copy_exceptions: Counter[tuple[str, str, str]] = Counter()
expected_full_row_copy_inventory = (
    expected_test_full_row_copy_exceptions
    + expected_oracle_full_row_copy_exceptions
)
require(
    full_row_copy_inventory == expected_full_row_copy_inventory,
    f"source-wide final full-row copy allowlist: {full_row_copy_inventory}",
)
require(
    not any(
        scope.startswith("production:")
        for scope, _kind, _expression in full_row_copy_inventory
    ),
    "production full-row copy escape",
)
print(
    "full-row copy exceptions="
    "test:StaticSessionSource::parse:row.clone():1;oracle:none"
)

output_field = (
    r"(?:session_id|provider|project_path|title|summary|first_user_message|"
    r"last_activity_at|created_at|cwd|is_subagent|is_non_interactive|"
    r"is_running|archived|matched_in|snippet|running_terminal_id|"
    r"live_terminal_only|session_type)"
)
mutation_pattern = re.compile(
    rf"(?:\.\s*{output_field}\s*(?:[+\-*/%&|^]?=|"
    rf"\.(?:clone_from|clone_into|replace|take|insert|push|push_str|clear|"
    rf"truncate|extend)\s*\()|"
    rf"&\s*mut\s+[A-Za-z_][A-Za-z0-9_]*\s*\.\s*{output_field}\b)"
)
mutation_offsets = [match.start() for match in mutation_pattern.finditer(masked)]
mutation_inventory = classify(mutation_offsets)
require(
    not any(key.startswith("production:") for key in mutation_inventory),
    f"production output mutation sites: {mutation_inventory}",
)

require(
    sum(
        materializer.body_start <= start < materializer.end
        for start, _end in dir_item_spans
    )
    == 2,
    "materializer constructor count",
)

annotation_spans = constructor_spans("SearchAnnotation")
annotation_offsets = [start for start, _end in annotation_spans]
require(
    classify(annotation_offsets) == Counter({
        "production:title_search_annotation": 1,
        "production:select_page_candidates": 1,
    }),
    "SearchAnnotation constructor owner allowlist",
)
require(
    classify(symbol_references("title_search_annotation")) == Counter({
        "production:select_page_candidates": 1,
        "test:shared_title_match_preserves_field_precedence_and_140_scalar_snippet": 4,
    }),
    "title annotation helper call allowlist",
)
require(
    classify(symbol_references("materialize_selected_candidate")) == Counter({
        "production:derive_directory_page": 1,
        "test:candidate_normalization_preserves_first_winner_from_supplied_identity_vector": 1,
        "test:materialize_test_candidate": 1,
    }),
    "materializer call allowlist",
)
serializer_offsets = [
    match.start()
    for match in re.finditer(
        r"(?:\.\s*to_value\b|\bDirItem::to_value\b)",
        masked,
    )
]
require(
    classify(serializer_offsets) == Counter({
        "production:derive_directory_page": 1,
        "test:live_terminal_item_mirrors_identity_subagent_flag": 2,
        "test:item_from_meta_maps_fields_and_fallback_session_id": 1,
    }),
    "serializer call allowlist",
)

site_expectations = {
    r"rows\.push\s*\(\s*SelectedCandidate\s*\{": Counter({
        "production:select_page_candidates": 1,
    }),
    r"retained_descriptor_peak\s*=\s*counts\.retained_descriptor_peak\.max\(rows\.len\(\)\)": Counter({
        "production:select_page_candidates": 1,
    }),
    r"counts\.search_annotations\s*\+=\s*1": Counter({
        "production:select_page_candidates": 2,
    }),
    r"counts\.indexed_full\s*\+=\s*1": Counter({
        "production:materialize_selected_candidate": 1,
    }),
    r"counts\.synthesized_full\s*\+=\s*1": Counter({
        "production:materialize_selected_candidate": 1,
    }),
    r"counts\.override_decoration\s*\+=\s*1": Counter({
        "production:materialize_selected_candidate": 1,
    }),
    r"counts\.metadata_decoration\s*\+=\s*1": Counter({
        "production:materialize_selected_candidate": 1,
    }),
    r"counts\.running_decoration\s*\+=\s*1": Counter({
        "production:materialize_selected_candidate": 1,
    }),
    r"counts\.serialization\s*\+=\s*1": Counter({
        "production:to_value": 1,
    }),
}
for pattern, expected in site_expectations.items():
    offsets = [match.start() for match in re.finditer(pattern, masked)]
    require(classify(offsets) == expected, f"counter/site allowlist: {pattern}")

selector_title_calls = [
    offset
    for offset in symbol_references("title_search_annotation")
    if selector.body_start <= offset < selector.end
]
selector_annotations = [
    start for start, _end in annotation_spans
    if selector.body_start <= start < selector.end
]
selector_counters = [
    selector.declaration_start + match.start()
    for match in re.finditer(
        r"counts\.search_annotations\s*\+=\s*1",
        selector.masked,
    )
]
require(
    len(selector_title_calls) == 1
    and len(selector_annotations) == 1
    and len(selector_counters) == 2,
    "annotation creation/counter cardinality",
)
selector_pushes = [
    selector.declaration_start + match.start()
    for match in re.finditer(
        r"rows\.push\s*\(\s*SelectedCandidate\s*\{",
        selector.masked,
    )
]
require(len(selector_pushes) == 1, "selector push cardinality")
require(
    selector_title_calls[0]
    < selector_counters[0]
    < selector_annotations[0]
    < selector_counters[1]
    < selector_pushes[0],
    "title/deep annotation creation is not paired with its following counter",
)

require(
    derive.masked.count("materialize_selected_candidate(") == 1,
    "derive materializer count",
)
require(derive.masked.count(".to_value()") == 1, "derive serializer count")
require(
    derive.masked.index("let revision")
    < derive.masked.index("select_page_candidates")
    < derive.masked.index(".take(limit)")
    < derive.masked.index("materialize_selected_candidate"),
    "masked revision/select/take/materialize order",
)
require(
    selector.masked.index("rows.push(SelectedCandidate {")
    < selector.masked.index("retained_descriptor_peak"),
    "masked push/counter order",
)
require(serializer.masked.count("Value::Object(o)") == 1, "serializer result count")
require("identities.sort" not in masked, "identity sort")
for line in masked.splitlines():
    require(
        not ("sort_by" in line and "terminal_id" in line),
        f"terminal identity sort: {line}",
    )

print(
    f"PASS profile={profile}: declaration-aware constructors; recursive qualified "
    "helper graph; exact production copy/conversion expressions; operation-sensitive "
    "typed full-row copies/reference controls; annotation/counter, materializer/"
    "serializer, mutation, counter, and masked-order allowlists"
)
PY
```

Expected: exactly one coherent isolated-Python audit runs with explicit exceptions. Borrowed and indexed-provenance profiles retain exact representation markers, signatures, graph edges, external calls, constructor RHS, general operation counts, annotations, counters, mutations, and order. The exact production policy-copy ledger contains only the supplied `Arc::clone`, selected-output field clones, snippet collect, and returned-item collect expressions. The source-wide pass contains exactly one genuine full-row-copy test exception (`StaticSessionSource::parse` / `row.clone()`) and an explicitly empty oracle exception counter. It preserves category/reference depth: row/vector value clones and every enumerated slice/vector materialization are rejected, direct and iterator loop row bindings carry provenance, and clones of already-borrowed row/slice/vector references emit `harmless-reference-copy` and are omitted from the full-row-copy inventory. Inherent/trait-qualified slice `to_vec`/`to_owned`, parenthesized/dereferenced rows, qualified `Vec::from`, `.cloned()`, clone function items under iterator maps, `from_iter`, and qualified/method collect conversions are covered in either representation. The proof boundary is syntactic: masking preserves Python character/newline positions but does not claim UTF-8 byte offsets; explicit typed bindings and enumerated standard forms are covered, while macro expansion, hidden generic/custom copy wrappers, arbitrary unsafe copies, and allocator behavior are not claimed.


- [ ] **Step 8: Run 27 page-bound tests, deep edges, focused family, and server all-targets GREEN.**

```bash
run_logged task7-page-bound \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    'session_directory::page_bound_tests' -- \
    --color=never --test-threads=1
for test_name in \
  tier_user_messages_matches_only_the_user_turn \
  tier_full_text_matches_assistant_turn_too \
  tier_search_is_case_insensitive \
  tier_search_empty_no_match_returns_empty_items_without_partial \
  tier_search_combined_with_cursor_pagination \
  tier_search_reports_partial_budget_when_scan_budget_exceeded \
  title_tier_search_matches_a_renamed_sessions_override_title \
  tier_search_reports_io_error_for_missing_source_file \
  tier_search_budget_overwrites_prior_io_error \
  tier_search_budget_is_checked_before_no_source_tail
do
  run_logged "task7-deep-$test_name" \
    env CARGO_TERM_COLOR=never \
    cargo test --manifest-path "$MANIFEST" \
      -p freshell-server --bin freshell-server \
      "session_directory::tests::$test_name" -- \
      --exact --color=never --test-threads=1
done
run_logged task7-session-directory \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    session_directory -- --color=never --test-threads=1
run_logged task7-server-all-targets \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --all-targets
```

Expected GREEN: page-bound module reports `27 passed; 0 failed; 0 ignored; 0 measured`; each of the ten named deep/title exact filters reports `1 passed`; focused and all-target suites have positive counts and zero failures.

- [ ] **Step 9: Commit only the source file.**

```bash
git -C "$WT" diff --check
git -C "$WT" add -- "$SOURCE_REL"
test "$(git -C "$WT" diff --cached --name-only)" = "$SOURCE_REL"
git -C "$WT" commit \
  -m "perf(session-directory): materialize only returned rows" \
  -m "Retain at most limit + 1 descriptors and owned search annotations while materializing, output-decorating, and serializing only returned rows; pair current-thread counters with a lexical static work-site audit." \
  -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)" \
  -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Gate 8: Final Verification, Exact Scope, and Unrelated-Failure Evidence

**Fresh-shell precondition:** Start the normal Gate-8 execution unit in a new persistent Bash session and evaluate the complete `Command and Evidence Harness` block before Step 1. Run every normal Gate-8 Bash fence in that session; do not reuse shell state from a prior unit. A Gate-0 baseline-matrix branch into the physically shared Step-7 protocol is not a Gate-8 execution-unit start: execute that Step-7 replay in the existing Gate-0 shell as directed below, then return only to Gate 0 Step 8.

**Files:**
- Modify: none
- Read only: repository, manifests, tests, and coordinator status
- Generated evidence: `$LOG_ROOT/**`

**Interfaces:**

```text
Relevant focused gate = must be GREEN
Broad gate = GREEN or exact matching unchanged-BASE_SHA evidence for unrelated failure
Final committed path set = plan + session_directory.rs
Final working state = clean
Manifest/config scope = no diff from BASE_SHA
```

- [ ] **Step 1: Run final focused tests.**

```bash
run_logged final-page-bound \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    'session_directory::page_bound_tests' -- \
    --color=never --test-threads=1
run_logged final-session-directory \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    session_directory -- --color=never --test-threads=1
```

Required GREEN: exactly 27 page-bound tests pass; focused family has positive count and zero failures. Stop on any failure.

- [ ] **Step 2: Run the local seven-test Rust-backed Playwright matrix.**

```bash
FINAL_MATRIX_DISPOSITION=pending
FINAL_MATRIX_DISPOSITION_FILE=
if run_rust_session_directory_matrix \
  final-rust-session-directory-matrix \
  "$WT" \
  "$LOG_ROOT/final-playwright-output"
then
  FINAL_MATRIX_STATUS=0
  test "$(grep -Ec '(^|[^0-9])7 passed([^0-9]|$)' \
    "$LOG_ROOT/final-rust-session-directory-matrix.log")" -eq 1
  if grep -Eq '(^|[^0-9])(failed|skipped|interrupted|did not run)([^0-9]|$)' \
    "$LOG_ROOT/final-rust-session-directory-matrix.log"
  then
    printf '%s\n' 'STOP: final Rust Playwright matrix has a non-GREEN result summary.' >&2
    exit 1
  fi
  FINAL_MATRIX_DISPOSITION=matrix_green
else
  FINAL_MATRIX_STATUS=$?
  FINAL_MATRIX_DISPOSITION=recovery_required
  FAILED_COMMAND_NAME=final-rust-session-directory-matrix
  printf '%s\n' \
    "RECOVERY REQUIRED: final Rust Playwright matrix exited $FINAL_MATRIX_STATUS; Gate 8 Step 3 and every later acceptance step remain closed." \
    'If the Step-7 entry conditions are met, keep this Gate-8 shell open, set FAILURE_SEQUENCE to the next canonical value, and execute every Step-7 Bash fence through its final handoff assignment in this same shell.' \
    'Only paired_candidate_recovered_green or matching_BASE_SHA_playwright_environment_failure may reopen the gate; functional, timeout, route/API, DOM, and live-flow failures remain non-waivable.' >&2
fi
```

Required GREEN: exit zero and exactly one final `7 passed` marker. Direct GREEN sets `FINAL_MATRIX_DISPOSITION=matrix_green`. A nonzero command remains a failed gate: `run_logged` has persisted the original command, argv, log, and exit evidence; the fence sets `FAILED_COMMAND_NAME=final-rust-session-directory-matrix` and `FINAL_MATRIX_DISPOSITION=recovery_required`, but intentionally leaves the owning Gate-8 shell alive solely for Step 7. It does not authorize Step 3. If the Step-7 entry conditions are met, set the next canonical `FAILURE_SEQUENCE` and execute every Step-7 Bash fence in this same shell. The final Step-7 fence may replace `recovery_required` only with `paired_candidate_recovered_green` or `matching_BASE_SHA_playwright_environment_failure` after verified cleanup; the latter is a waiver, never a pass. The Step-3 Bash guard then permits the sole resume point. Any named assertion, route/API mismatch, DOM mismatch, timeout after server startup, or live create/search/delete failure is terminal and non-waivable.

- [ ] **Step 3: Run full server and read-only sessions sanity.**

```bash
case "${FINAL_MATRIX_DISPOSITION-}" in
  matrix_green)
    ;;
  paired_candidate_recovered_green|matching_BASE_SHA_playwright_environment_failure)
    test -n "${FINAL_MATRIX_DISPOSITION_FILE-}"
    test -s "$FINAL_MATRIX_DISPOSITION_FILE"
    grep -Fx "disposition=$FINAL_MATRIX_DISPOSITION" \
      "$FINAL_MATRIX_DISPOSITION_FILE" >/dev/null
    grep -Fx 'command_name=final-rust-session-directory-matrix' \
      "$FINAL_MATRIX_DISPOSITION_FILE" >/dev/null
    grep -Fx 'command_phase=gate8-final' \
      "$FINAL_MATRIX_DISPOSITION_FILE" >/dev/null
    ;;
  *)
    printf 'STOP: Gate 8 Step 3 is closed; final matrix disposition=%q\n' \
      "${FINAL_MATRIX_DISPOSITION-unset}" >&2
    exit 1
    ;;
esac
if run_logged final-server-all-targets \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --all-targets
then
  FINAL_SERVER_STATUS=0
else
  FINAL_SERVER_STATUS=$?
fi
if run_logged final-sessions-read-only \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-sessions
then
  FINAL_SESSIONS_STATUS=0
else
  FINAL_SESSIONS_STATUS=$?
fi
```

Expected GREEN: all summaries report zero failures. Never edit `freshell-sessions` to address a failure.

- [ ] **Step 4: Run formatting and all warnings-denied Clippy gates.**

```bash
run_logged final-fmt \
  cargo fmt --manifest-path "$MANIFEST" --all --check
if run_logged final-clippy-workspace \
  cargo clippy --manifest-path "$MANIFEST" \
    --workspace --all-targets -- -D warnings
then FINAL_CLIPPY_WORKSPACE_STATUS=0; else FINAL_CLIPPY_WORKSPACE_STATUS=$?; fi
if run_logged final-clippy-codex-real \
  cargo clippy --manifest-path "$MANIFEST" \
    -p freshell-codex --features real-transport --all-targets -- -D warnings
then FINAL_CLIPPY_CODEX_STATUS=0; else FINAL_CLIPPY_CODEX_STATUS=$?; fi
if run_logged final-clippy-opencode-real \
  cargo clippy --manifest-path "$MANIFEST" \
    -p freshell-opencode --features real-transport --all-targets -- -D warnings
then FINAL_CLIPPY_OPENCODE_STATUS=0; else FINAL_CLIPPY_OPENCODE_STATUS=$?; fi
if run_logged final-clippy-all-features \
  cargo clippy --manifest-path "$MANIFEST" \
    --workspace --all-targets --all-features -- -D warnings
then FINAL_CLIPPY_ALL_FEATURES_STATUS=0; else FINAL_CLIPPY_ALL_FEATURES_STATUS=$?; fi
```

Expected GREEN: every command exits 0 with no warning diagnostics. If a source-only formatting or lint correction is needed, return to the responsible TDD task, commit only `session_directory.rs`, and restart Gate 8.

- [ ] **Step 5: Run coordinator status and repository `check`.**

```bash
run_logged final-status-before-check npm --prefix "$WT" run test:status
if run_logged final-npm-check \
  env FRESHELL_TEST_SUMMARY='session-directory page-bound npm check' \
  npm --prefix "$WT" run check
then
  FINAL_CHECK_STATUS=0
else
  FINAL_CHECK_STATUS=$?
fi
```

Normal GREEN: typecheck and coordinated client/server/Electron suites succeed with positive counts.

- [ ] **Step 6: Run the canonical full `npm test` separately.**

```bash
run_logged final-status-before-test npm --prefix "$WT" run test:status
if run_logged final-npm-test \
  env FRESHELL_TEST_SUMMARY='session-directory page-bound final validation' \
  npm --prefix "$WT" test
then
  FINAL_NPM_STATUS=0
else
  FINAL_NPM_STATUS=$?
fi
run_logged final-status-after-test npm --prefix "$WT" run test:status
```

Normal GREEN: all suite exits are `code: 0`, test counts are positive, command exits 0, and final status records success.

- [ ] **Step 7: For any eligible failure, execute the command-class direct-child paired protocol before classification.**

This protocol applies only after focused Rust is GREEN and no functional Playwright assertion has failed; a pre-assertion Playwright bootstrap/environment failure may itself enter this protocol. Functional matrix failures and focused session-directory failures are never waived. Execute the protocol serially for each eligible failed command. Set `FAILED_COMMAND_NAME` and supply the next canonical decimal `FAILURE_SEQUENCE`. `$LOG_ROOT/waiver-sequence-state.txt` starts logically at zero, is never reset during the gate, and requires each accepted proposal to equal the prior persisted value plus one. Accepted values are exactly `1..999999999`; the final value may be allocated once, and every later attempt is durably denied as exhausted. The allocator locks, validates, safely increments only a bounded value, pads the supplied canonical string lexically to nine digits, atomically persists it, and then derives every artifact basename. Gaps, reuse, malformed/out-of-range input or state, lock/state failure, and exhaustion use unique `rejected-waiver-input.XXXXXXXX` denial artifacts. No unbounded value reaches Bash arithmetic or numeric `printf`.

For a matrix failure, the caller fence has already set its caller-specific disposition to `recovery_required` and set the exact `FAILED_COMMAND_NAME`. If the failure meets this Step's entry conditions, supply the next canonical decimal `FAILURE_SEQUENCE` and branch here immediately, before the caller's guarded downstream step. Execute this physically shared Step-7 protocol in the unchanged shell that observed the failure; entering it from Gate 0 does not start a Gate-8 execution unit. After the final fence validates an exact resumable disposition, completes cleanup, disarms the EXIT trap, and assigns the caller-specific disposition/file variables, return only to Gate 0 Step 8 or Gate 8 Step 3 respectively.

```text
Per-failure identity = injective nine-digit monotonic sequence + gate phase + exact run_logged command name
Sequence authority = locked atomic last-sequence state; bounded 1..999999999; lexical zero padding
Replay authority = original NUL-delimited argv, never reconstructed prose
Adjudication authority = original + paired candidate + paired base artifacts
```

Create one fresh, detached, direct child of the repository's `.worktrees` directory and install ownership-safe cleanup:

**Same-shell safety dependency:** For each eligible failure, execute every Step-7 Bash fence from failure-identity initialization through `trap - EXIT` and the caller handoff assignment in the uninterrupted owning execution-unit shell: the Gate-0 shell for `baseline-rust-session-directory-matrix`, otherwise the Gate-8 shell. The harness helpers, arrays, `BASE_WT` ownership flag, EXIT cleanup trap, and caller gate state are live safety state; never split this protocol across one-shot or replacement shells.

```bash
FAILED_COMMAND_NAME=${FAILED_COMMAND_NAME-}
FAILURE_SEQUENCE=${FAILURE_SEQUENCE-}
FAILURE_SEQUENCE_WIDTH=9
FAILURE_SEQUENCE_MAX=999999999
FAILURE_SEQUENCE_STATE="$LOG_ROOT/waiver-sequence-state.txt"
FAILURE_SEQUENCE_LOCK="$LOG_ROOT/.waiver-sequence-lock"
REJECTED_INPUT_FILE=

reject_failure_identity() {
  local reason=$1
  if ! REJECTED_INPUT_FILE=$(mktemp \
    "$LOG_ROOT/rejected-waiver-input.XXXXXXXX")
  then
    printf 'could not create durable failure-identity denial\n' >&2
    return 1
  fi
  {
    printf 'waiver_denied=%s\n' "$reason"
    printf 'command_name=%q\n' "$FAILED_COMMAND_NAME"
    printf 'failure_sequence=%q\n' "$FAILURE_SEQUENCE"
    printf 'waiver_granted=false\n'
  } >"$REJECTED_INPUT_FILE"
  return 1
}

deny_locked_failure_sequence() {
  local reason=$1
  if ! rmdir -- "$FAILURE_SEQUENCE_LOCK"; then
    reason="$reason;sequence_lock_release_failed"
  fi
  reject_failure_identity "$reason"
}

if [[ ! "$FAILED_COMMAND_NAME" =~ ^[A-Za-z0-9._-]+$ ]] \
  || [[ ! "$FAILURE_SEQUENCE" =~ ^[1-9][0-9]{0,8}$ ]]
then
  reject_failure_identity invalid_failure_identity
  exit 1
fi

ELIGIBILITY_DENIAL=
case "$FAILED_COMMAND_NAME" in
  baseline-rust-session-directory-matrix)
    FAILED_COMMAND_CLASS=playwright-environment
    FAILED_COMMAND_PHASE=gate0-baseline
    ;;
  baseline-npm-test)
    FAILED_COMMAND_CLASS=coordinated-npm
    FAILED_COMMAND_PHASE=gate0-baseline
    ;;
  final-rust-session-directory-matrix)
    FAILED_COMMAND_CLASS=playwright-environment
    FAILED_COMMAND_PHASE=gate8-final
    ;;
  final-server-all-targets|final-sessions-read-only|final-clippy-workspace|final-clippy-codex-real|final-clippy-opencode-real|final-clippy-all-features)
    FAILED_COMMAND_CLASS=cargo
    FAILED_COMMAND_PHASE=gate8-final
    ;;
  final-npm-check|final-npm-test)
    FAILED_COMMAND_CLASS=coordinated-npm
    FAILED_COMMAND_PHASE=gate8-final
    ;;
  *)
    FAILED_COMMAND_CLASS=ineligible
    FAILED_COMMAND_PHASE=eligibility
    ELIGIBILITY_DENIAL="ineligible_command:$FAILED_COMMAND_NAME"
    ;;
esac

if ! mkdir -- "$FAILURE_SEQUENCE_LOCK"; then
  reject_failure_identity failure_sequence_lock_unavailable
  exit 1
fi
LAST_FAILURE_SEQUENCE=0
if [[ -L "$FAILURE_SEQUENCE_STATE" ]]; then
  deny_locked_failure_sequence invalid_failure_sequence_state
  exit 1
fi
if [[ -e "$FAILURE_SEQUENCE_STATE" ]]; then
  if [[ ! -f "$FAILURE_SEQUENCE_STATE" ]]; then
    deny_locked_failure_sequence invalid_failure_sequence_state
    exit 1
  fi
  if ! mapfile -t FAILURE_SEQUENCE_LINES <"$FAILURE_SEQUENCE_STATE"; then
    deny_locked_failure_sequence unreadable_failure_sequence_state
    exit 1
  fi
  if [[ "${#FAILURE_SEQUENCE_LINES[@]}" -ne 1 ]] \
    || [[ ! "${FAILURE_SEQUENCE_LINES[0]}" =~ ^last_sequence=(0|[1-9][0-9]{0,8})$ ]]
  then
    deny_locked_failure_sequence invalid_failure_sequence_state
    exit 1
  fi
  LAST_FAILURE_SEQUENCE=${FAILURE_SEQUENCE_LINES[0]#last_sequence=}
fi
if [[ "$LAST_FAILURE_SEQUENCE" == "$FAILURE_SEQUENCE_MAX" ]]; then
  deny_locked_failure_sequence failure_sequence_exhausted
  exit 1
fi
if [[ "$LAST_FAILURE_SEQUENCE" == 0 ]]; then
  LAST_FAILURE_SEQUENCE_VALUE=0
else
  LAST_FAILURE_SEQUENCE_VALUE=$((10#$LAST_FAILURE_SEQUENCE))
fi
NEXT_FAILURE_SEQUENCE_VALUE=$((LAST_FAILURE_SEQUENCE_VALUE + 1))
if [[ "$FAILURE_SEQUENCE" != "$NEXT_FAILURE_SEQUENCE_VALUE" ]]; then
  deny_locked_failure_sequence \
    "failure_sequence_not_next:expected=$NEXT_FAILURE_SEQUENCE_VALUE"
  exit 1
fi
printf -v FAILURE_SEQUENCE_PADDED '%*s' \
  "$FAILURE_SEQUENCE_WIDTH" "$FAILURE_SEQUENCE"
FAILURE_SEQUENCE_PADDED=${FAILURE_SEQUENCE_PADDED// /0}
if [[ ! "$FAILURE_SEQUENCE_PADDED" =~ ^[0-9]{9}$ ]]; then
  deny_locked_failure_sequence internal_failure_sequence_padding_error
  exit 1
fi
if ! FAILURE_SEQUENCE_STATE_TMP=$(mktemp \
  "$LOG_ROOT/.waiver-sequence-state.XXXXXXXX")
then
  deny_locked_failure_sequence failure_sequence_state_temp_failed
  exit 1
fi
if ! printf 'last_sequence=%s\n' "$FAILURE_SEQUENCE" \
  >"$FAILURE_SEQUENCE_STATE_TMP"
then
  rm -f -- "$FAILURE_SEQUENCE_STATE_TMP"
  deny_locked_failure_sequence failure_sequence_state_write_failed
  exit 1
fi
if ! mv -f -- "$FAILURE_SEQUENCE_STATE_TMP" "$FAILURE_SEQUENCE_STATE"; then
  rm -f -- "$FAILURE_SEQUENCE_STATE_TMP"
  deny_locked_failure_sequence failure_sequence_state_replace_failed
  exit 1
fi
if ! rmdir -- "$FAILURE_SEQUENCE_LOCK"; then
  reject_failure_identity failure_sequence_lock_release_failed
  exit 1
fi

FAILURE_ID="${FAILURE_SEQUENCE_PADDED}-${FAILED_COMMAND_PHASE}-${FAILED_COMMAND_NAME}"
EVIDENCE_PREFIX="waiver-$FAILURE_ID"
PAIR_DISPOSITION_FILE="$LOG_ROOT/$EVIDENCE_PREFIX-disposition.txt"
if compgen -G "$LOG_ROOT/$EVIDENCE_PREFIX-*" >/dev/null; then
  COLLISION_DISPOSITION=$(mktemp \
    "$LOG_ROOT/rejected-$FAILURE_ID-collision.XXXXXXXX")
  {
    printf 'waiver_denied=evidence_prefix_collision\n'
    printf 'command_name=%s\n' "$FAILED_COMMAND_NAME"
    printf 'command_phase=%s\n' "$FAILED_COMMAND_PHASE"
    printf 'command_class=%s\n' "$FAILED_COMMAND_CLASS"
    printf 'occupied_prefix=%s\n' "$EVIDENCE_PREFIX"
    printf 'waiver_granted=false\n'
  } >"$COLLISION_DISPOSITION"
  exit 1
fi
pair_deny() {
  local reason=$1
  local revised
  if [[ -e "$PAIR_DISPOSITION_FILE" ]] \
    && grep -q '^waiver_denied=' "$PAIR_DISPOSITION_FILE"
  then
    printf 'secondary_denial=%s\n' "$reason" >>"$PAIR_DISPOSITION_FILE"
  elif [[ -e "$PAIR_DISPOSITION_FILE" ]]; then
    revised=$(mktemp "$LOG_ROOT/$EVIDENCE_PREFIX-revised.XXXXXXXX")
    grep -v '^waiver_granted=' "$PAIR_DISPOSITION_FILE" >"$revised" || true
    {
      cat "$revised"
      printf 'waiver_denied=%s\n' "$reason"
      printf 'waiver_granted=false\n'
    } >"$PAIR_DISPOSITION_FILE"
    rm -f -- "$revised"
  else
    {
      printf 'waiver_denied=%s\n' "$reason"
      printf 'command_name=%s\n' "$FAILED_COMMAND_NAME"
      printf 'command_phase=%s\n' "$FAILED_COMMAND_PHASE"
      printf 'command_class=%s\n' "$FAILED_COMMAND_CLASS"
      printf 'waiver_granted=false\n'
    } >"$PAIR_DISPOSITION_FILE"
  fi
  printf 'waiver denied: %s\n' "$reason" >&2
  return 1
}
pair_step() {
  local reason=$1
  shift
  local status
  if "$@"; then
    return 0
  else
    status=$?
  fi
  pair_deny "$reason:status=$status"
}
directory_is_empty() {
  local directory=$1
  local first_entry
  [[ -d "$directory" ]] || return 1
  if ! first_entry=$(find "$directory" -mindepth 1 -print -quit); then
    return 1
  fi
  [[ -z "$first_entry" ]]
}
if [[ -n "$ELIGIBILITY_DENIAL" ]]; then
  pair_deny "$ELIGIBILITY_DENIAL"
fi
FAILED_ARGV_FILE="$LOG_ROOT/$FAILED_COMMAND_NAME.argv0"
pair_step missing_original_argv test -s "$FAILED_ARGV_FILE"
pair_step missing_original_command test -s \
  "$LOG_ROOT/$FAILED_COMMAND_NAME.command"
pair_step missing_original_log test -s \
  "$LOG_ROOT/$FAILED_COMMAND_NAME.log"
pair_step missing_original_exit test -s \
  "$LOG_ROOT/$FAILED_COMMAND_NAME.exit"
if ! ORIGINAL_STATUS=$(sed -n 's/^exit_code=//p' \
  "$LOG_ROOT/$FAILED_COMMAND_NAME.exit")
then
  pair_deny original_status_read_failed
fi
if [[ ! "$ORIGINAL_STATUS" =~ ^[0-9]+$ ]] \
  || [[ "$ORIGINAL_STATUS" -eq 0 ]]; then
  pair_deny "invalid_original_status:$ORIGINAL_STATUS"
fi
worktree_registration_present() {
  local phase=$1
  if ! run_logged "$EVIDENCE_PREFIX-$phase-worktree-list" \
    git -C "$WT" worktree list --porcelain
  then
    pair_deny "$phase-worktree-list-failed" || return 1
    return 1
  fi
  if ! grep -Fx "worktree $BASE_WT" \
    "$LOG_ROOT/$EVIDENCE_PREFIX-$phase-worktree-list.log"
  then
    pair_deny "$phase-worktree-registration-missing" || return 1
    return 1
  fi
}
worktree_is_clean() {
  local status_output
  if ! status_output=$(git -C "$BASE_WT" status \
    --porcelain=v1 --untracked-files=all)
  then
    return 1
  fi
  [[ -z "$status_output" ]]
}
worktree_is_detached() {
  local branch
  if ! branch=$(git -C "$BASE_WT" branch --show-current); then
    return 1
  fi
  [[ -z "$branch" ]]
}
worktree_is_detached_at_base_sha() {
  local branch
  local head
  if ! branch=$(git -C "$BASE_WT" branch --show-current); then
    return 1
  fi
  if ! head=$(git -C "$BASE_WT" rev-parse HEAD); then
    return 1
  fi
  [[ -z "$branch" && "$head" == "$BASE_SHA" ]]
}

if ! BASE_WT=$(mktemp -d \
  "$BASE_WORKTREE_PARENT/session-directory-page-prep-base.XXXXXXXX")
then
  pair_deny base_path_reservation_failed
fi
pair_step base_placeholder_remove_failed rmdir "$BASE_WT"
BASE_WT_CREATED=0

cleanup_base_worktree() {
  if [[ "$BASE_WT_CREATED" -ne 1 ]]; then
    return 0
  fi
  pair_step cleanup_canonical_path_mismatch \
    test "$(realpath "$BASE_WT")" = "$BASE_WT" || return 1
  pair_step cleanup_not_direct_child \
    test "$(dirname "$BASE_WT")" = "$BASE_WORKTREE_PARENT" || return 1
  pair_step cleanup_toplevel_mismatch \
    test "$(git -C "$BASE_WT" rev-parse --show-toplevel)" = "$BASE_WT" \
    || return 1
  pair_step cleanup_head_mismatch \
    test "$(git -C "$BASE_WT" rev-parse HEAD)" = "$BASE_SHA" || return 1
  pair_step cleanup_tracked_or_untracked_changes worktree_is_clean || return 1
  worktree_registration_present cleanup || return 1
  pair_step cleanup_not_detached_at_base_sha \
    worktree_is_detached_at_base_sha || return 1
  pair_step worktree_remove_failed \
    run_logged "$EVIDENCE_PREFIX-worktree-remove" \
      git -C "$WT" worktree remove --force "$BASE_WT" || return 1
  BASE_WT_CREATED=0
}
trap cleanup_base_worktree EXIT

pair_step worktree_add_failed \
  run_logged "$EVIDENCE_PREFIX-worktree-add" \
    git -C "$WT" worktree add --detach "$BASE_WT" "$BASE_SHA"
BASE_WT_CREATED=1
pair_step post_add_canonical_path_mismatch \
  test "$(realpath "$BASE_WT")" = "$BASE_WT"
pair_step post_add_not_direct_child \
  test "$(dirname "$BASE_WT")" = "$BASE_WORKTREE_PARENT"
pair_step post_add_toplevel_mismatch \
  test "$(git -C "$BASE_WT" rev-parse --show-toplevel)" = "$BASE_WT"
pair_step post_add_head_mismatch \
  test "$(git -C "$BASE_WT" rev-parse HEAD)" = "$BASE_SHA"
pair_step post_add_not_detached worktree_is_detached
pair_step post_add_dirty worktree_is_clean
pair_step base_checkout_has_node_modules test ! -e "$BASE_WT/node_modules"
pair_step worktree_parent_has_node_modules \
  test ! -e "$BASE_WORKTREE_PARENT/node_modules"
worktree_registration_present post-add
```

The ownership flag is set only after successful `worktree add`; removal remains gated by canonical/direct-child/toplevel/HEAD/clean/positive-registration proof. After the clean and registration checks, `worktree_is_detached_at_base_sha` re-reads both `branch --show-current` and `rev-parse HEAD`; its detached-and-exact-`BASE_SHA` result is the last predicate immediately before `git worktree remove --force`. Invalid input and occupied-prefix attempts write separate `rejected-*` denial artifacts rather than overwrite prior evidence. Keep the EXIT trap armed, and retain the prohibition on `rm -rf` and `git clean`.

Prove tracked dependency identity against both actual checkout paths:

```bash
pair_step dependency_manifest_diff_failed \
  git -C "$WT" diff --exit-code "$BASE_SHA" HEAD -- \
    Cargo.toml Cargo.lock package.json package-lock.json \
    ':(glob)**/Cargo.toml' \
    ':(glob)**/package.json' \
    ':(glob)**/package-lock.json'
for rel in \
  Cargo.toml Cargo.lock package.json package-lock.json \
  crates/freshell-server/Cargo.toml crates/freshell-sessions/Cargo.toml
do
  reason=${rel//\//_}
  pair_step "dependency_file_mismatch:$reason" \
    cmp "$WT/$rel" "$BASE_WT/$rel"
done
```

The Node report must contain 85 sorted paired direct dependency records, each containing labeled target and base installed version, lock version, and actual resolved real path, followed by exactly these counters:

```text
direct_count=85
missing=0
resolution_mismatch=0
lock_entry_missing=0
installed_version_mismatch=0
exact_entrypoint_mismatch=0
```

Record paired Node resolution only for npm and Playwright, then capture command-class context for both real paths, normalize only checkout and HEAD, and require byte equality:

```bash
case "$FAILED_COMMAND_CLASS" in
  coordinated-npm|playwright-environment)
    pair_step node_pre_resolution_failed \
      record_node_resolution \
        "$EVIDENCE_PREFIX-pre-pair" "$WT" "$BASE_WT"
    ;;
  cargo)
    ;;
  *)
    pair_deny "unsupported_context_class:$FAILED_COMMAND_CLASS"
    ;;
esac
pair_step candidate_context_failed \
  record_comparison_context \
    "$EVIDENCE_PREFIX-candidate" "$WT" \
    "$FAILED_COMMAND_CLASS" "$FAILED_COMMAND_NAME" "$FAILED_COMMAND_PHASE"
pair_step base_context_failed \
  record_comparison_context \
    "$EVIDENCE_PREFIX-base" "$BASE_WT" \
    "$FAILED_COMMAND_CLASS" "$FAILED_COMMAND_NAME" "$FAILED_COMMAND_PHASE"
if ! grep -Ev '^(checkout|head)=' \
  "$LOG_ROOT/$EVIDENCE_PREFIX-candidate-context.txt" \
  >"$LOG_ROOT/$EVIDENCE_PREFIX-candidate-context.normalized.txt"
then
  pair_deny candidate_context_normalization_failed
fi
if ! grep -Ev '^(checkout|head)=' \
  "$LOG_ROOT/$EVIDENCE_PREFIX-base-context.txt" \
  >"$LOG_ROOT/$EVIDENCE_PREFIX-base-context.normalized.txt"
then
  pair_deny base_context_normalization_failed
fi
pair_step context_mismatch \
  diff -u \
    "$LOG_ROOT/$EVIDENCE_PREFIX-candidate-context.normalized.txt" \
    "$LOG_ROOT/$EVIDENCE_PREFIX-base-context.normalized.txt"
```

Only `checkout=` and `head=` are removed before context comparison. Command class, exact command name, gate phase, and that class's explicit non-secret tool/environment evidence must be byte-identical. Cargo context contains no Node/Playwright probes; npm context contains no Cargo/Playwright probes; Playwright context contains no Cargo/npm probes. Paired Node resolution is required only for coordinated npm and Playwright.

Required attestations by class are exact:

| Failed command class | Required paired attestations |
|---|---|
| Cargo test/check/Clippy | actual manifest/lock identity; same cargo/rustc and normalized non-secret environment; separate initially empty `CARGO_TARGET_DIR`s; same arguments; positive execution where tests are expected |
| Coordinated npm | package/lock identity; pre/post actual-path Node resolution; same node/npm and selected Vitest backend; cloud account/project/region/image and credential availability when applicable; coordinator before/after records; positive executed counts |
| Playwright bootstrap/environment | package/lock identity; pre/post actual-path Node resolution; same Node/Playwright/Chromium paths; `FRESHELL_E2E_BACKEND=local`; same `rust-chromium` config/spec/worker/reporter arguments; failure before any functional assertion |

Rerun the exact failed command freshly on both candidate and base. Do not compare the original candidate failure directly with one base run. For Cargo create separate initially empty targets; for Playwright create separate external output directories; for npm capture coordinator state before and after each run:

```bash
if ! PAIR_ROOT=$(mktemp -d \
  "$LOG_ROOT/$EVIDENCE_PREFIX-pair.XXXXXXXX")
then
  pair_deny pair_root_creation_failed
fi
ORIGINAL_CARGO_TARGET=
CANDIDATE_TARGET=
BASE_TARGET=
CANDIDATE_PW_OUTPUT=
BASE_PW_OUTPUT=
case "$FAILED_COMMAND_CLASS" in
  cargo)
    if [[ -n "${CARGO_TARGET_DIR:-}" ]]; then
      if ! ORIGINAL_CARGO_TARGET=$(realpath -m "$CARGO_TARGET_DIR"); then
        pair_deny original_cargo_target_normalization_failed
      fi
    else
      if ! ORIGINAL_CARGO_TARGET=$(realpath -m "$WT/target"); then
        pair_deny original_cargo_target_normalization_failed
      fi
    fi
    CANDIDATE_TARGET="$PAIR_ROOT/candidate-target"
    BASE_TARGET="$PAIR_ROOT/base-target"
    pair_step cargo_target_creation_failed \
      mkdir "$CANDIDATE_TARGET" "$BASE_TARGET"
    pair_step candidate_cargo_target_not_empty \
      directory_is_empty "$CANDIDATE_TARGET"
    pair_step base_cargo_target_not_empty \
      directory_is_empty "$BASE_TARGET"
    ;;
  playwright-environment)
    CANDIDATE_PW_OUTPUT="$PAIR_ROOT/candidate-playwright"
    BASE_PW_OUTPUT="$PAIR_ROOT/base-playwright"
    pair_step playwright_output_creation_failed \
      mkdir "$CANDIDATE_PW_OUTPUT" "$BASE_PW_OUTPUT"
    pair_step candidate_playwright_output_not_empty \
      directory_is_empty "$CANDIDATE_PW_OUTPUT"
    pair_step base_playwright_output_not_empty \
      directory_is_empty "$BASE_PW_OUTPUT"
    ;;
  coordinated-npm)
    ;;
  *)
    pair_deny "unsupported_pair_class:$FAILED_COMMAND_CLASS"
    ;;
esac

pair_step candidate_argv_build_failed \
  build_paired_argv \
    "$WT" "$CANDIDATE_TARGET" "$CANDIDATE_PW_OUTPUT" CANDIDATE_ARGV
pair_step base_argv_build_failed \
  build_paired_argv \
    "$BASE_WT" "$BASE_TARGET" "$BASE_PW_OUTPUT" BASE_ARGV
unset CANDIDATE_STATUS BASE_STATUS

if [[ "$FAILED_COMMAND_CLASS" == coordinated-npm ]]; then
  pair_step candidate_coordinator_before_failed \
    capture_coordinator_state "$EVIDENCE_PREFIX-candidate-before" "$WT"
fi
if run_logged "$EVIDENCE_PREFIX-paired-candidate" "${CANDIDATE_ARGV[@]}"; then
  CANDIDATE_STATUS=0
else
  CANDIDATE_STATUS=$?
fi
if [[ "$FAILED_COMMAND_CLASS" == coordinated-npm ]]; then
  pair_step candidate_coordinator_after_failed \
    capture_coordinator_state "$EVIDENCE_PREFIX-candidate-after" "$WT"
  pair_step base_coordinator_before_failed \
    capture_coordinator_state "$EVIDENCE_PREFIX-base-before" "$BASE_WT"
fi
if run_logged "$EVIDENCE_PREFIX-paired-base" "${BASE_ARGV[@]}"; then
  BASE_STATUS=0
else
  BASE_STATUS=$?
fi
if [[ "$FAILED_COMMAND_CLASS" == coordinated-npm ]]; then
  pair_step base_coordinator_after_failed \
    capture_coordinator_state "$EVIDENCE_PREFIX-base-after" "$BASE_WT"
fi
```

For Cargo, `build_paired_argv` retains the entire original argv—including `env CARGO_TERM_COLOR=never` where present—and only rewrites the manifest checkout path, then adds one outer `env CARGO_TARGET_DIR=<fresh target>`. It never drops `CARGO_TERM_COLOR`, flags, package/feature/target arguments, or nested `env` assignments. For npm it rewrites only the `--prefix` checkout and creates no irrelevant scratch directory. For Playwright it rewrites checkout-bearing `--chdir`/config/spec paths and the one unavoidable output path; both class-specific output directories are explicitly created and proven empty before replay. Cargo target directories exist only for Cargo. Compare exact argv, command class, named failing tests or diagnostic codes, phase, and stable error lines in the executable adjudicator:

```bash
case "$FAILED_COMMAND_CLASS" in
  coordinated-npm|playwright-environment)
    pair_step node_post_resolution_failed \
      record_node_resolution \
        "$EVIDENCE_PREFIX-post-pair" "$WT" "$BASE_WT"
    pair_step node_resolution_changed \
      cmp \
        "$LOG_ROOT/$EVIDENCE_PREFIX-pre-pair-node-resolution.txt" \
        "$LOG_ROOT/$EVIDENCE_PREFIX-post-pair-node-resolution.txt"
    ;;
  cargo)
    ;;
esac

if python3 -I - \
  "$LOG_ROOT" "$EVIDENCE_PREFIX" "$FAILED_COMMAND_CLASS" \
  "$FAILED_COMMAND_NAME" "$FAILED_COMMAND_PHASE" \
  "$ORIGINAL_STATUS" "$CANDIDATE_STATUS" "$BASE_STATUS" \
  "$WT" "$BASE_WT" "$PAIR_ROOT" "$ORIGINAL_CARGO_TARGET" \
  "$CANDIDATE_TARGET" "$BASE_TARGET" \
  "$CANDIDATE_PW_OUTPUT" "$BASE_PW_OUTPUT" <<'PY'
from pathlib import Path
import json
import os
import re
import sys
import traceback

(
    log_root_raw,
    prefix,
    command_class,
    command_name,
    command_phase,
    original_status_raw,
    candidate_status_raw,
    base_status_raw,
    wt_raw,
    base_wt_raw,
    pair_root_raw,
    original_cargo_target_raw,
    candidate_target_raw,
    base_target_raw,
    candidate_pw_raw,
    base_pw_raw,
) = sys.argv[1:]
log_root = Path(log_root_raw)
wt = os.path.realpath(wt_raw)
base_wt = os.path.realpath(base_wt_raw)
pair_root = os.path.realpath(pair_root_raw)


def optional_realpath(value: str) -> str | None:
    return os.path.realpath(value) if value else None


original_cargo_target = optional_realpath(original_cargo_target_raw)
candidate_target = optional_realpath(candidate_target_raw)
base_target = optional_realpath(base_target_raw)
candidate_pw = optional_realpath(candidate_pw_raw)
base_pw = optional_realpath(base_pw_raw)
disposition_path = log_root / f"{prefix}-disposition.txt"
ansi = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


class Denial(RuntimeError):
    pass


def write_denial(reason: str) -> None:
    safe_reason = reason.replace("\n", "\\n")
    disposition_path.write_text(
        f"waiver_denied={safe_reason}\n"
        f"command_name={command_name}\n"
        f"command_phase={command_phase}\n"
        f"command_class={command_class}\n"
        "waiver_granted=false\n",
        encoding="utf-8",
    )


def denial_hook(exception_type, exception, exception_traceback) -> None:
    if isinstance(exception, Denial):
        reason = str(exception)
    else:
        reason = (
            f"adjudicator_internal:{exception_type.__name__}:"
            f"{str(exception).replace(chr(10), ' ')}"
        )
    write_denial(reason)
    traceback.print_exception(exception_type, exception, exception_traceback)


sys.excepthook = denial_hook


def require(condition: bool, reason: str) -> None:
    if not condition:
        raise Denial(reason)


def parse_status(label: str, raw: str) -> int:
    require(re.fullmatch(r"[0-9]+", raw) is not None, f"invalid_status:{label}")
    value = int(raw)
    require(0 <= value <= 255, f"status_out_of_range:{label}")
    return value


original_status = parse_status("original", original_status_raw)
candidate_status = parse_status("candidate", candidate_status_raw)
base_status = parse_status("base", base_status_raw)


def read_exit(name: str) -> int:
    lines = (log_root / f"{name}.exit").read_text(encoding="utf-8").splitlines()
    values = [
        line.removeprefix("exit_code=")
        for line in lines
        if line.startswith("exit_code=")
    ]
    require(
        len(values) == 1 and values[0].isdigit(),
        f"invalid_exit_artifact:{name}",
    )
    return int(values[0])


def read_argv(name: str) -> list[str]:
    raw = (log_root / f"{name}.argv0").read_bytes()
    require(raw.endswith(b"\0"), f"invalid_argv_artifact:{name}")
    return [value.decode("utf-8") for value in raw[:-1].split(b"\0")]


def clean_text(name: str) -> str:
    return ansi.sub(
        "",
        (log_root / f"{name}.log").read_text(
            encoding="utf-8", errors="replace"
        ),
    )


def command_index(argv: list[str], executable: str) -> int:
    indexes = [index for index, value in enumerate(argv) if value == executable]
    require(len(indexes) == 1, f"argv_missing_or_duplicate:{executable}")
    return indexes[0]


require(
    original_status == read_exit(command_name) and original_status != 0,
    "original_status_artifact_mismatch",
)
require(
    candidate_status == read_exit(f"{prefix}-paired-candidate"),
    "candidate_status_artifact_mismatch",
)
require(
    base_status == read_exit(f"{prefix}-paired-base"),
    "base_status_artifact_mismatch",
)
original_argv = read_argv(command_name)
candidate_argv = read_argv(f"{prefix}-paired-candidate")
base_argv = read_argv(f"{prefix}-paired-base")


def expected_argv(
    checkout: str,
    target: str | None,
    playwright_output: str | None,
) -> list[str]:
    rewritten = [argument.replace(wt, checkout) for argument in original_argv]
    if command_class == "playwright-environment":
        require(playwright_output is not None, "missing_playwright_output_path")
        rewritten = [
            f"--output={playwright_output}"
            if argument.startswith("--output=")
            else argument
            for argument in rewritten
        ]
    if command_class == "cargo":
        require(target is not None, "missing_cargo_target_path")
        require(
            not any(
                argument.startswith("CARGO_TARGET_DIR=")
                for argument in original_argv
            ),
            "original_command_has_explicit_cargo_target",
        )
        rewritten = ["env", f"CARGO_TARGET_DIR={target}", *rewritten]
    return rewritten


require(
    candidate_argv == expected_argv(wt, candidate_target, candidate_pw),
    "candidate_argv_mismatch",
)
require(
    base_argv == expected_argv(base_wt, base_target, base_pw),
    "base_argv_mismatch",
)

if command_class == "cargo":
    cargo_index = command_index(original_argv, "cargo")
    require(
        cargo_index + 1 < len(original_argv)
        and original_argv[cargo_index + 1] in {"test", "check", "clippy"},
        "invalid_cargo_subcommand",
    )
elif command_class == "coordinated-npm":
    command_index(original_argv, "npm")
elif command_class == "playwright-environment":
    for required_argument in [
        "FRESHELL_E2E_BACKEND=local",
        "--project=rust-chromium",
        "--workers=1",
        "--reporter=line",
    ]:
        require(
            required_argument in original_argv,
            f"missing_playwright_argument:{required_argument}",
        )
    require(
        sum(argument.startswith("--output=") for argument in original_argv) == 1,
        "invalid_original_playwright_output_argument",
    )
else:
    raise Denial(f"unknown_class:{command_class}")

original_text = clean_text(command_name)
candidate_text = clean_text(f"{prefix}-paired-candidate")
base_text = clean_text(f"{prefix}-paired-base")


def cargo_counts(text: str) -> dict[str, int]:
    counts = {"passed": 0, "failed": 0, "ignored": 0}
    pattern = re.compile(
        r"test result: (?:ok|FAILED)\.\s+"
        r"(\d+) passed;\s+(\d+) failed;\s+(\d+) ignored;"
    )
    for passed, failed, ignored in pattern.findall(text):
        counts["passed"] += int(passed)
        counts["failed"] += int(failed)
        counts["ignored"] += int(ignored)
    return counts


def npm_counts(text: str) -> dict[str, int]:
    counts = {"passed": 0, "failed": 0, "skipped": 0, "todo": 0}
    for line in text.splitlines():
        if not re.search(r"\bTests\b", line):
            continue
        for count, state in re.findall(
            r"(\d+)\s+(passed|failed|skipped|todo)\b",
            line,
            re.IGNORECASE,
        ):
            counts[state.lower()] += int(count)
    return counts


def executed_count(counts: dict[str, int]) -> int:
    return counts.get("passed", 0) + counts.get("failed", 0)


def playwright_green(text: str) -> bool:
    return (
        len(
            re.findall(
                r"(^|[^0-9])7 passed([^0-9]|$)",
                text,
                re.MULTILINE,
            )
        )
        == 1
        and not re.search(
            r"(^|[^0-9])(failed|skipped|interrupted|did not run)"
            r"([^0-9]|$)",
            text,
            re.IGNORECASE | re.MULTILINE,
        )
    )


def requires_executed_tests() -> bool:
    if command_class == "coordinated-npm":
        return True
    if command_class != "cargo":
        return False
    cargo_index = command_index(original_argv, "cargo")
    return original_argv[cargo_index + 1] == "test"


def counts_for(text: str) -> dict[str, int]:
    if command_class == "cargo":
        return cargo_counts(text)
    if command_class == "coordinated-npm":
        return npm_counts(text)
    return {"passed": 7 if playwright_green(text) else 0, "failed": 0}

execution_evidence = {
    "original": counts_for(original_text),
    "candidate": counts_for(candidate_text),
    "base": counts_for(base_text),
}
(log_root / f"{prefix}-execution-counts.json").write_text(
    json.dumps(execution_evidence, indent=2, sort_keys=True) + "\n",
    encoding="utf-8",
)


def npm_command_key() -> str:
    npm_index = command_index(original_argv, "npm")
    tail = original_argv[npm_index + 1:]
    if tail[:1] == ["--prefix"]:
        tail = tail[2:]
    require(bool(tail), "missing_npm_command_key")
    if tail[0] == "test":
        return "test"
    require(tail[:2] == ["run", "check"], "unexpected_npm_command_key")
    return "check"


def coordinator_record(snapshot: str, key: str):
    payload = json.loads(
        (log_root / f"{prefix}-{snapshot}-command-runs.json").read_text(
            encoding="utf-8"
        )
    )
    require(payload.get("schemaVersion") == 1, f"invalid_coordinator:{snapshot}")
    return payload.get("byKey", {}).get(key)


def coordinator_run_id(record, label: str) -> str:
    require(isinstance(record, dict), f"missing_coordinator_record:{label}")
    run_id = record.get("runId")
    require(
        isinstance(run_id, str) and bool(run_id.strip()),
        f"missing_or_empty_coordinator_run_id:{label}",
    )
    return run_id


def validate_completed_record(
    record,
    key: str,
    checkout: str,
    status: int,
) -> str:
    require(isinstance(record, dict), f"missing_coordinator_record:{checkout}")
    run_id = coordinator_run_id(record, checkout)
    require(
        record.get("entrypoint", {}).get("commandKey") == key,
        f"coordinator_key_mismatch:{checkout}",
    )
    require(
        record.get("command", {}).get("argv") == [key],
        f"coordinator_argv_mismatch:{checkout}",
    )
    require(record.get("exitCode") == status, f"coordinator_status_mismatch:{checkout}")
    require(
        record.get("outcome") == ("success" if status == 0 else "failure"),
        f"coordinator_outcome_mismatch:{checkout}",
    )
    require(bool(record.get("finishedAt")), f"coordinator_unfinished:{checkout}")
    require(
        os.path.realpath(record.get("repo", {}).get("checkoutRoot", ""))
        == checkout,
        f"coordinator_checkout_mismatch:{checkout}",
    )
    return run_id


if command_class == "coordinated-npm":
    key = npm_command_key()
    candidate_before = coordinator_record("candidate-before", key)
    candidate_after = coordinator_record("candidate-after", key)
    base_before = coordinator_record("base-before", key)
    base_after = coordinator_record("base-after", key)
    candidate_after_run_id = validate_completed_record(
        candidate_after, key, wt, candidate_status
    )
    base_after_run_id = validate_completed_record(
        base_after, key, base_wt, base_status
    )
    if candidate_before is not None:
        candidate_before_run_id = coordinator_run_id(
            candidate_before, "candidate-before"
        )
        require(
            candidate_before_run_id != candidate_after_run_id,
            "candidate_coordinator_run_not_fresh",
        )
    base_before_run_id = coordinator_run_id(base_before, "base-before")
    require(
        base_before_run_id == candidate_after_run_id,
        "coordinator_changed_between_candidate_and_base",
    )
    require(
        base_after_run_id != base_before_run_id,
        "base_coordinator_run_not_fresh",
    )


if candidate_status == 0:
    if command_class == "playwright-environment":
        require(playwright_green(candidate_text), "candidate_playwright_not_exactly_green")
    elif requires_executed_tests():
        require(
            executed_count(execution_evidence["candidate"]) > 0,
            "candidate_recovered_without_executed_tests",
        )
    disposition_path.write_text(
        "disposition=paired_candidate_recovered_green\n"
        f"command_name={command_name}\n"
        f"command_phase={command_phase}\n"
        f"command_class={command_class}\n"
        "waiver_granted=false\n",
        encoding="utf-8",
    )
    print("paired_candidate_recovered_green")
    raise SystemExit(0)

require(base_status != 0, "base_passed_candidate_failed")
require(
    original_status == candidate_status == base_status,
    "exit_status_mismatch",
)
if requires_executed_tests():
    for phase_name in ["original", "candidate", "base"]:
        require(
            executed_count(execution_evidence[phase_name]) > 0,
            f"{phase_name}_missing_executed_tests",
        )

cargo_signature_pattern = re.compile(
    r"^(?:error\[E[0-9]+\]|error:|test .* \.\.\. FAILED|"
    r"failures:|---- .* stdout ----)"
)
npm_signature_pattern = re.compile(
    r"^\s*(?:FAIL\s|×\s|Test Files\b|Tests\b|Error:|code: [1-9])"
)
playwright_allowed_pattern = re.compile(
    r"(browserType\.launch:.*(?:Executable doesn't exist|"
    r"Host system is missing|shared librar|cannot open shared object|"
    r"sandbox|EACCES|EPERM|Permission denied|EADDRINUSE|"
    r"address already in use|Missing X server|DISPLAY)|"
    r"Host system is missing dependencies|"
    r"error while loading shared libraries|cannot open shared object file|"
    r"No usable sandbox|setuid sandbox|"
    r"sandbox.*(?:denied|not supported|permission)|"
    r"(?:spawn|open).*?(?:EACCES|EPERM|Permission denied)|"
    r"EADDRINUSE|address already in use|Missing X server)",
    re.IGNORECASE,
)
playwright_reject_pattern = re.compile(
    r"(TimeoutError|timed out|test timeout|AssertionError|"
    r"Error:\s*expect|\bExpected:|\bReceived:|"
    r"\.to(?:Equal|Contain|Be|Have|Match)|"
    r"locator\.|page\.(?:click|fill|waitFor|goto)|"
    r"request\.(?:get|post|delete)|HTTP\s+[45][0-9][0-9]|"
    r"functional assertion|route/API mismatch|DOM mismatch)",
    re.IGNORECASE,
)
playwright_substantive_pattern = re.compile(
    r"(Error:|browserType\.launch:|Host system is missing|"
    r"shared librar|cannot open shared object|sandbox|permission|"
    r"EACCES|EPERM|EADDRINUSE|address already in use|"
    r"Missing X server|Timeout|Assertion|Expected:|Received:)",
    re.IGNORECASE,
)

def normalize_authorized_paths(
    line: str,
    checkout: str,
    target: str | None,
    output: str | None,
    replay_root: str | None,
) -> str:
    replacements = [
        (output, "<OUTPUT>"),
        (target, "<TARGET>"),
        (checkout, "<CHECKOUT>"),
        (replay_root, "<PAIR_ROOT>"),
    ]
    normalized = line
    for path, placeholder in sorted(
        [(path, placeholder) for path, placeholder in replacements if path],
        key=lambda entry: len(entry[0]),
        reverse=True,
    ):
        normalized = normalized.replace(path, placeholder)
    return normalized


def original_playwright_output() -> str | None:
    if command_class != "playwright-environment":
        return None
    values = [
        argument.removeprefix("--output=")
        for argument in original_argv
        if argument.startswith("--output=")
    ]
    require(len(values) == 1 and bool(values[0]), "missing_original_output_path")
    return os.path.realpath(values[0])


def signature(
    label: str,
    text: str,
    checkout: str,
    target: str | None,
    output: str | None,
    replay_root: str | None,
) -> tuple[list[str], str]:
    if command_class == "cargo":
        selected = [
            line.strip()
            for line in text.splitlines()
            if cargo_signature_pattern.search(line)
        ]
        phase = (
            "test-execution"
            if any(
                " ... FAILED" in line or line.startswith("failures:")
                for line in selected
            )
            else "compile-or-lint"
        )
    elif command_class == "coordinated-npm":
        selected = [
            line.strip()
            for line in text.splitlines()
            if npm_signature_pattern.search(line)
        ]
        phase = "test-execution"
    else:
        require(
            not playwright_reject_pattern.search(text),
            f"{label}_playwright_functional_or_timeout_failure",
        )
        substantive = [
            line.strip()
            for line in text.splitlines()
            if playwright_substantive_pattern.search(line)
        ]
        disallowed = [
            line for line in substantive
            if not playwright_allowed_pattern.search(line)
        ]
        require(
            not disallowed,
            f"{label}_playwright_unclassified_error:{' | '.join(disallowed)}",
        )
        selected = [
            line for line in substantive
            if playwright_allowed_pattern.search(line)
        ]
        phase = "pre-assertion-bootstrap"
    require(bool(selected), f"{label}_empty_failure_signature")
    return (
        [
            normalize_authorized_paths(
                line, checkout, target, output, replay_root
            )
            for line in selected
        ],
        phase,
    )


original_signature, original_failure_phase = signature(
    "original",
    original_text,
    wt,
    original_cargo_target,
    original_playwright_output(),
    None,
)
candidate_signature, candidate_failure_phase = signature(
    "candidate",
    candidate_text,
    wt,
    candidate_target,
    candidate_pw,
    pair_root,
)
base_signature, base_failure_phase = signature(
    "base",
    base_text,
    base_wt,
    base_target,
    base_pw,
    pair_root,
)
for label, signature_lines, phase in [
    ("original", original_signature, original_failure_phase),
    ("paired-candidate", candidate_signature, candidate_failure_phase),
    ("paired-base", base_signature, base_failure_phase),
]:
    (log_root / f"{prefix}-{label}.signature").write_text(
        "\n".join(signature_lines) + "\n",
        encoding="utf-8",
    )
    (log_root / f"{prefix}-{label}.failure-phase").write_text(
        phase + "\n",
        encoding="utf-8",
    )
require(
    original_signature == candidate_signature == base_signature,
    "original_candidate_base_signature_mismatch",
)
require(
    original_failure_phase == candidate_failure_phase == base_failure_phase,
    "original_candidate_base_phase_mismatch",
)

if command_class == "playwright-environment":
    disposition = "matching_BASE_SHA_playwright_environment_failure"
else:
    disposition = "matching_unrelated_BASE_SHA_failure"
disposition_path.write_text(
    f"disposition={disposition}\n"
    f"command_name={command_name}\n"
    f"command_phase={command_phase}\n"
    f"failure_phase={candidate_failure_phase}\n"
    "waiver_granted=true\n",
    encoding="utf-8",
)
print(disposition)
PY
then
  :
else
  ADJUDICATOR_STATUS=$?
  if [[ ! -s "$PAIR_DISPOSITION_FILE" ]] \
    || ! grep -q '^waiver_denied=' "$PAIR_DISPOSITION_FILE"
  then
    pair_deny "adjudicator_failed_without_denial:status=$ADJUDICATOR_STATUS"
  fi
  exit "$ADJUDICATOR_STATUS"
fi

pair_step missing_adjudication_disposition test -s "$PAIR_DISPOSITION_FILE"
pair_step malformed_adjudication_grant \
  grep -Eq '^waiver_granted=(true|false)$' "$PAIR_DISPOSITION_FILE"
if [[ "$(grep -Ec '^waiver_granted=' "$PAIR_DISPOSITION_FILE")" -ne 1 ]]; then
  pair_deny malformed_adjudication_grant_count
fi
```

Interpretation is executable, not prose:

- Fresh candidate status zero records `paired_candidate_recovered_green`; Cargo/npm test classes require `passed + failed > 0`, and Playwright requires the exact seven-pass GREEN marker. No waiver is granted.
- For a matrix caller, the final cleanup fence consumes—but does not reclassify—the adjudicator's disposition. Only `paired_candidate_recovered_green` or `matching_BASE_SHA_playwright_environment_failure` for the exact caller name/phase is copied into caller state, and only after owned-worktree path/registration absence and `trap - EXIT`; every denial or cleanup failure leaves the caller gate closed.
- Ignored/skipped/todo counts are recorded but never contribute to executed-test evidence.
- A nonzero Playwright comparison does not require executed tests. It is eligible only when original, candidate, and base each contain at least one closed-allowlist launch/shared-library/sandbox/permission/port/display bootstrap diagnostic, no timeout/assertion/application diagnostic, and identical normalized `pre-assertion-bootstrap` signatures.
- Every nonzero waiver requires original/candidate/base exit-code, failure-phase, and stable-signature equality. Class-specific output/target/checkouts are replaced longest-first with common placeholders before residual pair-root normalization.
- Missing evidence, coordinator failures, shell precondition failures, functional Playwright evidence, or any mismatch writes `waiver_denied`; secondary cleanup failures append to that same record. The EXIT cleanup trap remains armed until the final path and registration absence checks pass.
- Every coordinator record participating in a freshness comparison must contain a nonempty string `runId`; candidate-after and base-after are validated completed records, and optional candidate-before plus required base-before are also rejected if their IDs are missing or blank. The retained comparisons require new/distinct IDs, matching exit status, expected command key/argv, finished timestamps, and the actual checkout root; a status view, missing identifier, or advisory baseline alone is insufficient.

Finally remove only the verified owned worktree and prove path and registration are absent:

```bash
pair_step owned_worktree_cleanup_failed cleanup_base_worktree
pair_step removed_worktree_path_still_exists test ! -e "$BASE_WT"
pair_step post_remove_worktree_list_failed \
  run_logged "$EVIDENCE_PREFIX-worktree-list-after" \
    git -C "$WT" worktree list --porcelain
if grep -Fx "worktree $BASE_WT" \
  "$LOG_ROOT/$EVIDENCE_PREFIX-worktree-list-after.log"
then
  pair_deny "removed_worktree_still_registered:$BASE_WT"
else
  REGISTRATION_GREP_STATUS=$?
  if [[ "$REGISTRATION_GREP_STATUS" -ne 1 ]]; then
    pair_deny \
      "post_remove_registration_lookup_failed:status=$REGISTRATION_GREP_STATUS"
  fi
fi

MATRIX_RECOVERY_DISPOSITION=
case "$FAILED_COMMAND_NAME" in
  baseline-rust-session-directory-matrix|final-rust-session-directory-matrix)
    if [[ "$(grep -Ec '^disposition=' "$PAIR_DISPOSITION_FILE")" -ne 1 ]]; then
      pair_deny matrix_recovery_disposition_count_invalid
    fi
    pair_step matrix_recovery_disposition_not_resumable \
      grep -Eq '^disposition=(paired_candidate_recovered_green|matching_BASE_SHA_playwright_environment_failure)$' \
        "$PAIR_DISPOSITION_FILE"
    pair_step matrix_recovery_command_name_mismatch \
      grep -Fx "command_name=$FAILED_COMMAND_NAME" "$PAIR_DISPOSITION_FILE"
    pair_step matrix_recovery_command_phase_mismatch \
      grep -Fx "command_phase=$FAILED_COMMAND_PHASE" "$PAIR_DISPOSITION_FILE"
    if ! MATRIX_RECOVERY_DISPOSITION=$(sed -n 's/^disposition=//p' \
      "$PAIR_DISPOSITION_FILE")
    then
      pair_deny matrix_recovery_disposition_read_failed
    fi
    ;;
esac
trap - EXIT
case "$FAILED_COMMAND_NAME" in
  baseline-rust-session-directory-matrix)
    BASELINE_MATRIX_DISPOSITION=$MATRIX_RECOVERY_DISPOSITION
    BASELINE_MATRIX_DISPOSITION_FILE=$PAIR_DISPOSITION_FILE
    ;;
  final-rust-session-directory-matrix)
    FINAL_MATRIX_DISPOSITION=$MATRIX_RECOVERY_DISPOSITION
    FINAL_MATRIX_DISPOSITION_FILE=$PAIR_DISPOSITION_FILE
    ;;
esac
```

The producer must pass before lookup, and only grep status `1` proves absence; status `0` means still registered and any status greater than `1` is a lookup failure. Do not use `! producer | grep`, `if grep` without status adjudication, or any equivalent fail-open negative check.

- [ ] **Step 8: Prove no manifest, lock, Kata, Playwright-config, or matrix-spec drift.**

```bash
git -C "$WT" diff --exit-code "$BASE_SHA" HEAD -- \
  Cargo.toml Cargo.lock .kata.toml package.json package-lock.json \
  ':(glob)**/Cargo.toml' \
  ':(glob)**/package.json' \
  ':(glob)**/package-lock.json' \
  test/e2e-browser/playwright.config.ts \
  test/e2e-browser/specs/session-directory-matrix.spec.ts
```

Expected: no output and exit 0.

- [ ] **Step 9: Prove final committed scope is exactly plan plus implementation file.**

```bash
printf '%s\n' "$PLAN_REL" "$SOURCE_REL" | sort \
  >"$LOG_ROOT/expected-final-paths.txt"
git -C "$WT" diff --name-only "$BASE_SHA" HEAD | sort \
  >"$LOG_ROOT/actual-final-paths.txt"
diff -u "$LOG_ROOT/expected-final-paths.txt" \
  "$LOG_ROOT/actual-final-paths.txt"
```

Expected exact paths:

```text
crates/freshell-server/src/session_directory.rs
docs/plans/2026-08-13-session-directory-page-prep.md
```

- [ ] **Step 10: Prove canonical implementation commit order, source-only scope, and a clean worktree.**

```bash
test -z "$(git -C "$WT" status --porcelain=v1 --untracked-files=all)"
git -C "$WT" log --format='%H %s' --reverse "$BASE_SHA"..HEAD \
  | tee "$LOG_ROOT/final-commits.txt"
```

Review every implementation commit with:

```bash
for commit in $(git -C "$WT" rev-list --reverse "$BASE_SHA"..HEAD); do
  subject=$(git -C "$WT" show -s --format=%s "$commit")
  if [[ "$subject" == test\(session-directory\):* \
     || "$subject" == refactor\(session-directory\):* \
     || "$subject" == perf\(session-directory\):* ]]; then
    test "$(git -C "$WT" diff-tree --no-commit-id --name-only -r "$commit")" = "$SOURCE_REL"
  fi
done
cat >"$LOG_ROOT/expected-implementation-subjects.txt" <<'SUBJECTS'
test(session-directory): characterize effective page boundaries
test(session-directory): pin paging totals and revisions
test(session-directory): pin cursor and deep partial edges
test(session-directory): freeze search and response semantics
refactor(session-directory): borrow provider display names
refactor(session-directory): stage candidate policy for differential
refactor(session-directory): cut route over to candidate policy
refactor(session-directory): remove eager policy residue
perf(session-directory): materialize only returned rows
SUBJECTS
git -C "$WT" log --format='%s' --reverse "$BASE_SHA"..HEAD \
  | grep -E '^(test|refactor|perf)\(session-directory\):' \
  >"$LOG_ROOT/actual-implementation-subjects.txt"
diff -u "$LOG_ROOT/expected-implementation-subjects.txt" \
  "$LOG_ROOT/actual-implementation-subjects.txt"
```

Expected: clean status, canonical subject order, and every implementation task commit contains only `session_directory.rs`.

Canonical count ledger used by every gate:

| Checkpoint | Count |
|---|---:|
| Task 1 page-bound tests | 5 |
| Task 2 page-bound tests | 11 |
| Task 3 page-bound tests | 12 |
| Task 4 / pre-candidate page-bound tests | 15 |
| Task 6 shared-prefix tests | 4 |
| Task 6 supplied-vector winner test | 1 |
| Task 6 before differential | 20 |
| Task 6 with temporary differential | 21 |
| Task 6 after oracle deletion | 20 |
| Task 7 retained additions | 7 |
| Final page-bound tests | 27 |
| Differential comparisons inside one temporary test | 516 |
| Rust-backed Playwright matrix, baseline | 7 |
| Rust-backed Playwright matrix, final | 7 |
| Direct-helper migration | 28 unique / 29 obligations |
| Existing named route tests | 9 |

Broad suite counts remain runtime-discovered positive counts and are never hard-coded.

## Writing-Plans Self-Review Record for the Post-Validation Amendment

### Evidence boundary

This record is part of the exact plan text presented for independent review. It assigns no successful verdict to any historical, prior-repair, or v2 independent audit, and it does not authorize implementation by itself. It records only plan-text assertions that are independently reproducible from this file, the fixed review boundary `485dcb4bbecc303f6c57b4b477c241e65213786d`, and the read-only commands/fixtures named below. Future Cargo, differential, browser, coordinator, broad-suite, cleanup, and implementation outcomes remain future gates.

No post-audit plan edit is part of the protocol. Reviewers run checks against this complete record. If a check or independent review fails, implementation remains blocked and a new repair/review cycle begins; no stale report is edited and no embedded status transition is made.

### Reproducible A01–A12 plan-text assertions

| ID | Independently checkable plan-text assertion |
|---|---|
| A01 | Exact-pair and full-key collision tests preserve first supplied occurrence; no identity sort or registry/cross-request winner claim exists. |
| A02 | Both handler statuses are captured under `set -e`; fallback authorization remains primary-span fail closed; the sole fallback fence supplies complete index/provenance types, resolver/accessors, selector, materializer-with-inputs, derivation, test call sites, and exact A08 profile. |
| A03 | Effective overrides, deletion/re-synthesis, running, synthesis/dedupe, visibility, order, cursor, title/deep search, partials, metadata, wire order/shape, and colors remain explicitly covered. |
| A04 | Final retained operational state is descriptors/annotations plus partial aggregate/colors, not a traversal cap. |
| A05 | Annotations may reach `limit + 1`; full rows, returned-field decoration, and serialization are capped at returned `limit`. |
| A06 | The exact 516/21/15/nine/focused checkpoint runs before cutover and immediately before deletion; marker/proof-commit ancestry follows the latest representation; temporary oracle/generator/test are deleted. |
| A07 | Snapshot-generation pinning remains accepted; no allocator, fixed-generation, allocation, or RSS non-increase claim is made. |
| A08 | One declaration-aware audit selects the persisted borrowed/indexed profile; retains exact constructor/helper/annotation/counter/order checks; inventories every enumerated copy/conversion site in reachable production policy functions by owner, kind, and canonical expression; and runs an operation-sensitive source-wide pass across production, oracle, and tests. Explicit row/slice/vector category and reference depth propagate through aliases, closures, direct container loops, and iterator loops. Nested unary borrow/deref, inherent/trait-qualified slice `to_vec`/`to_owned`, UFCS, qualified clone items, `Vec::from`, cloned/map/collect, and from-iterator forms are covered. Row/vector value copies and slice materializations fail; clones whose result is only an already-borrowed reference pass. The only genuine full-row exception is test fixture `StaticSessionSource::parse` / `row.clone()`; oracle exceptions are empty. The contract is syntactic, not a macro/typechecker/custom-wrapper/allocator proof. |
| A09 | Both local `rust-chromium` gates require exit zero and one exact seven-pass marker; functional failures block. |
| A10 | Unchanged-base comparison uses a fresh direct child of `.worktrees`; detached exact `BASE_SHA` is re-read immediately before removal; final absence is fail closed. |
| A11 | Revision includes effective corpus activity and every identity update before sort/filter/search/retention/materialization. |
| A12 | Lossless argv, class-specific context/scratch, paired actual-path Node evidence, executed-only counts, three-way status/phase/signature equality, nonempty coordinator IDs, durable denials, and exact cleanup predicates are executable checks. Per-failure identity additionally uses locked atomic monotonic state, canonical bounded decimal `1..999999999`, safe previous-plus-one validation, lexical nine-digit padding, and durable gap/reuse/malformed/exhaustion denial; no unbounded input reaches arithmetic or `%d`. The execution harness is also fail-closed at every worker boundary: all nine execution units carry the fresh-shell precondition, Task 6 preserves its fallback-decision shell, and each shared Step-7 replay remains in its owning caller shell through verified cleanup, trap disarm, and exact caller-gate handoff. |

No item is deferred or marked not applicable. Synthetic route rows are paired with the real route and nine named routes; the temporary eager oracle directly composes old production helpers and is deleted; thread-local counters are paired with the source-wide audit; local provider fixtures are paired with the seven-test Rust/browser matrix. Explicit non-goals remain unchanged.

### Reproducible count, scope, and syntax contract

The final plan must reproduce all of the following from text alone:

- exactly one repository path differs from the review boundary: this plan;
- progression `15 -> 20 -> 21 -> 20 -> 27`;
- exactly two distinct `_u64` seed tokens, `2 * 8 * 8 * 2 * 2 = 512`, four fixed comparisons, and total 516 with one marker;
- 28 unique direct-helper tests / 29 obligations, seven transitive override tests, one display test, nine named routes, and seven Playwright tests at each local gate;
- exactly three Task-6 source-only commits and nine implementation subjects;
- temporary differential names confined to Task 6 and absent from Task 7/final completion state;
- exactly nine `**Fresh-shell precondition:**` markers exist: one each under Gate 0, Tasks 1-7, and Gate 8; the obsolete once-before-Gate-0 harness instruction is absent; Task 6 explicitly preserves its fallback-decision shell, and each shared Step-7 replay is explicitly same-shell through verified cleanup, `trap - EXIT`, and caller-gate handoff;
- `total_fences=136`, `bash_fences=58`, `rust_fences=56`, `text_fences=22`, `python_heredocs=4`, and `node_heredocs=2`;
- every Bash fence parses, every Python heredoc compiles under isolated Python with no plain `assert`, every Node heredoc passes `node --check`, and every Rust fence is syntactically parseable as its intended insertion unit;
- the corrected seed/cardinality validator, both A08 profile baselines, all 48 prior genuine/corrected escape cases, twelve new inherent/trait/path-qualified-slice/direct-loop cases, twelve harmless-reference/selected-field controls, every retained A08 mutant, the independent exact production-expression ledger mutants, and bounded/injective/exhaustion failure-ID fixtures produce their required success/denial outcomes.

These are check contracts, not claims about historical report verdicts. Implementation remains blocked unless an independent review of this exact final plan and all required static checks succeeds; success requires no subsequent edit to this record.

## Completion Criteria

The branch is ready for user review only when all twenty nonduplicative statements are evidenced:

1. Gate 0 began clean with the plan already committed, `BASE_SHA` ancestral, the committed plan as the only initial changed path, and application source unchanged from `BASE_SHA`.
2. Fifteen pre-refactor real-route characterizations were GREEN before candidate introduction and remain GREEN after eager cleanup.
3. The one temporary differential performed exactly 516 exact `Value` and serialized-byte comparisons inside the complete 516/21/15/nine/focused representation checkpoint before cutover and immediately before deletion; the validated fallback marker selected the latest representation's recorded, ancestral `TASK6_PROOF_COMMIT`.
4. Both actual Axum-handler compiler statuses were captured under `set -e`; `cargo check` and full test-target `--no-run` passed with the post-final-await narrow borrow and explicit snapshot drop, or the structured diagnostic classifier authorized only the exact index/provenance fallback and its complete compiler/representation reruns.
5. Final production has one candidate path and no eager helper, temporary oracle/generator/test, strategy selector, feature flag, canary, or rollback residue.
6. Exact-pair and synthesized full-key collisions preserve first occurrence in the supplied identity vector; registry/cross-request winners remain unspecified and no identity sorting exists.
7. The complete A03 crosswalk is preserved for effective overrides, deletion/live re-synthesis, running matching, synthesis/dedupe, visibility, ordering, cursor, title/deep search, partials, metadata, wire shape/order, and project colors.
8. A11 revision remains the full effective-corpus activity maximum plus every identity update, clamped as before and computed before sort/filter/search/retention/materialization.
9. A04 retained state is at most `limit + 1` descriptors and owned annotations plus deep partial aggregate and colors; traversal is not capped to `limit + 1` candidates.
10. Full `DirItem` rows, returned-field clones/decorators, and serialization are at most returned `limit`; lookahead may own one annotation but is never materialized or serialized.
11. Direct descriptor/annotation/full-work counters and the isolated explicit-check A08 audit pass under the one non-overlapped current-thread attribution claim; the exact borrowed/indexed profile, recursive helper graph, constructors, operations, mutations, calls, counters, and order match; every enumerated copy/conversion in reachable policy code matches its exact owner/kind/expression ledger; and the source-wide operation-sensitive pass permits only `StaticSessionSource::parse` / `row.clone()` as a genuine test full-row copy with no oracle or production exception. Row/slice/vector category and reference depth propagate through aliases, closures, direct `for row in rows`, and iterator loops. Parenthesized/deref, inherent/trait-qualified slice materialization, owned-vector clone, UFCS, qualified-item, cloned/map/collect, and from-iterator escapes are denied in both profiles, while the explicit borrowed-reference and selected-field controls pass, subject to the syntactic non-macro/non-typechecker proof boundary.
12. Indexed, synthesized, filtered/cursor, all-hidden, sparse-title, deep-lookahead, and scope-reset/negative-control tests pass.
13. Final `page_bound_tests` inventory is exactly 27 passing tests.
14. The 28 unique direct-helper tests / 29 obligations, seven transitive override tests, display test, and nine named route tests retain their intended cleanup and behavior coverage.
15. Baseline and final local `rust-chromium` matrix each report exit zero with exactly one `7 passed` marker, or a narrowly eligible pre-assertion environment result has complete matching unchanged-base evidence; any functional failure blocks. Gate 0 Step 8 and Gate 8 Step 3 ran only while their caller-specific matrix disposition was `matrix_green` or one of those two exact Step-7 outputs linked to the matching disposition file.
16. Snapshot-generation pinning is an accepted tradeoff; no fixed generation-memory, allocation, or RSS non-increase claim remains, and total RSS requires a separate paired measurement.
17. Deep-loop order, empty-key rejection, stable duplicate gap, current Rust recency/full-key ordering, serializer byte order, fields/omissions, colors, validation, and no-total contract remain unchanged.
18. Every accepted waiver used a locked atomic sequence state with the exact next canonical value in `1..999999999`, injective lexical nine-digit padding, and durable malformed/gap/reuse/lock/state/exhaustion denial; unique lossless command artifacts; class-specific context and scratch; paired target/base Node evidence where required; fresh exact-argv candidate/base reruns; passed-plus-failed execution counts; validated coordinator transitions with nonempty string run IDs; original/candidate/base phase and signature equality; durable disposition records; a fresh direct-child base checkout; and fail-closed detached-`BASE_SHA` cleanup/registration absence. Otherwise no waiver was granted.
19. Final `BASE_SHA..HEAD` is exactly the plan and `crates/freshell-server/src/session_directory.rs`; all nine implementation commits are source-only; forbidden manifests, locks, config, spec, README, schema, Node/client/browser, WS, sessions/index/search, refresh/sweep, fixture, and setting files are unchanged; the worktree is clean.
20. No release benchmark, temporary manifest edit, unrelated repair, or unapproved PR occurred. Every execution unit used its own harness-initialized persistent shell, and every shared Step-7 replay retained its ownership state and EXIT trap in the owning caller shell through verified cleanup and exact handoff.
