# Terminal Replay Credit Repair Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Repair Freshell's terminal replay deadlock so the Codex pane finishes rendering and responds to scrolling and typing, including after tab switching, reconnecting, and refreshing the browser; use the-usual workflow and land the reviewed fix on main.

### Explicit constraints
- Work in a dedicated worktree under the repository's .worktrees directory, based on origin/main; preserve unrelated work and keep commits focused.
- Bypass the green-base prerequisite and record the observed pre-existing failures while completing the replay repair.
- Use red/green/refactor TDD and meaningful integration and browser coverage; use the configured test backends without an unapproved local fallback.
- Land the fix on main through a PR after repair and review; PR creation and merging are authorized.
- Do not deploy or mutate the live service without explicit authorization; restarting the self-hosted server on port 3001 requires the user's word APPROVED.
- Use OneCLI for any secret retrieval, and avoid interfering with other agents or their processes.

### Accepted tradeoffs and residuals
- The clean origin/main baseline has three pre-existing failures: OpenCode free-tier readiness, required systemd service visibility through Docker ignore rules, and a stale runtime manifest entry. They may remain recorded outside this replay repair.

**Goal:** A restored Codex terminal finishes its replay, renders the continuation of an escape sequence across a page boundary, and remains usable through tab changes, connection recovery, and browser refresh.

**Architecture:** A successful, ordered xterm write acknowledges transport consumption of the entire accepted sequence range, including bytes retained by preprocessing; this acknowledgement is distinct from the strict applied checkpoint. An ordered queue task acknowledges a range with no xterm write, while pending rendering bytes and mixed rendering invalidate delta eligibility until a real surface rebuild. Failed, abandoned, or stale writes never acknowledge consumption, save coverage, or complete a later attach generation.

**Tech Stack:** React 18, TypeScript, xterm 6, the existing serial terminal write queue, Vitest component integration tests, Playwright Chromium, and the Rust/Axum paced replay implementation.

## Global Constraints

- Implement in `/home/dan/code/freshell/.worktrees/terminal-replay-credit`, branch `the-usual/terminal-replay-credit`, created from `origin/main` at `58b65677ff2c70a42525413bd76daa67de13644f`. The user has explicitly bypassed the green-base prerequisite for this repair.
- Respect `AGENTS.md`, especially worktree ownership, process ownership, test coordination, and the PR branch model. The user has authorized PR creation and merging for this change. The coordinator owns the external run record and workflow transitions.
- pnpm is exactly `10.34.5`; Node is at least `22.5`; Rust meets the workspace `1.96` requirement. Keep frozen installs and the existing lockfile. No dependencies or server protocol changes are needed. Relative TypeScript imports include `.js`.
- `FRESHELL_VITEST_BACKEND=cloud` and `FRESHELL_E2E_BACKEND=cloud` are already configured. Use `GCLOUD_ROBOT_REQUIRE=1` on cloud gates. Focused `test:vitest` delegates locally regardless of this setting; use `test:cloud --config=default` instead. Rust and source-runtime lanes remain local as designed, as does Electron; this is not a fallback from cloud.
- Keep the existing serial/coalesced write order, generation checks, scoped side effects, stale completed-write mutation ledger, negotiated/legacy compatibility, and strict applied/checkpoint distinction. Do not bypass Rust's page-end credit requirement or issue credits from a test harness.
- Use a public synthetic escape fragment, never the captured private transcript. The diagnosis is already proven: preprocessing held an incomplete SGR suffix, wrote a visible prefix, and suppressed the only completion callback needed to credit the page.
- Do not use live user panes or production port `3001`. Browser tests own isolated `RustServer` instances, random ports, temporary homes, and their processes. Follow the existing test fixtures' cleanup; do not use broad process kills. Do not restart or deploy the source service.
- No new UI feature, end-user documentation, mock redesign, migration, or secret is required. Keep the existing recovering state and recovery behavior. Use the existing structured logger for failures; never log terminal output bytes or tokens.
- Record the three accepted baseline failures and evidence under `.worktrees/.the-usual-logs/terminal-replay-credit/reports/`. Do not fix or weaken their tests in this repair. Their exact titles are listed under Step 6.

---

## File Responsibilities

| File | Responsibility |
| --- | --- |
| `src/components/TerminalView.tsx` | Separate successful ordered consumption from strict application; classify pending preprocessing; make no-write acknowledgement ordered; prevent unsafe checkpoint reuse and credit after failure. |
| `src/components/terminal/terminal-write-queue.ts` | Settle a thrown surface write without firing success callbacks, retain balanced scopes/counters, report failure, and continue scheduling serial work. |
| `test/unit/client/components/TerminalView.lifecycle.test.tsx` | Exercise the real component adapter with single/batched output, held callbacks, filtering, pending controls, failure, supersession, and reconnect. |
| `test/unit/client/components/terminal/terminal-write-queue.test.ts` | Prove failure settlement releases scope/counters without successful acknowledgement and subsequent queue scheduling still works. |
| `test/e2e-browser/specs/terminal-replay-credit-rust.spec.ts` | Prove real browser credits release real Rust replay pages and scrolling/keyboard input work through reload, reconnect, and tab switching. |
| This plan | Agent implementation intent and pre-implementation code drafts; source becomes authoritative once execution starts. |

These responsibilities form one independently reviewable repair. Existing parser and pure paced-consumption modules already have the needed behavior; do not change their public interfaces unless implementation evidence requires it.

### Task 1: Restore terminal replay progress without unsafe acknowledgements

**Files:**
- Modify: `src/components/TerminalView.tsx:409` (submission result), `:1246` (delta decision), `:1263` (surface reset), `:1377` (paced completion), `:1524` (checkpoint persistence), `:2421` (output submission), `:2765` (queue adapter), `:4544` (ordered completion), `:4635` (accepted output).
- Modify: `src/components/terminal/terminal-write-queue.ts:34` (failure interface), `:161` (write settlement).
- Test: `test/unit/client/components/TerminalView.lifecycle.test.tsx:13714`.
- Test: `test/unit/client/components/terminal/terminal-write-queue.test.ts`.
- Create: `test/e2e-browser/specs/terminal-replay-credit-rust.spec.ts`.

