# OpenCode Replay Playback Coalescing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore fast OpenCode replay playback by allowing parser-barrier-heavy terminal output to reach xterm in bounded coalesced writes while preserving parser checkpoint ordering and attach completion safety.

**Architecture:** Keep the terminal write-scope gate and xterm acknowledgement sequencing introduced by the recent playback safety work. Change the client batch replay path so parser barriers no longer force hard xterm write boundaries; barrier metadata still controls checkpoint callbacks, while adjacent renderable segments coalesce through `TerminalWriteQueue`. Add e2e-only write/callback recording so a browser regression test verifies real `Terminal.write` progression without changing server protocol or production logging.

**Tech Stack:** React 18, TypeScript, xterm.js 6.0.0, Vitest, Testing Library, Playwright, Freshell WebSocket terminal output protocol.

---

## File Structure

- Modify: `src/components/TerminalView.tsx`
  - Remove the `disableWriteCoalescing` control path from accepted terminal output submission.
  - Record e2e-only terminal write submitted/written events through `window.__FRESHELL_TEST_HARNESS__`.
  - Keep per-segment parser checkpoint callbacks for `terminal.output.batch` barrier segments.
- Modify: `src/lib/test-harness.ts`
  - Add e2e-only terminal write event storage and accessors.
- Modify: `test/e2e-browser/helpers/test-harness.ts`
  - Add Playwright helper methods for terminal write events.
- Create: `test/e2e-browser/specs/opencode-replay-write-progression.spec.ts`
  - Mount a real browser `TerminalView`, feed a barrier-heavy replay batch through the test WebSocket path, and assert real xterm writes are bounded.
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`
  - Replace the old expectation that barrier segments produce separate xterm writes.
  - Keep the committed red OpenCode replay regression test.
  - Add a direct `A`, stripped segment, `B` checkpoint-safety regression.
- No change: `src/components/terminal/terminal-write-queue.ts`
  - The queue already coalesces adjacent compatible writes and preserves callback order.
- No change: `server/terminal-stream/output-batch.ts`
  - Server batching can be optimized later, but this fix removes the client-side hard write boundary causing the observed slowdown.

## Baseline And Load-Bearing Evidence

- Temp baseline report: `/tmp/freshell-opencode-playback-investigation-20260615/baseline-slow-playback-data.md`
- Red test commit: `7895df4a test: cover barrier-heavy replay coalescing`
- Current red failure:

```text
Expected submitted replay to equal the full 96-segment data payload.
Received only the first 5-byte segment, "\x1b[30m", after one replay flush.
```

- Load-bearing validation results:

```text
A2 confirmed: installed @xterm/xterm 6.0.0 applies concatenated writes in order and invokes callbacks after parsing.
A3 confirmed: barrier metadata is parser classification, not a protocol-level xterm write boundary.
A4 confirmed: one replay write scope around a coalesced write still suppresses external side effects.
A5/A6 structurally confirmed but missing a direct TerminalView regression for renderable + stripped + renderable coalescing.
A1 inconclusive from existing artifacts: local logs do not prove real OpenCode write progression.
A7 confirmed as a plan gap: focused Vitest + coordinated suite are not enough without browser/xterm write-progression evidence.
```

## Task 1: Update Terminal Lifecycle Regression Coverage

**Files:**
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`

- [ ] **Step 1: Replace the old split-write assertion with a coalescing assertion**

Find the test named:

```ts
it('splits terminal.output.batch writes around parser barrier segments', async () => {
```

Replace the whole test with:

```ts
it('preserves parser barrier checkpoints while allowing terminal.output.batch writes to coalesce', async () => {
  const rafCallbacks: FrameRequestCallback[] = []
  requestAnimationFrameSpy?.mockImplementation((cb: FrameRequestCallback) => {
    rafCallbacks.push(cb)
    return rafCallbacks.length
  })

  const { terminalId, term } = await renderTerminalHarness({
    status: 'running',
    terminalId: 'term-output-batch-barrier',
  })
  const attachRequestId = latestAttachRequestIdForTerminal(terminalId)
  const streamId = latestStreamIdByTerminal.get(terminalId)

  const delayedCallbacks: Array<{ data: string; callback: () => void }> = []
  term.write.mockClear()
  term.write.mockImplementation((chunk: string, onWritten?: () => void) => {
    if (onWritten) delayedCallbacks.push({ data: chunk, callback: onWritten })
  })

  act(() => {
    messageHandler!({
      type: 'terminal.output.batch',
      terminalId,
      streamId,
      attachRequestId,
      source: 'replay',
      seqStart: 1,
      seqEnd: 3,
      data: 'aBc',
      serializedBytes: 256,
      segments: [
        { seqStart: 1, seqEnd: 1, endOffset: 1, rawFrameCount: 1 },
        { seqStart: 2, seqEnd: 2, endOffset: 2, rawFrameCount: 1, barrier: 'control' },
        { seqStart: 3, seqEnd: 3, endOffset: 3, rawFrameCount: 1 },
      ],
    })
  })

  expect(delayedCallbacks).toEqual([])
  expect(loadTerminalSurfaceCheckpoint(terminalId, {
    streamId,
    serverInstanceId: 'server-instance',
  })).toBeNull()

  act(() => {
    rafCallbacks.shift()?.(16)
  })

  expect(delayedCallbacks.map(({ data }) => data)).toEqual(['aBc'])
  expect(loadTerminalSurfaceCheckpoint(terminalId, {
    streamId,
    serverInstanceId: 'server-instance',
  })).toBeNull()

  act(() => {
    delayedCallbacks[0]?.callback()
  })

  expect(loadTerminalSurfaceCheckpoint(terminalId, {
    streamId,
    serverInstanceId: 'server-instance',
  })?.parserAppliedSeq).toBe(3)
})
```

- [ ] **Step 2: Add the stripped-middle checkpoint regression**

Add this test immediately after the parser barrier coalescing test:

```ts
it('does not checkpoint across a stripped middle batch segment when adjacent renderable segments coalesce', async () => {
  const rafCallbacks: FrameRequestCallback[] = []
  requestAnimationFrameSpy?.mockImplementation((cb: FrameRequestCallback) => {
    rafCallbacks.push(cb)
    return rafCallbacks.length
  })

  const { terminalId, term } = await renderTerminalHarness({
    status: 'running',
    terminalId: 'term-output-batch-stripped-middle-coalesced',
    mode: 'opencode',
    serverInstanceId: 'server-output-batch-stripped-middle-coalesced',
  })
  const attachRequestId = latestAttachRequestIdForTerminal(terminalId)
  const streamId = latestStreamIdByTerminal.get(terminalId)
  expect(attachRequestId).toBeTruthy()
  expect(streamId).toBeTruthy()

  const delayedCallbacks: Array<{ data: string; callback: () => void }> = []
  term.write.mockClear()
  term.write.mockImplementation((chunk: string, onWritten?: () => void) => {
    if (onWritten) delayedCallbacks.push({ data: chunk, callback: onWritten })
  })

  act(() => {
    messageHandler!({
      type: 'terminal.output.batch',
      terminalId,
      streamId,
      attachRequestId,
      source: 'replay',
      seqStart: 1,
      seqEnd: 3,
      data: 'A\x07B',
      serializedBytes: 256,
      segments: [
        { seqStart: 1, seqEnd: 1, endOffset: 1, rawFrameCount: 1 },
        { seqStart: 2, seqEnd: 2, endOffset: 2, rawFrameCount: 1, barrier: 'turn_complete' },
        { seqStart: 3, seqEnd: 3, endOffset: 3, rawFrameCount: 1 },
      ],
    })
  })

  expect(delayedCallbacks).toEqual([])
  expect(loadTerminalSurfaceCheckpoint(terminalId, {
    streamId,
    serverInstanceId: 'server-output-batch-stripped-middle-coalesced',
  })).toBeNull()

  act(() => {
    rafCallbacks.shift()?.(16)
  })

  expect(delayedCallbacks.map(({ data }) => data)).toEqual(['AB'])
  expect(loadTerminalSurfaceCheckpoint(terminalId, {
    streamId,
    serverInstanceId: 'server-output-batch-stripped-middle-coalesced',
  })).toBeNull()

  act(() => {
    delayedCallbacks[0]?.callback()
  })

  expect(loadTerminalSurfaceCheckpoint(terminalId, {
    streamId,
    serverInstanceId: 'server-output-batch-stripped-middle-coalesced',
  })?.parserAppliedSeq).toBe(1)

  wsMocks.send.mockClear()
  act(() => {
    reconnectHandler?.()
  })

  expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
    type: 'terminal.attach',
    terminalId,
    sinceSeq: 1,
  }))
})
```

