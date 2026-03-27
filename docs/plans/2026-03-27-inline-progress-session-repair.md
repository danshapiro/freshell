# Inline Stop-Hook Progress Session Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect and repair Claude session JSONL files where an inline Stop-hook `progress` record on the active chain causes `claude --resume` to repaint as blank, without affecting disk-scan read-only behavior for otherwise healthy sessions.

**Architecture:** Extend the existing single-pass JSONL scan to classify a specific active-chain leaf shape (`assistant -> progress -> stop_hook_summary [-> turn_duration]`) as a resume issue. Keep `status: 'healthy'` for these sessions (they have no orphans). Add a `resumeIssue` field to `SessionScanResult` that the queue and service use to gate repair. Only the `active`-priority path (triggered by `terminal.create` with a `resumeSessionId`) is allowed to rewrite the file. The rewrite patches exactly one field: `stop_hook_summary.parentUuid` is changed from the `progress` UUID to the `assistant` UUID. The `progress` record stays in the file as a side leaf. After repair, the session is rescanned and cached before the resume proceeds.

**Tech Stack:** TypeScript, NodeNext/ESM, Claude JSONL session files, Vitest unit tests, Vitest server integration tests.

---

## Design Decisions and Rationale

### Why `resumeIssue` rather than a new `status` value

The existing `status` field (`healthy | corrupted | missing | unreadable`) drives eager repair for corrupted files at all priorities. Adding a new status like `resume_issue` would require auditing every consumer of `status` to decide whether to treat it like healthy or corrupted. Instead, the `resumeIssue` field is orthogonal: the session is healthy (no orphans), but has a known resume-time problem. This keeps the existing repair pipeline unchanged and adds the new behavior as a clean extension.

### Why repair only on the `active` path

Disk and background scans process hundreds of sessions at startup. Rewriting files during startup adds I/O load and creates race conditions with running Claude processes that might be writing to the same JSONL files. The inline-progress issue only manifests when `--resume` is actually invoked, so deferring the repair to the `active` resume path is both safer and more efficient.

### Why extend `ParsedMessage` minimally

The scanner's `ParsedMessage` currently extracts only `uuid`, `parentUuid`, `type`, and `lineNumber`. The inline-progress detection needs four additional fields from the raw JSON: `subtype` (for stop_hook_summary), `toolUseID` (for matching stop_hook_summary to progress), `data.type` (to confirm hook_progress), and `data.hookEvent` (to confirm Stop). These are extracted only when present, keeping the parse cost minimal.

### Why the `SessionScanner` interface gains `options` on `repair()`

The existing `repair()` signature has no options parameter. Adding `SessionRepairOptions` with `includeResumeIssues?: boolean` lets the queue signal whether this repair call should also fix resume issues. Orphan repair remains the default (no options needed). The interface change is backward-compatible: existing callers without options get the same behavior.

### Why not add `resumeIssuesFixed` to `SessionRepairResult`

The existing `SessionRepairResult` already has `orphansFixed: number` and `status: 'repaired' | 'already_healthy' | 'failed'`. Adding `resumeIssuesFixed: number` to it lets callers distinguish orphan repairs from resume-issue repairs, which is useful for logging and testing. The existing `status` values remain sufficient: `repaired` means something was fixed, `already_healthy` means nothing needed fixing.

---

## File Structure Map

- Modify: `server/session-scanner/types.ts`
  - Add `SessionResumeIssue` type, `resumeIssue` field to `SessionScanResult`, `resumeIssuesFixed` field to `SessionRepairResult`, `SessionRepairOptions` interface, update `SessionScanner.repair()` signature.
- Modify: `server/session-scanner/scanner.ts`
  - Extend `parseMessage()` to extract four additional fields. Add `detectInlineStopHookProgress()` function. Wire classification into `scan()` and targeted pointer rewrite into `repair()`.
- Modify: `server/session-scanner/queue.ts`
  - Add cache-bypass logic for `resumeIssue` results at `active` priority. Pass `includeResumeIssues` to `repair()` when appropriate. Add `clearProcessed(sessionId)` method to allow the service to remove stale processed entries before re-enqueueing.
- Modify: `server/session-scanner/service.ts`
  - Prevent `waitForSession()` from returning cached results with `resumeIssue` directly; call `clearProcessed` then re-enqueue at `active` priority.
- Create: `test/fixtures/sessions/inline-stop-hook-progress.jsonl`
  - Healthy session whose active chain has the exact inline-progress shape: `user -> assistant -> progress(hook_progress/Stop) -> stop_hook_summary -> turn_duration`.
- Create: `test/fixtures/sessions/sibling-stop-hook-progress.jsonl`
  - Control fixture: same hook records present but the stop_hook_summary is parented to the assistant (not the progress), so no resume issue.
- Modify: `test/unit/server/session-scanner.test.ts`
  - Add scan classification and repair tests for inline-progress detection.
- Modify: `test/unit/server/session-queue.test.ts`
  - Add queue-level tests proving disk scans only classify while active priority triggers repair.
- Modify: `test/server/ws-terminal-create-session-repair.test.ts`
  - Add integration test proving `terminal.create` blocks for inline-progress repair on the active path.

---

## Chunk 1: Scanner Classification

### Task 1: Create fixture files and extend scanner to classify inline stop-hook progress

**Files:**
- Create: `test/fixtures/sessions/inline-stop-hook-progress.jsonl`
- Create: `test/fixtures/sessions/sibling-stop-hook-progress.jsonl`
- Modify: `server/session-scanner/types.ts`
- Modify: `server/session-scanner/scanner.ts`
- Modify: `test/unit/server/session-scanner.test.ts`

- [ ] **Step 1: Create the inline-stop-hook-progress fixture**

This fixture must be **healthy** (no orphans) but have the active chain shape that causes blank resume. The key shape is:

```
user -> assistant -> progress(type=progress, data.type=hook_progress, data.hookEvent=Stop) -> stop_hook_summary(type=system, subtype=stop_hook_summary, matching toolUseID) -> turn_duration(type=system, subtype=turn_duration)
```

Create `test/fixtures/sessions/inline-stop-hook-progress.jsonl`:

```jsonl
{"type":"user","message":"Help me with a task","uuid":"u-001","parentUuid":null,"timestamp":"2026-01-30T10:00:00.000Z"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Sure, I can help."}]},"uuid":"a-002","parentUuid":"u-001","timestamp":"2026-01-30T10:00:01.000Z"}
{"type":"progress","data":{"type":"hook_progress","hookEvent":"Stop","hookName":"Stop","command":"echo done"},"toolUseID":"tool-001","parentToolUseID":"tool-001","uuid":"p-003","parentUuid":"a-002","timestamp":"2026-01-30T10:00:02.000Z"}
{"type":"system","subtype":"stop_hook_summary","hookCount":1,"hookInfos":[{"command":"echo done"}],"hookErrors":[],"preventedContinuation":false,"stopReason":"","hasOutput":false,"level":"suggestion","uuid":"s-004","parentUuid":"p-003","toolUseID":"tool-001","timestamp":"2026-01-30T10:00:03.000Z"}
{"type":"system","subtype":"turn_duration","durationMs":2500,"uuid":"td-005","parentUuid":"s-004","timestamp":"2026-01-30T10:00:04.000Z"}
```

This has 5 messages, all with valid parent chains (no orphans), so the existing scanner will report `status: 'healthy'`. But the active chain suffix is `assistant -> progress -> stop_hook_summary -> turn_duration`, which is exactly the shape that causes blank resume.

- [ ] **Step 2: Create the sibling-stop-hook-progress control fixture**

This fixture has the same hook records present, but the `stop_hook_summary` is parented directly to the `assistant` (bypassing the `progress`). This is the "already repaired" or "non-problematic" shape. The `progress` record exists as a side leaf, not inline on the active chain.

Create `test/fixtures/sessions/sibling-stop-hook-progress.jsonl`:

```jsonl
{"type":"user","message":"Help me with a task","uuid":"u-001","parentUuid":null,"timestamp":"2026-01-30T10:00:00.000Z"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Sure, I can help."}]},"uuid":"a-002","parentUuid":"u-001","timestamp":"2026-01-30T10:00:01.000Z"}
{"type":"progress","data":{"type":"hook_progress","hookEvent":"Stop","hookName":"Stop","command":"echo done"},"toolUseID":"tool-001","parentToolUseID":"tool-001","uuid":"p-003","parentUuid":"a-002","timestamp":"2026-01-30T10:00:02.000Z"}
{"type":"system","subtype":"stop_hook_summary","hookCount":1,"hookInfos":[{"command":"echo done"}],"hookErrors":[],"preventedContinuation":false,"stopReason":"","hasOutput":false,"level":"suggestion","uuid":"s-004","parentUuid":"a-002","toolUseID":"tool-001","timestamp":"2026-01-30T10:00:03.000Z"}
{"type":"system","subtype":"turn_duration","durationMs":2500,"uuid":"td-005","parentUuid":"s-004","timestamp":"2026-01-30T10:00:04.000Z"}
```

Note: the only difference is `s-004.parentUuid` is `"a-002"` (the assistant) instead of `"p-003"` (the progress).

- [ ] **Step 3: Write the failing scan classification tests**

Add to `test/unit/server/session-scanner.test.ts` inside the `describe('scan()')` block:

```typescript
it('flags inline stop-hook progress on the active chain as a resume issue', async () => {
  const result = await scanner.scan(path.join(FIXTURES_DIR, 'inline-stop-hook-progress.jsonl'))

  expect(result.status).toBe('healthy')
  expect(result.orphanCount).toBe(0)
  expect(result.resumeIssue).toBe('inline_stop_hook_progress')
})

it('does not flag sibling stop-hook progress that is off the active chain', async () => {
  const result = await scanner.scan(path.join(FIXTURES_DIR, 'sibling-stop-hook-progress.jsonl'))

  expect(result.status).toBe('healthy')
  expect(result.orphanCount).toBe(0)
  expect(result.resumeIssue).toBeUndefined()
})

it('does not flag resume issue for files without stop-hook progress', async () => {
  const result = await scanner.scan(path.join(FIXTURES_DIR, 'healthy.jsonl'))

  expect(result.status).toBe('healthy')
  expect(result.resumeIssue).toBeUndefined()
})
```

- [ ] **Step 4: Run the scanner tests to verify the new assertions fail**

Run:

```bash
npm run test:vitest -- --config vitest.config.ts test/unit/server/session-scanner.test.ts
```

Expected: FAIL because `SessionScanResult` does not yet have a `resumeIssue` property and the scanner does not classify the inline-progress leaf shape.

- [ ] **Step 5: Extend types and implement bounded leaf-shape detection**

In `server/session-scanner/types.ts`:

1. Add the resume issue type:

```typescript
/**
 * Known resume issues that don't constitute corruption but prevent
 * successful `--resume` in Claude CLI.
 */
export type SessionResumeIssue = 'inline_stop_hook_progress'
```

2. Add `resumeIssue` to `SessionScanResult`:

```typescript
export interface SessionScanResult {
  // ... existing fields ...
  /** Resume issue detected on the active chain, if any */
  resumeIssue?: SessionResumeIssue
}
```

3. Add `SessionRepairOptions`:

```typescript
/**
 * Options for session repair.
 */
export interface SessionRepairOptions {
  /** Also fix resume issues (not just orphans). Default: false. */
  includeResumeIssues?: boolean
}
```

4. Add `resumeIssuesFixed` to `SessionRepairResult`:

```typescript
export interface SessionRepairResult {
  // ... existing fields ...
  /** Number of resume issues that were fixed */
  resumeIssuesFixed: number
}
```

5. Update the `SessionScanner` interface's `repair()` method:

```typescript
export interface SessionScanner {
  scan(filePath: string): Promise<SessionScanResult>
  repair(filePath: string, options?: SessionRepairOptions): Promise<SessionRepairResult>
  scanBatch(filePaths: string[]): Promise<SessionScanResult[]>
}
```

In `server/session-scanner/scanner.ts`:

1. Extend `ParsedMessage` fields extracted in `parseMessage()`. Add `subtype`, `toolUseID`, and two fields from `data`:

```typescript
function parseMessage(line: string, lineNumber: number): ParsedMessage | null {
  if (!line.trim()) return null

  try {
    const obj = JSON.parse(line)
    if (!obj.uuid) return null

    return {
      uuid: obj.uuid,
      parentUuid: obj.parentUuid,
      type: obj.type,
      lineNumber,
      subtype: obj.subtype,
      toolUseID: obj.toolUseID,
      dataType: obj.data?.type,
      dataHookEvent: obj.data?.hookEvent,
    }
  } catch {
    return null
  }
}
```

2. Update the `ParsedMessage` interface in `types.ts` to include these optional fields:

```typescript
export interface ParsedMessage {
  uuid: string
  parentUuid?: string
  type?: string
  lineNumber: number
  /** System message subtype (e.g. 'stop_hook_summary', 'turn_duration') */
  subtype?: string
  /** Tool use ID for progress/hook records */
  toolUseID?: string
  /** data.type for progress records (e.g. 'hook_progress') */
  dataType?: string
  /** data.hookEvent for progress records (e.g. 'Stop') */
  dataHookEvent?: string
}
```

3. Add the detection function in `scanner.ts`:

```typescript
/**
 * Detect the inline stop-hook progress chain shape on the active leaf.
 *
 * The problematic shape is (from leaf toward root):
 *   turn_duration? -> stop_hook_summary -> progress(hook_progress/Stop) -> assistant
 *
 * Where stop_hook_summary.parentUuid === progress.uuid
 *   and stop_hook_summary.toolUseID === progress.toolUseID
 *   and progress.dataType === 'hook_progress'
 *   and progress.dataHookEvent === 'Stop'
 *   and the progress is parented to an assistant message.
 *
 * Returns the matched nodes if found, or undefined.
 */
interface InlineProgressMatch {
  stopSummary: ParsedMessage
  progress: ParsedMessage
  assistant: ParsedMessage
}

function detectInlineStopHookProgress(
  lastMessage: ParsedMessage | undefined,
  uuidToMessage: Map<string, ParsedMessage>,
): InlineProgressMatch | undefined {
  if (!lastMessage) return undefined

  // The leaf may be turn_duration (skip it) or stop_hook_summary directly
  let candidate = lastMessage
  if (candidate.type === 'system' && candidate.subtype === 'turn_duration' && candidate.parentUuid) {
    const parent = uuidToMessage.get(candidate.parentUuid)
    if (parent) candidate = parent
  }

  // Candidate should be stop_hook_summary
  if (candidate.type !== 'system' || candidate.subtype !== 'stop_hook_summary') return undefined
  const stopSummary = candidate

  // Parent of stop_hook_summary should be the progress record
  if (!stopSummary.parentUuid) return undefined
  const progress = uuidToMessage.get(stopSummary.parentUuid)
  if (!progress) return undefined

  // Validate progress record
  if (progress.type !== 'progress') return undefined
  if (progress.dataType !== 'hook_progress') return undefined
  if (progress.dataHookEvent !== 'Stop') return undefined

  // Validate toolUseID match
  if (!stopSummary.toolUseID || stopSummary.toolUseID !== progress.toolUseID) return undefined

  // Parent of progress should be an assistant message
  if (!progress.parentUuid) return undefined
  const assistant = uuidToMessage.get(progress.parentUuid)
  if (!assistant) return undefined
  if (assistant.type !== 'assistant') return undefined

  return { stopSummary, progress, assistant }
}
```

4. Wire classification into `scan()`. After calculating orphans and chain depth, add:

```typescript
// Detect resume issue on active chain (bounded: at most 3 parent hops from leaf)
const lastMessage = messages.length > 0 ? messages[messages.length - 1] : undefined
const resumeMatch = detectInlineStopHookProgress(lastMessage, uuidToMessage)

return {
  sessionId,
  filePath,
  status: orphans.length > 0 ? 'corrupted' : 'healthy',
  chainDepth,
  orphanCount: orphans.length,
  fileSize: stat.size,
  messageCount: messages.length,
  resumeIssue: resumeMatch ? 'inline_stop_hook_progress' : undefined,
}
```

5. Update the existing `repair()` to include `resumeIssuesFixed: 0` in all return paths. The `repair()` signature gains the optional `options` parameter but the inline-progress repair logic is added in Task 2.

- [ ] **Step 6: Run the scanner tests to verify they pass**

Run:

```bash
npm run test:vitest -- --config vitest.config.ts test/unit/server/session-scanner.test.ts
```

Expected: All tests PASS, including the three new classification tests and all existing tests. Existing tests should continue to pass unchanged because `resumeIssue` defaults to `undefined` for healthy files without the inline-progress shape, and `resumeIssuesFixed` is always 0 (repair not yet implemented).

- [ ] **Step 7: Refactor and verify**

Review the code for clarity. Ensure:
- `detectInlineStopHookProgress` is well-named and documented
- `ParsedMessage` field names are consistent with the raw JSON field names
- No unnecessary fields are being extracted
- The detection function handles all edge cases (missing fields, missing parents)

Run:

```bash
npm run test:vitest -- --config vitest.config.ts test/unit/server/session-scanner.test.ts
```

Expected: All PASS.

- [ ] **Step 8: Commit**

```bash
git add \
  server/session-scanner/types.ts \
  server/session-scanner/scanner.ts \
  test/fixtures/sessions/inline-stop-hook-progress.jsonl \
  test/fixtures/sessions/sibling-stop-hook-progress.jsonl \
  test/unit/server/session-scanner.test.ts
git commit -m "feat: classify inline stop-hook progress resume issue in scanner"
```

---

## Chunk 2: Targeted Repair Writer

### Task 2: Implement the pointer rewrite for classified resume issues

**Files:**
- Modify: `server/session-scanner/scanner.ts`
- Modify: `test/unit/server/session-scanner.test.ts`

- [ ] **Step 1: Write the failing repair tests**

Add to `test/unit/server/session-scanner.test.ts` inside the `describe('repair()')` block:

```typescript
it('rewrites stop_hook_summary parentUuid to bypass inline stop-hook progress when enabled', async () => {
  const testFile = await copyFixture('inline-stop-hook-progress.jsonl')

  const result = await scanner.repair(testFile, { includeResumeIssues: true })

  expect(result.status).toBe('repaired')
  expect(result.resumeIssuesFixed).toBe(1)
  expect(result.orphansFixed).toBe(0)

  // Verify the file is now clean (no resume issue)
  const scanAfter = await scanner.scan(testFile)
  expect(scanAfter.status).toBe('healthy')
  expect(scanAfter.resumeIssue).toBeUndefined()
})

it('does not rewrite inline-progress sessions during default repair (no options)', async () => {
  const testFile = await copyFixture('inline-stop-hook-progress.jsonl')

  const result = await scanner.repair(testFile)

  expect(result.status).toBe('already_healthy')
  expect(result.resumeIssuesFixed).toBe(0)
  expect(result.orphansFixed).toBe(0)

  // Resume issue should still be present
  const scanAfter = await scanner.scan(testFile)
  expect(scanAfter.resumeIssue).toBe('inline_stop_hook_progress')
})

it('repair is idempotent for inline stop-hook progress', async () => {
  const testFile = await copyFixture('inline-stop-hook-progress.jsonl')

  const result1 = await scanner.repair(testFile, { includeResumeIssues: true })
  expect(result1.status).toBe('repaired')
  expect(result1.resumeIssuesFixed).toBe(1)

  const result2 = await scanner.repair(testFile, { includeResumeIssues: true })
  expect(result2.status).toBe('already_healthy')
  expect(result2.resumeIssuesFixed).toBe(0)
})

it('preserves all fields except stop_hook_summary.parentUuid during inline progress repair', async () => {
  const testFile = await copyFixture('inline-stop-hook-progress.jsonl')
  const linesBefore = (await fs.readFile(testFile, 'utf8')).split('\n').filter(Boolean)

  await scanner.repair(testFile, { includeResumeIssues: true })

  const linesAfter = (await fs.readFile(testFile, 'utf8')).split('\n').filter(Boolean)
  expect(linesAfter.length).toBe(linesBefore.length)

  for (let i = 0; i < linesBefore.length; i++) {
    const before = JSON.parse(linesBefore[i])
    const after = JSON.parse(linesAfter[i])

    // uuid, type, and all non-parentUuid fields must be preserved
    expect(after.uuid).toBe(before.uuid)
    expect(after.type).toBe(before.type)

    // Only the stop_hook_summary line should have a changed parentUuid
    if (before.uuid === 's-004') {
      // stop_hook_summary was re-parented from progress (p-003) to assistant (a-002)
      expect(before.parentUuid).toBe('p-003')
      expect(after.parentUuid).toBe('a-002')
    } else {
      expect(after.parentUuid).toBe(before.parentUuid)
    }
  }
})

it('creates backup before inline progress repair', async () => {
  const testFile = await copyFixture('inline-stop-hook-progress.jsonl')
  const originalContent = await fs.readFile(testFile, 'utf8')

  const result = await scanner.repair(testFile, { includeResumeIssues: true })

  expect(result.backupPath).toBeDefined()
  expect(result.backupPath).toMatch(/\.backup-\d+$/)

  const backupContent = await fs.readFile(result.backupPath!, 'utf8')
  expect(backupContent).toBe(originalContent)
})

it('does not create backup when inline progress repair is not enabled', async () => {
  const testFile = await copyFixture('inline-stop-hook-progress.jsonl')

  const result = await scanner.repair(testFile)

  expect(result.status).toBe('already_healthy')
  expect(result.backupPath).toBeUndefined()
})

it('leaves progress record in file as side leaf after repair', async () => {
  const testFile = await copyFixture('inline-stop-hook-progress.jsonl')

  await scanner.repair(testFile, { includeResumeIssues: true })

  const content = await fs.readFile(testFile, 'utf8')
  const lines = content.split('\n').filter(Boolean)
  const progressLine = lines.find(l => {
    const obj = JSON.parse(l)
    return obj.uuid === 'p-003'
  })
  expect(progressLine).toBeDefined()
  // Progress record should still be parented to assistant
  const progressObj = JSON.parse(progressLine!)
  expect(progressObj.parentUuid).toBe('a-002')
  expect(progressObj.type).toBe('progress')
})
```

- [ ] **Step 2: Run the repair tests to verify they fail**

Run:

```bash
npm run test:vitest -- --config vitest.config.ts test/unit/server/session-scanner.test.ts
```

Expected: FAIL because `repair()` does not yet accept options or fix resume issues.

- [ ] **Step 3: Implement the pointer rewrite in `repair()`**

In `server/session-scanner/scanner.ts`, modify the `repair()` function:

1. Add the `options` parameter:

```typescript
async function repair(filePath: string, options?: SessionRepairOptions): Promise<SessionRepairResult> {
```

2. **Critical:** Update the inline `ParsedMessage` construction inside `repair()` to include the new fields. The existing code (around line 182) builds ParsedMessage with only `uuid`, `parentUuid`, `type`, `lineNumber`. The `detectInlineStopHookProgress` function needs `subtype`, `toolUseID`, `dataType`, and `dataHookEvent`. Update the inline construction:

```typescript
const msg: ParsedMessage = {
  uuid: obj.uuid,
  parentUuid: obj.parentUuid,
  type: obj.type,
  lineNumber: i,
  subtype: obj.subtype,
  toolUseID: obj.toolUseID,
  dataType: obj.data?.type,
  dataHookEvent: obj.data?.hookEvent,
}
```

Without this change, `detectInlineStopHookProgress` will always return `undefined` inside `repair()` because the ParsedMessage objects will lack the fields it checks. Note: `repair()` does NOT call `parseMessage()` -- it builds ParsedMessage inline because it also needs `lineToObj`. Both code paths must extract the same fields.

3. After building `messages`, `uuidToMessage`, and `lineToObj` but before the orphan check, detect the inline-progress match when enabled:

```typescript
const inlineMatch = options?.includeResumeIssues
  ? detectInlineStopHookProgress(
      messages.length > 0 ? messages[messages.length - 1] : undefined,
      uuidToMessage,
    )
  : undefined
```

4. Update the early-return condition to check both orphans and inline match:

```typescript
if (orphans.length === 0 && !inlineMatch) {
  const chainDepth = calculateChainDepth(messages, uuidToMessage)
  return {
    sessionId,
    status: 'already_healthy',
    orphansFixed: 0,
    resumeIssuesFixed: 0,
    newChainDepth: chainDepth,
  }
}
```

5. After the orphan-fix loop, add the inline-progress fix:

```typescript
let resumeIssuesFixed = 0
if (inlineMatch) {
  const obj = lineToObj.get(inlineMatch.stopSummary.lineNumber)
  if (obj) {
    obj.parentUuid = inlineMatch.assistant.uuid
    fixedLines[inlineMatch.stopSummary.lineNumber] = JSON.stringify(obj)
    resumeIssuesFixed = 1
  }
}
```

6. Include `resumeIssuesFixed` in all return paths of the function.

7. Ensure backup creation still happens before the write -- the existing backup code already runs before writing `fixedLines`, which is correct. The backup condition should be: create backup if `orphans.length > 0 || inlineMatch`.

Important implementation note: the existing backup code is already positioned before `fixedLines` is written. If the orphan section was the only thing creating backups, verify that the backup creation also fires for inline-only repairs. The cleanest approach is: move the backup creation to after all fixes are determined but before writing, and gate it on `orphans.length > 0 || resumeIssuesFixed > 0`.

- [ ] **Step 4: Run the scanner tests to verify they pass**

Run:

```bash
npm run test:vitest -- --config vitest.config.ts test/unit/server/session-scanner.test.ts
```

Expected: All PASS, including all new repair tests and all existing orphan repair tests.

- [ ] **Step 5: Refactor and verify**

Check that:
- The repair function handles the case where both orphans and inline-progress issues exist in the same file (both should be fixed in one pass)
- The `resumeIssuesFixed` count is accurate
- Backup creation is correct for all combinations
- The function signature update is reflected in the import from `types.ts`

Run the full scanner suite:

```bash
npm run test:vitest -- --config vitest.config.ts test/unit/server/session-scanner.test.ts
```

Expected: All PASS.

- [ ] **Step 6: Commit**

```bash
git add \
  server/session-scanner/scanner.ts \
  test/unit/server/session-scanner.test.ts
git commit -m "feat: implement inline stop-hook progress pointer rewrite"
```

---

## Chunk 3: Queue Gating

### Task 3: Make the queue trigger inline-progress repair only for active priority

**Files:**
- Modify: `server/session-scanner/queue.ts`
- Modify: `test/unit/server/session-queue.test.ts`

- [ ] **Step 1: Write the failing queue tests**

Add to `test/unit/server/session-queue.test.ts` inside the `describe('start() and processing')` block:

```typescript
it('does not repair healthy sessions with resume issues during disk scans', async () => {
  const scanResult: SessionScanResult = {
    sessionId: 'resume-issue',
    filePath: '/tmp/resume-issue.jsonl',
    status: 'healthy',
    chainDepth: 5,
    orphanCount: 0,
    fileSize: 500,
    messageCount: 5,
    resumeIssue: 'inline_stop_hook_progress',
  }

  const scanner = {
    scan: vi.fn().mockResolvedValue(scanResult),
    repair: vi.fn(),
    scanBatch: vi.fn(),
  }

  const localCache = new SessionCache(path.join(tempDir, 'cache-disk.json'))
  const localQueue = new SessionRepairQueue(scanner as any, localCache)

  localQueue.enqueue([
    { sessionId: 'resume-issue', filePath: '/tmp/resume-issue.jsonl', priority: 'disk' },
  ])

  localQueue.start()
  const result = await localQueue.waitFor('resume-issue', 5000)

  expect(result.status).toBe('healthy')
  expect(result.resumeIssue).toBe('inline_stop_hook_progress')
  expect(scanner.repair).not.toHaveBeenCalled()

  await localQueue.stop()
})

it('repairs healthy sessions with resume issues during active scans', async () => {
  const scanResult: SessionScanResult = {
    sessionId: 'resume-issue',
    filePath: '/tmp/resume-issue.jsonl',
    status: 'healthy',
    chainDepth: 5,
    orphanCount: 0,
    fileSize: 500,
    messageCount: 5,
    resumeIssue: 'inline_stop_hook_progress',
  }

  const repairedScanResult: SessionScanResult = {
    ...scanResult,
    resumeIssue: undefined,
  }

  const scanner = {
    scan: vi.fn()
      .mockResolvedValueOnce(scanResult)
      .mockResolvedValueOnce(repairedScanResult),
    repair: vi.fn().mockResolvedValue({
      sessionId: 'resume-issue',
      status: 'repaired',
      orphansFixed: 0,
      resumeIssuesFixed: 1,
      newChainDepth: 5,
    }),
    scanBatch: vi.fn(),
  }

  const localCache = new SessionCache(path.join(tempDir, 'cache-active.json'))
  const localQueue = new SessionRepairQueue(scanner as any, localCache)

  localQueue.enqueue([
    { sessionId: 'resume-issue', filePath: '/tmp/resume-issue.jsonl', priority: 'active' },
  ])

  localQueue.start()
  const result = await localQueue.waitFor('resume-issue', 5000)

  expect(result.status).toBe('healthy')
  expect(result.resumeIssue).toBeUndefined()
  expect(scanner.repair).toHaveBeenCalledWith('/tmp/resume-issue.jsonl', { includeResumeIssues: true })

  await localQueue.stop()
})

it('bypasses cache for active priority when cached result has resume issue', async () => {
  const cachedResult: SessionScanResult = {
    sessionId: 'cached-resume-issue',
    filePath: path.join(tempDir, 'cached-resume.jsonl'),
    status: 'healthy',
    chainDepth: 5,
    orphanCount: 0,
    fileSize: 500,
    messageCount: 5,
    resumeIssue: 'inline_stop_hook_progress',
  }

  // Create a real file so cache.set stat() works
  await fs.writeFile(path.join(tempDir, 'cached-resume.jsonl'), '{}')

  const repairedScanResult: SessionScanResult = {
    ...cachedResult,
    resumeIssue: undefined,
  }

  const scanner = {
    scan: vi.fn()
      .mockResolvedValueOnce(cachedResult)
      .mockResolvedValueOnce(repairedScanResult),
    repair: vi.fn().mockResolvedValue({
      sessionId: 'cached-resume-issue',
      status: 'repaired',
      orphansFixed: 0,
      resumeIssuesFixed: 1,
      newChainDepth: 5,
    }),
    scanBatch: vi.fn(),
  }

  const localCache = new SessionCache(path.join(tempDir, 'cache-bypass.json'))
  // Seed cache with the resume-issue result
  await localCache.set(path.join(tempDir, 'cached-resume.jsonl'), cachedResult)

  const localQueue = new SessionRepairQueue(scanner as any, localCache)
  localQueue.enqueue([
    { sessionId: 'cached-resume-issue', filePath: path.join(tempDir, 'cached-resume.jsonl'), priority: 'active' },
  ])

  localQueue.start()
  const result = await localQueue.waitFor('cached-resume-issue', 5000)

  expect(result.resumeIssue).toBeUndefined()
  expect(scanner.repair).toHaveBeenCalledWith(
    path.join(tempDir, 'cached-resume.jsonl'),
    { includeResumeIssues: true },
  )

  await localQueue.stop()
})

it('uses cached resume-issue result for disk priority without repair', async () => {
  const cachedResult: SessionScanResult = {
    sessionId: 'cached-disk-resume',
    filePath: path.join(tempDir, 'cached-disk.jsonl'),
    status: 'healthy',
    chainDepth: 5,
    orphanCount: 0,
    fileSize: 500,
    messageCount: 5,
    resumeIssue: 'inline_stop_hook_progress',
  }

  await fs.writeFile(path.join(tempDir, 'cached-disk.jsonl'), '{}')

  const scanner = {
    scan: vi.fn(),
    repair: vi.fn(),
    scanBatch: vi.fn(),
  }

  const localCache = new SessionCache(path.join(tempDir, 'cache-disk-reuse.json'))
  await localCache.set(path.join(tempDir, 'cached-disk.jsonl'), cachedResult)

  const localQueue = new SessionRepairQueue(scanner as any, localCache)
  localQueue.enqueue([
    { sessionId: 'cached-disk-resume', filePath: path.join(tempDir, 'cached-disk.jsonl'), priority: 'disk' },
  ])

  localQueue.start()
  const result = await localQueue.waitFor('cached-disk-resume', 5000)

  expect(result.resumeIssue).toBe('inline_stop_hook_progress')
  expect(scanner.scan).not.toHaveBeenCalled()
  expect(scanner.repair).not.toHaveBeenCalled()

  await localQueue.stop()
})
```