**Interfaces:**
- Consumes: `enqueue(data: string, onWritten?: () => void, options?: TerminalWriteQueueOptions): void`, `enqueueTask(task: () => void, options?: TerminalWriteQueueOptions): void`, `setActiveGeneration(generation: string, options?: { dropQueuedStaleWrites?: boolean }): void`, and `hasInFlightWrites(generation?: string): boolean`.
- Consumes: `pacedReplayConsumeThrough(state, seqEnd)`, `pacedReplayNextCredit(state)`, and the existing received/attach target ceilings; their APIs and wire fields remain unchanged.
- Produces: `TerminalWriteQueueArgs.onWriteFailed?: (item: { mode: TerminalWriteQueueMode; generation: string | undefined; error: unknown }) => void`; it runs only for a thrown `clearBeforeWrite`/write before successful completion and never substitutes for a success callback.
- Produces: `TerminalOutputSubmission` retains `submittedWrite`, `submittedBytesEqualInput`, and `preParserConsumedAllBytes` (meaning only `cleaned === ''`, not proof of checkpoint safety), and adds `preprocessingPending: boolean`.
- Produces: `handleTerminalOutput(raw: string, mode: TerminalPaneContent['mode'], tid: string | undefined, allowReplies: boolean, onWritten?: (submittedBytesEqualInput: boolean) => void, writeOptions?: TerminalWriteQueueOptions): TerminalOutputSubmission`; every successful nonempty write invokes this callback with its fidelity result.
- Produces: one surface-scoped `surfaceCheckpointUnsafeRef: MutableRefObject<boolean>` and one attach-scoped `failedConsumptionAttachRef: MutableRefObject<string | undefined>`. Only a true baseline-zero surface reset clears the former; an attach generation change replaces the latter. These refs protect distinct facts rather than representing new persisted cursors.

- [ ] **Step 1: Write the failing behavioral tests**

Add a nested `describe('replay credit regression', ...)` inside the existing paced describe in `TerminalView.lifecycle.test.tsx`, reusing `setupPacedPane`, `captureRaf`, `creditMessages`, `attachMessagesFor`, `latestAttachRequestIdForTerminal`, `latestStreamIdByTerminal`, `__readTerminalSurfaceCheckpointForTests`, and the existing `reconnectHandler`. All are already defined/imported in that test file. Use this complete primary regression and envelope helper:

```tsx
const INCOMPLETE_SGR = '\x1b[38;5;2;48;2;33;58'
const CONTINUATION = ';255mAFTER\r\n'
const PREFIX = 'BEFORE\r\n'
const ENVELOPES = ['single', 'batch', 'barrier-batch'] as const

function deliverOutput(
  envelope: typeof ENVELOPES[number],
  terminalId: string,
  seq: number,
  data: string,
) {
  if (envelope === 'single') {
    messageHandler!({ type: 'terminal.output', terminalId, seqStart: seq, seqEnd: seq, data })
    return
  }
  messageHandler!({
    type: 'terminal.output.batch', terminalId, source: 'replay',
    seqStart: seq, seqEnd: seq, serializedBytes: data.length + 256,
    data,
    segments: [{
      seqStart: seq, seqEnd: seq, endOffset: data.length, rawFrameCount: 1,
      ...(envelope === 'barrier-batch' ? { barrier: 'control' } : {}),
    }],
  })
}

function readPacedCheckpoint(terminalId: string, paneId: string) {
  return __readTerminalSurfaceCheckpointForTests(terminalId, {
    streamId: latestStreamIdByTerminal.get(terminalId),
    serverInstanceId: 'srv-paced',
  }, { paneId })
}

it.each(ENVELOPES)('credits a page-ending incomplete SGR after the real %s write completes', async (envelope) => {
  const { terminalId, paneId, term } = await setupPacedPane({ suffix: `sgr-${envelope}`, mode: 'codex' })
  const pumpRaf = captureRaf()
  const held: Array<() => void> = []
  term.write.mockImplementation((_data: string, callback?: () => void) => {
    if (callback) held.push(callback)
  })
  act(() => {
    messageHandler!({ type: 'terminal.attach.ready', terminalId,
      headSeq: 2, replayFromSeq: 1, replayToSeq: 2 })
    deliverOutput(envelope, terminalId, 1, PREFIX + INCOMPLETE_SGR)
    pumpRaf()
  })
  expect(term.write.mock.calls.map(([data]: [string]) => data)).toEqual([PREFIX])
  expect(creditMessages()).toEqual([])
  expect(held).toHaveLength(1)
  act(() => { held.shift()!(); pumpRaf() })
  expect(creditMessages()).toEqual([expect.objectContaining({
    terminalId, attachRequestId: latestAttachRequestIdForTerminal(terminalId), consumedSeq: 1,
  })])
  // The server-shaped continuation is supplied only after the real credit.
  // The browser/Rust spec below supplies this through the actual server.
  act(() => { deliverOutput(envelope, terminalId, 2, CONTINUATION); pumpRaf() })
  expect(term.write.mock.calls.map(([data]: [string]) => data)).toEqual([
    PREFIX, INCOMPLETE_SGR + CONTINUATION,
  ])
  expect(creditMessages().at(-1)).toMatchObject({ consumedSeq: 1 })
  act(() => { held.shift()!(); pumpRaf() })
  expect(creditMessages().at(-1)).toMatchObject({ consumedSeq: 2 })
  expect(readPacedCheckpoint(terminalId, paneId)).toBeNull()
})

it.each([
  { label: 'OSC52', data: PREFIX + OSC52_ONLY_FRAME, rendered: PREFIX },
  { label: 'Codex BEL', data: PREFIX + '\x07', rendered: PREFIX },
])('credits a mixed $label frame without claiming strict applied progress', async ({ label, data, rendered }) => {
  const { terminalId, paneId, term } = await setupPacedPane({ suffix: `mixed-${label}`, mode: 'codex' })
  const pumpRaf = captureRaf()
  const held: Array<() => void> = []
  term.write.mockImplementation((_data: string, callback?: () => void) => { if (callback) held.push(callback) })
  act(() => {
    messageHandler!({ type: 'terminal.attach.ready', terminalId, headSeq: 1, replayFromSeq: 1, replayToSeq: 1 })
    deliverOutput('single', terminalId, 1, data)
    pumpRaf()
  })
  expect(term.write.mock.calls.map(([value]: [string]) => value)).toEqual([rendered])
  expect(creditMessages()).toEqual([])
  act(() => { held.shift()!(); pumpRaf() })
  expect(creditMessages().at(-1)).toMatchObject({ consumedSeq: 1 })
  expect(readPacedCheckpoint(terminalId, paneId)).toBeNull()
})

it('orders a fully filtered acknowledgement behind a held visible write', async () => {
  const { terminalId, paneId, term } = await setupPacedPane({ suffix: 'ordered-filter' })
  const pumpRaf = captureRaf()
  let held: (() => void) | undefined
  term.write.mockImplementation((_data: string, callback?: () => void) => { held = callback })
  act(() => {
    messageHandler!({ type: 'terminal.attach.ready', terminalId, headSeq: 2, replayFromSeq: 1, replayToSeq: 2 })
    deliverOutput('single', terminalId, 1, PREFIX)
    deliverOutput('single', terminalId, 2, OSC52_ONLY_FRAME)
    pumpRaf()
  })
  expect(creditMessages()).toEqual([])
  expect(readPacedCheckpoint(terminalId, paneId)).toBeNull()
  expect(term.write).toHaveBeenCalledTimes(1)
  act(() => { held!(); pumpRaf() })
  expect(creditMessages()).toEqual([expect.objectContaining({ consumedSeq: 2 })])
  expect(readPacedCheckpoint(terminalId, paneId)).toMatchObject({ parserAppliedSeq: 1, surfaceCoverageSeq: 2 })
})

it('a buffered-only CSI can credit but cannot save reconstructable coverage', async () => {
  const { terminalId, paneId, term } = await setupPacedPane({ suffix: 'buffer-only', mode: 'codex' })
  const pumpRaf = captureRaf()
  act(() => {
    messageHandler!({ type: 'terminal.attach.ready', terminalId, headSeq: 2, replayFromSeq: 1, replayToSeq: 2 })
    deliverOutput('single', terminalId, 1, INCOMPLETE_SGR)
  })
  expect(creditMessages()).toEqual([])
  expect(term.write).not.toHaveBeenCalled()
  act(() => pumpRaf())
  expect(creditMessages().at(-1)).toMatchObject({ consumedSeq: 1 })
  expect(readPacedCheckpoint(terminalId, paneId)).toBeNull()
  act(() => { deliverOutput('single', terminalId, 2, CONTINUATION); pumpRaf() })
  expect(term.write.mock.calls.map(([data]: [string]) => data)).toEqual([INCOMPLETE_SGR + CONTINUATION])
  expect(creditMessages().at(-1)).toMatchObject({ consumedSeq: 2 })
})

it('invalidates a prior checkpoint after a mixed rendered prefix before reconnect', async () => {
  const { terminalId, paneId } = await setupPacedPane({ suffix: 'old-checkpoint', mode: 'codex' })
  const pumpRaf = captureRaf()
  act(() => {
    messageHandler!({ type: 'terminal.attach.ready', terminalId, headSeq: 3, replayFromSeq: 1, replayToSeq: 3 })
    deliverOutput('single', terminalId, 1, 'BASE\r\n')
    pumpRaf()
  })
  expect(readPacedCheckpoint(terminalId, paneId)).toMatchObject({ parserAppliedSeq: 1, surfaceCoverageSeq: 1 })
  act(() => { deliverOutput('single', terminalId, 2, PREFIX + INCOMPLETE_SGR); pumpRaf() })
  expect(creditMessages().at(-1)).toMatchObject({ consumedSeq: 2 })
  act(() => reconnectHandler?.())
  await waitFor(() => expect(attachMessagesFor(terminalId).at(-1)).toMatchObject({ sinceSeq: 0, intent: 'viewport_hydrate' }))
})

it('the actual xterm adapter never acknowledges a thrown write or a later filtered range', async () => {
  const { store, tabId, terminalId, paneId, term } = await setupPacedPane({ suffix: 'throw-mixed', mode: 'codex' })
  const pumpRaf = captureRaf()
  term.write.mockImplementation(() => { throw new Error('synthetic disposed surface') })
  act(() => {
    messageHandler!({ type: 'terminal.attach.ready', terminalId, headSeq: 3, replayFromSeq: 1, replayToSeq: 3 })
    deliverOutput('single', terminalId, 1, PREFIX + INCOMPLETE_SGR)
    deliverOutput('single', terminalId, 2, ';255m')
    deliverOutput('single', terminalId, 3, OSC52_ONLY_FRAME)
    pumpRaf()
  })
  expect(term.write).toHaveBeenCalled()
  expect(creditMessages()).toEqual([])
  expect(readPacedCheckpoint(terminalId, paneId)).toBeNull()
  term.write.mockImplementation((_data: string, callback?: () => void) => callback?.())
  const failedAttach = latestAttachRequestIdForTerminal(terminalId)
  act(() => store.dispatch(requestPaneRefresh({ tabId, paneId })))
  await waitFor(() => expect(latestAttachRequestIdForTerminal(terminalId)).not.toBe(failedAttach))
  act(() => {
    messageHandler!({ type: 'terminal.attach.ready', terminalId, headSeq: 1, replayFromSeq: 1, replayToSeq: 1 })
    deliverOutput('single', terminalId, 1, 'RECOVERED\r\n')
    pumpRaf()
  })
  expect(creditMessages()).toEqual([expect.objectContaining({
    attachRequestId: latestAttachRequestIdForTerminal(terminalId), consumedSeq: 1,
  })])
})

it.each([false, true])('superseded mixed and no-write work never acknowledges the old generation (inflight=%s)', async (inflight) => {
  const { store, tabId, paneId, terminalId, term } = await setupPacedPane({ suffix: `stale-${inflight}`, mode: 'codex' })
  const pumpRaf = captureRaf()
  const held: Array<() => void> = []
  term.write.mockImplementation((_data: string, callback?: () => void) => { if (callback) held.push(callback) })
  const oldAttach = latestAttachRequestIdForTerminal(terminalId)
  act(() => {
    messageHandler!({ type: 'terminal.attach.ready', terminalId, headSeq: 3, replayFromSeq: 1, replayToSeq: 3 })
    deliverOutput('single', terminalId, 1, PREFIX + INCOMPLETE_SGR)
    deliverOutput('single', terminalId, 2, ';255m')
    deliverOutput('single', terminalId, 3, OSC52_ONLY_FRAME)
    if (inflight) pumpRaf()
  })
  act(() => store.dispatch(requestPaneRefresh({ tabId, paneId })))
  await waitFor(() => expect(latestAttachRequestIdForTerminal(terminalId)).not.toBe(oldAttach))
  act(() => {
    held.splice(0).forEach((callback) => callback())
    pumpRaf()
  })
  expect(creditMessages().filter((message) => message.attachRequestId === oldAttach)).toEqual([])
  expect(readPacedCheckpoint(terminalId, paneId)).toBeNull()
  if (!inflight) expect(term.write).not.toHaveBeenCalled()
})
```

