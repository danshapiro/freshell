# Session Directory Lazy Page Preparation Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Preserve every current Rust HTTP result for fixed captured inputs and non-overlapping operations while bounding full `DirItem` preparation and JSON serialization to the returned page and bounding selected descriptors and owned search annotations to `limit + 1`; the route's explicitly unsupported cross-store race timing is not frozen.

**Architecture:** Capture one independent value from each accessor in the existing accessor order: one `Arc<Vec<IndexedSession>>`, one overrides snapshot, one metadata snapshot, and one identity snapshot, then borrow them during one synchronous derivation. The captures do not represent one atomic point in time, and moving projection work after all captures can change overlap windows. Build and stable-sort shallow effective candidates across the complete corpus, apply one shared order and eligibility policy before tier-specific search, retain at most `limit + 1` selected descriptors, and consume only the first `limit` through the sole full-row materializer and serializer.

**Tech Stack:** Rust 1.96, Axum, Tokio, `Arc`, `serde_json` with `preserve_order`, URL-safe no-padding Base64, `freshell-sessions` `SessionIndex` and transcript search, `freshell-ws` terminal identities, Cargo test/clippy/rustfmt, Axum `tower::ServiceExt` route tests, Playwright's Rust-backed browser matrix, and the repository test coordinator with explicitly selected local Vitest for every baseline, impacted, and final run in this branch.

## Global Constraints

- Target repository root: `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep`.
- Frozen implementation base: `225a91db3e4d48d4b6a7e8bc0987afad8ff31917`.
- Execution begins after `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/docs/plans/2026-08-13-session-directory-lazy-page-prep.md` has been committed. Task 1 must prove the base is an ancestor of `HEAD` and that this plan is the only `base..HEAD` path; it must not require `HEAD` to equal the base.
- The only application/test source file that may change is `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/crates/freshell-server/src/session_directory.rs`; tests and test-only instrumentation stay inline there.
- Final `base..HEAD` scope must be exactly the committed plan and `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/crates/freshell-server/src/session_directory.rs`.
- Do not modify any `Cargo.toml`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/Cargo.lock`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/.kata.toml`, any TypeScript or JavaScript file, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/package.json`, or `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/package-lock.json`.
- Do not change public route/state/query/wire interfaces, status codes, authentication, `SessionIndex::snapshot(&self) -> Arc<Vec<IndexedSession>>`, cursor encoding, response fields, optional-field omission, or object insertion order.
- Preserve accessor order: auth, raw-query validation, one awaited index snapshot, one overrides snapshot, one awaited metadata snapshot, one identity snapshot, synchronous page derivation, snapshot release, then whole-map project colors only on success.
- Supported concurrency is one independent snapshot/value per accessor, captured sequentially in this order: index, overrides, metadata, identities; project colors remains a separate late success-only read. These values do not form an atomic or common point-in-time cross-store view. If a write overlaps the GET across stores, whether that write appears is unspecified and only each accessor's own locking/freshness contract applies. Moving projection work until after all captures can change old race windows; exact old overlap timing is not promised. `revision` remains full-corpus candidate/identity recency and is not a cross-store generation/version; override, metadata, and project-color writes can change a page without changing it. Do not add a race test that freezes either allowed overlap outcome.
- For fixed captured inputs and non-overlapping operations, preserve exact current Rust candidate, override, metadata, live-join, revision, stable order, strict cursor, visibility, search, partial-reason, and page semantics described in the evidence reports.
- Do not import Node-only archived-last ordering, project-path or cwd-leaf title matching, focused Node title snippets, checkout-root synthesis, or `checkoutPath`.
- Production ends with one borrowed candidate representation, one comparator used by sorting and cursor continuation, one eligibility predicate, one selector, and one consuming materializer. A temporary eager oracle is test-only and is deleted in Task 6 only after final-selector parity.
- Do not add an owned/index-provenance fallback, a runtime old/new strategy, a `SessionIndex` paging API, caching, a population total, or a compatibility `Vec<DirItem>` adapter.
- LB-03 is accepted only as a compiler residual risk, not a confirmed compile claim. The complete borrowed core must pass locked production and inline-test compiler stop-steps before handler cutover; the real Axum handler must pass the same locked checks immediately after cutover; final cleanup/selector assembly must compile before commit and again in final validation. Any failure stops and permits only correction of the planned one-file borrowed design plus complete rerun. It never authorizes an owned/index-provenance fallback, compatibility adapter, public/store/index API or manifest change, or another source file. If correction cannot stay within those bounds, reopen the architecture decision before further edits.
- The full corpus may require `O(N)` shallow candidates, stable sorting, and sparse-search inspection. The accepted bound is at most `limit + 1` retained descriptors/annotations and at most `limit` full-row materializations/serializations.
- Keep deep search's `limit * 10` scan budget and exact check order: lookahead count, budget, source, provider, increment, file I/O. A later budget stop overwrites an earlier `io_error` reason.
- An exhaustive real-route TLS matrix proves limiter consequences for every accepted limit `1..=MAX_DIRECTORY_PAGE_ITEMS` on oversized no-search, title, `userMessages`, and `fullText` corpora; a mandatory static post-capture preparation locality/centrality proof establishes that the observed counters belong to the sole production chain. Neither elapsed time nor TLS alone is evidence. `PreparationScope` is a request-level activation window, not a claim that index/metadata acquisition is same-thread. The static leg requires current-thread structural tests; proves that the awaited index snapshot, override snapshot, awaited metadata snapshot, and identity snapshot all precede the sole synchronous `derive_directory_page` call; proves no await or recognized handoff in the post-capture counted candidate-derivation subgraph or transcript helper; proves direct Tower/Axum polling and full response-body completion before the test snapshots counts; and proves exact-one production selection/materialization/serialization sites and counter placement. Acquisition-time offload before candidate derivation is allowed and outside the counted-work locality claim. Any failure of either runtime limiter evidence or the post-capture locality/centrality invariant stops and reopens LB-08; do not waive either leg or silently keep the counters. Do not make allocator, RSS, or latency claims.
- Use RED-GREEN-REFACTOR. Characterization tests added before the refactor must pass against the eager route; Task 4's intended RED is missing candidate symbols; Task 6's intended RED is exact structural-count mismatch.
- Every checkbox step is one monotonic 2-5 minute action: one module shell, cohesive helper group, individual test, production function or implementation/type group, independent command, or commit. Do not combine unrelated tests, function groups, or commands into one step. A provenance-bracketed sandbox gate is one indivisible evidence action even though its internal build/run/postflight and duration exceed ordinary step granularity; it must remain one self-contained shell process that records the exact worktree-context build result via `--iidfile` and passes that full immutable image ID to the test container. The build creates no Docker tag, and no mutable tag may serve as provenance or runtime selection.
- Every shell command is self-contained, uses absolute paths or `git -C`, assumes no caller working directory, and begins with `FRESHELL_VITEST_BACKEND=local` even when it does not invoke Vitest. This branch-local override is mandatory because LB-10 falsified reviewed-source provenance and race freedom for the remote wrapper; it does not alter repository or user configuration.
- Preflight, readiness, coordinator history, and prior results are never pass evidence. The exact local browser matrix, fresh coordinator-owned local suite, and provenance-bracketed sandbox workload must execute successfully. Any preflight, build, runtime, or image-ID discrepancy stops. The sandbox bracket never reads or mutates `freshell-sandbox:latest`, creates no Docker tag, and performs no image/tag deletion; its content-addressed build result remains subject to normal Docker image/cache policy. Concurrent foreign image builds or containers cannot change the full-ID run, and no foreign process, container, tag, or image is removed. Never substitute a remote runner, unsandboxed Cargo, narrowed browser project/package target, focused-only evidence, or a waiver. If another coordinator holder uses a shared coordinator resource, wait and retry the same gate; never kill or bypass it.
- Never invoke raw `npx vitest`. Broad JavaScript tests run through the repository coordinator; destructive server-package tests run through the repository sandbox.
- Make ordinary coherent local task-level commits after green source-changing work, using the configured repository identity and Amplifier co-author footer. Every shown commit subject/body is one valid example, not a mandatory history. Mandatory task spec/quality reviews or final checks may require additional source-only correction commits and reruns before advancing. Do not prescribe or validate an exact commit count, subject sequence, commit order, or ancestry ledger.
- This plan contains no push, pull-request creation, merge, deployment, or server-restart step.
- Preserve every existing assertion that remains applicable. Where a direct eager-helper assertion is replaced, the replacement must exercise the production candidate derivation or real route and assert the same fact plus any stated stronger wire or structural fact.

---

## File Structure Map

- **Modify and test only:** `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/crates/freshell-server/src/session_directory.rs` — route handler, request-local candidate pipeline, inline characterization/differential/structural tests, and test-only counters.
- **Committed execution input, never edit during these tasks:** `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/docs/plans/2026-08-13-session-directory-lazy-page-prep.md` — the implementation plan whose commit is the sole pre-execution delta.
- **Read-only repository rules and test orchestration:** `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/AGENTS.md`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/docs/skills/testing.md`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/docs/development/test-sandbox.md`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/scripts/sandbox-build.sh`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/scripts/sandbox-test.sh`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/scripts/testing/test-coordinator.ts`, and `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/scripts/run-standard-tests.ts`.
- **Read-only Rust contracts:** `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/crates/freshell-sessions/src/directory_index.rs` owns `IndexedSession`, `SessionSource`, and `SessionIndex::snapshot`; `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/crates/freshell-sessions/src/search.rs` owns `FileSearchTier`, `FileSearchMatch`, and `search_session_file`; `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/crates/freshell-ws/src/identity.rs` owns `TerminalIdentity` and registry snapshots; `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/crates/freshell-server/src/settings_store.rs` owns override/color snapshots; `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/crates/freshell-server/src/session_metadata.rs` owns metadata snapshots.
- **Read-only manifests/configuration:** `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/Cargo.toml`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/Cargo.lock`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/crates/freshell-server/Cargo.toml`, every other tracked `Cargo.toml`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/.kata.toml`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/package.json`, and `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/package-lock.json`.
- **Read-only behavior references:** `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/shared/read-models.ts` and `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/server/session-directory/service.ts`; they document cross-server differences and must not be edited or treated as an oracle over current Rust behavior.
- **Read-only fixtures and browser regression:** `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/test/fixtures/sessions/**`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/test/e2e-browser/playwright.config.ts`, and `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/test/e2e-browser/specs/session-directory-matrix.spec.ts`.
- **External read-only Playwright executable:** `/home/dan/code/freshell/node_modules/@playwright/test/cli.js`.
- No file is created, renamed, or deleted by implementation. The existing large Rust module remains the established repository boundary; splitting it would expand scope and break the one-file acceptance proof.

## Dependency Order

```text
Task 1 fresh unchanged-source authorization gate
  -> Task 2 effective-corpus route characterizations
    -> Task 3 cursor/search/partial/wire characterizations
      -> Task 4 borrowed candidate path, differential, locked compiler gates, and handler cutover
        -> Task 5 retained-test migration with eager oracle retained
          -> Task 6 structural RED, final selector, final oracle parity, cleanup, final assembly, and work-bound proof
            -> Task 7 final validation and exact scope proof
```

### Task 1: Run the fresh unchanged-source authorization gate

**Files:**
- Modify: none.
- Read only: `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/docs/plans/2026-08-13-session-directory-lazy-page-prep.md`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/AGENTS.md`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/Cargo.toml`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/Cargo.lock`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/package.json`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/package-lock.json`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/docs/skills/testing.md`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/.github/workflows/rust-clippy.yml`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/scripts/testing/test-coordinator.ts`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/scripts/run-standard-tests.ts`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/crates/freshell-server/src/session_directory.rs`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/test/e2e-browser/playwright.config.ts`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/test/e2e-browser/specs/session-directory-matrix.spec.ts`, and `/home/dan/code/freshell/node_modules/@playwright/test/cli.js`.

**Interfaces:**
- Consumes: LB-01 as an accepted residual rather than a verified green claim; base commit `225a91db3e4d48d4b6a7e8bc0987afad8ff31917`; committed plan path `docs/plans/2026-08-13-session-directory-lazy-page-prep.md`; current `router(SessionDirectoryState)`; existing focused Rust tests; the exact local browser matrix; and the local coordinator path.
- Produces: only after every command succeeds, a fresh local authorization receipt proving plan-only `HEAD` carries frozen-base implementation bytes and that exact focused Rust, exact Rust-backed browser, and fresh coordinator-owned local workloads passed before a post-run source seal. No green-base claim exists before execution, and Task 2 cannot be dispatched after any failure or before the final seal.

- [ ] **Step 1: Prove branch, base ancestry, committed-plan-only scope, and a clean worktree**

Run:

```bash
FRESHELL_VITEST_BACKEND=local bash -c 'test "$(git -C /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep branch --show-current)" = "the-usual/session-directory-lazy-page-prep" && git -C /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep merge-base --is-ancestor 225a91db3e4d48d4b6a7e8bc0987afad8ff31917 HEAD && diff -u <(printf "%s\n" "docs/plans/2026-08-13-session-directory-lazy-page-prep.md") <(git -C /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep diff --name-only 225a91db3e4d48d4b6a7e8bc0987afad8ff31917 HEAD) && test -z "$(git -C /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep status --porcelain=v1 --untracked-files=all)"'
```

Expected: exit 0 and no diff/status output. `HEAD` is allowed and expected to be ahead of the base by the plan commit; equality with the base is not tested. This is provenance evidence, not behavior-pass evidence.

- [ ] **Step 2: Prove the implementation source is unchanged from the frozen base**

Run:

```bash
FRESHELL_VITEST_BACKEND=local git -C /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep diff --exit-code 225a91db3e4d48d4b6a7e8bc0987afad8ff31917 HEAD -- crates/freshell-server/src/session_directory.rs
```

Expected: exit 0 and no diff. This is source provenance, not a green claim.

- [ ] **Step 3: Run the unchanged focused Rust behavior gate**

Run:

```bash
FRESHELL_VITEST_BACKEND=local CARGO_TERM_COLOR=never cargo test --manifest-path /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/Cargo.toml -p freshell-server --bin freshell-server session_directory -- --color=never --test-threads=1
```

Expected: exit 0, every emitted `test result` is `ok`, and no `FAILED` line. Retain the exact command output and record observed counts as run evidence without converting them into a future count assertion.

- [ ] **Step 4: Run the fail-closed local-browser readiness preflight**

Run:

```bash
FRESHELL_VITEST_BACKEND=local bash -c '
set -euo pipefail
root=/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep
for name in FRESHELL_E2E_TARGET_URL FRESHELL_E2E_TARGET_TOKEN FRESHELL_E2E_TARGET_WS_URL FRESHELL_E2E_TARGET_HOME FRESHELL_E2E_RUST_SERVER_BIN CARGO_TARGET_DIR PLAYWRIGHT_BROWSERS_PATH; do
  test -z "${!name-}" || { echo "unexpected routing override: ${name}" >&2; exit 1; }
done
test -f /home/dan/code/freshell/node_modules/@playwright/test/cli.js
node -e "
const fs = require(\"fs\");
const lock = JSON.parse(fs.readFileSync(\"${root}/package-lock.json\", \"utf8\"));
for (const p of [\"node_modules/@playwright/test\", \"node_modules/playwright\", \"node_modules/playwright-core\"]) {
  if (lock.packages[p]?.version !== \"1.58.2\") throw new Error(p + \" lock mismatch\");
}
const installed = require(\"/home/dan/code/freshell/node_modules/@playwright/test/package.json\").version;
if (installed !== \"1.58.2\") throw new Error(\"installed Playwright mismatch: \" + installed);
"
for exe in \
  /home/dan/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome \
  /home/dan/.cache/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell; do
  test -x "$exe"
  ldd_output="$(ldd "$exe")" || exit 1
  if grep -q "not found" <<<"$ldd_output"; then echo "unresolved library: $exe" >&2; exit 1; fi
done
command -v cargo rustc cc gcc g++ ar ranlib make pkg-config perl python3 ldd >/dev/null
rustup target list --installed | grep -Fx x86_64-unknown-linux-gnu >/dev/null
cargo --version
rustc --version
df -h "$root"
grep "^MemAvailable:" /proc/meminfo
'
```

Expected: exit 0 with exact installed/locked Playwright 1.58.2, both Chromium revision-1208 executables, no unresolved libraries, Cargo/Rust 1.96 and the native Linux toolchain available, and resource state printed without a pass threshold. This is readiness evidence only and never substitutes for the matrix.

- [ ] **Step 5: Run the unchanged exact local Rust-backed browser behavior gate**

Run:

```bash
FRESHELL_VITEST_BACKEND=local env --chdir=/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep FRESHELL_E2E_BACKEND=local node /home/dan/code/freshell/node_modules/@playwright/test/cli.js test --config /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/test/e2e-browser/playwright.config.ts --project=rust-chromium --workers=1 --reporter=line /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/test/e2e-browser/specs/session-directory-matrix.spec.ts
```

Expected: exit 0 and every existing matrix case passes. Retain the exact output and observed case count. Any compile, launch, server, Chromium, or matrix failure stops; do not install, reroute, move to a remote runner, narrow the project/spec, or waive the matrix.

- [ ] **Step 6: Inspect the coordinator without treating advisory history as this run**

Run:

```bash
FRESHELL_VITEST_BACKEND=local env --chdir=/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep INIT_CWD=/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep PWD=/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep npm --prefix /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep run test:status
```

Expected: exit 0 and truthful holder state. If another holder is active, wait and rerun this same independent command; never kill or bypass the holder. Readiness and historical results do not satisfy Step 7.

- [ ] **Step 7: Run a fresh coordinator-owned local full-suite behavior gate**

Run:

```bash
FRESHELL_VITEST_BACKEND=local FRESHELL_TEST_SUMMARY="session-directory lazy-page unchanged local baseline" env --chdir=/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep INIT_CWD=/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep PWD=/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep npm --prefix /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep test
```

Expected: a fresh coordinator-owned exit 0 for the target worktree and current `HEAD`, with clean source provenance. Retain observed counts and require output containing `Resolved standard test plan` and not containing `Dispatching client+server suites to cloud vitest`. Advisory history is not a substitute, and this run is not accepted until Step 8 machine-proves its persisted `byKey.test` receipt.

- [ ] **Step 8: Reseal source provenance and close the authorization receipt**

Run:

```bash
FRESHELL_VITEST_BACKEND=local bash -c '
set -euo pipefail
root=/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep
base=225a91db3e4d48d4b6a7e8bc0987afad8ff31917
expected=docs/plans/2026-08-13-session-directory-lazy-page-prep.md
summary="session-directory lazy-page unchanged local baseline"
diff -u <(printf "%s\n" "$expected") <(git -C "$root" diff --name-only "$base" HEAD)
git -C "$root" diff --exit-code "$base" HEAD -- crates/freshell-server/src/session_directory.rs
test -z "$(git -C "$root" status --porcelain=v1 --untracked-files=all)"
head="$(git -C "$root" rev-parse HEAD)"
printf "head=%s\n" "$head"
rustc --version
cargo --version
node --version
env --chdir="$root" INIT_CWD="$root" PWD="$root" npm --prefix "$root" run test:status
record="$(git -C "$root" rev-parse --path-format=absolute --git-common-dir)/freshell-test-coordinator/command-runs.json"
ROOT="$root" HEAD="$head" SUMMARY="$summary" RECORD="$record" python3 - <<PY
import json
import os
from pathlib import Path

root = os.environ["ROOT"]
head = os.environ["HEAD"]
summary = os.environ["SUMMARY"]
record = json.loads(
    Path(os.environ["RECORD"]).read_text(encoding="utf-8")
)["byKey"]["test"]
assert record["summary"] == summary, record
assert record["summarySource"] == "env", record
assert record["outcome"] == "success", record
assert record["exitCode"] == 0, record
assert record["entrypoint"] == {"commandKey": "test", "suiteKey": "full-suite"}, record
assert record["command"] == {"display": "npm test", "argv": ["test"]}, record
repo = record["repo"]
assert repo["invocationCwd"] == root, repo
assert repo["checkoutRoot"] == root, repo
assert repo["worktreePath"] == root, repo
assert repo["commit"] == head, repo
assert repo["isDirty"] is False, repo
print("coordinator receipt provenance: PASS")
PY
'
```

Expected: exit 0; plan-only scope, frozen-base source bytes, and clean status are still sealed after all runtime gates; exact `HEAD` and Rust/Cargo/Node versions are printed; and the exact line `coordinator receipt provenance: PASS` machine-proves the unique environment-sourced summary, successful exit-0 `test`/`full-suite`, exact `npm test` command shape, exact target `invocationCwd`/`checkoutRoot`/`worktreePath`, sealed contemporaneous `HEAD`, and `isDirty=false` from persisted `command-runs.json.byKey.test`. Attach the retained Step 3, Step 5, and Step 7 command outputs to this receipt, including exact commands, exit statuses, and observed test/matrix counts. Ignored build caches, `target/`, `dist/`, Playwright output, and coordinator records are allowed test side effects; any unexpected unignored artifact stops. Only this complete machine-proven receipt authorizes Task 2.

- [ ] **Step 9: Apply fail-closed remediation to any discrepancy**

Any command, preflight, runtime gate, or source seal failure means no production source edit and no Task 2 dispatch. Record the exact command, exit status, and concise failure output. For a runner/transient failure, repair only the environment, restore clean provenance, and rerun Task 1 from Step 1. For a real frozen-base failure, stop for a separate prerequisite repair or rebase onto known-green `origin/main`, update every frozen SHA and expectation, re-review this plan, and rerun Task 1 from Step 1. Never waive a gate, retry until lucky, call a failure pre-existing but acceptable, or attribute it to a refactor that does not yet exist.

### Task 2: Add the real-route harness and effective-corpus characterizations

**Files:**
- Modify/test: `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/crates/freshell-server/src/session_directory.rs`.
- Read only: `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/crates/freshell-server/Cargo.toml`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/crates/freshell-sessions/src/directory_index.rs`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/crates/freshell-ws/src/identity.rs`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/crates/freshell-server/src/settings_store.rs`, and `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/crates/freshell-server/src/session_metadata.rs`.

**Interfaces:**
- Consumes: Task 1's complete local green receipt and post-run source-provenance seal, which is the authorization token for this first production-editing task; `router(SessionDirectoryState) -> Router`; `SessionIndex::with_ttl_and_cache_path(Vec<Arc<dyn SessionSource>>, Duration, Option<PathBuf>)`; `SettingsStore`; `SessionMetadataStore`; `TerminalIdentityRegistry`; current eager route semantics.
- Produces: sibling test module `page_bound_tests`; direct-listed in-memory `StaticSessionSource` with stable `direct_change_token` and cloned `direct_list` rows; `DirectoryRouteHarness`; `indexed_row`, `provider_row`, `get_page_with_bytes`, `get_page`, `item_ids`, `item_keys`, `page_cursor`, and `test_query`; complete current-GREEN effective-corpus, pagination, revision, Rust-title, archived-order, and wire-shape characterizations consumed by Tasks 3-6.

- [ ] **Step 1: Create the `page_bound_tests` module shell and imports**

Append this complete test-only module shell after the existing `tests` module:

```rust
#[cfg(test)]
mod page_bound_tests {
    use super::*;
    use axum::{
        body::{to_bytes, Body},
        http::{Request, StatusCode},
        Router,
    };
    use freshell_sessions::directory_index::{IndexedSession, SessionIndex, SessionSource};
    use serde_json::{json, Value};
    use std::{
        collections::HashSet,
        path::PathBuf,
        sync::Arc,
        time::Duration,
    };
    use tower::ServiceExt;
}
```

- [ ] **Step 2: Add the deterministic direct-list static session source**

Insert this complete block before the closing brace of `page_bound_tests`:

```rust
    struct StaticSessionSource {
        rows: Arc<Vec<IndexedSession>>,
    }

    impl StaticSessionSource {
        fn new(rows: Vec<IndexedSession>) -> Self {
            Self {
                rows: Arc::new(rows),
            }
        }
    }

    impl SessionSource for StaticSessionSource {
        fn discover(&self) -> Vec<freshell_sessions::directory_index::FileStat> {
            Vec::new()
        }

        fn parse(&self, _path: &std::path::Path) -> Option<IndexedSession> {
            None
        }

        fn direct_change_token(&self) -> Option<i64> {
            Some(1)
        }

        fn direct_list(&self) -> Result<Vec<IndexedSession>, String> {
            Ok(self.rows.as_ref().clone())
        }
    }
```

- [ ] **Step 3: Add the route harness state and indexed-row fixtures**

Insert this complete block before the closing brace of `page_bound_tests`:

```rust
    struct DirectoryRouteHarness {
        app: Router,
        settings: crate::settings_store::SettingsStore,
        identity: freshell_ws::identity::TerminalIdentityRegistry,
        metadata: crate::session_metadata::SessionMetadataStore,
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
```

- [ ] **Step 4: Build the real route harness around `SessionIndex`**

Insert this complete block before the closing brace of `page_bound_tests`:

```rust
    fn directory_route_harness(rows: Vec<IndexedSession>) -> DirectoryRouteHarness {
        let home = tempfile::tempdir().expect("temporary home");
        let settings = crate::settings_store::SettingsStore::load(
            Some(home.path()),
            vec!["claude".into(), "codex".into(), "opencode".into()],
        );
        let identity = freshell_ws::identity::TerminalIdentityRegistry::new();
        let metadata = crate::session_metadata::SessionMetadataStore::new(
            home.path().join(".freshell"),
        );
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
            metadata: metadata.clone(),
        });
        DirectoryRouteHarness {
            app,
            settings,
            identity,
            metadata,
            _home: home,
        }
    }
```

- [ ] **Step 5: Add authenticated response and parsed-page helpers**

Insert this complete block before the closing brace of `page_bound_tests`:

```rust
    async fn get_page_with_bytes(app: Router, suffix: &str) -> (Value, Vec<u8>) {
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
            .expect("response body")
            .to_vec();
        let page = serde_json::from_slice(&bytes).expect("JSON response");
        (page, bytes)
    }

    async fn get_page(app: Router, suffix: &str) -> Value {
        get_page_with_bytes(app, suffix).await.0
    }
```

- [ ] **Step 6: Add item, key, and cursor response inspectors**

Insert this complete block before the closing brace of `page_bound_tests`:

```rust
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

    fn item_keys(page: &Value) -> Vec<String> {
        page["items"]
            .as_array()
            .expect("items array")
            .iter()
            .map(|item| {
                format!(
                    "{}:{}",
                    item["provider"].as_str().expect("provider"),
                    item["sessionId"].as_str().expect("sessionId")
                )
            })
            .collect()
    }

    fn page_cursor(page: &Value) -> Option<String> {
        page["nextCursor"].as_str().map(str::to_string)
    }
```

- [ ] **Step 7: Add the direct derivation query fixture**

Insert this complete block before the closing brace of `page_bound_tests`:

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
```

- [ ] **Step 8: Add the temporary eager duplicate-row fixture**

Insert this complete block before the closing brace of `page_bound_tests`:

```rust
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

- [ ] **Step 9: Characterize deleted-head page backfill**

Insert this complete block before the closing brace of `page_bound_tests`:

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
```

- [ ] **Step 10: Characterize title-override promotion**

Insert this complete block before the closing brace of `page_bound_tests`:

```rust
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
        assert_eq!(page["revision"], json!(200));
    }
```

- [ ] **Step 11: Characterize running titleless-row promotion**

Insert this complete block before the closing brace of `page_bound_tests`:

```rust
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
        assert!(page_cursor(&page).is_some());
        assert_eq!(page["revision"], json!(900));
    }
```

- [ ] **Step 12: Characterize sessionless live-row interleaving and cursoring**

Insert this complete block before the closing brace of `page_bound_tests`:

```rust
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
            None,
            Some("/live"),
            300,
        );
        let first = get_page(harness.app.clone(), "&limit=1").await;
        assert_eq!(item_ids(&first), vec!["terminal:terminal-live"]);
        assert_eq!(first["items"][0]["lastActivityAt"], json!(300));
        assert_eq!(first["items"][0]["title"], json!("Claude CLI"));
        assert_eq!(first["items"][0]["isRunning"], json!(true));
        assert_eq!(
            first["items"][0]["runningTerminalId"],
            json!("terminal-live")
        );
        assert_eq!(first["items"][0]["liveTerminalOnly"], json!(true));
        assert_eq!(first["revision"], json!(300));
        let cursor = page_cursor(&first).expect("first-page cursor");
        let second = get_page(
            harness.app.clone(),
            &format!("&limit=1&cursor={cursor}"),
        )
        .await;
        assert_eq!(item_ids(&second), vec!["indexed"]);
        assert!(page_cursor(&second).is_none());
        assert_eq!(second["revision"], json!(300));
    }
```

- [ ] **Step 13: Characterize known-session live-row interleaving**

Insert this complete block before the closing brace of `page_bound_tests`:

```rust
    #[tokio::test]
    async fn no_search_newer_unindexed_session_id_interleaves_without_live_only_flag() {
        let harness = directory_route_harness(vec![indexed_row(
            "indexed",
            200,
            Some("indexed"),
        )]);
        harness.identity.upsert(
            "terminal-unindexed",
            Some("claude"),
            Some("unindexed"),
            Some("/live"),
            300,
        );
        let first = get_page(harness.app.clone(), "&limit=1").await;
        assert_eq!(item_ids(&first), vec!["unindexed"]);
        assert_eq!(first["items"][0]["lastActivityAt"], json!(300));
        assert_eq!(first["items"][0]["title"], json!("Claude CLI"));
        assert_eq!(first["items"][0]["isRunning"], json!(true));
        assert_eq!(
            first["items"][0]["runningTerminalId"],
            json!("terminal-unindexed")
        );
        assert!(first["items"][0].get("liveTerminalOnly").is_none());
        assert_eq!(first["revision"], json!(300));
        let cursor = page_cursor(&first).expect("first-page cursor");
        let second = get_page(
            harness.app.clone(),
            &format!("&limit=1&cursor={cursor}"),
        )
        .await;
        assert_eq!(item_ids(&second), vec!["indexed"]);
        assert!(page_cursor(&second).is_none());
        assert_eq!(second["revision"], json!(300));
    }
```

- [ ] **Step 14: Characterize deleted indexed-row live re-synthesis**

Insert this complete block before the closing brace of `page_bound_tests`:

```rust
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
        harness
            .metadata
            .set(
                "claude",
                "deleted-live",
                "kilroy",
                Some("explicit"),
            )
            .await
            .expect("seed indexed metadata");
        harness.identity.upsert(
            "terminal-deleted-live",
            Some("claude"),
            Some("deleted-live"),
            Some("/live"),
            300,
        );
        let page = get_page(harness.app.clone(), "&limit=1").await;
        assert_eq!(item_ids(&page), vec!["deleted-live"]);
        assert_eq!(page["revision"], json!(300));
        let item = &page["items"][0];
        assert_eq!(item["title"], json!("Claude CLI"));
        assert_eq!(item["lastActivityAt"], json!(300));
        assert_eq!(item["createdAt"], json!(300));
        assert_eq!(item["archived"], json!(false));
        assert_eq!(item["sessionType"], json!("claude"));
        assert_eq!(item["isRunning"], json!(true));
        assert_eq!(
            item["runningTerminalId"],
            json!("terminal-deleted-live")
        );
        assert!(item.get("summary").is_none());
        assert!(item.get("liveTerminalOnly").is_none());
        assert!(page_cursor(&page).is_none());
    }
```

- [ ] **Step 15: Characterize all eight visibility-flag combinations**

Insert this complete block before the closing brace of `page_bound_tests`:

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
                    assert_eq!(page["revision"], json!(800), "suffix={suffix}");
                }
            }
        }
    }
```

- [ ] **Step 16: Characterize complete cursor-chain traversal**

Insert this complete block before the closing brace of `page_bound_tests`:

```rust
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
        assert_eq!(page_count, 3);
        assert_eq!(seen, vec!["s5", "s4", "s3", "s2", "s1"]);
        let unique: HashSet<_> = seen.iter().collect();
        assert_eq!(unique.len(), seen.len());
    }
```

- [ ] **Step 17: Characterize page lookahead boundaries**

Insert this complete block before the closing brace of `page_bound_tests`:

```rust
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
            let expected_revision = if count == 0 { 0 } else { 10_000 };
            assert_eq!(
                page["revision"],
                json!(expected_revision),
                "count={count} limit={limit}"
            );
        }
    }
```

- [ ] **Step 18: Characterize full-key tie ordering and cursoring**

Insert this complete block before the closing brace of `page_bound_tests`:

```rust
    #[tokio::test]
    async fn no_search_equal_activity_uses_descending_full_key_for_order_and_cursor() {
        let harness = directory_route_harness(vec![
            provider_row("claude", "a", 500, Some("claude a")),
            provider_row("codex", "z", 500, Some("codex z")),
            provider_row("claude", "z", 500, Some("claude z")),
        ]);
        let first = get_page(harness.app.clone(), "&limit=2").await;
        assert_eq!(item_keys(&first), vec!["codex:z", "claude:z"]);
        assert_eq!(first["revision"], json!(500));
        let cursor = page_cursor(&first).expect("cursor");
        let second = get_page(
            harness.app.clone(),
            &format!("&limit=2&cursor={cursor}"),
        )
        .await;
        assert_eq!(item_keys(&second), vec!["claude:a"]);
        assert!(page_cursor(&second).is_none());
        assert_eq!(second["revision"], json!(500));
    }
```

- [ ] **Step 19: Characterize corpus-wide revision invariance**

Insert this complete block before the closing brace of `page_bound_tests`:

```rust
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
        assert!(page_cursor(&title_search).is_none());
    }
```

- [ ] **Step 20: Characterize providerless-identity revision contribution**

Insert this complete block before the closing brace of `page_bound_tests`:

```rust
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

- [ ] **Step 21: Characterize ignored request revision**

Insert this complete block before the closing brace of `page_bound_tests`:

```rust
    #[tokio::test]
    async fn request_revision_parameter_remains_ignored() {
        let harness = directory_route_harness(vec![indexed_row(
            "visible",
            500,
            Some("visible"),
        )]);
        let without_revision = get_page(harness.app.clone(), "&limit=1").await;
        let with_revision = get_page(
            harness.app.clone(),
            "&limit=1&revision=999999999999",
        )
        .await;
        assert_eq!(with_revision, without_revision);
        assert_eq!(with_revision["revision"], json!(500));
    }
```

- [ ] **Step 22: Characterize stable duplicates and the strict-cursor gap**

Insert this complete block before the closing brace of `page_bound_tests`:

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
        assert_eq!(one_page["revision"], json!(500));

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
        assert_eq!(second_page["revision"], json!(500));
    }
```

- [ ] **Step 23: Characterize sparse effective-field title search**

Insert this complete block before the closing brace of `page_bound_tests`:

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
        assert_eq!(page["revision"], json!(2_000));
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
        assert_eq!(items[1]["snippet"], json!("needle in summary"));
        assert_eq!(items[2]["matchedIn"], json!("firstUserMessage"));
        assert_eq!(items[2]["snippet"], json!("needle in first message"));
        assert_eq!(items[3]["matchedIn"], json!("title"));
        assert_eq!(items[3]["snippet"], json!("needle override title"));
        assert_eq!(items[4]["matchedIn"], json!("summary"));
        assert_eq!(items[4]["snippet"], json!("needle override summary"));
    }
```

- [ ] **Step 24: Characterize Rust title-search field exclusions**

Insert this complete block before the closing brace of `page_bound_tests`:

```rust
    #[tokio::test]
    async fn current_rust_title_search_does_not_match_project_or_cwd_leaf() {
        let mut project_leaf = indexed_row("project-leaf", 200, Some("visible"));
        project_leaf.project_path = "/workspace/needle-project".to_string();
        project_leaf.cwd = Some("/workspace/other".to_string());
        let mut cwd_leaf = indexed_row("cwd-leaf", 100, Some("visible"));
        cwd_leaf.project_path = "/workspace/repository".to_string();
        cwd_leaf.cwd = Some("/workspace/needle-cwd".to_string());
        let harness = directory_route_harness(vec![project_leaf, cwd_leaf]);

        let page = get_page(
            harness.app.clone(),
            "&query=needle&tier=title&limit=50",
        )
        .await;

        assert!(item_ids(&page).is_empty());
        assert!(page_cursor(&page).is_none());
        assert_eq!(page["revision"], json!(200));
        assert!(page.get("partial").is_none());
        assert!(page.get("partialReason").is_none());
    }
```

- [ ] **Step 25: Characterize exact response shape and field omissions**

Insert this complete block before the closing brace of `page_bound_tests`:

```rust
    #[tokio::test]
    async fn no_search_exact_response_shape_preserves_all_fields_bytes_and_no_totals() {
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
        let (page, bytes) = get_page_with_bytes(harness.app.clone(), "&limit=2").await;
        let expected = json!({
            "items": [
                {
                    "sessionId": "terminal:terminal-fallback",
                    "provider": "claude",
                    "projectPath": "/live",
                    "lastActivityAt": 300,
                    "isRunning": true,
                    "archived": false,
                    "title": "Claude CLI",
                    "createdAt": 300,
                    "cwd": "/live",
                    "runningTerminalId": "terminal-fallback",
                    "liveTerminalOnly": true,
                    "sessionType": "claude"
                },
                {
                    "sessionId": "shape",
                    "provider": "claude",
                    "projectPath": "/project",
                    "lastActivityAt": 200,
                    "isRunning": true,
                    "archived": true,
                    "title": "effective title",
                    "summary": "effective summary",
                    "firstUserMessage": "first user",
                    "createdAt": 150,
                    "cwd": "/cwd",
                    "runningTerminalId": "terminal-indexed"
                }
            ],
            "nextCursor": null,
            "revision": 300
        });
        assert_eq!(page, expected);
        assert_eq!(
            bytes,
            serde_json::to_vec(&expected).expect("serialize expected response")
        );
        for forbidden in ["total", "totalCount", "totalSessions"] {
            assert!(page.get(forbidden).is_none());
            assert!(
                !String::from_utf8_lossy(&bytes).contains(&format!("\"{forbidden}\"")),
                "raw response must omit {forbidden}"
            );
        }
        for item in page["items"].as_array().expect("items") {
            assert!(item.get("checkoutPath").is_none());
            assert!(item.get("titleSource").is_none());
            assert!(item.get("sourceFile").is_none());
        }
    }
```

- [ ] **Step 26: Characterize recency-first archived ordering**

Insert this complete block before the closing brace of `page_bound_tests`:

```rust
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
        assert_eq!(first["revision"], json!(300));
        let cursor = page_cursor(&first).expect("cursor");
        let second = get_page(
            harness.app.clone(),
            &format!("&limit=1&cursor={cursor}"),
        )
        .await;
        assert_eq!(item_ids(&second), vec!["older-active"]);
        assert_eq!(second["items"][0]["archived"], json!(false));
        assert!(page_cursor(&second).is_none());
        assert_eq!(second["revision"], json!(300));
    }
