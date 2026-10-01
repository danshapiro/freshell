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

**Goal:** A restored Codex terminal finishes rendering across replay-page and replay-to-live boundaries, remains usable through tab changes, reconnects, and browser refresh, and recovers without duplicated content or false exhaustion when fresh output succeeds.

**Architecture:** Successful ordered stream consumption advances replay credit and recovery liveness independently of strict applied/checkpoint coverage, while ordinary pending rendering bytes survive intact same-generation replay-to-live transitions. A mounted surface that needs reconstruction uses one replay-scoped non-coalescing local CAN/RIS/cursor-visible write; only genuine completion followed by all queue hooks and a guarded ordered task establishes a fresh zero baseline and sends the existing surfaceReset full-hydrate attach. Old input is fenced before preprocessing throughout that local interval, and failure, supersession, or abandonment never authorizes an attach or falsely clears new-generation uncertainty.

**Tech Stack:** React 18, TypeScript, xterm 6, the existing serial terminal write queue, Vitest component integration tests, Playwright Chromium, and the Rust/Axum paced replay implementation.

## Global Constraints

- Implement in `/home/dan/code/freshell/.worktrees/terminal-replay-credit`, branch `the-usual/terminal-replay-credit`, created from `origin/main` at `58b65677ff2c70a42525413bd76daa67de13644f`. The user has explicitly bypassed the green-base prerequisite for this repair.
- Respect `AGENTS.md`, especially worktree ownership, process ownership, test coordination, and the PR branch model. The user has authorized PR creation and merging for this change. The coordinator owns the external run record and workflow transitions.
- pnpm is exactly `10.34.5`; Node is at least `22.5`; Rust meets the workspace `1.96` requirement. Keep frozen installs and the existing lockfile. No dependencies or server protocol changes are needed. Relative TypeScript imports include `.js`.
- `FRESHELL_VITEST_BACKEND=cloud` and `FRESHELL_E2E_BACKEND=cloud` are already configured. Use `GCLOUD_ROBOT_REQUIRE=1` on cloud gates. Focused `test:vitest` delegates locally regardless of this setting; use `test:cloud --config=default` instead. Rust and source-runtime lanes remain local as designed, as does Electron; this is not a fallback from cloud.
- Keep serial/coalesced stream-write order, generation checks, scoped side effects, the stale completed-write mutation ledger, negotiated/legacy compatibility, and strict applied/checkpoint integrity. Local reconstruction is a hard non-coalescing boundary. Do not bypass Rust's page-end credit requirement or issue credits from a test harness.
- For mounted reconstruction use only the selected executed controls `\x18\x1bc\x1b[?25h` (CAN, RIS, cursor visible), established in `reports/load-bearing-validator-lbf-4.md`, under replay side-effect suppression. An epoch update, `term.clear()`, direct JavaScript `term.reset()`, or bare RIS does not substitute for this operation. Keep genuinely new blank-surface handling separate; do not recreate the terminal instance or add a reset framework.
- Reconstruction uses the existing supported mode projection, including the empty projection. Preserve the intentional omissions of focus-reporting `?1004`, synchronized-output `?2026`, and XTMODIFYKEYS. The server's optional tagged mode preamble precedes replay and bypasses ordinary output preprocessing. Neither mode traffic nor local reset bytes has a stream range or counts toward credit, checkpoint, or recovery progress.
- Use a public synthetic escape fragment, never the captured private transcript. The diagnosis is already proven: preprocessing held an incomplete SGR suffix, wrote a visible prefix, and suppressed the only completion callback needed to credit the page.
- Do not use live user panes or production port `3001`. Browser tests own isolated `RustServer` instances, random ports, temporary homes, and their processes. Follow the existing test fixtures' cleanup; do not use broad process kills. Do not restart or deploy the source service.
- No new UI feature, end-user documentation, mock redesign, migration, or secret is required. Keep the existing recovering/retry UI, progressless-attempt bound, explicit user retry/refresh semantics, honest gap notices, and healthy backend terminal identity. Correct fresh-output accounting and ordinary rendering-fragment ownership; do not weaken existing meaningful behavior tests. Use the existing structured logger for failure/reconstruction lifecycle events; never log terminal output bytes or tokens.
- The implementer owns RED/GREEN/refactor, focused impacted verification, and the repair commit. The task coordinator owns the one final broad full-suite gate after task review/repairs, plus the authorized PR/check/merge workflow. Do not duplicate that broad run inside every implementation or fixing turn.
- Record the three accepted baseline failures and evidence under `.worktrees/.the-usual-logs/terminal-replay-credit/reports/`. Do not fix or weaken their tests in this repair. Their exact titles are listed under Coordinator Final Suite Gate.

---

## File Responsibilities

| File | Responsibility |
| --- | --- |
| `src/components/TerminalView.tsx` | Separate successful consumption/recovery progress from checkpoint application; preserve ordinary replay/live pending bytes; order and fence mounted reconstruction; prevent stale/failure acknowledgement and unsafe checkpoint reuse. |
| `src/components/terminal/terminal-write-queue.ts` | Settle a thrown surface write without success, balance scopes/counters, preserve stale mutation hooks, and provide serial non-coalescing write/post-hook task ordering. |
| `test/unit/client/components/TerminalView.lifecycle.test.tsx` | Exercise actual component consumption, fresh/progressless recovery, final replay/live ownership, local-ticket fences, reset completion/failure/staleness, mode/empty projection, and lifecycle paths. |
| `test/unit/client/components/terminal/terminal-write-queue.test.ts` | Prove failure settlement releases scope/counters without successful acknowledgement and subsequent queue scheduling still works. |
| `test/e2e-browser/specs/terminal-replay-credit-rust.spec.ts` | Four actual browser/Rust tests prove replay-page and replay/live continuation, mounted reconstruction without duplicates, and scrolling/typing through refresh, reconnect, and tab switching. |
| This plan | Agent implementation intent and pre-implementation code drafts; source becomes authoritative once execution starts. |

