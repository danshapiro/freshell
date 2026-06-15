# OpenCode Replay Playback Coalescing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore fast OpenCode replay playback by allowing parser-barrier-heavy terminal output to reach xterm in bounded coalesced writes while preserving parser checkpoint ordering and attach completion safety.

**Architecture:** Keep the terminal write-scope gate and xterm acknowledgement sequencing introduced by the recent playback safety work. Change the client batch replay path so parser barriers no longer force hard xterm write boundaries; barrier metadata still controls checkpoint callbacks, but adjacent renderable segments can coalesce through `TerminalWriteQueue`. No server protocol or PTY lifecycle changes are required for this fix.

**Tech Stack:** React 18, TypeScript, xterm.js, Vitest, Testing Library, Freshell WebSocket terminal output protocol.

---

## File Structure

- Modify: `src/components/TerminalView.tsx`
  - Remove the `disableWriteCoalescing` control path from accepted terminal output submission.
  - Keep per-segment parser checkpoint callbacks for `terminal.output.batch` barrier segments.
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`
  - Replace the old expectation that barrier segments produce separate xterm writes.
  - Keep the committed red regression test that reproduces the OpenCode slow replay failure.
  - Verify stripped/no-write barrier cases still hold checkpoints until safe.
- No change: `src/components/terminal/terminal-write-queue.ts`
  - The queue already coalesces adjacent compatible writes and preserves callback order.
- No change: `server/terminal-stream/output-batch.ts`
  - Server batching can be optimized later, but the user-facing regression is caused by client-side hard write boundaries.

## Baseline Evidence

- Temp report: `/tmp/freshell-opencode-playback-investigation-20260615/baseline-slow-playback-data.md`
- Red test commit: `7895df4a test: cover barrier-heavy replay coalescing`
- Current failure:

```text
Expected submitted replay to equal the full 96-segment data payload.
Received only the first 5-byte segment, "\x1b[30m", after one replay flush.
```

## Task 1: Update The Parser-Barrier Write Expectation

**Files:**
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`

- [ ] **Step 1: Replace the old split-write assertion with a coalescing assertion**

Find the test named:

```ts
it('splits terminal.output.batch writes around parser barrier segments', async () => {
```

Replace the test name and final expectation with:

```ts
it('preserves parser barrier checkpoints while allowing terminal.output.batch writes to coalesce', async () => {
  const { terminalId, term } = await renderTerminalHarness({
    status: 'running',
    terminalId: 'term-output-batch-barrier',
  })
  const attachRequestId = latestAttachRequestIdForTerminal(terminalId)
  const streamId = latestStreamIdByTerminal.get(terminalId)

  term.write.mockClear()
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

  expect(terminalWriteStrings(term)).toEqual(['aBc'])
  expect(loadTerminalSurfaceCheckpoint(terminalId, {
    streamId,
    serverInstanceId: 'server-instance',
  })?.parserAppliedSeq).toBe(3)
})
```

- [ ] **Step 2: Run the focused old/new expectation**

Run:

```bash
npm run test:vitest -- test/unit/client/components/TerminalView.lifecycle.test.tsx -t "preserves parser barrier checkpoints" --run
```

Expected before production changes: fail because the terminal still writes `['a', 'B', 'c']`.

- [ ] **Step 3: Commit the test expectation update**

Run:

```bash
git add test/unit/client/components/TerminalView.lifecycle.test.tsx
git commit -m "test: expect parser barriers to coalesce terminal writes"
```

Expected:

```text
[test/opencode-playback-coalescing <sha>] test: expect parser barriers to coalesce terminal writes
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

- [ ] **Step 4: Run the OpenCode regression test**

Run:

```bash
npm run test:vitest -- test/unit/client/components/TerminalView.lifecycle.test.tsx -t "replays barrier-heavy OpenCode batches" --run
```

Expected after production changes:

```text
✓ test/unit/client/components/TerminalView.lifecycle.test.tsx > TerminalView lifecycle > ... > replays barrier-heavy OpenCode batches as bounded writes while holding checkpoints until xterm applies them
```

- [ ] **Step 5: Run the parser-barrier focused test**

Run:

```bash
npm run test:vitest -- test/unit/client/components/TerminalView.lifecycle.test.tsx -t "preserves parser barrier checkpoints" --run
```

Expected after production changes:

```text
✓ test/unit/client/components/TerminalView.lifecycle.test.tsx > TerminalView lifecycle > ... > preserves parser barrier checkpoints while allowing terminal.output.batch writes to coalesce
```

- [ ] **Step 6: Commit the client fix**

Run:

```bash
git add src/components/TerminalView.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx
git commit -m "fix: coalesce parser-barrier terminal replay writes"
```

Expected:

```text
[test/opencode-playback-coalescing <sha>] fix: coalesce parser-barrier terminal replay writes
```

## Task 3: Verify Existing Replay Safety Cases

**Files:**
- Test only: `test/unit/client/components/TerminalView.lifecycle.test.tsx`
- Test only: `src/components/terminal/terminal-write-queue.ts`

- [ ] **Step 1: Run the terminal lifecycle tests around output batching**

Run:

```bash
npm run test:vitest -- test/unit/client/components/TerminalView.lifecycle.test.tsx --run
```

Expected:

```text
Test Files  1 passed
```

The important protected behaviors in this file are:

```text
replays barrier-heavy OpenCode batches as bounded writes while holding checkpoints until xterm applies them
does not checkpoint a stripped terminal.output.batch BEL segment as parser-applied
completes attach when replay ends in a stripped terminal.output.batch BEL segment without checkpointing it
queues stripped terminal.output.batch replay completion behind earlier replay write callbacks
does not checkpoint a mixed renderable and stripped terminal.output.batch segment as parser-applied
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

- [ ] **Step 3: Re-run the synthetic baseline measurement manually from the regression test result**

Use the OpenCode regression test evidence:

```text
Before fix: 96 barrier segments required 96 xterm writes, 96 xterm callbacks, and 96 RAF flushes.
After fix: the same 96 barrier segments should submit the full replay payload in no more than 2 xterm writes before checkpointing.
```

The red test checks the after-fix invariant directly:

```ts
const submittedReplay = delayedCallbacks.map(({ data: chunk }) => chunk).join('')
expect(submittedReplay).toBe(data)
expect(delayedCallbacks.length).toBeLessThanOrEqual(2)
```

- [ ] **Step 4: Commit any verification-only test adjustment**

If no files changed during verification, do not create a commit.

If a test assertion needed a legitimate adjustment, run:

```bash
git add test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/terminal/terminal-write-queue.test.ts
git commit -m "test: verify terminal replay coalescing safety"
```

Expected only when files changed:

```text
[test/opencode-playback-coalescing <sha>] test: verify terminal replay coalescing safety
```

## Task 4: Final Verification And Branch Finish

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
# includes src/components/TerminalView.tsx and test/unit/client/components/TerminalView.lifecycle.test.tsx
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
- Placeholder scan: No unfinished placeholders or unspecified test instructions remain.
- Type consistency: `disableWriteCoalescing` is removed from the `submitAcceptedOutput` input type, from the queue options, and from the batch barrier call site in the same task.
- Safety: No production deploy, production restart, live host mutation, or PR creation is included.
- Test design: The highest-value test is the existing OpenCode-style lifecycle replay regression test. The old split-write test is updated to protect parser checkpoint behavior rather than the harmful write-boundary behavior.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-15-opencode-replay-playback-coalescing.md`. The selected execution path for "the usual" is subagent-driven implementation with review checkpoints, followed by Fresh Eyes review of the resulting delta.