- [ ] **Step 2: Run the queue tests to verify they fail**

Run:

```bash
npm run test:vitest -- --config vitest.config.ts test/unit/server/session-queue.test.ts
```

Expected: FAIL because the queue does not distinguish resume issues from healthy results and does not pass `includeResumeIssues` to `repair()`.

- [ ] **Step 3: Implement active-only repair promotion in the queue**

In `server/session-scanner/queue.ts`, import `SessionRepairOptions` from `types.js`.

Then modify the `processNext()` method. The key changes are:

1. **Cache bypass for active priority with resume issues.** After the cache check, if the cached result has a `resumeIssue` and the item's priority is `active`, do NOT use the cached result -- fall through to scan and repair.

Replace the cache-hit block:

```typescript
// Check cache first
const cached = await this.cache.get(item.filePath, {
  allowStaleMs: item.priority === 'active' ? ACTIVE_CACHE_GRACE_MS : undefined,
})
if (cached) {
  // For active priority: bypass cache if result has a resume issue that needs repair
  if (item.priority === 'active' && cached.resumeIssue) {
    // Fall through to scan/repair path below
  } else {
    const normalized = cached.sessionId === item.sessionId
      ? cached
      : { ...cached, sessionId: item.sessionId }
    await this.postScan?.(normalized)
    this.setProcessed(item.sessionId, normalized)
    this.emit('scanned', normalized)
    this.resolveWaiting(item.sessionId, normalized)
    return
  }
}
```

2. **Repair for active priority with resume issues.** After the scan, in addition to repairing `corrupted` sessions, also repair `healthy` sessions with resume issues when the priority is `active`:

Replace the repair decision block:

```typescript
// Repair if corrupted, or if active priority and has resume issue
const needsRepair = normalizedScan.status === 'corrupted'
  || (item.priority === 'active' && !!normalizedScan.resumeIssue)

if (needsRepair) {
  const repairOptions: SessionRepairOptions = item.priority === 'active' && normalizedScan.resumeIssue
    ? { includeResumeIssues: true }
    : {}
  const repairResult = await this.scanner.repair(item.filePath, repairOptions)
  this.emit('repaired', repairResult)

  // Re-scan to get updated result
  const newResult = await this.scanner.scan(item.filePath)
  await this.cache.set(item.filePath, newResult)
  const normalizedNew = newResult.sessionId === item.sessionId
    ? newResult
    : { ...newResult, sessionId: item.sessionId }
  await this.postScan?.(normalizedNew)
  this.setProcessed(item.sessionId, normalizedNew)
  this.resolveWaiting(item.sessionId, normalizedNew)
} else {
  await this.postScan?.(normalizedScan)
  this.setProcessed(item.sessionId, normalizedScan)
  this.resolveWaiting(item.sessionId, normalizedScan)
}
```

Note: The import needs `SessionRepairOptions` from `./types.js`. Add it to the existing import.

3. **Add `clearProcessed(sessionId)` method.** The service layer (Task 4) needs to clear a stale processed result before re-enqueueing a session for active repair. Without this, `queue.waitFor()` would immediately return the stale result from `this.processed` before the re-enqueued item is processed. Add:

```typescript
/**
 * Remove a processed result so the session can be re-enqueued and re-awaited.
 * Used by the service layer to force active-priority re-processing.
 */
clearProcessed(sessionId: string): void {
  this.processed.delete(sessionId)
}
```

This is a one-line method but it solves a critical race: `waitFor()` checks `this.processed` first and returns immediately if found. If the service calls `enqueue()` then `waitFor()` without clearing the stale processed entry, `waitFor()` returns the old (resume-issue) result immediately.

- [ ] **Step 4: Run the queue tests to verify they pass**

Run:

```bash
npm run test:vitest -- --config vitest.config.ts test/unit/server/session-queue.test.ts
```

Expected: All PASS, including all new resume-issue tests and all existing queue tests.

- [ ] **Step 5: Refactor and verify**

Ensure:
- Orphan repair remains eager for all priorities (no regression)
- The `SessionRepairOptions` import is clean
- No duplicate code between the corrupt path and the resume-issue path

Run:

```bash
npm run test:vitest -- --config vitest.config.ts test/unit/server/session-queue.test.ts
```

