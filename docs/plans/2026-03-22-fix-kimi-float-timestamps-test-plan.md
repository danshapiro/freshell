# Fix Kimi Float Timestamps Test Plan

> Reconciled against implementation plan: `docs/plans/2026-03-22-fix-kimi-float-timestamps.md`

## Strategy reconciliation notes

The agreed testing strategy proposed three categories of tests:

1. **Kimi provider unit test** -- extends `kimi-provider.test.ts` to verify integer `lastActivityAt`. Confirmed by the implementation plan (Task 2). No adjustment needed.

2. **Schema regression anchor** -- adds a case in `session-directory-schema.test.ts` that rejects float `lastActivityAt`. Confirmed by the implementation plan (Task 1). No adjustment needed.

3. **Rate limit config test** -- the strategy mentioned verifying a higher rate limit. The implementation plan is scoped exclusively to the float timestamp bug (no rate limit changes). This test is therefore **out of scope** for this plan. The rate limit exhaustion was a secondary symptom amplified by the Zod rejection cascade; fixing the float eliminates the amplification. If rate limit changes are pursued separately, tests should be added then.

All planned interfaces, architecture, and harness assumptions from the strategy match the implementation plan. No cost or scope changes.

## Test plan

### Test 1: Schema rejects float `lastActivityAt` (regression anchor)

- **Name**: Session directory schema rejects floating-point `lastActivityAt` values
- **Type**: regression
- **Disposition**: new
- **Harness**: Vitest unit test (`npm run test:vitest -- --run test/unit/shared/session-directory-schema.test.ts`)
- **Preconditions**: None. This tests the Zod schema definition in `shared/read-models.ts` directly.
- **Actions**:
  1. Construct a minimal `SessionDirectoryItemSchema`-conforming object with `lastActivityAt: 1774212239458.0225` (the exact float observed in production logs).
  2. Call `SessionDirectoryItemSchema.parse()` on it.
- **Expected outcome**: `parse()` throws a `ZodError` because `z.number().int()` rejects the float. Source of truth: the `z.number().int().nonnegative()` constraint on `lastActivityAt` at `shared/read-models.ts:49`.
- **Interactions**: None. Pure schema validation, no I/O or external dependencies.

### Test 2: Schema accepts integer `lastActivityAt` (companion anchor)

- **Name**: Session directory schema accepts integer `lastActivityAt` values
- **Type**: regression
- **Disposition**: new
- **Harness**: Vitest unit test (same file as Test 1)
- **Preconditions**: None.
- **Actions**:
  1. Construct a minimal `SessionDirectoryItemSchema`-conforming object with `lastActivityAt: 1000` (an integer).
  2. Call `SessionDirectoryItemSchema.parse()` on it.
- **Expected outcome**: `parse()` succeeds without throwing. Source of truth: same schema constraint -- integers must be accepted.
- **Interactions**: None.

### Test 3: Kimi provider returns integer `lastActivityAt` even when filesystem `mtimeMs` has sub-millisecond precision

- **Name**: Kimi provider returns integer `lastActivityAt` even when filesystem `mtimeMs` has sub-millisecond precision
- **Type**: integration
- **Disposition**: new
- **Harness**: Vitest unit test (`npm run test:vitest -- --run test/unit/server/coding-cli/kimi-provider.test.ts`)
- **Preconditions**:
  1. A temporary Kimi share directory is created with a valid `kimi.json` pointing to a work directory.
  2. A session directory exists with a `context.jsonl` file containing a valid user message.
  3. The `context.jsonl` file's mtime is set via `fsp.utimes()` to a float-second value (`1774212239.4580225`) that produces a sub-millisecond-precision `mtimeMs` on most filesystems.
- **Actions**:
  1. Instantiate `KimiProvider` with the temporary share directory.
  2. Call `provider.listSessionsDirect()`.
  3. Find the session in the returned list.
  4. Check `Number.isInteger(session.lastActivityAt)`.
  5. Pass the session through `SessionDirectoryItemSchema.parse()` to verify end-to-end Zod compliance.
- **Expected outcome**:
  1. `session.lastActivityAt` is an integer (`Number.isInteger()` returns `true`). Source of truth: the `z.number().int().nonnegative()` contract on `SessionDirectoryItemSchema.lastActivityAt`.
  2. `SessionDirectoryItemSchema.parse()` succeeds without throwing when given the session data plus `isRunning: false`. Source of truth: same schema.
- **Interactions**: Exercises the full `KimiProvider.loadSessionCandidate()` → `CodingCliSession` pipeline including filesystem stat. The `resolveGitRepoRoot` and `resolveGitBranchAndDirty` calls are mocked (existing mock in the test file). Note: on tmpfs or other filesystems that truncate `mtimeMs` to integer precision, the test may pass vacuously before the fix. The schema regression anchor (Tests 1-2) provides the primary defense; this test provides defense-in-depth on filesystems that preserve sub-millisecond precision.

### Test 4: Full test suite passes (verification gate)

- **Name**: All existing tests continue to pass after the `Math.trunc()` fix
- **Type**: invariant
- **Disposition**: existing
- **Harness**: `npm test` (coordinated full suite)
- **Preconditions**: Tasks 1-3 are complete and committed.
- **Actions**: Run `npm test`.
- **Expected outcome**: All tests pass. No regressions introduced by the one-line `Math.trunc()` change. Source of truth: existing test suite as the regression baseline.
- **Interactions**: Exercises the entire codebase. Any failure indicates a regression from the change.

## Coverage summary

### Covered

| Area | Tests | Coverage |
|------|-------|----------|
| Zod schema integer enforcement for `lastActivityAt` | Tests 1-2 | Direct assertion against the schema contract; locks the `.int()` constraint against future loosening |
| Kimi provider `lastActivityAt` integer output | Test 3 | End-to-end through `KimiProvider.listSessionsDirect()` with a float-mtime fixture, validated against `SessionDirectoryItemSchema.parse()` |
| Full regression baseline | Test 4 | Entire test suite confirms no collateral damage |

### Explicitly excluded (per strategy)

| Area | Reason | Risk |
|------|--------|------|
| Rate limit configuration changes | Implementation plan is scoped to the float timestamp bug only; rate limit changes are a separate task | Low -- the Zod rejection cascade was the primary rate-limit amplifier; fixing the float eliminates it. If a dedicated rate limit increase is pursued later, it should carry its own test plan. |
| Client-side 429 backoff behavior | Out of scope for this implementation plan | Low -- same reasoning as above. The unhandled rejection that triggered cascading `/api/logs/client` POSTs is eliminated by the float fix. |
| Other providers (`claude`, `codex`, `opencode`) `lastActivityAt` integrity | These providers derive timestamps from parsed JSONL content via `parseTimestampMs()` / `Math.round()`, which already produce integers | Negligible -- no code change touches these providers, and the schema regression anchor (Tests 1-2) would catch any future float introduction from any provider. |
