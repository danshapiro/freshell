# Inline Stop-Hook Progress Session Repair -- Test Plan

## Harness Requirements

### No new harnesses needed

All tests use existing infrastructure:

1. **Unit harness (scanner):** `vitest.server.config.ts` with `test/unit/server/session-scanner.test.ts`. Uses `createSessionScanner()` directly against fixture JSONL files. Temp directory for repair tests (copy fixture, mutate, assert). Already established with `beforeEach`/`afterEach` lifecycle.

2. **Unit harness (queue):** `vitest.server.config.ts` with `test/unit/server/session-queue.test.ts`. Uses mock scanners (`vi.fn()`) and real `SessionCache` instances in temp directories. Already established with priority, event, and waitFor patterns.

3. **Integration harness (ws-handler):** `vitest.server.config.ts` with `test/server/ws-terminal-create-session-repair.test.ts`. Spins up a real HTTP server with `WsHandler`, injects `FakeSessionRepairService` and `FakeRegistry`, connects real WebSocket clients. Already established with helper functions (`waitForReady`, `waitForCreated`, `closeWebSocket`).

**Note:** The implementation plan's test run commands reference `--config vitest.config.ts` for scanner and queue tests. This is incorrect -- those tests live under `test/unit/server/` which is excluded from the default config and included only in `vitest.server.config.ts`. The correct invocation is:
```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/session-scanner.test.ts
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/session-queue.test.ts
```
This does not affect scope or cost -- it is a correction to the plan's commands.

### Fixture files (new, required)

Two JSONL fixture files must be created before tests can run:

- `test/fixtures/sessions/inline-stop-hook-progress.jsonl` -- healthy session with the problematic active-chain shape
- `test/fixtures/sessions/sibling-stop-hook-progress.jsonl` -- healthy session with the same records but stop_hook_summary correctly parented to assistant (control)

These are specified in the implementation plan with exact content.

---

## Test Plan

### 1. Scan classifies inline stop-hook progress on the active chain as a resume issue

- **Name:** Scanning a session with inline stop-hook progress on the active chain flags `resumeIssue: 'inline_stop_hook_progress'`
- **Type:** scenario
- **Disposition:** new
- **Harness:** Unit (scanner), `vitest.server.config.ts`
- **Preconditions:** `inline-stop-hook-progress.jsonl` fixture exists with the chain shape `user -> assistant -> progress(hook_progress/Stop) -> stop_hook_summary -> turn_duration`.
- **Actions:** Call `scanner.scan(fixturePath)`.
- **Expected outcome:**
  - `result.status === 'healthy'` (source: design decision -- "the session is healthy (no orphans)")
  - `result.orphanCount === 0` (source: fixture has no orphans -- all parentUuids resolve)
  - `result.resumeIssue === 'inline_stop_hook_progress'` (source: plan Chunk 1, Step 3 test specification)
- **Interactions:** `parseMessage()` must now extract `subtype`, `toolUseID`, `dataType`, `dataHookEvent` from JSONL. `detectInlineStopHookProgress()` must walk the active leaf chain.

### 2. Scan does not flag sibling stop-hook progress (control)

- **Name:** Scanning a session where stop_hook_summary is correctly parented to assistant (not through progress) reports no resume issue
- **Type:** differential
- **Disposition:** new
- **Harness:** Unit (scanner), `vitest.server.config.ts`
- **Preconditions:** `sibling-stop-hook-progress.jsonl` fixture exists with `stop_hook_summary.parentUuid` pointing to the assistant, not the progress record.
- **Actions:** Call `scanner.scan(fixturePath)`.
- **Expected outcome:**
  - `result.status === 'healthy'` (source: fixture is healthy)
  - `result.orphanCount === 0`
  - `result.resumeIssue === undefined` (source: plan Chunk 1, Step 3 -- "does not flag sibling stop-hook progress that is off the active chain")
- **Interactions:** Same chain-walking logic; validates the specificity of the detection (does not false-positive on the repaired shape).

### 3. Scan does not flag resume issue for files without stop-hook progress

