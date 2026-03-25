# Kimi Provider isNonInteractive Detection — Test Plan

## Harness requirements

No new harnesses need to be built. All tests use the existing Vitest + fixture infrastructure already established in `kimi-provider.test.ts` and `session-visibility.test.ts`. The harness pattern is:

- **Fixture-backed provider tests**: Instantiate `KimiProvider` against `test/fixtures/coding-cli/kimi/share-dir/` (or temporary directories derived from it), call `listSessionsDirect()`, and assert against returned `CodingCliSession` objects. The `vi.mock` for `resolveGitRepoRoot` and `resolveGitBranchAndDirty` is already established in `kimi-provider.test.ts` and will be replicated in `session-visibility.test.ts`.
- **Content-parsing unit tests**: Call `parseSessionContent()` / `parseCodexSessionContent()` with synthetic JSONL strings and assert against `ParsedSessionMeta`. Already established in `session-visibility.test.ts`.
- **Temporary directory tests**: Create ephemeral `mkdtemp` fixture directories for edge cases (no TurnBegin, incremental refresh), following the pattern already used in 4 existing `kimi-provider.test.ts` tests.

All tests run under `vitest.server.config.ts` (`npm run test:vitest -- --config vitest.server.config.ts`).

---

## Test plan

### 1. Claude isNonInteractive test matches current `entrypoint` heuristic

- **Name**: Sets isNonInteractive when entrypoint is sdk-cli (fixes red test)
- **Type**: regression
- **Disposition**: extend (replace broken test)
- **Harness**: `parseSessionContent()` unit harness in `session-visibility.test.ts`
- **Preconditions**: Existing test at line 53 asserts `queue-operation` triggers `isNonInteractive`, but the implementation at `claude.ts:359` was changed to `entrypoint === 'sdk-cli'` in commit `e1fd2097`. Test is currently RED.
- **Actions**: Replace the test body: construct a JSONL string with `{ entrypoint: 'sdk-cli', cwd: '/home/user/project', type: 'user', message: { role: 'user', content: 'Automated task' } }`, pass to `parseSessionContent()`.
- **Expected outcome**: `meta.isNonInteractive` is `true`. Source of truth: `claude.ts:359` — `if (obj.entrypoint === 'sdk-cli') isNonInteractive = true`.
- **Interactions**: None. Pure content-parsing test.

### 2. queue-operation no longer triggers isNonInteractive for Claude

- **Name**: Does not set isNonInteractive for queue-operation records (interactive signal)
- **Type**: regression
- **Disposition**: new
- **Harness**: `parseSessionContent()` unit harness in `session-visibility.test.ts`
- **Preconditions**: Claude provider no longer uses `queue-operation` as a non-interactive signal.
- **Actions**: Construct a JSONL string with a normal user record followed by a `queue-operation` enqueue record, pass to `parseSessionContent()`.
- **Expected outcome**: `meta.isNonInteractive` is falsy. Source of truth: the user's root-cause analysis proved `queue-operation` is evidence of interactivity, and commit `e1fd2097` removed that heuristic.
- **Interactions**: None. Pure content-parsing test.

### 3. Kimi print-mode session (string user_input) is flagged as non-interactive

- **Name**: Sets isNonInteractive when wire.jsonl TurnBegin user_input is a string
- **Type**: integration
- **Disposition**: new
- **Harness**: `KimiProvider.listSessionsDirect()` against fixture share dir, in `session-visibility.test.ts`
- **Preconditions**: New fixture `print-mode-session/wire.jsonl` with `{"message":{"type":"TurnBegin","payload":{"user_input":"Automated print mode task"}}}` exists in the `4a3dcd71f4774356bb688dad99173808` workdir hash directory. `vi.mock` for git utils is set up.
- **Actions**: Instantiate `KimiProvider(kimiFixtureShareDir)`, call `listSessionsDirect()`, find session with `sessionId === 'print-mode-session'`.
- **Expected outcome**: `printSession.isNonInteractive` is `true`. Source of truth: user's validated signal — string `user_input` in TurnBegin = `--print` mode (machine), validated across 84/104 real sessions.
- **Interactions**: Exercises `loadKimiWireSummary()` -> `loadSessionCandidate()` -> `listSessionsDirect()` pipeline. Shares fixture directory with existing tests (kimi-session-1, wire-title-session, etc.), so must not break existing session discovery.

### 4. Kimi interactive session (array user_input) is NOT flagged as non-interactive

