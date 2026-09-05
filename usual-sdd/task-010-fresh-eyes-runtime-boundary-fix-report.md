# Task 10 Fresh Eyes runtime-boundary repair report

## Scope

This bounded repair covers the remaining runtime-boundary, prebuild guidance,
distribution-test, and example-Docker documentation findings. It does not
modify the parent progress ledger or any existing review artifact, and it does
not touch the already-repaired Electron/Rust files. No process on live port
3001 was contacted, stopped, or restarted.

## Changes

- The runtime-boundary analyzer now tokenizes package commands sufficiently to
  recognize `node`/`tsx` invocations with flags, quotes, Windows separators,
  `server/index`, `dist/server/index`, and nested `build/server/index` paths.
  Shell separators stop a match from crossing into another command.
- Required Rust package-script names are checked independently of the
  manifest's declared `entries`. Removing a required name now reports both the
  missing manifest name and the missing/invalid package behavior.
- The prebuild conflict text now states that main-checkout `check`,
  source-runtime, build, and verify paths fail closed before artifact writes,
  gives the no-write client typecheck option, and shows linked-worktree
  commands for the full checks.
- Distribution tests retain `node-pty` as forbidden in Docker/workflow
  sources. The Cloud Run Dockerfile has a narrow, explicit exception because
  it removes and verifies that stale directory during image construction.
- The duplicate distribution-fixture visibility assertion was consolidated in
  the dedicated visibility test, which now covers the Rust-only client fixture
  as well.
- The example Docker command now supplies a clearly marked, non-secret
  `AUTH_TOKEN` placeholder of sufficient length.

## TDD evidence

The required runtime test was run red before implementation. It reported 4
failures: three quoted/flagged/nested Node command cases were not detected and
the required-script omission produced no drift. The guard/distribution red run
then reported the missing formatter export and the intentional Cloud Run
`node-pty` cleanup being rejected by the restored forbidden-term assertion.

The focused green run passed:

```text
npm run test:vitest -- run \
  test/unit/architecture/rust-only-server-runtime.test.ts \
  test/unit/tooling/prebuild-guard.test.ts \
  test/unit/tooling/distribution-runtime.test.ts \
  test/unit/tooling/distribution-fixture-visibility.test.ts \
  --config config/vitest/vitest.config.ts
PASS: 4 files, 61 tests
```

Additional verification passed:

```text
npm run typecheck
PASS: client and tools TypeScript checks

git diff --check -- <repair files>
PASS
```

The focused changes are ready for the single repair commit
`fix: tighten runtime-boundary retirement guards`.
