# Task 11 implementer report

## Outcome

Task 11 is implemented and committed as `69daee80c` (`docs: declare the
Rust-only backend`). Active documentation now describes the Rust server as the
only Freshell HTTP/WebSocket backend, with standalone Node CLI/MCP clients and
the isolated Claude SDK sidecar called out separately. Electron packaging,
development commands, environment examples, and the destructive-test sandbox
guidance describe the Rust runtime.

The active runtime boundary now reports only executable/runtime evidence: its
`manifestDrift`, `legacyDebt`, and `unexpectedNodeBackend` arrays are all
required to be empty by the current-checkout test. The dead CLI/MCP request
branches for removed `/api/run` and `/api/fresh-agent/send` routes were removed
so the final source/caller inventory contains no request sender.

The external triage receipt is at
`/home/dan/code/freshell/.worktrees/.the-usual-logs/retire-node-server-v2/reports/final-node-feature-triage.md`.
It contains the exact inventory/search commands, timestamps, exit codes,
results, and owner classifications. No important untracked Node-only feature
was found and no Kata was filed. Existing `freshell#g8d3` is a separate
BrowserPane security Kata and was not duplicated.

Protected `docs/index.html` and `.kata.toml` remain unchanged. Historical
plans/reports were not edited by this task.

## TDD and focused verification

- Required RED command, run before the Task 11 edits:
  `npm run test:vitest -- run test/unit/architecture/rust-only-server-runtime.test.ts --config config/vitest/vitest.config.ts`.
  It unexpectedly passed the pre-edit checkout (15 tests), because prior
  retirement tasks had already removed the old runtime paths. No artificial
  failure was introduced.
- During the implementation, the tightened test initially exposed an
  over-broad removal of the old static debt checks: one synthetic test still
  expected a removed legacy path. That stale expectation was removed, while
  the dynamic unexpected-listener checks remained.
- Focused GREEN command: the same runtime test, 15/15 tests passed at
  `2026-08-27 17:25:46 -0700`.
- `git diff --exit-code origin/main -- docs/index.html .kata.toml`: exit 0.
- Receipt nonempty check (`test -s .../final-node-feature-triage.md`): exit 0.
- Final active forbidden-reference scan: no output; the wrapped `rg` no-match
  status was 1, so the plan's `! rg ...` check is satisfied.
- `node --import tsx scripts/retirement/verify-node-test-disposition.ts`: exit
  0; 347 candidates, 349 rows, 21 retained, 328 deleted, zero unresolved or
  vacuous rows.
- `npm run typecheck`: exit 0 (client and tooling).
- `npm run lint`: exit 0 with 11 existing warnings and no errors.

## Impacted verification status

The required broad commands were run after the implementation commit. No
command contacted, stopped, restarted, or health-checked the live service on
port 3001.

- `npm run test:status`: exit 0; coordinator idle. It reports the existing
  latest full-suite failure with client/unit failures and Rust integration
  success, not a new Task 11 failure.
- `FRESHELL_TEST_SUMMARY="retire Node server: final Rust-only proof" npm run check`:
  exit 1. Typechecks passed; the coordinated client phase had 471 passing test
  files and 5 failures among 5,609 tests. Failures were the existing
  `FreshAgentMobile` call-shape assertions (2), refresh context-menu flow (1),
  and visible-first audit subprocess stderr assertions (2). The runtime guard,
  MCP tool suite, CLI capability suite, and other relevant tests passed.
- `cargo fmt --all --check`: exit 1 due pre-existing formatting differences in
  `crates/freshell-platform/src/mcp_inject.rs`, its tests, and
  `crates/freshell-tauri/tests/server_spawn_smoke.rs`.
- `cargo clippy --workspace --all-targets --locked -- -D warnings`: exit 101;
  host prerequisite missing: `libdbus-sys` cannot find `dbus-1.pc`.
- `cargo clippy -p freshell-codex --features real-transport --all-targets --locked -- -D warnings`:
  exit 0.
- `cargo clippy -p freshell-opencode --features real-transport --all-targets --locked -- -D warnings`:
  exit 0.
- `cargo test --workspace --locked`: exit 101 for the same missing
  `libdbus-sys`/`dbus-1.pc` host prerequisite.
- `cargo test -p freshell-codex --features real-transport --locked`: exit 0;
  172 unit tests plus 4 integration tests passed.
- `cargo test -p freshell-opencode --features real-transport --locked`: exit 0;
  49 unit tests plus health/serve integration tests passed.
- `env -u FRESHELL_RUN_REAL_PROVIDER_CONTRACTS npm run test:oracle`: exit 0;
  162 tests passed and 3 real-provider tests were explicitly skipped because
  the opt-in variable was unset. The suite reported no oracle gaps.
- `npm run test:e2e:helpers`: exit 0; 23 files and 257 tests passed.
- `npm exec playwright -- test --config test/e2e-browser/playwright.config.ts --project=chromium --list`:
  exit 0; 460 Chromium tests in 119 files listed, with no legacy project.
- Full browser E2E execution was not started because `FRESHELL_E2E_BACKEND`
  is unset and the repository policy requires choosing/configuring local or
  paid cloud E2E before running it. The list and helper checks were run; no
  filtered result was presented as coverage.
- `npm run test:electron`: exit 0; 31 files and 290 tests passed.
- `npm run electron:build`: completed successfully; the embedded artifact
  verification reported `ok: true` and no forbidden files.
- `npm run verify:electron-artifact`: exit 0; required Rust/client/MCP/Claude
  resources found and forbidden-files list empty.
- `npm run test:electron:runtime`: exit 0; checkout-free runtime acceptance
  passed.
- `xvfb-run -a npm run test:e2e:electron`: exit 1; all 8 tests failed before
  app launch because the local Electron package reported “Electron failed to
  install correctly, please delete node_modules/electron and try installing
  again.”
- Both required Docker builds exited 1 before building because this host's
  user cannot access `/var/run/docker.sock`; corresponding image probes were
  not run against nonexistent images.
- The plan's final forbidden-reference scan succeeded with no output; the
  no-match `rg` check, `server`/`dist/server`/`tsconfig.server`/retired Vitest
  config absence checks, protected-file diff, and receipt nonempty check all
  exited 0.
- The destructive sandbox self-test was not run because its documented
  command intentionally probes the host service on port 3001, which is out of
  scope for this task.