Expected: All PASS.

- [ ] **Step 6: Commit**

```bash
git add \
  server/session-scanner/queue.ts \
  test/unit/server/session-queue.test.ts
git commit -m "feat: gate inline progress repair to active priority in queue"
```

---

## Chunk 4: Service Layer Gating

### Task 4: Make `waitForSession()` force active repair for cached resume issues

**Files:**
- Modify: `server/session-scanner/service.ts`
- Modify: `test/server/ws-terminal-create-session-repair.test.ts`

- [ ] **Step 1: Write the failing service integration test**

Add to `test/server/ws-terminal-create-session-repair.test.ts`:

First, update the `FakeSessionRepairService` to support the new `resumeIssue` field in its default response and add the ability to simulate the transition. The existing fake's `waitForSession` should be able to return results with `resumeIssue: undefined` (post-repair), while `getResult` can return the cached pre-repair result with `resumeIssue: 'inline_stop_hook_progress'`.

```typescript
it('does not skip resume for healthy sessions with inline-progress resume issue', async () => {
  // Simulate: getResult returns a cached result with resumeIssue
  sessionRepairService.result = {
    sessionId: VALID_SESSION_ID,
    filePath: `/tmp/${VALID_SESSION_ID}.jsonl`,
    status: 'healthy',
    chainDepth: 5,
    orphanCount: 0,
    fileSize: 500,
    messageCount: 5,
    resumeIssue: 'inline_stop_hook_progress',
  }

  // waitForSession should still be called because the cached result has a resume issue
  // After repair, it returns the clean result
  sessionRepairService.waitForSessionResult = {
    sessionId: VALID_SESSION_ID,
    filePath: `/tmp/${VALID_SESSION_ID}.jsonl`,
    status: 'healthy',
    chainDepth: 5,
    orphanCount: 0,
    fileSize: 500,
    messageCount: 5,
  }

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)

  try {
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    await waitForReady(ws)

    const requestId = 'resume-inline-progress-1'
    const createdPromise = waitForCreated(ws, requestId, 3000)
    ws.send(JSON.stringify({
      type: 'terminal.create',
      requestId,
      mode: 'claude',
      resumeSessionId: VALID_SESSION_ID,
    }))

    const created = await createdPromise

    // Resume should proceed (not be dropped)
    expect(created.effectiveResumeSessionId).toBe(VALID_SESSION_ID)
    // waitForSession should have been called despite cached result
    expect(sessionRepairService.waitForSessionCalls).toContain(VALID_SESSION_ID)
  } finally {
    await closeWebSocket(ws)
  }
})
```

Note: This test verifies the ws-handler + service integration. The ws-handler calls `getResult()` first, sees `status: 'healthy'` (not `missing`), then calls `waitForSession()`. The service's `waitForSession()` must not short-circuit on the cached result because it has a `resumeIssue`. This test validates that the full chain works: ws-handler does not drop the resume (because status is healthy), and `waitForSession` is called (because the service forces re-enqueue).

However, looking at the current ws-handler code at line 1297-1322, the ws-handler only checks `cached?.status === 'missing'` from `getResult()`. If the cached status is `'healthy'`, it falls through to `waitForSession()`. So the ws-handler itself does NOT need modification -- it already calls `waitForSession()` for non-missing results. The change is purely in the service's `waitForSession()` method.

But there is a subtlety: `waitForSession()` currently returns immediately if `queue.getResult(sessionId)` returns a processed result. If that result has a `resumeIssue`, the service must NOT return it immediately. Instead, it must re-enqueue at active priority and wait for the repair.

