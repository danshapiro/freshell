# Cloud Run Jobs for Playwright E2E Tests — Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

**Goal:** Make Google Cloud Run Jobs the default execution backend for Playwright e2e tests, with a `--local` flag (and `test:e2e:local` script) for local execution.

**Architecture:** A multi-stage Docker image bundles the Rust server binary, Node.js runtime, built `dist/` artifacts, and Playwright browsers. A Cloud Run Job executes the container with optional sharding (`--tasks=N`, `CLOUD_RUN_TASK_INDEX`). A wrapper script (`scripts/e2e-cloud.sh`) handles image build/push, job creation, execution, log streaming, and result reporting. The `test:e2e` npm script defaults to cloud; `test:e2e:local` and `--local` flag fall back to direct local Playwright execution.

**Tech Stack:** Docker multi-stage build (`rust:1-bookworm` + `node:22-bookworm`), Google Cloud Run Jobs, gcloud CLI, Playwright 1.58.2, bash wrapper script.

## Global Constraints

- GCP account: `dan@danshapiro.com`, project: `misc-puttering-project`, region: `us-west1`
- gcloud commands must pass `--account`, `--project`, `--region` explicitly (no default config set)
- Playwright version: 1.58.2 — Docker base must install matching browser version
- Node.js: >=22.5.0 (per `.nvmrc`/`engines`)
- Server uses NodeNext/ESM; relative imports must include `.js` extensions
- The existing `docker/sandbox/Dockerfile` deliberately uses `node:22-bookworm` (not the MS Playwright image) to pin Node version — follow the same pattern
- Tests use isolated `mkdtemp` HOME dirs per worker — safe for parallel containers
- `continuity-smoke` project must NEVER run in cloud (uses real CLIs from `~/.codex/auth.json`)
- `CI=1` adds firefox/webkit projects — do NOT set `CI=1` in cloud; use explicit `--project` flags instead
- Screenshot baselines are `*-chromium-linux.png` — Linux chromium in the container matches
- Never restart the self-hosted production server (port 3001) without explicit "APPROVED"

## Requirements

- **R1 — Cloud default:** `npm run test:e2e` executes the Playwright e2e suite on Google Cloud Run Jobs by default, not locally.
- **R2 — Local fallback:** `npm run test:e2e:local` (and `npm run test:e2e -- --local`) runs the same suite locally via direct Playwright invocation, preserving the pre-change behavior.
- **R3 — End-to-end validation:** A Cloud Run Job executes a real test run (at minimum `auth.spec.ts`) and returns passing results that match the local baseline.
- **R4 — Pass-through args:** The cloud execution path supports `--grep`, `--project`, and spec-file filter arguments passed through to Playwright inside the container.
- **R5 — Sharding:** The cloud execution path supports sharding via `--shards=N` to split the test suite across N parallel Cloud Run tasks.
- **R6 — No regression:** The existing `test:e2e:chromium`, `test:e2e:headed`, `test:e2e:debug`, `test:e2e:update-snapshots`, `test:e2e:helpers`, and `test:e2e:electron` scripts continue to work unchanged.

---

### Task 1: Docker Image — Dockerfile, .dockerignore, and Entrypoint

**Requirements served:** R1, R3, R5

**Behavior:**
- A multi-stage Docker build produces an image containing: the Rust `freshell-server` binary, Node.js runtime with all npm dependencies, built `dist/client` + `dist/server`, and Playwright chromium browsers with system dependencies.
- The entrypoint script reads `CLOUD_RUN_TASK_INDEX` (0-based) and `CLOUD_RUN_TASK_COUNT` env vars and translates them to Playwright `--shard=$(($INDEX+1))/$COUNT` arguments.
- When `CLOUD_RUN_TASK_COUNT` is unset or 1, no shard flag is passed (runs all tests in one task).
- The entrypoint accepts pass-through arguments (grep patterns, project names, spec paths) after the shard flags.
- A `.dockerignore` excludes `node_modules/`, `dist/`, `target/`, `.git/`, `.worktrees/`, and other large/unnecessary paths from the build context.

**Files:**
- Create: `docker/cloud-run/Dockerfile`
- Create: `docker/cloud-run/entrypoint.sh`
- Create: `.dockerignore`
- Test: `scripts/test/cloud-run-dockerfile.test.sh` (build + smoke test)