- **Name:** Scanning a normal healthy session without any stop-hook records reports no resume issue
- **Type:** regression
- **Disposition:** extend (extends existing healthy scan test)
- **Harness:** Unit (scanner), `vitest.server.config.ts`
- **Preconditions:** `healthy.jsonl` fixture exists (already present).
- **Actions:** Call `scanner.scan(fixturePath)`.
- **Expected outcome:**
  - `result.status === 'healthy'`
  - `result.resumeIssue === undefined` (source: plan Chunk 1, Step 3 -- "does not flag resume issue for files without stop-hook progress")
- **Interactions:** Ensures the new detection code does not regress existing healthy file classification.

### 4. Repair rewrites stop_hook_summary parentUuid when includeResumeIssues is true

- **Name:** Repairing an inline-progress session with `includeResumeIssues: true` reparents the stop_hook_summary to the assistant
- **Type:** scenario
- **Disposition:** new
- **Harness:** Unit (scanner), `vitest.server.config.ts`
- **Preconditions:** Copy of `inline-stop-hook-progress.jsonl` in temp directory.
- **Actions:** Call `scanner.repair(testFile, { includeResumeIssues: true })`.
- **Expected outcome:**
  - `result.status === 'repaired'` (source: plan Chunk 2, Step 1)
  - `result.resumeIssuesFixed === 1`
  - `result.orphansFixed === 0`
  - Post-repair scan: `scanAfter.status === 'healthy'` and `scanAfter.resumeIssue === undefined`
- **Interactions:** File I/O (write modified JSONL), backup creation, `detectInlineStopHookProgress` inside repair path.

### 5. Default repair (no options) does not rewrite inline-progress sessions

- **Name:** Calling repair without `includeResumeIssues` on an inline-progress session leaves the file unchanged
- **Type:** boundary
- **Disposition:** new
- **Harness:** Unit (scanner), `vitest.server.config.ts`
- **Preconditions:** Copy of `inline-stop-hook-progress.jsonl` in temp directory.
- **Actions:** Call `scanner.repair(testFile)` (no options).
- **Expected outcome:**
  - `result.status === 'already_healthy'` (source: plan Chunk 2, Step 1 -- "does not rewrite inline-progress sessions during default repair")
  - `result.resumeIssuesFixed === 0`
  - `result.orphansFixed === 0`
  - Post-repair scan: `scanAfter.resumeIssue === 'inline_stop_hook_progress'` (issue still present)
- **Interactions:** Validates the gating -- disk/background scans call `repair()` without options and must not rewrite these files.

### 6. Repair is idempotent for inline stop-hook progress

- **Name:** Calling repair with `includeResumeIssues` twice: first repairs, second is already_healthy
- **Type:** invariant
- **Disposition:** new
- **Harness:** Unit (scanner), `vitest.server.config.ts`
- **Preconditions:** Copy of `inline-stop-hook-progress.jsonl` in temp directory.
- **Actions:** Call `scanner.repair(testFile, { includeResumeIssues: true })` twice.
- **Expected outcome:**
  - First call: `status === 'repaired'`, `resumeIssuesFixed === 1`
  - Second call: `status === 'already_healthy'`, `resumeIssuesFixed === 0`
  - (Source: plan Chunk 2, Step 1 -- "repair is idempotent for inline stop-hook progress")
- **Interactions:** Validates that after repair the detection function returns undefined, preventing re-repair.

### 7. Repair preserves all fields except stop_hook_summary.parentUuid

- **Name:** After inline progress repair, only the stop_hook_summary line's parentUuid changes; all other data is preserved
- **Type:** invariant
- **Disposition:** new
- **Harness:** Unit (scanner), `vitest.server.config.ts`
- **Preconditions:** Copy of `inline-stop-hook-progress.jsonl` in temp directory.
- **Actions:** Read file before repair, call `scanner.repair(testFile, { includeResumeIssues: true })`, read file after repair.
- **Expected outcome:**
  - Same number of lines
  - Every line: `uuid` and `type` preserved
  - Line with `uuid === 's-004'` (stop_hook_summary): `parentUuid` changed from `'p-003'` to `'a-002'`
  - All other lines: `parentUuid` unchanged
  - (Source: plan Chunk 2, Step 1 -- "preserves all fields except stop_hook_summary.parentUuid during inline progress repair")