These responsibilities form one independently reviewable repair. Existing parsers can buffer the required controls, but their component ownership/reset boundary must change. Existing paced-credit and recovery high-water helpers provide the needed monotonic decisions; do not introduce protocol fields, persisted parser state, or an unrelated range ledger. The accepted architecture decisions and their evidence are recorded in `reports/load-bearing-validator-lbf-1.md` through `load-bearing-validator-lbf-4.md` under `.worktrees/.the-usual-logs/terminal-replay-credit/`; the preparation report is `reports/plan-amendment-preparation.md`. Evidence remains in those reports.

### Task 1: Restore terminal replay progress without unsafe acknowledgements

**Files:**
- Modify: `src/components/TerminalView.tsx:409` (submission result), `:1246` (checkpoint eligibility), `:1263` (baseline bookkeeping), `:1377` (paced completion), `:1524`/`:1576` (checkpoint/recovery separation), `:2398` (phase ownership), `:2421` (output submission), `:2765` (queue adapter), `:3310` (input fence), `:3493` (attach/reconstruction ordering), `:4544`/`:4635` (accepted success), `:5582` (mode admission).
- Modify: `src/components/terminal/terminal-write-queue.ts:34` (failure interface), `:161` (write settlement).
- Test: `test/unit/client/components/TerminalView.lifecycle.test.tsx:13714`.
- Test: `test/unit/client/components/terminal/terminal-write-queue.test.ts`.
- Test: `test/unit/client/lib/terminal-recovery-accounting.test.ts`, `test/unit/client/lib/terminal-startup-probes.test.ts`, and `test/unit/client/lib/terminal-surface-checkpoint.test.ts` as impacted behavioral contracts.
- Create: `test/e2e-browser/specs/terminal-replay-credit-rust.spec.ts`.

**Interfaces:**
- Consumes: `enqueue(data: string, onWritten?: () => void, options?: TerminalWriteQueueOptions): void`, `enqueueTask(task: () => void, options?: TerminalWriteQueueOptions): void`, `setActiveGeneration(generation: string, options?: { dropQueuedStaleWrites?: boolean }): void`, and `hasInFlightWrites(generation?: string): boolean`.
- Consumes: `pacedReplayConsumeThrough(state, seqEnd)`, `pacedReplayNextCredit(state)`, and the existing received/attach target ceilings; their APIs and wire fields remain unchanged.
- Produces: `TerminalWriteQueueArgs.onWriteFailed?: (item: { mode: TerminalWriteQueueMode; generation: string | undefined; error: unknown }) => void`; it runs only for a thrown `clearBeforeWrite`/write before successful completion and never substitutes for a success callback.
- Produces: `TerminalOutputSubmission` retains `submittedWrite`, `submittedBytesEqualInput`, and `preParserConsumedAllBytes` (meaning only `cleaned === ''`, not proof of checkpoint safety), and adds `preprocessingPending: boolean`.
- Produces: `handleTerminalOutput(raw: string, mode: TerminalPaneContent['mode'], tid: string | undefined, allowReplies: boolean, onWritten?: (submittedBytesEqualInput: boolean) => void, writeOptions?: TerminalWriteQueueOptions): TerminalOutputSubmission`; every successful nonempty write invokes this callback with its fidelity result.
- Produces: surface-scoped unsafe-checkpoint state, attach-scoped failed-consumption state, and one local reconstruction ticket owning the pending interval. The ticket captures a unique unsent generation, terminal/surface/queue identity, connection eligibility, and genuine-success/abandonment status; no new server field or persistent state is introduced. Only a newly constructed blank surface or the guarded post-hook reconstruction boundary retires old-baseline uncertainty.
- Consumes: `recordRecoveryProgress` and `beginRecoveryAttempt` from `src/lib/terminal-recovery-accounting.ts`. Successful original stream sequence ends, including live positions above replay target, supply independent recovery progress; replaying a previously consumed position never refunds an attempt.
- Produces: a normal same-stream replay/live ownership rule preserving ordinary pending CSI/OSC until continuation, while matching known startup-query remainders retain intentional suppression and generation/discontinuity resets retire obsolete ownership.
- Produces: mounted reconstruction using the existing `terminal.attach` shape (`sinceSeq: 0`, internal `viewport_hydrate`, `surfaceReset: true`) and optional existing `terminal.modes.sync`. Hidden panes retain the existing wire `keepalive_delta` projection without losing those full-hydrate/freshness semantics.

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