**Interfaces:**
- Consumes: `package.json`, `package-lock.json`, `Cargo.toml`, `Cargo.lock`, `crates/`, `server/`, `src/`, `test/e2e-browser/`
- Produces: Docker image tagged `freshell-e2e:latest` (local) or Artifact Registry path (cloud); entrypoint that runs `npx playwright test --config test/e2e-browser/playwright.cloud.config.ts [args]`

**Test cases:**
- `docker build -f docker/cloud-run/Dockerfile -t freshell-e2e:test .` succeeds
- `docker run --rm freshell-e2e:test --project=chromium test/e2e-browser/specs/auth.spec.ts --reporter=line` runs 6 auth tests and all pass
- `docker run --rm -e CLOUD_RUN_TASK_INDEX=0 -e CLOUD_RUN_TASK_COUNT=2 freshell-e2e:test --project=chromium --reporter=line` runs shard 1 of 2
- `docker run --rm -e CLOUD_RUN_TASK_INDEX=1 -e CLOUD_RUN_TASK_COUNT=2 freshell-e2e:test --project=chromium --reporter=line` runs shard 2 of 2

- [ ] **Step 1: Write the failing test script**

Create `scripts/test/cloud-run-dockerfile.test.sh` that:
1. Builds the Docker image: `docker build -f docker/cloud-run/Dockerfile -t freshell-e2e:test .`
2. Runs the auth smoke test: `docker run --rm freshell-e2e:test --project=chromium test/e2e-browser/specs/auth.spec.ts --reporter=line`
3. Checks that the exit code is 0 and output contains "6 passed"
4. Exits non-zero if any step fails

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `bash scripts/test/cloud-run-dockerfile.test.sh`

Expected: FAIL because `docker/cloud-run/Dockerfile` does not exist yet.

- [ ] **Step 3: Add the minimal production implementation**

Create `.dockerignore` excluding: `node_modules/`, `dist/`, `target/`, `.git/`, `.worktrees/`, `.claude/`, `*.log`, `.env`, `test-results/`, `playwright-report/`, `docs/`, `.the-usual-logs/`.

Create `docker/cloud-run/Dockerfile`:
- Stage 1 (`rust-builder`): `FROM rust:1-bookworm`, copy `Cargo.toml`, `Cargo.lock`, `crates/`, build with `cargo build --release -p freshell-server`
- Stage 2 (`runtime`): `FROM node:22-bookworm`, install system deps (`build-essential`, `libssl-dev`, `pkg-config`, `procps`, `python3`), install Playwright browsers (`npx playwright@1.58.2 install --with-deps chromium`), copy Rust binary from stage 1, `npm ci`, copy source, `npm run build:client && npm run build:server`
- Set `WORKDIR /app`, copy entrypoint, set `ENTRYPOINT`

Create `docker/cloud-run/entrypoint.sh`:
- Read `CLOUD_RUN_TASK_INDEX` and `CLOUD_RUN_TASK_COUNT`
- If `CLOUD_RUN_TASK_COUNT > 1`, prepend `--shard=$(($INDEX+1))/$COUNT`
- Exec `npx playwright test --config test/e2e-browser/playwright.cloud.config.ts "$@"` (with shard flag prepended)
- Make executable

- [ ] **Step 4: Run the focused test**

Run: `bash scripts/test/cloud-run-dockerfile.test.sh`

Expected: PASS — Docker image builds, auth tests pass inside container.

- [ ] **Step 5: Refactor while green**

Review the Dockerfile for layer caching (copy `package.json` + `package-lock.json` before source, copy `Cargo.toml` + `Cargo.lock` before `crates/`). Ensure the `.dockerignore` is complete.

- [ ] **Step 6: Run broader verification**

Run: `docker run --rm freshell-e2e:test --project=chromium --reporter=line` (full chromium suite in container)

Expected: PASS (same pass/fail counts as local baseline, within retry variance)

- [ ] **Step 7: Commit the task**

```bash
git add docker/cloud-run/Dockerfile docker/cloud-run/entrypoint.sh .dockerignore scripts/test/cloud-run-dockerfile.test.sh
git commit -m "feat: add Cloud Run Docker image with Rust server, Node, and Playwright browsers"
```

---

### Task 2: Cloud Playwright Config

**Requirements served:** R1, R3, R5