- **Name**: Does not set isNonInteractive when wire.jsonl TurnBegin user_input is an array
- **Type**: integration
- **Disposition**: new
- **Harness**: `KimiProvider.listSessionsDirect()` against fixture share dir, in `session-visibility.test.ts`
- **Preconditions**: Existing fixture `wire-title-session/wire.jsonl` has `{"message":{"type":"TurnBegin","payload":{"user_input":[{"type":"text","text":"Fix the left sidebar refresh bug"}]}}}` — array `user_input`.
- **Actions**: Instantiate `KimiProvider(kimiFixtureShareDir)`, call `listSessionsDirect()`, find session with `sessionId === 'wire-title-session'`.
- **Expected outcome**: `interactiveSession.isNonInteractive` is falsy. Source of truth: array `user_input` = interactive mode (human), per user's design principle "default is human."
- **Interactions**: Same fixture directory as test 3.

### 5. Kimi session without wire.jsonl defaults to interactive (human)

- **Name**: Does not set isNonInteractive when wire.jsonl is absent
- **Type**: boundary
- **Disposition**: new
- **Harness**: `KimiProvider.listSessionsDirect()` against fixture share dir, in `session-visibility.test.ts`
- **Preconditions**: Existing fixture `context-title-session` has `context.jsonl` but no `wire.jsonl`.
- **Actions**: Instantiate `KimiProvider(kimiFixtureShareDir)`, call `listSessionsDirect()`, find session with `sessionId === 'context-title-session'`.
- **Expected outcome**: `noWireSession.isNonInteractive` is falsy. Source of truth: user's design principle — "Our default is 'human' so we only care about machine signals. We err on the side of include."
- **Interactions**: Same fixture directory as tests 3-4.

### 6. Kimi session with wire.jsonl but no TurnBegin records defaults to interactive

- **Name**: Does not set isNonInteractive when wire.jsonl has no TurnBegin records
- **Type**: boundary
- **Disposition**: new
- **Harness**: `KimiProvider.listSessionsDirect()` with temporary directory, in `session-visibility.test.ts`
- **Preconditions**: Temporary share directory with a session whose `wire.jsonl` contains only a metadata line (`{"type":"metadata","protocol_version":"1.2"}`), no TurnBegin.
- **Actions**: Create temp share dir with `kimi.json`, session `context.jsonl`, and metadata-only `wire.jsonl`. Instantiate `KimiProvider(tempShareDir)`, call `listSessionsDirect()`, find session with `sessionId === 'no-turnbegin-session'`.
- **Expected outcome**: `session.isNonInteractive` is falsy. Source of truth: user's design principle — absent signal defaults to human.
- **Interactions**: Isolated temp directory, no fixture sharing.

### 7. isNonInteractive flows through listSessionsDirect for print-mode fixture (kimi-provider integration)

- **Name**: Sets isNonInteractive for print-mode sessions and leaves interactive sessions unset
- **Type**: integration
- **Disposition**: new
- **Harness**: `KimiProvider.listSessionsDirect()` in `kimi-provider.test.ts`
- **Preconditions**: The `print-mode-session` fixture exists in the share dir. Existing fixtures `kimi-session-1` (string `user_input`), `wire-title-session` (array `user_input`), and `context-title-session` (no wire.jsonl) are present.
- **Actions**: Set `KIMI_SHARE_DIR` to fixture dir. Instantiate `KimiProvider()`, call `listSessionsDirect()`. Assert `isNonInteractive` for each session: `print-mode-session` (true), `kimi-session-1` (true — its wire.jsonl has string user_input), `wire-title-session` (falsy), `context-title-session` (falsy).
- **Expected outcome**: Four sessions classified correctly. Source of truth: fixture wire.jsonl contents cross-referenced with user's validated signal definition.
- **Interactions**: This test exercises the full `listSessionsDirect()` pipeline including `loadKimiWireSummary()`, `loadSessionCandidate()`, `deriveKimiTitle()`, and the git mock layer. Tests all four classification paths in one integration test.

### 8. Incremental refresh updates isNonInteractive when wire.jsonl changes

- **Name**: Updates isNonInteractive on incremental refresh when wire.jsonl changes
- **Type**: integration
- **Disposition**: new
- **Harness**: `KimiProvider.listSessionsDirect()` with temporary directory, in `kimi-provider.test.ts`
- **Preconditions**: Temporary share directory with a session starting as non-interactive (string `user_input`).
- **Actions**: Create temp share dir. Call `listSessionsDirect()` — assert `isNonInteractive` is `true`. Overwrite `wire.jsonl` with array `user_input`. Call `listSessionsDirect({ changedFiles: [wirePath], deletedFiles: [] })` for incremental refresh. Assert `isNonInteractive` is now falsy.
- **Expected outcome**: The flag updates correctly on incremental refresh. Source of truth: the incremental refresh must re-read wire.jsonl (matching the established pattern in the existing incremental refresh test for metadata.json).
- **Interactions**: Tests the `changedFiles` path through `listSessionsDirect()`, which determines whether to re-read from disk or use cache.