```

Also parameterize the buffered-only test with an incomplete OSC (`'\x1b]0;title'`, continuation `'\x07AFTER\r\n'`) so both renderable CSI and OSC buffering are exercised. Keep the existing fully completed OSC52-only coverage/checkpoint eligibility regression green. Add a stale/unmounted late mixed-write completion using the same held callback, `const deliver = messageHandler!; cleanup(); held.splice(0).forEach(cb => cb())`, and assert zero old-generation credit/checkpoint. Keep existing refresh, hidden reveal, exit, replay-gap, and legacy strict mixed-BEL tests intact.

The earlier draft's synchronous reconnect/refresh tests are replaced by the following behavioral cases because mounted reconstruction now owns an unsent local ticket. Add these cases to the same `replay credit regression` describe so the focused selector executes all of them. Use the actual component adapter and existing held-callback/RAF helpers; do not infer a sent attach from a local ticket or release reset success through a disposal/exception callback.

**Final replay target 1 followed by live sequence 2:** For every row below, ready has `headSeq: 1`, `replayFromSeq: 1`, and `replayToSeq: 1`; seq 1 is replay and seq 2 is explicitly live in the same attach/stream. Run ordinary SGR/OSC through single output, barrier-free batch, and barrier-segment batch. For mixed writes, hold the real callback and supply the live continuation both before and after releasing it; concatenate actual submitted writes when coalescing changes their grouping. Seq 1 can receive credit only on its successful write or ordered no-write task; no replay credit may exceed target 1. Check strict checkpoint/safe coverage separately from rendered output and consumption.

| Case | Replay seq 1 | Live seq 2 | Required result |
| --- | --- | --- | --- |
| Mixed SGR | Public visible prefix plus `ESC[38;5;2;48;2;33;58` | `;255mAFTER` and newline | Prefix once; the complete SGR and AFTER reach xterm; no orphan printable color continuation. |
| Buffered-only SGR | Only that incomplete SGR | Same continuation | No seq-1 write; its task can acknowledge ownership, with no safe checkpoint; the complete SGR is submitted on seq 2. |
| Mixed ordinary OSC | Public visible prefix plus `ESC]0;title` | BEL and AFTER/newline | Complete title OSC reaches xterm, without treating its terminator as an orphan completion signal. |
| Buffered-only ordinary OSC | Only `ESC]0;title` | BEL and AFTER/newline | No seq-1 write/safe coverage; complete ordinary OSC reaches xterm on seq 2. |
| Recognized old startup query | `ESC]11;?` without visible prefix | Matching BEL and AFTER/newline | Suppress the old query remainder; render AFTER; emit no obsolete startup reply or query fragment. |
| Generation/discontinuity reset | Ordinary fragment or recognized query above | Continuation under another attach/stream, or after an explicit gap | Do not join obsolete pending/discard bytes across the discontinuity; new generation reconstructs through the guarded baseline path. |

Also queue a buffered-only fragment behind a held preceding real write. A no-write ownership acknowledgement must not pass that held write. Retain the original target-2 tests above: they prove continuation on another replay page and are distinct coverage.

**Recovery progress independent of checkpoint coverage:**

1. Establish safe seq 1, then a successfully rendered mixed prefix at seq 2 and continuation at seq 3, leaving safe coverage pinned at 1. Complete genuinely newer ordinary seq 4. Drive more independent keyless automatic reconnects than the existing attempt limit, with genuinely newer successfully completed output after each; every attach proceeds, each output appears once, and no exhausted strip appears. Invoke the actual reconnect handler, never user refresh/retry.
2. Repeat without any genuinely newer output: every full hydrate only reapplies already consumed ranges, and all callbacks/tasks complete. After the initial exemption, require the existing number of allowed progressless reconnects and refusal of the next, or the existing deadline if deliberately advanced; each local reconstruction plus its resulting attach is one attempt. Empty attaches and re-rendering the same history cannot refund attempts.
3. Hold a genuinely newer mixed write after a progressless attempt. Submission alone cannot refund an attempt or clear visible exhaustion; successful current-generation completion does, even with safe coverage pinned.
4. Throw through the actual adapter or supersede the newer range before/during its write. No failed/late success or later same-generation filtered task can refund recovery. A valid later generation can recover normally.
5. Successfully consume live output above a completed replay target 1. This must count as recovery liveness despite replay credit remaining capped at 1; repeated old live/replay sequence positions do not count twice.

**Mounted reconstruction, old-message fence, and mode controls:**

1. Create a prior safe checkpoint and successfully render an unterminated current-line prefix plus incomplete SGR. Require the next automatic reconnect to refuse the old delta checkpoint. Hold the reset write: no new full-hydrate attach is sent until genuine reset success, every reset hook, and its ordered continuation have completed. After pumping that continuation require `sinceSeq: 0` and `surfaceReset: true`, and replay the prefix exactly once. A new incoming incomplete fragment after attach must remain unsafe/pending after subsequent mode/write completions.
2. Begin reconstruction while an old real write is in flight. Old completion remains a surface mutation but cannot update current stream state; the local reset is submitted only afterward. Verify the ordering of actual write submission, completion hooks, final task, mode preamble, and replay. Freshness/marker advertisement must occur after the reset's own applied/completed hooks, rather than be consumed by them.
3. Make the actual reset write throw; let its queued task run. Require no attach, freshness publication, checkpoint eligibility, credit, or recovery refund; queue scopes/counters settle. A merely adjacent task is not success evidence. The subsequent valid recovery generation can establish its own successful baseline.
4. Supersede before reset submission and after submission with a held callback. A dropped write is never submitted; an already submitted old reset may mutate its old surface but never authorize the new one. Cover unmount, terminal/surface replacement, connection loss/new eligibility, refresh, and tab change. No abandoned ticket sends attach or clears uncertainty.
5. While the unsent local ticket owns reconstruction, deliver old tagged **and truly untagged** `terminal.attach.ready`, `terminal.output`, `terminal.output.batch`, `terminal.output.gap`, and `terminal.modes.sync`. Capture the callback argument of the latest `wsMocks.onMessage` invocation and deliver directly to it so `withCurrentAttachRequestId` cannot silently stamp the untagged cases. Require rejection before preprocessing/mode admission: no bytes, parser-state pollution, ready-state mutation, gap notice, credit, checkpoint, or recovery progress. After the ticket finishes, a real current-generation frame must still be accepted normally. Setting current attach to null alone fails this test because the old gate accepts null.
6. Use the public exact mode projection fixtures under `port/oracle/baselines/mode-preamble/`: `f01-opencode-startup.json`, `f04-alt-fold.json`, `f06-ris.json`, `f13-cursor-visibility-restore.json`, `f15-empty-tracker.json`, and `f16-wraparound-disable.json`. Require the component to submit local reset, then only the supported tagged mode bytes through direct replay queue admission, then stream replay. Check alternate-buffer/paste/mouse/wrap/cursor behavior through actual emulator coverage where the fixture supports it; never assert a static fixture string without running the protected behavior.
7. In the empty projection path, send ready and replay with no mode frame and require completion. Cursor-visible default comes from the selected local reset; a tracked-hidden preamble can intentionally hide it again. No omitted focus `?1004`, sync-output `?2026`, or XTMODIFYKEYS mode is manufactured.
8. Protect local cancellation of stale incomplete OSC/DCS payloads and hidden cursor state: actual selected reset controls must cancel obsolete title/query payloads, normalize visibility, and establish a blank buffer/cursor baseline before replay. Use production-submitted control bytes with the real emulator/queue in behavioral coverage: load the actual published xterm through Vitest's `vi.importActual`, create one disposable unopened terminal, and delegate the mocked component surface's write operation to that actual emulator while retaining the component's genuine queue callbacks. Read its normal/alternate buffers, cursor position, mode/query responses, and title/data observers; dispose it in test cleanup. Feed component-received mode frames through its normal adapter, rather than independently assembling an expected reset in the test. The exact capability was executed by LBF-4; these cases protect production admission/ownership and bytes without a new production helper or reset framework.
9. Require local reset and mode synchronization to have no sequence range and no credit, strict application, coverage save, or recovery refund of their own. Existing successful stream credit may flush on a drain, but neither local control is its justification.

Keep the existing meaningful negotiated/legacy strict mixed-BEL, hidden reveal, exit, checkpoint, gap, fresh-claim, user retry/refresh, and stale callback tests. Where reconstruction changes asynchronous timing, update test actions to pump the real ordered boundary; retain the protected behavioral assertions rather than weakening them to fit a mock. The browser reconnect case below also proves that the first-line partial prefix was physically erased and replayed once.

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

Register the first three tests, with `test.setTimeout(120_000)` inside each, parameterized over `['refresh', 'tab-switch', 'reconnect'] as const`. Add the distinct fourth replay-to-live test below; the new file must contain and execute exactly four Chromium tests. For each of these three lifecycle tests use the following actions and concrete assertions in this order (these are precise patch steps, not optional alternative coverage):

1. Create `root = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-replay-credit-'))`, instantiate `new RustServer()`, `info = await server.start()`, and `owned = await createFreshE2ePage(browser, info)`; install the collector on `owned.context` before the page's first navigation. Use `try/finally` to close only `owned.context`, then `server.stop()`, then `fs.rm(root, { recursive: true, force: true })`.
2. `installRecoveryOfferAutoDecline(page)`; navigate to `${info.baseUrl}/?token=${info.token}&e2e=1`; create `new TestHarness(page)`; `waitForHarness()`, `waitForConnection()`, and `selectShellFromPicker(page)`. Obtain the active tab ID from `harness.getActiveTabId()` and terminal ID from `terminalIdOfTabFromState(await harness.getState(), tabId)` using `expect.poll` until non-null. Assert `.xterm:visible` exists. Set the collector target to this ID.
3. Create a second shell tab by `createShellTabViaRest(info, root)` for the tab-switch path; keep the original tab active via `selectTab`. Send only `sh ${quote(writerFile)}\n` to the original PTY with `sendTerminalInput`; the echoed command contains no output sentinel. Poll `wire.events` for an actual server `terminal.output` or `terminal.output.batch` for this terminal whose data ends with `SGR`. Require finite `seqEnd`; save that end as `boundarySeq`. Create `releaseFile` with `fs.writeFile(releaseFile, '')`. Poll for a later actual server output frame containing `DONE`, with `seqStart > boundarySeq`, then wait for `harness.getTerminalBuffer(terminalId)` to contain `DONE`.
4. Flush persistence. Clear `wire.events.length = 0`; `wire.begin(true)`; for reconnect also `wire.holdNextContinuation()`. `await page.reload()` starts a genuine viewport hydrate for all paths. Reattach the harness and wait for its connection. Poll `wire.hasHeldBoundary()` true. Require a recorded actual replay output ending `SGR` with exactly `seqEnd === boundarySeq`, and a positive finite sequence range. Require `page.getByText('Recovering terminal output...', { exact: true })` visible before release so disappearance cannot pass vacuously.
5. For tab-switch, click the second tab and wait active, release the boundary to the browser while the original is hidden, then click the original tab and wait active. For refresh/reconnect, simply release the boundary. Require an actual **client-originated** `terminal.replay.credit` for the original terminal and `consumedSeq === boundarySeq`; record its attach request ID. Require an actual subsequent **server-originated** continuation output with matching attach ID, `seqStart > boundarySeq`, and data containing `';255m'` or `DONE`. Credits come solely from the application; no `sendWsMessage({type:'terminal.replay.credit'})` or injected receive operation is allowed.
6. For reconnect, poll `wire.hasHeldContinuation()` true before `await harness.forceDisconnect()`. Disable holding with `wire.resumeContinuation()`, wait for connection recovery, and require the new original-terminal attach uses a new request ID and `sinceSeq: 0`, demonstrating that the successfully rendered mixed prefix made the older checkpoint unusable. The old socket's held continuation is discarded with that socket; the new actual replay provides the continuation. Require an actual credit for `boundarySeq` and an actual continuation under this new generation as well.
7. Wait for the recovering text count to be zero and for the original terminal buffer to contain `DONE`. Count exact marker occurrences with `buffer.split(marker).length - 1`; require exactly one `REPLAY-PREFIX`, exactly one `DONE`, and exactly one each of `REPLAY-ROW-000`, `REPLAY-ROW-090`, and `REPLAY-ROW-179`. Require no printable `'[38;5;2;48;2;33;58'` fragment. This detects duplicate reapplication and lost scrollback.
8. Use the original visible `.xterm-viewport` locator; poll `scrollHeight > clientHeight`, record `scrollTop`, hover it and `page.mouse.wheel(0, -700)`, then poll its `scrollTop` is smaller. Click `.xterm:visible` and type `echo "REPLAY-INPUT-""WORKS"`, press Enter, and poll the buffer contains the contiguous `REPLAY-INPUT-WORKS` marker. Its command echo cannot satisfy the result.
9. Attach JSON evidence through `testInfo.attach('replay-credit-wire', { body: Buffer.from(JSON.stringify({ pathName, terminalId, boundarySeq, events: wire.events })), contentType: 'application/json' })`. Assertion failure artifacts must retain the same public wire evidence through a `finally` attachment, rather than losing it on a timeout. Assert the original terminal ID remains present in the pane state; no recreate/kill is part of recovery.