**Behavior:**
- A Playwright config file extends the base config behavior for the cloud environment.
- Skips `globalSetup` (the build is already baked into the Docker image — no need to rebuild).
- Sets `workers: 2`, `retries: 2` (CI-like, since cloud is a CI environment).
- Uses `html` reporter with `open: 'never'` and `line` reporter for log parsing.
- Only registers `chromium`, `legacy-chromium`, and `rust-chromium` projects (no firefox/webkit, no continuity-smoke).
- Reads `--shard` from Playwright's built-in sharding (passed by entrypoint).

**Files:**
- Create: `test/e2e-browser/playwright.cloud.config.ts`
- Test: `scripts/test/cloud-run-config.test.sh`

**Interfaces:**
- Consumes: base config patterns from `test/e2e-browser/playwright.config.ts` (MATRIX_SPECS, RUST_ONLY_SPECS, projects)
- Produces: config file referenced by `docker/cloud-run/entrypoint.sh`

**Test cases:**
- `npx playwright test --config test/e2e-browser/playwright.cloud.config.ts --list` lists all chromium + legacy-chromium + rust-chromium specs (no firefox/webkit/continuity-smoke)
- `npx playwright test --config test/e2e-browser/playwright.cloud.config.ts --list --shard=1/2` lists a subset
- Config does NOT call `globalSetup` (verified by code inspection — no build step triggered)

- [ ] **Step 1: Write the failing test script**

Create `scripts/test/cloud-run-config.test.sh` that:
1. Runs `npx playwright test --config test/e2e-browser/playwright.cloud.config.ts --list 2>&1`
2. Checks that output contains spec files (non-empty list)
3. Checks that output does NOT contain "firefox" or "webkit" or "continuity-smoke"
4. Checks that output does NOT contain "[e2e-setup]" (no globalSetup build step)
5. Exits non-zero if any check fails

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `bash scripts/test/cloud-run-config.test.sh`

Expected: FAIL because `test/e2e-browser/playwright.cloud.config.ts` does not exist.

- [ ] **Step 3: Add the minimal production implementation**

Create `test/e2e-browser/playwright.cloud.config.ts`:
- Import the MATRIX_SPECS and RUST_ONLY_SPECS from the base config (or duplicate them with a comment referencing the source — they are const arrays, not exported)
- Actually: refactor `playwright.config.ts` to export `MATRIX_SPECS` and `RUST_ONLY_SPECS`, then import them in the cloud config. This is a DRY improvement that keeps both configs in sync.
- Define the cloud config with: `globalSetup: undefined`, `globalTeardown: undefined`, `workers: 2`, `retries: 2`, `reporter: [['line'], ['html', { open: 'never' }]]`, and the three chromium projects from the base config.

- [ ] **Step 4: Run the focused test**

Run: `bash scripts/test/cloud-run-config.test.sh`

Expected: PASS

- [ ] **Step 5: Refactor while green**

Ensure the shared spec lists (MATRIX_SPECS, RUST_ONLY_SPECS) are exported cleanly from the base config and imported by the cloud config. Verify the base config still works unchanged.

- [ ] **Step 6: Run broader verification**

Run: `npx playwright test --config test/e2e-browser/playwright.cloud.config.ts --project=chromium test/e2e-browser/specs/auth.spec.ts --reporter=line`