```

- [ ] **Step 27: Strengthen the raw-byte assertion so insertion order is independent of parsed `Value` equality**

Inside `no_search_exact_response_shape_preserves_all_fields_bytes_and_no_totals`, replace the `serde_json::to_vec(&expected)` byte comparison with this complete assertion:

```rust
        assert_eq!(
            bytes,
            br#"{"items":[{"sessionId":"terminal:terminal-fallback","provider":"claude","projectPath":"/live","lastActivityAt":300,"isRunning":true,"archived":false,"title":"Claude CLI","createdAt":300,"cwd":"/live","runningTerminalId":"terminal-fallback","liveTerminalOnly":true,"sessionType":"claude"},{"sessionId":"shape","provider":"claude","projectPath":"/project","lastActivityAt":200,"isRunning":true,"archived":true,"title":"effective title","summary":"effective summary","firstUserMessage":"first user","createdAt":150,"cwd":"/cwd","runningTerminalId":"terminal-indexed"}],"nextCursor":null,"revision":300}"#.to_vec()
        );
```

This is stronger than the replaced assertion: it retains exact parsed equality and additionally pins raw response key order against a literal produced by the eager route.

- [ ] **Step 28: Run the new module against the untouched eager route**

Run:

```bash
FRESHELL_VITEST_BACKEND=local CARGO_TERM_COLOR=never cargo test --manifest-path /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/Cargo.toml -p freshell-server --bin freshell-server session_directory::page_bound_tests -- --color=never --test-threads=1
```

Expected: exit 0. Every new characterization is GREEN before production restructuring. If the exact raw bytes differ, stop and report the actual body; do not bless a later candidate-path ordering.

- [ ] **Step 29: Run the complete focused family to detect assertion regressions**

Run:

```bash
FRESHELL_VITEST_BACKEND=local CARGO_TERM_COLOR=never cargo test --manifest-path /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/Cargo.toml -p freshell-server --bin freshell-server session_directory -- --color=never --test-threads=1
```

Expected: exit 0 and no existing test regresses.

- [ ] **Step 30: Check the source diff for whitespace errors**

Run:

```bash
FRESHELL_VITEST_BACKEND=local git -C /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep diff --check -- crates/freshell-server/src/session_directory.rs
```

Expected: exit 0 and no output.

- [ ] **Step 31: Commit the green characterization checkpoint**

The command below is one valid example for a coherent task-level source checkpoint; its subject and body are illustrative, not required history. If this task's mandatory spec/quality review or a later final check finds a defect, make any additional source-only correction commit needed and rerun the affected checks before advancing. Do not infer an exact commit count, subject sequence, or commit order from this example.

Run:

```bash
FRESHELL_VITEST_BACKEND=local bash -c 'git -C /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep diff --check -- crates/freshell-server/src/session_directory.rs && git -C /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep add -- crates/freshell-server/src/session_directory.rs && test "$(git -C /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep diff --cached --name-only)" = "crates/freshell-server/src/session_directory.rs" && git -C /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep commit -m "test(session-directory): characterize effective page semantics" -m "Pin effective-corpus paging, revision, Rust-only search/order behavior, and exact wire bytes through the real Axum route." -m "Generated with Amplifier" -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"'
```

Expected: exit 0 and a normal local source-only commit. Do not inspect or enforce repository commit counts.

### Task 3: Freeze cursor, deep-search, partial, and edge semantics

**Files:**
- Modify/test: `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/crates/freshell-server/src/session_directory.rs`.
- Read only: `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/crates/freshell-sessions/src/search.rs`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/shared/read-models.ts`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/server/session-directory/service.ts`, and `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/Cargo.toml` solely to confirm `serde_json/preserve_order`.

**Interfaces:**
- Consumes: Task 2's `page_bound_tests` route harness and the current eager `apply_query`/deep-search path.
- Produces: exact invalid-cursor matrix and accepted-extra-field contract; deep-search I/O/budget-order fixtures; exact `io_error` then `budget` precedence; retained assertions for empty items, null cursor, revision, partial flags, and reasons.

- [ ] **Step 1: Import the Base64 trait in the existing main test module**

Add this exact import beside the existing imports inside `#[cfg(test)] mod tests`:

```rust
    use base64::Engine as _;
```

- [ ] **Step 2: Add the raw cursor-payload encoder**

Insert this complete helper inside the existing main `tests` module:

```rust
    fn encode_raw_cursor_payload(payload: &[u8]) -> String {
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload)
    }
```

- [ ] **Step 3: Replace the weak invalid-cursor test with the full rejection matrix**

Replace `invalid_cursor_is_rejected` with this complete test:

```rust
    #[test]
    fn invalid_cursor_is_rejected() {
        let cases = [
            ("invalid base64", "!!!not-base64!!!".to_string()),
            (
                "valid base64 with invalid JSON",
                encode_raw_cursor_payload(b"not-json"),
            ),
            ("JSON null", encode_raw_cursor_payload(b"null")),
            ("JSON array", encode_raw_cursor_payload(b"[]")),
            ("JSON object missing both fields", encode_raw_cursor_payload(b"{}")),
            (
                "missing key",
                encode_raw_cursor_payload(br#"{"lastActivityAt":1}"#),
            ),
            (
                "missing lastActivityAt",
                encode_raw_cursor_payload(br#"{"key":"claude:s1"}"#),
            ),
            (
                "string lastActivityAt",
                encode_raw_cursor_payload(
                    br#"{"lastActivityAt":"1","key":"claude:s1"}"#,
                ),
            ),
            (
                "fractional lastActivityAt",
                encode_raw_cursor_payload(
                    br#"{"lastActivityAt":1.5,"key":"claude:s1"}"#,
                ),
            ),
            (
                "out-of-i64 lastActivityAt",
                encode_raw_cursor_payload(
                    br#"{"lastActivityAt":18446744073709551615,"key":"claude:s1"}"#,
                ),
            ),
            (
                "non-string key",
                encode_raw_cursor_payload(br#"{"lastActivityAt":1,"key":1}"#),
            ),
            ("empty key", encode_cursor(1, "")),
        ];

        for (label, cursor) in cases {
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
                apply_query(Vec::new(), &query, &[]).expect_err(label),
                "Invalid session-directory cursor",
                "case={label}"
            );
        }
    }
```

- [ ] **Step 4: Add accepted-extra-field cursor coverage**

Append this complete test immediately after `invalid_cursor_is_rejected`:

```rust
    #[test]
    fn cursor_with_required_fields_and_extra_json_field_remains_accepted() {
        let cursor = encode_raw_cursor_payload(
            br#"{"lastActivityAt":7,"key":"claude:session","extra":true}"#,
        );
        let query = DirQuery {
            cursor: Some(cursor),
            ..DirQuery::default()
        };
        let page = apply_query(Vec::new(), &query, &[]).expect("extra field is ignored");
        assert!(page["items"].as_array().expect("items").is_empty());
        assert_eq!(page["nextCursor"], Value::Null);
        assert_eq!(page["revision"], json!(0));
    }
```

- [ ] **Step 5: Add the exact invalid-cursor route error contract**

Add this complete route-level test before `page_bound_tests` closes:

```rust
    #[tokio::test]
    async fn invalid_cursor_route_preserves_exact_400_payload() {
        let harness = directory_route_harness(Vec::new());
        let response = harness
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/session-directory?priority=visible&cursor=not-base64")
                    .header("x-auth-token", "tok")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("route response");
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("response body");
        let body: Value = serde_json::from_slice(&bytes).expect("JSON response");
        assert_eq!(
            body,
            json!({"error": "Invalid session-directory cursor"})
        );
    }
```

- [ ] **Step 6: Add the indexed deep-search row fixture**

Insert this complete helper before `synthetic_claude_home_with_turns` in the existing main `tests` module:

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
```

- [ ] **Step 7: Add the nonmatching Claude transcript writer**

Insert this complete helper before `synthetic_claude_home_with_turns` in the existing main `tests` module:

```rust
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
```

- [ ] **Step 8: Add the canonical deep-search query fixture**

Insert this complete helper before `synthetic_claude_home_with_turns` in the existing main `tests` module:

```rust
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

- [ ] **Step 9: Characterize missing-source I/O partial results**

Insert this complete test after `tier_search_reports_partial_budget_when_scan_budget_exceeded`:

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
        assert_eq!(page["nextCursor"], Value::Null);
        assert_eq!(page["revision"], json!(100));
        assert_eq!(page["partial"], json!(true));
        assert_eq!(page["partialReason"], json!("io_error"));
    }
```

- [ ] **Step 10: Characterize budget precedence over a prior I/O error**

Insert this complete test after `tier_search_reports_partial_budget_when_scan_budget_exceeded`:

```rust
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
        assert_eq!(page["nextCursor"], Value::Null);
        assert_eq!(page["revision"], json!(1_000));
        assert_eq!(page["partial"], json!(true));
        assert_eq!(page["partialReason"], json!("budget"));
    }
```

- [ ] **Step 11: Characterize the budget check before a no-source tail**

Insert this complete test after `tier_search_reports_partial_budget_when_scan_budget_exceeded`:

```rust
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
        assert_eq!(page["nextCursor"], Value::Null);
        assert_eq!(page["revision"], json!(1_000));
        assert_eq!(page["partial"], json!(true));
        assert_eq!(page["partialReason"], json!("budget"));
    }
```

The two budget tests retain all three result-state assertions: empty items, `partial=true`, and `partialReason="budget"`.

- [ ] **Step 12: Run the exact cursor tests against the eager implementation**

Run:

```bash
FRESHELL_VITEST_BACKEND=local CARGO_TERM_COLOR=never cargo test --manifest-path /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/Cargo.toml -p freshell-server --bin freshell-server session_directory::tests::invalid_cursor_is_rejected -- --exact --color=never --test-threads=1
```

Expected: exit 0 with the exact matching test passing.

- [ ] **Step 13: Run the accepted-extra-field cursor test**

Run:

```bash
FRESHELL_VITEST_BACKEND=local CARGO_TERM_COLOR=never cargo test --manifest-path /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/Cargo.toml -p freshell-server --bin freshell-server session_directory::tests::cursor_with_required_fields_and_extra_json_field_remains_accepted -- --exact --color=never --test-threads=1
```

Expected: exit 0 with one matching test passing.

- [ ] **Step 14: Run all three deep I/O/budget-order tests together**

Run:

```bash
FRESHELL_VITEST_BACKEND=local CARGO_TERM_COLOR=never cargo test --manifest-path /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/Cargo.toml -p freshell-server --bin freshell-server tier_search_ -- --color=never --test-threads=1
```

Expected: exit 0; the missing-source case reports `io_error`, and both budget-order cases report `budget` with empty items and `partial=true`.

- [ ] **Step 15: Rerun all route characterizations**

Run:

```bash
FRESHELL_VITEST_BACKEND=local CARGO_TERM_COLOR=never cargo test --manifest-path /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/Cargo.toml -p freshell-server --bin freshell-server session_directory::page_bound_tests -- --color=never --test-threads=1
```

Expected: exit 0.

- [ ] **Step 16: Rerun the complete focused family**

Run:

```bash
FRESHELL_VITEST_BACKEND=local CARGO_TERM_COLOR=never cargo test --manifest-path /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/Cargo.toml -p freshell-server --bin freshell-server session_directory -- --color=never --test-threads=1
```

Expected: exit 0. Production is still unchanged.

- [ ] **Step 17: Commit the second green characterization checkpoint**

The command below is one valid example for a coherent task-level source checkpoint; its subject and body are illustrative, not required history. If this task's mandatory spec/quality review or a later final check finds a defect, make any additional source-only correction commit needed and rerun the affected checks before advancing. Do not infer an exact commit count, subject sequence, or commit order from this example.

Run:

```bash
FRESHELL_VITEST_BACKEND=local bash -c 'git -C /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep diff --check -- crates/freshell-server/src/session_directory.rs && git -C /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep add -- crates/freshell-server/src/session_directory.rs && test "$(git -C /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep diff --cached --name-only)" = "crates/freshell-server/src/session_directory.rs" && git -C /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep commit -m "test(session-directory): freeze cursor and search edges" -m "Characterize invalid cursors, accepted extra cursor fields, transcript I/O failures, scan-budget precedence, and budget-before-source ordering." -m "Generated with Amplifier" -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"'
```

Expected: exit 0 and a normal local source-only commit.

### Task 4: Build the borrowed candidate path, prove parity, and cut over

**Files:**
- Modify/test: `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/crates/freshell-server/src/session_directory.rs`.
- Read only: `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/crates/freshell-sessions/src/directory_index.rs`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/crates/freshell-sessions/src/search.rs`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/crates/freshell-ws/src/identity.rs`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/crates/freshell-server/src/settings_store.rs`, and `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/crates/freshell-server/src/session_metadata.rs`.

**Interfaces:**
- Consumes: Tasks 2-3's green route contracts; current eager helper chain as a temporary test oracle; `IndexedSession`, `TerminalIdentity`, `FileSearchTier`, `search_session_file`, override map, metadata map, and `Arc<Vec<IndexedSession>>` snapshot owner.
- Produces: `DirectoryInputs<'a>`, `IndexedOverlay<'a>`, `SynthesizedSessionId<'a>`, `DirectoryCandidateSource<'a>`, `DirectoryCandidate<'a>`, `DirectoryOrderKey<'a>`, `DecodedCursor`, `SearchAnnotation`, `SelectedCandidate<'a>`, `CandidatePage<'a>`, `resolve_indexed_overlay`, `build_directory_candidates`, one comparator/cursor relation/eligibility predicate, `title_search_annotation`, `file_search_tier`, temporary unbounded non-deep `select_page_candidates`, consuming `materialize_selected_candidate`, `derive_directory_page`, handler cutover, and temporary test-only eager differential.

- [ ] **Step 1: Create the nested `candidate_tests` module shell**

Insert this complete shell before the closing brace of `page_bound_tests`:

```rust
    mod candidate_tests {
        use super::*;
    }
```

- [ ] **Step 2: Add the shared order/cursor RED test**

Insert this complete test before the closing brace of `candidate_tests`:

```rust
        #[test]
        fn shared_order_and_cursor_relation_covers_full_keys_and_i64_extremes() {
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
                let mut candidates = build_directory_candidates(
                    std::slice::from_ref(&row),
                    &overrides,
                    &identities,
                );
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
                    expected,
                );
                assert_eq!(
                    candidate_is_strictly_after_cursor(&candidate, &cursor),
                    expected == std::cmp::Ordering::Greater,
                );
            }
        }
```

- [ ] **Step 3: Add the shared eligibility RED test**

Insert this complete test before the closing brace of `candidate_tests`:

```rust
        #[test]
        fn shared_eligibility_preserves_flags_running_empty_and_cursor_order() {
            let mut subagent = indexed_row("subagent", 300, Some("visible"));
            subagent.is_subagent = true;
            let mut noninteractive = indexed_row("noninteractive", 290, Some("visible"));
            noninteractive.is_non_interactive = true;
            let empty = indexed_row("empty", 280, Some("   "));
            let running = indexed_row("running", 270, None);
            let indexed = vec![subagent, noninteractive, empty, running];
            let registry = freshell_ws::identity::TerminalIdentityRegistry::new();
            registry.upsert(
                "terminal-running",
                Some("claude"),
                Some("running"),
                Some("/repo"),
                900,
            );
            let identities = registry.list();
            let overrides = Map::new();
            let candidates = build_directory_candidates(&indexed, &overrides, &identities);
            let by_id = |session_id: &str| {
                candidates
                    .iter()
                    .find(|candidate| match &candidate.source {
                        DirectoryCandidateSource::Indexed { row, .. } => {
                            row.session_id == session_id
                        }
                        DirectoryCandidateSource::Synthesized { .. } => false,
                    })
                    .expect("indexed candidate")
            };

            let default_query = test_query(None, Tier::Title, None, 50);
            assert!(!candidate_is_eligible(
                by_id("subagent"),
                &default_query,
                None,
            ));
            assert!(!candidate_is_eligible(
                by_id("noninteractive"),
                &default_query,
                None,
            ));
            assert!(!candidate_is_eligible(
                by_id("empty"),
                &default_query,
                None,
            ));
            assert!(candidate_is_eligible(
                by_id("running"),
                &default_query,
                None,
            ));

            let mut all_flags = default_query;
            all_flags.include_subagents = true;
            all_flags.include_non_interactive = true;
            all_flags.include_empty = true;
            assert!(candidate_is_eligible(
                by_id("subagent"),
                &all_flags,
                None,
            ));
            assert!(candidate_is_eligible(
                by_id("noninteractive"),
                &all_flags,
                None,
            ));
            assert!(candidate_is_eligible(by_id("empty"), &all_flags, None));

            let cursor = DecodedCursor {
                last_activity_at: 280,
                key: "claude:empty".to_string(),
            };
            assert!(!candidate_is_eligible(
                by_id("empty"),
                &all_flags,
                Some(&cursor),
            ));
            assert!(candidate_is_eligible(
                by_id("running"),
                &all_flags,
                Some(&cursor),
            ));
        }
```

- [ ] **Step 4: Add the indexed-overlay RED test**

Insert this complete test before the closing brace of `candidate_tests`:

```rust
        #[test]
        fn indexed_overlay_preserves_delete_title_guard_summary_and_archive_rules() {
            let mut row = indexed_row("overlay", 100, Some("base title"));
            row.summary = Some("base summary".to_string());
            row.title_source = Some("provider-generated".to_string());

            let accepted = json!({
                "titleOverride": "accepted",
                "titleSource": "user",
                "summaryOverride": "",
                "archived": true,
            });
            let overlay =
                resolve_indexed_overlay(&row, Some(&accepted)).expect("accepted overlay");
            assert_eq!(overlay.effective_title, Some("accepted"));
            assert_eq!(overlay.effective_summary, Some(""));
            assert!(overlay.archived);

            for source in ["dir", "first-message"] {
                let suppressed = json!({
                    "titleOverride": "suppressed",
                    "titleSource": source,
                });
                let overlay =
                    resolve_indexed_overlay(&row, Some(&suppressed)).expect("overlay");
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
```

- [ ] **Step 5: Add the candidate-builder RED test**

Insert this complete test before the closing brace of `candidate_tests`:

```rust
        #[test]
        fn candidate_builder_preserves_indexed_duplicates_full_key_collisions_and_identity_winners() {
            let duplicate_first = provider_row("claude", "duplicate", 500, Some("first"));
            let duplicate_second = provider_row("claude", "duplicate", 500, Some("second"));
            let deleted = provider_row("claude", "deleted-live", 490, Some("deleted"));
            let indexed_collision_first =
                provider_row("a", "b:c", 480, Some("indexed collision first"));
            let indexed_collision_second =
                provider_row("a:b", "c", 479, Some("indexed collision second"));
            let indexed = vec![
                duplicate_first,
                duplicate_second,
                deleted,
                indexed_collision_first,
                indexed_collision_second,
            ];
            let overrides = Map::from_iter([(
                "claude:deleted-live".to_string(),
                json!({"deleted": true}),
            )]);

            let registry = freshell_ws::identity::TerminalIdentityRegistry::new();
            registry.upsert(
                "z-running-first",
                Some("claude"),
                Some("duplicate"),
                Some("/first"),
                700,
            );
            registry.upsert(
                "a-running-second",
                Some("claude"),
                Some("duplicate"),
                Some("/second"),
                701,
            );
            registry.upsert(
                "deleted-resynth",
                Some("claude"),
                Some("deleted-live"),
                Some("/live"),
                702,
            );
            registry.upsert(
                "string-collision",
                Some("a:b"),
                Some("c"),
                Some("/collision"),
                703,
            );
            registry.upsert(
                "synth-first",
                Some("x"),
                Some("y:z"),
                Some("/synth-first"),
                704,
            );
            registry.upsert(
                "synth-second",
                Some("x:y"),
                Some("z"),
                Some("/synth-second"),
                705,
            );
            let identities = [
                "z-running-first",
                "a-running-second",
                "deleted-resynth",
                "string-collision",
                "synth-first",
                "synth-second",
            ]
            .into_iter()
            .map(|terminal_id| registry.get(terminal_id).expect("identity"))
            .collect::<Vec<_>>();

            let candidates = build_directory_candidates(&indexed, &overrides, &identities);
            let duplicate_rows = candidates
                .iter()
                .filter(|candidate| candidate.key.as_ref() == "claude:duplicate")
                .collect::<Vec<_>>();
            assert_eq!(duplicate_rows.len(), 2, "indexed duplicates survive");
            for candidate in duplicate_rows {
                match &candidate.source {
                    DirectoryCandidateSource::Indexed {
                        running_identity, ..
                    } => assert_eq!(
                        running_identity
                            .expect("running winner")
                            .terminal_id
                            .as_str(),
                        "z-running-first",
                    ),
                    DirectoryCandidateSource::Synthesized { .. } => {
                        panic!("duplicate key must remain indexed")
                    }
                }
            }

            let deleted_live = candidates
                .iter()
                .find(|candidate| candidate.key.as_ref() == "claude:deleted-live")
                .expect("deleted row is resynthesized");
            assert!(matches!(
                &deleted_live.source,
                DirectoryCandidateSource::Synthesized { .. }
            ));

            let indexed_collision_count = candidates
                .iter()
                .filter(|candidate| candidate.key.as_ref() == "a:b:c")
                .count();
            assert_eq!(
                indexed_collision_count,
                2,
                "both indexed tuple variants survive while synthesis of the same full key is suppressed"
            );

            let synthesized_collision = candidates
                .iter()
                .find(|candidate| candidate.key.as_ref() == "x:y:z")
                .expect("first synthesized collision winner");
            match &synthesized_collision.source {
                DirectoryCandidateSource::Synthesized { identity, .. } => {
                    assert_eq!(identity.terminal_id, "synth-first")
                }
                DirectoryCandidateSource::Indexed { .. } => {
                    panic!("collision winner must be synthesized")
                }
            }
        }
```

