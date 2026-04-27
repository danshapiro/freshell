# Codex Session Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Codex panes stay useful when the Codex app-server, remote TUI transport, or worker PTY fails by automatically replacing the full disposable worker bundle around the durable session identity without prompting the user.

**Architecture:** Treat the Freshell terminal record, pane binding, scrollback, clients, and durable session binding as stable state. Treat the Codex app-server process, app-server client socket, sidecar, rollout tracker, generated MCP config, and remote TUI PTY as one disposable worker bundle that is always replaced as a unit after spontaneous failure. Recovery readiness must be proven by current-generation provider-owned lifecycle evidence for the expected durable session; provider lifecycle-loss evidence, when the real app-server emits it, must trigger the same bundle replacement path.

**Tech Stack:** Node 22, TypeScript ESM/NodeNext, Express/WebSocket `ws`, `node-pty`, React 18, Redux Toolkit, Zod, Vitest, Testing Library, existing Freshell coordinated test scripts.

---

## Plan Verdict

Build the supervisor architecture directly. Do not first add a narrow restart-on-sidecar-exit patch.

The important product guarantee is not "the upstream WebSocket never fails." The guarantee is:

> A Codex pane with a known durable session ID does not become useless when a disposable Codex worker fails. Freshell preserves the terminal ID, clients, scrollback, and durable binding, automatically replaces the whole worker bundle, resumes the durable session, and returns the pane to interactivity without prompting.

The honest boundary is:

> If failure happens before Freshell has any durable session identity, Freshell retries the original fresh launch automatically and keeps the pane alive. If retry budget is exhausted before any durable identity exists, Freshell enters a clear `recovery_failed` state. It must not silently claim continuity with an unrelated new durable session.

There is one narrower startup boundary:

> If the very first Codex app-server launch fails before `TerminalRegistry.create()` can create a terminal record, there is not yet a stable `terminalId` to recover in place. `ws-handler` and `agent-api/router` must still retry the initial launch automatically with the same bounded policy before returning a create error. Once `terminal.created` has been sent, all later pre-durable failures use the registry recovery path and can enter `recovery_failed` without losing the terminal ID.

The recovery action is intentionally singular:

> Any spontaneous Codex worker failure retires the current bundle and creates a new bundle. Detection sources can differ, but the repair primitive never branches into "reuse this sidecar" or "reuse this PTY."

Provider contract note: the current Codex app-server README documents `thread/closed` after delayed idle unload for `thread/unsubscribe`, not as an immediate consequence of closing a remote TUI socket. See https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#example-unsubscribe-from-a-loaded-thread. The implementation may handle provider lifecycle-loss notifications when they arrive, but must not depend on an immediate `thread/closed` signal for the known transport/backpressure recovery path.

## User-Visible Behavior

- Existing Codex panes remain mounted through recovery.
- The `terminalId` seen by the client stays stable.
- Scrollback stays visible and replacement worker output appends to the same stream.
- No `terminal.exit` is sent for recoverable Codex worker failures.
- The user is not prompted. Recovery starts automatically.
- Input typed during recovery is not written to a dead PTY. Freshell buffers a small bounded amount and flushes it only after readiness proof.
- If the input buffer overflows or expires, Freshell writes a short local terminal message explaining that input was not sent. It must not make the WebSocket layer send `INVALID_TERMINAL_ID`, because the current client treats that error as proof that the terminal is gone.
- If retry budget is exhausted, the pane stays alive in `recovery_failed` with the durable binding preserved if known. The user can still close the pane through Freshell controls.
- If the initial app-server launch fails before a terminal record exists, terminal creation is retried automatically before any error is shown. Exhaustion may return the existing create error because no `terminalId` exists yet; this is not a recoverable session loss.
- Explicit Freshell close/remove/kill remains final and still emits `terminal.exit`.
- For durable Codex sessions, an in-TUI quit or transport fatal that exits the PTY is treated as a spontaneous worker failure, not as final user close. The product contract is that final close is expressed through Freshell controls.
- Do not emit `terminal.status` with `status: 'exited'`. Final exit remains represented only by `terminal.exit`, so clients have one unambiguous final-clear signal.

## Contracts And Invariants

Stable state:

- `terminalId`
- pane/tab binding
- attached WebSocket clients and terminal stream broker state
- scrollback ring buffer and replay sequence
- durable Codex session binding once known
- cwd, rows, cols, env context, and provider launch settings needed for replacement
- user-facing terminal metadata

Disposable worker bundle:

- `CodexTerminalSidecar`
- `CodexAppServerRuntime`
- app-server process and loopback port
- app-server JSON-RPC client socket
- rollout tracker and app-server watches
- generated MCP config for this generation
- remote TUI PTY process
- generation-scoped callbacks and timers

Invariants:

- `terminal.exit` is emitted only for explicit Freshell final close, non-Codex terminal exit, or shutdown cleanup that has already marked the terminal final.
- `terminal.exit` is never emitted by Codex spontaneous worker failure, recovery retire cleanup, stale-generation callback, retry exhaustion, or `recovery_failed`.
- Durable session binding is monotonic for a terminal until explicit Freshell final close. Stale generations cannot bind or unbind it.
- Durable-session promotion callbacks cannot make a recovering terminal running or flush input before replacement worker publication and readiness consumption.
- Worker generations are monotonically allocated and never reused, including failed candidates that were never published as `workerGeneration`. Late callbacks from failed unpublished candidates must remain stale forever.
- A Codex terminal created from an explicit durable `sessionRef` starts as durable immediately; it must initialize `codex.durableSessionId` from the normalized resume binding, not wait for a later sidecar promotion callback.
- Every disposable callback carries or closes over a worker generation. Stale or retiring generations cannot mutate stable terminal state.
- Active-candidate disposable callbacks also carry or close over a replacement attempt ID. Candidate callbacks are accepted only while the active replacement attempt ID still matches; generation alone is not enough before publication.
- Retiring a bundle marks the generation `retiring` before cleanup starts. Any PTY exit, app-server child exit, client disconnect, sidecar fatal, watcher callback, rollout callback, metadata cleanup callback, or timer callback from that generation is cleanup, not a fresh failure.
- PTY data callbacks are generation-scoped too. Output from stale or retiring generations must not mutate the stable buffer, broker replay ring, pre-attach startup probe state, perf counters, status, or remote-TUI failure detector after the generation has been retired. The only output allowed after retirement is explicit Freshell-local recovery diagnostic output.
- Recovery readiness for durable sessions requires current-generation provider evidence naming the expected durable session ID after replacement launch, normally `thread/started` for that session observed by the current sidecar client after the replacement remote TUI resumes it. Existing rollout files, CLI command arguments, process start, first PTY output, and old-generation notifications are insufficient.
- Readiness evidence observed by an active candidate generation before the replacement worker is fully installed is not readiness yet. It must be latched on the active replacement attempt and consumed only after the candidate sidecar, PTY, handlers, latest dimensions, generation-scoped metadata, and `workerGeneration` publication are complete. Until that publication point, Freshell must not set `running_durable`, emit running status, or flush buffered input.
- Current-generation provider lifecycle-loss evidence for the expected durable session, such as `thread/closed` or `thread/status/changed` with `status.type: 'notLoaded' | 'systemError'`, is a spontaneous worker failure even if the PTY process remains alive.
- Do not invent fake-only liveness notifications. Any provider lifecycle-loss trigger used to claim immediate liveness detection must be backed by a real-provider contract test. Documented provider lifecycle-loss notifications may still be parsed and handled when they arrive. If the real app-server only emits a lifecycle-loss notification after delayed idle unload, treat that notification as a valid late failure signal, but do not make immediate recovery depend on it.
- The remote TUI fatal-output detector and app-server client disconnect handling are the immediate transport-loss detectors for the known queue/backpressure failure mode. Provider lifecycle-loss evidence is an additional real signal, not the sole way to notice transport loss.
- If the real provider cannot produce the readiness evidence, do not implement a weaker fallback. The terminal must remain recovering through bounded retry attempts and become `recovery_failed` only when the retry budget is exhausted; silently declaring success would violate the user requirement.
- Pre-durable recovery never guesses a durable session ID and never resumes by title.
- Recovery attempts are bounded per recovery episode and reset only after a stable running window. Time passing while the terminal remains in `recovering_*` must never replenish attempts.
- Idle kill treats `recovering_pre_durable`, `recovering_durable`, and `recovery_failed` as protected states.
- At most one bundle replacement attempt is active for a terminal. Additional failure signals from the current or retiring generation are coalesced into the active attempt or ignored as cleanup; they do not start parallel replacement bundles or consume extra retry budget.
- A replacement launch failure, sidecar readiness failure, PTY spawn failure, or readiness timeout is one failed recovery attempt. Freshell schedules the next whole-bundle replacement attempt with the same recovery policy until the budget is exhausted; it never leaves the terminal permanently stuck in `recovering_*` without a live attempt or timer.
- Replacement attempts have explicit attempt state separate from "the current live worker generation." A failed launch or spawn before a replacement PTY is installed must not leave `workerGeneration`, `record.pty`, `record.codexSidecar`, `mcpCwd`, or readiness timers pointing at a half-created bundle as if it were live.
- Explicit final close during recovery cancels and invalidates all recovery state before signaling workers: backoff timers, readiness timers, input buffers, active replacement attempts, and in-flight async launch/spawn continuations. If an in-flight launch later resolves after final close, Freshell must shut down any candidate sidecar and clean up candidate resources without installing them or emitting recovery status.
- Resize during recovery updates stable terminal dimensions and does not fail attach merely because the disposable PTY is unavailable. The next replacement PTY is spawned and resized with the latest known `cols` and `rows`.
- Local recovery messages are appended through the same terminal output path as PTY output, including `terminal.output.raw`, so attached clients, broker replay state, and later attaches all see the same diagnostic text.
- A detached Codex terminal that replaces its worker bundle gets a fresh current-generation pre-attach startup probe state so startup prompts from the replacement remote TUI can still be answered. Startup probe replies must write only to the current generation's PTY.
- `shutdown()` and `shutdownGracefully()` are explicit final-close paths. They must mark running Codex generations as `user_final_close` or equivalent before signaling PTYs so shutdown cannot start recovery loops.

## File Structure

Create:

- `server/coding-cli/codex-app-server/recovery-policy.ts`
  - Pure recovery state, retry budget, backoff, input buffer policy, close reasons, and generation helper types.
- `server/coding-cli/codex-app-server/remote-tui-failure-detector.ts`
  - Small explicit rolling detector for Codex remote TUI fatal output chunks that mean the PTY is alive but not useful.
- `test/unit/server/terminal-registry.codex-recovery.test.ts`
  - Unit-level registry/supervisor tests with mocked `node-pty`, fake sidecars, fake launch factory, status events, stale callbacks, input buffering, and idle-kill coverage.
