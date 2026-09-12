# Task 10 Fresh Eyes round 3 runtime-boundary repair report

## Scope

This repair addresses only the blocking runtime-boundary finding. No Electron
or Rust files were changed, no parent progress or review artifact was edited,
and live port 3001 was not contacted.

## Changes

- The retired Node backend detector now preserves quote boundaries while
  tokenizing commands and recursively inspects quoted subcommands passed to
  `concurrently`, POSIX shells, Windows `cmd`, and PowerShell-style shell
  wrappers.
- Direct and nested commands continue to support flags, quoted paths, Windows
  separators, `server/index`, `dist/server/index`, and nested
  `build/server/index` paths.
- Every required Rust package-script predicate rejects a command that also
  contains a detected retired Node backend. The separate retired-command
  evidence remains present so a mixed command cannot appear valid.
- The required-script regression now removes both `start` and
  `test:source-runtime` from the package and manifest, proving that neither
  side can silently skip the required-name checks.

## TDD evidence

The required runtime test was run red before implementation. It reported 5
failures: four quoted shell-wrapper cases and one Rust-plus-Node command were
not rejected. The earlier required-name regression continued to verify the
missing-name behavior.

The focused green run passed:

```text
npm run test:vitest -- run \
  test/unit/architecture/rust-only-server-runtime.test.ts \
  test/unit/tooling/prebuild-guard.test.ts \
  test/unit/tooling/distribution-runtime.test.ts \
  test/unit/tooling/distribution-fixture-visibility.test.ts \
  --config config/vitest/vitest.config.ts
PASS: 4 files, 66 tests
```

Additional verification passed:

```text
npm run typecheck
PASS: client and tools TypeScript checks
```

The focused changes are committed as
`fix: close quoted Node backend runtime-boundary escapes`.
