# Task 6 implementation report

Date: 2026-08-27

## Outcome

The source build/start and broad test lanes now use the Rust server. The
default client Vitest lane, an artifact-owning source-runtime smoke, the Rust
workspace lane, and Electron Vitest run as explicit phases. The old server
Vitest config, Node server build/typecheck script, and retired provider
contract/config files were removed within the Task 6 scope. Retained tests
were moved out of the server test tree where specified, and the shared title
and tab-registry subjects were split as planned.

The source-runtime smoke builds the client, tools, and release server; starts
`npm start` on an OS-assigned non-production port with an isolated home and
test token; verifies health, authenticated Rust server provenance, and the
SPA; identifies the exact release `freshell-server` child; and tears down that
PID. No command in this report contacted, stopped, restarted, or health-checked
live port 3001.

## Required RED checks

These were run before the implementation changes:

| Command | Result before implementation |
| --- | --- |
| `npm run build:client` | Passed, with existing Vite/Browserslist warnings. |
| `npm run build:server` | Passed against the old Node baseline; this was the behavior being retired. |
| Focused tooling/config Vitest command | Failed on the new Rust-first expectations because the old scripts/configs were still present. |
| Source-runtime Vitest command using `vitest.runtime.config.ts` | Failed because the dedicated config did not yet exist. |
| `bash scripts/test/cloud-vitest-wrapper.test.sh` | Initially passed the old behavior unexpectedly; the test was then made truthful by requiring the retired server selector to fail with a Rust-lane hint. |
| Tauri `server_spawn_smoke` exact test | Could not compile on this host because `dbus-1.pc`/`libdbus-1-dev` is absent. This is an environment dependency, not a test assertion failure. |

## GREEN and impacted verification

Passed:

- `npm run build:client`
- `npm run build:tools`
- `cargo build --release -p freshell-server --locked`
- Focused retained/tooling/shared/provider/default-lane Vitest: 18 files,
  131 tests passed.
- `npm run test:source-runtime`: 1 file, 1 test passed, including exact
  release-child ownership and Rust provenance checks.
- `bash scripts/test/cloud-vitest-wrapper.test.sh`: all checks passed.
- `bash scripts/test/cloud-vitest-entrypoint.test.sh`: all checks passed.
- `bash scripts/test/cloud-vitest-integration.test.sh`: all checks passed.
- `npm run test:electron`: 34 files, 350 tests passed.
- `cargo test -p freshell-codex --features real-transport --locked`: passed.
- `cargo test -p freshell-opencode --features real-transport --locked`: passed.
- `npm run typecheck`: client and tools typechecks passed.
- Runtime-boundary architecture inventory: 15 tests passed, with the closed
  manifest reconciled and temporary listener tests recorded as exact
  assertion-only rows.
- Forbidden-reference scan from Task 6 Step 6: no matches. The expected `rg`
  exit status was 1 because the scan was empty. All three file-absence checks
  passed.

The Tauri smoke was rerun with the required explicit binary and still stopped
at the host dependency check:

```text
The system library `dbus-1` required by crate `libdbus-sys` was not found.
Suggested package: libdbus-1-dev
```

The WSL bootstrap and Rust CI workflow now install that dependency before the
Tauri smoke, and CI builds `freshell-server` explicitly before setting
`FRESHELL_SERVER_BIN`.

## Coordinated broad gate

The required command was run:

```bash
FRESHELL_TEST_SUMMARY="retire Node server: Rust broad gate" npm test
```

It reached the retained default lane and selected 471 files / 5,589 tests;
468 files passed and 3 files failed with 5 baseline test failures. The
failures were unrelated to Task 6:

1. Two `FreshAgentMobile` assertions expected an unused second argument.
2. Two visible-first audit subprocess assertions expected empty stderr but
   observed existing `tsx` `UNDICI-EHPA` warnings.
3. One refresh-context-menu test observed a scheduling-sensitive missing
   refresh call.

The standard runner stopped after this failed client phase, as designed. The
source-runtime and Electron phases were run independently and passed; the Rust
phase built the server and then stopped at the same missing DBus host
dependency while compiling the Tauri crate. No Task 6 source/runtime failure
was observed.

## Implementation notes

- `scripts/launch-rust.sh` remains canonical; `scripts/launch.sh` is a
  compatibility forwarder and keeps exact-PID safety.
- `start-rust-server.ts` is foreground-only, resolves Windows `.exe` names,
  forwards termination signals, inherits stdio, and emits JSONL only for
  wrapper errors.
- `run-source-runtime-tests.ts` and `run-rust-tests.ts` own their prerequisites
  and forward signals without backgrounding or killing unrelated processes.
- Cloud Vitest accepts only the retained default config; server selection exits
  2 with a Rust cargo hint, and no required runner uses the vacuous-test flag.
- The default config retains the visible-first CLI harness and excludes the
  artifact-dependent integration trees, which have their own runtime setup.