- [ ] **Step 6: Add the title-annotation RED test**

Insert this complete test before the closing brace of `candidate_tests`:

```rust
        #[test]
        fn title_annotation_preserves_precedence_case_and_140_scalar_snippet() {
            let mut row = indexed_row("precedence", 100, Some("Needle title"));
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
            assert_eq!(annotation.snippet, "Needle title");

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
                assert_eq!(
                    annotation.snippet,
                    field.chars().take(140).collect::<String>(),
                );
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
                "summary",
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
                .expect("first-message match")
                .matched_in,
                "firstUserMessage",
            );
        }
```

- [ ] **Step 7: Run the candidate tests and observe the intended RED**

Run:

```bash
FRESHELL_VITEST_BACKEND=local CARGO_TERM_COLOR=never cargo test --manifest-path /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/Cargo.toml -p freshell-server --bin freshell-server session_directory::page_bound_tests::candidate_tests -- --color=never --test-threads=1
```

Expected RED: compilation fails only because the new candidate types/functions are not yet defined, naming symbols such as `build_directory_candidates`, `DecodedCursor`, or `resolve_indexed_overlay`. Any unrelated parse, type, or fixture failure is not valid RED.

- [ ] **Step 8: Replace the import region with the complete candidate-pipeline imports**

Use this complete import block, retaining the current root re-export for transcript search:

```rust
use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::Arc,
};

use axum::{
    extract::{Query, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use freshell_sessions::directory_index::{IndexedSession, SessionIndex};
use freshell_sessions::{search_session_file, FileSearchTier};
#[cfg(test)]
use freshell_sessions::meta::ParsedSessionMeta;
#[cfg(test)]
use freshell_sessions::{parse_session_content, ParseSessionOptions};
use freshell_ws::identity::TerminalIdentity;
use serde_json::{json, Map, Value};

use crate::boot::{is_authed, unauthorized};
```

- [ ] **Step 9: Replace `provider_display_name` with a borrowed return**

Replace the complete helper with:

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

- [ ] **Step 10: Adapt the temporary eager live-row title field**

Replace the title field in the still-test-only eager `build_live_terminal_session_item` with:

```rust
        title: Some(provider_display_name(&provider).to_string()),
```

- [ ] **Step 11: Add borrowed input and candidate-source types**

Insert this complete type group before the cursor codec:

```rust
struct DirectoryInputs<'a> {
    indexed: &'a [IndexedSession],
    overrides: &'a Map<String, Value>,
    metadata: &'a HashMap<String, Value>,
    identities: &'a [TerminalIdentity],
}

#[derive(Debug, Clone, Copy)]
struct IndexedOverlay<'a> {
    effective_title: Option<&'a str>,
    effective_summary: Option<&'a str>,
    archived: bool,
}

#[derive(Debug, Clone, Copy)]
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
```

- [ ] **Step 12: Add order, cursor, annotation, and selected-page types**

Insert this complete type group after the candidate-source types:

```rust
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
    matched_in: &'static str,
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
```

- [ ] **Step 13: Implement indexed override resolution**

Insert this complete function after the candidate types:

```rust
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
```

- [ ] **Step 14: Build the first exact identity lookup**

Insert this complete helper after `resolve_indexed_overlay`:

```rust
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
```

- [ ] **Step 15: Build borrowed directory candidates**

Insert this complete candidate builder after the identity lookup:

```rust
fn build_directory_candidates<'a>(
    indexed: &'a [IndexedSession],
    overrides: &'a Map<String, Value>,
    identities: &'a [TerminalIdentity],
) -> Vec<DirectoryCandidate<'a>> {
    let first_live = first_identity_by_exact_session(identities);
    let mut existing_keys: HashSet<Arc<str>> = HashSet::new();
    let mut candidates = Vec::with_capacity(indexed.len() + identities.len());

    for row in indexed {
        let key: Arc<str> =
            Arc::from(format!("{}:{}", row.provider, row.session_id).into_boxed_str());
        let Some(overlay) = resolve_indexed_overlay(row, overrides.get(key.as_ref())) else {
            continue;
        };
        let running_identity = first_live
            .get(&(row.provider.as_str(), row.session_id.as_str()))
            .map(|index| &identities[*index]);

        // Preserve every surviving indexed duplicate. The set is synthesis-only
        // membership; a repeated indexed key does not suppress an indexed row.
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
```

- [ ] **Step 16: Add candidate accessors for order, search, and visibility**

Insert this complete implementation after the candidate builder:

```rust
impl DirectoryCandidate<'_> {
    fn order_key(&self) -> DirectoryOrderKey<'_> {
        DirectoryOrderKey {
            last_activity_at: match &self.source {
                DirectoryCandidateSource::Indexed { row, .. } => row.last_activity_at,
                DirectoryCandidateSource::Synthesized { identity, .. } => identity.updated_at,
            },
            key: self.key.as_ref(),
        }
    }

    fn provider(&self) -> &str {
        match &self.source {
            DirectoryCandidateSource::Indexed { row, .. } => row.provider.as_str(),
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

    fn source_file(&self) -> Option<&Path> {
        match &self.source {
            DirectoryCandidateSource::Indexed { row, .. } => row.source_file.as_deref(),
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
}
```

- [ ] **Step 17: Replace the cursor codec with the typed decoder**

Use this complete codec block:

```rust
fn encode_cursor(last_activity_at: i64, key: &str) -> String {
    let payload = json!({ "lastActivityAt": last_activity_at, "key": key });
    URL_SAFE_NO_PAD.encode(payload.to_string().as_bytes())
}

fn decode_cursor(raw: &str) -> Result<DecodedCursor, String> {
    let bytes = URL_SAFE_NO_PAD
        .decode(raw.as_bytes())
        .map_err(|_| "Invalid session-directory cursor".to_string())?;
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "Invalid session-directory cursor".to_string())?;
    let last_activity_at = value.get("lastActivityAt").and_then(Value::as_i64);
    let key = value.get("key").and_then(Value::as_str);
    match (last_activity_at, key) {
        (Some(last_activity_at), Some(key)) if !key.is_empty() => Ok(DecodedCursor {
            last_activity_at,
            key: key.to_string(),
        }),
        _ => Err("Invalid session-directory cursor".to_string()),
    }
}
```

- [ ] **Step 18: Adapt eager-oracle cursor retention to `DecodedCursor`**

While the eager oracle remains, replace its cursor-retention block inside `apply_query` with:

```rust
    if let Some(cursor) = &cursor {
        items.retain(|item| {
            item.last_activity_at < cursor.last_activity_at
                || (item.last_activity_at == cursor.last_activity_at
                    && item.key().as_str() < cursor.key.as_str())
        });
    }
```

- [ ] **Step 19: Implement the sole directory-order comparator**

Insert this complete function:

```rust
fn compare_directory_order(
    left: DirectoryOrderKey<'_>,
    right: DirectoryOrderKey<'_>,
) -> Ordering {
    right
        .last_activity_at
        .cmp(&left.last_activity_at)
        .then_with(|| right.key.cmp(left.key))
}
```

- [ ] **Step 20: Implement strict continuation through the shared comparator**

Insert this complete function:

```rust
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
```

- [ ] **Step 21: Implement the sole candidate eligibility predicate**

Insert this complete function:

```rust
fn candidate_is_eligible(
    candidate: &DirectoryCandidate<'_>,
    query: &DirQuery,
    cursor: Option<&DecodedCursor>,
) -> bool {
    (query.include_subagents || !candidate.is_subagent())
        && (query.include_non_interactive || !candidate.is_non_interactive())
        && (query.include_empty
            || candidate.is_running()
            || candidate
                .effective_title()
                .map(str::trim)
                .is_some_and(|title| !title.is_empty()))
        && cursor
            .map(|cursor| candidate_is_strictly_after_cursor(candidate, cursor))
            .unwrap_or(true)
}
```

- [ ] **Step 22: Implement title-search annotation**

Insert this complete function:

```rust
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
                matched_in,
                snippet: field.chars().take(140).collect(),
            });
        }
    }
    None
}
```

- [ ] **Step 23: Map directory tiers to file-search tiers**

Insert this complete function:

```rust
fn file_search_tier(tier: Tier) -> Option<FileSearchTier> {
    match tier {
        Tier::Title => None,
        Tier::UserMessages => Some(FileSearchTier::UserMessages),
        Tier::FullText => Some(FileSearchTier::FullText),
    }
}
```

- [ ] **Step 24: Add the temporary parity selector with intentionally unbounded no-search/title retention**

Use this complete selector for Tasks 4-5. It already preserves deep lookahead/budget order; Task 6 adds and proves the final non-deep post-push break.

```rust
fn select_page_candidates<'a>(
    mut candidates: Vec<DirectoryCandidate<'a>>,
    query: &DirQuery,
    cursor: Option<&DecodedCursor>,
    limit: usize,
) -> CandidatePage<'a> {
    candidates.sort_by(|left, right| {
        compare_directory_order(left.order_key(), right.order_key())
    });

    let query_text = query
        .query
        .as_deref()
        .map(str::trim)
        .filter(|query_text| !query_text.is_empty());
    let lowercase_title_query = if query_text.is_some() && query.tier == Tier::Title {
        Some(query_text.expect("query exists").to_lowercase())
    } else {
        None
    };

    let mut rows = Vec::new();
    let mut partial = false;
    let mut partial_reason = None;
    let mut scanned_files = 0usize;
    let max_scan = limit * 10;

    for candidate in candidates {
        if !candidate_is_eligible(&candidate, query, cursor) {
            continue;
        }

        let annotation = match (query_text, query.tier) {
            (None, _) => None,
            (Some(_), Tier::Title) => {
                let Some(annotation) = title_search_annotation(
                    &candidate,
                    lowercase_title_query
                        .as_deref()
                        .expect("lowercase title query"),
                ) else {
                    continue;
                };
                Some(annotation)
            }
            (Some(search_text), Tier::UserMessages | Tier::FullText) => {
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
                let tier = file_search_tier(query.tier).expect("file search tier");
                match search_session_file(path, candidate.provider(), search_text, tier) {
                    Ok(Some(found)) => {
                        let annotation = SearchAnnotation {
                            matched_in: found.matched_in,
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
```

- [ ] **Step 25: Add the temporary consuming materializer**

Use this complete materializer while the eager test oracle still requires the two legacy `DirItem` fields:

```rust
fn materialize_selected_candidate(
    selected: SelectedCandidate<'_>,
    metadata: &HashMap<String, Value>,
) -> DirItem {
    let SelectedCandidate {
        candidate,
        annotation,
    } = selected;
    let DirectoryCandidate { key, source } = candidate;
    let (matched_in, snippet) = match annotation {
        Some(SearchAnnotation {
            matched_in,
            snippet,
        }) => (Some(matched_in.to_string()), Some(snippet)),
        None => (None, None),
    };

    match source {
        DirectoryCandidateSource::Indexed {
            row,
            overlay,
            running_identity,
        } => {
            let session_type = metadata
                .get(key.as_ref())
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
                matched_in,
                snippet,
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
                    (session_id.to_string(), false)
                }
                SynthesizedSessionId::TerminalFallback(terminal_id) => {
                    (format!("terminal:{terminal_id}"), true)
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
                matched_in,
                snippet,
                running_terminal_id: Some(identity.terminal_id.clone()),
                live_terminal_only,
                session_type: Some(provider.to_string()),
                title_source: None,
                source_file: None,
            }
        }
    }
}
```

- [ ] **Step 26: Add owned directory-page derivation**

Add this complete page derivation:

```rust
fn derive_directory_page(
    inputs: DirectoryInputs<'_>,
    query: &DirQuery,
) -> Result<Value, String> {
    let limit = query
        .limit
        .unwrap_or(MAX_DIRECTORY_PAGE_ITEMS)
        .min(MAX_DIRECTORY_PAGE_ITEMS);
    let candidates = build_directory_candidates(
        inputs.indexed,
        inputs.overrides,
        inputs.identities,
    );
    let cursor = query
        .cursor
        .as_deref()
        .map(decode_cursor)
        .transpose()?;
    let revision = candidates
        .iter()
        .map(|candidate| candidate.order_key().last_activity_at)
        .chain(inputs.identities.iter().map(|identity| identity.updated_at))
        .max()
        .unwrap_or(0)
        .max(0);

    let selected = select_page_candidates(candidates, query, cursor.as_ref(), limit);
    let has_more = selected.rows.len() > limit;
    let next_cursor = has_more.then(|| {
        let tail = selected.rows[limit - 1].candidate.order_key();
        encode_cursor(tail.last_activity_at, tail.key)
    });
    let CandidatePage {
        rows,
        partial,
        partial_reason,
    } = selected;
    let items = rows
        .into_iter()
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
    if partial {
        page["partial"] = Value::Bool(true);
        if let Some(reason) = partial_reason {
            page["partialReason"] = Value::String(reason.to_string());
        }
    }
    Ok(page)
}
```

- [ ] **Step 27: Compile the complete borrowed production core before handler cutover**

Run:

```bash
FRESHELL_VITEST_BACKEND=local CARGO_TERM_COLOR=never cargo check --locked --manifest-path /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/Cargo.toml -p freshell-server
```

Expected: exit 0. This compiles the complete non-test borrowed core against the real locked crate while the eager handler remains registered. On failure, stop before handler modification, retain diagnostics, repair only the planned one-file borrowed design, and rerun this gate and Step 28. No failure authorizes an owned fallback, adapter, API/manifest change, or second source file.

- [ ] **Step 28: Compile inline candidate and eager-oracle coexistence before handler cutover**

Run:

```bash
FRESHELL_VITEST_BACKEND=local CARGO_TERM_COLOR=never cargo test --locked --manifest-path /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/Cargo.toml -p freshell-server --bin freshell-server --no-run
```

Expected: exit 0. This compiles inline candidate tests and eager/candidate coexistence against the lockfile. On failure, stop before handler modification under the same one-file correction/reopen rule as Step 27.

- [ ] **Step 29: Run the shared candidate tests GREEN before handler cutover**

Run:

```bash
FRESHELL_VITEST_BACKEND=local CARGO_TERM_COLOR=never cargo test --manifest-path /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/Cargo.toml -p freshell-server --bin freshell-server session_directory::page_bound_tests::candidate_tests -- --color=never --test-threads=1
```

Expected: exit 0; shared order/cursor, eligibility, override, candidate-winner, and title-annotation tests pass.

- [ ] **Step 30: Gate every eager policy declaration to tests**

Add this complete attribute immediately before each existing declaration named `dir_item_from_indexed`, `apply_session_overrides`, `apply_session_metadata`, `join_running_state`, `build_live_terminal_session_item`, `join_live_terminals`, `apply_query`, `FileSearchOutcome`, `apply_file_search`, and `apply_title_search`; leave each body unchanged:

```rust
#[cfg(test)]
```

- [ ] **Step 31: Add the temporary eager page oracle**

Add this complete test-only oracle function:

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

- [ ] **Step 32: Add deterministic differential support types and seeds**

Insert this complete support group before the closing brace of `candidate_tests`:

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