- `test/e2e/codex-session-resilience-flow.test.tsx`
  - Client flow test proving recovery status does not clear a mounted pane and recovery_failed keeps the terminal ID.
- `test/integration/real/codex-app-server-readiness-contract.test.ts`
  - Gated real-provider contract test, enabled only by `FRESHELL_REAL_PROVIDER_CONTRACTS=1`, proving the installed Codex app-server emits current-generation thread lifecycle evidence on durable resume.

Modify:

- `server/coding-cli/codex-app-server/protocol.ts`
  - Parse provider thread lifecycle notifications used for durable readiness and lifecycle-loss detection: `thread/started`, `thread/closed`, and `thread/status/changed`.
- `server/coding-cli/codex-app-server/client.ts`
  - Add disconnect/error handlers and expose thread lifecycle notifications as structured callbacks.
- `server/coding-cli/codex-app-server/runtime.ts`
  - Preserve bounded child stdout/stderr diagnostics, report child exit code/signal/PID/port, and surface app-server client disconnect as a worker failure.
- `server/coding-cli/codex-app-server/sidecar.ts`
  - Forward lifecycle evidence and worker failures to attached terminal callbacks. Keep shutdown cleanup non-fatal.
- `server/coding-cli/codex-app-server/launch-planner.ts`
  - Export a reusable Codex launch factory type, preserve enough inputs for replacement bundles, and own cleanup for sidecars created by failed `planCreate()` attempts.
- `server/terminal-registry.ts`
  - Extract reusable spawn/install/retire helpers, add Codex worker generation and recovery state, replace `onFatal -> kill()` with bundle replacement, gate input during recovery, emit terminal status updates, and protect recovery states from idle kill.
- `server/ws-handler.ts`
  - Retry initial Codex launch planning before `terminal.created`, pass a Codex launch factory into registry-created Codex terminals, and broadcast `terminal.status`.
- `server/agent-api/router.ts`
  - Retry initial Codex launch planning before terminal creation and pass the same launch factory into API-created Codex terminals so automation-created panes recover identically.
- `shared/ws-protocol.ts`
  - Add `TerminalStatusMessage` and optional terminal inventory runtime status.
- `src/store/types.ts`
  - Extend `TerminalStatus` with `recovering` and `recovery_failed`, and add optional runtime status to background terminal inventory types.
- `src/store/paneTypes.ts`
  - No structural redesign; it automatically consumes the extended `TerminalStatus`.
- `src/lib/terminal-status-indicator.ts`
  - Map `recovering` and `recovery_failed` to distinct accessible status styling.
- `src/components/TerminalView.tsx`
  - Handle `terminal.status` without clearing `terminalId`; keep `terminal.exit` final.
- `docs/index.html`
  - Update the mock default experience if recovery status becomes visible in pane chrome or terminal status indicators.
- `test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs`
  - Broadcast lifecycle notifications for `thread/resume`, support client-socket close, app-server process exit, provider-shaped `thread/closed` and `thread/status/changed` lifecycle-loss notifications, and duplicate-active-thread assertions.
- Existing tests:
  - `test/unit/server/coding-cli/codex-app-server/client.test.ts`
  - `test/unit/server/coding-cli/codex-app-server/runtime.test.ts`
  - `test/unit/server/coding-cli/codex-app-server/sidecar.test.ts`
  - `test/integration/server/codex-session-flow.test.ts`
  - `test/unit/client/components/TerminalView.lifecycle.test.tsx`
  - `test/unit/client/components/TerminalView.resumeSession.test.tsx`

Review:

- `server/terminal-stream/broker.ts`
  - No code change is expected if recovery local messages are emitted through `terminal.output.raw` and recovery never emits `terminal.exit`.

## State Model

Keep `TerminalRecord.status` as `'running' | 'exited'` to preserve the existing public "exists or final" contract. Add Codex-specific runtime state:

```ts
export type CodexRecoveryState =
  | 'starting'
  | 'running_live_only'
  | 'running_durable'
  | 'recovering_pre_durable'
  | 'recovering_durable'
  | 'recovery_failed'

export type CodexWorkerCloseReason =
  | 'spontaneous_worker_failure'
  | 'recovery_retire'
  | 'user_final_close'

export type CodexWorkerFailureSource =
  | 'pty_exit'
  | 'sidecar_fatal'
  | 'app_server_exit'
  | 'app_server_client_disconnect'
  | 'remote_tui_fatal_output'
  | 'provider_thread_lifecycle_loss'
  | 'readiness_timeout'
  | 'replacement_launch_failure'
  | 'replacement_spawn_failure'
```

Public messages:

```ts
export type TerminalStatusMessage = {
  type: 'terminal.status'
  terminalId: string
  status: 'running' | 'recovering' | 'recovery_failed'
  reason?: string
  attempt?: number
}
```

Inventory keeps existing `status: 'running' | 'exited'` and adds optional `runtimeStatus?: 'running' | 'recovering' | 'recovery_failed'` so old clients do not interpret recovery as terminal death.

## Retry And Input Policy

Retry policy:

- Attempt 1 immediately.
- Backoff attempts after that: 250 ms, 1 s, 2 s, 5 s.
- Maximum 5 failed attempts per recovery episode per terminal. A recovery episode starts when the terminal enters `recovering_pre_durable` or `recovering_durable` and ends only after explicit final close or after the terminal has returned to `running_live_only` / `running_durable` for the stable reset window.
- Initial Codex launch planning before `terminal.created` uses the same delay sequence and maximum attempt count before returning a create error.
- Reset the budget after 10 minutes in `running_durable` or `running_live_only` without worker failure.
- Durable recovery exhaustion enters `recovery_failed` and preserves durable binding.
- Pre-durable recovery exhaustion enters `recovery_failed` and leaves the pane alive without inventing a session.
- A replacement attempt includes launch planning, sidecar readiness, PTY spawn, handler installation, and readiness proof. Failure at any point in that sequence, including readiness timeout, consumes exactly one attempt and schedules the next attempt through the same backoff policy unless the retry budget is exhausted. Attempts do not age out while recovery is ongoing; exhaustion is deterministic even if individual attempts are slow.
- While a replacement attempt or backoff timer is active, later failure signals for the same terminal are logged with their source and generation but do not start additional concurrent replacement attempts.

Input policy:

- While `recovering_*`, buffer at most 8 KiB for at most 10 seconds.
- Flush only after current-generation readiness proof.
- If buffering overflows or expires, append one local message to the terminal buffer and send it to attached clients:

```text

[Freshell] Codex is reconnecting; input was not sent because recovery is still in progress.
```

- While `recovery_failed`, do not accept input into the dead worker. Append one local message and treat the input request as handled so the client does not enter the existing `INVALID_TERMINAL_ID` reconnect path:

```text

[Freshell] Codex recovery failed. Close this pane or refresh after checking the server logs.
```

## Task 1: Lock Provider Lifecycle And Disconnect Contracts

**Files:**
- Modify: `server/coding-cli/codex-app-server/protocol.ts`
- Modify: `server/coding-cli/codex-app-server/client.ts`
- Modify: `server/coding-cli/codex-app-server/runtime.ts`
- Modify: `server/coding-cli/codex-app-server/sidecar.ts`
- Modify: `test/unit/server/coding-cli/codex-app-server/client.test.ts`
- Modify: `test/unit/server/coding-cli/codex-app-server/runtime.test.ts`
- Modify: `test/unit/server/coding-cli/codex-app-server/sidecar.test.ts`
- Modify: `test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs`
- Create: `test/integration/real/codex-app-server-readiness-contract.test.ts`

- [ ] **Step 1: Add failing client tests for lifecycle and disconnect**

Add tests to `test/unit/server/coding-cli/codex-app-server/client.test.ts`:

```ts
it('emits thread lifecycle notifications from app-server notifications', async () => {
  const lifecycle = vi.fn()
  const client = createConnectedClient()
  client.onThreadLifecycle(lifecycle)

  fakeServer.broadcast({
    jsonrpc: '2.0',
    method: 'thread/started',
    params: {
      thread: {
        id: 'thread-resume-1',
        path: '/tmp/codex/rollout-thread-resume-1.jsonl',
        ephemeral: false,
      },
    },
  })

  await waitFor(() => expect(lifecycle).toHaveBeenCalledWith({
    kind: 'thread_started',
    thread: {
      id: 'thread-resume-1',
      path: '/tmp/codex/rollout-thread-resume-1.jsonl',
      ephemeral: false,
    },
  }))
})

it('emits thread closed lifecycle notifications from app-server notifications', async () => {
  const lifecycle = vi.fn()
  const client = createConnectedClient()
  client.onThreadLifecycle(lifecycle)

  fakeServer.broadcast({
    jsonrpc: '2.0',
    method: 'thread/closed',
    params: {
      threadId: 'thread-resume-1',
    },
  })

  await waitFor(() => expect(lifecycle).toHaveBeenCalledWith({
    kind: 'thread_closed',
    threadId: 'thread-resume-1',
  }))
})

it('emits thread status lifecycle notifications from app-server notifications', async () => {
  const lifecycle = vi.fn()
  const client = createConnectedClient()
  client.onThreadLifecycle(lifecycle)

  fakeServer.broadcast({
    jsonrpc: '2.0',
    method: 'thread/status/changed',
    params: {
      threadId: 'thread-resume-1',
      status: { type: 'notLoaded' },
    },
  })

  await waitFor(() => expect(lifecycle).toHaveBeenCalledWith({
    kind: 'thread_status_changed',
    threadId: 'thread-resume-1',
    status: { type: 'notLoaded' },
  }))
})

it('emits a disconnect callback when the app-server client socket closes unexpectedly', async () => {
  const onDisconnect = vi.fn()
  const client = createConnectedClient()
  client.onDisconnect(onDisconnect)

  fakeServer.closeClientSocket()

  await waitFor(() => expect(onDisconnect).toHaveBeenCalledWith(expect.objectContaining({
    reason: 'close',
  })))
})
```

Expected: these tests fail because `CodexAppServerClient` has only `onThreadStarted` and has no unified `onThreadLifecycle`, `thread/closed` or `thread/status/changed` parsing, or `onDisconnect`.

- [ ] **Step 2: Add failing runtime and sidecar tests**

Add tests:

```ts
it('notifies runtime exit handlers when the app-server client socket disconnects while the child is alive', async () => {
  const runtime = createRuntime({
    env: {
      FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({
        closeSocketAfterMethodsOnce: ['initialize'],
      }),
    },
  })
  const onExit = vi.fn()
  runtime.onExit(onExit)

  await runtime.ensureReady()
  await waitFor(() => expect(onExit).toHaveBeenCalledWith(expect.any(Error)))
})

it('forwards current thread lifecycle evidence to the attached terminal', () => {
  const onThreadLifecycle = vi.fn()
  const sidecar = createSidecarWithFakeRuntime()
  sidecar.attachTerminal({
    terminalId: 'term-1',
    onDurableSession: vi.fn(),
    onThreadLifecycle,
    onFatal: vi.fn(),
  })

  fakeRuntime.emitThreadStarted({ id: 'thread-1', path: '/tmp/rollout.jsonl', ephemeral: false })

  expect(onThreadLifecycle).toHaveBeenCalledWith({
    kind: 'thread_started',
    thread: expect.objectContaining({ id: 'thread-1' }),
  })
})

it('replays lifecycle evidence observed before terminal attachment', () => {
  const onThreadLifecycle = vi.fn()
  const sidecar = createSidecarWithFakeRuntime()

  fakeRuntime.emitThreadStarted({ id: 'thread-1', path: '/tmp/rollout.jsonl', ephemeral: false })

  sidecar.attachTerminal({
    terminalId: 'term-1',
    onDurableSession: vi.fn(),
    onThreadLifecycle,
    onFatal: vi.fn(),
  })

  expect(onThreadLifecycle).toHaveBeenCalledWith({
    kind: 'thread_started',
    thread: expect.objectContaining({ id: 'thread-1' }),
  })
})
```

Expected: fail at compile/type level until sidecar attachment grows `onThreadLifecycle`. The replay test is required because a replacement PTY can resume fast enough that the app-server emits `thread/started` before the registry has finished installing all replacement handlers. Do not assert that `ensureReady()` rejects for an after-`initialize` socket close; the fake sends the initialize response before closing, so readiness can resolve before disconnect handling fires.

- [ ] **Step 3: Implement protocol parsing and client callbacks**

In `protocol.ts`, add:

```ts
export const CodexThreadStartedLifecycleNotificationSchema = z.object({
  method: z.literal('thread/started'),
  params: z.object({
    thread: CodexThreadSchema,
  }).passthrough(),
}).passthrough()

export const CodexThreadClosedNotificationSchema = z.object({
  method: z.literal('thread/closed'),
  params: z.object({
    threadId: z.string().min(1),
  }).passthrough(),
}).passthrough()

export const CodexThreadStatusChangedNotificationSchema = z.object({
  method: z.literal('thread/status/changed'),
  params: z.object({
    threadId: z.string().min(1),
    status: z.object({
      type: z.string().min(1),
    }).passthrough(),
  }).passthrough(),
}).passthrough()

export const CodexThreadLifecycleNotificationSchema = z.union([
  CodexThreadStartedLifecycleNotificationSchema,
  CodexThreadClosedNotificationSchema,
  CodexThreadStatusChangedNotificationSchema,
])

export type CodexThreadLifecycleNotification = z.infer<typeof CodexThreadLifecycleNotificationSchema>
```

In `client.ts`, add callback sets:

```ts
type CodexThreadLifecycleEvent = {
  kind: 'thread_started'
  thread: CodexThreadHandle
} | {
  kind: 'thread_closed'
  threadId: string
} | {
  kind: 'thread_status_changed'
  threadId: string
  status: { type: string } & Record<string, unknown>
}

type CodexAppServerDisconnectEvent = {
  reason: 'close' | 'error'
  error?: Error
}
```

Expose:

```ts
onThreadLifecycle(handler: (event: CodexThreadLifecycleEvent) => void): () => void
onDisconnect(handler: (event: CodexAppServerDisconnectEvent) => void): () => void
```

In `installSocketHandlers`, distinguish close from error and call disconnect handlers after rejecting pending requests.

- [ ] **Step 4: Implement runtime and sidecar forwarding**

In `runtime.ts`, subscribe to `client.onDisconnect`. If the disconnect is not caused by `runtime.shutdown()` or startup cleanup, clear runtime state and notify `exitHandlers` with a detailed error.

In `sidecar.ts`, update `CodexTerminalAttachment`:

```ts
type CodexTerminalAttachment = {
  terminalId: string
  onDurableSession: (sessionId: string) => void
  onThreadLifecycle: (event: CodexThreadLifecycleEvent) => void
  onFatal: (error: Error) => void
}
```

`noteThreadStarted()` should both track durable rollout and forward lifecycle evidence to the attached terminal, unless shutting down. The registry must treat the durable-session callback as identity evidence only; it must not use that callback to bypass candidate readiness latching or mark a recovering terminal running before worker publication. `noteThreadClosed()` and `noteThreadStatusChanged()` should forward lifecycle-loss evidence for the attached terminal unless shutting down.

The sidecar must retain a bounded last-lifecycle-event queue while no terminal is attached and replay those events synchronously from `attachTerminal()` before returning. This prevents a fast replacement TUI from producing the readiness `thread/started` event before registry recovery handlers are installed. Keep the replay queue small, for example the last 10 lifecycle events, and clear it on shutdown.

- [ ] **Step 5: Make the fake app-server prove resume attachment**

Update `test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs` so `thread/resume` broadcasts the same `thread/started` notification as `thread/start`. Add behavior switches:

```js
threadClosedAfterMethodsOnce: ['thread/resume'],
threadStatusChangedAfterMethodsOnce: {
  'thread/resume': [{ threadId: 'thread-resume-1', status: { type: 'notLoaded' } }],
},
assertNoDuplicateActiveThread: true,
appendThreadOperationLogPath: '/tmp/thread-ops.jsonl',
```

`threadClosedAfterMethodsOnce` should broadcast the real provider-shaped `thread/closed` notification with the affected thread ID. The duplicate assertion should track active thread IDs per process and send an error if a new `thread/start` happens while recovery was supposed to `thread/resume` the durable ID.

Add `threadStatusChangedAfterMethodsOnce` with provider-shaped `thread/status/changed` payloads so tests can cover `notLoaded` and `systemError` lifecycle-loss evidence without pretending the real app-server emits immediate `thread/closed` on every socket disconnect.

- [ ] **Step 6: Add the gated real-provider readiness contract**

Create `test/integration/real/codex-app-server-readiness-contract.test.ts`. It must skip unless `FRESHELL_REAL_PROVIDER_CONTRACTS=1`.

The readiness test should:

1. Start `CodexAppServerRuntime` with the installed `codex`.
2. Create or identify a durable test thread through the app-server.
3. Create two app-server clients against the same current-generation `wsUrl`: an observer client representing Freshell's sidecar and an actor client representing the remote TUI.
4. Subscribe the observer client to lifecycle notifications.
5. Resume that exact thread through the actor client.
6. Assert the observer receives a current notification naming the expected thread ID after the actor resume call.

Add a second provider lifecycle-loss contract only for a real provider signal that can be produced reliably without waiting for the normal idle-unload timeout documented by Codex app-server:

1. Use the same observer plus actor setup.
2. Resume the exact durable thread through the actor client.
3. Trigger a documented immediate lifecycle-loss condition, if one exists, such as explicit thread close, archive/unload, or a status transition to `notLoaded` or `systemError`.
4. Assert the observer receives current-generation provider lifecycle-loss evidence for that same thread, such as `thread/closed` or `thread/status/changed`.

Do not use "close the actor socket" or `thread/unsubscribe` as the liveness-loss proof unless the installed app-server actually emits a prompt lifecycle-loss event in that scenario. The current Codex app-server README documents `thread/closed` after delayed idle unload for unsubscribe, so a contract test that simply closes/unsubscribes the actor and waits for immediate `thread/closed` is invalid.

If readiness cannot be made reliable, stop implementation and report that the provider readiness contract is unavailable. Do not weaken durable readiness to process start or first output. If immediate provider lifecycle-loss evidence cannot be made reliable, keep production handling for real `thread/closed` / `thread/status/changed` notifications when they arrive, but do not block the rest of the architecture on that optional signal; the immediate known transport-loss paths are app-server client disconnect, runtime exit, PTY exit, and remote TUI fatal output.

- [ ] **Step 7: Verify Task 1**

Run:

```bash
npm run test:vitest -- test/unit/server/coding-cli/codex-app-server/client.test.ts test/unit/server/coding-cli/codex-app-server/runtime.test.ts test/unit/server/coding-cli/codex-app-server/sidecar.test.ts
```

Expected: PASS.

Run the real-provider contract locally when an authenticated installed Codex app-server is available:

```bash
FRESHELL_REAL_PROVIDER_CONTRACTS=1 npm run test:vitest -- test/integration/real/codex-app-server-readiness-contract.test.ts
```

Expected: PASS. If the provider is unavailable in the execution environment, document that it was not run. If it runs and fails because the provider does not emit current-generation readiness evidence, stop and report that durable seamless recovery cannot honestly be guaranteed with the installed provider; do not weaken the production readiness gate.

- [ ] **Step 8: Commit Task 1**

```bash
git add server/coding-cli/codex-app-server test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs test/unit/server/coding-cli/codex-app-server test/integration/real/codex-app-server-readiness-contract.test.ts
git commit -m "test: lock codex app-server lifecycle contract"
```

## Task 2: Retain App-Server Exit Diagnostics

**Files:**
- Modify: `server/coding-cli/codex-app-server/runtime.ts`
- Modify: `test/unit/server/coding-cli/codex-app-server/runtime.test.ts`

- [ ] **Step 1: Write or preserve failing diagnostics tests**

If commit `806a8d7fabc17e4d491e0aa93f9f95f260cb5626` is not already present, port its tests into `runtime.test.ts`:

```ts
it('includes pid, websocket port, exit code, signal, and stderr tail when a child exits unexpectedly', async () => {
  const runtime = createRuntime({
    env: {
      FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({
        stderrBeforeExit: 'queue full diagnostic',
        exitProcessAfterMethodsOnce: ['initialize'],
      }),
    },
  })
  const onExit = vi.fn()
  runtime.onExit(onExit)

  await expect(runtime.ensureReady()).rejects.toThrow()

  const message = String(onExit.mock.calls[0]?.[0]?.message ?? '')
  expect(message).toContain('pid ')
  expect(message).toContain('ws port ')
  expect(message).toContain('exit code ')
  expect(message).toContain('signal ')
  expect(message).toContain('stderr tail')
  expect(message).toContain('queue full diagnostic')
})
```

Expected: fail while stdout/stderr are only drained and discarded.

- [ ] **Step 2: Implement bounded diagnostic tails**

In `runtime.ts`, add a bounded output tail class with 4 KiB / 40 line caps. Replace raw `.resume()` with data listeners that both drain and retain bounded output. Include PID, ws port, exit code, signal, elapsed time, stdout tail, and stderr tail in unexpected exit errors.

Do not retain unbounded child output.

- [ ] **Step 3: Verify Task 2**

Run:

```bash
npm run test:vitest -- test/unit/server/coding-cli/codex-app-server/runtime.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit Task 2**

```bash
git add server/coding-cli/codex-app-server/runtime.ts test/unit/server/coding-cli/codex-app-server/runtime.test.ts
git commit -m "fix: retain codex app-server crash diagnostics"
```

## Task 3: Add Recovery Policy And Failure Detection Units

**Files:**
- Create: `server/coding-cli/codex-app-server/recovery-policy.ts`
- Create: `server/coding-cli/codex-app-server/remote-tui-failure-detector.ts`
- Create: `test/unit/server/coding-cli/codex-app-server/recovery-policy.test.ts`
- Create: `test/unit/server/coding-cli/codex-app-server/remote-tui-failure-detector.test.ts`

- [ ] **Step 1: Write failing recovery policy tests**

Create `recovery-policy.test.ts` with tests for:

- immediate first retry
- backoff sequence `0`, `250`, `1000`, `2000`, `5000`
- exhaustion after 5 failed attempts in one recovery episode
- attempts do not become available merely because more than 2 minutes pass while the terminal stays in recovery
- reset after 10 stable minutes
- `recovery_retire` callbacks do not consume retry budget
- input buffer caps at 8 KiB and 10 seconds

Example:

```ts
it('buffers input during recovery and expires it after the ttl', () => {
  const policy = new CodexRecoveryPolicy({ now: () => now })
  expect(policy.bufferInput('abc')).toEqual({ ok: true })
  now += 10_001
  expect(policy.drainBufferedInput()).toEqual({
    ok: false,
    reason: 'expired',
  })
})
```

Expected: fail because the file does not exist.

- [ ] **Step 2: Write failing fatal-output detector tests**

Create `remote-tui-failure-detector.test.ts`:

```ts
it.each([
  'ERROR: remote app server at `ws://127.0.0.1:34025/` transport failed: WebSocket protocol error: Connection reset without closing handshake',
  'app-server event stream disconnected: channel closed',
  'Failed to attach to resumed app-server thread: thread is not yet available for replay or live attach.',
])('detects known remote TUI fatal output: %s', (line) => {
  expect(detectCodexRemoteTuiFailure(line)).toEqual(expect.objectContaining({
    fatal: true,
  }))
})

it('does not treat ordinary output as fatal', () => {
  expect(detectCodexRemoteTuiFailure('working on it')).toEqual({ fatal: false })
})

it('detects fatal output split across chunks with ANSI control sequences', () => {
  const detector = new CodexRemoteTuiFailureDetector()

  expect(detector.push('\u001b[31mERROR: remote app server at `ws://127.0.0.1:34025/` transport')).toEqual({ fatal: false })
  expect(detector.push(' failed: WebSocket protocol error: Connection reset without closing handshake\u001b[0m\n')).toEqual(expect.objectContaining({
    fatal: true,
  }))
})
```

Expected: fail because the file does not exist.

- [ ] **Step 3: Implement the policy and detector**

Implement small pure modules. Keep detector intentionally narrow. The detector must retain only a bounded rolling tail, strip ANSI before matching, and handle fatal strings split across PTY chunks. Do not add broad substring fallbacks like any line containing `error`.

- [ ] **Step 4: Verify Task 3**

Run:

```bash
npm run test:vitest -- test/unit/server/coding-cli/codex-app-server/recovery-policy.test.ts test/unit/server/coding-cli/codex-app-server/remote-tui-failure-detector.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 3**

```bash
git add server/coding-cli/codex-app-server/recovery-policy.ts server/coding-cli/codex-app-server/remote-tui-failure-detector.ts test/unit/server/coding-cli/codex-app-server/recovery-policy.test.ts test/unit/server/coding-cli/codex-app-server/remote-tui-failure-detector.test.ts
git commit -m "test: define codex recovery policy"
```

## Task 4: Extract Reusable Terminal Worker Launch Helpers

**Files:**
- Modify: `server/terminal-registry.ts`
- Modify: `test/unit/server/terminal-registry.test.ts`

- [ ] **Step 1: Add regression tests before refactor**

Add focused tests to `terminal-registry.test.ts` or `terminal-registry.codex-recovery.test.ts` proving current behavior remains unchanged:

- normal create emits `terminal.created`
- normal PTY exit emits one `terminal.exit`
- explicit `kill()` emits one `terminal.exit`
- `cleanupMcpConfig` receives `record.mcpCwd`
- clients and buffer receive PTY output
- pre-attach Codex startup probes still work

Expected: existing code should pass these tests before refactor. If any fail, fix the test setup, not production behavior.

- [ ] **Step 2: Extract helper types inside `terminal-registry.ts`**

Add:

```ts
type TerminalLaunchSpec = {
  terminalId: string
  mode: TerminalMode
  shell: ShellType
  cwd?: string
  cols: number
  rows: number
  resumeSessionId?: string
  providerSettings?: ProviderSettings
  envContext?: TerminalEnvContext
  baseEnv: Record<string, string>
}

type SpawnedTerminalWorker = {
  pty: pty.IPty
  procCwd?: string
  mcpCwd?: string
}
```

- [ ] **Step 3: Extract spawn and handler methods**

Extract without changing behavior:

```ts
private spawnTerminalWorker(spec: TerminalLaunchSpec): SpawnedTerminalWorker
private installTerminalWorkerHandlers(record: TerminalRecord, generation: number): void
private finalizeTerminalExit(record: TerminalRecord, exitCode: number | undefined, reason: 'pty_exit' | 'user_final_close'): void
```

Initially `generation` can always be `record.workerGeneration` with value `1`. Both `onData` and `onExit` handlers must close over this generation even before recovery behavior is implemented, so the later recovery tasks can guard every PTY callback without moving output logic again.

- [ ] **Step 4: Preserve synchronous `create()`**

Do not make `TerminalRegistry.create()` async. Codex initial app-server planning stays in `WsHandler` and `agent-api/router.ts`; recovery will use a stored async launch factory later.

- [ ] **Step 5: Verify Task 4**

Run:

```bash
npm run test:vitest -- test/unit/server/terminal-registry.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 4**

```bash
git add server/terminal-registry.ts test/unit/server/terminal-registry.test.ts
git commit -m "refactor: extract terminal worker launch helpers"
```

## Task 5: Add Codex Generation State And Final-Close Reasons

**Files:**
- Modify: `server/terminal-registry.ts`
- Create: `test/unit/server/terminal-registry.codex-recovery.test.ts`

- [ ] **Step 1: Add failing generation and close-reason tests**

Create mocked PTY helpers in `terminal-registry.codex-recovery.test.ts`:

```ts
type MockPty = {
  onData: ReturnType<typeof vi.fn>
  onExit: ReturnType<typeof vi.fn>
  write: ReturnType<typeof vi.fn>
  resize: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
  pid: number
}
```

Write tests:

- stale generation PTY exit is ignored
- stale generation PTY data is ignored and does not append to the buffer, broker, perf counters, startup probe state, or remote-TUI fatal detector
- `recovery_retire` PTY exit is ignored
- `recovery_retire` PTY data is ignored after retirement starts
- `user_final_close` emits `terminal.exit`
- stale durable-session callback cannot rebind after a newer generation exists
- in-TUI PTY exit after durable bind is not final
- Codex terminal created with an explicit durable `resumeSessionId` starts with `codex.durableSessionId` set and recovers as durable immediately
- non-Codex PTY exit still emits `terminal.exit`; Codex generation guards must not run for ordinary shell terminals
- failed unpublished candidate generation is never reused by a later replacement attempt, and late callbacks from the failed candidate remain ignored even after another candidate is published

Expected: fail because generation and close reason do not exist.

- [ ] **Step 2: Extend `TerminalRecord` with Codex fields**

Add fields:

```ts
codex?: {
  recoveryState: CodexRecoveryState
  workerGeneration: number
  nextWorkerGeneration: number
  retiringGenerations: Set<number>
  closeReasonByGeneration: Map<number, CodexWorkerCloseReason>
  durableSessionId?: string
  originalResumeSessionId?: string
  launchFactory?: CodexLaunchFactory
  launchBaseProviderSettings?: {
    model?: string
    sandbox?: string
    permissionMode?: string
  }
  envContext?: TerminalEnvContext
  recoveryPolicy: CodexRecoveryPolicy
}
```

Keep `record.status` unchanged.

When `resumeForBinding` is present during Codex terminal creation, initialize `record.codex.durableSessionId` to that value and set the recovery state to `running_durable` after initial create. Fresh Codex terminals without a durable binding start as `running_live_only` after initial create and promote to `running_durable` only through the durable rollout proof path.

Initialize `workerGeneration` and `nextWorkerGeneration` so every later candidate generation is allocated by incrementing `nextWorkerGeneration`, never by recomputing `workerGeneration + 1`. A candidate that fails before publication still consumes its generation number permanently.

- [ ] **Step 3: Wire close reasons**

Explicit `kill()` and `remove()` must set current generation close reason to `user_final_close` before shutting down sidecar or killing PTY.

Recovery retirement must set close reason to `recovery_retire` before calling shutdown/kill.

PTY exit handler classification:

```ts
if (record.mode !== 'codex') {
  this.finalizeTerminalExit(record, e.exitCode, 'pty_exit')
  return
}
if (generation !== record.codex?.workerGeneration) return
if (record.codex.retiringGenerations.has(generation)) return
const closeReason = record.codex.closeReasonByGeneration.get(generation)
if (closeReason === 'recovery_retire') return
if (closeReason === 'user_final_close') {
  this.finalizeTerminalExit(record, e.exitCode, 'user_final_close')
  return
}
void this.handleCodexWorkerFailure(record, generation, 'pty_exit', new Error(...))
return
```

The non-Codex branch must stay before any `record.codex` generation or close-reason guard. Ordinary shell terminals have no Codex generation state, and their PTY exit remains final.

PTY data handler classification:

```ts
if (record.mode === 'codex') {
  if (!this.isCurrentCodexGeneration(record, generation)) return
  if (record.codex?.retiringGenerations.has(generation)) return
}
this.handleTerminalWorkerData(record, generation, data)
```

`handleTerminalWorkerData()` should contain the existing buffer append, `terminal.output.raw`, client output, startup probe, perf accounting, and remote-TUI fatal detection. This keeps old-generation output from corrupting the replacement stream or triggering recursive recovery.

- [ ] **Step 4: Guard durable promotion callbacks**

The sidecar attachment callback should capture `generation`. On durable session:

```ts
if (!this.isCurrentCodexGeneration(record, generation)) return
if (record.codex?.retiringGenerations.has(generation)) return
this.promoteCodexDurableSession(record, sessionId, generation)
```

When Task 7 introduces active replacement attempts, update the durable promotion guard to accept the active candidate generation as well as the published current generation. A fast pre-durable replacement can produce durable-session evidence before the candidate generation is published.

Candidate durable promotion must use the same latch as candidate readiness:

- if `onDurableSession` names the active candidate generation before publication, store the pending durable session ID on the active attempt; it may bind `record.codex.durableSessionId` only if that field is unset or already equal to the same ID, and it must return without setting `running_durable`, emitting running status, or flushing input
- if the terminal is already running on the published current generation, `promoteCodexDurableSession()` may bind the durable ID and transition `running_live_only` to `running_durable`
- if the terminal is recovering, `promoteCodexDurableSession()` may bind the durable ID monotonically, but readiness and input flush remain owned by `noteCodexReadinessEvidence()` / `markCodexRecoveryReady()` after worker publication

This deliberately splits "durable ID is known" from "the replacement worker is ready." Durable binding may become known early, but it cannot by itself make a recovering terminal interactive.

- [ ] **Step 5: Verify Task 5**

Run:

```bash
npm run test:vitest -- test/unit/server/terminal-registry.codex-recovery.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 5**

