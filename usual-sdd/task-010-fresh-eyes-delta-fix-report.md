# Task 10 Fresh Eyes delta repair report

## Scope

This report covers the ten Fresh Eyes findings assigned to the Electron, artifact, fixture, verifier, and guard repair group. It does not change the parent progress ledger or any review file. The live Rust server on port 3001 was not contacted.

## Changes

- Electron runtime verification now permits the files that electron-builder places in platform resource roots: `icon.icns` for macOS and `elevate.exe` for Windows NSIS.
- The artifact verifier resolves the macOS `release/mac-arm64` directory for arm64 builds and keeps `release/mac` for x64 builds. The command accepts an optional `--arch` value.
- Runtime download temporary files use the directory derived by `fileURLToPath`. A Windows file URL regression test prevents a `/C:/...` path from returning.
- POSIX Rust and Node runtime binaries retain their source mode and receive all execute bits. Staging tests cover non-executable inputs.
- The Electron app-bound development command builds the static client and the debug Rust server before Electron starts. A package-script test covers the clean-tree prerequisites.
- Electron resumes quitting after asynchronous server cleanup rejects and keeps the structured error log. A lifecycle test checks both the resumed quit and the single cleanup attempt.
- The Electron E2E Vite dependency resolves from this checkout. The test asserts the repository-local Vite entry exists.
- Negation rules make tracked distribution fixtures visible even when their paths contain `dist` or `node_modules`. The distribution test checks both fixture families with Git's ignore matcher.
- The retirement verifier uses `pathToFileURL` for its direct-run check, including Windows path conversion coverage.
- Deliberately split literals are now direct in the Rust server environment guard, source-runtime vacuity guard, Cloud Run cleanup list and test, browser-selection helper, and its companion guard test. The tests continue to assert the Rust-only restrictions.

## TDD evidence

The new tests were run before their implementation changes. The first run failed because the artifact verifier rejected the two platform files, the macOS architecture resolver was absent, rejected cleanup did not resume Electron quit, the Windows path helper was absent, staged modes lacked execute bits, and the fixture paths were still ignored. The implementation then made those tests pass.

Focused Electron tests:

```text
npm run test:vitest -- run --config config/vitest/vitest.electron.config.ts \
  test/unit/electron/prepare-electron-runtime.test.ts \
  test/unit/electron/verify-electron-artifact.test.ts \
  test/unit/electron/main.test.ts \
  test/unit/electron/startup-rust.test.ts \
  test/unit/electron/server-spawner.test.ts \
  test/unit/electron/electron-builder-config.test.ts \
  test/unit/electron/startup.test.ts
PASS: 7 files, 91 tests
```

Impacted verification:

```text
npm run test:electron
PASS: 31 files, 297 tests

npm run test:vitest -- run --config config/vitest/vitest.config.ts \
  test/unit/tooling/distribution-runtime.test.ts \
  test/unit/tooling/testing/test-selection.test.ts \
  test/unit/tooling/testing/coordinator-command-matrix.test.ts \
  test/unit/architecture/node-test-disposition.test.ts
PASS: 4 files, 31 tests

npm run test:vitest -- run --config test/e2e-browser/vitest.config.ts \
  test/e2e-browser/helpers/selection-nonvacuity.test.ts
PASS: 1 file, 4 tests; the helper used an owned temporary Rust server

bash scripts/test/cloud-vitest-entrypoint.test.sh
PASS: all checks

npm run typecheck
PASS: client and tools TypeScript checks

npm run build:electron
PASS

npm run build:tools
PASS

npm exec -- tsx scripts/retirement/verify-node-test-disposition.ts
PASS: candidateCount 347, rowCount 349, retainedRows 21, deletedRows 328
```

`git diff --check` also passed for the repair files. Native macOS and Windows installer assembly was not available on this Linux host, so those layouts are covered by platform-specific verifier fixtures rather than real native artifacts. No production process was restarted.