const DIFFERENTIAL_SEEDS: [u64; 2] = [0x5EED_0001, 0x5EED_0002];
```

- [ ] **Step 33: Build the seeded differential fixture**

Insert this complete fixture builder inside `candidate_tests`:

```rust
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
    indexed[13].summary = Some("needle-summary".to_string());
    indexed[14].first_user_message = Some("needle-first".to_string());
    indexed[15].source_file = Some(user_hit);
    indexed[16].source_file = Some(assistant_hit);
    indexed[17].source_file = Some(no_hit);
    indexed[18].source_file = Some(missing);
    indexed[19].source_file = Some(home.path().join("unsupported.jsonl"));
    indexed[20].source_file = None;
    indexed[9].is_subagent = true;
    indexed[10].is_non_interactive = true;
    indexed[7].title_source = Some("provider-generated".to_string());

    let mut overrides = Map::new();
    overrides.insert("claude:deleted".to_string(), json!({"deleted": true}));
    overrides.insert(
        "claude:deleted-live".to_string(),
        json!({"deleted": true}),
    );
    overrides.insert(
        "claude:override-title".to_string(),
        json!({"titleOverride": "needle-title-override", "titleSource": "user"}),
    );
    overrides.insert(
        "claude:override-summary".to_string(),
        json!({"summaryOverride": "needle-summary-override", "archived": true}),
    );
    overrides.insert(
        "claude:provider-generated".to_string(),
        json!({"titleOverride": "suppressed", "titleSource": "dir"}),
    );
    overrides.insert(
        "claude:empty-override".to_string(),
        json!({"titleOverride": ""}),
    );

    let mut metadata = HashMap::new();
    metadata.insert(
        "claude:ordinary".to_string(),
        json!({"sessionType": "claude"}),
    );
    metadata.insert("claude:duplicate".to_string(), json!({}));

    let registry = freshell_ws::identity::TerminalIdentityRegistry::new();
    registry.upsert(
        "z-exact-first",
        Some("claude"),
        Some("running-empty"),
        Some("/running"),
        1_100,
    );
    registry.upsert(
        "a-exact-second",
        Some("claude"),
        Some("running-empty"),
        Some("/second"),
        1_101,
    );
    registry.upsert(
        "y-alias-first",
        Some("a"),
        Some("b:c"),
        Some("/alias-first"),
        1_102,
    );
    registry.upsert(
        "b-alias-second",
        Some("a:b"),
        Some("c"),
        Some("/alias-second"),
        1_103,
    );
    registry.upsert(
        "deleted-resynth",
        Some("claude"),
        Some("deleted-live"),
        Some("/live"),
        1_104,
    );
    registry.upsert(
        "providerless",
        None,
        Some("ignored"),
        Some("/ignored"),
        1_105,
    );
    registry.upsert(
        "live-fallback",
        Some("claude"),
        None,
        None,
        1_106,
    );
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
    .map(|terminal_id| registry.get(terminal_id).expect("identity"))
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
```

- [ ] **Step 34: Add differential visibility axes**

Insert this complete axis function inside `candidate_tests`:

```rust
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
```

- [ ] **Step 35: Add differential query/tier axes**

Insert this complete axis function inside `candidate_tests`:

```rust
fn differential_query_cases() -> [(Option<&'static str>, Tier); 10] {
    [
        (None, Tier::Title),
        (Some("   "), Tier::Title),
        (Some("needle-title"), Tier::Title),
        (Some("needle-summary"), Tier::Title),
        (Some("needle-first"), Tier::Title),
        (Some("absent-title"), Tier::Title),
        (Some("needle-user"), Tier::UserMessages),
        (Some("needle-assistant"), Tier::UserMessages),
        (Some("needle-assistant"), Tier::FullText),
        (Some("absent-transcript"), Tier::FullText),
    ]
}
```

- [ ] **Step 36: Add the initial differential limit axis**

Insert this complete axis function inside `candidate_tests`:

```rust
fn differential_limits() -> [usize; 2] {
    [1, 2]
}
```

- [ ] **Step 37: Add differential cursor axes**

Insert this complete axis function inside `candidate_tests`:

```rust
fn differential_cursors() -> [Option<String>; 2] {
    [None, Some(encode_cursor(650, "claude:empty-override"))]
}
```

- [ ] **Step 38: Add fixed deep-partial differential cases**

Insert this complete fixture-case function inside `candidate_tests`:

```rust
fn fixed_deep_partial_cases() -> Vec<(
    DifferentialFixture,
    DirQuery,
    &'static str,
    Option<&'static str>,
)> {
    let mut io_only = seeded_differential_fixture(DIFFERENTIAL_SEEDS[0]);
    io_only
        .indexed
        .retain(|row| row.session_id == "missing-source");

    let mut io_budget = seeded_differential_fixture(DIFFERENTIAL_SEEDS[1]);
    io_budget.indexed.retain(|row| {
        matches!(
            row.session_id.as_str(),
            "missing-source" | "no-hit" | "ordinary"
        )
    });
    let io_budget_source = io_budget
        .indexed
        .iter()
        .find(|candidate| candidate.session_id == "no-hit")
        .and_then(|candidate| candidate.source_file.clone())
        .expect("nonmatching transcript source");
    while io_budget.indexed.len() < 11 {
        let mut row = provider_row(
            "claude",
            &format!("budget-{}", io_budget.indexed.len()),
            500 - io_budget.indexed.len() as i64,
            Some("visible"),
        );
        row.source_file = Some(io_budget_source.clone());
        io_budget.indexed.push(row);
    }
    let mut io_budget_stop = provider_row("claude", "io-budget-stop", 1, Some("visible"));
    io_budget_stop.source_file = Some(io_budget_source);
    io_budget.indexed.push(io_budget_stop);

    let mut budget_tail = seeded_differential_fixture(DIFFERENTIAL_SEEDS[0]);
    budget_tail.indexed.retain(|row| row.session_id == "no-hit");
    while budget_tail.indexed.len() < 10 {
        let mut row = budget_tail.indexed[0].clone();
        row.session_id = format!("budget-tail-{}", budget_tail.indexed.len());
        budget_tail.indexed.push(row);
    }
    budget_tail
        .indexed
        .push(provider_row("claude", "no-source-tail", 1, Some("visible")));

    let mut lookahead = seeded_differential_fixture(DIFFERENTIAL_SEEDS[1]);
    lookahead.indexed.retain(|row| {
        matches!(
            row.session_id.as_str(),
            "user-hit" | "missing-source" | "no-hit"
        )
    });
    let mut second_hit = lookahead
        .indexed
        .iter()
        .find(|row| row.session_id == "user-hit")
        .expect("first lookahead hit")
        .clone();
    second_hit.session_id = "user-hit-lookahead".to_string();
    second_hit.last_activity_at = 570;
    lookahead.indexed.push(second_hit);

    let query = || DirQuery {
        query: Some("needle-user".to_string()),
        tier: Tier::UserMessages,
        limit: Some(1),
        include_subagents: true,
        include_non_interactive: true,
        include_empty: true,
        ..DirQuery::default()
    };
    vec![
        (io_only, query(), "io-only", Some("io_error")),
        (io_budget, query(), "io-then-budget", Some("budget")),
        (
            budget_tail,
            query(),
            "budget-before-no-source",
            Some("budget"),
        ),
        (lookahead, query(), "lookahead-before-later-partial", None),
    ]
}
```

`io-budget-stop` sorts after the ten scannable rows, so the selector must visit this later eligible candidate with `scanned_files == 10` and overwrite the earlier `io_error` with `budget`. The tuple pins `io-only -> io_error`, `io-then-budget -> budget`, `budget-before-no-source -> budget`, and exact omission of both partial fields for `lookahead-before-later-partial`. Keep Task 3's dedicated I/O/budget tests unchanged.

- [ ] **Step 39: Add the initial seeded differential test**

Insert this complete test inside `candidate_tests`:

```rust
#[test]
fn candidate_path_matches_eager_oracle_across_seeded_cross_product() {
    let visibility_cases = differential_visibility_cases();
    let query_cases = differential_query_cases();
    let limits = differential_limits();
    let cursors = differential_cursors();
    let expected_cross_product = DIFFERENTIAL_SEEDS.len()
        * visibility_cases.len()
        * query_cases.len()
        * limits.len()
        * cursors.len();
    let mut comparisons = 0usize;

    for seed in DIFFERENTIAL_SEEDS {
        let fixture = seeded_differential_fixture(seed);
        for (include_subagents, include_non_interactive, include_empty) in visibility_cases {
            for (query_text, tier) in query_cases {
                for limit in limits {
                    for cursor in cursors.clone() {
                        let query = DirQuery {
                            query: query_text.map(str::to_string),
                            tier,
                            limit: Some(limit),
                            cursor,
                            include_subagents,
                            include_non_interactive,
                            include_empty,
                        };
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
                        assert_eq!(candidate, eager);
                        assert_eq!(
                            serde_json::to_vec(&candidate).expect("candidate bytes"),
                            serde_json::to_vec(&eager).expect("eager bytes"),
                        );
                        comparisons += 1;
                    }
                }
            }
        }
    }

    let fixed_cases = fixed_deep_partial_cases();
    let expected_fixed = fixed_cases.len();
    for (fixture, query, label, expected_partial_reason) in fixed_cases {
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
        match expected_partial_reason {
            Some(reason) => {
                assert_eq!(candidate.get("partial"), Some(&json!(true)), "case={label}");
                assert_eq!(
                    candidate.get("partialReason"),
                    Some(&json!(reason)),
                    "case={label}",
                );
            }
            None => {
                assert!(candidate.get("partial").is_none(), "case={label}");
                assert!(candidate.get("partialReason").is_none(), "case={label}");
            }
        }
        comparisons += 1;
    }

    assert_eq!(comparisons, expected_cross_product + expected_fixed);
}
```

- [ ] **Step 40: Add empty and malformed metadata variants to the seeded fixture**

After the two existing metadata inserts in `seeded_differential_fixture`, add this complete block:

```rust
    metadata.insert(
        "claude:override-title".to_string(),
        json!({"sessionType": ""}),
    );
    metadata.insert(
        "claude:override-summary".to_string(),
        json!({"sessionType": 7}),
    );
```

- [ ] **Step 41: Expand the differential limit axis to include 50**

Replace `differential_limits` with this complete function:

```rust
fn differential_limits() -> [usize; 3] {
    [1, 2, 50]
}
```

- [ ] **Step 42: Add named full/no-override/no-identity fixture variants**

Insert this complete fixture-variant function inside `candidate_tests`:

```rust
fn seeded_differential_fixture_variants(
    seed: u64,
) -> Vec<(&'static str, DifferentialFixture)> {
    let full = seeded_differential_fixture(seed);

    let mut no_overrides = seeded_differential_fixture(seed);
    no_overrides.overrides.clear();

    let mut no_identities = seeded_differential_fixture(seed);
    no_identities.identities.clear();

    vec![
        ("full", full),
        ("no-overrides", no_overrides),
        ("no-identities", no_identities),
    ]
}
```

- [ ] **Step 43: Strengthen the differential across every named fixture axis**

Replace `candidate_path_matches_eager_oracle_across_seeded_cross_product` with this complete test:

```rust
#[test]
fn candidate_path_matches_eager_oracle_across_seeded_cross_product() {
    let visibility_cases = differential_visibility_cases();
    let query_cases = differential_query_cases();
    let limits = differential_limits();
    let cursors = differential_cursors();
    let fixture_variant_names = ["full", "no-overrides", "no-identities"];
    let expected_cross_product = DIFFERENTIAL_SEEDS.len()
        * fixture_variant_names.len()
        * visibility_cases.len()
        * query_cases.len()
        * limits.len()
        * cursors.len();
    let mut comparisons = 0usize;

    for seed in DIFFERENTIAL_SEEDS {
        let variants = seeded_differential_fixture_variants(seed);
        let actual_variant_names = variants
            .iter()
            .map(|(name, _fixture)| *name)
            .collect::<Vec<_>>();
        assert_eq!(
            actual_variant_names.as_slice(),
            fixture_variant_names.as_slice()
        );
        for (variant, fixture) in variants {
            for (include_subagents, include_non_interactive, include_empty) in
                visibility_cases.iter().copied()
            {
                for (query_text, tier) in query_cases.iter().copied() {
                    for limit in limits.iter().copied() {
                        for cursor in cursors.iter().cloned() {
                            let query = DirQuery {
                                query: query_text.map(str::to_string),
                                tier,
                                limit: Some(limit),
                                cursor,
                                include_subagents,
                                include_non_interactive,
                                include_empty,
                            };
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
                            assert_eq!(
                                candidate, eager,
                                "seed={seed} variant={variant} query={query_text:?} tier={tier:?} limit={limit}"
                            );
                            assert_eq!(
                                serde_json::to_vec(&candidate).expect("candidate bytes"),
                                serde_json::to_vec(&eager).expect("eager bytes"),
                                "serialized seed={seed} variant={variant} query={query_text:?} tier={tier:?} limit={limit}",
                            );
                            comparisons += 1;
                        }
                    }
                }
            }
        }
    }

    let fixed_cases = fixed_deep_partial_cases();
    let expected_fixed = fixed_cases.len();
    for (fixture, query, label, expected_partial_reason) in fixed_cases {
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
        match expected_partial_reason {
            Some(reason) => {
                assert_eq!(candidate.get("partial"), Some(&json!(true)), "case={label}");
                assert_eq!(
                    candidate.get("partialReason"),
                    Some(&json!(reason)),
                    "case={label}",
                );
            }
            None => {
                assert!(candidate.get("partial").is_none(), "case={label}");
                assert!(candidate.get("partialReason").is_none(), "case={label}");
            }
        }
        comparisons += 1;
    }

    assert_eq!(comparisons, expected_cross_product + expected_fixed);
}
```

The named `full`, `no-overrides`, and `no-identities` fixtures cover both presence and absence axes; the full corpus includes delete/title/summary/archive/provider-title overrides, exact/providerless/known-session/fallback/collision identities, and metadata hit/empty/malformed/miss. The comparison total remains derived from array/vector lengths; do not replace it with a numeric literal.

- [ ] **Step 44: Run exact eager/candidate parsed and serialized parity**

Run:

```bash
FRESHELL_VITEST_BACKEND=local CARGO_TERM_COLOR=never cargo test --manifest-path /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/Cargo.toml -p freshell-server --bin freshell-server session_directory::page_bound_tests::candidate_tests::candidate_path_matches_eager_oracle_across_seeded_cross_product -- --exact --color=never --test-threads=1
```

Expected: exit 0; every named cross-product and fixed deep-partial case has equal `Value` and equal `serde_json::to_vec` bytes, and the fixed cases assert `io_error`, `budget`, `budget`, and exact omission of both partial fields respectively.

- [ ] **Step 45: Cut the real handler over to the narrow borrow scope**

Only after Steps 27-28's locked compiler gates, Step 29's candidate tests, and Step 44's parsed/serialized eager parity all pass, replace the eager body after successful query validation with this complete block:

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
                page["projectColors"] = Value::Object(project_colors);
            }
            Json(page).into_response()
        }
        Err(message) => (
            axum::http::StatusCode::BAD_REQUEST,
            Json(json!({ "error": message })),
        )
            .into_response(),
    }
```

This preserves auth/query early returns, accessor order and fixed-input semantics, invalid-cursor timing, explicit snapshot release, late whole-map project colors, and `Err(message)`. It intentionally does not preserve old interleaving windows between projection stages and later independent accessor reads; overlapping-write outcomes remain unspecified.

- [ ] **Step 46: Compile the real Axum handler immediately after cutover**

Run:

```bash
FRESHELL_VITEST_BACKEND=local CARGO_TERM_COLOR=never cargo check --locked --manifest-path /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/Cargo.toml -p freshell-server
```

Expected: exit 0. This is the load-bearing production proof for the real registered Axum handler, not a repeat of the old-handler pre-cutover check. Any failure stops before route tests or commit and permits only correction of the planned one-file borrowed design followed by complete rerun; it never authorizes a fallback, adapter, API/manifest change, or second source file.

- [ ] **Step 47: Compile all inline test-only coexistence code immediately after cutover**

Run:

```bash
FRESHELL_VITEST_BACKEND=local CARGO_TERM_COLOR=never cargo test --locked --manifest-path /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/Cargo.toml -p freshell-server --bin freshell-server --no-run
```

Expected: exit 0. This separately proves inline `#[cfg(test)]` coexistence against the cut-over handler. A failure has the same stop/correct-within-plan/reopen rule as Step 46 and occurs before route tests or commit.

- [ ] **Step 48: Rerun all candidate tests after handler cutover**

Run:

```bash
FRESHELL_VITEST_BACKEND=local CARGO_TERM_COLOR=never cargo test --manifest-path /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/Cargo.toml -p freshell-server --bin freshell-server session_directory::page_bound_tests::candidate_tests -- --color=never --test-threads=1
```

Expected: exit 0.

- [ ] **Step 49: Rerun all real-route characterizations after cutover**

Run:

```bash
FRESHELL_VITEST_BACKEND=local CARGO_TERM_COLOR=never cargo test --manifest-path /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/Cargo.toml -p freshell-server --bin freshell-server session_directory::page_bound_tests -- --color=never --test-threads=1
```

Expected: exit 0 with exact route behavior and bytes unchanged.

- [ ] **Step 50: Rerun the complete focused family after cutover**

Run:

```bash
FRESHELL_VITEST_BACKEND=local CARGO_TERM_COLOR=never cargo test --manifest-path /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/Cargo.toml -p freshell-server --bin freshell-server session_directory -- --color=never --test-threads=1
```

Expected: exit 0.

- [ ] **Step 51: Commit the green borrowed-path cutover**

The command below is one valid example for a coherent task-level source checkpoint; its subject and body are illustrative, not required history. If this task's mandatory spec/quality review or a later final check finds a defect, make any additional source-only correction commit needed and rerun the affected checks before advancing. Do not infer an exact commit count, subject sequence, or commit order from this example.

Run:

```bash
FRESHELL_VITEST_BACKEND=local bash -c 'git -C /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep diff --check -- crates/freshell-server/src/session_directory.rs && git -C /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep add -- crates/freshell-server/src/session_directory.rs && test "$(git -C /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep diff --cached --name-only)" = "crates/freshell-server/src/session_directory.rs" && git -C /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep commit -m "refactor(session-directory): add borrowed page derivation" -m "Normalize the captured corpus into borrowed candidates, prove exact eager parity, and route production through one shared order and eligibility policy." -m "Generated with Amplifier" -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"'
```

Expected: exit 0 and a normal local source-only commit.

### Task 5: Migrate retained tests while preserving the eager oracle

**Files:**
- Modify/test: `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/crates/freshell-server/src/session_directory.rs`.
- Read only: `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/test/fixtures/sessions/**`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/crates/freshell-sessions/src/directory_index.rs`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/crates/freshell-sessions/src/search.rs`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/crates/freshell-ws/src/identity.rs`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/crates/freshell-server/src/settings_store.rs`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/crates/freshell-server/src/session_metadata.rs`, and `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/crates/freshell-server/src/sessions_tests.rs` for the unchanged cross-router override assertion.

**Interfaces:**
- Consumes: Task 3's unchanged `fn encode_raw_cursor_payload(payload: &[u8]) -> String`, `fn write_nonmatching_claude_transcript(path: &Path)`, and `fn deep_search_query() -> DirQuery` helpers; Task 4's production `build_directory_candidates`, `resolve_indexed_overlay`, `derive_directory_page`, temporary unbounded selector/materializer, handler cutover, and temporary eager differential.
- Produces: all retained semantic assertions routed through `IndexedSession` and the production derivation while deliberately retaining, under test-only use, every eager helper, `derive_eager_oracle_page`, all 2,884-case differential support, the temporary legacy `DirItem` fields/materializer/serializer, and the unbounded non-deep selector. Task 6 consumes and removes that one oracle after proving the final selector; Task 5 adds no second oracle representation.

- [ ] **Step 1: Update the main test-module imports for indexed derivation**

At the top of the existing main `tests` module, replace its imports with this complete block and remove the later duplicate `ClaudeSource`/`SessionIndex`/`SessionSource` import:

```rust
    use super::*;
    use freshell_sessions::directory_index::{ClaudeSource, SessionIndex, SessionSource};
    use std::time::Duration;
```

This replacement intentionally removes Task 3's direct test-local `use base64::Engine as _;`. Task 4 retains `Engine as _` at the parent module scope, and this block's `use super::*;` imports that anonymous trait into `tests`, so the retained `encode_raw_cursor_payload` helper still resolves `URL_SAFE_NO_PAD.encode(...)`. Do not add a second direct trait import: after rustfmt places `use super::*;` first, Rust 1.96 reports the direct import as unused, which would fail Task 7's warnings-denied Clippy gates.

- [ ] **Step 2: Add the shared indexed-row fixture**

Add this complete helper after `default_query`:

```rust
    fn indexed_test_item(
        provider: &str,
        session_id: &str,
        last_activity_at: i64,
        title: Option<&str>,
    ) -> IndexedSession {
        IndexedSession {
            session_id: session_id.to_string(),
            provider: provider.to_string(),
            project_path: "/repo".to_string(),
            title: title.map(str::to_string),
            title_provider_generated: false,
            summary: None,
            first_user_message: None,
            title_source: None,
            last_activity_at,
            created_at: Some(last_activity_at),
            cwd: Some("/repo".to_string()),
            git_branch: None,
            is_subagent: false,
            is_non_interactive: false,
            source_file: None,
        }
    }
```

- [ ] **Step 3: Add the indexed Claude scan helper**

Add this complete helper after `default_query`:

```rust
    fn scan_indexed_claude_sessions(home: &Path) -> Vec<IndexedSession> {
        ClaudeSource::new(claude_home(home)).scan()
    }
```

- [ ] **Step 4: Add the shared production-derivation helper**

Add this complete helper after `default_query`:

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

- [ ] **Step 5: Replace `join_tests` with a candidate-test module shell**

Replace the complete eager `join_tests` module with this shell:

```rust
#[cfg(test)]
mod join_tests {
    use super::*;
    use freshell_ws::identity::TerminalIdentityRegistry;
}
```

- [ ] **Step 6: Add the join-test indexed-row fixture**

Insert this complete helper before the closing brace of `join_tests`:

```rust
    fn indexed_item(provider: &str, session_id: &str, last_activity_at: i64) -> IndexedSession {
        IndexedSession {
            session_id: session_id.to_string(),
            provider: provider.to_string(),
            project_path: "/repo".to_string(),
            title: Some("A real session".to_string()),
            title_provider_generated: false,
            summary: None,
            first_user_message: None,
            title_source: None,
            last_activity_at,
            created_at: Some(last_activity_at),
            cwd: Some("/repo".to_string()),
            git_branch: None,
            is_subagent: false,
            is_non_interactive: false,
            source_file: None,
        }
    }
```

- [ ] **Step 7: Add deterministic identity ordering for join tests**

Insert this complete helper before the closing brace of `join_tests`:

```rust
    fn ordered_identities(
        registry: &TerminalIdentityRegistry,
        terminal_ids: &[&str],
    ) -> Vec<TerminalIdentity> {
        terminal_ids
            .iter()
            .map(|terminal_id| registry.get(terminal_id).expect("identity"))
            .collect()
    }
```

- [ ] **Step 8: Add selected-candidate materialization for join tests**

Insert this complete helper before the closing brace of `join_tests`:

```rust
    fn materialized_rows(
        indexed: &[IndexedSession],
        identities: &[TerminalIdentity],
    ) -> Vec<DirItem> {
        let overrides = Map::new();
        let metadata = HashMap::new();
        build_directory_candidates(indexed, &overrides, identities)
            .into_iter()
            .map(|candidate| {
                materialize_selected_candidate(
                    SelectedCandidate {
                        candidate,
                        annotation: None,
                    },
                    &metadata,
                )
            })
            .collect()
    }
```

- [ ] **Step 9: Migrate `provider_display_name_matches_known_providers_and_falls_back_to_raw` to the candidate path**

Insert this complete retained test before the closing brace of `join_tests`:

```rust
    #[test]
    fn provider_display_name_matches_known_providers_and_falls_back_to_raw() {
        assert_eq!(provider_display_name("claude"), "Claude CLI");
        assert_eq!(provider_display_name("codex"), "Codex CLI");
        assert_eq!(provider_display_name("opencode"), "OpenCode");
        assert_eq!(provider_display_name("amplifier"), "amplifier");
    }
```

- [ ] **Step 10: Migrate `join_running_state_matches_live_terminal_and_sets_running_fields` to the candidate path**

Insert this complete retained test before the closing brace of `join_tests`:

```rust
    #[test]
    fn join_running_state_matches_live_terminal_and_sets_running_fields() {
        let registry = TerminalIdentityRegistry::new();
        registry.upsert("term-1", Some("claude"), Some("sess-1"), None, 1_000);
        let indexed = vec![indexed_item("claude", "sess-1", 500)];
        let rows = materialized_rows(&indexed, &registry.list());

        assert_eq!(rows.len(), 1);
        assert!(rows[0].is_running);
        assert_eq!(rows[0].running_terminal_id.as_deref(), Some("term-1"));
        assert_eq!(rows[0].last_activity_at, 500);
    }
```

- [ ] **Step 11: Migrate `join_running_state_no_match_leaves_not_running` to the candidate path**

Insert this complete retained test before the closing brace of `join_tests`:

```rust
    #[test]
    fn join_running_state_no_match_leaves_not_running() {
        let registry = TerminalIdentityRegistry::new();
        registry.upsert(
            "term-1",
            Some("claude"),
            Some("other-session"),
            None,
            1_000,
        );
        let indexed = vec![indexed_item("claude", "sess-1", 500)];
        let rows = materialized_rows(&indexed, &registry.list());

        let row = rows
            .iter()
            .find(|row| row.session_id == "sess-1")
            .expect("indexed row");
        assert!(!row.is_running);
        assert_eq!(row.running_terminal_id, None);
    }
```

- [ ] **Step 12: Migrate `build_live_terminal_session_item_none_without_a_provider` to the candidate path**

Insert this complete retained test before the closing brace of `join_tests`:

```rust
    #[test]
    fn build_live_terminal_session_item_none_without_a_provider() {
        let registry = TerminalIdentityRegistry::new();
        registry.upsert("term-1", None, None, None, 1_000);
        let identities = registry.list();
        let overrides = Map::new();
        let candidates = build_directory_candidates(&[], &overrides, &identities);

        assert!(candidates.is_empty());
    }
```

- [ ] **Step 13: Migrate `build_live_terminal_session_item_with_session_id_is_not_live_terminal_only` to the candidate path**

Insert this complete retained test before the closing brace of `join_tests`:

```rust
    #[test]
    fn build_live_terminal_session_item_with_session_id_is_not_live_terminal_only() {
        let registry = TerminalIdentityRegistry::new();
        registry.upsert(
            "term-9",
            Some("opencode"),
            Some("sess-77"),
            Some("/home/dan/project"),
            2_000,
        );
        let rows = materialized_rows(&[], &registry.list());
        let item = rows.first().expect("synthesized item");

        assert_eq!(item.provider, "opencode");
        assert_eq!(item.session_id, "sess-77");
        assert_eq!(item.project_path, "/home/dan/project");
        assert_eq!(item.title.as_deref(), Some("OpenCode"));
        assert_eq!(item.session_type.as_deref(), Some("opencode"));
        assert!(item.is_running);
        assert_eq!(item.running_terminal_id.as_deref(), Some("term-9"));
        assert!(!item.live_terminal_only);
        assert_eq!(item.last_activity_at, 2_000);
    }
```

- [ ] **Step 14: Migrate `live_terminal_item_mirrors_identity_subagent_flag` to the candidate path**

Insert this complete retained test before the closing brace of `join_tests`:

```rust
    #[test]
    fn live_terminal_item_mirrors_identity_subagent_flag() {
        let registry = TerminalIdentityRegistry::new();
        registry.upsert(
            "term-9",
            Some("opencode"),
            Some("sess-77"),
            Some("/home/dan/project"),
            2_000,
        );
        let mut identity = registry.get("term-9").expect("identity");
        identity.is_subagent = Some(true);
        let item = materialized_rows(&[], std::slice::from_ref(&identity))
            .into_iter()
            .next()
            .expect("item");
        assert!(item.is_subagent, "identity Some(true) must project");
        assert_eq!(item.to_value()["isSubagent"], json!(true));

        identity.is_subagent = None;
        let item = materialized_rows(&[], std::slice::from_ref(&identity))
            .into_iter()
            .next()
            .expect("item");
        assert!(!item.is_subagent, "unclassified stays non-subagent");
        assert!(item.to_value().get("isSubagent").is_none());
    }
```

- [ ] **Step 15: Migrate `build_live_terminal_session_item_without_session_id_is_live_terminal_only` to the candidate path**

Insert this complete retained test before the closing brace of `join_tests`:

```rust
    #[test]
    fn build_live_terminal_session_item_without_session_id_is_live_terminal_only() {
        let registry = TerminalIdentityRegistry::new();
        registry.upsert("term-5", Some("codex"), None, None, 3_000);
        let rows = materialized_rows(&[], &registry.list());
        let item = rows.first().expect("synthesized item");

        assert!(item.live_terminal_only);
        assert_eq!(item.session_id, "terminal:term-5");
        assert_eq!(item.project_path, "terminal:term-5");
        assert_eq!(item.title.as_deref(), Some("Codex CLI"));
    }
```

- [ ] **Step 16: Migrate `join_live_terminals_matched_session_yields_one_running_item` to the candidate path**

Insert this complete retained test before the closing brace of `join_tests`:

```rust
    #[test]
    fn join_live_terminals_matched_session_yields_one_running_item() {
        let registry = TerminalIdentityRegistry::new();
        registry.upsert("term-1", Some("claude"), Some("sess-1"), None, 1_000);
        let indexed = vec![indexed_item("claude", "sess-1", 500)];
        let rows = materialized_rows(&indexed, &registry.list());

        assert_eq!(rows.len(), 1);
        assert!(rows[0].is_running);
        assert_eq!(rows[0].running_terminal_id.as_deref(), Some("term-1"));
    }
```

- [ ] **Step 17: Migrate `join_live_terminals_unmatched_terminal_synthesizes_one_live_only_item` to the candidate path**

Insert this complete retained test before the closing brace of `join_tests`:

```rust
    #[test]
    fn join_live_terminals_unmatched_terminal_synthesizes_one_live_only_item() {
        let registry = TerminalIdentityRegistry::new();
        registry.upsert("term-2", Some("codex"), None, None, 4_000);
        let rows = materialized_rows(&[], &registry.list());

        assert_eq!(rows.len(), 1);
        assert!(rows[0].live_terminal_only);
        assert_eq!(rows[0].running_terminal_id.as_deref(), Some("term-2"));
    }
```

- [ ] **Step 18: Migrate `join_live_terminals_matched_terminal_is_never_double_emitted` to the candidate path**

Insert this complete retained test before the closing brace of `join_tests`:

```rust
    #[test]
    fn join_live_terminals_matched_terminal_is_never_double_emitted() {
        let registry = TerminalIdentityRegistry::new();
        registry.upsert("term-3", Some("claude"), Some("sess-3"), None, 1_000);
        let indexed = vec![indexed_item("claude", "sess-3", 500)];
        let rows = materialized_rows(&indexed, &registry.list());

        assert_eq!(rows.len(), 1, "no duplicate for a matched terminal");
    }
```

- [ ] **Step 19: Migrate `codex_fresh_terminal_pre_adoption_duplicate_is_transient_pending_locator_adoption` to the candidate path**

Insert this complete retained test before the closing brace of `join_tests`:

```rust
    #[test]
    fn codex_fresh_terminal_pre_adoption_duplicate_is_transient_pending_locator_adoption() {
        let registry = TerminalIdentityRegistry::new();
        registry.upsert("term-codex", Some("codex"), None, None, 5_000);
        let indexed = vec![indexed_item(
            "codex",
            "real-codex-session-id",
            4_500,
        )];
        let rows = materialized_rows(&indexed, &registry.list());

        assert_eq!(
            rows.len(),
            2,
            "pre-adoption: unassociated codex terminal and its session file do not merge yet"
        );
    }
```

- [ ] **Step 20: Migrate `supplied_identity_vector_preserves_first_exact_and_synthesized_winners` to the candidate path**

Insert this complete retained test before the closing brace of `join_tests`:

```rust
    #[test]
    fn supplied_identity_vector_preserves_first_exact_and_synthesized_winners() {
        let registry = TerminalIdentityRegistry::new();
        registry.upsert(
            "exact-first",
            Some("claude"),
            Some("indexed"),
            Some("/first"),
            7_000,
        );
        registry.upsert(
            "exact-second",
            Some("claude"),
            Some("indexed"),
            Some("/second"),
            7_001,
        );
        registry.upsert(
            "synth-first",
            Some("x"),
            Some("y:z"),
            Some("/synth-first"),
            7_002,
        );
        registry.upsert(
            "synth-second",
            Some("x:y"),
            Some("z"),
            Some("/synth-second"),
            7_003,
        );
        let identities = ordered_identities(
            &registry,
            &["exact-first", "exact-second", "synth-first", "synth-second"],
        );
        let indexed = vec![indexed_item("claude", "indexed", 500)];
        let rows = materialized_rows(&indexed, &identities);

        let indexed_row = rows
            .iter()
            .find(|row| row.provider == "claude" && row.session_id == "indexed")
            .expect("indexed row");
        assert_eq!(
            indexed_row.running_terminal_id.as_deref(),
            Some("exact-first")
        );
        let collision_rows = rows
            .iter()
            .filter(|row| format!("{}:{}", row.provider, row.session_id) == "x:y:z")
            .collect::<Vec<_>>();
        assert_eq!(collision_rows.len(), 1);
        assert_eq!(
            collision_rows[0].running_terminal_id.as_deref(),
            Some("synth-first")
        );
    }
```

The replacement retains all eleven original test names and adds the supplied-vector winner test. Exact booleans, terminal IDs, synthesized IDs/paths/titles/types, subagent wire emission, dedupe, pre-adoption two-row behavior, and first-winner assertions remain.

- [ ] **Step 21: Migrate `default_query_hides_non_interactive_fixtures` to indexed derivation**

Replace the existing test with this complete test inside the main `tests` module:

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
        assert_eq!(page["items"].as_array().expect("items").len(), 0);
        assert_eq!(page["nextCursor"], Value::Null);
        assert_eq!(page["revision"], json!(1_769_753_759_234i64));
        std::fs::remove_dir_all(&home).ok();
    }
```

- [ ] **Step 22: Migrate `include_non_interactive_surfaces_titled_session` to indexed derivation**

Replace the existing test with this complete test inside the main `tests` module:

```rust
    #[test]
    fn include_non_interactive_surfaces_titled_session() {
        let home = claude_home_with(&["real-corrupted.jsonl", "healthy.jsonl"]);
        let indexed = scan_indexed_claude_sessions(&home);
        let query = DirQuery {
            include_non_interactive: true,
            ..DirQuery::default()
        };
        let page = derive_test_page(&indexed, &Map::new(), &[], &query);
        let items = page["items"].as_array().expect("items");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["title"], json!("Test Session 1"));
        assert_eq!(items[0]["provider"], json!("claude"));
        std::fs::remove_dir_all(&home).ok();
    }
```

- [ ] **Step 23: Migrate `include_empty_surfaces_untitled_sessions_sorted_desc` to indexed derivation**

Replace the existing test with this complete test inside the main `tests` module:

```rust
    #[test]
    fn include_empty_surfaces_untitled_sessions_sorted_desc() {
        let home = claude_home_with(&["real-corrupted.jsonl", "healthy.jsonl"]);
        let indexed = scan_indexed_claude_sessions(&home);
        let query = DirQuery {
            include_non_interactive: true,
            include_empty: true,
            ..DirQuery::default()
        };
        let page = derive_test_page(&indexed, &Map::new(), &[], &query);
        let items = page["items"].as_array().expect("items");
        assert_eq!(items.len(), 1);
        assert_eq!(
            items[0]["sessionId"],
            json!("b7936c10-4935-441c-837c-c1f33cafec2d")
        );
        std::fs::remove_dir_all(&home).ok();
    }
```

- [ ] **Step 24: Migrate `r10b_cwdless_repair_fixture_never_surfaces_under_any_flags` to indexed derivation**

Replace the existing test with this complete test inside the main `tests` module:

```rust
    #[test]
    fn r10b_cwdless_repair_fixture_never_surfaces_under_any_flags() {
        let home = std::env::temp_dir().join(format!(
            "freshell-r10b-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let project = home.join(".claude").join("projects").join("-home-qa-demo");
        std::fs::create_dir_all(&project).expect("project dir");
        let content = std::fs::read_to_string(fixtures_dir().join("healthy.jsonl"))
            .expect("fixture");
        std::fs::write(
            project.join("11111111-1111-4111-8111-111111111111.jsonl"),
            content,
        )
        .expect("seed fixture");

        let indexed = scan_indexed_claude_sessions(&home);
        assert!(indexed.is_empty(), "a cwd-less session must never be indexed");
        let query = DirQuery {
            include_subagents: true,
            include_non_interactive: true,
            include_empty: true,
            ..DirQuery::default()
        };
        let page = derive_test_page(&indexed, &Map::new(), &[], &query);
        assert_eq!(page["items"].as_array().expect("items").len(), 0);
        assert_eq!(page["revision"], json!(0));
        std::fs::remove_dir_all(&home).ok();
    }
```

- [ ] **Step 25: Migrate `title_search_matches_and_annotates` to indexed derivation**

Replace the existing test with this complete test inside the main `tests` module:

```rust
    #[test]
    fn title_search_matches_and_annotates() {
        let home = claude_home_with(&["real-corrupted.jsonl"]);
        let indexed = scan_indexed_claude_sessions(&home);
        let hit_query = DirQuery {
            include_non_interactive: true,
            query: Some("session 1".to_string()),
            ..DirQuery::default()
        };
        let page = derive_test_page(&indexed, &Map::new(), &[], &hit_query);
        let items = page["items"].as_array().expect("items");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["matchedIn"], json!("title"));
        assert_eq!(items[0]["snippet"], json!("Test Session 1"));

        let miss_query = DirQuery {
            include_non_interactive: true,
            query: Some("zzz-not-present".to_string()),
            ..DirQuery::default()
        };
        let miss_page = derive_test_page(&indexed, &Map::new(), &[], &miss_query);
        assert!(miss_page["items"].as_array().expect("items").is_empty());
        std::fs::remove_dir_all(&home).ok();
    }
```

- [ ] **Step 26: Migrate `cursor_paging_splits_and_round_trips` to indexed derivation**

Replace the existing test with this complete test inside the main `tests` module:

```rust
    #[test]
    fn cursor_paging_splits_and_round_trips() {
        let indexed = vec![
            indexed_test_item("claude", "a", 100, Some("t-a")),
            indexed_test_item("claude", "b", 200, Some("t-b")),
        ];
        let first_query = DirQuery {
            limit: Some(1),
            ..DirQuery::default()
        };
        let first_page = derive_test_page(&indexed, &Map::new(), &[], &first_query);
        let first_items = first_page["items"].as_array().expect("items");
        assert_eq!(first_items.len(), 1);
        assert_eq!(first_items[0]["sessionId"], json!("b"));
        let cursor = first_page["nextCursor"]
            .as_str()
            .expect("next cursor")
            .to_string();

        let second_query = DirQuery {
            limit: Some(1),
            cursor: Some(cursor),
            ..DirQuery::default()
        };
        let second_page = derive_test_page(&indexed, &Map::new(), &[], &second_query);
        let second_items = second_page["items"].as_array().expect("items");
        assert_eq!(second_items.len(), 1);
        assert_eq!(second_items[0]["sessionId"], json!("a"));
        assert_eq!(second_page["nextCursor"], Value::Null);
    }
```

- [ ] **Step 27: Migrate `invalid_cursor_is_rejected` to indexed derivation**

Replace the existing test with this complete test inside the main `tests` module:

```rust
    #[test]
    fn invalid_cursor_is_rejected() {
        let cases = [
            ("invalid base64", "!!!not-base64!!!".to_string()),
            (
                "valid base64 with invalid JSON",
                encode_raw_cursor_payload(b"not-json"),
            ),
            ("JSON null", encode_raw_cursor_payload(b"null")),
            ("JSON array", encode_raw_cursor_payload(b"[]")),
            ("JSON object missing both fields", encode_raw_cursor_payload(b"{}")),
            (
                "missing key",
                encode_raw_cursor_payload(br#"{"lastActivityAt":1}"#),
            ),
            (
                "missing lastActivityAt",
                encode_raw_cursor_payload(br#"{"key":"claude:s1"}"#),
            ),
            (
                "string lastActivityAt",
                encode_raw_cursor_payload(
                    br#"{"lastActivityAt":"1","key":"claude:s1"}"#,
                ),
            ),
            (
                "fractional lastActivityAt",
                encode_raw_cursor_payload(
                    br#"{"lastActivityAt":1.5,"key":"claude:s1"}"#,
                ),
            ),
            (
                "out-of-i64 lastActivityAt",
                encode_raw_cursor_payload(
                    br#"{"lastActivityAt":18446744073709551615,"key":"claude:s1"}"#,
                ),
            ),
            (
                "non-string key",
                encode_raw_cursor_payload(br#"{"lastActivityAt":1,"key":1}"#),
            ),
            ("empty key", encode_cursor(1, "")),
        ];
        let indexed = Vec::new();
        let overrides = Map::new();
        let metadata = HashMap::new();
        let identities = Vec::new();

        for (label, cursor) in cases {
            let query = DirQuery {
                cursor: Some(cursor),
                ..DirQuery::default()
            };
            let error = derive_directory_page(
                DirectoryInputs {
                    indexed: &indexed,
                    overrides: &overrides,
                    metadata: &metadata,
                    identities: &identities,
                },
                &query,
            )
            .expect_err(label);
            assert_eq!(error, "Invalid session-directory cursor", "case={label}");
        }
    }
```

- [ ] **Step 28: Migrate `cursor_with_required_fields_and_extra_json_field_remains_accepted` to indexed derivation**

Replace the existing test with this complete test inside the main `tests` module:

```rust
    #[test]
    fn cursor_with_required_fields_and_extra_json_field_remains_accepted() {
        let cursor = encode_raw_cursor_payload(
            br#"{"lastActivityAt":7,"key":"claude:session","extra":true}"#,
        );
        let decoded = decode_cursor(&cursor).expect("extra field is ignored");
        assert_eq!(decoded.last_activity_at, 7);
        assert_eq!(decoded.key, "claude:session");
    }
```

- [ ] **Step 29: Migrate `badcursor_still_400s_with_original_message_r9_parity_untouched` to indexed derivation**

Replace the existing test with this complete test inside the main `tests` module:

```rust
    #[test]
    fn badcursor_still_400s_with_original_message_r9_parity_untouched() {
        let query = validate_query(&q(&[
            ("priority", "visible"),
            ("cursor", "!!!not-base64!!!"),
        ]))
        .expect("query shape");
        let indexed = Vec::new();
        let overrides = Map::new();
        let metadata = HashMap::new();
        let identities = Vec::new();
        let error = derive_directory_page(
            DirectoryInputs {
                indexed: &indexed,
                overrides: &overrides,
                metadata: &metadata,
                identities: &identities,
            },
            &query,
        )
        .expect_err("bad cursor");
        assert_eq!(error, "Invalid session-directory cursor");
    }
```

These replacements keep the fixture-specific item counts, IDs, titles, providers, null cursors, revisions, no-match result, newest-first cursor round trip, exact invalid-cursor text, and unchanged bad-cursor validation path.

- [ ] **Step 30: Add the provider-title guard row fixture**

Insert this complete helper inside the main `tests` module:

```rust
    fn guard_row(session_id: &str, title_source: Option<&str>) -> IndexedSession {
        let mut row = indexed_test_item(
            "amplifier",
            session_id,
            100,
            Some("Provider Title"),
        );
        row.title_source = title_source.map(str::to_string);
        row
    }
```

- [ ] **Step 31: Add the resolved-overlay title helper**

Insert this complete helper inside the main `tests` module:

```rust
    fn resolved_title(row: &IndexedSession, override_row: Value) -> Option<String> {
        resolve_indexed_overlay(row, Some(&override_row))
            .expect("surviving overlay")
            .effective_title
            .map(str::to_string)
    }
```

- [ ] **Step 32: Migrate `overrides_overlay_applies_title_summary_archived_and_filters_deleted` to overlay/candidate derivation**

Replace the existing test with this complete test inside the main `tests` module:

```rust
    #[test]
    fn overrides_overlay_applies_title_summary_archived_and_filters_deleted() {
        let mut keep = indexed_test_item("claude", "keep", 100, Some("parsed"));
        keep.summary = Some("parsed-sum".to_string());
        let gone = indexed_test_item("claude", "gone", 90, Some("parsed"));
        let indexed = vec![keep, gone];
        let overrides = Map::from_iter([
            (
                "claude:keep".to_string(),
                json!({
                    "titleOverride": "Renamed",
                    "summaryOverride": "New sum",
                    "archived": true
                }),
            ),
            ("claude:gone".to_string(), json!({"deleted": true})),
        ]);

        let page = derive_test_page(&indexed, &overrides, &[], &default_query());
        let items = page["items"].as_array().expect("items");
        assert_eq!(items.len(), 1, "deleted item filtered out");
        assert_eq!(items[0]["sessionId"], json!("keep"));
        assert_eq!(items[0]["title"], json!("Renamed"));
        assert_eq!(items[0]["summary"], json!("New sum"));
        assert_eq!(items[0]["archived"], json!(true));
    }
```

- [ ] **Step 33: Migrate `overlay_shape_unchanged_when_no_overrides_archived_always_present` to overlay/candidate derivation**

Replace the existing test with this complete test inside the main `tests` module:

```rust
    #[test]
    fn overlay_shape_unchanged_when_no_overrides_archived_always_present() {
        let indexed = vec![indexed_test_item("claude", "x", 1, Some("t"))];
        let page = derive_test_page(&indexed, &Map::new(), &[], &default_query());
        let item = &page["items"][0];
        assert_eq!(item["archived"], json!(false));
        assert_eq!(item["title"], json!("t"));
    }
```

- [ ] **Step 34: Migrate `provider_generated_session_suppresses_dir_override_row` to overlay/candidate derivation**

Replace the existing test with this complete test inside the main `tests` module:

```rust
    #[test]
    fn provider_generated_session_suppresses_dir_override_row() {
        let row = guard_row("s1", Some("provider-generated"));
        let title = resolved_title(
            &row,
            json!({"titleOverride": "proj", "titleSource": "dir"}),
        );
        assert_eq!(title.as_deref(), Some("Provider Title"));
    }
```

- [ ] **Step 35: Migrate `provider_generated_session_suppresses_first_message_override_row` to overlay/candidate derivation**

Replace the existing test with this complete test inside the main `tests` module:

```rust
    #[test]
    fn provider_generated_session_suppresses_first_message_override_row() {
        let row = guard_row("s1", Some("provider-generated"));
        let title = resolved_title(
            &row,
            json!({
                "titleOverride": "Fix the flux",
                "titleSource": "first-message"
            }),
        );
        assert_eq!(title.as_deref(), Some("Provider Title"));
    }
```

- [ ] **Step 36: Migrate `provider_generated_session_still_applies_ai_override_row` to overlay/candidate derivation**

Replace the existing test with this complete test inside the main `tests` module:

```rust
    #[test]
    fn provider_generated_session_still_applies_ai_override_row() {
        let row = guard_row("s1", Some("provider-generated"));
        let title = resolved_title(
            &row,
            json!({"titleOverride": "AI Title", "titleSource": "ai"}),
        );
        assert_eq!(title.as_deref(), Some("AI Title"));
    }
```

- [ ] **Step 37: Migrate `provider_generated_session_still_applies_user_override_row` to overlay/candidate derivation**

Replace the existing test with this complete test inside the main `tests` module:

```rust
    #[test]
    fn provider_generated_session_still_applies_user_override_row() {
        let row = guard_row("s1", Some("provider-generated"));
        let title = resolved_title(
            &row,
            json!({"titleOverride": "My Rename", "titleSource": "user"}),
        );
        assert_eq!(title.as_deref(), Some("My Rename"));
    }
```

- [ ] **Step 38: Migrate `provider_generated_session_still_applies_absent_source_override_row` to overlay/candidate derivation**

Replace the existing test with this complete test inside the main `tests` module:

```rust
    #[test]
    fn provider_generated_session_still_applies_absent_source_override_row() {
        let row = guard_row("s1", Some("provider-generated"));
        let title = resolved_title(&row, json!({"titleOverride": "Legacy Rename"}));
        assert_eq!(title.as_deref(), Some("Legacy Rename"));
    }
```

- [ ] **Step 39: Migrate `empty_string_title_override_never_applies` to overlay/candidate derivation**

Replace the existing test with this complete test inside the main `tests` module:

```rust
    #[test]
    fn empty_string_title_override_never_applies() {
        let provider_generated = guard_row("s1", Some("provider-generated"));
        let generated_title = resolved_title(
            &provider_generated,
            json!({"titleOverride": "", "titleSource": "user"}),
        );
        assert_eq!(generated_title.as_deref(), Some("Provider Title"));

        let plain = guard_row("s2", None);
        let plain_title = resolved_title(&plain, json!({"titleOverride": ""}));
        assert_eq!(plain_title.as_deref(), Some("Provider Title"));
    }
```

- [ ] **Step 40: Migrate `non_provider_generated_session_still_applies_dir_override_row` to overlay/candidate derivation**

Replace the existing test with this complete test inside the main `tests` module:

```rust
    #[test]
    fn non_provider_generated_session_still_applies_dir_override_row() {
        let row = guard_row("s1", None);
        let title = resolved_title(
            &row,
            json!({"titleOverride": "proj", "titleSource": "dir"}),
        );
        assert_eq!(title.as_deref(), Some("proj"));
    }
```

- [ ] **Step 41: Migrate `suppressed_title_row_still_overlays_summary_and_archived` to overlay/candidate derivation**

Replace the existing test with this complete test inside the main `tests` module:

```rust
    #[test]
    fn suppressed_title_row_still_overlays_summary_and_archived() {
        let row = guard_row("s1", Some("provider-generated"));
        let override_row = json!({
            "titleOverride": "proj",
            "titleSource": "dir",
            "summaryOverride": "sum",
            "archived": true
        });
        let overlay = resolve_indexed_overlay(&row, Some(&override_row)).expect("overlay");
        assert_eq!(overlay.effective_title, Some("Provider Title"));
        assert_eq!(overlay.effective_summary, Some("sum"));
        assert!(overlay.archived);
    }
```

- [ ] **Step 42: Migrate `title_tier_search_matches_a_renamed_sessions_override_title` to overlay/candidate derivation**

Replace the existing test with this complete test inside the main `tests` module:

```rust
    #[test]
    fn title_tier_search_matches_a_renamed_sessions_override_title() {
        let indexed = vec![indexed_test_item(
            "claude",
            "s1",
            100,
            Some("original parsed title"),
        )];
        let overrides = Map::from_iter([(
            "claude:s1".to_string(),
            json!({"titleOverride": "My Renamed Special Project"}),
        )]);
        let query = DirQuery {
            query: Some("Renamed Special".to_string()),
            ..DirQuery::default()
        };

        let page = derive_test_page(&indexed, &overrides, &[], &query);
        let items = page["items"].as_array().expect("items");
        assert_eq!(items.len(), 1, "search must match the override title");
        assert_eq!(items[0]["title"], json!("My Renamed Special Project"));
        assert_eq!(items[0]["matchedIn"], json!("title"));
    }
```

Every prior title-source case remains named and asserted: `dir`/`first-message` suppression only for provider-generated rows; `ai`, `user`, absent source, and non-provider-generated acceptance; empty-title fallback; summary/archive despite title suppression; deletion; exact `archived:false`; and renamed-title search annotation.

- [ ] **Step 43: Add the indexed deep-search row fixture**

Insert this complete helper inside the main `tests` module:

```rust
    fn deep_search_indexed_row(
        session_id: &str,
        last_activity_at: i64,
        source_file: Option<PathBuf>,
    ) -> IndexedSession {
        let mut row = indexed_test_item(
            "claude",
            session_id,
            last_activity_at,
            Some("visible"),
        );
        row.source_file = source_file;
        row
    }
```

- [ ] **Step 44: Reuse the Task 3 deep-search helpers without redefining them**

Make no source edit in this step. Confirm the migrated tests continue to call the two existing Task 3 helpers with the exact signatures listed in this Task's **Consumes** interface. Do not paste either helper into the Rust module, rename it, wrap it, or add a second definition.

- [ ] **Step 45: Migrate `tier_user_messages_matches_only_the_user_turn` to `IndexedSession.source_file`**

Replace the existing test with this complete test inside the main `tests` module:

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

        let user_query = DirQuery {
            include_non_interactive: true,
            tier: Tier::UserMessages,
            query: Some("unique-search-term-alpha".to_string()),
            ..DirQuery::default()
        };
        let page = derive_test_page(&indexed, &Map::new(), &[], &user_query);
        let items = page["items"].as_array().expect("items");
        assert_eq!(items.len(), 1, "userMessages tier must match the user turn");
        assert_eq!(items[0]["matchedIn"], json!("userMessage"));
        assert_eq!(items[0]["snippet"], json!("unique-search-term-alpha"));

        let assistant_query = DirQuery {
            include_non_interactive: true,
            tier: Tier::UserMessages,
            query: Some("assistant-only".to_string()),
            ..DirQuery::default()
        };
        let assistant_page =
            derive_test_page(&indexed, &Map::new(), &[], &assistant_query);
        assert!(
            assistant_page["items"]
                .as_array()
                .expect("items")
                .is_empty(),
            "userMessages tier must never match assistant-only text"
        );
        std::fs::remove_dir_all(&home).ok();
    }
