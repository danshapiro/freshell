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
- Pre-existing flaky timing tests (`auto_resume_e2e::reconcile_after_replacement_attaches_to_the_new_terminal`, `claude::tests::the_prior_turns_terminal_edge_during_the_compact_write_window_folds_against_the_armed_tracker`) may occasionally fail in CI — accepted as known pre-existing flakes, both pass on re-run
- Making the new `rust-test` check a required merge gate requires a post-merge ruleset amendment (ruleset 14473229, precedent: clippy-debt plan Task 9 Step 5) — documented here but is a separate user follow-up, not part of this PR

**Goal:** Every PR runs the full Rust workspace test suite (`cargo test --workspace --locked`) and the Tauri app-bound server-spawn smoke test in CI, as a parallel job alongside the existing clippy gate.

**Architecture:** Add a `rust-test` job to the existing `.github/workflows/rust-clippy.yml` workflow. The job reuses the same pinned toolchain (1.96.0), `Swatinem/rust-cache@v2`, and Tauri GTK/WebKit apt dependencies as the `clippy` job. It adds `npm ci` (needed because `freshell-freshagent` tests spawn MCP servers that require `tsx` from `node_modules`), then runs `cargo test --workspace --locked`. A workspace `cargo test` builds the `freshell-server` binary, so the Tauri `server_spawn_smoke` integration test discovers and exercises it for real (non-vacuous). The job runs concurrently with `clippy` under the same workflow, so required-check wall time does not grow.

**Tech Stack:** GitHub Actions, Rust 1.96.0 (pinned), `Swatinem/rust-cache@v2`, `actions/setup-node@v4`, `npm ci`, `cargo test --workspace --locked`.

## Global Constraints

- **Toolchain pin:** Rust 1.96.0 via `dtolnay/rust-toolchain@master` — must match the existing `clippy` job and workspace `rust-version`.
- **Cache:** `Swatinem/rust-cache@v2` — shares the cache key with the `clippy` job (same OS + Cargo.lock hash).
- **Tauri system deps:** The exact same 8 apt packages as the `clippy` job (`libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev librsvg2-dev libayatana-appindicator3-dev pkg-config build-essential`) — needed to compile `freshell-tauri`.
- **Node.js:** `actions/setup-node@v4` with `node-version: 22` and `cache: npm` — needed because `freshell-freshagent` tests spawn MCP servers that resolve `tsx` from `node_modules/.bin/tsx`. Without `npm ci`, 24 of 825 `freshell-freshagent` tests fail with `Unable to resolve MCP dependency "tsx"`.
- **`--locked`:** Must use `cargo test --workspace --locked` for reproducibility parity with `port-contract.yml`.
- **Concurrency:** The workflow already has `concurrency: rust-clippy-${{ github.ref }}` with `cancel-in-progress: true`. Both jobs share this group.
- **No scope creep:** This PR only wires existing test suites into CI. It does not modify any Rust source code, test files, or the test suites themselves. The post-merge ruleset amendment is a follow-up.
- **No production server restart:** The self-hosted Rust server on port 3001 must not be restarted.

---

### Task 1: Add `rust-test` job to `.github/workflows/rust-clippy.yml`

**Files:**
- Modify: `.github/workflows/rust-clippy.yml` (add a `rust-test` job alongside the existing `clippy` job)

**Interfaces:**
- Consumes: the existing workflow trigger (`on: push:main + pull_request`), concurrency group, and permissions
- Produces: a new CI check named `rust-test` (job name within the "Rust Clippy" workflow) that runs `cargo test --workspace --locked`

- [ ] **Step 1: Write the failing behavioral test**

The behavior under test is: "CI runs `cargo test --workspace --locked` on every PR." The test is the CI job itself running in GitHub Actions — there is no local unit test that can verify CI behavior (per AGENTS.md: "Checking that prose, prompts, docs, or config contain, match, or hash to expected text does not qualify"). The red phase is the current state: no `rust-test` job exists, so Rust tests (except `freshell-protocol` and `freshell-terminal` via `port-contract.yml`) do not run in CI.

Local baseline verification (already completed during workspace setup):

```bash
# Verifies the test suite that CI will run is green locally
cargo test --workspace --locked
# Expected: all tests pass (825 freshell-freshagent + all other crates; 2 pre-existing flaky timing tests may fail on first run but pass on re-run)
```

- [ ] **Step 2: Run the test and verify the intended failure**

The "test" is the absence of the `rust-test` CI job. Verify the current state:

```bash
# Confirm no rust-test job exists in the workflow today
grep -c 'rust-test' .github/workflows/rust-clippy.yml
# Expected: 0 (no rust-test job exists yet)
```

- [ ] **Step 3: Add the minimal production implementation**

Add a `rust-test` job to `.github/workflows/rust-clippy.yml`, after the existing `clippy` job:

```yaml
  rust-test:
    runs-on: ubuntu-latest
    timeout-minutes: 30
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

      # --locked for reproducibility parity with port-contract.yml.
      # A workspace cargo test builds the freshell-server binary, so the Tauri
      # server_spawn_smoke integration test discovers and exercises it for real
      # (non-vacuous — it does NOT soft-skip, because the binary is at
      # target/debug/freshell-server and the test probes ancestor dirs).
      - name: cargo test (workspace)
        run: cargo test --workspace --locked
```

- [ ] **Step 4: Run the focused test**

Push the branch and verify the CI job runs:

```bash
git add .github/workflows/rust-clippy.yml
git commit -m "ci: add rust-test job to run cargo test --workspace on every PR"
git push origin the-usual/ci-rust-test-coverage
```

Then check GitHub Actions:

```bash
gh run list --workflow rust-clippy.yml --branch the-usual/ci-rust-test-coverage --limit 1
# Expected: a run triggered by the push, with both `clippy` and `rust-test` jobs
gh run watch <run-id>
# Expected: both jobs pass (rust-test runs cargo test --workspace --locked and all tests pass)
```

- [ ] **Step 5: Refactor while green**

No refactor needed — the job is a straightforward parallel job that reuses the same toolchain, cache, and apt deps as the `clippy` job. The YAML structure mirrors the existing `clippy` job for consistency.

- [ ] **Step 6: Run impacted-test verification**

The change is a CI workflow YAML file — it does not touch any Rust source code, test files, or the Node test suite. The impacted set is the CI workflow itself, verified in Step 4.

Additionally, verify the full local test suite remains green (confirming no accidental side effects):

```bash
cargo test --workspace --locked
# Expected: PASS (all tests green, same as baseline)
```

- [ ] **Step 7: Commit the task**

```bash
git add .github/workflows/rust-clippy.yml
git commit -m "ci: add rust-test job to run cargo test --workspace on every PR"
```

---

## Post-merge follow-up (NOT part of this PR)

After the PR is merged and the `rust-test` check has run successfully on `main`, amend the GitHub branch protection ruleset to make `rust-test` a required check:

```bash
# Get the current ruleset
gh api repos/danshapiro/freshell/rules/branches/main --jq '.[] | select(.id == 14473229)'

# Add "rust-test" to the required_status_checks array (alongside "clippy" and "typecheck-client")
# using a PUT to ruleset 14473229 with integration_id 15368
# Precedent: docs/plans/2026-07-25-clippy-debt.md Task 9 Step 5
```

This is a user action, not part of this PR. The PR's CI job will run as advisory (non-required) until this amendment is made.