Also parameterize the buffered-only test with an incomplete OSC (`'\x1b]0;title'`, continuation `'\x07AFTER\r\n'`) so both renderable CSI and OSC buffering are exercised. Keep the existing fully completed OSC52-only coverage/checkpoint eligibility regression green. Add a stale/unmounted late mixed-write completion using the same held callback, `const deliver = messageHandler!; cleanup(); held.splice(0).forEach(cb => cb())`, and assert zero old-generation credit/checkpoint. Keep existing refresh, hidden reveal, exit, replay-gap, and legacy strict mixed-BEL tests intact.

In `terminal-write-queue.test.ts`, add this complete failure settlement test. It runs queue behavior, not source text:

```ts
it('settles a thrown write without success and schedules following ordered work', () => {
  const raf: FrameRequestCallback[] = []
  const failed = vi.fn()
  const successful = vi.fn()
  const laterTask = vi.fn()
  const completed = vi.fn()
  const write = vi.fn((data: string, callback?: () => void) => {
    if (data === 'bad') throw new Error('write rejected')
    callback?.()
  })
  const queue = createTerminalWriteQueue({
    terminalInstanceId: 'surface-throw', write,
    onWriteFailed: failed, onWriteCompleted: completed,
    requestFrame: (callback) => { raf.push(callback); return raf.length },
    cancelFrame: () => {},
  })
  queue.setActiveGeneration('A')
  queue.enqueue('bad', successful, { generation: 'A', coalesce: false })
  queue.enqueueTask(laterTask, { generation: 'A' })
  expect(() => { while (raf.length) raf.shift()!(0) }).not.toThrow()
  expect(successful).not.toHaveBeenCalled()
  expect(completed).not.toHaveBeenCalled()
  expect(failed).toHaveBeenCalledWith(expect.objectContaining({ generation: 'A', error: expect.any(Error) }))
  expect(laterTask).toHaveBeenCalledOnce()
  expect(queue.hasInFlightWrites()).toBe(false)
  expect(getTerminalOutputWriteScope('surface-throw')).toBeNull()
  queue.setActiveGeneration('B')
  queue.enqueue('good', successful, { generation: 'B' })
  while (raf.length) raf.shift()!(0)
  expect(successful).toHaveBeenCalledOnce()
  expect(completed).toHaveBeenCalledWith({ mode: 'live', generation: 'B' })
})
```

Add the actual browser/Rust test below before production changes. It uses synthetic public controls and a real PTY writer. Each test must preserve its incomplete frame boundary; assertions on the route's actual server data make that requirement non-vacuous.

**Browser specification code and fixture construction:** create `terminal-replay-credit-rust.spec.ts` with default imports `fs` from `node:fs/promises`, `os` from `node:os`, and `path` from `node:path`; type-only `BrowserContext` from `@playwright/test`; `test`/`expect`/`createFreshE2ePage` from `../helpers/fixtures.js`; `RustServer` from `../helpers/rust-server.js`; `TestHarness`/`selectShellFromPicker` from `../helpers/test-harness.js`; and `installRecoveryOfferAutoDecline` from `../helpers/recovery-offer.js`. The copied REST helper's `E2eServerInfo` type comes from `../helpers/server-fixture-support.js`. Copy the existing bodies of these bounded helpers from `paced-restore-convergence-rust.spec.ts` without its flood constants or provider features: `sendTerminalInput` (line 335), `flushPersistence` (348), `selectTab` (355), `createShellTabViaRest` (318), and `terminalIdOfTabFromState` (383). Each remains local to the new spec. The donor already proves these real UI/REST interfaces work in cloud.

Use this complete boundary collector; it forwards actual traffic and changes only the client's requested page budget:

```ts
type WireMessage = {
  type?: string; terminalId?: string; attachRequestId?: string;
  consumedSeq?: number; seqStart?: number; seqEnd?: number; data?: string;
  source?: string; sinceSeq?: number; intent?: string; replayPageBytes?: number;
}
type WireEvent = { direction: 'client' | 'server'; message: WireMessage }
const SGR = '\x1b[38;5;2;48;2;33;58'
const DONE = 'REPLAY-CREDIT-DONE'

function collectReplayWire(context: BrowserContext) {
  const events: WireEvent[] = []
  let target = ''
  let restoring = false
  let holdFirstBoundary = false
  let holdContinuation = false
  let releaseBoundary: (() => void) | undefined
  let heldContinuation = false
  return {
    events,
    setTarget: (terminalId: string) => { target = terminalId },
    begin: (hold: boolean) => { restoring = true; holdFirstBoundary = hold; releaseBoundary = undefined },
    release: () => { releaseBoundary?.(); releaseBoundary = undefined },
    hasHeldBoundary: () => releaseBoundary !== undefined,
    holdNextContinuation: () => { holdContinuation = true; heldContinuation = false },
    hasHeldContinuation: () => heldContinuation,
    resumeContinuation: () => { holdContinuation = false },
    install: async () => {
      await context.routeWebSocket((url) => url.pathname === '/ws', (client) => {
        const server = client.connectToServer()
        client.onMessage((raw) => {
          const parsed = JSON.parse(String(raw)) as WireMessage
          events.push({ direction: 'client', message: parsed })
          if (restoring && parsed.type === 'terminal.attach' && parsed.terminalId === target) {
            server.send(JSON.stringify({ ...parsed, replayPageBytes: 1 }))
          } else server.send(raw)
        })
        server.onMessage((raw) => {
          const parsed = JSON.parse(String(raw)) as WireMessage
          events.push({ direction: 'server', message: parsed })
          if (restoring && parsed.terminalId === target && parsed.source === 'replay') {
            if (holdFirstBoundary && parsed.data?.endsWith(SGR)) {
              holdFirstBoundary = false
              releaseBoundary = () => client.send(raw)
              return
            }
            if (holdContinuation && parsed.data?.includes(DONE)) {
              heldContinuation = true
              return
            }
          }
          client.send(raw)
        })
        client.onClose((code, reason) => void server.close({ code, reason }).catch(() => {}))
        server.onClose((code, reason) => void client.close({ code, reason }).catch(() => {}))
      })
    },
  }
}
```