- **Interactions:** Validates the surgical nature of the rewrite -- no collateral damage to JSONL content.

### 8. Repair creates backup before inline progress repair

- **Name:** Inline progress repair creates a timestamped backup of the original file
- **Type:** scenario
- **Disposition:** new
- **Harness:** Unit (scanner), `vitest.server.config.ts`
- **Preconditions:** Copy of `inline-stop-hook-progress.jsonl` in temp directory.
- **Actions:** Read original content, call `scanner.repair(testFile, { includeResumeIssues: true })`.
- **Expected outcome:**
  - `result.backupPath` is defined and matches `/\.backup-\d+$/`
  - Backup file content equals original content
  - (Source: plan Chunk 2, Step 1 -- "creates backup before inline progress repair")
- **Interactions:** File system: backup file creation alongside the session file.

### 9. No backup created when inline progress repair is not enabled

- **Name:** Default repair on an inline-progress session does not create a backup
- **Type:** boundary
- **Disposition:** new
- **Harness:** Unit (scanner), `vitest.server.config.ts`
- **Preconditions:** Copy of `inline-stop-hook-progress.jsonl` in temp directory.
- **Actions:** Call `scanner.repair(testFile)` (no options).
- **Expected outcome:**
  - `result.status === 'already_healthy'`
  - `result.backupPath === undefined`
  - (Source: plan Chunk 2, Step 1 -- "does not create backup when inline progress repair is not enabled")
- **Interactions:** Validates that the backup is gated on actual repair, not just detection.

### 10. Progress record remains as side leaf after repair

- **Name:** After inline progress repair, the progress record is still in the file, parented to the assistant
- **Type:** invariant
- **Disposition:** new
- **Harness:** Unit (scanner), `vitest.server.config.ts`
- **Preconditions:** Copy of `inline-stop-hook-progress.jsonl` in temp directory.
- **Actions:** Call `scanner.repair(testFile, { includeResumeIssues: true })`, read file, find progress line.
- **Expected outcome:**
  - Progress line with `uuid === 'p-003'` exists
  - `progressObj.parentUuid === 'a-002'` (still parented to assistant)
  - `progressObj.type === 'progress'`
  - (Source: plan Chunk 2, Step 1 -- "leaves progress record in file as side leaf after repair")
- **Interactions:** The repair only reparents stop_hook_summary; it does not remove or modify the progress record.

### 11. Queue does not repair healthy sessions with resume issues during disk scans

- **Name:** A disk-priority scan of a session with inline-progress resume issue caches the result but does not trigger repair
- **Type:** scenario
- **Disposition:** new
- **Harness:** Unit (queue), `vitest.server.config.ts`
- **Preconditions:** Mock scanner returning a scan result with `resumeIssue: 'inline_stop_hook_progress'` and `status: 'healthy'`.
- **Actions:** Enqueue at `priority: 'disk'`, start, `waitFor()`.
- **Expected outcome:**
  - `result.status === 'healthy'`
  - `result.resumeIssue === 'inline_stop_hook_progress'`
  - `scanner.repair` not called
  - (Source: plan Chunk 3, Step 1 -- "does not repair healthy sessions with resume issues during disk scans")
- **Interactions:** Queue processing path, cache set, event emission. Validates that disk/background scans are read-only for this issue.

### 12. Queue repairs healthy sessions with resume issues during active scans

- **Name:** An active-priority scan of a session with inline-progress resume issue triggers repair and returns the clean result
- **Type:** scenario
- **Disposition:** new
- **Harness:** Unit (queue), `vitest.server.config.ts`
- **Preconditions:** Mock scanner: first `scan()` returns resume-issue result, `repair()` returns repaired result, second `scan()` returns clean result.
- **Actions:** Enqueue at `priority: 'active'`, start, `waitFor()`.
- **Expected outcome:**
  - `result.status === 'healthy'`
  - `result.resumeIssue === undefined`
  - `scanner.repair` called with `{ includeResumeIssues: true }`
  - (Source: plan Chunk 3, Step 1 -- "repairs healthy sessions with resume issues during active scans")
- **Interactions:** Queue scan-repair-rescan cycle, cache update, event emission.

### 13. Queue bypasses cache for active priority when cached result has resume issue

