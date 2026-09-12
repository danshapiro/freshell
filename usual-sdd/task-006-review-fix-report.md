# Task 6 review-fix report

## Issue addressed

The Task 6 source-runtime smoke test had a Windows-specific gap: its process
tree helper returned no children on `win32`, so `npm.cmd start` could never be
proven to own the release Rust server. The test could time out even when the
server was running correctly.

## Fix

- Added `scripts/testing/process-tree.ts` with platform-independent process
  ownership and release-binary identity helpers.
- POSIX hosts use `ps`; Windows hosts use an injected/testable PowerShell
  `Get-CimInstance Win32_Process` snapshot.
- The helper follows every descendant between the `npm` wrapper and the Rust
  process, and accepts only the exact `target/release/freshell-server` path
  (`.exe` on Windows).
- The source-runtime smoke test now uses that helper and records the exact Rust
  PID. Cleanup terminates that PID explicitly before cleaning up the wrapper.
- Added unit coverage for a Windows npm-wrapper process tree and the mocked
  Windows process-table parser.

## TDD and verification

The focused unit test was first run before the helper existed and failed during
module resolution. After implementing the helper, it passed.

Passing commands:

```text
npm run test:vitest -- run test/unit/tooling/process-tree.test.ts --config config/vitest/vitest.config.ts
  1 file, 2 tests passed

npm run test:vitest -- run test/integration/tooling/source-runtime-rust.test.ts --config config/vitest/vitest.runtime.config.ts
  1 file, 1 test passed

npm run typecheck
  client and tools typechecks passed

npm run test:vitest -- run test/unit/architecture/rust-only-server-runtime.test.ts --config config/vitest/vitest.config.ts
  1 file, 15 tests passed
```

The source-runtime test used an operating-system-assigned port and a temporary
home directory. No process on live port 3001 was contacted, stopped, or
restarted.