```bash
git add server/terminal-registry.ts test/unit/server/terminal-registry.codex-recovery.test.ts
git commit -m "test: guard codex worker generations"
```

## Task 6: Store A Reusable Codex Launch Factory And Retry Initial Launch

**Files:**
- Modify: `server/coding-cli/codex-app-server/launch-planner.ts`
- Modify: `server/ws-handler.ts`
- Modify: `server/agent-api/router.ts`
- Modify: `server/terminal-registry.ts`
- Modify: `test/unit/server/terminal-registry.codex-recovery.test.ts`
- Modify: `test/server/ws-terminal-create-reuse-running-codex.test.ts`
- Modify: `test/e2e/agent-cli-flow.test.ts`
- Modify: `test/integration/server/codex-session-flow.test.ts`

- [ ] **Step 1: Add failing tests for replacement launch inputs**

In `terminal-registry.codex-recovery.test.ts`, assert that a durable recovery calls the stored launch factory with:

```ts
{
  terminalId: originalTerminalId,
  cwd: originalCwd,
  resumeSessionId: durableSessionId,
  envContext: originalEnvContext,
}
```

Assert that the replacement PTY spawn receives provider settings with the new `codexAppServer.wsUrl` and `resumeSessionId` equal to the durable session ID.

Expected: fail because registry does not store a launch factory.

- [ ] **Step 1b: Add failing tests for initial Codex launch retry before a terminal record exists**

Add WebSocket and agent API tests proving the first Codex app-server launch is retried automatically before `terminal.created`:

- `terminal.create` with a Codex launch planner that rejects attempts 1 and 2, then succeeds, sends one `terminal.created`, no `error`, and only creates one terminal record with the preallocated terminal ID used by the successful plan.
- `terminal.create` with a launch planner that rejects all 5 attempts sends one clear create error and creates no terminal record.
- Any sidecar returned by a failed initial planning attempt is shut down before the next attempt or final error.
- If `CodexLaunchPlanner.planCreate()` creates a sidecar and then rejects before returning a plan, the planner/factory itself shuts down that sidecar before rejecting. Callers cannot clean up a sidecar they never received.
- The agent API terminal creation path follows the same retry and cleanup behavior.

Expected: fail because `ws-handler.ts` and `agent-api/router.ts` call `planCodexLaunch` once and return a create error immediately on failure.

- [ ] **Step 2: Export launch factory types**

In `launch-planner.ts`:

```ts
export type CodexLaunchFactoryInput = {
  terminalId: string
  cwd?: string
  envContext?: TerminalEnvContext
  resumeSessionId?: string
  providerSettings?: {
    model?: string
    sandbox?: string
    permissionMode?: string
  }
}

export type CodexLaunchFactory = (input: CodexLaunchFactoryInput) => Promise<CodexLaunchPlan>
```

Avoid circular runtime imports. If `TerminalEnvContext` creates a cycle, move the shared type to a small new file such as `server/terminal-env.ts`.

Also wrap sidecar creation/`ensureReady()` in `planCreate()` so a sidecar created during a failed plan is always shut down before the promise rejects:

```ts
const sidecar = this.createSidecar(...)
try {
  const ready = await sidecar.ensureReady()
  return buildPlan(ready, sidecar)
} catch (error) {
  await sidecar.shutdown().catch(() => undefined)
  throw error
}
```

- [ ] **Step 3: Pass factory from WebSocket terminal creation and retry initial planning**

In `ws-handler.ts`, keep initial planning before synchronous `registry.create()`, but also pass:

```ts
codexLaunchFactory: async (input) => this.planCodexLaunch(
  input.cwd,
  input.resumeSessionId,
  input.providerSettings,
  input.terminalId,
  input.envContext ?? {},
)
```

Persist the provider settings used for initial launch, excluding the generation-specific `codexAppServer` field.

Wrap the initial `planCodexLaunch()` call in the same bounded retry policy used for pre-durable recovery. This retry exists only before the terminal record exists; after `registry.create()` succeeds, all failures must be handled by the registry supervisor. Log each pre-create retry with request ID, planned terminal ID, attempt number, and error message.

- [ ] **Step 4: Pass factory from agent API terminal creation and retry initial planning**

In `agent-api/router.ts`, pass an equivalent factory when creating Codex terminals through automation routes. API-created Codex panes must not become a separate non-recovering path. Initial Codex launch planning in the API path must use the same bounded retry helper as WebSocket `terminal.create`.

- [ ] **Step 5: Verify Task 6**

Run:

