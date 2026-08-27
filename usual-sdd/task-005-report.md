# Task 5 implementation report — retire dead contracts and rebase port oracles

Date: 2026-08-27
Worktree: `.worktrees/retire-node-server-v2`

## Outcome

Task 5 is implemented on the Rust-port branch. The active WebSocket contract no
longer contains the `codingcli.create/input/kill` or
`codingcli.created/event/exit/stderr/killed` family. Caller-free client APIs and
the fresh-agent thunk were removed, the retired visible-first harnesses and
Node-side oracle helpers/generators were deleted, and active T0/T1/T2 oracle
coverage now boots only an owned Rust server and uses committed Rust fixtures.

The retained real-provider T2 checks are explicitly opt-in under
`FRESHELL_RUN_REAL_PROVIDER_CONTRACTS`; with that variable unset they skip as
supplemental checks. The always-on fake/provider-shape and mutation checks stay
active.

## RED evidence

The required RED commands were run before implementation:

| Command | RED result before the change |
| --- | --- |
| `npm run test:vitest -- run test/unit/client/lib/api.test.ts --config config/vitest/vitest.config.ts` | 43 tests passed. The old tests did not assert the now-removed exports, so this was an uninformative green baseline. |
| `npm run test:vitest -- run test/unit/visible-first/acceptance-contract.test.ts --config config/vitest/vitest.config.ts` | 2 tests passed; the old package-script assertion did not yet express the retired harness requirement. |
| `npm run test:visible-first:contract` | 3 files / 6 tests passed on the old lane. |
| `npm run test:vitest -- run test/unit/port --config config/vitest/vitest.port.config.ts` | 2 files / 38 tests passed. |
| `cargo test -p freshell-protocol -p freshell-ws -p freshell-terminal -p freshell-extensions --locked` | Failed in the pre-existing `freshell-ws` lifecycle/activity baseline; see unresolved issues below. |
| `env -u FRESHELL_RUN_REAL_PROVIDER_CONTRACTS npm run test:oracle` | 10 files, 172 passed, 6 skipped. The old lane still exercised the Node/original oracle paths. |

The newly added Rust-only boundary test was also run against the pre-change
source and failed on the expected Node target/proxy/generator paths. It was then
used as the implementation guard.

## GREEN evidence

Focused and impacted checks after implementation:

- Client/API, fresh-agent WebSocket, and acceptance tests: 3 files / 55 tests
  passed.
- `npm run test:visible-first:contract`: 2 files / 3 tests passed; the lane now
  runs only the retained acceptance and visible-first report tests.
- Port contract tests: 2 files / 38 tests passed.
- Server protocol/identity tests: 2 files / 65 tests passed.
- `env -u FRESHELL_RUN_REAL_PROVIDER_CONTRACTS npm run test:oracle`: 11 files
  passed and 3 provider-gated files skipped; 162 tests passed and 3 skipped.
  The Rust-only T0/T1 captures are nonempty, compare against frozen fixtures,
  and retain one-byte/field mutation proofs. Owned processes are reaped.
- Rust-only oracle boundary: 2 tests passed.
- Runtime-surface architecture reconciliation: 15 tests passed.
- `npm run contract:generate`: passed with 65 exported schemas, 28 client
  message types, 53 server message types, and zero Zod required-field
  mismatches. A second generation produced identical hashes for all three
  committed contract artifacts:
  `ws-message-inventory.json`, `ws-protocol.schema.json`, and
  `ws-server-messages.schema.json`.
- `npm run typecheck:client`: passed.
- `npm run typecheck:server`: passed.
- `npm run lint`: passed with 0 errors and 11 existing warnings.
- Sequential Rust WebSocket unit lane,
  `cargo test -p freshell-ws --lib --locked -- --test-threads=1`: 507 passed.
- Rust formatting check for the changed Rust files passed.

The active oracle scans are clean for retired protocol names, Node oracle
targets/build paths, warm proxy/listener inspection, deleted generators, and
deleted route/generator references. Two historical-provenance references are
intentionally retained outside active commands: the frozen extension fixture
metadata and the frozen handshake transcript note. The repository-level
`package.json` still has `build:server` and `start` Node scripts because source
build/start retirement is Task 6; the Rust-only boundary deliberately scopes
its check to active oracle sources.

## Unresolved baseline issues

The required broad Cargo command still fails under the repository's shared
parallel test environment. The latest run completed the other crates and
reported 497 passed / 10 failed in `freshell-ws`; the failures were activity
lane seeding/reattachment and pane-ledger lock-pressure tests. The same activity
and pane-ledger tests pass in isolation and all 507 `freshell-ws` unit tests pass
with one test thread, so these are contention-sensitive baseline failures, not
Task 5 contract/oracle failures.

Two existing integration tests remain reproducibly red even when run alone:

```text
cargo test -p freshell-ws --test auto_resume_e2e \
  crashing_agent_is_resumed_twice_then_settles_exited --locked -- --nocapture
cargo test -p freshell-ws --test auto_resume_e2e \
  reconcile_after_replacement_attaches_to_the_new_terminal --locked -- --nocapture
```

Both fail after about five seconds with:
`timed out waiting for a terminal.created frame` at
`crates/freshell-ws/tests/common/mod.rs:1093`.

No live server was contacted, stopped, restarted, or health-checked. All oracle
boots used an ephemeral non-3001 loopback port and exact child ownership.