**Fourth test: final replay control continues in actual live output.** Name it `retains the final replay SGR until its actual live continuation`. Reuse the owned Rust/identity/PTY/writer/route fixture, actual wire evidence, scroll/input assertions, and cleanup above, with these precise differences:

1. Keep the writer release file absent after its actual first-stage server output ends in the incomplete SGR. Record that frame's `seqEnd` as the boundary; no continuation/final-marker output may have been produced yet.
2. Flush persistence and reload the real browser. Retain the real `terminal.attach.ready` bounds in the route evidence and require its `replayToSeq`/head to equal that boundary. Do not make the continuation retained output before this attach or present it as another replay page.
3. Release that **final** replay frame to the application and require actual client-generated credit for its exact end, under the current attach ID. Require the recovering status to finish through the actual successful consumption edge without discarding the ordinary pending rendering bytes.
4. Only now create the owned release file. Require actual server `source: 'live'` output in the same stream/attach, at a sequence above the completed replay target, containing the SGR continuation and final marker. The collector must record real ready bounds and stream identity as well as output/credit; no relabeling, injected receive, or fabricated credit is allowed.
5. Require the visible prefix and final marker once, rows once, and no printable `;255m` or orphan SGR fragment; run the same real wheel/keyboard checks. Attach ready/credit/live-continuation evidence even when assertions fail.