- **Name:** When a cached result has a resume issue and a new active-priority item arrives, the queue bypasses the cache and triggers scan+repair
- **Type:** scenario
- **Disposition:** new
- **Harness:** Unit (queue), `vitest.server.config.ts`
- **Preconditions:** Cache seeded with a result that has `resumeIssue: 'inline_stop_hook_progress'`. Mock scanner: first `scan()` returns resume-issue result, `repair()` returns repaired, second `scan()` returns clean.
- **Actions:** Enqueue at `priority: 'active'`, start, `waitFor()`.
- **Expected outcome:**
  - `result.resumeIssue === undefined`
  - `scanner.repair` called with `{ includeResumeIssues: true }`
  - (Source: plan Chunk 3, Step 1 -- "bypasses cache for active priority when cached result has resume issue")
- **Interactions:** Cache read, cache bypass logic, queue processing path.

### 14. Queue uses cached resume-issue result for disk priority without repair

- **Name:** When a cached result has a resume issue and a disk-priority item arrives, the queue uses the cached result without scanning or repairing
- **Type:** boundary
- **Disposition:** new
- **Harness:** Unit (queue), `vitest.server.config.ts`
- **Preconditions:** Cache seeded with a result that has `resumeIssue: 'inline_stop_hook_progress'`.
- **Actions:** Enqueue at `priority: 'disk'`, start, `waitFor()`.
- **Expected outcome:**
  - `result.resumeIssue === 'inline_stop_hook_progress'`
  - `scanner.scan` not called
  - `scanner.repair` not called
  - (Source: plan Chunk 3, Step 1 -- "uses cached resume-issue result for disk priority without repair")
- **Interactions:** Cache read, priority-based decision logic.

### 15. Integration: terminal.create proceeds with resume after inline-progress repair

- **Name:** When FakeSessionRepairService has a cached result with resume issue, `terminal.create` still calls `waitForSession` and proceeds with resume using the repaired result
- **Type:** integration
- **Disposition:** new
- **Harness:** Integration (ws-handler), `vitest.server.config.ts`
- **Preconditions:** `FakeSessionRepairService.result` set to a healthy result with `resumeIssue: 'inline_stop_hook_progress'`. `FakeSessionRepairService.waitForSessionResult` set to a clean healthy result (no resume issue).
- **Actions:** Connect WebSocket, handshake, send `terminal.create` with `resumeSessionId`.
- **Expected outcome:**
  - `created.effectiveResumeSessionId === VALID_SESSION_ID` (resume proceeds, not dropped)
  - `sessionRepairService.waitForSessionCalls` contains the session ID (repair path was invoked)
  - (Source: plan Chunk 4, Step 1 -- ws-handler sees `status: 'healthy'` (not missing) from getResult, falls through to waitForSession, which returns the clean result)
- **Interactions:** ws-handler -> FakeSessionRepairService.getResult() -> FakeSessionRepairService.waitForSession() -> FakeRegistry.create(). Validates the full terminal.create flow does not drop the resume for sessions that have `status: 'healthy'` with a resume issue.

### 16. Existing orphan repair behavior is unchanged

