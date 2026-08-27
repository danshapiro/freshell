# Task 4 report — Rust-only browser E2E

Implemented the browser E2E fixture collapse on `the-usual/retire-node-server-v2`.

- Browser fixtures now start an owned `RustServer`; an explicit external target remains non-owned.
- Shared server info, port allocation, HOME isolation, and setup-wizard seeding live in `server-fixture-support.ts`.
- The browser Node constructor, its tests, legacy browser projects, and GATE-01 executable/collator files were removed. The frozen GATE-01 JSON remains untouched.
- The temporary Node constructor is oracle-local at `port/oracle/harness/legacy-node-server.ts`; Task 5 owns its removal.
- Chromium is now the single match-all Rust project. Its selection lists 460 tests in 119 files, excluding only `continuity-smoke.spec.ts`; cloud retains the classified local-only `mcp-qa-smoke-rust.spec.ts` skip and selector.
- Rust startup now rejects healthy-but-non-Rust `/api/server-info` responses and requires build provenance.

Verification:

- `FRESHELL_E2E_BACKEND=local npm run test:e2e:helpers` passed (helper suite, including the selection non-vacuity and fake-provenance checks).
- `FRESHELL_E2E_BACKEND=local npm exec playwright -- test --config test/e2e-browser/playwright.config.ts --project=chromium --list` passed: 460 tests in 119 files.
- The required forbidden-legacy scan passed.
- The requested oracle handshake command selected no tests because `vitest.port.config.ts` explicitly excludes `test/unit/port/oracle/**`; it exited 1 with `No test files found` rather than exercising the target.
- The focused local Chromium run was started with the four requested specs. It built the Rust client/binary and began all 25 selected tests; its captured output was truncated while concurrent workers serialized on Cargo locks, so no final pass receipt is claimed here.

No port 3001 operation was performed.