The lifecycle cases exercise mounted reconstruction where reconnect/hide/reveal must replace a dirty surface; require that resulting attach to carry `surfaceReset: true` as well as `sinceSeq: 0`. A browser reload's genuinely new blank surface keeps its existing initial fresh attach. Preserve the terminal ID and prove the unterminated first-line prefix is physically erased before mounted replay through exact marker counts in the real xterm buffer. The local reset is never a wire credit or sequence-bearing server output. Mode-projection/empty-path details are protected by the component/queue/emulator cases above; no extra external provider fixture is needed.

The smallest browser fixture uses shell terminals because the same startup parser and paced replay path handle Codex output. Codex-mode filtering and completion are covered through the actual component integration path above; no external provider CLI or synthetic server is needed.

- [ ] **Step 2: Run the tests and verify the intended failure**

Run in the feature worktree:

```bash
GCLOUD_ROBOT_REQUIRE=1 pnpm run test:cloud --config=default --shards=1 test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/terminal/terminal-write-queue.test.ts -t 'replay credit regression|settles a thrown write'
GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e --project=chromium test/e2e-browser/specs/terminal-replay-credit-rust.spec.ts
```

Expected: component regressions fail because mixed successful writes do not credit `seqEnd`, buffered-only frames are falsely checkpointed, the adapter turns throws into success, old checkpoints/partial surface content survive false clear-based hydration, old untagged input enters before reconstruction fences, final replay completion loses an ordinary pending SGR/OSC, and fresh output cannot refund recovery when safe coverage is pinned. The standalone queue failure test fails because the thrown write escapes its RAF instead of reporting failure and continuing. The actual browser spec must match and attempt four Chromium tests; its primary intended failure is missing browser credit for the exact observed incomplete-SGR page end, with no following real Rust replay continuation. The fourth browser case additionally must distinguish a truly live continuation after final replay completion; its missing ordinary prefix control is separate from page pacing. Setup, fixture path, routing, identity, syntax, or provider failures are not acceptable RED evidence. Correct such problems before changing production behavior.

- [ ] **Step 3: Add the minimal production implementation**

**3.1 Successful stream consumption and write failure settlement.** `handleTerminalOutput` must supply its completion for every successful nonempty cleaned write, including mixed filtered/pending input; it reports byte fidelity separately. Complete stream consumption only inside the active generation/surface write scope, using the accepted original sequence end, never just the cleaned prefix length. Strict application/checkpoint advancement remains conditional on the existing byte-fidelity, contiguity, identity, and scope rules. A fully preprocessed no-write range executes its actual acknowledgement as a generation-scoped queue task behind earlier writes; buffering can acknowledge owned bytes but cannot certify reconstructable coverage. An absent queue/surface, failed enqueue, or thrown write never acknowledges consumption.

Remove the component adapter's thrown-write success fallback. The queue's failure path closes its scope, balances in-flight state, reports `onWriteFailed`, and schedules following work without calling successful callbacks or successful applied/completed hooks. Do not swallow exceptions from callbacks that had already completed successfully. A failed accepted stream range pins all later same-generation consumption/checkpoint/recovery/completion decisions; a later attach generation can establish a new valid state. Preserve the stale **successful** completed-write mutation ledger. Failure may have followed a local clear or partial mutation, so retain uncertainty; a failure from another surface cannot mark the current replacement's generation successful or failed.