```bash
npm run test:vitest -- test/unit/server/terminal-registry.codex-recovery.test.ts test/server/ws-terminal-create-reuse-running-codex.test.ts test/e2e/agent-cli-flow.test.ts test/integration/server/codex-session-flow.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 6**

```bash
git add server/coding-cli/codex-app-server/launch-planner.ts server/ws-handler.ts server/agent-api/router.ts server/terminal-registry.ts test/unit/server/terminal-registry.codex-recovery.test.ts test/server/ws-terminal-create-reuse-running-codex.test.ts test/e2e/agent-cli-flow.test.ts test/integration/server/codex-session-flow.test.ts
git commit -m "feat: preserve codex launch inputs for recovery"
```

## Task 7: Implement Durable Bundle Replacement

**Files:**
- Modify: `server/terminal-registry.ts`
- Modify: `server/coding-cli/codex-app-server/sidecar.ts`
- Modify: `test/unit/server/terminal-registry.codex-recovery.test.ts`
- Modify: `test/integration/server/codex-session-flow.test.ts`

- [ ] **Step 1: Add failing durable recovery tests**

Add tests covering each detection source with the same assertion shape:

- durable PTY exit
- sidecar fatal
- app-server child/runtime exit
- app-server client disconnect while child remains alive
- remote TUI fatal output while PTY remains alive
- provider lifecycle-loss notification for the expected durable thread while PTY remains alive, using `thread/closed`, `thread/status/changed` to `notLoaded`, or `thread/status/changed` to `systemError`
- provider lifecycle-loss notification for the active replacement candidate before candidate publication fails that replacement attempt and schedules the next whole-bundle attempt instead of being ignored as stale
- detached durable terminal recovery re-arms current-generation pre-attach startup probes and sends probe replies only to the replacement PTY

Each test must assert:

- no `terminal.exit` event
- same `terminalId`
- same `TerminalRecord`
- same clients still attached
- `resumeSessionId` remains the durable ID
- old generation is retiring
- new generation increments by exactly 1
- old sidecar shutdown called once
- old PTY killed with recovery retire close reason
- new sidecar created on a new ws URL
- replacement PTY args include `--remote <new-url>` and `resume <durable-id>`

Expected: fail because recovery calls `kill()`.

- [ ] **Step 1b: Add failing retry-coalescing and replacement-failure tests**

Add tests proving:

- two failure signals from the same generation start only one replacement attempt
- sidecar fatal followed by PTY exit from the retiring generation consumes one retry attempt, not two
- sidecar fatal followed by PTY output from the retiring generation does not append stale output and does not trigger another recovery attempt
- launch factory rejection schedules the next attempt and does not emit `terminal.exit`
- PTY spawn failure after a successful launch plan shuts down that just-created sidecar, schedules the next attempt, and does not delete the durable binding
- recovery budget exhaustion after repeated replacement launch/spawn failures enters `recovery_failed`
- explicit `kill()` or `remove()` during an active replacement attempt cancels the attempt; if the launch factory later resolves, the candidate sidecar is shut down, no candidate PTY is installed, no `terminal.status` recovery message is emitted, and no retry timer remains
- fast `thread/started` readiness evidence received for an active candidate before replacement PTY installation is latched, does not emit `terminal.status` running, and does not flush buffered input until the candidate PTY, handlers, latest dimensions, and `workerGeneration` are published
- fast `onDurableSession` evidence received for an active candidate before publication records pending durable identity, optionally binds the same durable ID monotonically, and never marks running, emits `terminal.status` running, or flushes input
- failed unpublished candidate generations are marked retired/final and are never reused by later replacement attempts; late PTY data/exit from such a candidate is ignored even after a later candidate is published

Expected: fail because replacement failures are not classified as recovery attempts yet.

- [ ] **Step 2: Implement `handleCodexWorkerFailure()`**

Add:

```ts
private async handleCodexWorkerFailure(
  record: TerminalRecord,
  generation: number,
  source: CodexWorkerFailureSource,
  error: Error,
  attemptId?: string,
): Promise<void>
```

Rules:

- ignore if record missing or `status === 'exited'`
- ignore stale generation, except that the active replacement candidate generation with the matching active replacement attempt ID is not stale for replacement-attempt failure handling
- ignore retiring generation
- ignore if final close has already invalidated the terminal or recovery attempt
- if mode is not `codex`, finalize exit
- if explicit `user_final_close`, finalize exit
- otherwise call `startCodexBundleReplacement(record, source, error)`

The sidecar lifecycle callback must call this method with `source: 'provider_thread_lifecycle_loss'` when a current-generation or active-candidate lifecycle-loss event names the terminal's durable session ID. Lifecycle-loss events include `thread_closed` for the durable ID and `thread_status_changed` for the durable ID with `status.type` of `notLoaded` or `systemError`. This applies in `running_durable` and `recovering_durable`; old-generation, wrong-attempt, or non-matching thread IDs are ignored. For an active candidate that has not yet been published, lifecycle-loss fails the current replacement attempt, cleans up any candidate resources, consumes exactly one attempt, and schedules the next whole-bundle replacement or enters `recovery_failed`. It must not be routed through the normal stale-generation ignore path.

The accepted PTY data path must feed the current generation's `CodexRemoteTuiFailureDetector`. If it reports a fatal transport/attachment failure, append the raw data first, then call this method with `source: 'remote_tui_fatal_output'`. This makes the visible diagnostic replayable while still starting replacement even when the PTY process stays alive.

When handling startup probes, write probe replies to the PTY for the same accepted generation that produced the probe output. Never let stale-generation startup probe output write to a newer PTY.

- [ ] **Step 3: Implement bundle retirement**

Add:

```ts
private async retireCodexWorkerBundle(record: TerminalRecord, generation: number): Promise<void>
```

It must:

- mark generation retiring before side effects
- set close reason `recovery_retire`
- stop accepting writes to old PTY
- shut down sidecar
- kill old PTY
- cleanup MCP config for the generation
- leave `record.status`, clients, buffer, durable binding, and broker state intact

- [ ] **Step 4: Implement replacement spawn**

Add:

```ts
private async startCodexBundleReplacement(
  record: TerminalRecord,
  source: CodexWorkerFailureSource,
  error: Error,
): Promise<void>
```

It must:

1. ask `CodexRecoveryPolicy` for the next attempt or enter `recovery_failed`
2. set `recoveryState` to `recovering_durable`
3. emit `terminal.status` with `status: 'recovering'`
4. retire generation `N`
5. call launch factory with durable session ID
6. allocate a fresh candidate generation by incrementing `record.codex.nextWorkerGeneration`
7. attach replacement sidecar callbacks capturing that candidate generation and the active replacement attempt ID
8. start the readiness timer for the candidate generation
9. if no clients are attached, reset `preAttachStartupProbeState` for the candidate generation
10. spawn replacement PTY using existing helper
11. install PTY handlers for the candidate generation
12. publish `workerGeneration = candidateGeneration` only after the replacement sidecar and PTY have both been installed

Do not emit `terminal.created`. This is the same terminal.

Track the active replacement attempt explicitly, for example:

```ts
activeReplacement?: {
  attempt: number
  id: string
  retiringGeneration: number
  candidateGeneration: number
  candidatePublished: boolean
  pendingReadiness?: {
    kind: 'thread_started'
    threadId: string
  }
  pendingDurableSessionId?: string
  timer?: NodeJS.Timeout
  finalCloseAbort?: AbortController
}
```

Install sidecar lifecycle callbacks before spawning the remote TUI PTY. The remote TUI may call `thread/resume` immediately after spawn, and the app-server can emit `thread/started` before the next tick. Missing that event would strand the terminal in recovery even though resume succeeded.

Allocate candidate generations monotonically from `record.codex.nextWorkerGeneration`; never derive the next candidate as `workerGeneration + 1`, because a failed unpublished candidate must not have its generation number reused by a later attempt. Only publish `candidateGeneration` as the current live `workerGeneration` after the replacement sidecar, PTY, PTY handlers, latest dimensions, and generation-scoped disposable metadata have all been installed. Until then, callbacks for that generation are valid only if they match the active replacement attempt's candidate generation and attempt ID. Do not route candidate lifecycle evidence through a helper that requires `generation === record.codex.workerGeneration`, or fast `thread/started` evidence can be discarded before the candidate is published. If fast `thread/started` evidence arrives before publication, store it on `activeReplacement.pendingReadiness` and keep the terminal in `recovering_durable`; do not mark ready or flush buffered input. If fast `onDurableSession` evidence arrives before publication, store it on `activeReplacement.pendingDurableSessionId`; it may bind `record.codex.durableSessionId` only if unset or equal to that same ID, and running-state transition plus input flush remain forbidden until publication and readiness consumption. Immediately after publishing the candidate as current, consume matching pending durable promotion and readiness evidence in that order, using the same helpers used for later events. If launch planning fails before any new disposable resources exist, or PTY spawn fails after a sidecar exists, mark the candidate generation retiring/final, clean up the candidate resources, clear `activeReplacement`, and schedule the next attempt without treating the candidate generation as a live worker. Late callbacks from that failed candidate must remain ignored even if a later candidate is published.

Every `await` inside a replacement attempt must re-check that the record still exists, `record.status === 'running'`, the active attempt ID still matches, and no final-close abort has fired. If final close wins the race, dispose candidate resources and return without scheduling another retry.

Wrap launch planning, sidecar readiness, and PTY spawn in a single attempt boundary:

```ts
let plan: CodexLaunchPlan | undefined
let attemptedMcpCwd: string | undefined
try {
  plan = await record.codex.launchFactory!(...)
  const worker = this.spawnTerminalWorker(...)
  attemptedMcpCwd = worker.mcpCwd
  this.installTerminalWorkerHandlers(record, nextGeneration)
  this.startCodexReadinessTimer(record, nextGeneration)
} catch (error) {
  await plan?.sidecar.shutdown().catch(() => undefined)
  if (attemptedMcpCwd !== undefined) {
    cleanupMcpConfig(record.terminalId, record.mode, attemptedMcpCwd)
  }
  this.scheduleCodexRecoveryRetry(record, nextGeneration, classifyReplacementFailure(error))
}
```

The concrete implementation can differ, but the behavior cannot: every failed replacement attempt either schedules exactly one next attempt or transitions to `recovery_failed`.

- [ ] **Step 5: Add structured logs**

At minimum:

- `codex_worker_failure`
- `codex_recovery_started`
- `codex_recovery_attempt`
- `codex_recovery_bundle_retired`
- `codex_recovery_attempt_failed`
- `codex_recovery_attempt_coalesced`

Include terminal ID, source, generation, state, durable ID presence, old/new ws URL when known, PTY PID, app-server PID, attempt number, and error message.

- [ ] **Step 6: Verify Task 7**

Run:

```bash
npm run test:vitest -- test/unit/server/terminal-registry.codex-recovery.test.ts
```

Expected: PASS for durable replacement tests.

- [ ] **Step 7: Commit Task 7**

```bash
git add server/terminal-registry.ts server/coding-cli/codex-app-server/sidecar.ts test/unit/server/terminal-registry.codex-recovery.test.ts test/integration/server/codex-session-flow.test.ts
git commit -m "feat: recover durable codex worker bundles"
```

## Task 8: Enforce Readiness Proof And Input Gating

**Files:**
- Modify: `server/terminal-registry.ts`
- Modify: `test/unit/server/terminal-registry.codex-recovery.test.ts`
- Modify: `test/integration/server/codex-session-flow.test.ts`

- [ ] **Step 1: Add failing readiness tests**

Write tests:

- durable recovery does not become running on process spawn
- durable recovery does not become running on first PTY output
- durable recovery does not become running when an old rollout artifact exists
- durable recovery becomes running only after current-generation lifecycle event names expected durable ID
- lifecycle event for another thread keeps recovery pending
- stale-generation lifecycle event is ignored
- fast candidate-generation `thread/started` before replacement PTY publication is latched but does not mark running or flush input until the candidate PTY, handlers, latest dimensions, and `workerGeneration` are published
- readiness timeout consumes one retry attempt and schedules the next bundle replacement
- readiness timeout enters `recovery_failed` only after retry budget exhaustion

Expected: fail because recovery readiness is not implemented.

- [ ] **Step 2: Add failing input buffering tests**

Write tests:

- input during `recovering_durable` is not written to old PTY
- buffered input flushes to new PTY only after readiness proof
- buffer overflow appends the local "input was not sent" message
- buffer expiry appends the local "input was not sent" message
- `recovery_failed` input appends the local recovery-failed message and is treated as handled by `ws-handler`
- recovery input overflow/expiry and `recovery_failed` input do not cause `ws-handler` to send `INVALID_TERMINAL_ID`
- local recovery messages update the terminal buffer and emit `terminal.output.raw`

Expected: fail because input still writes to `record.pty`.

- [ ] **Step 2b: Add failing resize-during-recovery tests**

Write tests:

- `resize()` during `recovering_durable` updates `record.cols` and `record.rows` without writing to the retired PTY
- broker/attach hydration during recovery does not report the terminal missing merely because the old PTY is retired
- the replacement PTY is spawned and/or resized with the latest `cols` and `rows`
- stale-generation resize side effects cannot resize a newer PTY

Expected: fail because resize currently writes directly to `record.pty` and returns false if that PTY is unavailable.

- [ ] **Step 3: Implement readiness tracking**

On replacement start, store:

```ts
readiness: {
  generation: number
  expectedSessionId?: string
  timeout: NodeJS.Timeout
}
```

Sidecar `onThreadLifecycle` callback:

```ts
if (!this.isCurrentOrActiveCandidateCodexGeneration(record, generation, attemptId)) return
if (event.kind === 'thread_closed' && event.threadId === expectedSessionId) {
  void this.handleCodexWorkerFailure(record, generation, 'provider_thread_lifecycle_loss', new Error('Codex provider reported the active thread closed.'), attemptId)
  return
}
if (
  event.kind === 'thread_status_changed'
  && event.threadId === expectedSessionId
  && (event.status.type === 'notLoaded' || event.status.type === 'systemError')
) {
  void this.handleCodexWorkerFailure(record, generation, 'provider_thread_lifecycle_loss', new Error(`Codex provider reported the active thread status ${event.status.type}.`), attemptId)
  return
}
if (
  event.kind === 'thread_started'
  && event.thread.id === expectedSessionId
  && record.codex?.recoveryState === 'recovering_durable'
) {
  this.noteCodexReadinessEvidence(record, generation, attemptId, event.thread.id)
}
```

The guard must accept the published current generation and the active replacement attempt's candidate generation. Lifecycle-loss handling must not be gated by `recoveryState === 'recovering_durable'`; provider lifecycle-loss evidence for the expected durable ID is a failure source in both `running_durable` and `recovering_durable`. Only readiness handling is gated to `recovering_durable`.

If lifecycle-loss belongs to the active replacement candidate before publication, it is not ignored as stale. It fails the active replacement attempt through the same attempt-failure path as launch, spawn, and readiness-timeout failures, including candidate cleanup and exactly one consumed retry attempt.

`noteCodexReadinessEvidence()` must distinguish candidate evidence from installed-worker evidence:

- if the event belongs to the active replacement candidate and that candidate is not yet published, set `activeReplacement.pendingReadiness` and return without changing status or flushing input
- if the event belongs to the active replacement candidate after publication, or the published current generation, call `markCodexRecoveryReady()`
- if final close, retry cancellation, wrong attempt ID, wrong generation, or wrong session ID wins the race, ignore the evidence

A candidate can receive `thread/started` before `workerGeneration` is published, because callbacks are installed before the replacement PTY is spawned to avoid missing fast provider evidence. That event must be preserved but cannot make the terminal running until the worker is fully installed.

`markCodexRecoveryReady()` must:

- assert the generation is the published current `workerGeneration`
- assert the replacement PTY, sidecar, handlers, latest dimensions, and readiness timer for that generation are installed
- clear readiness timeout
- set state `running_durable`
- reset stable retry timer
- emit `terminal.status` running
- flush buffered input
- log `codex_recovery_ready`

The readiness timeout handler must call the same recovery-attempt failure path as launch and spawn failures. It consumes exactly one retry attempt and schedules the next whole-bundle replacement unless the budget is exhausted; only budget exhaustion emits `terminal.status` `recovery_failed`.

- [ ] **Step 4: Implement input gating**

Change `input()`:

```ts
if (term.mode === 'codex' && isRecovering(term)) {
  return this.bufferCodexRecoveryInput(term, data)
}
if (term.mode === 'codex' && isRecoveryFailed(term)) {
  this.appendLocalTerminalMessage(term, RECOVERY_FAILED_INPUT_MESSAGE)
  return true
}
```

`bufferCodexRecoveryInput()` should return `true` when the input was buffered or when the registry appended a local "input was not sent" message. It should return `false` only when the terminal is genuinely missing or final-exited. Do not rely on `ws-handler` to send a clear error for recovery input rejection; its current `false` path sends `INVALID_TERMINAL_ID`, and `TerminalView` intentionally interprets that as terminal loss.

Implement:

```ts
private appendLocalTerminalMessage(record: TerminalRecord, message: string): void
```

It must append to `record.buffer`, send to attached clients through the existing terminal output framing path, and emit `terminal.output.raw` so `TerminalStreamBroker` replay state remains consistent.

- [ ] **Step 4b: Implement recovery-safe resize**

Change `resize()` so Codex recovery states update stable dimensions and return `true` without requiring a live worker PTY. When a replacement worker reaches readiness, ensure the current dimensions are applied to the new PTY before buffered input is flushed.

- [ ] **Step 5: Verify Task 8**

Run:

```bash
npm run test:vitest -- test/unit/server/terminal-registry.codex-recovery.test.ts test/integration/server/codex-session-flow.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 8**