Expected: PASS — 6 auth tests pass using the cloud config locally.

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/playwright.cloud.config.ts test/e2e-browser/playwright.config.ts scripts/test/cloud-run-config.test.sh
git commit -m "feat: add cloud Playwright config with CI-like settings, no globalSetup"
```

---

### Task 3: Wrapper Script and npm Scripts

**Requirements served:** R1, R2, R4, R5, R6

**Behavior:**
- `scripts/e2e-cloud.sh` is the main entry point for cloud test execution.
- Subcommands: `run` (default), `build`, `push`, `logs`, `help`.
- `run` flow: ensure image exists in Artifact Registry (build+push if missing or `--build` flag), create/update Cloud Run Job, execute job with `--tasks=N` (from `--shards=N`), wait for completion, stream logs, report exit code.
- Pass-through args: `--grep=<pattern>`, `--project=<name>`, `<spec-paths>` — forwarded as container args.
- `--local` flag: skips cloud entirely, runs `npx playwright test --config test/e2e-browser/playwright.config.ts` directly.
- `--shards=N` (default 1): sets Cloud Run Job `--tasks=N` and `CLOUD_RUN_TASK_COUNT=N`.
- `--build` flag: forces image rebuild + push before execution.
- Environment variable defaults: `FRESHELL_GCP_ACCOUNT=dan@danshapiro.com`, `FRESHELL_GCP_PROJECT=misc-puttering-project`, `FRESHELL_GCP_REGION=us-west1`, `FRESHELL_GCP_REPO=freshell-e2e`, `FRESHELL_GCP_JOB=freshell-e2e`.
- npm scripts: `test:e2e` calls `scripts/e2e-cloud.sh run "$@"`, `test:e2e:local` calls Playwright directly (the old `test:e2e` behavior), `test:e2e:cloud` is an explicit alias for the cloud path.
- Existing scripts (`test:e2e:chromium`, `test:e2e:headed`, etc.) remain unchanged.

**Files:**
- Create: `scripts/e2e-cloud.sh`
- Modify: `package.json` (test:e2e scripts section)
- Test: `scripts/test/cloud-run-wrapper.test.sh`

**Interfaces:**
- Consumes: `docker/cloud-run/Dockerfile`, `test/e2e-browser/playwright.cloud.config.ts`, gcloud CLI
- Produces: Cloud Run Job execution results, exit codes, log streams

**Test cases:**
- `scripts/e2e-cloud.sh help` prints usage with subcommands and flags
- `scripts/e2e-cloud.sh run --local --project=chromium test/e2e-browser/specs/auth.spec.ts --reporter=line` runs 6 auth tests locally and passes
- `npm run test:e2e -- --local --project=chromium test/e2e-browser/specs/auth.spec.ts --reporter=line` runs 6 auth tests locally and passes
- `npm run test:e2e:local -- --project=chromium test/e2e-browser/specs/auth.spec.ts --reporter=line` runs 6 auth tests locally and passes
- `npm run test:e2e:chromium -- test/e2e-browser/specs/auth.spec.ts --reporter=line` still works (unchanged)

- [ ] **Step 1: Write the failing test script**

Create `scripts/test/cloud-run-wrapper.test.sh` that:
1. Tests `scripts/e2e-cloud.sh help` — checks exit code 0 and output contains "Usage" and "run" and "--local"
2. Tests `scripts/e2e-cloud.sh run --local --project=chromium test/e2e-browser/specs/auth.spec.ts --reporter=line` — checks exit code 0 and output contains "6 passed"
3. Tests `npm run test:e2e -- --local --project=chromium test/e2e-browser/specs/auth.spec.ts --reporter=line` — checks exit code 0
4. Tests `npm run test:e2e:local -- --project=chromium test/e2e-browser/specs/auth.spec.ts --reporter=line` — checks exit code 0
5. Exits non-zero if any check fails

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `bash scripts/test/cloud-run-wrapper.test.sh`

Expected: FAIL because `scripts/e2e-cloud.sh` does not exist.

- [ ] **Step 3: Add the minimal production implementation**

Create `scripts/e2e-cloud.sh`:
- Parse subcommand (default: `run`)
- Parse flags: `--local`, `--build`, `--shards=N`, `--grep=<pattern>`, `--project=<name>`, `--account=<email>`, `--project-id=<id>`, `--region=<region>`
- Collect remaining args as Playwright pass-through
- `help` subcommand: print usage
- `build` subcommand: docker build + tag for Artifact Registry
- `push` subcommand: docker push to Artifact Registry (create repo if needed)
- `run` subcommand:
  - If `--local`: exec `npx playwright test --config test/e2e-browser/playwright.config.ts "$@"` directly
  - Else: ensure image (build+push if `--build` or missing), create/update Cloud Run Job, execute with `--tasks=$SHARDS`, wait (`--wait`), stream logs, exit with job's exit code
- `logs` subcommand: `gcloud run jobs execution logs fetch ...`

Modify `package.json`:
- Change `test:e2e` to: `scripts/e2e-cloud.sh run`
- Add `test:e2e:local`: `playwright test --config test/e2e-browser/playwright.config.ts` (the old `test:e2e` command)
- Add `test:e2e:cloud`: `scripts/e2e-cloud.sh run` (explicit alias)
- Leave all other `test:e2e:*` scripts unchanged

- [ ] **Step 4: Run the focused test**

Run: `bash scripts/test/cloud-run-wrapper.test.sh`

Expected: PASS

- [ ] **Step 5: Refactor while green**

Extract common gcloud flag construction into a helper function. Ensure the script is `set -euo pipefail` safe. Add comments for each subcommand.

- [ ] **Step 6: Run broader verification**

Run: `npm run test:e2e:chromium -- test/e2e-browser/specs/auth.spec.ts --reporter=line`

Expected: PASS — existing script still works.

Run: `npm run test:e2e -- --local --project=chromium test/e2e-browser/specs/auth.spec.ts --reporter=line`

Expected: PASS — local fallback via flag works.

- [ ] **Step 7: Commit the task**

```bash
git add scripts/e2e-cloud.sh package.json scripts/test/cloud-run-wrapper.test.sh
git commit -m "feat: add e2e-cloud wrapper script, make cloud the default with --local fallback"
```

---

### Task 4: End-to-End Cloud Run Validation

**Requirements served:** R3, R5

**Behavior:**
- Build and push the Docker image to Artifact Registry.
- Create the Cloud Run Job.
- Execute a smoke test (auth.spec.ts) on Cloud Run and verify all 6 tests pass.
- Execute a broader test run (chromium project) on Cloud Run and verify results are consistent with the local baseline.
- Test sharding by running with `--shards=2` and verifying both tasks complete.

**Files:**
- No new files. Uses `scripts/e2e-cloud.sh`, `docker/cloud-run/Dockerfile`, `test/e2e-browser/playwright.cloud.config.ts`.
- Test: manual validation with recorded evidence in `<logs-dir>/reports/cloud-validation.md`

**Test cases:**
- `scripts/e2e-cloud.sh build` — image builds and pushes successfully
- `scripts/e2e-cloud.sh run --project=chromium test/e2e-browser/specs/auth.spec.ts --reporter=line` — 6 passed on Cloud Run
- `scripts/e2e-cloud.sh run --project=chromium --reporter=line` — full chromium suite passes with similar counts to local baseline
- `scripts/e2e-cloud.sh run --shards=2 --project=chromium --reporter=line` — sharded run completes, combined results cover all tests

- [ ] **Step 1: Build and push the image**

Run: `scripts/e2e-cloud.sh build`

Expected: Docker image builds locally and pushes to `us-west1-docker.pkg.dev/misc-puttering-project/freshell-e2e/freshell-e2e:latest`.

- [ ] **Step 2: Create the Cloud Run Job**

Run: `scripts/e2e-cloud.sh run --project=chromium test/e2e-browser/specs/auth.spec.ts --reporter=line`

Expected: Cloud Run Job is created (if first run) and executed. 6 auth tests pass. Exit code 0.

- [ ] **Step 3: Run the full chromium suite**

Run: `scripts/e2e-cloud.sh run --project=chromium --reporter=line`

Expected: Full chromium suite runs. Pass/fail counts are consistent with local baseline (within retry variance). Exit code 0 or 1 (1 if pre-existing failures match local baseline).

- [ ] **Step 4: Test sharding**

Run: `scripts/e2e-cloud.sh run --shards=2 --project=chromium test/e2e-browser/specs/auth.spec.ts --reporter=line`

Expected: Two Cloud Run tasks execute. Combined, all auth tests are covered. Both tasks exit 0.

- [ ] **Step 5: Record validation evidence**

Write results to `/home/dan/code/freshell/.worktrees/.the-usual-logs/cloud-run-jobs/reports/cloud-validation.md` with: commands, exit codes, pass/fail counts, timing, and comparison to local baseline.

- [ ] **Step 6: Commit the task**

```bash
git add -A
git commit -m "test: validate Cloud Run Jobs end-to-end with smoke and full suite runs"
```

---

## Notes

- The `playwright.config.ts` refactor to export `MATRIX_SPECS` and `RUST_ONLY_SPECS` (Task 2) is a minimal DRY improvement that does not change any behavior. The base config's `export default defineConfig(...)` remains unchanged.
- The `package.json` change (Task 3) repurposes `test:e2e` from local to cloud. The old behavior is preserved as `test:e2e:local`. This is the user's explicit request: "Make that the new default with a flag For any other options like running locally."
- Cloud Run Jobs have a maximum execution time of 24 hours and a maximum of 256 tasks. The default 1-shard config runs all tests in one task; `--shards=N` splits across N parallel tasks.
- The Docker image includes the Rust server binary for `rust-chromium` project support. The image will be large (~2-3 GB) due to Playwright browsers + Node deps + Rust binary.