**3.2 Independent recovery liveness.** Make the guarded ordered accepted-success edge supply the original `seqEnd` to recovery's monotonic progress decision, independently of strict application, safe coverage, or the target-capped paced frontier. New successful mixed, ordinary, and genuinely consumed no-write output can advance liveness; reception, submission, reset/mode bytes, failed/dropped work, an empty attach, and re-rendering previously consumed history cannot. Keep the recovery high-water across same-stream full hydration, including a zero surface baseline. Update the existing visible exhausted state when genuine newer success clears accounting. Keep the current initial exemption, progressless bound/deadline, episode-key semantics, and explicit user refresh/retry actions. One local reconstruction and its resulting attach are one logical recovery attempt: do not count the preparatory write/task as another attempt or refund attempts when it completes. Remove coverage-contiguity as the sole automatic progress gate; do not introduce a second recovery ledger or persist parser state.

**3.3 Pending rendering ownership and checkpoint safety.** Classify pending state across startup preprocessing, OSC52, turn-signal parsing, and replay-discard buffering; `cleaned === ''` alone proves neither a completed null-screen effect nor checkpoint safety. A mixed successfully rendered prefix or unresolved ordinary rendering fragment makes an older saved surface checkpoint unusable. Block both new unsafe checkpoint saves and reuse, including an explicit internal `sinceSeq` that would otherwise bypass eligibility. Genuinely completed null-screen filtering can keep its established coverage eligibility; strict applied state remains conservative.

At an intact same-terminal/stream/attach replay-to-live phase change, retain ordinary pending CSI/OSC in its current owner until continuation. Preserve deliberate matching old-startup-query remainder suppression/resume, without obsolete replies. True generation, stream, renderer, disposal, or explicit loss/gap discontinuity retires obsolete pending/discard ownership. Changing when a destructive reset runs does not substitute for retaining those bytes. Normal mode preamble bypasses output preprocessing and cannot later overwrite new pending state.

**3.4 Mounted reconstruction decision and local ownership.** Use the verified mounted mechanism whenever this repair requires a true replacement baseline before full hydration of a dirty mounted surface. A genuinely newly constructed blank surface keeps its existing initial fresh attach; a healthy valid checkpoint delta keeps its existing resume. Bookkeeping-only epochs, `term.clear()`, or direct JavaScript reset never retire dirty-baseline uncertainty. Preserve bounded quarantine handling and the existing intentional gap/no-wipe behavior when reconstruction is abandoned before submission; do not automatically erase a healthy surface on a rejected or fully filtered frame.

Create one unique unsent local reconstruction ticket bound to terminal, surface, queue, and connection eligibility. Install its generation and drop obsolete queued work before local reset admission. Fence old tagged **and untagged** ready/output(single/batch)/gap/mode frames for this terminal before preprocessing throughout the owned interval; explicitly address the existing null-current-attach acceptance exception. The ticket is local lifecycle ownership, not a backend attach or wire/protocol extension. Teardown, terminal/surface change, reconnect eligibility change, refresh, tab change, or superseding attach invalidates its authorization. Do not recreate the emulator, backend terminal, or input/layout registration, and do not add a generic reset framework.

**3.5 Executed local control and post-hook baseline boundary.** Submit the validator-executed controls `\x18\x1bc\x1b[?25h` as one **non-coalescing** direct queue write under replay side-effect suppression, owned by that local ticket. Bypass ordinary preprocessing; assign no stream sequence. CAN cancels obsolete OSC/DCS payloads before RIS, and the cursor-visible control establishes the default that an empty server projection cannot restore. Capability and exact controls were executed in `reports/load-bearing-validator-lbf-4.md`, especially its selected observation; do not replace them with an invented reset sequence.

Its genuine successful callback only marks that ticket's success. Do not publish freshness or send attach inside that callback: the queue still has applied/completed hooks and scope/counter settlement to run. Enqueue an ordered task under the same ticket; only after all hooks does it recheck genuine success, non-abandonment, active ticket/generation, mounted/current surface, terminal ID, queue identity, and current connection eligibility. A following task without a success flag cannot authorize anything.

At that guarded boundary, retire **only the old baseline's** preprocessing/discard/unsafe state, zero applied/coverage with a new surface epoch, publish freshness with fresh-write bookkeeping reset, and install the real next attach generation/fence before permitting its messages. Then send existing full-hydrate semantics with `sinceSeq: 0` and `surfaceReset: true`. No later reset callback/task may clear uncertainty or parser bytes after current-generation output has entered preprocessing. Local reset completion never advances stream/recovery cursors, and it must not refund recovery attempts or complete a stream attach.

**3.6 Server projection and actual attach completion.** Reuse the existing server ready → optional tagged mode sync → replay order. Keep mode sync in direct generation-guarded replay queue admission and preserve its supported projection, including intentionally omitted focus/synchronized-output/XTMODIFYKEYS controls. Internal full-hydrate freshness still requests `surfaceReset` when a hidden pane's wire intent is `keepalive_delta`. An empty projection produces no mode frame; do not wait for one. A tracked-hidden preamble can hide the cursor after the local visible default, and alternate/paste/mouse/wrap projections must apply before replay.

Guard real stream attach completion with successful ordered consumption and the existing active attach/terminal/surface rules. A mixed nonempty frame cannot queue a no-write completion before its real callback; a no-write frame completes only through its actual ordered task. Keep the genuine empty-window ready/completion path and fresh marker bookkeeping. Delete duplicate no-op credit tasks or completion branches once the ordered edges own those responsibilities. Log write/reconstruction failure through the existing structured logger with terminal/pane/generation identifiers and outcome, never raw terminal bytes or tokens.