```bash
git add server/terminal-registry.ts test/unit/server/terminal-registry.codex-recovery.test.ts test/integration/server/codex-session-flow.test.ts
git commit -m "feat: gate codex recovery readiness and input"
```

## Task 9: Implement Pre-Durable Retry And Recovery Failure

**Files:**
- Modify: `server/terminal-registry.ts`
- Modify: `test/unit/server/terminal-registry.codex-recovery.test.ts`
- Modify: `test/integration/server/codex-session-flow.test.ts`

- [ ] **Step 1: Add failing pre-durable tests**

Tests:

- sidecar/runtime failure before durable promotion retries the original fresh launch
- fresh retry uses original launch request and does not pass a guessed resume ID
- pre-durable readiness starts a concrete attach-stability timer only after current-generation sidecar readiness, PTY spawn, handler installation, latest resize application, and worker publication
- pre-durable readiness becomes `running_live_only`, emits `terminal.status` running, resets stable retry state, and flushes buffered input only after that attach-stability window elapses without worker failure or fatal remote TUI output
- pre-durable lifecycle promotion to a durable ID before the attach-stability timer elapses cancels the pre-durable ready timer and uses durable readiness/promotion rules instead
- retry exhaustion enters `recovery_failed`
- `recovery_failed` does not emit `terminal.exit`
- retry exhaustion does not release any durable binding if one appeared before exhaustion

Expected: fail because pre-durable failures currently exit.

- [ ] **Step 2: Implement pre-durable replacement**

Use the same `startCodexBundleReplacement()` path. The only difference is launch identity:

```ts
const resumeSessionId = record.codex.durableSessionId
if (resumeSessionId) {
  state = 'recovering_durable'
  launchFactory({ resumeSessionId, ... })
} else {
  state = 'recovering_pre_durable'
  launchFactory({ resumeSessionId: record.codex.originalResumeSessionId, ... })
}
```

For a truly fresh terminal, `originalResumeSessionId` is undefined.

- [ ] **Step 3: Define pre-durable readiness**

For `recovering_pre_durable`, readiness is a concrete current-generation attach-stability window, not process spawn, first output, or sidecar readiness alone.

Start a `preDurableAttachStabilityTimer` for 1500 ms only after all of these are true:

- the replacement sidecar is ready
- the replacement PTY is spawned
- PTY handlers are installed with the candidate generation
- the latest stable `cols` and `rows` have been applied
- `workerGeneration` has been published for the candidate

If, during that 1500 ms window, Freshell observes PTY exit, sidecar fatal, app-server runtime exit, app-server client disconnect, remote TUI fatal output, lifecycle-loss for a known thread, final close, or replacement-attempt cancellation, cancel the timer and route the event through the normal attempt-failure path. If the timer elapses with the same active attempt ID and current generation still valid, transition to `running_live_only`, clear recovery timers, reset the stable-running timer, emit `terminal.status` running, apply latest dimensions again if needed, and flush buffered input. If buffered input already expired before the timer elapses, append the normal local "input was not sent" message instead of flushing stale input.

If durable lifecycle evidence or rollout proof promotes the terminal during pre-durable recovery, cancel the pre-durable attach-stability timer and transition through the durable promotion/readiness rules instead. Do not allow the pre-durable timer to later overwrite `running_durable` or flush input a second time.

- [ ] **Step 4: Verify Task 9**

Run:

```bash
npm run test:vitest -- test/unit/server/terminal-registry.codex-recovery.test.ts test/integration/server/codex-session-flow.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 9**

```bash
git add server/terminal-registry.ts test/unit/server/terminal-registry.codex-recovery.test.ts test/integration/server/codex-session-flow.test.ts
git commit -m "feat: retry pre-durable codex workers"
```

## Task 10: Add Terminal Status Protocol And Client Handling

**Files:**
- Modify: `shared/ws-protocol.ts`
- Modify: `server/ws-handler.ts`
- Modify: `server/terminal-registry.ts`
- Modify: `src/store/types.ts`
- Modify: `src/lib/terminal-status-indicator.ts`
- Modify: `src/components/TerminalView.tsx`
- Modify: `docs/index.html`
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`
- Modify: `test/unit/client/components/TerminalView.resumeSession.test.tsx`
- Create: `test/e2e/codex-session-resilience-flow.test.tsx`

- [ ] **Step 1: Add failing protocol/client tests**

In `TerminalView.lifecycle.test.tsx`, add:

```ts
it('keeps the terminal id when a recoverable terminal.status arrives', async () => {
  const { sendServerMessage, store } = renderTerminalViewWithCreatedTerminal('term-1')

  sendServerMessage({
    type: 'terminal.status',
    terminalId: 'term-1',
    status: 'recovering',
    reason: 'codex_worker_failure',
  })

  const content = selectPaneContent(store.getState(), tabId, paneId)
  expect(content?.kind).toBe('terminal')
  expect(content?.terminalId).toBe('term-1')
  expect(content?.status).toBe('recovering')
})
```

Add another test for `recovery_failed` preserving `terminalId`, and one confirming `terminal.exit` still clears it.

Expected: fail because protocol/client do not know `terminal.status`.

- [ ] **Step 2: Add shared message types**

In `shared/ws-protocol.ts`, add `TerminalStatusMessage`, include it in `ServerMessage`, and add optional `runtimeStatus` to inventory terminal entries.

`TerminalStatusMessage.status` is runtime-only and must be limited to:

```ts
'running' | 'recovering' | 'recovery_failed'
```

Do not add or emit `terminal.status` with `status: 'exited'`; final terminal shutdown remains `terminal.exit`.

- [ ] **Step 3: Broadcast status from registry through ws-handler**

In `TerminalRegistry`, emit an event such as:

```ts
this.emit('terminal.status', {
  terminalId,
  status: 'recovering',
  reason,
  attempt,
})
```

In `WsHandler`, subscribe and broadcast it, similar to `terminal.exit` and metadata updates.

- [ ] **Step 4: Update client state and indicators**

Extend `TerminalStatus`:

```ts
export type TerminalStatus = 'creating' | 'running' | 'recovering' | 'recovery_failed' | 'exited' | 'error'
```

Map `recovering` to a neutral/in-progress style and `recovery_failed` to destructive style. Use existing accessible labels and avoid adding a modal or prompt.

- [ ] **Step 5: Update `TerminalView` message handling**

Add handling before `terminal.exit`:

```ts
if (msg.type === 'terminal.status' && msg.terminalId === tid) {
  if (msg.status === 'recovering') {
    updateContent({ status: 'recovering' })
    return
  }
  if (msg.status === 'recovery_failed') {
    updateContent({ status: 'recovery_failed' })
    return
  }
  if (msg.status === 'running') {
    updateContent({ status: 'running' })
    return
  }
}
```

Do not clear refs, cursor, attach state, or persisted terminal ID from status updates.

- [ ] **Step 6: Add e2e flow test**

Create `test/e2e/codex-session-resilience-flow.test.tsx` using existing TerminalView test harness patterns:

- create a Codex pane
- deliver `terminal.created`
- deliver `terminal.status` recovering
- verify pane remains mounted and terminal ID remains stable
- deliver `terminal.status` running
- verify user input still targets the same terminal ID
- deliver `terminal.status` recovery_failed
- verify terminal ID remains stable
- deliver `terminal.exit`
- verify only then it clears

- [ ] **Step 7: Update docs mock if status is visible**

If recovery or recovery-failed status appears in pane chrome, status dots, labels, or any visible default terminal UI, update `docs/index.html` to reflect the new status language and styling in the nonfunctional mock. If the status is not represented there, state why in the task commit notes.

- [ ] **Step 8: Verify Task 10**

Run:

```bash
npm run test:vitest -- test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TerminalView.resumeSession.test.tsx test/e2e/codex-session-resilience-flow.test.tsx
```

Expected: PASS.

- [ ] **Step 9: Commit Task 10**

```bash
git add shared/ws-protocol.ts server/ws-handler.ts server/terminal-registry.ts src/store/types.ts src/lib/terminal-status-indicator.ts src/components/TerminalView.tsx docs/index.html test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TerminalView.resumeSession.test.tsx test/e2e/codex-session-resilience-flow.test.tsx
git commit -m "feat: surface recoverable terminal status"
```

## Task 11: Harden Integration Coverage For Bundle Replacement

**Files:**
- Modify: `test/integration/server/codex-session-flow.test.ts`
- Modify: `test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs`

- [ ] **Step 1: Replace the old sidecar-death expectation**

Change the existing test named like "terminates the terminal when the owning Codex sidecar dies after launch" to assert recovery:

- create terminal
- promote durable ID
- kill fake app-server
- observe `terminal.status` recovering
- observe no `terminal.exit`
- observe new fake app-server launch
- observe replacement remote CLI invoked with `resume <durable-id>`
- observe `terminal.status` running after lifecycle proof
- send input and verify fake replacement receives it

Expected before implementation: old behavior exits; after prior tasks: pass.

- [ ] **Step 2: Add socket-disconnect integration test**

Configure fake app-server:

```json
{
  "closeSocketAfterMethodsOnce": ["thread/resume"]
}
```

Assert this uses the same bundle replacement path and does not emit `terminal.exit`.

- [ ] **Step 3: Add provider lifecycle-loss integration tests**

Configure fake app-server to send `thread/closed` for the expected durable thread after durable resume while the PTY stays alive. Assert bundle replacement starts anyway and no `terminal.exit` is emitted.

