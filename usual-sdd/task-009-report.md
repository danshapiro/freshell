# Task 9 Implementer Report

## Result

Task 9's container, CI, and release-artifact changes are implemented on the
`the-usual/retire-node-server-v2` branch. The example image now starts
`/app/freshell-server`; the Cloud Run image stages the Rust server, client, and
MCP tooling while retaining Node only for browser/test tooling. The Cloud Run
Node stage uses `npm ci --ignore-scripts`, removes and asserts the exact
Task 10 backend-only dependency directories, and copies only the retained
runtime tree.

The new distribution-runtime test and container-layout verifier enforce the
Rust/client/tools layout, reject `dist/server`, `node-pty`, and related backend
artifacts, and emit sorted JSONL evidence. Cloud Run discovery now fails closed
on discovery errors or an empty selection. Rust CI owns formatting, clippy,
workspace tests, and source-runtime smoke; the client typecheck job owns the
default nonempty Vitest lane; and the Electron build/release workflows install
Rust 1.96.0, build and verify native artifacts, run checkout-free runtime
acceptance on all four required OS targets, and upload only installer globs.

## TDD and verification

- RED: before the implementation, the required distribution-runtime command
  failed because the test file did not exist; Vitest reported no test files and
  exited nonzero.
- GREEN: `npm run test:vitest -- run test/unit/tooling/distribution-runtime.test.ts --config config/vitest/vitest.config.ts`
  passed: 1 file, 10 tests.
- `bash scripts/verify-container-layout.sh --fixture test/fixtures/distribution/rust-only`
  passed and emitted one `container_layout_verified` JSONL record.
- The node-server fixture failed as intended with status 1 and sorted evidence
  naming `dist/server/index.js` and `node_modules/node-pty/index.js`.
- The required forbidden-artifact scan passed with no matches.
- Shell syntax, ShellCheck, workflow YAML parsing, and the focused structural
  tests passed.
- `cargo build --release -p freshell-server --locked` passed.
- `npm run build:client && npm run build:tools`,
  `npm run typecheck:client && npm run typecheck:tools`,
  `npm run test:electron` (31 files, 290 tests), and
  `npm run test:source-runtime` passed.

## Environment-limited checks

- Both required Docker builds and their image probes were attempted, but this
  environment cannot access `/var/run/docker.sock` (`permission denied while
  trying to connect to the Docker API`). No image was built or run.
- `cargo fmt --all --check` remains blocked by pre-existing formatting in
  `crates/freshell-platform/src/mcp_inject.rs`,
  `crates/freshell-platform/src/mcp_inject_tests.rs`, and
  `crates/freshell-tauri/tests/server_spawn_smoke.rs`.
- Workspace clippy and workspace tests remain blocked before compilation by
  the missing host pkg-config dependency `libdbus-1`.

No live server or port 3001 was contacted, stopped, restarted, or health
checked.