These corrected steps state decisions and intended production behavior. The accepted falsifications removed the earlier component implementation drafts; newly authored unexecuted implementation code is intentionally absent from this Stage 2 amendment. The implementer must realize the specified interfaces/invariants and prove the behavioral tests; source supersedes plan code drafts once execution begins.

- [ ] **Step 4: Run the focused tests**

Run the same two commands from Step 2.

Expected: every selected component/queue test passes; the new browser file executes and passes exactly four Chromium tests. Their attached wire evidence proves actual application credit releases the real next Rust page, and the fourth case retains ordinary pending bytes until the actual live continuation after the final replay target. Mounted reconnect reconstruction reproduces each prefix once. Report the exact passed/failed/skipped counts from the runner rather than treating exit zero as proof of coverage.

- [ ] **Step 5: Refactor while green**

Keep one guarded accepted-success decision for consumption, recovery progress, strict application, and real attach completion, with separate eligibility for each. Remove duplicate no-op credit tasks, premature mixed-frame completion, and comments equating empty cleaned bytes with safe null-screen filtering. Keep ordinary phase carry distinct from known-query discard and true generation/loss resets. Keep mounted reconstruction as one local non-coalescing write plus one guarded post-hook task; consolidate failure scope/counter cleanup only while stale successful mutation hooks remain intact. Do not create a reset framework, new range ledger, persisted parser snapshot, or wider renderer recreation path. Keep the browser fixture local to its spec. Run the Step 2 focused cloud commands again after the refactor and require the same selected passing counts, including four actual browser tests.

- [ ] **Step 6: Run impacted-test verification**

The changed component and serial queue serve all terminal modes and both negotiated and legacy restores, so the impacted set includes whole component lifecycle coverage, write scopes, strict sequencing/checkpoint modules, parser filters, scroll input, the actual Rust paced protocol, and the real browser replay/lifecycle donors. This shared terminal behavior also requires the final full suite after task review; the coordinator runs that logical gate once, as recorded below, with the three already-proven baseline failures excluded by exact title. Implementers/fixers run the focused commands in this step and do not repeat the coordinator broad gate. Do not add `skip` markers, remove tests, or alter baseline expectations.

Run:

```bash
pnpm run typecheck:client
GCLOUD_ROBOT_REQUIRE=1 pnpm run test:cloud --config=default test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TerminalView.scroll-input-policy.test.tsx test/unit/client/components/terminal/terminal-write-queue.test.ts test/unit/client/lib/paced-replay-consumption.test.ts test/unit/client/lib/terminal-recovery-accounting.test.ts test/unit/client/lib/terminal-attach-seq-state.test.ts test/unit/client/lib/terminal-surface-checkpoint.test.ts test/unit/client/lib/terminal-output-write-scope.test.ts test/unit/client/lib/terminal-output-side-effects.test.ts test/unit/client/lib/terminal-startup-probes.test.ts test/unit/client/lib/terminal-osc52.test.ts test/unit/client/lib/turn-complete-signal.test.ts test/unit/shared/turn-complete-signal.test.ts test/e2e/terminal-osc52-policy-flow.test.tsx
pnpm run test:integration --test paced_replay
GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e --project=chromium test/e2e-browser/specs/terminal-replay-credit-rust.spec.ts test/e2e-browser/specs/paced-restore-convergence-rust.spec.ts test/e2e-browser/specs/opencode-replay-write-progression.spec.ts test/e2e-browser/specs/reconnection.spec.ts
```

Expected: typecheck and every included test pass. The Rust command runs the real `crates/freshell-ws/tests/paced_replay.rs` target, including partial-page credit gating, input during replay, stale generations, and disconnect. The cloud browser output must show the new file's four tests and positive matching counts for each selected donor; inspect cloud skips and titles before interpreting coverage. If an existing donor is cloud-ineligible, select its eligible behavioral subset or add the missing behavior to the new eligible spec; a skipped donor is not evidence. No configured lane may silently switch to local.


- [ ] **Step 7: Commit the task**

```bash
git add src/components/TerminalView.tsx src/components/terminal/terminal-write-queue.ts test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/terminal/terminal-write-queue.test.ts test/e2e-browser/specs/terminal-replay-credit-rust.spec.ts
git commit -m "fix: acknowledge ordered terminal replay consumption"
```

Expected: a focused repair commit with these files and a clean feature worktree. The external reports are outside the worktree and remain untracked by this branch. The coordinator then performs specification-plus-quality review for the single repair task, resolves findings according to the scope rule, and completes the authorized PR/check/merge process in `the-usual`. Follow `AGENTS.md` for updating local main by fast-forward only and worktree cleanup after integration. Never deploy or restart the live self-hosted service as part of landing.

## Coordinator Final Suite Gate

After Task 1's focused verification, commit, specification-plus-quality review, and any required repairs, the task coordinator owns the **one required final broad full-suite gate**. Implementers and fixers do not duplicate it. The shared terminal/queue lifecycle changes justify this full regression gate in addition to focused and actual browser/Rust evidence.

Run from the reviewed feature worktree:

```bash
GCLOUD_ROBOT_REQUIRE=1 FRESHELL_TEST_SUMMARY=terminal-replay-credit-repair pnpm run test --testNamePattern='^(?!.*(?:keeps the free-tier model banner part of readiness and handles ANSI styling|keeps every manifest-owned file visible through both ignore filters|requires executable runtime evidence to be fully Rust-only)).*$'
```