```

- [ ] **Step 46: Migrate `tier_full_text_matches_assistant_turn_too` to `IndexedSession.source_file`**

Replace the existing test with this complete test inside the main `tests` module:

```rust
    #[test]
    fn tier_full_text_matches_assistant_turn_too() {
        let home = synthetic_claude_home_with_turns(
            "bbbbbbbb-0000-4000-8000-000000000002",
            "hello there",
            "unique-fulltext-only-phrase",
        );
        let indexed = scan_indexed_claude_sessions(&home);
        let query = DirQuery {
            include_non_interactive: true,
            tier: Tier::FullText,
            query: Some("unique-fulltext-only-phrase".to_string()),
            ..DirQuery::default()
        };
        let page = derive_test_page(&indexed, &Map::new(), &[], &query);
        let items = page["items"].as_array().expect("items");
        assert_eq!(items.len(), 1, "fullText tier must match assistant text");
        assert_eq!(items[0]["matchedIn"], json!("assistantMessage"));
        std::fs::remove_dir_all(&home).ok();
    }
```

- [ ] **Step 47: Migrate `tier_search_is_case_insensitive` to `IndexedSession.source_file`**

Replace the existing test with this complete test inside the main `tests` module:

```rust
    #[test]
    fn tier_search_is_case_insensitive() {
        let home = synthetic_claude_home_with_turns(
            "bbbbbbbb-0000-4000-8000-000000000003",
            "MixedCase NeedleValue Here",
            "irrelevant",
        );
        let indexed = scan_indexed_claude_sessions(&home);
        let query = DirQuery {
            include_non_interactive: true,
            tier: Tier::UserMessages,
            query: Some("needlevalue".to_string()),
            ..DirQuery::default()
        };
        let page = derive_test_page(&indexed, &Map::new(), &[], &query);
        assert_eq!(page["items"].as_array().expect("items").len(), 1);
        std::fs::remove_dir_all(&home).ok();
    }
```

- [ ] **Step 48: Migrate `tier_search_empty_no_match_returns_empty_items_without_partial` to `IndexedSession.source_file`**

Replace the existing test with this complete test inside the main `tests` module:

```rust
    #[test]
    fn tier_search_empty_no_match_returns_empty_items_without_partial() {
        let home = synthetic_claude_home_with_turns(
            "bbbbbbbb-0000-4000-8000-000000000004",
            "nothing relevant here at all",
            "still nothing relevant",
        );
        let indexed = scan_indexed_claude_sessions(&home);
        let query = DirQuery {
            include_non_interactive: true,
            tier: Tier::FullText,
            query: Some("zzz-absent-query-text".to_string()),
            ..DirQuery::default()
        };
        let page = derive_test_page(&indexed, &Map::new(), &[], &query);
        assert!(page["items"].as_array().expect("items").is_empty());
        assert_eq!(page["nextCursor"], Value::Null);
        assert!(
            page.get("partial").is_none(),
            "an exhausted, non-budget-limited scan must not report partial"
        );
        std::fs::remove_dir_all(&home).ok();
    }
