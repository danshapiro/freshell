# Task 10 round 4 repair report

## Scope

This repair covers the six findings assigned for the round 4 runtime-boundary, distribution, helper visibility, artifact path, shebang, and file URL path checks. It does not change Rust sources, Electron application sources, parent progress files, or review files. The live server on port 3001 was not contacted.

## Changes

- Shell command inspection now keeps looking through wrapper options until it finds a command selector. It recognizes PowerShell `-Command`, POSIX `-c`, combined shell flags, and Windows `/c`. This covers `pwsh`, `powershell`, `cmd.exe`, `bash`, and `sh` forms with quoted nested commands.
- Distribution tests now reject every `node-pty` reference in Docker and workflow sources outside the exact Cloud Run cleanup block. A focused test covers install, copy, and rebuild forms. The Cloud Run test still checks the cleanup block structure and allows its single intentional reference.
- The production conflict formatter and retired server-config selector are module-private because no external consumer remains. Their public behavior continues through the existing guard and coordinator tests.
- Artifact architecture parsing occurs only when the verifier must construct its default path. An explicit path, including the environment override, does not consult host architecture.
- The Electron development prerequisite script now uses the `tsx` shebang.
- File URL conversion uses `path.win32` for Windows URLs and `path.posix` for POSIX URLs, even when tests simulate the other platform.

## TDD evidence

The wrapper regression cases were added before the parser change. The required red run was:

```text
npm run test:vitest -- run test/unit/architecture/rust-only-server-runtime.test.ts --config config/vitest/vitest.config.ts
```

Result: 5 of 35 tests failed. The failures were the five new wrapper forms: `pwsh -Command`, PowerShell with `-NoProfile`, `cmd.exe /d /s /c`, `bash --norc -c`, and `sh -eu -c`.

After the parser change, the same command passed with 35 of 35 tests.

## Verification

Focused runtime and tooling tests passed:

```text
npm run test:vitest -- run --config config/vitest/vitest.electron.config.ts test/unit/electron/prepare-electron-runtime.test.ts test/unit/electron/verify-electron-artifact.test.ts
PASS: 2 files, 16 tests

npm run test:vitest -- run --config config/vitest/vitest.config.ts test/unit/tooling/electron-dev-prerequisites.test.ts test/unit/tooling/testing/coordinator-command-matrix.test.ts test/unit/tooling/prebuild-guard.test.ts test/unit/tooling/distribution-runtime.test.ts
PASS: 4 files, 48 tests

npm run typecheck:tools
PASS

npm run test:electron
PASS: 31 files, 300 tests
```

`git diff --check` passed for all changed source and test files. The pre-existing worktree changes under `usual-sdd/` were left unstaged.

## Remaining limits

Native macOS and Windows artifact assembly was not available on this Linux host. The path and verifier behavior is covered by platform-specific unit fixtures. No production process was started or restarted.