Rust's `crates/freshell-ws/tests/paced_replay.rs:887` already asserts that negotiated pages are stamped `source: 'replay'`; use that real wire field. Never relabel, split, or manufacture server output.

Build the writer in an owned temporary directory before typing its file path into the terminal. The shell waits for a file that the test creates only after observing the actual incomplete live server frame, so a sleep cannot accidentally combine the two stages:

```ts
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
const releaseFile = path.join(root, 'continue')
const writerFile = path.join(root, 'writer.sh')
await fs.writeFile(writerFile, [
  '#!/bin/sh',
  "awk 'BEGIN { for (i=0;i<180;i++) printf \"REPLAY-ROW-%03d\\n\", i }'",
  "printf 'REPLAY-PREFIX\\033[38;5;2;48;2;33;58'",
  `while [ ! -f ${quote(releaseFile)} ]; do sleep 0.02; done`,
  "printf ';255m\\nREPLAY-CREDIT-DONE\\n\\033[0m'",
  '',
].join('\n'))
```

Register exactly three tests, with `test.setTimeout(120_000)` inside each, parameterized over `['refresh', 'tab-switch', 'reconnect'] as const`. For each test use the following actions and concrete assertions in this order (these are precise patch steps, not optional alternative coverage):

1. Create `root = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-replay-credit-'))`, instantiate `new RustServer()`, `info = await server.start()`, and `owned = await createFreshE2ePage(browser, info)`; install the collector on `owned.context` before the page's first navigation. Use `try/finally` to close only `owned.context`, then `server.stop()`, then `fs.rm(root, { recursive: true, force: true })`.
2. `installRecoveryOfferAutoDecline(page)`; navigate to `${info.baseUrl}/?token=${info.token}&e2e=1`; create `new TestHarness(page)`; `waitForHarness()`, `waitForConnection()`, and `selectShellFromPicker(page)`. Obtain the active tab ID from `harness.getActiveTabId()` and terminal ID from `terminalIdOfTabFromState(await harness.getState(), tabId)` using `expect.poll` until non-null. Assert `.xterm:visible` exists. Set the collector target to this ID.
3. Create a second shell tab by `createShellTabViaRest(info, root)` for the tab-switch path; keep the original tab active via `selectTab`. Send only `sh ${quote(writerFile)}\n` to the original PTY with `sendTerminalInput`; the echoed command contains no output sentinel. Poll `wire.events` for an actual server `terminal.output` or `terminal.output.batch` for this terminal whose data ends with `SGR`. Require finite `seqEnd`; save that end as `boundarySeq`. Create `releaseFile` with `fs.writeFile(releaseFile, '')`. Poll for a later actual server output frame containing `DONE`, with `seqStart > boundarySeq`, then wait for `harness.getTerminalBuffer(terminalId)` to contain `DONE`.
4. Flush persistence. Clear `wire.events.length = 0`; `wire.begin(true)`; for reconnect also `wire.holdNextContinuation()`. `await page.reload()` starts a genuine viewport hydrate for all paths. Reattach the harness and wait for its connection. Poll `wire.hasHeldBoundary()` true. Require a recorded actual replay output ending `SGR` with exactly `seqEnd === boundarySeq`, and a positive finite sequence range. Require `page.getByText('Recovering terminal output...', { exact: true })` visible before release so disappearance cannot pass vacuously.
5. For tab-switch, click the second tab and wait active, release the boundary to the browser while the original is hidden, then click the original tab and wait active. For refresh/reconnect, simply release the boundary. Require an actual **client-originated** `terminal.replay.credit` for the original terminal and `consumedSeq === boundarySeq`; record its attach request ID. Require an actual subsequent **server-originated** continuation output with matching attach ID, `seqStart > boundarySeq`, and data containing `';255m'` or `DONE`. Credits come solely from the application; no `sendWsMessage({type:'terminal.replay.credit'})` or injected receive operation is allowed.
6. For reconnect, poll `wire.hasHeldContinuation()` true before `await harness.forceDisconnect()`. Disable holding with `wire.resumeContinuation()`, wait for connection recovery, and require the new original-terminal attach uses a new request ID and `sinceSeq: 0`, demonstrating that the successfully rendered mixed prefix made the older checkpoint unusable. The old socket's held continuation is discarded with that socket; the new actual replay provides the continuation. Require an actual credit for `boundarySeq` and an actual continuation under this new generation as well.
7. Wait for the recovering text count to be zero and for the original terminal buffer to contain `DONE`. Count exact marker occurrences with `buffer.split(marker).length - 1`; require exactly one `REPLAY-PREFIX`, exactly one `DONE`, and exactly one each of `REPLAY-ROW-000`, `REPLAY-ROW-090`, and `REPLAY-ROW-179`. Require no printable `'[38;5;2;48;2;33;58'` fragment. This detects duplicate reapplication and lost scrollback.
8. Use the original visible `.xterm-viewport` locator; poll `scrollHeight > clientHeight`, record `scrollTop`, hover it and `page.mouse.wheel(0, -700)`, then poll its `scrollTop` is smaller. Click `.xterm:visible` and type `echo "REPLAY-INPUT-""WORKS"`, press Enter, and poll the buffer contains the contiguous `REPLAY-INPUT-WORKS` marker. Its command echo cannot satisfy the result.
9. Attach JSON evidence through `testInfo.attach('replay-credit-wire', { body: Buffer.from(JSON.stringify({ pathName, terminalId, boundarySeq, events: wire.events })), contentType: 'application/json' })`. Assertion failure artifacts must retain the same public wire evidence through a `finally` attachment, rather than losing it on a timeout. Assert the original terminal ID remains present in the pane state; no recreate/kill is part of recovery.

The smallest browser fixture uses shell terminals because the same startup parser and paced replay path handle Codex output. Codex-mode filtering and completion are covered through the actual component integration path above; no external provider CLI or synthetic server is needed.

- [ ] **Step 2: Run the tests and verify the intended failure**

Run in the feature worktree:

```bash
GCLOUD_ROBOT_REQUIRE=1 pnpm run test:cloud --config=default test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/terminal/terminal-write-queue.test.ts -t 'replay credit regression|settles a thrown write'
GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e --project=chromium test/e2e-browser/specs/terminal-replay-credit-rust.spec.ts
```

Expected: component regressions fail because a successful mixed write does not credit `seqEnd`, buffered-only frames are falsely persisted as reconstructable coverage, the adapter turns a thrown write into success, and a prior checkpoint is reused after mixed rendering. The standalone queue failure test fails because the thrown write escapes its RAF instead of reporting failure and continuing. The actual browser spec must match and attempt three Chromium tests; its primary intended failure is missing browser credit for the exact observed incomplete-SGR page end, with no following real Rust replay continuation. Setup, fixture path, routing, identity, syntax, or provider failures are not acceptable RED evidence. Correct such problems before changing production behavior.

- [ ] **Step 3: Add the minimal production implementation**

**3.1 Queue failure settlement.** Add `onWriteFailed` to `TerminalWriteQueueArgs`. Replace its `runItem` catch with the following patch; keep the existing success body and stale `onWriteCompleted` behavior intact:

```ts
} catch (error) {
  if (didWriteComplete) throw error
  didWriteComplete = true
  scope.complete()
  decrementInFlightWrites(item.generation)
  submittedWriteInFlight = false
  try {
    args.onWriteFailed?.({ mode: item.mode, generation: item.generation, error })
  } finally {
    continueAfterWriteCompletion()
  }
}
```

This catch handles a synchronous surface/clear failure, not an exception thrown by a successful callback. Do not swallow a callback error after `didWriteComplete` became true. The existing finally in the success path still closes scope and balances in-flight counters. The flush loop can then process ordered tasks; the component's failed-generation guard below makes those tasks unable to claim the failed range.

**3.2 Component adapter.** Remove the adapter's `try/catch` that calls `onWritten` after `term.write` throws. Keep the submitted/written test events and successful `completeWrite` wrapper, with the final call simply `term.write(data, completeWrite)`. Add `onWriteFailed` at the queue construction:

```ts
onWriteFailed: ({ generation, mode, error }) => {
  if (terminalInstanceIdRef.current !== terminalInstanceId) return
  // A failure can occur after a clear or partial surface mutation.
  surfaceCheckpointUnsafeRef.current = true
  if (currentAttachRef.current?.requestId === generation) {
    failedConsumptionAttachRef.current = generation
  }
  const quarantine = quarantineRepairRef.current
  if (quarantine) quarantine.completedWrites += 1
  log.warn('Terminal output write failed', {
    paneId: paneIdRef.current,
    terminalId: terminalIdRef.current,
    attachRequestId: generation,
    outputSource: mode,
    error: error instanceof Error ? error.message : String(error),
  })
},
```

A stale failure must not mark the **new** generation failed. It still invalidates surface reconstruction and the quarantine mutation decision because the old submission may have changed the same surface. No output data belongs in logs.

**3.3 Checkpoint safety.** Define the two refs near existing surface/attach refs. At the start of `getCheckpointDeltaReplayDecision`, return `{ ok: false as const, reason: 'surface_changed' as const }` when the unsafe ref is true; include the same ref guard in `persistSurfaceCheckpointForAttach` so another applied/null-only frame cannot replace an old unsafe checkpoint with a falsely safe one. Do not treat `seqState.surfaceSafeForDeltaReplay === false` as sufficient here: the existing pure completed null-screen filter case legitimately advances coverage despite strict unapplied quarantine.

Extend `resetParserAppliedSurface` options with `rebuildSurface?: boolean`. Reset the unsafe ref only on `opts?.rebuildSurface === true`; in the existing non-quarantined viewport-hydrate reset at line 3652, use `resetParserAppliedSurface(0, { rebuildSurface: true })`. Fresh xterm construction also initializes the ref to false. All other reset callers keep their current arguments and preserve the unsafe latch: the local-notice epoch bump at 1645, terminal identity bookkeeping at 1711, loss/quarantine bookkeeping at 3257/3401/3425, launch/terminal abandonment at 4257/4290/4349/4440/4489/5954/6146/6536, sequence-domain reset at 4975/5093, and the applied-position gap handlers at 4970/5088/5231/5359/5443/5479/5497/5502. A new terminal receives either a new xterm or a non-quarantined full hydrate before becoming checkpoint-eligible. Quarantine preparation and ordinary reconnect generation changes must not clear it. No new persistence schema is needed.

In `attachTerminal`, reset `failedConsumptionAttachRef` to `undefined` when installing a **different** request ID. Do not clear it from `onDrain`, attach-ready, another frame, or same-generation replay completion.

An unsafe surface must also override an explicit `sinceSeq` supplied by an internal reveal/recovery caller. Replace the fallback condition at line 3603 with the following branch, so an explicit cursor cannot bypass the surface guard:

```ts
} else if (effectiveIntent !== 'viewport_hydrate' && surfaceCheckpointUnsafeRef.current) {
  effectiveIntent = 'viewport_hydrate'
  clearViewportFirst = true
  fullHydrateFallbackReason = 'surface_changed'
} else if (effectiveIntent !== 'viewport_hydrate' && explicitSinceSeq === undefined && !checkpointDecision.ok) {
  effectiveIntent = 'viewport_hydrate'
  clearViewportFirst = true
  fullHydrateFallbackReason = checkpointDecision.reason
}
```

**3.4 Preprocessing result.** Change `handleTerminalOutput` callback to `(submittedBytesEqualInput: boolean) => void`. After running all three preprocessors, classify retained/control-parser state:

```ts
const turnState = turnCompleteSignalStateRef.current
const preprocessingPending = Boolean(
  startupProbeStateRef.current.pending
  || osc52ParserRef.current.pending
  || turnState.pendingEsc
  || turnState.inCsi
  || turnState.inOsc
  || turnState.inDcs
  || startupProbeReplayDiscardStateRef.current.buffered,
)
const submittedBytesEqualInput = cleaned === raw
if (preprocessingPending || (cleaned !== '' && !submittedBytesEqualInput)) {
  surfaceCheckpointUnsafeRef.current = true
}
```

The replay-discard caller additionally invalidates the surface when its own `inputBytesEqualSubmission` is false and either a write is submitted or discard buffering remains. Fully completed deliberate discard of only null-screen bytes can use the safe no-write coverage rule only when no renderable pending state remains.

Supply the completion for every nonempty successful write:

```ts
const submittedWrite = cleaned
  ? enqueueTerminalWrite(
      cleaned,
      () => onWritten?.(submittedBytesEqualInput),
      writeOptions,
      consumedDeferredClear ?? undefined,
    )
  : false
```

Return `preprocessingPending` alongside the existing submission fields. Keep repair clear atomicity, preprocessing side effects and their scope guards, OSC52 handling, and startup replay-boundary discard behavior unchanged.

**3.5 Ordered acknowledgement helper.** Remove consumption advancement and attach completion from `completeParserAppliedFrame`; it remains solely the existing strict applied/save operation, with active generation, surface identity, and parser-applied write-scope guards. It must also refuse the failed attach generation. Add a distinct accepted-range completion inside the same message-handler scope:

```ts
const completeConsumedOutput = (input: {
  attachRequestId?: string
  mode: TerminalPaneContent['mode']
  terminalInstanceId: string
  seqStart: number
  seqEnd: number
  parserAppliedSeq: number
  completedAttach: boolean
  hadWrite: boolean
  strictApplied: boolean
  safeNoWriteCoverage: boolean
}) => {
  const attach = currentAttachRef.current
  if (!attach || attach.requestId !== input.attachRequestId || attach.terminalId !== tid) return
  if (terminalInstanceIdRef.current !== input.terminalInstanceId) return
  if (input.attachRequestId !== undefined && failedConsumptionAttachRef.current === input.attachRequestId) return
  const scope = getTerminalOutputWriteScope(input.terminalInstanceId)
  if (input.hadWrite) {
    if (!scope || scope.generation !== input.attachRequestId) return
  } else if (scope) return

  if (input.strictApplied) {
    completeParserAppliedFrame(input)
  } else if (input.safeNoWriteCoverage) {
    advanceSurfaceCoverageAndPersist(tid, attach, input.seqStart, input.seqEnd)
  }
  advancePacedReplayConsumption(input.attachRequestId, input.seqEnd)
  if (input.completedAttach) {
    completeAttachGeneration({
      attachRequestId: input.attachRequestId,
      mode: input.mode,
      terminalInstanceId: input.terminalInstanceId,
      terminalId: tid,
      allowWithoutWriteScope: !input.hadWrite,
    })
  }
}
```

`completeParserAppliedFrame` no longer needs its `completedAttach` property; it accepts the structural subset provided here. Keep `completeAttachGeneration`'s original guards and fresh-marker bookkeeping. The existing `onDrain` still sends at most one coalesced credit and applies existing received/target ceilings.

**3.6 Replace accepted-output routing.** In `submitAcceptedOutput` always pass this callback to `handleTerminalOutput`:

```ts
(bytesUnchanged) => completeConsumedOutput({
  attachRequestId: input.attachRequestId,
  mode: input.mode,
  terminalInstanceId: outputTerminalInstanceId,
  seqStart: input.seqStart,
  seqEnd: input.seqEnd,
  parserAppliedSeq: input.parserAppliedSeq,
  completedAttach: input.completedAttach,
  hadWrite: true,
  strictApplied: inputBytesEqualSubmission && bytesUnchanged,
  safeNoWriteCoverage: false,
})
```

Preserve `markOutputRangeUnapplied` for all non-strict submissions and real failures; never mark mixed rendering as strict application just to release transport. For `!submission.submittedWrite && submission.preParserConsumedAllBytes`, enqueue the **actual** `completeConsumedOutput` operation with the original `mode` and `generation`, not an empty task after synchronous state movement. Set `hadWrite: false`, `strictApplied: false`, and `safeNoWriteCoverage: inputBytesEqualSubmission && !submission.preprocessingPending`; use the complete immutable input/surface ID captured above. This ordered task is allowed to credit pending buffered-only input because preprocessing owns it, but cannot save coverage for it.

If the write queue or terminal surface is absent, do not acknowledge even a no-write range. If a nonempty cleaned write cannot enqueue, mark `failedConsumptionAttachRef` for the active generation and `surfaceCheckpointUnsafeRef` true; never fall through to no-write success. A synchronous direct-write exception already returns false and must follow that same failure route. If later range callbacks/tasks run in this attach, the failed-generation guard pins consumption and checkpoint state below the failure.

Delete now-unused `schedulePacedReplayCreditFlush`, `completeNoWriteReplayAttach`, and `queueNoWriteReplayAttachCompletion` after their responsibilities are owned by the ordered completion. Keep the existing empty-attach ready/completion path for a genuinely empty replay window. In particular, remove the old branch that queues no-write attach completion for a **mixed nonempty** write before its callback has completed.

- [ ] **Step 4: Run the focused tests**

Run the same two commands from Step 2.

Expected: every selected component/queue test passes; the new browser file executes and passes exactly three Chromium tests. Their attached wire evidence proves the application credits the actual incomplete-SGR page end and the Rust server supplies the continuation afterward. Report the exact passed/failed/skipped counts from the runner rather than treating exit zero as proof of coverage.

- [ ] **Step 5: Refactor while green**

Keep completion decisions in `completeConsumedOutput`; remove duplicate credit/attach completion branches and outdated comments that equate `cleaned === ''` with a completed null-screen filter. Keep the strict helper narrowly responsible for checkpoint application. Consolidate queue scope/counter settlement only if both success and failure paths remain readable and the stale completion ledger still runs on successful old-generation writes. Keep test fixture helpers local to their spec following the donor convention; avoid a generic replay fault-injection framework or a new range ledger. Run the Step 2 focused cloud commands again after the refactor and require the same passing counts.

- [ ] **Step 6: Run impacted-test verification**

The changed component and serial queue serve all terminal modes and both negotiated and legacy restores, so the impacted set includes whole component lifecycle coverage, write scopes, strict sequencing/checkpoint modules, parser filters, scroll input, the actual Rust paced protocol, and the real browser replay/lifecycle donors. The final full suite checks unrelated caller regressions while keeping the three already-proven baseline failures excluded by exact test title. Do not add `skip` markers, remove tests, or alter baseline expectations.

Run:

```bash
pnpm run typecheck:client
GCLOUD_ROBOT_REQUIRE=1 pnpm run test:cloud --config=default test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TerminalView.scroll-input-policy.test.tsx test/unit/client/components/terminal/terminal-write-queue.test.ts test/unit/client/lib/paced-replay-consumption.test.ts test/unit/client/lib/terminal-attach-seq-state.test.ts test/unit/client/lib/terminal-surface-checkpoint.test.ts test/unit/client/lib/terminal-output-write-scope.test.ts test/unit/client/lib/terminal-output-side-effects.test.ts test/unit/client/lib/terminal-startup-probes.test.ts test/unit/client/lib/terminal-osc52.test.ts test/unit/client/lib/turn-complete-signal.test.ts test/unit/shared/turn-complete-signal.test.ts test/e2e/terminal-osc52-policy-flow.test.tsx
pnpm run test:integration --test paced_replay
GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e --project=chromium test/e2e-browser/specs/terminal-replay-credit-rust.spec.ts test/e2e-browser/specs/paced-restore-convergence-rust.spec.ts test/e2e-browser/specs/opencode-replay-write-progression.spec.ts test/e2e-browser/specs/reconnection.spec.ts
GCLOUD_ROBOT_REQUIRE=1 FRESHELL_TEST_SUMMARY=terminal-replay-credit-repair pnpm run test --testNamePattern='^(?!.*(?:keeps the free-tier model banner part of readiness and handles ANSI styling|keeps every manifest-owned file visible through both ignore filters|requires executable runtime evidence to be fully Rust-only)).*$'
```

Expected: typecheck and every included test pass. The Rust command runs the real `crates/freshell-ws/tests/paced_replay.rs` target, including partial-page credit gating, input during replay, stale generations, and disconnect. The cloud browser output must show the new file's three tests and positive matching counts for each selected donor; inspect cloud skips and titles before interpreting coverage. If an existing donor is cloud-ineligible, select its eligible behavioral subset or add the missing behavior to the new eligible spec; a skipped donor is not evidence. No configured lane may silently switch to local.

The final command keeps the full-suite coordinator gate and configured cloud default lane because `--testNamePattern` is an option value, not a path selector. Source-runtime and Cargo keep their existing local phases. It excludes only these accepted pre-existing titles, which were observed in the clean base command `GCLOUD_ROBOT_REQUIRE=1 FRESHELL_TEST_SUMMARY=terminal-replay-credit-base scripts/base-gate.sh test`:

1. `test/unit/tooling/testing/opencode-native-history.test.ts` → `keeps the free-tier model banner part of readiness and handles ANSI styling` (free-tier readiness).
2. `test/unit/tooling/distribution-runtime.test.ts` → `keeps every manifest-owned file visible through both ignore filters` (`installers/systemd/freshell-supervisor.service` hidden).
3. `test/unit/architecture/rust-only-server-runtime.test.ts` → `requires executable runtime evidence to be fully Rust-only` (stale `service-systemd-supervisor` manifest row).

Store commands, exact counts, backend identity, and the comparison with those baseline failures in the external execution report. Report the included suite as passing with these three baseline exclusions; do not claim the unfiltered baseline is green. If a new failure appears, investigate and resolve it within this repair's scope or send the coordinator a substantiated disposition; do not classify it as pre-existing without evidence.

- [ ] **Step 7: Commit the task**

```bash
git add src/components/TerminalView.tsx src/components/terminal/terminal-write-queue.ts test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/terminal/terminal-write-queue.test.ts test/e2e-browser/specs/terminal-replay-credit-rust.spec.ts
git commit -m "fix: acknowledge ordered terminal replay consumption"
```

Expected: a focused repair commit with these files and a clean feature worktree. The external reports are outside the worktree and remain untracked by this branch. The coordinator then performs specification-plus-quality review for the single repair task, resolves findings according to the scope rule, and completes the authorized PR/check/merge process in `the-usual`. Follow `AGENTS.md` for updating local main by fast-forward only and worktree cleanup after integration. Never deploy or restart the live self-hosted service as part of landing.

## Verification and Scope Map

| Requirement | Observable evidence |
| --- | --- |
| Codex pane finishes rendering | Codex component single/batch tests receive the held SGR continuation; actual browser receives server continuation after application credit and recovering text disappears. |
| Scrolling and typing respond | Actual browser viewport changes after a wheel event and a real PTY emits an echo marker that typed command text cannot satisfy. |
| Tab switching | Browser holds the incident-shaped replay boundary, switches away/reveals, and then completes the same terminal without duplication. |
| Reconnecting | Browser disconnects after successful mixed-prefix consumption; next generation full-hydrates with `sinceSeq: 0`, then renders continuation once. Prior-checkpoint component test also proves old delta state is refused. |
| Refreshing | Browser reload starts a new surface and real retained replay reproduces all markers once. Component supersession protects refresh before/after an in-flight callback. |
| Stale/failure/checkpoint safety | Held callback, queued/in-flight supersession, unmount, throw-adapter, queue settlement, buffered-only CSI/OSC, and strict checkpoint regressions. |
| Red/green/refactor and integration coverage | Step 2 intended RED; Step 4 GREEN; Step 5 cleanup and rerun; Step 6 real Rust target/browser/cloud/full-suite gates. |
| Dedicated branch, preserved work, focused commits | Existing worktree/base, explicit add list, local repair commit, authorized PR to main after review. |
| Baseline failures remain recorded | Exact three-title final-suite exclusions plus retained clean-base log; no unrelated baseline fixes. |
| No live service mutation/secrets/process interference | Only owned test fixtures and ports; no source service operations or credential retrieval. OneCLI remains mandatory if a later authorized operation truly requires secrets. |

## Planning Self-review

The complete dispatcher-authored User Request above is included once and unchanged. Every active requirement maps to Task 1 and the observable evidence table. The plan contains no provider stub, synthetic replay response, fabricated browser credit, production restart, new dependency, checkpoint schema migration, or unrelated baseline repair. Pure unit and component test doubles only isolate callbacks; real Rust PTYs and actual browser wire routing prove the production boundary.

The central draft explicitly separates ordered transport consumption, strict parser application, and reconstruction-safe coverage. Mixed rendering cannot release an old saved checkpoint on reconnect; no-write buffered controls can release transport without saving false coverage. Queue failure settlement releases bookkeeping while component guards prevent later same-generation acknowledgements. The final gate acknowledges the baseline exceptions without weakening test code.

Pre-implementation code in this document is a draft. During execution the source tree supersedes code blocks; repair/review fixes must not backport implementation into this plan. The User Request, Goal, Architecture, Global Constraints, and task intent remain authoritative.