Expected: every included phase/test passes on its configured backend, with exactly the accepted baseline title exclusions below. Record phase/test counts, backend, reviewed commit, and the evidence receipt in the external run reports. Required PR checks still run through the authorized integration workflow; this logical gate does not waive them.

This command keeps the full-suite coordinator gate and configured cloud default lane because `--testNamePattern` is an option value, not a path selector. Source-runtime and Cargo keep their existing local phases. It excludes only these accepted pre-existing titles, which were observed in the clean base command `GCLOUD_ROBOT_REQUIRE=1 FRESHELL_TEST_SUMMARY=terminal-replay-credit-base scripts/base-gate.sh test`:

1. `test/unit/tooling/testing/opencode-native-history.test.ts` → `keeps the free-tier model banner part of readiness and handles ANSI styling` (free-tier readiness).
2. `test/unit/tooling/distribution-runtime.test.ts` → `keeps every manifest-owned file visible through both ignore filters` (`installers/systemd/freshell-supervisor.service` hidden).
3. `test/unit/architecture/rust-only-server-runtime.test.ts` → `requires executable runtime evidence to be fully Rust-only` (stale `service-systemd-supervisor` manifest row).

Store commands, exact counts, backend identity, and the comparison with those baseline failures in the external execution report. Report the included suite as passing with these three baseline exclusions; do not claim the unfiltered baseline is green. If a new failure appears, investigate and resolve it within this repair's scope or send the coordinator a substantiated disposition; do not classify it as pre-existing without evidence.


## Verification and Scope Map

| Requirement | Observable evidence |
| --- | --- |
| Codex pane finishes rendering | Codex single/batch/barrier component paths preserve SGR/OSC across replay pages and final replay-to-live; four actual browser/Rust tests show generated credit, real continuation, and recovering completion. |
| Scrolling and typing respond | Actual browser viewport changes after a wheel event and a real PTY emits an echo marker that typed command text cannot satisfy. |
| Tab switching | Browser holds the incident-shaped replay boundary, switches away/reveals, and then completes the same terminal without duplication. |
| Reconnecting | Browser disconnects after mixed-prefix success; guarded mounted CAN/RIS/cursor-visible reconstruction precedes `sinceSeq: 0`/`surfaceReset` full hydrate, and markers render once. Component tests reject old checkpoint/explicit delta and old tagged/untagged traffic. |
| Refreshing | Browser reload starts a new surface and real retained replay reproduces all markers once. Component supersession protects refresh before/after an in-flight callback. |
| Stale/failure/checkpoint safety | Held callbacks, local ticket success/failure/abandonment, pre-preprocessing old-message rejection, post-hook baseline order, mode/empty projection, pending generation/loss controls, and strict/coverage integrity. |
| Fresh output versus progressless recovery | Real component keyless reconnects stay available after newer successful mixed/live output despite pinned safe coverage; repeated history/empty attaches exhaust normally. Local reset/mode traffic cannot refund attempts. |
| Red/green/refactor and integration coverage | Step 2 RED; Step 4 GREEN; Step 5 cleanup/rerun; Step 6 focused typecheck/cloud/Rust/browser; coordinator final full suite once after task review. |
| Dedicated branch, preserved work, focused commits | Existing worktree/base, explicit add list, local repair commit, authorized PR to main after review. |
| Baseline failures remain recorded | Exact three-title final-suite exclusions plus retained clean-base log; no unrelated baseline fixes. |
| No live service mutation/secrets/process interference | Only owned test fixtures and ports; no source service operations or credential retrieval. OneCLI remains mandatory if a later authorized operation truly requires secrets. |

## Planning Self-review

The complete dispatcher-authored User Request appears once and unchanged, and Task 1 remains the single complete repair. All planner-owned fields reconcile the accepted LBF-1/LBF-2/LBF-3 corrections with the selected LBF-4 mounted mechanism and all its mandatory integration conditions. Original clean-base/historical receipts remain outside the branch unchanged.

The earlier falsified component reconstruction/completion drafts have been removed in favor of precise decisions and intended behavior. The only newly selected control bytes are the validator-executed `\x18\x1bc\x1b[?25h`, cited to `reports/load-bearing-validator-lbf-4.md`; no fresh unexecuted component replacement code has entered this correction. Retained initial test/fixture drafts are pre-implementation history and do not assert that the source already implements these decisions.

Self-review covered: independent successful-output recovery progress; final target-1/live-seq-2 SGR/OSC and known-probe/generation controls; genuine reset success; old tagged/untagged ready/output/gap/mode rejection before preprocessing; every reset hook before freshness/attach; same surface/terminal/queue/connection ownership; old-state retirement before any new preprocessing; no local control stream/recovery credit; exact supported/omitted/empty mode behavior; four actual browser/Rust tests with consistent expected counts; configured cloud commands; and coordinator ownership of the single final broad gate after review.

The amendment artifact audit confirmed exact User Request equality, one task with Steps 1–7, no prohibited placeholders, all four retained non-shell code blocks drawn unchanged from the original plan, no component implementation block in Step 3, one coordinator broad-gate command, and 26 existing production/test/fixture paths. The new browser file is explicitly declared for creation. `git diff --check` passed. These are planning checks; implementation and test execution remain pending.

Pure/component doubles isolate callbacks and ownership. Actual owned Rust PTYs, actual browser wire routing, real xterm duplicate/content and scrolling/typing assertions, and meaningful emulator/mode behavior protect the user-visible outcome. No fake provider, fabricated output/credit, new dependency, persisted parser snapshot, production restart, unrelated baseline fix, or coverage weakening is planned.

During execution the source supersedes plan code drafts; do not backport source/review repairs into the plan. The User Request, Goal, Architecture, Global Constraints, and task intent remain authoritative.
