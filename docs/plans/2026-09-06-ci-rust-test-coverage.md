# CI Rust Test Coverage Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Per-PR CI runs the Rust cargo test suites and the Tauri app-bound Rust server-spawn smoke test, keeping required-check wall time fast; no CI scope creep beyond wiring existing suites.

### Explicit constraints
- Keep required-check wall time fast (new job runs in parallel, not serial)
- No CI scope creep beyond wiring existing test suites into CI
- Do not restart the self-hosted production server (port 3001)
- Follow the-usual workflow (TDD, fresh-eyes review, worktree discipline)

### Accepted tradeoffs and residuals
- Pre-existing flaky timing tests may occasionally fail in CI — accepted as known pre-existing flakes, all pass on re-run:
  - `auto_resume_e2e::reconcile_after_replacement_attaches_to_the_new_terminal` (freshell-ws) — timing-sensitive, passes in isolation
  - `claude::tests::the_prior_turns_terminal_edge_during_the_compact_write_window_folds_against_the_armed_tracker` (freshell-freshagent) — timing-sensitive, passes in isolation
  - `ETXTBSY` race in `sleeper_cli_spec` (freshell-ws/tests/common/mod.rs:92) — `std::fs::write` to a `{name}-{pid}` shared path fails when another parallel test is executing the script. Observed on CI (PR #699 run 33943201442, 2026-09-05). Retry procedure: re-run the failed job (GitHub Actions "Re-run failed jobs" button). Fixing the race (unique path per call) is a separate task, not in scope for this PR.
- Making the new `rust-test` check a required merge gate requires a post-merge ruleset amendment (ruleset 14473229, precedent: clippy-debt plan Task 9 Step 5) — documented here but is a separate user follow-up, not part of this PR
- Open PR #699 ("Retire the Node server in favor of Rust", 100 files, CONFLICTING/DIRTY, failing clippy, no reviews) also modifies `.github/workflows/rust-clippy.yml` to add `cargo test --workspace --locked` and the Tauri smoke. This PR extracts just the CI workflow change so it lands independently and quickly. When PR #699 eventually merges, it should drop `rust-clippy.yml` from its diff (the changes will already be on main). The user should be aware of this overlap.

**Goal:** Every PR runs the full Rust workspace test suite (`cargo test --workspace --locked`) and the Tauri app-bound server-spawn smoke test in CI, as a parallel job alongside the existing clippy gate.

**Architecture:** Add a `rust-test` job to the existing `.github/workflows/rust-clippy.yml` workflow. The job reuses the same pinned toolchain (1.96.0), `Swatinem/rust-cache@v2`, and Tauri GTK/WebKit apt dependencies as the `clippy` job. It adds `npm ci` (needed because `freshell-freshagent` tests spawn MCP servers that require `tsx` from `node_modules`), explicitly builds `freshell-server` (so the Tauri smoke cannot soft-skip), sets `FRESHELL_SERVER_BIN` to the built binary path, runs `cargo test --workspace --locked`, then runs the Tauri smoke with `--nocapture` so the CI log visibly confirms "using server binary:" (non-vacuous). The job runs concurrently with `clippy` under the same workflow, so required-check wall time does not grow. The new check will display as "Rust Clippy / rust-test" in the GitHub UI.

**Tech Stack:** GitHub Actions, Rust 1.96.0 (pinned), `Swatinem/rust-cache@v2`, `actions/setup-node@v4`, `npm ci`, `cargo test --workspace --locked`, `cargo build -p freshell-server --locked`.

## Global Constraints

- **Toolchain pin:** Rust 1.96.0 via `dtolnay/rust-toolchain@master` — must match the existing `clippy` job and workspace `rust-version`.
- **Cache:** `Swatinem/rust-cache@v2` — keys on the job id by default (`add-job-id-key: true`), so `rust-test` gets its own cache separate from `clippy` (correct: clippy check artifacts and test codegen artifacts differ). No `shared-key` override needed.
- **Tauri system deps:** The exact same 8 apt packages as the `clippy` job (`libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev librsvg2-dev libayatana-appindicator3-dev pkg-config build-essential`) — needed to compile `freshell-tauri`. `libdbus-1-dev` (added by PR #699) is not needed on origin/main (the `dbus` crate is a transitive dep of tauri, but the existing clippy job compiles without it — it's pre-installed on ubuntu-latest).
- **Node.js:** `actions/setup-node@v4` with `node-version: 22` and `cache: npm` — needed because `freshell-freshagent` tests spawn MCP servers that resolve `tsx` from `node_modules/.bin/tsx`. Without `npm ci`, 24 of 825 `freshell-freshagent` tests fail with `Unable to resolve MCP dependency "tsx"`.
- **`--locked`:** Must use `cargo test --workspace --locked` and `cargo build -p freshell-server --locked` for reproducibility parity with `port-contract.yml`.
- **`RUST_BACKTRACE=1`:** Set as an env var on the test step so runner-only failures are diagnosable.
- **Timeout:** 60 minutes — the first run has a cold, job-keyed cache and must do full test-profile codegen of the Tauri tree. PR #699's warm-cache workspace tests took 7-8 minutes after build; cold first runs will be longer.
- **Concurrency:** The workflow already has `concurrency: rust-clippy-${{ github.ref }}` with `cancel-in-progress: true`. Both jobs share this group. A new push cancels the entire run (both jobs).
- **Check display name:** The new check will display as "Rust Clippy / rust-test" in the GitHub UI (job name within the "Rust Clippy" workflow).
- **No scope creep:** This PR only wires existing test suites into CI. It does not modify any Rust source code, test files, or the test suites themselves. The post-merge ruleset amendment is a follow-up.
- **No production server restart:** The self-hosted Rust server on port 3001 must not be restarted.

---

### Task 1: Add `rust-test` job to `.github/workflows/rust-clippy.yml`

**Files:**
- Modify: `.github/workflows/rust-clippy.yml` (add a `rust-test` job alongside the existing `clippy` job)

**Interfaces:**
- Consumes: the existing workflow trigger (`on: push:main + pull_request`), concurrency group, and permissions
- Produces: a new CI check named `rust-test` (displayed as "Rust Clippy / rust-test") that runs `cargo test --workspace --locked` and the Tauri smoke

- [ ] **Step 1: Rebase onto origin/main**

The worktree base is 14 commits behind `origin/main`. PR #714 rewrote `auto_resume_e2e.rs` and `tests/common/mod.rs` — the very files the flake inventory cites. Rebase before pushing so CI runs the current test suite.

```bash
git fetch origin
git rebase origin/main
# Expected: clean rebase (no conflicts — this branch only adds a plan doc and no code changes conflict with main)
```

- [ ] **Step 2: Write the failing behavioral test**

The behavior under test is: "CI runs `cargo test --workspace --locked` on every PR." The test is the CI job itself running in GitHub Actions — there is no local unit test that can verify CI behavior (per AGENTS.md: "Checking that prose, prompts, docs, or config contain, match, or hash to expected text does not qualify"). The red phase is the current state: no `rust-test` job exists, so Rust tests (except `freshell-protocol` and `freshell-terminal` via `port-contract.yml`) do not run in CI.

Local baseline verification (already completed during workspace setup):

```bash
# Verifies the test suite that CI will run is green locally
cargo test --workspace --locked
# Expected: all tests pass (825 freshell-freshagent + all other crates; pre-existing flaky timing tests may fail on first run but pass on re-run)
```

- [ ] **Step 3: Verify the intended failure**

```bash
# Confirm no rust-test job exists in the workflow today
! grep -q 'rust-test' .github/workflows/rust-clippy.yml
# Expected: 0 exit (grep finds nothing, ! inverts to success)
```

- [ ] **Step 4: Add the minimal production implementation**

Add a `rust-test` job to `.github/workflows/rust-clippy.yml`, after the existing `clippy` job:

```yaml
  rust-test:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    env:
      RUST_BACKTRACE: 1
    steps:
      - uses: actions/checkout@v4

      # Same pinned toolchain as the clippy job (NOT @stable).
      - uses: dtolnay/rust-toolchain@master
        with:
          toolchain: 1.96.0

      - uses: Swatinem/rust-cache@v2

      # freshell-tauri needs GTK+WebKit system libs to compile (same set as clippy job).
      - name: Install Tauri system dependencies
        run: |
          sudo apt-get update
          sudo apt-get install -y --no-install-recommends \
            libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev \
            libjavascriptcoregtk-4.1-dev librsvg2-dev \
            libayatana-appindicator3-dev pkg-config build-essential

      # freshell-freshagent tests spawn MCP servers that resolve tsx from node_modules.
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - name: Install Node dependencies
        run: npm ci --no-audit --no-fund

      # Build the server binary explicitly so the Tauri smoke can never soft-skip.
      # The smoke's discover_server_binary() probes ancestor dirs of the test exe;
      # this step guarantees target/debug/freshell-server exists before tests run.
      - name: Build Rust server for Tauri smoke
        run: cargo build -p freshell-server --locked

      # --locked for reproducibility parity with port-contract.yml.
      # FRESHELL_SERVER_BIN ensures the Tauri smoke finds the binary via env var
      # (not just ancestor probing), making non-vacuity deterministic.
      - name: Rust workspace tests
        env:
          FRESHELL_SERVER_BIN: ${{ github.workspace }}/target/debug/freshell-server
        run: cargo test --workspace --locked

      # Dedicated Tauri smoke with --nocapture so the CI log visibly shows
      # "using server binary:" (confirming the test exercised the real binary,
      # not soft-skipped). --exact matches the single test function name.
      - name: Tauri app-bound server spawn smoke
        env:
          FRESHELL_SERVER_BIN: ${{ github.workspace }}/target/debug/freshell-server
        run: cargo test -p freshell-tauri --locked --test server_spawn_smoke app_bound_spawn_health_reap_end_to_end -- --exact --nocapture
```

- [ ] **Step 5: Commit and push**

```bash
git add .github/workflows/rust-clippy.yml
git commit -m "ci: add rust-test job to run cargo test --workspace on every PR"
git push origin the-usual/ci-rust-test-coverage
```

- [ ] **Step 6: Request PR approval and open PR**

The workflow triggers on `push:main` and `pull_request`. Pushing a feature branch does NOT trigger a run. A PR must exist to trigger the CI. Per AGENTS.md, PR creation requires explicit user approval.

Ask the user for PR approval. Once approved:

```bash
GH_ACCOUNT=danshapiro gh pr create \
  --base main \
  --head the-usual/ci-rust-test-coverage \
  --title "ci: add rust-test job for per-PR Rust test coverage" \
  --body "Adds a parallel \`rust-test\` job to \`rust-clippy.yml\` that runs \`cargo test --workspace --locked\` + the Tauri app-bound server-spawn smoke on every PR. Extracted from PR #699 (which is stuck) so CI coverage lands independently. When PR #699 merges, it should drop \`rust-clippy.yml\` from its diff."
```

- [ ] **Step 7: Verify the CI job runs and passes**

After the PR is open, the workflow triggers. Verify:

```bash
GH_ACCOUNT=danshapiro gh run list --workflow rust-clippy.yml --branch the-usual/ci-rust-test-coverage --limit 1
# Expected: a run triggered by the PR, with both `clippy` and `rust-test` jobs

GH_ACCOUNT=danshapiro gh run watch <run-id>
# Expected: both jobs pass. The rust-test job log should show:
#   - "using server binary: .../target/debug/freshell-server" (Tauri smoke non-vacuous)
#   - "test result: ok" for all test suites
```

If the `ETXTBSY` race triggers (pre-existing flake in `sleeper_cli_spec`), re-run the failed job via the GitHub Actions "Re-run failed jobs" button. The race is documented in the Accepted tradeoffs.

- [ ] **Step 8: Refactor while green**

No refactor needed — the job is a straightforward parallel job that reuses the same toolchain, cache, and apt deps as the `clippy` job. The YAML structure mirrors the existing `clippy` job for consistency.

- [ ] **Step 9: Run impacted-test verification**

The change is a CI workflow YAML file — it does not touch any Rust source code, test files, or the Node test suite. The impacted set is the CI workflow itself, verified in Step 7.

Additionally, verify the full local test suite remains green (confirming no accidental side effects):

```bash
cargo test --workspace --locked
# Expected: PASS (all tests green, same as baseline)
```

---

## Post-merge follow-up (NOT part of this PR)

After the PR is merged and the `rust-test` check has run successfully on `main`, amend the GitHub branch protection ruleset to make `rust-test` a required check:

```bash
# Get the current ruleset (note: use /rulesets/<id>, not /rules/branches/main filtered by id)
GH_ACCOUNT=danshapiro gh api repos/danshapiro/freshell/rulesets/14473229

# Add "rust-test" to the required_status_checks array (alongside "clippy" and "typecheck-client")
# using a PUT to ruleset 14473229 with integration_id 15368
# Precedent: docs/plans/2026-07-25-clippy-debt.md Task 9 Step 5
```

This is a user action, not part of this PR. The PR's CI job will run as advisory (non-required) until this amendment is made.
