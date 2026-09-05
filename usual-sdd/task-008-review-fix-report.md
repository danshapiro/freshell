# Task 8 review-fix report

## Finding fixed

The original verifier used `RUNTIME_LAYOUT` only as producer-side data and
maintained a separate required-file list. It therefore accepted arbitrary
non-forbidden files. The verifier now derives required files and its exact and
recursive path rules from the same platform-aware declarative layout used by
the producer. The producer validates its own staged file list against that
contract before writing its receipt.

The allowlist permits the Rust and Node platform-specific binaries, the
recursive client/Claude/MCP/client-runtime trees, the staged receipt, and the
explicit Electron Builder-owned archive, chooser/assets, and unpacked Claude
SDK paths. An arbitrary path such as `unapproved-runtime/server.js` fails
verification. Existing required-file, forbidden-name, `.node`, binary-format,
and native auth-refusal checks remain in place.

## RED

After adding the regression test and before implementing the allowlist:

```text
npm run test:electron -- test/unit/electron/verify-electron-artifact.test.ts
```

Failed 1 of 5 tests. The new test created
`unapproved-runtime/server.js`, and the old verifier incorrectly accepted it.

## GREEN

The focused Electron tests passed:

```text
npm run test:electron -- test/unit/electron/prepare-electron-runtime.test.ts test/unit/electron/verify-electron-artifact.test.ts test/unit/electron/native-windows-build-script.test.ts
```

Result: 3 files, 12 tests passed, including the new unapproved-file
regression, recursive client/receipt fixture, and platform-specific Windows
structural fixture.

The producer/verifier typecheck passed:

```text
npx tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --skipLibCheck scripts/prepare-electron-runtime.ts scripts/verify-electron-artifact.ts
```

The real staged runtime was rebuilt and passed its producer validation:

```text
npm run prepare:electron-runtime
```

The unpacked Electron artifact passed the direct verifier:

```text
npm run verify:electron-artifact
```

The receipt reported `executed: true` and `forbiddenFiles: []`. During the
first allowlist pass this command correctly identified legitimate Builder
resources outside the staging tree; those paths were then added explicitly to
the shared layout. No arbitrary catch-all root allowance was added.

The checkout-free acceptance remained green:

```text
npm run test:electron:runtime
```

Result: 1 file, 1 test passed. It still copies the staged runtime outside the
checkout, authenticates the Rust server, serves the client, runs fake Claude,
speaks MCP over stdio, checks for no MCP listener, and reaps owned children.

`git diff --check` passed.

No command contacted, stopped, restarted, or health-checked live port 3001.
Existing historical/untracked reports in the worktree were left untouched.