### 9. Existing kimi-provider test count updated for new fixture

- **Name**: Resolves git metadata once per cwd even when multiple sessions share a workdir (updated count)
- **Type**: regression
- **Disposition**: extend
- **Harness**: Existing test in `kimi-provider.test.ts`
- **Preconditions**: The new `print-mode-session` fixture is in the same workdir hash `4a3dcd71f4774356bb688dad99173808` as `kimi-session-1`. The existing test copies the fixture dir, adds `kimi-session-2`, and asserts `toHaveLength(2)`.
- **Actions**: Update the assertion from `toHaveLength(2)` to `toHaveLength(3)` at line 226 to account for the new `print-mode-session` fixture.
- **Expected outcome**: Test passes with the correct count of 3 sessions sharing the `/repo/root/packages/app` cwd. Source of truth: fixture directory contents.
- **Interactions**: Validates that adding the new fixture doesn't break existing session discovery or git-metadata deduplication.

### 10. Validation against all real sessions (cross-check)

- **Name**: Provider classification matches raw wire.jsonl signal for all real ~/.kimi sessions
- **Type**: differential
- **Disposition**: new
- **Harness**: One-time validation script (not a persistent test file). Uses `KimiProvider` against real `~/.kimi` data and independently reads `wire.jsonl` files to cross-validate.
- **Preconditions**: Real `~/.kimi` directory with 100+ sessions on the development machine.
- **Actions**: Instantiate `KimiProvider()` (default path). Call `listSessionsDirect()`. For each session, independently read its `wire.jsonl`, find the first TurnBegin, check if `user_input` is a string. Compare the provider's `isNonInteractive` flag against this independent signal. Report match/mismatch/noWire counts.
- **Expected outcome**: Zero mismatches. Source of truth: the raw wire.jsonl data that was previously validated (84 string = machine, 20 array = interactive out of 104 with wire.jsonl).
- **Interactions**: Exercises the full production path against real data. Not a permanent test — runs once after implementation to validate correctness.

---

## Coverage summary

### Covered areas

| Area | Tests | Coverage type |
|------|-------|--------------|
| String `user_input` -> `isNonInteractive: true` | 3, 7 | Integration (fixture-backed) |
| Array `user_input` -> interactive (falsy) | 4, 7 | Integration (fixture-backed) |
| Missing `wire.jsonl` -> defaults to human | 5, 7 | Boundary |
| No TurnBegin records -> defaults to human | 6 | Boundary |
| Incremental refresh updates flag | 8 | Integration |
| Full pipeline: `loadKimiWireSummary()` -> `loadSessionCandidate()` -> `listSessionsDirect()` | 3, 4, 5, 7 | Integration |
| Claude `entrypoint === 'sdk-cli'` heuristic (fix red test) | 1 | Regression |
| `queue-operation` no longer triggers non-interactive | 2 | Regression |
| Existing fixture count correctness after adding new fixture | 9 | Regression |
| Real-world validation against all sessions | 10 | Differential |

### Explicitly excluded (per agreed strategy)

| Area | Reason | Risk |
|------|--------|------|
| Sidebar filtering of `isNonInteractive` sessions | Already tested generically in sidebar selector tests; the sidebar consumes the boolean flag without provider-specific logic | Low — the flag is a simple boolean consumed by `shouldHideAsNonInteractive()`, which has its own tests |
| E2E browser tests | No browser-level interaction changes; this is a backend-only classification change that flows through existing sidebar filtering | Low — the only user-visible effect is sessions appearing/disappearing in the sidebar, which is controlled by a boolean already tested at the selector level |
| `parseSessionFile()` path for Kimi | Kimi's `listSessionFiles()` returns `[]`, so `parseSessionFile()` is never invoked for Kimi sessions; all Kimi session loading goes through `listSessionsDirect()` | None — dead code path for Kimi |
| Malformed `wire.jsonl` (corrupt JSON, binary data) | The existing `loadKimiWireSummary()` already has a `try/catch` around JSON.parse with `continue`, and the default is human. No new error handling is needed. | Very low — malformed lines are skipped, and the default-to-human behavior is covered by test 6 (no TurnBegin found) |
| Performance testing | The change adds a single `typeof` check inside an existing loop iteration. No measurable performance impact. | None |