- [ ] **Step 2: Run the integration test to verify it fails**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/server/ws-terminal-create-session-repair.test.ts
```

Expected: This test should actually pass with the existing code because the integration test uses a `FakeSessionRepairService` -- we need to verify the real service behavior. However, the fake service's `getResult()` returns the cached result with `resumeIssue`, and the ws-handler sees `status: 'healthy'` (not missing), so it calls `waitForSession()`. The fake's `waitForSession()` always returns the `waitForSessionResult` which has no `resumeIssue`. So this test may pass even without changes.

The real behavior we need to test is the service's `waitForSession()` method when it finds a cached/processed result with a `resumeIssue`. This is better tested at the unit level. Let me adjust the approach.

Instead, add a focused unit test for the service. But `SessionRepairService` is hard to unit test in isolation because it depends on glob, fs, and the full cache/queue infrastructure. The integration test proves the end-to-end behavior. The key behavior change is in `waitForSession()`.

The fake already simulates the correct behavior (returns clean result from `waitForSession`), so the integration test proves the ws-handler does not drop the resume. What we really need to test is that the REAL service's `waitForSession()` does not return stale cached results with `resumeIssue`. But this is already handled by the queue changes in Task 3 -- when the queue processes an `active` item and the scan/cached result has a `resumeIssue`, it repairs first.

The service-layer change is: in `waitForSession()`, when a processed result is found via `queue.getResult()` and it has a `resumeIssue`, do NOT return it. Instead, re-enqueue at active priority and wait.

Let me adjust the integration test to specifically validate that `waitForSession` is called (which triggers the active-priority repair path):

```typescript
it('calls waitForSession for healthy cached results with resume issues', async () => {
  // Pre-populate getResult with a resume-issue result
  sessionRepairService.result = {
    sessionId: VALID_SESSION_ID,
    filePath: `/tmp/${VALID_SESSION_ID}.jsonl`,
    status: 'healthy',
    chainDepth: 5,
    orphanCount: 0,
    fileSize: 500,
    messageCount: 5,
    resumeIssue: 'inline_stop_hook_progress',
  }

  sessionRepairService.waitForSessionResult = {
    sessionId: VALID_SESSION_ID,
    filePath: `/tmp/${VALID_SESSION_ID}.jsonl`,
    status: 'healthy',
    chainDepth: 5,
    orphanCount: 0,
    fileSize: 500,
    messageCount: 5,
  }

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)

  try {
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    await waitForReady(ws)

    const requestId = 'resume-inline-progress-1'
    const createdPromise = waitForCreated(ws, requestId, 3000)
    ws.send(JSON.stringify({
      type: 'terminal.create',
      requestId,
      mode: 'claude',
      resumeSessionId: VALID_SESSION_ID,
    }))

    const created = await createdPromise

    expect(created.effectiveResumeSessionId).toBe(VALID_SESSION_ID)
    expect(sessionRepairService.waitForSessionCalls).toContain(VALID_SESSION_ID)
  } finally {
    await closeWebSocket(ws)
  }
})
```

- [ ] **Step 3: Implement the `waitForSession()` bypass for resume issues**

In `server/session-scanner/service.ts`, modify `waitForSession()`:

The first thing `waitForSession()` does is check `queue.getResult(sessionId)`. If the result exists and has a `resumeIssue`, we must NOT return it. Instead, we need to re-enqueue and wait.

Replace the early return at the top of `waitForSession()`:

**Critical:** Before calling `this.queue.waitFor()`, you MUST call `this.queue.clearProcessed(sessionId)` to remove the stale processed entry. Without this, `waitFor()` checks `this.processed` first and returns the stale result immediately, before the re-enqueued item is processed. The sequence must be: `clearProcessed` -> `enqueue` -> `waitFor`.

```typescript
async waitForSession(sessionId: string, timeoutMs = 30000): Promise<SessionScanResult> {
  // Check if already processed
  const existing = this.queue.getResult(sessionId)
  if (existing) {
    // If the processed result has a resume issue, force active-priority repair
    if (existing.resumeIssue) {
      this.queue.clearProcessed(sessionId)
      this.queue.enqueue([{ sessionId, filePath: existing.filePath, priority: 'active' }])
      return this.queue.waitFor(sessionId, timeoutMs)
    }
    await this.ensureSessionArtifacts(existing)
    return existing
  }
  // ... rest of method unchanged ...
```

Also, further down in `waitForSession()`, there is a section that checks `legacyResult` from `queue.getResult(fileSessionId)`. Apply the same check there:

```typescript
const legacyResult = this.queue.getResult(fileSessionId)
if (legacyResult) {
  // If the legacy result has a resume issue, force active-priority repair
  if (legacyResult.resumeIssue) {
    this.queue.clearProcessed(fileSessionId)
    this.queue.enqueue([{ sessionId: fileSessionId, filePath, priority: 'active' }])
    const result = await this.queue.waitFor(fileSessionId, timeoutMs)
    const normalized = result.sessionId === sessionId
      ? result
      : { ...result, sessionId }
    this.queue.seedResult(sessionId, normalized)
    await this.ensureSessionArtifacts(normalized)
    return normalized
  }
  const normalized = legacyResult.sessionId === sessionId
    ? legacyResult
    : { ...legacyResult, sessionId }
  if (fileSessionId !== sessionId) {
    this.queue.seedResult(sessionId, normalized)
  }
  await this.ensureSessionArtifacts(normalized)
  return normalized
}
```

And in the cache check section:

```typescript
// Check cache for recent result
const cached = await this.cache.get(filePath, { allowStaleMs: ACTIVE_CACHE_GRACE_MS })
if (cached) {
  if (cached.status === 'missing') {
    this.sessionPathIndex.delete(sessionId)
  }
  // If cached result has a resume issue, force active-priority repair
  if (cached.resumeIssue) {
    this.queue.clearProcessed(sessionId)
    this.queue.enqueue([{ sessionId, filePath, priority: 'active' }])
    return this.queue.waitFor(sessionId, timeoutMs)
  }
  const normalized = cached.sessionId === sessionId
    ? cached
    : { ...cached, sessionId }
  this.queue.seedResult(sessionId, normalized)
  await this.ensureSessionArtifacts(normalized)
  return normalized
}
```

- [ ] **Step 4: Run the integration test to verify it passes**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/server/ws-terminal-create-session-repair.test.ts
```

Expected: All PASS, including the new resume-issue integration test and all existing tests.

- [ ] **Step 5: Refactor and verify**

Ensure:
- The `resumeIssue` bypass is applied consistently in all code paths through `waitForSession()`
- No infinite re-enqueue loop is possible (the queue's active-priority processing will repair and produce a result without `resumeIssue`, breaking the cycle)
- The `SessionScanResult` type change (adding `resumeIssue`) does not break any other consumers

Run both test suites:

```bash
npm run test:vitest -- --config vitest.config.ts test/unit/server/session-scanner.test.ts test/unit/server/session-queue.test.ts
npm run test:vitest -- --config vitest.server.config.ts test/server/ws-terminal-create-session-repair.test.ts
```

Expected: All PASS.

- [ ] **Step 6: Commit**

```bash
git add \
  server/session-scanner/service.ts \
  test/server/ws-terminal-create-session-repair.test.ts
git commit -m "feat: force active repair path for cached resume issues in service"
```

---

## Verification

- [ ] Run typechecking:

```bash
npm run typecheck
```

Expected: No errors. The type changes (`resumeIssue` on `SessionScanResult`, `resumeIssuesFixed` on `SessionRepairResult`, `options` on `repair()`) are backward-compatible.

- [ ] Run the focused scanner suite:

```bash
npm run test:vitest -- --config vitest.config.ts test/unit/server/session-scanner.test.ts
```

- [ ] Run the focused queue suite:

```bash
npm run test:vitest -- --config vitest.config.ts test/unit/server/session-queue.test.ts
```

- [ ] Run the server integration suite:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/server/ws-terminal-create-session-repair.test.ts
```

- [ ] Check coordinator state, then run the full regression suite:

```bash
npm run test:status
FRESHELL_TEST_SUMMARY="inline progress session repair" npm test
```

---

## Definition of Done

- [ ] Healthy sessions with inline Stop-hook progress on the active chain are classified as `resumeIssue: 'inline_stop_hook_progress'`.
- [ ] Those sessions remain `status: 'healthy'` unless they also contain real corruption.
- [ ] Disk and background scans never rewrite healthy-inline-progress session files.
- [ ] `waitForSession()` does not return a cached inline-progress result directly to `terminal.create`; it forces the active repair path first.
- [ ] The repair rewrites only `stop_hook_summary.parentUuid`, leaves the `progress` record in place, and is idempotent.
- [ ] Orphan repair behavior remains unchanged.
- [ ] Focused unit and server integration suites pass.
- [ ] `npm run typecheck` passes.
- [ ] Coordinated `npm test` passes.