- **Name:** Existing orphan repair tests continue to pass with the new `resumeIssuesFixed` field and `options` parameter
- **Type:** regression
- **Disposition:** existing
- **Harness:** Unit (scanner), `vitest.server.config.ts`
- **Preconditions:** Existing corrupted fixture files.
- **Actions:** Run all existing `describe('repair()')` tests.
- **Expected outcome:**
  - All existing repair tests pass without modification (source: plan Chunk 1, Step 5 -- "Update the existing `repair()` to include `resumeIssuesFixed: 0` in all return paths")
  - `result.resumeIssuesFixed === 0` for all orphan-only repairs (implicitly -- existing tests don't assert this, but the implementation must not break them)
- **Interactions:** All existing repair code paths with the new optional parameter.

### 17. Existing queue processing behavior is unchanged

- **Name:** Existing queue tests continue to pass with the new cache-bypass and repair-gating logic
- **Type:** regression
- **Disposition:** existing
- **Harness:** Unit (queue), `vitest.server.config.ts`
- **Preconditions:** Existing queue test setup.
- **Actions:** Run all existing `describe('start() and processing')` and `describe('waitFor()')` tests.
- **Expected outcome:**
  - All existing tests pass (source: plan design -- changes are additive and the new logic only triggers for results with `resumeIssue`)
- **Interactions:** Queue processing for healthy, corrupted, cached, and error scenarios.

### 18. Existing integration tests for terminal.create remain unchanged

- **Name:** Existing ws-terminal-create-session-repair integration tests continue to pass
- **Type:** regression
- **Disposition:** existing
- **Harness:** Integration (ws-handler), `vitest.server.config.ts`
- **Preconditions:** Existing test setup with `FakeSessionRepairService` and `FakeRegistry`.
- **Actions:** Run all existing tests in `describe('terminal.create session repair wait')`.
- **Expected outcome:**
  - All 11 existing tests pass. The `FakeSessionRepairService` returns results without `resumeIssue` by default (undefined), so the ws-handler's behavior is unchanged.
- **Interactions:** Full ws-handler flow including repair wait, missing-session handling, duplicate prevention, disconnect handling.

### 19. TypeScript compilation passes

- **Name:** All type changes compile cleanly with no errors
- **Type:** invariant
- **Disposition:** extend (existing typecheck)
- **Harness:** `npm run typecheck`
- **Preconditions:** All source changes applied.
- **Actions:** Run `npm run typecheck`.
- **Expected outcome:**
  - Zero errors (source: plan Verification section -- "The type changes are backward-compatible")
  - The optional `resumeIssue` on `SessionScanResult`, `resumeIssuesFixed` on `SessionRepairResult`, and `options` on `repair()` do not break any existing consumers.
- **Interactions:** All files importing from `server/session-scanner/types.ts`.

---

## Coverage Summary

### Covered areas

| Area | Tests | Coverage quality |
|---|---|---|
| Scan classification (inline-progress detection) | #1, #2, #3 | Full: positive match, negative control, absence check |
| Repair writer (pointer rewrite) | #4, #5, #6, #7, #8, #9, #10 | Full: enabled/disabled, idempotency, field preservation, backup, side-leaf preservation |
| Queue gating (priority-based repair decision) | #11, #12, #13, #14 | Full: disk-no-repair, active-repair, cache-bypass, cache-reuse |
| Service + ws-handler integration | #15 | Validates the end-to-end flow for the problem statement |
| Regression (orphan repair) | #16 | Existing tests run; no modification needed |
| Regression (queue processing) | #17 | Existing tests run; no modification needed |
| Regression (ws integration) | #18 | Existing tests run; no modification needed |
| Type safety | #19 | Full typecheck |

### Explicitly excluded

| Area | Reason | Risk |
|---|---|---|
| Real `SessionRepairService.waitForSession()` unit test | The service class requires glob, fs, cache, queue, and history-repair infrastructure. The implementation plan wires the change into `waitForSession()` at three code paths (existing result, legacy result, cache result). The queue-level tests (#12, #13) prove the active-priority repair flow, and the integration test (#15) proves the ws-handler correctly calls `waitForSession`. The service-internal logic (checking `resumeIssue` and calling `clearProcessed + enqueue + waitFor`) is small enough that the combination of queue-level and integration tests provides adequate coverage. | Low. If the service fails to bypass stale results, the integration test would fail (it expects `waitForSessionCalls` to contain the session ID). A future unit-testable service refactor could add direct coverage. |
| Multi-turn inline-progress (more than one progress record) | The implementation detects exactly one pattern: the active leaf shape ending in `stop_hook_summary -> progress -> assistant`. Multiple progress records would have different leaf shapes. | Low. The detection is pattern-matched, not count-based. Additional progress records that are not on the active leaf path are ignored by design. |
| Concurrent file writes during repair | The plan explicitly defers repair to the `active` path (triggered by `terminal.create`) to avoid race conditions with running Claude processes. | Medium. If a Claude process writes to the JSONL while repair is in progress, the file could be corrupted. The backup mitigates data loss, but the repair could produce an incorrect result. This is an accepted risk per the design decision "deferring the repair to the active resume path is both safer and more efficient." |
| Frontend/UI changes | No frontend changes in this plan. | None. |