Configure fake app-server to send `thread/status/changed` with `status.type: 'notLoaded'` for the expected durable thread while the PTY stays alive. Assert the same bundle replacement path. Add a second status test for `systemError` if it is not redundant in the local helper. These fake tests cover production parsing and routing; the gated real-provider contract determines which provider lifecycle-loss signals are proven immediate in the installed provider.

- [ ] **Step 4: Add duplicate-session guard**

Use fake app-server `assertNoDuplicateActiveThread`. Recovery of a durable session must call resume on the durable ID and must not start a new active thread. The test should fail if a `thread/start` occurs during durable recovery.

- [ ] **Step 5: Verify Task 11**

Run:

```bash
npm run test:vitest -- test/integration/server/codex-session-flow.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 11**

```bash
git add test/integration/server/codex-session-flow.test.ts test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs
git commit -m "test: cover codex bundle replacement integration"
```

## Task 12: Protect Recovery From Idle Kill And Shutdown Regressions

**Files:**
- Modify: `server/terminal-registry.ts`
- Modify: `test/unit/server/terminal-registry.codex-recovery.test.ts`
- Modify: `test/unit/server/terminal-registry.test.ts`

- [ ] **Step 1: Add failing idle-kill tests**

Tests:

- detached `recovering_pre_durable` terminal is not idle-killed
- detached `recovering_durable` terminal is not idle-killed
- detached `recovery_failed` terminal is not idle-killed
- detached `running` terminal is still idle-killed after configured threshold
- explicit `kill()` still finalizes a recovering terminal
- explicit `kill()` or `remove()` clears any recovery backoff timer, readiness timer, active attempt, and buffered recovery input
- an in-flight launch promise that resolves after explicit final close shuts down its sidecar and does not install a replacement PTY or emit `terminal.status`

Expected: fail because idle kill currently checks only `status === 'running'` and clients size.

- [ ] **Step 2: Update idle-kill policy**

In `enforceIdleKills()`:

```ts
if (term.mode === 'codex' && isCodexRecoveryProtected(term)) continue
```

Protected means `recovering_pre_durable`, `recovering_durable`, or `recovery_failed`.

- [ ] **Step 3: Make final-close cancellation explicit**

Add a helper such as:

```ts
private markCodexFinalClose(record: TerminalRecord): void
```

It must set the current generation close reason to `user_final_close`, abort the active replacement attempt, clear backoff/readiness timers, clear buffered recovery input, mark any current or candidate generation as final, and prevent future async continuations for that attempt from installing worker resources. `kill()`, `remove()`, `shutdown()`, and `shutdownGracefully()` must call this before signaling PTYs or sidecars.

- [ ] **Step 4: Verify shutdown cleanup remains final**

Add or adjust tests proving `registry.shutdown()` and `registry.shutdownGracefully()` still kill all terminals and do not start recovery loops. Both shutdown paths must mark Codex worker generations as final before signaling PTYs; direct SIGTERM from graceful shutdown must not be classified as a spontaneous Codex worker failure.

- [ ] **Step 5: Verify Task 12**

Run:

```bash
npm run test:vitest -- test/unit/server/terminal-registry.codex-recovery.test.ts test/unit/server/terminal-registry.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 12**

```bash
git add server/terminal-registry.ts test/unit/server/terminal-registry.codex-recovery.test.ts test/unit/server/terminal-registry.test.ts
git commit -m "fix: protect codex recovery from idle kill"
```

## Task 13: Observability And Error Quality

**Files:**
- Modify: `server/terminal-registry.ts`
- Modify: `server/coding-cli/codex-app-server/runtime.ts`
- Modify: `test/unit/server/terminal-registry.codex-recovery.test.ts`
- Modify: `test/unit/server/coding-cli/codex-app-server/runtime.test.ts`

- [ ] **Step 1: Add failing log-context tests**

Mock logger and assert recovery logs include:

- terminal ID
- source
- state before/after
- attempt number
- generation
- durable session presence, not necessarily full ID
- old and new ws URL or port when available
- app-server PID when available
- PTY PID when available
- exit code/signal and stdout/stderr tails when available

Expected: fail until structured logs are complete.

- [ ] **Step 2: Add logs**

Add logs:

- `codex_worker_failure`
- `codex_recovery_started`
- `codex_recovery_attempt`
- `codex_recovery_ready`
- `codex_recovery_failed`
- `codex_recovery_attempt_failed`
- `codex_recovery_attempt_coalesced`
- `codex_recovery_abandoned_stale_generation`
- `codex_recovery_cleanup_callback`

These logs should be visible at normal server log levels for failures and recovery transitions. Do not require debug logging for the incident-critical path.

- [ ] **Step 3: Verify Task 13**

Run:

```bash
npm run test:vitest -- test/unit/server/terminal-registry.codex-recovery.test.ts test/unit/server/coding-cli/codex-app-server/runtime.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit Task 13**

```bash
git add server/terminal-registry.ts server/coding-cli/codex-app-server/runtime.ts test/unit/server/terminal-registry.codex-recovery.test.ts test/unit/server/coding-cli/codex-app-server/runtime.test.ts
git commit -m "chore: log codex recovery transitions"
```

## Task 14: Full Regression Verification And Refactor Pass

**Files:**
- Review all touched files.
- Modify only files that need cleanup after full verification.

- [ ] **Step 1: Run focused server and client checks**

Run:

```bash
npm run test:vitest -- test/unit/server/coding-cli/codex-app-server test/unit/server/terminal-registry.test.ts test/unit/server/terminal-registry.codex-recovery.test.ts
npm run test:vitest -- test/integration/server/codex-session-flow.test.ts test/integration/server/codex-session-rebind-regression.test.ts
npm run test:vitest -- test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TerminalView.resumeSession.test.tsx test/e2e/codex-session-resilience-flow.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run lint if client files changed**

Run:

```bash
npm run lint
```

Expected: PASS.

- [ ] **Step 4: Refactor**

Refactor only after green focused checks:

- remove duplicated generation checks
- keep recovery policy pure and independently tested
- keep terminal registry helper names explicit
- avoid adding any in-place sidecar/PTY repair branch
- ensure all relative ESM imports include `.js`
- ensure tests assert behavior rather than implementation details where possible

Re-run the focused checks from Step 1 after refactor.

- [ ] **Step 5: Run broad coordinated suite**

Check coordinator status first:

```bash
npm run test:status
```

Then run:

```bash
FRESHELL_TEST_SUMMARY="codex session resilience full check" npm run check
```

Expected: PASS.

- [ ] **Step 6: Provider readiness contract gate**

If the environment has an authenticated installed Codex app-server, run:

```bash
FRESHELL_REAL_PROVIDER_CONTRACTS=1 npm run test:vitest -- test/integration/real/codex-app-server-readiness-contract.test.ts
```

Expected: PASS. If the provider is unavailable, record that in the final handoff. If the provider is available and this fails, keep production readiness strict and report that durable seamless recovery cannot honestly be guaranteed with the installed provider.

- [ ] **Step 7: Final commit**

If refactor or cleanup changed files:

```bash
git add .
git commit -m "refactor: tighten codex recovery implementation"
```

## Acceptance Criteria

- A durable Codex PTY exit does not emit `terminal.exit`.
- A durable Codex sidecar/runtime exit does not emit `terminal.exit`.
- A durable Codex app-server client disconnect while the child process remains alive does not emit `terminal.exit`.
- Known remote TUI fatal output triggers bundle replacement even if the PTY has not exited.
- Provider lifecycle-loss evidence (`thread/closed` or `thread/status/changed` to `notLoaded`/`systemError`) for the expected durable thread triggers bundle replacement even if the PTY remains alive.
- Provider lifecycle-loss evidence for the expected durable thread is handled in both `running_durable` and `recovering_durable`; only readiness evidence is gated to recovery state.
- Replacement launch failures and replacement PTY spawn failures retry through the same whole-bundle replacement policy and never emit `terminal.exit`.
- Multiple failure signals for the same generation coalesce into one active recovery attempt.
- Retry attempts are capped per recovery episode; attempts do not age out while the terminal remains in recovery, so exhaustion deterministically reaches `recovery_failed`.
- The recovery action is always whole bundle replacement. There is no in-place sidecar reuse branch, no PTY-only branch, and no JSON-RPC-client-only reconnect branch.
- The replacement PTY uses the same terminal ID and launches with `--remote <new-ws-url> resume <durable-session-id>` for durable recovery.
- Current-generation lifecycle evidence naming the expected durable session is required before `running_durable`.
- Buffered input flushes only after readiness proof and only after the replacement PTY, handlers, latest dimensions, and published `workerGeneration` are installed.
- Input is never silently written to a dead PTY.
- Resize during recovery preserves the latest terminal dimensions and applies them to the replacement worker.
- Local recovery diagnostics are replayable after detach/reattach because they flow through the normal terminal output broker path.
- Stale generation PTY exit, sidecar fatal, runtime exit, client disconnect, watcher callback, rollout callback, lifecycle event, and timers are ignored.
- Worker generation numbers are monotonically allocated and never reused, including failed unpublished candidates.
- Stale or retiring generation PTY data is ignored after retirement begins and cannot append to scrollback, broker replay, perf counters, startup probes, or remote-TUI fatal detection.
- `recovery_retire` callbacks do not consume retry budget, emit `terminal.exit`, release durable binding, or start recursive recovery.
- `user_final_close` remains final and emits `terminal.exit`.
- `user_final_close` during recovery cancels timers, clears buffered recovery input, aborts active attempts, disposes late candidate sidecars, and cannot later spawn or install a replacement worker.
- In-TUI quit for a durable Codex session is recovered unless Freshell initiated final close.
- Pre-durable failures retry the original launch and never guess durable identity.
- Pre-durable recovery reaches `running_live_only` only after the defined current-generation attach-stability window elapses without failure, then flushes only non-expired buffered input.
- Retry exhaustion leaves the pane alive in `recovery_failed`.
- Idle kill skips recovery states and still kills ordinary detached running terminals.
- Client `terminal.status` handling never clears `terminalId`; only `terminal.exit` clears it.
- `terminal.status` never carries `exited`; final exit is represented only by `terminal.exit`.
- Integration tests fail if durable recovery creates duplicate active upstream work instead of resuming the intended durable session.
- Logs contain enough diagnostic context for the next incident without requiring debug logging.

## Required Final Verification

Before handing off for merge:

```bash
npm run test:status
FRESHELL_TEST_SUMMARY="codex session resilience final verification" npm run check
FRESHELL_REAL_PROVIDER_CONTRACTS=1 npm run test:vitest -- test/integration/real/codex-app-server-readiness-contract.test.ts
git diff --check
```

Expected: all PASS and no whitespace errors. If the real-provider contract cannot run because the provider is unavailable or unauthenticated, document that explicitly; if it runs and fails, do not claim the seamless durable-session guarantee.

Follow the repository merge rule after implementation: update the feature worktree from main first, resolve conflicts in the worktree, run the full suite, then fast-forward main only after verification.