```

- [ ] **Step 49: Migrate `tier_search_combined_with_cursor_pagination` to `IndexedSession.source_file`**

Replace the existing test with this complete test inside the main `tests` module:

```rust
    #[test]
    fn tier_search_combined_with_cursor_pagination() {
        let home = std::env::temp_dir().join(format!(
            "freshell-s07-page-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let project = home.join(".claude").join("projects").join("-home-dan-proj");
        std::fs::create_dir_all(&project).expect("project dir");
        for (session_id, timestamp) in [
            (
                "cccccccc-0000-4000-8000-000000000001",
                "2026-01-30T06:10:00.000Z",
            ),
            (
                "cccccccc-0000-4000-8000-000000000002",
                "2026-01-30T06:20:00.000Z",
            ),
            (
                "cccccccc-0000-4000-8000-000000000003",
                "2026-01-30T06:30:00.000Z",
            ),
        ] {
            let content = format!(
                "{{\"parentUuid\":null,\"cwd\":\"/home/dan/proj\",\"sessionId\":\"{session_id}\",\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":\"paginated-search-term\"}},\"uuid\":\"{session_id}-u001\",\"timestamp\":\"{timestamp}\"}}\n\
                 {{\"parentUuid\":\"{session_id}-u001\",\"cwd\":\"/home/dan/proj\",\"sessionId\":\"{session_id}\",\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":\"second turn\"}},\"uuid\":\"{session_id}-u002\",\"timestamp\":\"{timestamp}\"}}\n"
            );
            std::fs::write(project.join(format!("{session_id}.jsonl")), content)
                .expect("session file");
        }
        let indexed = scan_indexed_claude_sessions(&home);
        let mut seen = Vec::new();
        let mut cursor = None;
        for _page_number in 0..3 {
            let query = DirQuery {
                include_non_interactive: true,
                tier: Tier::UserMessages,
                query: Some("paginated-search-term".to_string()),
                limit: Some(1),
                cursor: cursor.clone(),
                ..DirQuery::default()
            };
            let page = derive_test_page(&indexed, &Map::new(), &[], &query);
            let items = page["items"].as_array().expect("items");
            assert_eq!(items.len(), 1, "each page must have exactly one item");
            seen.push(
                items[0]["sessionId"]
                    .as_str()
                    .expect("sessionId")
                    .to_string(),
            );
            cursor = page["nextCursor"].as_str().map(str::to_string);
        }
        assert_eq!(cursor, None, "the third page must be the last");
        assert_eq!(
            seen,
            vec![
                "cccccccc-0000-4000-8000-000000000003",
                "cccccccc-0000-4000-8000-000000000002",
                "cccccccc-0000-4000-8000-000000000001",
            ]
        );
        std::fs::remove_dir_all(&home).ok();
    }
```

- [ ] **Step 50: Migrate `tier_search_reports_partial_budget_when_scan_budget_exceeded` to `IndexedSession.source_file`**

Replace the existing test with this complete test inside the main `tests` module:

```rust
    #[test]
    fn tier_search_reports_partial_budget_when_scan_budget_exceeded() {
        let home = std::env::temp_dir().join(format!(
            "freshell-s07-budget-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let project = home.join(".claude").join("projects").join("-home-dan-proj");
        std::fs::create_dir_all(&project).expect("project dir");
        for index in 0..11u32 {
            let session_id = format!("dddddddd-0000-4000-8000-{index:012}");
            let content = format!(
                "{{\"parentUuid\":null,\"cwd\":\"/home/dan/proj\",\"sessionId\":\"{session_id}\",\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":\"no match here\"}},\"uuid\":\"{session_id}-u001\",\"timestamp\":\"2026-01-30T06:{index:02}:00.000Z\"}}\n\
                 {{\"parentUuid\":\"{session_id}-u001\",\"cwd\":\"/home/dan/proj\",\"sessionId\":\"{session_id}\",\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":\"second turn\"}},\"uuid\":\"{session_id}-u002\",\"timestamp\":\"2026-01-30T06:{index:02}:30.000Z\"}}\n"
            );
            std::fs::write(project.join(format!("{session_id}.jsonl")), content)
                .expect("session file");
        }
        let indexed = scan_indexed_claude_sessions(&home);
        assert_eq!(indexed.len(), 11);
        let query = DirQuery {
            include_non_interactive: true,
            tier: Tier::UserMessages,
            query: Some("zzz-never-present".to_string()),
            limit: Some(1),
            ..DirQuery::default()
        };
        let page = derive_test_page(&indexed, &Map::new(), &[], &query);
        assert!(page["items"].as_array().expect("items").is_empty());
        assert_eq!(page["partial"], json!(true));
        assert_eq!(page["partialReason"], json!("budget"));
        std::fs::remove_dir_all(&home).ok();
    }
```

- [ ] **Step 51: Migrate `tier_search_reports_io_error_for_missing_source_file` to `IndexedSession.source_file`**

Replace the existing test with this complete test inside the main `tests` module:

```rust
    #[test]
    fn tier_search_reports_io_error_for_missing_source_file() {
        let home = tempfile::tempdir().expect("tempdir");
        let indexed = vec![deep_search_indexed_row(
            "missing",
            100,
            Some(home.path().join("missing.jsonl")),
        )];
        let page = derive_test_page(&indexed, &Map::new(), &[], &deep_search_query());
        assert!(page["items"].as_array().expect("items").is_empty());
        assert_eq!(page["nextCursor"], Value::Null);
        assert_eq!(page["revision"], json!(100));
        assert_eq!(page["partial"], json!(true));
        assert_eq!(page["partialReason"], json!("io_error"));
    }
```

- [ ] **Step 52: Migrate `tier_search_budget_overwrites_prior_io_error` to `IndexedSession.source_file`**

Replace the existing test with this complete test inside the main `tests` module:

```rust
    #[test]
    fn tier_search_budget_overwrites_prior_io_error() {
        let home = tempfile::tempdir().expect("tempdir");
        let mut indexed = vec![deep_search_indexed_row(
            "missing",
            1_000,
            Some(home.path().join("missing.jsonl")),
        )];
        for index in 0..9 {
            let path = home.path().join(format!("valid-{index}.jsonl"));
            write_nonmatching_claude_transcript(&path);
            indexed.push(deep_search_indexed_row(
                &format!("valid-{index}"),
                999 - index as i64,
                Some(path),
            ));
        }
        let tail = home.path().join("eligible-tail.jsonl");
        write_nonmatching_claude_transcript(&tail);
        indexed.push(deep_search_indexed_row("eligible-tail", 900, Some(tail)));

        let page = derive_test_page(&indexed, &Map::new(), &[], &deep_search_query());
        assert!(page["items"].as_array().expect("items").is_empty());
        assert_eq!(page["nextCursor"], Value::Null);
        assert_eq!(page["revision"], json!(1_000));
        assert_eq!(page["partial"], json!(true));
        assert_eq!(page["partialReason"], json!("budget"));
    }
```

- [ ] **Step 53: Migrate `tier_search_budget_is_checked_before_no_source_tail` to `IndexedSession.source_file`**

Replace the existing test with this complete test inside the main `tests` module:

```rust
    #[test]
    fn tier_search_budget_is_checked_before_no_source_tail() {
        let home = tempfile::tempdir().expect("tempdir");
        let mut indexed = Vec::new();
        for index in 0..10 {
            let path = home.path().join(format!("valid-{index}.jsonl"));
            write_nonmatching_claude_transcript(&path);
            indexed.push(deep_search_indexed_row(
                &format!("valid-{index}"),
                1_000 - index as i64,
                Some(path),
            ));
        }
        indexed.push(deep_search_indexed_row("no-source-tail", 900, None));

        let page = derive_test_page(&indexed, &Map::new(), &[], &deep_search_query());
        assert!(page["items"].as_array().expect("items").is_empty());
        assert_eq!(page["nextCursor"], Value::Null);
        assert_eq!(page["revision"], json!(1_000));
        assert_eq!(page["partial"], json!(true));
        assert_eq!(page["partialReason"], json!("budget"));
    }
```

The replacements retain user-only role scoping, full-text assistant matching, case-insensitivity, exhausted no-match omission of `partial`, cursor pagination order, scan-budget partial state, missing-file `io_error`, later-budget precedence, and budget-before-no-source order. Both budget-order tests keep empty items, `partial=true`, and `partialReason="budget"`.

- [ ] **Step 54: Migrate the duplicate tuple and supplied-vector tests in `page_bound_tests`**

Delete `legacy_duplicate_items` and replace the duplicate test with:

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
        assert!(one_page["nextCursor"].is_null());
        assert_eq!(one_page["revision"], json!(500));

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
        assert_eq!(first_page["items"][0]["title"], json!("first"));
        let cursor = first_page["nextCursor"]
            .as_str()
            .expect("duplicate cursor")
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
        assert_eq!(second_page["revision"], json!(500));
    }
```

The replacement `join_tests::supplied_identity_vector_preserves_first_exact_and_synthesized_winners` retains the direct first-winner assertions, while `candidate_tests::candidate_builder_preserves_indexed_duplicates_full_key_collisions_and_identity_winners` is the stronger companion assertion for indexed duplicates, deleted-live re-synthesis, and indexed-key precedence. No eager-only fixture helper remains.

- [ ] **Step 55: Confirm unchanged route and cross-router tests retain their bodies**

Do not edit these existing route tests while migrating direct helper consumers:

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

Also leave `sessions_tests::patch_override_is_visible_through_session_directory_overlay` unchanged. These tests transitively switch to the candidate handler and preserve metadata, project-color, absent-index/live-synthesis, provider, override-without-index-rebuild, and project-path contracts.

- [ ] **Step 56: Compile every migrated test without running it**

Run:

```bash
FRESHELL_VITEST_BACKEND=local CARGO_TERM_COLOR=never cargo test --locked --manifest-path /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/Cargo.toml -p freshell-server --bin freshell-server --no-run
```

Expected: exit 0; no stale direct-helper call remains, while eager/candidate coexistence and the legacy temporary output path still compile against the lockfile.

- [ ] **Step 57: Run all migrated and unchanged session-directory tests**

Run:

```bash
FRESHELL_VITEST_BACKEND=local CARGO_TERM_COLOR=never cargo test --manifest-path /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/Cargo.toml -p freshell-server --bin freshell-server session_directory -- --color=never --test-threads=1
```

Expected: exit 0 with all migrated and unchanged route tests passing.

- [ ] **Step 58: Run the migration checkpoint differential with the eager oracle retained**

Run:

```bash
FRESHELL_VITEST_BACKEND=local CARGO_TERM_COLOR=never cargo test --locked --manifest-path /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/Cargo.toml -p freshell-server --bin freshell-server session_directory::page_bound_tests::candidate_tests::candidate_path_matches_eager_oracle_across_seeded_cross_product -- --exact --color=never --test-threads=1
```

Expected: exit 0 with exact parsed and serialized parity plus the fixed-case `io_error`/`budget`/`budget`/omission assertions. This proves migration changed tests/callers only; both unbounded candidate and eager paths, the legacy temporary `DirItem` fields/materializer/serializer, and all 2,884-case support remain for Task 6. Do not delete or finalize output types in this task.

- [ ] **Step 59: Commit the green retained-test migration with the eager oracle intact**

The command below is one valid example for a coherent task-level source checkpoint; its subject and body are illustrative, not required history. If this task's mandatory spec/quality review or a later final check finds a defect, make any additional source-only correction commit needed and rerun the affected checks before advancing. Do not infer an exact commit count, subject sequence, or commit order from this example. The review must accept the retained eager code only as the temporary `#[cfg(test)]` oracle consumed by Task 6, never as a second production policy.

Run:

```bash
FRESHELL_VITEST_BACKEND=local bash -c 'git -C /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep diff --check -- crates/freshell-server/src/session_directory.rs && git -C /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep add -- crates/freshell-server/src/session_directory.rs && test "$(git -C /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep diff --cached --name-only)" = "crates/freshell-server/src/session_directory.rs" && git -C /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep commit -m "refactor(session-directory): migrate retained candidate tests" -m "Route retained assertions through indexed candidates and production derivation while preserving the test-only eager oracle for final-selector parity in Task 6." -m "Generated with Amplifier" -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"'
```

Expected: exit 0 and a normal local source-only migration commit. The eager helpers, oracle, 2,884-case support, legacy temporary output fields/path, and unbounded selector remain present by design.

### Task 6: Prove the bounded selector against the eager oracle, finalize output cleanup, and enforce structural work bounds

**Files:**
- Modify/test: `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/crates/freshell-server/src/session_directory.rs`.
- Read only: `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/Cargo.lock`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/crates/freshell-sessions/src/directory_index.rs`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/crates/freshell-sessions/src/search.rs`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/crates/freshell-ws/src/identity.rs`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/crates/freshell-server/src/settings_store.rs`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/crates/freshell-server/src/session_metadata.rs`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/scripts/sandbox-build.sh`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/scripts/sandbox-test.sh`, and `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/docs/development/test-sandbox.md`.

**Interfaces:**
- Consumes: Task 5's migrated tests, retained eager helpers/oracle and 2,884-case differential, legacy temporary `DirItem` fields/materializer/serializer, temporary unbounded non-deep selector, single production candidate path, and Task 2 route harness.
- Produces: test-only `PreparationCounts`, `PreparationScope`, and `record_preparation`; structural RED against the unbounded selector; the exact verified final selector; final-selector parsed/byte parity against the retained eager oracle before deletion; final non-`Clone` counted output path; no eager/differential residue; an exact full-valid-limit runtime structural matrix plus the mandatory static post-capture preparation locality/centrality proof; locked final assembly; and provenance-bracketed sandbox evidence. TLS counters are one runtime evidence leg, never sole proof.

- [ ] **Step 1: Add the preparation counter value type**

Insert this complete test-only type at module scope:

```rust
#[cfg(test)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct PreparationCounts {
    indexed_materializations: usize,
    synthesized_materializations: usize,
    serializations: usize,
    retained_descriptor_peak: usize,
    owned_annotations: usize,
}
```

- [ ] **Step 2: Add thread-local counter state and the scope guard type**

Insert this complete test-only state block:

```rust
#[cfg(test)]
thread_local! {
    static PREPARATION_COUNTS: std::cell::RefCell<Option<PreparationCounts>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
struct PreparationScope;
```

- [ ] **Step 3: Implement scope start and snapshot operations**

Insert this complete test-only implementation:

```rust
#[cfg(test)]
impl PreparationScope {
    fn begin() -> Self {
        PREPARATION_COUNTS.with(|slot| {
            let mut slot = slot.borrow_mut();
            assert!(slot.is_none(), "overlapping preparation scopes are forbidden");
            *slot = Some(PreparationCounts::default());
        });
        Self
    }

    fn snapshot(&self) -> PreparationCounts {
        PREPARATION_COUNTS.with(|slot| {
            slot.borrow()
                .as_ref()
                .copied()
                .expect("preparation scope is not active")
        })
    }
}
```

`PreparationScope` only arms the test recorder. Its lexical lifetime surrounds the real request so the test can read counts after full body completion; the bounded-work measurement consists only of `record_preparation` sites, which the mandatory static gate proves are downstream of all four input captures in one synchronous derivation.

- [ ] **Step 4: Clear preparation state when the scope drops**

Insert this complete test-only `Drop` implementation:

```rust
#[cfg(test)]
impl Drop for PreparationScope {
    fn drop(&mut self) {
        PREPARATION_COUNTS.with(|slot| {
            slot.borrow_mut().take();
        });
    }
}
```

- [ ] **Step 5: Record preparation only inside an active scope**

Insert this complete test-only helper:

```rust
#[cfg(test)]
fn record_preparation(update: impl FnOnce(&mut PreparationCounts)) {
    PREPARATION_COUNTS.with(|slot| {
        if let Some(counts) = slot.borrow_mut().as_mut() {
            update(counts);
        }
    });
}
```

- [ ] **Step 6: Add counter recording to the temporary selector while keeping it unbounded**

Replace `select_page_candidates` with this complete RED-phase selector:

```rust
fn select_page_candidates<'a>(
    mut candidates: Vec<DirectoryCandidate<'a>>,
    query: &DirQuery,
    cursor: Option<&DecodedCursor>,
    limit: usize,
) -> CandidatePage<'a> {
    candidates.sort_by(|left, right| {
        compare_directory_order(left.order_key(), right.order_key())
    });

    let query_text = query
        .query
        .as_deref()
        .map(str::trim)
        .filter(|query_text| !query_text.is_empty());
    let lowercase_title_query = if query_text.is_some() && query.tier == Tier::Title {
        Some(query_text.expect("query exists").to_lowercase())
    } else {
        None
    };

    let mut rows = Vec::new();
    let mut partial = false;
    let mut partial_reason = None;
    let mut scanned_files = 0usize;
    let max_scan = limit * 10;

    for candidate in candidates {
        if !candidate_is_eligible(&candidate, query, cursor) {
            continue;
        }

        let annotation = match (query_text, query.tier) {
            (None, _) => None,
            (Some(_), Tier::Title) => {
                let Some(annotation) = title_search_annotation(
                    &candidate,
                    lowercase_title_query
                        .as_deref()
                        .expect("lowercase title query"),
                ) else {
                    continue;
                };
                #[cfg(test)]
                record_preparation(|counts| counts.owned_annotations += 1);
                Some(annotation)
            }
            (Some(search_text), Tier::UserMessages | Tier::FullText) => {
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
                let tier = file_search_tier(query.tier).expect("file search tier");
                match search_session_file(path, candidate.provider(), search_text, tier) {
                    Ok(Some(found)) => {
                        let annotation = SearchAnnotation {
                            matched_in: found.matched_in,
                            snippet: found.snippet,
                        };
                        #[cfg(test)]
                        record_preparation(|counts| counts.owned_annotations += 1);
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

- [ ] **Step 7: Count both arms of the still-legacy temporary materializer**

Keep the complete Task 4 temporary `materialize_selected_candidate` shape, including `title_source` and `source_file`, because the eager oracle still consumes those fields. Insert this block at entry to the indexed arm, immediately after its `=> {`:

```rust
            #[cfg(test)]
            record_preparation(|counts| counts.indexed_materializations += 1);
```

Insert this block at entry to the synthesized arm, immediately after its `=> {`:

```rust
            #[cfg(test)]
            record_preparation(|counts| counts.synthesized_materializations += 1);
```

Do not replace any constructor field or create a second oracle/output representation in this step.

- [ ] **Step 8: Count serializations in the still-legacy temporary serializer**

Keep the current serializer's complete field order and body unchanged for eager parity. Insert this exact counter at entry to the current `DirItem::to_value`, before `let mut o = Map::new();`:

```rust
        #[cfg(test)]
        record_preparation(|counts| counts.serializations += 1);
```

The differential runs outside `PreparationScope`, so this test-only recorder is inactive and cannot alter parsed or byte output.

- [ ] **Step 9: Create the nested `preparation_tests` module shell**

Add this complete shell inside `page_bound_tests`:

```rust
    mod preparation_tests {
        use super::*;
    }
```

- [ ] **Step 10: Add structural test `no_search_materializes_only_returned_indexed_rows` across every accepted limit**

Insert this complete current-thread route test before the closing brace of `preparation_tests`:

```rust
        #[tokio::test(flavor = "current_thread")]
        async fn no_search_materializes_only_returned_indexed_rows() {
            let rows = (0..(MAX_DIRECTORY_PAGE_ITEMS + 2))
                .map(|index| {
                    indexed_row(
                        &format!("s-{index:03}"),
                        10_000 - index as i64,
                        Some("visible"),
                    )
                })
                .collect();
            let harness = directory_route_harness(rows);

            for limit in 1..=MAX_DIRECTORY_PAGE_ITEMS {
                let scope = PreparationScope::begin();
                let page = get_page(
                    harness.app.clone(),
                    &format!("&limit={limit}"),
                )
                .await;
                let counts = scope.snapshot();
                drop(scope);

                assert_eq!(
                    page["items"].as_array().expect("items").len(),
                    limit,
                    "limit={limit}",
                );
                assert!(page_cursor(&page).is_some(), "limit={limit}");
                assert_eq!(
                    counts,
                    PreparationCounts {
                        indexed_materializations: limit,
                        synthesized_materializations: 0,
                        serializations: limit,
                        retained_descriptor_peak: limit + 1,
                        owned_annotations: 0,
                    },
                    "limit={limit}",
                );
            }
        }
```

- [ ] **Step 11: Add structural test `no_search_materializes_only_returned_synthesized_rows`**

Insert this complete current-thread route test before the closing brace of `preparation_tests`:

```rust
        #[tokio::test(flavor = "current_thread")]
        async fn no_search_materializes_only_returned_synthesized_rows() {
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

            let scope = PreparationScope::begin();
            let page = get_page(harness.app.clone(), "&limit=2").await;
            let counts = scope.snapshot();
            drop(scope);

            assert_eq!(page["items"].as_array().expect("items").len(), 2);
            assert!(page_cursor(&page).is_some());
            assert_eq!(
                counts,
                PreparationCounts {
                    indexed_materializations: 0,
                    synthesized_materializations: 2,
                    serializations: 2,
                    retained_descriptor_peak: 3,
                    owned_annotations: 0,
                }
            );
        }
```

- [ ] **Step 12: Add structural test `filtered_and_cursor_prefixes_do_not_expand_full_preparation`**

Insert this complete current-thread route test before the closing brace of `preparation_tests`:

```rust
        #[tokio::test(flavor = "current_thread")]
        async fn filtered_and_cursor_prefixes_do_not_expand_full_preparation() {
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

            let scope = PreparationScope::begin();
            let page = get_page(
                harness.app.clone(),
                &format!("&limit=2&cursor={cursor}"),
            )
            .await;
            let counts = scope.snapshot();
            drop(scope);

            assert_eq!(item_ids(&page), vec!["visible-01", "visible-02"]);
            assert!(page_cursor(&page).is_some());
            assert_eq!(
                counts,
                PreparationCounts {
                    indexed_materializations: 2,
                    synthesized_materializations: 0,
                    serializations: 2,
                    retained_descriptor_peak: 3,
                    owned_annotations: 0,
                }
            );
        }
```

- [ ] **Step 13: Add structural test `all_hidden_page_materializes_nothing_and_keeps_revision`**

Insert this complete current-thread route test before the closing brace of `preparation_tests`:

```rust
        #[tokio::test(flavor = "current_thread")]
        async fn all_hidden_page_materializes_nothing_and_keeps_revision() {
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

            let scope = PreparationScope::begin();
            let page = get_page(harness.app.clone(), "&limit=2").await;
            let counts = scope.snapshot();
            drop(scope);

            assert!(item_ids(&page).is_empty());
            assert!(page_cursor(&page).is_none());
            assert_eq!(page["revision"], json!(10_000));
            assert_eq!(counts, PreparationCounts::default());
        }
```

- [ ] **Step 14: Add structural test `sparse_title_search_retains_only_limit_plus_one_annotations` across every accepted limit**

Insert this complete current-thread route test before the closing brace of `preparation_tests`:

```rust
        #[tokio::test(flavor = "current_thread")]
        async fn sparse_title_search_retains_only_limit_plus_one_annotations() {
            let mut rows: Vec<IndexedSession> = (0..101)
                .map(|index| {
                    indexed_row(
                        &format!("nonmatch-{index:03}"),
                        20_000 - index as i64,
                        Some("visible nonmatch"),
                    )
                })
                .collect();
            for index in 0..(MAX_DIRECTORY_PAGE_ITEMS + 2) {
                rows.push(indexed_row(
                    &format!("match-{index:02}"),
                    1_000 - index as i64,
                    Some("sparse needle match"),
                ));
            }
            let harness = directory_route_harness(rows);

            for limit in 1..=MAX_DIRECTORY_PAGE_ITEMS {
                let scope = PreparationScope::begin();
                let page = get_page(
                    harness.app.clone(),
                    &format!("&query=needle&tier=title&limit={limit}"),
                )
                .await;
                let counts = scope.snapshot();
                drop(scope);

                let ids = item_ids(&page);
                assert_eq!(ids.len(), limit, "limit={limit}");
                assert_eq!(ids[0], "match-00", "limit={limit}");
                assert!(page_cursor(&page).is_some(), "limit={limit}");
                assert_eq!(
                    counts,
                    PreparationCounts {
                        indexed_materializations: limit,
                        synthesized_materializations: 0,
                        serializations: limit,
                        retained_descriptor_peak: limit + 1,
                        owned_annotations: limit + 1,
                    },
                    "limit={limit}",
                );
            }
        }
```

- [ ] **Step 15: Add structural test `deep_search_retains_only_limit_plus_one_annotations` across every accepted limit and both deep tiers**

Insert this complete current-thread route test before the closing brace of `preparation_tests`:

```rust
        #[tokio::test(flavor = "current_thread")]
        async fn deep_search_retains_only_limit_plus_one_annotations() {
            let home = tempfile::tempdir().expect("transcript home");
            let mut rows = Vec::new();
            for index in 0..(MAX_DIRECTORY_PAGE_ITEMS + 2) {
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
                    1_000 - index as i64,
                    Some("visible"),
                );
                row.source_file = Some(path);
                rows.push(row);
            }
            let harness = directory_route_harness(rows);

            for tier in ["userMessages", "fullText"] {
                for limit in 1..=MAX_DIRECTORY_PAGE_ITEMS {
                    let scope = PreparationScope::begin();
                    let page = get_page(
                        harness.app.clone(),
                        &format!("&query=needle&tier={tier}&limit={limit}"),
                    )
                    .await;
                    let counts = scope.snapshot();
                    drop(scope);

                    let ids = item_ids(&page);
                    assert_eq!(ids.len(), limit, "tier={tier} limit={limit}");
                    assert_eq!(ids[0], "deep-0", "tier={tier} limit={limit}");
                    assert!(
                        page_cursor(&page).is_some(),
                        "tier={tier} limit={limit}",
                    );
                    assert_eq!(
                        page["items"][0]["matchedIn"],
                        json!("userMessage"),
                        "tier={tier} limit={limit}",
                    );
                    assert_eq!(
                        page["items"][0]["snippet"],
                        json!("needle deep 0"),
                        "tier={tier} limit={limit}",
                    );
                    assert_eq!(
                        counts,
                        PreparationCounts {
                            indexed_materializations: limit,
                            synthesized_materializations: 0,
                            serializations: limit,
                            retained_descriptor_peak: limit + 1,
                            owned_annotations: limit + 1,
                        },
                        "tier={tier} limit={limit}",
                    );
                }
            }
        }
```

- [ ] **Step 16: Add structural test `preparation_scope_resets_and_is_inactive_outside_interval`**

Insert this complete current-thread route test before the closing brace of `preparation_tests`:

```rust
        #[tokio::test(flavor = "current_thread")]
        async fn preparation_scope_resets_and_is_inactive_outside_interval() {
            let harness = directory_route_harness(vec![indexed_row(
                "measured",
                100,
                Some("visible"),
            )]);

            let _ = get_page(harness.app.clone(), "&limit=1").await;

            let scope = PreparationScope::begin();
            let page = get_page(harness.app.clone(), "&limit=1").await;
            assert_eq!(item_ids(&page), vec!["measured"]);
            assert_eq!(
                scope.snapshot(),
                PreparationCounts {
                    indexed_materializations: 1,
                    synthesized_materializations: 0,
                    serializations: 1,
                    retained_descriptor_peak: 1,
                    owned_annotations: 0,
                }
            );
            drop(scope);

            let _ = get_page(harness.app.clone(), "&limit=1").await;
            let empty_scope = PreparationScope::begin();
            assert_eq!(empty_scope.snapshot(), PreparationCounts::default());
            drop(empty_scope);

            let outer = PreparationScope::begin();
            assert!(std::panic::catch_unwind(PreparationScope::begin).is_err());
            assert_eq!(outer.snapshot(), PreparationCounts::default());
            drop(outer);

            assert!(
                std::panic::catch_unwind(|| {
                    let _scope = PreparationScope::begin();
                    panic!("exercise guard cleanup");
                })
                .is_err()
            );
            let final_scope = PreparationScope::begin();
            assert_eq!(final_scope.snapshot(), PreparationCounts::default());
        }
```

All three bound-stressing corpora contain `MAX_DIRECTORY_PAGE_ITEMS + 2` eligible or matching candidates; do not reduce any to `MAX_DIRECTORY_PAGE_ITEMS + 1`, which would make the maximum-limit limiter proof vacuous.

The RED run uses the temporary unbounded selector. Response assertions must already pass. The no-search and title exhaustive matrices fail exact retained peaks/owned annotations, including at the maximum limit because 52 selectable matches exist; the already-bounded deep path remains green.

- [ ] **Step 17: Run the structural tests and observe the intended RED**

Run:

```bash
FRESHELL_VITEST_BACKEND=local CARGO_TERM_COLOR=never cargo test --manifest-path /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/Cargo.toml -p freshell-server --bin freshell-server session_directory::page_bound_tests::preparation_tests -- --color=never --test-threads=1
```

Expected RED: response assertions already pass, but exact no-search/title descriptor peaks or annotation counts exceed their specified `limit + 1` values under the temporary selector for the exhaustive valid-limit matrix, including limit 50 because each corpus has 52 selectable matches. The deep matrix remains green under its existing bounded path. Compilation failure, response mismatch, timing failure, or unrelated failure is not valid RED.

- [ ] **Step 18: Replace only the selector with the final bounded implementation**

Use this complete final selector:

```rust
fn select_page_candidates<'a>(
    mut candidates: Vec<DirectoryCandidate<'a>>,
    query: &DirQuery,
    cursor: Option<&DecodedCursor>,
    limit: usize,
) -> CandidatePage<'a> {
    candidates.sort_by(|left, right| {
        compare_directory_order(left.order_key(), right.order_key())
    });

    let query_text = query
        .query
        .as_deref()
        .map(str::trim)
        .filter(|query_text| !query_text.is_empty());
    let is_deep_search = query_text.is_some()
        && matches!(query.tier, Tier::UserMessages | Tier::FullText);
    let lowercase_title_query = if query_text.is_some() && query.tier == Tier::Title {
        Some(query_text.expect("query exists").to_lowercase())
    } else {
        None
    };

    let mut rows = Vec::new();
    let mut partial = false;
    let mut partial_reason = None;
    let mut scanned_files = 0usize;
    let max_scan = limit * 10;

    for candidate in candidates {
        if !candidate_is_eligible(&candidate, query, cursor) {
            continue;
        }

        let annotation = match (query_text, query.tier) {
            (None, _) => None,
            (Some(_), Tier::Title) => {
                let Some(annotation) = title_search_annotation(
                    &candidate,
                    lowercase_title_query
                        .as_deref()
                        .expect("lowercase title query"),
                ) else {
                    continue;
                };
                #[cfg(test)]
                record_preparation(|counts| counts.owned_annotations += 1);
                Some(annotation)
            }
            (Some(search_text), Tier::UserMessages | Tier::FullText) => {
                // Preserve current deep-search order: lookahead match count,
                // budget, source, provider, scanned increment, then I/O.
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
                let tier = file_search_tier(query.tier).expect("file search tier");
                match search_session_file(path, candidate.provider(), search_text, tier) {
                    Ok(Some(found)) => {
                        let annotation = SearchAnnotation {
                            matched_in: found.matched_in,
                            snippet: found.snippet,
                        };
                        #[cfg(test)]
                        record_preparation(|counts| counts.owned_annotations += 1);
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
        if !is_deep_search && rows.len() > limit {
            break;
        }
    }

    CandidatePage {
        rows,
        partial,
        partial_reason,
    }
}
```

The post-push break applies only to no-search/title paths. Deep search retains its pre-budget lookahead check before source/provider filtering.

- [ ] **Step 19: Compile the final selector before using the eager oracle**

Run:

```bash
FRESHELL_VITEST_BACKEND=local CARGO_TERM_COLOR=never cargo check --locked --manifest-path /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/Cargo.toml -p freshell-server
```

Expected: exit 0 against the real locked production crate. The selector in Step 18 is the last production behavior edit before Step 20; this command may intervene, but no production edit may. Failure stops and reopens LB-03 under the one-file correction rule, never an owned fallback, adapter, API/manifest change, or second source file.

- [ ] **Step 20: Prove exact 2,884-case parity against the final bounded selector**

Run:

```bash
FRESHELL_VITEST_BACKEND=local CARGO_TERM_COLOR=never cargo test --locked --manifest-path /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/Cargo.toml -p freshell-server --bin freshell-server session_directory::page_bound_tests::candidate_tests::candidate_path_matches_eager_oracle_across_seeded_cross_product -- --exact --color=never --test-threads=1
```

Expected: exit 0 with 2,884 cases, 2,884 parsed `Value` equalities, 2,884 serialized-byte equalities, and all fixed partial expectations passing against the final bounded selector. No production edit may occur between Steps 18 and 20.

- [ ] **Step 21: Run every route characterization before oracle deletion**

Run:

```bash
FRESHELL_VITEST_BACKEND=local CARGO_TERM_COLOR=never cargo test --locked --manifest-path /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/Cargo.toml -p freshell-server --bin freshell-server session_directory::page_bound_tests -- --color=never --test-threads=1
```

Expected: exit 0, including the 599-byte literal wire assertion and the final-selector differential. Commands may intervene after Step 18; production edits may not.

- [ ] **Step 22: Run the runtime structural leg GREEN before oracle deletion**

Run:

```bash
FRESHELL_VITEST_BACKEND=local CARGO_TERM_COLOR=never cargo test --locked --manifest-path /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/Cargo.toml -p freshell-server --bin freshell-server session_directory::page_bound_tests::preparation_tests -- --color=never --test-threads=1
```

Expected: exit 0 with all seven current-thread test functions and all 203 measured route activations passing exact dynamic response length, cursor, materialization, serialization, retained-peak, and owned-annotation counts. The 203 cases are 50 no-search indexed, three focused single cases, 50 title, and 100 deep cases across two tiers; the seventh function is lifecycle-only. This is the runtime leg only; it is not admissible as sole proof without Step 44's static leg.

- [ ] **Step 23: Run the complete focused family before oracle deletion**

Run:

```bash
FRESHELL_VITEST_BACKEND=local CARGO_TERM_COLOR=never cargo test --locked --manifest-path /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/Cargo.toml -p freshell-server --bin freshell-server session_directory -- --color=never --test-threads=1
```

Expected: exit 0 with exact response behavior and structural counts intact. No production edit has occurred since Step 18. The first production edit after this command is Step 24's planned eager/oracle deletion.

- [ ] **Step 24: Delete all eager policy and temporary differential symbols after final-selector proof**

Immediately after Steps 20-23 pass, delete the complete definitions of these exact symbols and no neighboring retained parser/route code:

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
deep_search_dir_item
guard_item
overlaid_title
derive_eager_oracle_page
DifferentialFixture
DeterministicLcg
DIFFERENTIAL_SEEDS
seeded_differential_fixture
seeded_differential_fixture_variants
differential_visibility_cases
differential_query_cases
differential_limits
differential_cursors
fixed_deep_partial_cases
candidate_path_matches_eager_oracle_across_seeded_cross_product
```

Do not leave wrappers under old names. This is the first production edit after final-selector validation. Keep the shared candidate tests in `candidate_tests`, plus Task 3's reused `write_nonmatching_claude_transcript`, `deep_search_query`, and `encode_raw_cursor_payload` helpers. Do not add a second oracle representation.

- [ ] **Step 25: Replace `DirItem` with the final non-cloneable output shape**

Replace the complete legacy `DirItem` declaration with:

```rust
#[derive(Debug)]
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
```

The removed `Clone`, `title_source`, and `source_file` are now safe because Step 24 deleted their final eager consumers.

- [ ] **Step 26: Replace the complete `DirItem` implementation with the final counted serializer**

Replace the complete legacy `impl DirItem` block—explicitly remove `DirItem::key` and replace `to_value`—with:

```rust
impl DirItem {
    fn to_value(&self) -> Value {
        #[cfg(test)]
        record_preparation(|counts| counts.serializations += 1);

        let mut object = Map::new();
        object.insert("sessionId".into(), json!(self.session_id));
        object.insert("provider".into(), json!(self.provider));
        object.insert("projectPath".into(), json!(self.project_path));
        object.insert("lastActivityAt".into(), json!(self.last_activity_at));
        object.insert("isRunning".into(), json!(self.is_running));
        object.insert("archived".into(), json!(self.archived));
        if let Some(value) = &self.title {
            object.insert("title".into(), json!(value));
        }
        if let Some(value) = &self.summary {
            object.insert("summary".into(), json!(value));
        }
        if let Some(value) = &self.first_user_message {
            object.insert("firstUserMessage".into(), json!(value));
        }
        if let Some(value) = self.created_at {
            object.insert("createdAt".into(), json!(value));
        }
        if let Some(value) = &self.cwd {
            object.insert("cwd".into(), json!(value));
        }
        if self.is_subagent {
            object.insert("isSubagent".into(), json!(true));
        }
        if self.is_non_interactive {
            object.insert("isNonInteractive".into(), json!(true));
        }
        if let Some(value) = &self.matched_in {
            object.insert("matchedIn".into(), json!(value));
        }
        if let Some(value) = &self.snippet {
            object.insert("snippet".into(), json!(value));
        }
        if let Some(value) = &self.running_terminal_id {
            object.insert("runningTerminalId".into(), json!(value));
        }
        if self.live_terminal_only {
            object.insert("liveTerminalOnly".into(), json!(true));
        }
        if let Some(value) = &self.session_type {
            object.insert("sessionType".into(), json!(value));
        }
        Value::Object(object)
    }
}
```

The insertion order is unchanged, and this is the sole serialization recorder site.

- [ ] **Step 27: Replace the temporary materializer with the final counted legacy-free materializer**

Replace the complete temporary materializer with:

```rust
fn materialize_selected_candidate(
    selected: SelectedCandidate<'_>,
    metadata: &HashMap<String, Value>,
) -> DirItem {
    let SelectedCandidate {
        candidate,
        annotation,
    } = selected;
    let DirectoryCandidate { key, source } = candidate;
    let (matched_in, snippet) = match annotation {
        Some(SearchAnnotation {
            matched_in,
            snippet,
        }) => (Some(matched_in.to_string()), Some(snippet)),
        None => (None, None),
    };

    match source {
        DirectoryCandidateSource::Indexed {
            row,
            overlay,
            running_identity,
        } => {
            #[cfg(test)]
            record_preparation(|counts| counts.indexed_materializations += 1);

            let session_type = metadata
                .get(key.as_ref())
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
                matched_in,
                snippet,
                running_terminal_id: running_identity
                    .map(|identity| identity.terminal_id.clone()),
                live_terminal_only: false,
                session_type,
            }
        }
        DirectoryCandidateSource::Synthesized {
            identity,
            provider,
            session_id,
        } => {
            #[cfg(test)]
            record_preparation(|counts| counts.synthesized_materializations += 1);

            let (session_id, live_terminal_only) = match session_id {
                SynthesizedSessionId::Existing(session_id) => {
                    (session_id.to_string(), false)
                }
                SynthesizedSessionId::TerminalFallback(terminal_id) => {
                    (format!("terminal:{terminal_id}"), true)
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
                matched_in,
                snippet,
                running_terminal_id: Some(identity.terminal_id.clone()),
                live_terminal_only,
                session_type: Some(provider.to_string()),
            }
        }
    }
}
```

No legacy field remains and the indexed/synthesized arm entries are the sole materialization recorder sites.

- [ ] **Step 28: Replace the test-only parser row constructor for the final output shape**

Replace `item_from_meta` with:

```rust
#[cfg(test)]
fn item_from_meta(
    meta: &ParsedSessionMeta,
    provider: &str,
    fallback_session_id: &str,
    force_subagent: bool,
) -> DirItem {
    DirItem {
        session_id: meta
            .session_id
            .clone()
            .unwrap_or_else(|| fallback_session_id.to_string()),
        provider: provider.to_string(),
        project_path: meta.cwd.clone().unwrap_or_else(|| "unknown".to_string()),
        title: meta.title.clone(),
        summary: meta.summary.clone(),
        first_user_message: meta.first_user_message.clone(),
        last_activity_at: meta.last_activity_at.unwrap_or(0).max(0),
        created_at: meta.created_at,
        cwd: meta.cwd.clone(),
        is_subagent: force_subagent || meta.is_subagent.unwrap_or(false),
        is_non_interactive: meta.is_non_interactive.unwrap_or(false),
        is_running: false,
        archived: false,
        matched_in: None,
        snippet: None,
        running_terminal_id: None,
        live_terminal_only: false,
        session_type: None,
    }
}
```

- [ ] **Step 29: Remove the obsolete source path from the parser call**

Replace the parser call with:

```rust
    Some(item_from_meta(
        &meta,
        "claude",
        &fallback,
        force_subagent,
    ))
```

- [ ] **Step 30: Update the real-corrupted parser test call**

Replace the direct test call with:

```rust
        let item = item_from_meta(&meta, "claude", "real-corrupted", false);
```

- [ ] **Step 31: Update the healthy parser test call**

Replace the direct test call with:

```rust
        let item = item_from_meta(&meta, "claude", "healthy", false);
```

- [ ] **Step 32: Replace the removed `DirItem::key` use in `Comparable`**

Replace `Comparable::from(&DirItem)`'s key field with:

```rust
                key: format!("{}:{}", i.provider, i.session_id),
```

- [ ] **Step 33: Replace the module-level candidate-pipeline and concurrency documentation**

Replace the module header with:

```rust
//! Rust implementation of `GET /api/session-directory`.
//!
//! Each request captures independent index, override, metadata, and terminal-
//! identity values sequentially in accessor order. They are not one atomic
//! cross-store cut; overlapping writes and the old projection/read race windows
//! are unspecified. `revision` is full-corpus candidate/identity recency, not a
//! cross-store version. A shared borrowed-candidate pipeline owns effective
//! membership, ordering, visibility, cursor, and search policy for every tier;
//! only returned descriptors become `DirItem` values.
```

- [ ] **Step 34: Replace stale `SessionDirectoryState` field documentation**

Replace the complete state declaration and comments with:

```rust
/// Request dependencies for the Rust session-directory route. `session_index`
/// may be absent; provider-bearing live identities can still synthesize rows.
#[derive(Clone)]
pub struct SessionDirectoryState {
    pub auth_token: Arc<String>,
    pub settings: crate::settings_store::SettingsStore,
    pub session_index: Option<Arc<SessionIndex>>,
    pub identity: freshell_ws::identity::TerminalIdentityRegistry,
    pub metadata: crate::session_metadata::SessionMetadataStore,
}
```

- [ ] **Step 35: Replace stale search-tier documentation**

Replace the `Tier` documentation with:

```rust
/// Search tier. A nonblank query selects title metadata or transcript search;
/// a missing or blank query uses the same no-search candidate pipeline for all
/// tier values.
```

- [ ] **Step 36: Compile the final production assembly against the lockfile**

Run:

```bash
FRESHELL_VITEST_BACKEND=local CARGO_TERM_COLOR=never cargo check --locked --manifest-path /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/Cargo.toml -p freshell-server
```

Expected: exit 0 after final selector installation, oracle deletion, final counted serializer/materializer, parser callers, and documentation assembly. Any failure stops and reopens LB-03 under the one-file correction rule; it never authorizes a fallback, adapter, API/manifest change, or second source file.

- [ ] **Step 37: Compile the final inline-test assembly against the lockfile**

Run:

```bash
FRESHELL_VITEST_BACKEND=local CARGO_TERM_COLOR=never cargo test --locked --manifest-path /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/Cargo.toml -p freshell-server --bin freshell-server --no-run
```

Expected: exit 0 with the final non-`Clone` `DirItem`, counted sites, parser callers, candidate tests, and route tests type-consistent. Failure has the same stop/correct-within-plan/reopen rule as Step 36.

- [ ] **Step 38: Prove the exact literal response bytes after final output cleanup**

Run:

```bash
FRESHELL_VITEST_BACKEND=local CARGO_TERM_COLOR=never cargo test --locked --manifest-path /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/Cargo.toml -p freshell-server --bin freshell-server session_directory::page_bound_tests::no_search_exact_response_shape_preserves_all_fields_bytes_and_no_totals -- --exact --color=never --test-threads=1
```

Expected: exit 0 with the exact parsed object, 599-byte literal body, insertion order, omission rules, and no totals unchanged after the oracle is gone.

- [ ] **Step 39: Rerun the exact runtime structural suite after final output cleanup**

Run:

```bash
FRESHELL_VITEST_BACKEND=local CARGO_TERM_COLOR=never cargo test --locked --manifest-path /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/Cargo.toml -p freshell-server --bin freshell-server session_directory::page_bound_tests::preparation_tests -- --color=never --test-threads=1
```

Expected: exit 0 with all seven current-thread test functions and all 203 measured route activations passing every exact dynamic count unchanged. This remains the runtime leg only; Step 44 is mandatory companion evidence.

- [ ] **Step 40: Rerun every route and candidate characterization after final output cleanup**

Run:

```bash
FRESHELL_VITEST_BACKEND=local CARGO_TERM_COLOR=never cargo test --locked --manifest-path /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/Cargo.toml -p freshell-server --bin freshell-server session_directory::page_bound_tests -- --color=never --test-threads=1
```

Expected: exit 0. The released selector/output path preserves every retained route assertion; the deleted differential is no longer expected in this post-cleanup run.

- [ ] **Step 41: Rerun the complete focused family after final output cleanup**

Run:

```bash
FRESHELL_VITEST_BACKEND=local CARGO_TERM_COLOR=never cargo test --locked --manifest-path /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/Cargo.toml -p freshell-server --bin freshell-server session_directory -- --color=never --test-threads=1
```

Expected: exit 0 with all retained and unchanged route tests passing. Do not claim Step 20's differential independently validates this mechanical post-deletion phase; Steps 36-41 are its evidence.

- [ ] **Step 42: Prove old eager policy functions are absent**

Run:

```bash
FRESHELL_VITEST_BACKEND=local bash -c 'git -C /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep grep -n -E "^fn (dir_item_from_indexed|apply_session_overrides|apply_session_metadata|join_running_state|build_live_terminal_session_item|join_live_terminals|apply_query|apply_file_search|apply_title_search|derive_eager_oracle_page)\\(" -- crates/freshell-server/src/session_directory.rs; test "$?" -eq 1'
```

Expected: no matches and exit 0.

- [ ] **Step 43: Prove obsolete helpers and all temporary differential support are absent**

Run:

```bash
FRESHELL_VITEST_BACKEND=local bash -c 'git -C /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep grep -n -E "FileSearchOutcome|derive_eager_oracle_page|DifferentialFixture|DeterministicLcg|DIFFERENTIAL_SEEDS|seeded_differential_fixture|seeded_differential_fixture_variants|differential_visibility_cases|differential_query_cases|differential_limits|differential_cursors|fixed_deep_partial_cases|candidate_path_matches_eager_oracle_across_seeded_cross_product|deep_search_dir_item|guard_item|overlaid_title" -- crates/freshell-server/src/session_directory.rs; test "$?" -eq 1'
```

Expected: no matches and exit 0. Task 7 repeats this exact complete residue-name set against committed `HEAD`.

- [ ] **Step 44: Run the mandatory static post-capture preparation locality and centrality proof**

Run this source-shape and locked-dependency gate after the post-cleanup compiler/route/structural/focused evidence and before sandbox or commit:

```bash
FRESHELL_VITEST_BACKEND=local python3 - <<'PY'
from pathlib import Path
import re

root = Path('/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep')
source = (root / 'crates/freshell-server/src/session_directory.rs').read_text(encoding='utf-8')
search = (root / 'crates/freshell-sessions/src/search.rs').read_text(encoding='utf-8')

def count(pattern: str, text: str = source) -> int:
    return len(re.findall(pattern, text, flags=re.MULTILINE | re.DOTALL))

def braced_region(text: str, marker: str) -> str:
    assert text.count(marker) == 1, (marker, text.count(marker))
    start = text.index(marker)
    opening = text.index('{', start)
    depth = 0
    for end in range(opening, len(text)):
        if text[end] == '{':
            depth += 1
        elif text[end] == '}':
            depth -= 1
            if depth == 0:
                return text[start:end + 1]
    raise AssertionError(f'unclosed braced region: {marker}')

def only_position(text: str, needle: str) -> int:
    assert text.count(needle) == 1, (needle, text.count(needle))
    return text.index(needle)

# Exactly six named work-bound tests define one activation template per named test;
# each dynamic case surrounds exactly one fully awaited real route request. The
# interval may include acquisition-time offload. The seventh current-thread test
# is explicitly the lifecycle/reset-only test.
request_tests = (
    'no_search_materializes_only_returned_indexed_rows',
    'no_search_materializes_only_returned_synthesized_rows',
    'filtered_and_cursor_prefixes_do_not_expand_full_preparation',
    'all_hidden_page_materializes_nothing_and_keeps_revision',
    'sparse_title_search_retains_only_limit_plus_one_annotations',
    'deep_search_retains_only_limit_plus_one_annotations',
)
lifecycle_test = 'preparation_scope_resets_and_is_inactive_outside_interval'
preparation = braced_region(source, '    mod preparation_tests {')
current_thread_tests = re.findall(
    r'#\[tokio::test\(flavor = "current_thread"\)\]\s*async fn ([a-z0-9_]+)\(\)',
    preparation,
)
assert current_thread_tests == [*request_tests, lifecycle_test]
assert source.count('#[tokio::test(flavor = "current_thread")]') == len(current_thread_tests) == 7
assert 'tokio::test(flavor = "multi_thread")' not in source
assert lifecycle_test not in request_tests
lifecycle_body = braced_region(preparation, f'        async fn {lifecycle_test}()')
assert lifecycle_body.count('PreparationScope::begin()') == 5
assert 'catch_unwind(PreparationScope::begin)' in lifecycle_body

awaited_request = re.compile(
    r'\bget_page(?:_with_bytes)?\s*\([^;]*?\)\s*\.await\b',
    flags=re.DOTALL,
)
for test_name in request_tests:
    test_body = braced_region(preparation, f'        async fn {test_name}()')
    begin = only_position(test_body, 'let scope = PreparationScope::begin();')
    snapshot = only_position(test_body, 'scope.snapshot()')
    requests = list(awaited_request.finditer(test_body, begin, snapshot))
    assert len(requests) == 1, (test_name, len(requests))
    request = requests[0]
    assert begin < request.start() < request.end() < snapshot, test_name
assert source.count('let counts = scope.snapshot();') == 6

# The route helper directly polls one request and fully collects its body before returning.
bytes_helper = braced_region(source, '    async fn get_page_with_bytes(')
page_helper = braced_region(source, '    async fn get_page(')
assert bytes_helper.count('.oneshot(') == 1
assert bytes_helper.count('to_bytes(response.into_body(), usize::MAX)') == 1
assert bytes_helper.index('.oneshot(') < bytes_helper.index('to_bytes(') < bytes_helper.index('serde_json::from_slice')
assert page_helper.count('get_page_with_bytes(app, suffix).await.0') == 1

# Restrict exhaustive centrality checks to non-test production. The migrated
# join-test module and sole direct parser constructor are proved cfg(test) and excluded.
tests_marker = '\n#[cfg(test)]\nmod tests {'
assert source.count(tests_marker) == 1
production_region = source[:source.index(tests_marker)]
join_tests = braced_region(production_region, '#[cfg(test)]\nmod join_tests {')
test_only_parser = braced_region(production_region, '#[cfg(test)]\nfn item_from_meta(')
constructor_pattern = r'(?<!struct )(?<!impl )(?<!-> )\bDirItem\s*\{'
assert join_tests.startswith('#[cfg(test)]')
assert test_only_parser.startswith('#[cfg(test)]')
assert count(constructor_pattern, test_only_parser) == 1
production = production_region.replace(join_tests, '', 1).replace(test_only_parser, '', 1)
production_code = '\n'.join(line.split('//', 1)[0] for line in production.splitlines())

route = braced_region(production, 'async fn session_directory(')
provider_name = braced_region(production, 'fn provider_display_name(')
selector = braced_region(production, "fn select_page_candidates<'a>(")
materializer = braced_region(production, 'fn materialize_selected_candidate(')
derive = braced_region(production, 'fn derive_directory_page(')
dir_item_impl = braced_region(production, 'impl DirItem {')
serializer = braced_region(dir_item_impl, '    fn to_value(&self) -> Value {')

# The TLS activation surrounds the full request, but counted work starts only
# after all independent input captures and remains in synchronous derivation.
index_capture = only_position(route, 'Some(index) => Some(index.snapshot().await),')
overrides_capture = only_position(route, 'let overrides = state.settings.session_overrides();')
metadata_capture = only_position(route, 'let metadata = state.metadata.get_all().await;')
identities_capture = only_position(route, 'let identities = state.identity.list();')
derive_call = only_position(route, 'derive_directory_page(')
snapshot_release = only_position(route, 'drop(snapshot);')
assert (
    index_capture
    < overrides_capture
    < metadata_capture
    < identities_capture
    < derive_call
    < snapshot_release
)
post_capture_route = route[identities_capture:snapshot_release]
assert post_capture_route.count('derive_directory_page(') == 1
assert '.await' not in post_capture_route

# Scan the complete local candidate-function block, the serializer, and the
# external synchronous transcript module. Index/metadata acquisition is
# intentionally outside this no-handoff claim and may offload.
candidate_start = only_position(production, "fn resolve_indexed_overlay<'a>(")
candidate_end = production.index(derive) + len(derive)
candidate_region = production[candidate_start:candidate_end]
offload = re.compile(
    r'\b(?:spawn_blocking|block_in_place|tokio::(?:task::)?spawn|std::thread(?:\s*::|\b))'
)
assert re.search(r'\basync\s+fn\b|\.await\b', candidate_region) is None
assert offload.search(post_capture_route) is None
assert offload.search(provider_name) is None
assert offload.search(candidate_region) is None
assert offload.search(serializer) is None
assert offload.search(search) is None

# Exact-one policy definitions and exhaustive production references/call sites.
assert count(r'^fn compare_directory_order\(', production) == 1
assert count(r'^fn candidate_is_eligible\(', production) == 1
assert count(r'^fn select_page_candidates', production) == 1
assert count(r'^fn materialize_selected_candidate\(', production) == 1
assert count(r'^fn derive_directory_page\(', production) == 1
assert count(r'^impl DirItem\s*\{', production) == 1
assert count(r'^[ \t]+fn to_value\(', production) == 1
assert count(r'\bselect_page_candidates\b', production_code) == 2
assert count(r'\bmaterialize_selected_candidate\b', production_code) == 2
assert count(r'\bderive_directory_page\b', production_code) == 2
assert count(r'\bto_value\b', production_code) == 2
assert count(r'\bselect_page_candidates\s*\(', production_code) == 1
assert count(r'\bselect_page_candidates\s*\(', derive) == 1
assert count(r'(?<!fn )\bmaterialize_selected_candidate\s*\(', production_code) == 1
assert count(r'(?<!fn )\bmaterialize_selected_candidate\s*\(', derive) == 1
assert count(r'(?<!fn )\bderive_directory_page\s*\(', production_code) == 1
assert count(r'(?:\.|DirItem::)\s*to_value\s*\(', production_code) == 1
assert count(r'(?:\.|DirItem::)\s*to_value\s*\(', derive) == 1
assert count(constructor_pattern, production_code) == 2
assert count(constructor_pattern, materializer) == 2
assert count(r'->\s*DirItem\b', production_code) == 1
assert count(r'->\s*DirItem\b', materializer) == 1
assert count(r'impl\s+(?:serde::)?Serialize\s+for\s+DirItem\b', production_code) == 0
assert count(r'#\[derive\([^\]]*\bSerialize\b[^\]]*\)\]\s*struct DirItem', production_code) == 0
assert count(r'\bto_value\b', serializer) == 1

# Exhaustive oversized runtime cases prove limiter semantics; this section proves
# the exact canonical chain and counter-site centrality without locking source spelling.
assert count(r'\blet\s+selected\s*=\s*select_page_candidates\s*\(\s*candidates\s*,\s*query\s*,\s*cursor\.as_ref\(\)\s*,\s*limit\s*\)\s*;', derive) == 1
assert count(r'rows\s*\.into_iter\(\)\s*\.take\(limit\)', derive) == 1
assert count(r'materialize_selected_candidate\s*\(\s*selected\s*,\s*inputs\.metadata\s*\)\s*\.to_value\s*\(\s*\)', derive) == 1
assert source.count('rows.push(SelectedCandidate {') == selector.count('rows.push(SelectedCandidate {') == 1
assert source.count('counts.retained_descriptor_peak =') == selector.count('counts.retained_descriptor_peak =') == 1
assert source.count('counts.indexed_materializations += 1') == materializer.count('counts.indexed_materializations += 1') == 1
assert source.count('counts.synthesized_materializations += 1') == materializer.count('counts.synthesized_materializations += 1') == 1
assert source.count('counts.serializations += 1') == serializer.count('counts.serializations += 1') == 1
assert source.count('counts.owned_annotations += 1') == selector.count('counts.owned_annotations += 1') == 2

# Locked Tower/Axum mechanisms remain direct-poll, full-body, synchronous-JSON paths.
registry = Path('/home/dan/.cargo/registry/src')
def one(pattern: str) -> Path:
    matches = list(registry.glob(pattern))
    assert len(matches) == 1, (pattern, matches)
    return matches[0]

tower = one('*/tower-0.5.3/src/util/oneshot.rs').read_text(encoding='utf-8')
router = one('*/axum-0.8.9/src/routing/mod.rs').read_text(encoding='utf-8')
handler = one('*/axum-0.8.9/src/handler/service.rs').read_text(encoding='utf-8')
body = one('*/axum-0.8.9/src/body/mod.rs').read_text(encoding='utf-8')
json = one('*/axum-0.8.9/src/json.rs').read_text(encoding='utf-8')
assert 'ready!(svc.poll_ready(cx))?' in tower and 'ready!(fut.poll(cx))?' in tower
assert 'self.call_with_state(req, ())' in router
assert 'Handler::call(handler, req, self.state.clone())' in handler
assert 'IntoServiceFuture::new(future)' in handler
assert re.search(r'Limited::new\(body, limit\)\s*\.collect\(\)\s*\.await', body)
assert 'serde_json::to_writer(&mut buf, &self.0)' in json
print('static post-capture preparation locality/centrality proof: PASS')
PY
```

Expected: exit 0 and the explicit PASS line. The six named tests each define one TLS activation template, and every dynamic activation encloses exactly one fully awaited real route request before snapshot after full response-body completion; the seventh lifecycle-only test is excluded. The exhaustive oversized runtime matrix, not static source spelling, proves selector limiting for all valid limits and all no-search/title/deep modes. The lexical activation may include index/metadata offload. The handler-shape checks prove all four input captures precede the sole `derive_directory_page` call, with no await or recognized handoff from the final capture through the counted candidate derivation and snapshot release. Every recorder token is confined to the sole selector/materializer/serializer chain, and the local candidate block plus transcript helper is handoff-free. Therefore the TLS counts are admissible only for the post-capture bounded-work claim, not as evidence that the whole request is same-thread. If that post-capture invariant fails, stop; either restore synchronous counted derivation or replace TLS with a concrete request-carried/thread-safe probe.

- [ ] **Step 45: Rebuild and run the broad server package in one sandbox provenance bracket**

Run this indivisible shell process; do not split build, image capture, test, or postflight:

```bash
FRESHELL_VITEST_BACKEND=local bash <<'BASH'
set -euo pipefail

root=/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep
sandbox_test="${root}/scripts/sandbox-test.sh"
real_docker="$(type -P docker)"
tmp_dir=
wrapper=
iidfile=
expected_image_id=

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM

  if [ -n "${wrapper}" ] && [ -e "${wrapper}" ]; then
    rm -f -- "${wrapper}" || status=1
  fi
  if [ -n "${iidfile}" ] && [ -e "${iidfile}" ]; then
    rm -f -- "${iidfile}" || status=1
  fi
  if [ -n "${tmp_dir}" ] && [ -d "${tmp_dir}" ]; then
    rmdir -- "${tmp_dir}" || status=1
  fi
  exit "${status}"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

test -n "${real_docker}"
test -x "${real_docker}"
"${real_docker}" version >/dev/null
"${real_docker}" info >/dev/null

tmp_dir="$(mktemp -d /tmp/freshell-sandbox-provenance.XXXXXX)"
wrapper="${tmp_dir}/docker"
iidfile="${tmp_dir}/image.id"

cat >"${wrapper}" <<'WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = "build" ]; then
  echo "pinned sandbox runner refuses mutable-tag fallback builds" >&2
  exit 1
fi
real_docker="${FRESHELL_REAL_DOCKER:?}"
pinned_image_id="${FRESHELL_SANDBOX_IMAGE_ID:?}"
args=()
for arg in "$@"; do
  if [ "${arg}" = "freshell-sandbox:latest" ]; then
    args+=("${pinned_image_id}")
  else
    args+=("${arg}")
  fi
done
exec "${real_docker}" "${args[@]}"
WRAPPER
chmod 700 "${wrapper}"
bash -n "${wrapper}"

tag_count="$(grep -Fxc 'IMAGE_TAG="freshell-sandbox:latest"' "${sandbox_test}" || true)"
inspect_count="$(grep -Fxc 'if ! docker image inspect "${IMAGE_TAG}" >/dev/null 2>&1; then' "${sandbox_test}" || true)"
run_count="$(grep -Fxc 'docker "${DOCKER_ARGS[@]}" "${IMAGE_TAG}" bash -c "${CMD}" || DOCKER_STATUS=$?' "${sandbox_test}" || true)"
test "${tag_count}" -eq 1
test "${inspect_count}" -eq 1
test "${run_count}" -eq 1

"${real_docker}" build \
  --network=host \
  --build-arg "UID=$(id -u)" \
  --build-arg "GID=$(id -g)" \
  --iidfile "${iidfile}" \
  "${root}/docker/sandbox"

expected_image_id="$(cat "${iidfile}")"
test -n "${expected_image_id}"
built_image_id="$("${real_docker}" image inspect --format '{{.Id}}' "${expected_image_id}")"
test "${built_image_id}" = "${expected_image_id}"
printf 'sandbox_image_id=%s\n' "${expected_image_id}"

test_status=0
PATH="${tmp_dir}:${PATH}" \
FRESHELL_REAL_DOCKER="${real_docker}" \
FRESHELL_SANDBOX_IMAGE_ID="${expected_image_id}" \
"${sandbox_test}" "cargo test -p freshell-server --all-targets" || test_status=$?

actual_image_id="$("${real_docker}" image inspect --format '{{.Id}}' "${expected_image_id}")"
printf 'sandbox_image_id_after=%s\n' "${actual_image_id}"
test "${actual_image_id}" = "${expected_image_id}"
exit "${test_status}"
BASH
```

Expected: Docker preflight succeeds; the untagged worktree-context build succeeds; the `--iidfile` ID immediately resolves to that same full ID in the local Docker image store; the actual repository `sandbox-test.sh` wrapper runs `cargo test -p freshell-server --all-targets` with `docker run` receiving that full immutable ID; postflight still inspects the same full ID; all tests pass; owned wrapper/IID/temporary-directory artifacts clean successfully; the content-addressed image/cache is intentionally left to normal Docker policy with no image/tag deletion; and `freshell-sandbox:latest` is untouched. Any failure stops before commit. Never kill or remove a foreign process, container, tag, or image, and never substitute unsandboxed Cargo, a remote runner, narrowed targets, or a waiver.

- [ ] **Step 46: Commit the final-selector, oracle-cleanup, and combined-proof result**

The command below is one valid example for a coherent task-level source checkpoint; its subject and body are illustrative, not required history. If this task's mandatory spec/quality review or a later final check finds a defect, make any additional source-only correction commit needed and rerun the affected checks before advancing. Do not infer an exact commit count, subject sequence, or commit order from this example.

Run:

```bash
FRESHELL_VITEST_BACKEND=local bash -c 'git -C /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep diff --check -- crates/freshell-server/src/session_directory.rs && git -C /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep add -- crates/freshell-server/src/session_directory.rs && test "$(git -C /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep diff --cached --name-only)" = "crates/freshell-server/src/session_directory.rs" && git -C /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep commit -m "perf(session-directory): bound returned-page preparation" -m "Install the verified bounded selector, prove final eager parity, remove test-only oracle residue, finalize the counted output path, and retain combined static/runtime structural coverage." -m "Generated with Amplifier" -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"'
```

Expected: exit 0 and a normal local source-only commit. This commit is authorized only after the locked final assembly, post-cleanup literal/structural/focused tests, full-valid-domain runtime structural receipt, residue checks, static post-capture preparation locality/centrality receipt, and sandbox provenance bracket all pass.

### Task 7: Run final checks and prove exact scope

**Files:**
- Modify: none.
- Read/validate: `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/AGENTS.md`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/docs/plans/2026-08-13-session-directory-lazy-page-prep.md`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/Cargo.toml`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/Cargo.lock`, every tracked `Cargo.toml`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/.kata.toml`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/package.json`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/package-lock.json`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/docs/development/test-sandbox.md`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/scripts/sandbox-build.sh`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/scripts/sandbox-test.sh`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/scripts/testing/test-coordinator.ts`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/scripts/run-standard-tests.ts`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/crates/freshell-server/src/session_directory.rs`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/crates/freshell-sessions/src/directory_index.rs`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/crates/freshell-sessions/src/search.rs`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/crates/freshell-ws/src/identity.rs`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/test/e2e-browser/playwright.config.ts`, `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/test/e2e-browser/specs/session-directory-matrix.spec.ts`, and `/home/dan/code/freshell/node_modules/@playwright/test/cli.js`.
- Read/validate unchanged cross-router coverage: `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/crates/freshell-server/src/sessions_tests.rs`.

**Interfaces:**
- Consumes: Task 6's committed final source and all retained test interfaces.
- Produces: separate locked production and inline-test compiler receipts; the exact full-valid-limit runtime structural matrix and static post-capture preparation locality/centrality receipts against committed final `HEAD`; fresh focused, rebuilt-image sandbox package, dependency, format, lint, exact local browser-matrix, and fresh coordinator-owned local-suite pass evidence; plus single-policy/call-site, residue, exact-file-scope, forbidden-file, clean-state, and exact persisted coordinator-provenance evidence. Browser/Docker preflights and coordinator history are readiness/provenance only, never runtime pass evidence. No repository file changes.

- [ ] **Step 1: Compile the committed final production source against the lockfile**

Run:

```bash
FRESHELL_VITEST_BACKEND=local CARGO_TERM_COLOR=never cargo check --locked --manifest-path /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/Cargo.toml -p freshell-server
```

Expected: exit 0 against committed Task 6 source. This is the final production compiler receipt that can move LB-03 from accepted residual to runtime-confirmed. Any failure stops final readiness and reopens the one-file borrowed architecture; it never authorizes a fallback, adapter, API/manifest change, or second source file.

- [ ] **Step 2: Compile the committed final inline-test source against the lockfile**

Run:

```bash
FRESHELL_VITEST_BACKEND=local CARGO_TERM_COLOR=never cargo test --locked --manifest-path /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/Cargo.toml -p freshell-server --bin freshell-server --no-run
```

Expected: exit 0. This is the separate final inline `#[cfg(test)]` coexistence compiler receipt; failure has the same stop/reopen rule as Step 1.

- [ ] **Step 3: Run the complete focused behavior and runtime structural family**

Run:

```bash
FRESHELL_VITEST_BACKEND=local CARGO_TERM_COLOR=never cargo test --locked --manifest-path /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/Cargo.toml -p freshell-server --bin freshell-server session_directory -- --color=never --test-threads=1
```

Expected: exit 0 and no failed test. Report seven `preparation_tests` functions and all 203 measured route activations, including the exhaustive no-search/title/both-deep-tier valid-limit matrix, as the runtime structural leg separately from Step 15's static post-capture preparation locality/centrality leg. This workload is comparable with Task 1's focused local receipt.

- [ ] **Step 4: Rebuild and run the full server package in one sandbox provenance bracket**

Run this indivisible shell process; do not split build, image capture, test, or postflight:

```bash
FRESHELL_VITEST_BACKEND=local bash <<'BASH'
set -euo pipefail

root=/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep
sandbox_test="${root}/scripts/sandbox-test.sh"
real_docker="$(type -P docker)"
tmp_dir=
wrapper=
iidfile=
expected_image_id=

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM

  if [ -n "${wrapper}" ] && [ -e "${wrapper}" ]; then
    rm -f -- "${wrapper}" || status=1
  fi
  if [ -n "${iidfile}" ] && [ -e "${iidfile}" ]; then
    rm -f -- "${iidfile}" || status=1
  fi
  if [ -n "${tmp_dir}" ] && [ -d "${tmp_dir}" ]; then
    rmdir -- "${tmp_dir}" || status=1
  fi
  exit "${status}"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

test -n "${real_docker}"
test -x "${real_docker}"
"${real_docker}" version >/dev/null
"${real_docker}" info >/dev/null

tmp_dir="$(mktemp -d /tmp/freshell-sandbox-provenance.XXXXXX)"
wrapper="${tmp_dir}/docker"
iidfile="${tmp_dir}/image.id"

cat >"${wrapper}" <<'WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = "build" ]; then
  echo "pinned sandbox runner refuses mutable-tag fallback builds" >&2
  exit 1
fi
real_docker="${FRESHELL_REAL_DOCKER:?}"
pinned_image_id="${FRESHELL_SANDBOX_IMAGE_ID:?}"
args=()
for arg in "$@"; do
  if [ "${arg}" = "freshell-sandbox:latest" ]; then
    args+=("${pinned_image_id}")
  else
    args+=("${arg}")
  fi
done
exec "${real_docker}" "${args[@]}"
WRAPPER
chmod 700 "${wrapper}"
bash -n "${wrapper}"

tag_count="$(grep -Fxc 'IMAGE_TAG="freshell-sandbox:latest"' "${sandbox_test}" || true)"
inspect_count="$(grep -Fxc 'if ! docker image inspect "${IMAGE_TAG}" >/dev/null 2>&1; then' "${sandbox_test}" || true)"
run_count="$(grep -Fxc 'docker "${DOCKER_ARGS[@]}" "${IMAGE_TAG}" bash -c "${CMD}" || DOCKER_STATUS=$?' "${sandbox_test}" || true)"
test "${tag_count}" -eq 1
test "${inspect_count}" -eq 1
test "${run_count}" -eq 1

"${real_docker}" build \
  --network=host \
  --build-arg "UID=$(id -u)" \
  --build-arg "GID=$(id -g)" \
  --iidfile "${iidfile}" \
  "${root}/docker/sandbox"

expected_image_id="$(cat "${iidfile}")"
test -n "${expected_image_id}"
built_image_id="$("${real_docker}" image inspect --format '{{.Id}}' "${expected_image_id}")"
test "${built_image_id}" = "${expected_image_id}"
printf 'sandbox_image_id=%s\n' "${expected_image_id}"

test_status=0
PATH="${tmp_dir}:${PATH}" \
FRESHELL_REAL_DOCKER="${real_docker}" \
FRESHELL_SANDBOX_IMAGE_ID="${expected_image_id}" \
"${sandbox_test}" "cargo test -p freshell-server --all-targets" || test_status=$?

actual_image_id="$("${real_docker}" image inspect --format '{{.Id}}' "${expected_image_id}")"
printf 'sandbox_image_id_after=%s\n' "${actual_image_id}"
test "${actual_image_id}" = "${expected_image_id}"
exit "${test_status}"
BASH
```

Expected: Docker preflight succeeds; the untagged worktree-context build succeeds; the `--iidfile` ID immediately resolves to that same full ID in the local Docker image store; the actual repository `sandbox-test.sh` wrapper runs `cargo test -p freshell-server --all-targets` with `docker run` receiving that full immutable ID; postflight still inspects the same full ID; all tests pass; owned wrapper/IID/temporary-directory artifacts clean successfully; the content-addressed image/cache is intentionally left to normal Docker policy with no image/tag deletion; and `freshell-sandbox:latest` is untouched. Any failure stops final readiness. Never kill or remove a foreign process, container, tag, or image, and never substitute unsandboxed Cargo, a remote runner, narrowed targets, or a waiver.

- [ ] **Step 5: Run the direct sessions dependency regression**

Run:

```bash
FRESHELL_VITEST_BACKEND=local CARGO_TERM_COLOR=never cargo test --locked --manifest-path /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/Cargo.toml -p freshell-sessions
```

Expected: exit 0 and no failed test.

- [ ] **Step 6: Verify formatting**

Run:

```bash
FRESHELL_VITEST_BACKEND=local cargo fmt --manifest-path /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/Cargo.toml --all --check
```

Expected: exit 0 and no rustfmt diff.

- [ ] **Step 7: Run warnings-denied server Clippy**

Run:

```bash
FRESHELL_VITEST_BACKEND=local cargo clippy --locked --manifest-path /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/Cargo.toml -p freshell-server --all-targets -- -D warnings
```

Expected: exit 0 and no warning/error.

- [ ] **Step 8: Run warnings-denied workspace Clippy**

Run:

```bash
FRESHELL_VITEST_BACKEND=local cargo clippy --locked --manifest-path /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/Cargo.toml --workspace --all-targets -- -D warnings
```

Expected: exit 0 and no warning/error.

- [ ] **Step 9: Run warnings-denied Codex real-transport Clippy**

Run:

```bash
FRESHELL_VITEST_BACKEND=local cargo clippy --locked --manifest-path /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/Cargo.toml -p freshell-codex --features real-transport --all-targets -- -D warnings
```

Expected: exit 0.

- [ ] **Step 10: Run warnings-denied OpenCode real-transport Clippy**

Run:

```bash
FRESHELL_VITEST_BACKEND=local cargo clippy --locked --manifest-path /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/Cargo.toml -p freshell-opencode --features real-transport --all-targets -- -D warnings
```

Expected: exit 0.

- [ ] **Step 11: Run the fail-closed local-browser readiness preflight**

Run the same full preflight as Task 1 immediately before the final matrix:

```bash
FRESHELL_VITEST_BACKEND=local bash -c '
set -euo pipefail
root=/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep
for name in FRESHELL_E2E_TARGET_URL FRESHELL_E2E_TARGET_TOKEN FRESHELL_E2E_TARGET_WS_URL FRESHELL_E2E_TARGET_HOME FRESHELL_E2E_RUST_SERVER_BIN CARGO_TARGET_DIR PLAYWRIGHT_BROWSERS_PATH; do
  test -z "${!name-}" || { echo "unexpected routing override: ${name}" >&2; exit 1; }
done
test -f /home/dan/code/freshell/node_modules/@playwright/test/cli.js
node -e "
const fs = require(\"fs\");
const lock = JSON.parse(fs.readFileSync(\"${root}/package-lock.json\", \"utf8\"));
for (const p of [\"node_modules/@playwright/test\", \"node_modules/playwright\", \"node_modules/playwright-core\"]) {
  if (lock.packages[p]?.version !== \"1.58.2\") throw new Error(p + \" lock mismatch\");
}
const installed = require(\"/home/dan/code/freshell/node_modules/@playwright/test/package.json\").version;
if (installed !== \"1.58.2\") throw new Error(\"installed Playwright mismatch: \" + installed);
"
for exe in \
  /home/dan/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome \
  /home/dan/.cache/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell; do
  test -x "$exe"
  ldd_output="$(ldd "$exe")" || exit 1
  if grep -q "not found" <<<"$ldd_output"; then echo "unresolved library: $exe" >&2; exit 1; fi
done
command -v cargo rustc cc gcc g++ ar ranlib make pkg-config perl python3 ldd >/dev/null
rustup target list --installed | grep -Fx x86_64-unknown-linux-gnu >/dev/null
cargo --version
rustc --version
df -h "$root"
grep "^MemAvailable:" /proc/meminfo
'
```

Expected: exit 0 with the same routing/build overrides absent, exact installed/locked Playwright 1.58.2, both Chromium revision-1208 executables, no unresolved libraries, Cargo/Rust 1.96 and native Linux tools available, and resource state printed without a threshold. This is readiness only, not browser-pass evidence.

- [ ] **Step 12: Run the exact local Rust-backed browser matrix**

Run:

```bash
FRESHELL_VITEST_BACKEND=local env --chdir=/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep FRESHELL_E2E_BACKEND=local node /home/dan/code/freshell/node_modules/@playwright/test/cli.js test --config /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/test/e2e-browser/playwright.config.ts --project=rust-chromium --workers=1 --reporter=line /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep/test/e2e-browser/specs/session-directory-matrix.spec.ts
```

Expected: exit 0 and every existing matrix case passes. This exact workload is comparable with Task 1's matrix receipt. Any compile, launch, server, Chromium, or case failure stops; do not install, reroute, use a remote runner, narrow the matrix, or waive it.

- [ ] **Step 13: Inspect the local coordinator holder without treating history as this run**

Run:

```bash
FRESHELL_VITEST_BACKEND=local env --chdir=/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep INIT_CWD=/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep PWD=/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep npm --prefix /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep run test:status
```

Expected: exit 0 and truthful holder state. If another holder is active, wait and rerun this command; never kill or bypass it. Readiness/history cannot satisfy Step 14.

- [ ] **Step 14: Run a fresh coordinator-owned local full suite**

Run:

```bash
FRESHELL_VITEST_BACKEND=local FRESHELL_TEST_SUMMARY="session-directory lazy-page final local full suite" env --chdir=/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep INIT_CWD=/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep PWD=/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep npm --prefix /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep test
```

Expected: fresh coordinator-owned exit 0 from the target worktree and committed final `HEAD`, with output containing `Resolved standard test plan` and not containing `Dispatching client+server suites to cloud vitest`. Advisory history is not a substitute, and final acceptance also requires Step 20's exact persisted `byKey.test` receipt assertion. The focused, browser, and coordinator workloads are comparable with Task 1 because both receipts use the same exact local backends; a failure in a non-baselined final command may require a targeted frozen-base reproduction rather than a retroactive baseline claim.

- [ ] **Step 15: Repeat the mandatory static post-capture preparation locality and centrality proof against committed final `HEAD`**

Run the same hard source-shape and locked-dependency gate as Task 6:

```bash
FRESHELL_VITEST_BACKEND=local python3 - <<'PY'
from pathlib import Path
import re

root = Path('/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep')
source = (root / 'crates/freshell-server/src/session_directory.rs').read_text(encoding='utf-8')
search = (root / 'crates/freshell-sessions/src/search.rs').read_text(encoding='utf-8')

def count(pattern: str, text: str = source) -> int:
    return len(re.findall(pattern, text, flags=re.MULTILINE | re.DOTALL))

def braced_region(text: str, marker: str) -> str:
    assert text.count(marker) == 1, (marker, text.count(marker))
    start = text.index(marker)
    opening = text.index('{', start)
    depth = 0
    for end in range(opening, len(text)):
        if text[end] == '{':
            depth += 1
        elif text[end] == '}':
            depth -= 1
            if depth == 0:
                return text[start:end + 1]
    raise AssertionError(f'unclosed braced region: {marker}')

def only_position(text: str, needle: str) -> int:
    assert text.count(needle) == 1, (needle, text.count(needle))
    return text.index(needle)

# Exactly six named work-bound tests define one activation template per named test;
# each dynamic case surrounds exactly one fully awaited real route request. The
# interval may include acquisition-time offload. The seventh current-thread test
# is explicitly the lifecycle/reset-only test.
request_tests = (
    'no_search_materializes_only_returned_indexed_rows',
    'no_search_materializes_only_returned_synthesized_rows',
    'filtered_and_cursor_prefixes_do_not_expand_full_preparation',
    'all_hidden_page_materializes_nothing_and_keeps_revision',
    'sparse_title_search_retains_only_limit_plus_one_annotations',
    'deep_search_retains_only_limit_plus_one_annotations',
)
lifecycle_test = 'preparation_scope_resets_and_is_inactive_outside_interval'
preparation = braced_region(source, '    mod preparation_tests {')
current_thread_tests = re.findall(
    r'#\[tokio::test\(flavor = "current_thread"\)\]\s*async fn ([a-z0-9_]+)\(\)',
    preparation,
)
assert current_thread_tests == [*request_tests, lifecycle_test]
assert source.count('#[tokio::test(flavor = "current_thread")]') == len(current_thread_tests) == 7
assert 'tokio::test(flavor = "multi_thread")' not in source
assert lifecycle_test not in request_tests
lifecycle_body = braced_region(preparation, f'        async fn {lifecycle_test}()')
assert lifecycle_body.count('PreparationScope::begin()') == 5
assert 'catch_unwind(PreparationScope::begin)' in lifecycle_body

awaited_request = re.compile(
    r'\bget_page(?:_with_bytes)?\s*\([^;]*?\)\s*\.await\b',
    flags=re.DOTALL,
)
for test_name in request_tests:
    test_body = braced_region(preparation, f'        async fn {test_name}()')
    begin = only_position(test_body, 'let scope = PreparationScope::begin();')
    snapshot = only_position(test_body, 'scope.snapshot()')
    requests = list(awaited_request.finditer(test_body, begin, snapshot))
    assert len(requests) == 1, (test_name, len(requests))
    request = requests[0]
    assert begin < request.start() < request.end() < snapshot, test_name
assert source.count('let counts = scope.snapshot();') == 6

# The route helper directly polls one request and fully collects its body before returning.
bytes_helper = braced_region(source, '    async fn get_page_with_bytes(')
page_helper = braced_region(source, '    async fn get_page(')
assert bytes_helper.count('.oneshot(') == 1
assert bytes_helper.count('to_bytes(response.into_body(), usize::MAX)') == 1
assert bytes_helper.index('.oneshot(') < bytes_helper.index('to_bytes(') < bytes_helper.index('serde_json::from_slice')
assert page_helper.count('get_page_with_bytes(app, suffix).await.0') == 1

# Restrict exhaustive centrality checks to non-test production. The migrated
# join-test module and sole direct parser constructor are proved cfg(test) and excluded.
tests_marker = '\n#[cfg(test)]\nmod tests {'
assert source.count(tests_marker) == 1
production_region = source[:source.index(tests_marker)]
join_tests = braced_region(production_region, '#[cfg(test)]\nmod join_tests {')
test_only_parser = braced_region(production_region, '#[cfg(test)]\nfn item_from_meta(')
constructor_pattern = r'(?<!struct )(?<!impl )(?<!-> )\bDirItem\s*\{'
assert join_tests.startswith('#[cfg(test)]')
assert test_only_parser.startswith('#[cfg(test)]')
assert count(constructor_pattern, test_only_parser) == 1
production = production_region.replace(join_tests, '', 1).replace(test_only_parser, '', 1)
production_code = '\n'.join(line.split('//', 1)[0] for line in production.splitlines())

route = braced_region(production, 'async fn session_directory(')
provider_name = braced_region(production, 'fn provider_display_name(')
selector = braced_region(production, "fn select_page_candidates<'a>(")
materializer = braced_region(production, 'fn materialize_selected_candidate(')
derive = braced_region(production, 'fn derive_directory_page(')
dir_item_impl = braced_region(production, 'impl DirItem {')
serializer = braced_region(dir_item_impl, '    fn to_value(&self) -> Value {')

# The TLS activation surrounds the full request, but counted work starts only
# after all independent input captures and remains in synchronous derivation.
index_capture = only_position(route, 'Some(index) => Some(index.snapshot().await),')
overrides_capture = only_position(route, 'let overrides = state.settings.session_overrides();')
metadata_capture = only_position(route, 'let metadata = state.metadata.get_all().await;')
identities_capture = only_position(route, 'let identities = state.identity.list();')
derive_call = only_position(route, 'derive_directory_page(')
snapshot_release = only_position(route, 'drop(snapshot);')
assert (
    index_capture
    < overrides_capture
    < metadata_capture
    < identities_capture
    < derive_call
    < snapshot_release
)
post_capture_route = route[identities_capture:snapshot_release]
assert post_capture_route.count('derive_directory_page(') == 1
assert '.await' not in post_capture_route

# Scan the complete local candidate-function block, the serializer, and the
# external synchronous transcript module. Index/metadata acquisition is
# intentionally outside this no-handoff claim and may offload.
candidate_start = only_position(production, "fn resolve_indexed_overlay<'a>(")
candidate_end = production.index(derive) + len(derive)
candidate_region = production[candidate_start:candidate_end]
offload = re.compile(
    r'\b(?:spawn_blocking|block_in_place|tokio::(?:task::)?spawn|std::thread(?:\s*::|\b))'
)
assert re.search(r'\basync\s+fn\b|\.await\b', candidate_region) is None
assert offload.search(post_capture_route) is None
assert offload.search(provider_name) is None
assert offload.search(candidate_region) is None
assert offload.search(serializer) is None
assert offload.search(search) is None

# Exact-one policy definitions and exhaustive production references/call sites.
assert count(r'^fn compare_directory_order\(', production) == 1
assert count(r'^fn candidate_is_eligible\(', production) == 1
assert count(r'^fn select_page_candidates', production) == 1
assert count(r'^fn materialize_selected_candidate\(', production) == 1
assert count(r'^fn derive_directory_page\(', production) == 1
assert count(r'^impl DirItem\s*\{', production) == 1
assert count(r'^[ \t]+fn to_value\(', production) == 1
assert count(r'\bselect_page_candidates\b', production_code) == 2
assert count(r'\bmaterialize_selected_candidate\b', production_code) == 2
assert count(r'\bderive_directory_page\b', production_code) == 2
assert count(r'\bto_value\b', production_code) == 2
assert count(r'\bselect_page_candidates\s*\(', production_code) == 1
assert count(r'\bselect_page_candidates\s*\(', derive) == 1
assert count(r'(?<!fn )\bmaterialize_selected_candidate\s*\(', production_code) == 1
assert count(r'(?<!fn )\bmaterialize_selected_candidate\s*\(', derive) == 1
assert count(r'(?<!fn )\bderive_directory_page\s*\(', production_code) == 1
assert count(r'(?:\.|DirItem::)\s*to_value\s*\(', production_code) == 1
assert count(r'(?:\.|DirItem::)\s*to_value\s*\(', derive) == 1
assert count(constructor_pattern, production_code) == 2
assert count(constructor_pattern, materializer) == 2
assert count(r'->\s*DirItem\b', production_code) == 1
assert count(r'->\s*DirItem\b', materializer) == 1
assert count(r'impl\s+(?:serde::)?Serialize\s+for\s+DirItem\b', production_code) == 0
assert count(r'#\[derive\([^\]]*\bSerialize\b[^\]]*\)\]\s*struct DirItem', production_code) == 0
assert count(r'\bto_value\b', serializer) == 1

# Exhaustive oversized runtime cases prove limiter semantics; this section proves
# the exact canonical chain and counter-site centrality without locking source spelling.
assert count(r'\blet\s+selected\s*=\s*select_page_candidates\s*\(\s*candidates\s*,\s*query\s*,\s*cursor\.as_ref\(\)\s*,\s*limit\s*\)\s*;', derive) == 1
assert count(r'rows\s*\.into_iter\(\)\s*\.take\(limit\)', derive) == 1
assert count(r'materialize_selected_candidate\s*\(\s*selected\s*,\s*inputs\.metadata\s*\)\s*\.to_value\s*\(\s*\)', derive) == 1
assert source.count('rows.push(SelectedCandidate {') == selector.count('rows.push(SelectedCandidate {') == 1
assert source.count('counts.retained_descriptor_peak =') == selector.count('counts.retained_descriptor_peak =') == 1
assert source.count('counts.indexed_materializations += 1') == materializer.count('counts.indexed_materializations += 1') == 1
assert source.count('counts.synthesized_materializations += 1') == materializer.count('counts.synthesized_materializations += 1') == 1
assert source.count('counts.serializations += 1') == serializer.count('counts.serializations += 1') == 1
assert source.count('counts.owned_annotations += 1') == selector.count('counts.owned_annotations += 1') == 2

# Locked Tower/Axum mechanisms remain direct-poll, full-body, synchronous-JSON paths.
registry = Path('/home/dan/.cargo/registry/src')
def one(pattern: str) -> Path:
    matches = list(registry.glob(pattern))
    assert len(matches) == 1, (pattern, matches)
    return matches[0]

tower = one('*/tower-0.5.3/src/util/oneshot.rs').read_text(encoding='utf-8')
router = one('*/axum-0.8.9/src/routing/mod.rs').read_text(encoding='utf-8')
handler = one('*/axum-0.8.9/src/handler/service.rs').read_text(encoding='utf-8')
body = one('*/axum-0.8.9/src/body/mod.rs').read_text(encoding='utf-8')
json = one('*/axum-0.8.9/src/json.rs').read_text(encoding='utf-8')
assert 'ready!(svc.poll_ready(cx))?' in tower and 'ready!(fut.poll(cx))?' in tower
assert 'self.call_with_state(req, ())' in router
assert 'Handler::call(handler, req, self.state.clone())' in handler
assert 'IntoServiceFuture::new(future)' in handler
assert re.search(r'Limited::new\(body, limit\)\s*\.collect\(\)\s*\.await', body)
assert 'serde_json::to_writer(&mut buf, &self.0)' in json
print('static post-capture preparation locality/centrality proof: PASS')
PY
```

Expected: exit 0 and the explicit PASS line. The six named tests each define one TLS activation template, and every dynamic activation encloses exactly one fully awaited real route request before snapshot after full response-body completion; the seventh lifecycle-only test is excluded. The exhaustive oversized runtime matrix, not static source spelling, proves selector limiting for all valid limits and all no-search/title/deep modes. The lexical activation may include index/metadata offload. The handler-shape checks prove all four input captures precede the sole `derive_directory_page` call, with no await or recognized handoff from the final capture through the counted candidate derivation and snapshot release. Every recorder token is confined to the sole selector/materializer/serializer chain, and the local candidate block plus transcript helper is handoff-free. Therefore the TLS counts are admissible only for the post-capture bounded-work claim, not as evidence that the whole request is same-thread. If that post-capture invariant fails, stop; either restore synchronous counted derivation or replace TLS with a concrete request-carried/thread-safe probe.

- [ ] **Step 16: Prove eager policy functions are absent from `HEAD`**

Run:

```bash
FRESHELL_VITEST_BACKEND=local bash -c 'git -C /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep grep -n -E "^fn (dir_item_from_indexed|apply_session_overrides|apply_session_metadata|join_running_state|build_live_terminal_session_item|join_live_terminals|apply_query|apply_file_search|apply_title_search|derive_eager_oracle_page)\\(" HEAD -- crates/freshell-server/src/session_directory.rs; test "$?" -eq 1'
```

Expected: no output and exit 0.

- [ ] **Step 17: Prove obsolete helpers and all temporary differential support are absent from `HEAD`**

Run:

```bash
FRESHELL_VITEST_BACKEND=local bash -c 'git -C /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep grep -n -E "FileSearchOutcome|derive_eager_oracle_page|DifferentialFixture|DeterministicLcg|DIFFERENTIAL_SEEDS|seeded_differential_fixture|seeded_differential_fixture_variants|differential_visibility_cases|differential_query_cases|differential_limits|differential_cursors|fixed_deep_partial_cases|candidate_path_matches_eager_oracle_across_seeded_cross_product|deep_search_dir_item|guard_item|overlaid_title" HEAD -- crates/freshell-server/src/session_directory.rs; test "$?" -eq 1'
```

Expected: no output and exit 0. This is the same complete residue-name set used by Task 6 after final-selector parity.

- [ ] **Step 18: Prove exact final base scope is plan plus Rust source**

Run:

```bash
FRESHELL_VITEST_BACKEND=local bash -c 'diff -u <(printf "%s\n" "crates/freshell-server/src/session_directory.rs" "docs/plans/2026-08-13-session-directory-lazy-page-prep.md") <(git -C /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep diff --name-only 225a91db3e4d48d4b6a7e8bc0987afad8ff31917 HEAD)'
```

Expected: exit 0 and no output. This intentionally includes the already-committed plan; source alone is not the expected final scope.

- [ ] **Step 19: Prove forbidden manifests, configuration, and languages did not drift**

Run:

```bash
FRESHELL_VITEST_BACKEND=local bash -o pipefail -c "git -C /home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep diff --name-only 225a91db3e4d48d4b6a7e8bc0987afad8ff31917 HEAD | awk '/(^|\\/)Cargo\\.toml$|^Cargo\\.lock$|(^|\\/)\\.kata\\.toml$|^package(-lock)?\\.json$|\\.(ts|tsx|js|jsx)$/{print; bad=1} END{exit bad}'"
```

Expected: exit 0 and no output.

- [ ] **Step 20: Prove the worktree is clean and the final coordinator receipt has exact provenance**

Run:

```bash
FRESHELL_VITEST_BACKEND=local bash -c '
set -euo pipefail
root=/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep
summary="session-directory lazy-page final local full suite"
test -z "$(git -C "$root" status --porcelain=v1 --untracked-files=all)"
head="$(git -C "$root" rev-parse HEAD)"
record="$(git -C "$root" rev-parse --path-format=absolute --git-common-dir)/freshell-test-coordinator/command-runs.json"
ROOT="$root" HEAD="$head" SUMMARY="$summary" RECORD="$record" python3 - <<PY
import json
import os
from pathlib import Path

root = os.environ["ROOT"]
head = os.environ["HEAD"]
summary = os.environ["SUMMARY"]
record = json.loads(
    Path(os.environ["RECORD"]).read_text(encoding="utf-8")
)["byKey"]["test"]
assert record["summary"] == summary, record
assert record["summarySource"] == "env", record
assert record["outcome"] == "success", record
assert record["exitCode"] == 0, record
assert record["entrypoint"] == {"commandKey": "test", "suiteKey": "full-suite"}, record
assert record["command"] == {"display": "npm test", "argv": ["test"]}, record
repo = record["repo"]
assert repo["invocationCwd"] == root, repo
assert repo["checkoutRoot"] == root, repo
assert repo["worktreePath"] == root, repo
assert repo["commit"] == head, repo
assert repo["isDirty"] is False, repo
print("coordinator receipt provenance: PASS")
PY
'
```

Expected: exit 0 with clean status and the exact line `coordinator receipt provenance: PASS`, machine-proving the unique environment-sourced final summary, successful exit-0 `test`/`full-suite`, exact `npm test` command shape, exact target `invocationCwd`/`checkoutRoot`/`worktreePath`, contemporaneous final `HEAD`, and `isDirty=false` from persisted `command-runs.json.byKey.test`. No readiness, historical, focused-only, or preflight result substitutes for any required runtime gate. Do not inspect or enforce commit count, commit subjects, or commit order.

## Self-Review Checklist and Results

- [x] **1. Spec coverage:** Re-ran coverage against the Iteration 3-corrected plan and the original requirements plus LB-01/LB-03/LB-05/LB-06/LB-08/LB-09/LB-10. Exactly seven Tasks remain. Task 6 Step 8 now anchors its temporary counter at the real legacy serializer statement `let mut o = Map::new();`; Task 6 Step 26 now replaces the complete legacy `impl DirItem`, explicitly removing both the private `key` method and `to_value` before installing the already-specified final counted serializer. Task 4's RED qualifies `std::cmp::Ordering::Greater` before the later production import. All five Task 1/7 coordinator invocations pin real cwd, `INIT_CWD`, `PWD`, and npm prefix, while Task 1 Step 8 and Task 7 Step 20 machine-prove persisted receipts. Task 6/7 sandbox brackets build from the worktree without creating a Docker tag, pass the exact `--iidfile` image ID to the real sandbox runner, and never use shared `latest` for provenance or selection. LB-08 retains both mandatory legs: six named real-route request tests execute a 203-case matrix that exhausts every valid limit on oversized no-search/title/both-deep-tier corpora, while byte-identical Task 6/7 static proofs establish post-capture locality/centrality; the seventh test function remains lifecycle-only. No amended requirement lacks a task.
- [x] **1b. No silent deferrals of required behavior:** This Iteration 3 document-only review verifies the corrected Task 6 Step 8 legacy anchor and Step 26 whole-implementation replacement instruction; it does not prove product behavior. The future real-route matrix, Rust compile/lint gates, exact structural/focused/runtime suites, sandbox workload, and coordinator receipt gates remain required execution evidence. Task 4's real compiler RED must reach only the intentionally absent candidate symbols. Coordinator status remains readiness-only; acceptance requires the fresh local suite plus persisted exact target-worktree/current-HEAD receipt. Docker readiness/build/inspection alone is not package evidence; the exact `--iidfile` ID from each worktree-context build is passed as the `docker run` image reference while the real `scripts/sandbox-test.sh` executes the all-target workload. TLS/counter sites alone are not work-bound proof; the runtime leg exhausts limits 1-50 on `MAX_DIRECTORY_PAGE_ITEMS + 2` corpora for no-search, title, `userMessages`, and `fullText`, and the static companion proves capture-before-derive ordering, counted-region locality, recorder-site confinement, direct polling, and full-body completion without substituting source spelling for limiter semantics. Pre-cutover compilation, unbounded differentials, and pre-deletion parity do not substitute for later production gates. No product/runtime gate was executed during this document review, and no fake, preflight, seam, mutable tag, static-only check, or future-only substitute is claimed as execution evidence.
- [x] **2. Placeholder and stale-claim scan:** Re-ran the full-plan scan for prohibited deferred markers, vague implementation instructions, moved/undefined names, remote-backend execution, stale oracle timing, TLS-only proof, premature green claims, and unbracketed sandbox work. The stale future-only Step 8 anchor `let mut object = Map::new();` is absent from the temporary-serializer instruction, and the ambiguous method-only Step 26 replacement wording that could retain `DirItem::key` is absent; Step 8 names legacy `o`, while Step 26 explicitly replaces the whole legacy implementation including `key`. The Task 4 RED has no premature unqualified comparison ordering; every coordinator command pins provenance inputs; no claim treats mutable-tag endpoint equality as container identity; and no static-proof or self-review wording assigns full limiter semantics to counter placement or limits 1-2. Both static scripts use the scoped PASS label and receipt, allow acquisition-time offload, and omit obsolete whole-source or limiter-spelling assertions. Fresh product/runtime gates remain pending execution.
- [x] **3. Type/signature/lifecycle consistency:** Rechecked Tasks 3-7 in execution order. Task 6 Step 8 instruments the still-legacy `to_value` before `let mut o = Map::new();`; Step 26 then replaces the complete legacy `impl DirItem`, explicitly deleting `DirItem::key` and moving the serializer to its final `let mut object = Map::new();` body before Step 32 replaces the retained `Comparable` projection with direct provider/session formatting and before the final compile/lint/runtime gates. The neighboring `IndexedSession::key` lifecycle remains unchanged. Task 4's fully qualified RED expression coexists with the later sole production `cmp::Ordering` import and unqualified production uses. All five coordinator invocations use the same target cwd/`INIT_CWD`/`PWD`/prefix contract, and both persisted receipt bodies assert the same record schema with task-specific summaries. The Task 6/7 sandbox brackets are byte-identical from the untagged worktree build and `--iidfile` through immediate local-ID validation, wrapper substitution, immutable-ID postflight, status propagation, and filesystem-only cleanup; no image/tag deletion is attempted. The Task 6/7 Python proof bodies are byte-identical: each named request function has one syntactic activation template despite dynamic loops; all symbols are defined before use; capture order, sole-chain, counter-site, direct-poll, and full-body checks remain intact; and no brittle limiter regex was added. Seven current-thread Rust test functions remain while six named functions execute 203 measured route cases. The final-selector, oracle-deletion, final `DirItem`, parser/`Comparable`, locked-assembly, exact-one-signature, monotonic-step, and path-prefixed command lifecycles remain consistent.
- [x] **Mandatory structure and task boundaries:** The workflow execute-stage header, goal, architecture, tech stack, global constraints, file map, dependency order, and exactly seven numbered Tasks are present. Task 1 and Task 7 are validation-only; Task 5 ends with the eager oracle intact; Task 6 alone proves the final selector, deletes the oracle, finalizes output, and proves bounds.
- [x] **Bite-sized execution:** Task 5 and Task 6 step numbers are monotonic. Module shells, cohesive helper groups, individual tests, production functions/types, independent commands, and commits remain separate. The two sandbox provenance brackets are the documented narrow exception: each indivisible bracket builds without a Docker tag, records the exact `--iidfile` ID, pins the real sandbox runner to that full ID, fail-closed cleans only its wrapper/IID/temporary-directory artifacts, and intentionally leaves the content-addressed image/cache to normal Docker policy.
- [x] **Supported concurrency contract:** Snapshots/values are independent and sequential in accessor order, never an atomic cross-store instant. Overlapping writes and old projection/read race windows are unspecified; no race test freezes one allowed outcome. `revision` is full-corpus candidate/identity recency, not a cross-store version. Every deterministic candidate/override/metadata/live-join/order/cursor/visibility/search/partial/page obligation remains exact for fixed captured inputs and non-overlapping operations.
- [x] **One borrowed architecture and compiler residual:** The plan retains one borrowed candidate representation in one source file. Compiler failure is a fail-closed stop and architecture-reopen condition, never authorization for an owned fallback, adapter, manifest/public/store/index API change, or second file. Locked stop-gates exist before and immediately after cutover, after final assembly, and at Task 7 start.
- [x] **Combined work-bound proof:** At most `limit + 1` descriptors/owned annotations and exactly `limit` materializations/serializations on full pages require both the full-valid-domain real-route runtime matrix and the mandatory static post-capture preparation locality/centrality proof. Six named request functions execute 203 measured cases: 50 no-search indexed, three focused single cases, 50 title, and 100 deep across `userMessages`/`fullText`; every bound-stressing corpus has `MAX_DIRECTORY_PAGE_ITEMS + 2` eligible/matching rows, and each dynamic matrix case establishes one activation interval (`begin < fully awaited request < snapshot`). The seventh function is lifecycle-only. Runtime evidence proves selector-limit semantics; the static gate proves all captures precede the sole synchronous derivation, no await or recognized handoff occurs in the post-capture counted route/candidate region or transcript helper, every counter site is confined to the sole selector/materializer/serializer chain, and Tower/Axum polling is direct with full-body completion before snapshot. Acquisition-time offload is allowed, TLS alone is inadmissible, and Tasks 6 and 7 contain the same byte-identical static proof body plus the same runtime suite.
- [x] **Assertion and oracle sequencing:** All existing behavior/data-model/lookahead assertions remain. The exact final selector is unchanged. The final 2,884-case parsed/byte differential runs after that selector and before oracle deletion with no intervening production edit; exact route, structural, and focused gates run before deletion, and locked compile plus exact literal bytes, structural, page-bound, and focused gates rerun after final output cleanup.
- [x] **Helper lifecycle and residue:** Task 5 consumes Task 3's single definitions of `encode_raw_cursor_payload`, `write_nonmatching_claude_transcript`, and `deep_search_query` without redefining them; its complete import replacement preserves Base64 method resolution through Task 4's parent-module `Engine as _` import and `use super::*;` without leaving a redundant direct test-local import. Task 6 deletes eager helpers and all differential support only after final-selector parity; Step 26's whole-`impl DirItem` replacement removes the private `DirItem::key`, Step 32 replaces its retained `Comparable` use with direct formatting without removing `IndexedSession::key`, and the same complete residue-name set is repeated by Task 7 against `HEAD`.
- [x] **Command and backend discipline:** Every runnable shell fence begins with `FRESHELL_VITEST_BACKEND=local`, is self-contained, and uses absolute paths or `git -C`. All coordinator npm calls pin the target as real cwd, `INIT_CWD`, `PWD`, and prefix; Task 1/7 receipt closes assert exact persisted paths, commit, clean state, summary source, entrypoint, command, outcome, and exit code. No raw Vitest command, remote-wrapper execution dependency, caller-directory assumption, unsandboxed broad package fallback, narrowed substitute, or waiver appears. Task 1 and Task 7 use comparable local focused/browser/coordinator workloads.
- [x] **Scope and workflow discipline:** No manifest, lockfile, kata configuration, package file, TypeScript, or JavaScript edit is planned. Task 7 expects exactly the plan plus `crates/freshell-server/src/session_directory.rs` from the frozen base. Local commit examples do not prescribe history, and no push, pull request, merge, deployment, or restart is included.
- [x] **Residual-risk control, not pre-execution attestation:** LB-05, LB-06, LB-08, and LB-10 are corrected in the plan by the explicit post-capture counted-region boundary, final-selector oracle sequencing, full-valid-domain oversized-corpus runtime matrix plus static locality/centrality, immutable sandbox-image pinning, exact coordinator provenance receipts, and mandatory local backend. LB-01, LB-03, and LB-09 remain accepted residuals pending their exact fail-closed execution gates. This document review does not claim those runtime gates have passed; no requirement is deferred or waived.