- [ ] **Step 3: Run both focused red tests**

Run:

```bash
npm run test:vitest -- test/unit/client/components/TerminalView.lifecycle.test.tsx -t "preserves parser barrier checkpoints|stripped middle batch segment|replays barrier-heavy OpenCode batches" --run
```

Expected before production changes:

```text
FAIL replays barrier-heavy OpenCode batches as bounded writes while holding checkpoints until xterm applies them
FAIL preserves parser barrier checkpoints while allowing terminal.output.batch writes to coalesce
FAIL does not checkpoint across a stripped middle batch segment when adjacent renderable segments coalesce
```

- [ ] **Step 4: Commit the lifecycle test update**

Run:

```bash
git add test/unit/client/components/TerminalView.lifecycle.test.tsx
git commit -m "test: expect parser barrier replay writes to coalesce"
```

Expected:

```text
[test/opencode-playback-coalescing <sha>] test: expect parser barrier replay writes to coalesce
```

## Task 2: Let Parser-Barrier Segments Use Normal Write Coalescing

**Files:**
- Modify: `src/components/TerminalView.tsx`

- [ ] **Step 1: Remove the accepted-output flag that turns parser barriers into hard xterm write barriers**

In `submitAcceptedOutput`, replace this input type:

```ts
const submitAcceptedOutput = (input: {
  raw: string
  seqStart: number
  seqEnd: number
  attachRequestId?: string
  mode: TerminalPaneContent['mode']
  previousSeqState: AttachSeqState
  outputSource: TerminalOutputSource
  parserAppliedSeq: number
  completedAttach: boolean
  disableWriteCoalescing?: boolean
}) => {
```

with:

```ts
const submitAcceptedOutput = (input: {
  raw: string
  seqStart: number
  seqEnd: number
  attachRequestId?: string
  mode: TerminalPaneContent['mode']
  previousSeqState: AttachSeqState
  outputSource: TerminalOutputSource
  parserAppliedSeq: number
  completedAttach: boolean
}) => {
```

- [ ] **Step 2: Remove the special coalescing override from `handleTerminalOutput`**

Replace this queue option block:

```ts
{
  mode: input.outputSource,
  generation: input.attachRequestId,
  coalesce: input.disableWriteCoalescing ? false : undefined,
},
```

with:

```ts
{
  mode: input.outputSource,
  generation: input.attachRequestId,
},
```

- [ ] **Step 3: Stop passing `disableWriteCoalescing` for batch barrier segments**

Replace the barrier segment submission block:

```ts
submitAcceptedOutput({
  raw: segment.data,
  seqStart: segment.seqStart,
  seqEnd: segment.seqEnd,
  attachRequestId: msg.attachRequestId,
  mode,
  previousSeqState: acceptedSegment.previousState,
  outputSource,
  parserAppliedSeq: acceptedSegment.parserAppliedSeq,
  completedAttach: completedAttachOnBatch && index === batchSegments.length - 1,
  disableWriteCoalescing: true,
})
```

with:

```ts
submitAcceptedOutput({
  raw: segment.data,
  seqStart: segment.seqStart,
  seqEnd: segment.seqEnd,
  attachRequestId: msg.attachRequestId,
  mode,
  previousSeqState: acceptedSegment.previousState,
  outputSource,
  parserAppliedSeq: acceptedSegment.parserAppliedSeq,
  completedAttach: completedAttachOnBatch && index === batchSegments.length - 1,
})
```

- [ ] **Step 4: Run the focused lifecycle tests**

Run:

```bash
npm run test:vitest -- test/unit/client/components/TerminalView.lifecycle.test.tsx -t "preserves parser barrier checkpoints|stripped middle batch segment|replays barrier-heavy OpenCode batches" --run
```

Expected after production changes:

```text
Test Files  1 passed
```

- [ ] **Step 5: Commit the client coalescing fix**

Run:

```bash
git add src/components/TerminalView.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx
git commit -m "fix: coalesce parser-barrier terminal replay writes"
```

Expected:

```text
[test/opencode-playback-coalescing <sha>] fix: coalesce parser-barrier terminal replay writes
```

## Task 3: Add Browser Write-Progression Coverage

**Files:**
- Modify: `src/lib/test-harness.ts`
- Modify: `src/components/TerminalView.tsx`
- Modify: `test/e2e-browser/helpers/test-harness.ts`
- Create: `test/e2e-browser/specs/opencode-replay-write-progression.spec.ts`

- [ ] **Step 1: Extend the e2e harness type and storage**

In `src/lib/test-harness.ts`, add this exported type after the imports:

```ts
export type TerminalWriteEvent = {
  terminalId?: string
  paneId?: string
  phase: 'submitted' | 'written'
  chars: number
  data: string
  at: number
}
```

Add these optional methods to `FreshellTestHarness`:

```ts
  recordTerminalWrite?: (event: TerminalWriteEvent) => void
  getTerminalWriteEvents?: () => TerminalWriteEvent[]
  clearTerminalWriteEvents?: () => void
```

Inside `installTestHarness`, add storage next to `sentWsMessages`:

```ts
  const terminalWriteEvents: TerminalWriteEvent[] = []
```

Add these methods to the `window.__FRESHELL_TEST_HARNESS__` object:

```ts
    recordTerminalWrite: (event: TerminalWriteEvent) => {
      terminalWriteEvents.push({ ...event })
      if (terminalWriteEvents.length > 1000) terminalWriteEvents.shift()
    },
    getTerminalWriteEvents: () => [...terminalWriteEvents],
    clearTerminalWriteEvents: () => {
      terminalWriteEvents.length = 0
    },
```

- [ ] **Step 2: Record actual xterm writes in `TerminalView`**

In the `createTerminalWriteQueue` call in `src/components/TerminalView.tsx`, replace:

```ts
      write: (data, onWritten) => {
        try {
          term.write(data, onWritten)
        } catch {
          // disposed
          onWritten?.()
        }
      },
```

with:

```ts
      write: (data, onWritten) => {
        const recordForTest = (phase: 'submitted' | 'written') => {
          window.__FRESHELL_TEST_HARNESS__?.recordTerminalWrite?.({
            terminalId: terminalIdRef.current,
            paneId,
            phase,
            chars: data.length,
            data,
            at: performance.now(),
          })
        }
        const completeWrite = () => {
          recordForTest('written')
          onWritten?.()
        }
        recordForTest('submitted')
        try {
          term.write(data, completeWrite)
        } catch {
          // disposed
          completeWrite()
        }
      },
```

- [ ] **Step 3: Add Playwright helper methods**

In `test/e2e-browser/helpers/test-harness.ts`, import the event type:

```ts
import type { TerminalWriteEvent } from '@/lib/test-harness'
```

Add these methods to `TestHarness`:

```ts
  async getTerminalWriteEvents(): Promise<TerminalWriteEvent[]> {
    return this.page.evaluate(() => {
      const harness = window.__FRESHELL_TEST_HARNESS__
      if (!harness) throw new Error('Test harness not installed')
      return harness.getTerminalWriteEvents?.() ?? []
    })
  }

  async clearTerminalWriteEvents(): Promise<void> {
    await this.page.evaluate(() => {
      const harness = window.__FRESHELL_TEST_HARNESS__
      if (!harness) throw new Error('Test harness not installed')
      harness.clearTerminalWriteEvents?.()
    })
  }
```

- [ ] **Step 4: Create the browser replay write-progression spec**

Create `test/e2e-browser/specs/opencode-replay-write-progression.spec.ts`:

```ts
import { expect, test } from '../helpers/fixtures.js'

type TerminalSnapshot = {
  terminalId: string
  streamId: string
  attachRequestId: string
}

function createOpenCodeLikeReplay(seqBase: number) {
  const chunks = Array.from({ length: 96 }, (_unused, index) => (
    index % 2 === 0
      ? `\x1b[${30 + (index % 8)}m`
      : `tok${index.toString().padStart(2, '0')}`
  ))
  const data = chunks.join('')
  const segments = chunks.map((chunk, index) => ({
    seqStart: seqBase + index,
    seqEnd: seqBase + index,
    endOffset: chunks.slice(0, index + 1).join('').length,
    rawFrameCount: 1,
    barrier: 'control',
  }))
  return { chunks, data, segments }
}

test.describe('OpenCode replay write progression', () => {
  test('submits barrier-heavy replay to real xterm in bounded writes', async ({ freshellPage, harness, terminal }) => {
    const page = freshellPage
    await terminal.waitForPrompt({ timeout: 30_000 })

    const snapshot = await page.waitForFunction((): TerminalSnapshot | null => {
      const harness = window.__FRESHELL_TEST_HARNESS__
      const state = harness?.getState()
      const activeTabId = state?.tabs?.activeTabId
      const findTerminal = (node: any): any => {
        if (!node) return undefined
        if (node.type === 'leaf' && node.content?.kind === 'terminal') return node.content
        if (node.type === 'split') return findTerminal(node.children?.[0]) ?? findTerminal(node.children?.[1])
        return undefined
      }
      const content = findTerminal(state?.panes?.layouts?.[activeTabId])
      if (
        typeof content?.terminalId !== 'string'
        || typeof content?.streamId !== 'string'
      ) {
        return null
      }
      const sent = harness?.getSentWsMessages?.() ?? []
      const attach = [...sent].reverse().find((msg: any) =>
        msg?.type === 'terminal.attach'
        && msg.terminalId === content.terminalId
        && typeof msg.attachRequestId === 'string'
      )
      if (!attach) return null
      return {
        terminalId: content.terminalId,
        streamId: content.streamId,
        attachRequestId: attach.attachRequestId,
      }
    }, { timeout: 30_000 })
      .then((handle) => handle.jsonValue() as Promise<TerminalSnapshot>)

    const seqBase = 100_000
    const replay = createOpenCodeLikeReplay(seqBase)
    await harness.clearTerminalWriteEvents()

    await harness.receiveWsMessage({
      type: 'terminal.output.batch',
      terminalId: snapshot.terminalId,
      streamId: snapshot.streamId,
      attachRequestId: snapshot.attachRequestId,
      source: 'replay',
      seqStart: seqBase,
      seqEnd: seqBase + replay.chunks.length - 1,
      data: replay.data,
      serializedBytes: replay.data.length + 512,
      segments: replay.segments,
    })

    await expect.poll(async () => {
      const submitted = (await harness.getTerminalWriteEvents())
        .filter((event) => event.phase === 'submitted' && event.terminalId === snapshot.terminalId)
      return submitted.map((event) => event.data).join('')
    }, { timeout: 15_000 }).toBe(replay.data)

    const submitted = (await harness.getTerminalWriteEvents())
      .filter((event) => event.phase === 'submitted' && event.terminalId === snapshot.terminalId)
    expect(submitted.length).toBeLessThanOrEqual(2)

    await expect.poll(async () => {
      const written = (await harness.getTerminalWriteEvents())
        .filter((event) => event.phase === 'written' && event.terminalId === snapshot.terminalId)
      return written.map((event) => event.data).join('')
    }, { timeout: 15_000 }).toBe(replay.data)
  })
})
```

- [ ] **Step 5: Run the new e2e probe**

Run:

```bash
npm run test:e2e:chromium -- test/e2e-browser/specs/opencode-replay-write-progression.spec.ts --workers=1
```

Expected after the client fix:

```text
1 passed
```

- [ ] **Step 6: Commit the browser write-progression coverage**

Run:

```bash
git add src/lib/test-harness.ts src/components/TerminalView.tsx test/e2e-browser/helpers/test-harness.ts test/e2e-browser/specs/opencode-replay-write-progression.spec.ts
git commit -m "test: cover OpenCode replay write progression in browser"
```

Expected:

```text
[test/opencode-playback-coalescing <sha>] test: cover OpenCode replay write progression in browser
```

## Task 4: Verify Existing Replay Safety Cases

**Files:**
- Test only: `test/unit/client/components/TerminalView.lifecycle.test.tsx`
- Test only: `src/components/terminal/terminal-write-queue.ts`

- [ ] **Step 1: Run the terminal lifecycle suite**

Run:

```bash
npm run test:vitest -- test/unit/client/components/TerminalView.lifecycle.test.tsx --run
```

Expected:

```text
Test Files  1 passed
```

- [ ] **Step 2: Run the write queue tests**

Run:

```bash
npm run test:vitest -- test/unit/client/components/terminal/terminal-write-queue.test.ts --run
```

Expected:

```text
Test Files  1 passed
```

- [ ] **Step 3: Run the attach sequence state tests**

Run:

```bash
npm run test:vitest -- test/unit/client/lib/terminal-attach-seq-state.test.ts --run
```

Expected:

```text
Test Files  1 passed
```

- [ ] **Step 4: Run the browser write-progression e2e again**

Run:

```bash
npm run test:e2e:chromium -- test/e2e-browser/specs/opencode-replay-write-progression.spec.ts --workers=1
```

Expected:

```text
1 passed
```

- [ ] **Step 5: Commit any legitimate verification-only adjustment**

If no files changed during verification, do not create a commit.

If an assertion needed a legitimate adjustment, run:

```bash
git add test/unit/client/components/TerminalView.lifecycle.test.tsx test/e2e-browser/specs/opencode-replay-write-progression.spec.ts
git commit -m "test: verify terminal replay coalescing safety"
```

Expected only when files changed:

```text
[test/opencode-playback-coalescing <sha>] test: verify terminal replay coalescing safety
```

## Task 5: Final Verification And Branch Finish

**Files:**
- No source edits expected.

- [ ] **Step 1: Check the branch diff**

Run:

```bash
git status --short
git diff --stat origin/main...HEAD
git log --oneline origin/main..HEAD
```

Expected:

```text
git status --short
# no output

git diff --stat origin/main...HEAD
# includes TerminalView, test harness, lifecycle tests, and the e2e spec
```

- [ ] **Step 2: Run the repo-supported status check before any broad suite**

Run:

```bash
npm run test:status
```

Expected:

```text
No active broad test holder, or a reusable recent passing baseline is reported.
```

If another agent holds the coordinator, wait rather than killing it.

- [ ] **Step 3: Run coordinated verification**

Run:

```bash
FRESHELL_TEST_SUMMARY="OpenCode replay coalescing verification" npm run check
```

Expected:

```text
typecheck passes
coordinated test suite passes
```

- [ ] **Step 4: Do not create a PR without explicit user approval**

Stop with the branch committed locally and report:

```text
Branch test/opencode-playback-coalescing is committed and verified.
No PR was created because repo instructions require explicit approval.
```

## Self-Review Checklist

- Spec coverage: The plan targets the slow playback regression only. It leaves the tab-switch reload issue out of scope because the user narrowed the request to slow playback.
- Load-bearing coverage: The plan now includes direct coverage for the two validation gaps: stripped middle segment checkpointing and real browser/xterm write progression.
- Placeholder scan: No unfinished placeholders or unspecified test instructions remain.
- Type consistency: `disableWriteCoalescing` is removed from the `submitAcceptedOutput` input type, queue options, and batch barrier call site in the same task.
- Safety: No production deploy, production restart, live host mutation, or PR creation is included. Playwright starts an isolated test server through existing test helpers.
- Test design: Unit tests protect client ordering and checkpoint contracts; the browser e2e test protects the real `Terminal.write` progression that caused visible slow playback.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-15-opencode-replay-playback-coalescing.md`. The selected execution path for "the usual" is subagent-driven implementation with review checkpoints, followed by Fresh Eyes review of the resulting delta.
