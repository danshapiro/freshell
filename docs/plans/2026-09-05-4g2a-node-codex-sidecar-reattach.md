# Node Codex Sidecar Reattach on Restore (4g2a) Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result

The Node server (`server/`) never reattaches a restored codex terminal pane to a codex app-server sidecar that survived a server death — its restore path always spawns a fresh sidecar. Implement restore-time reattach parity with the Rust lane (kata da92), as an independent TypeScript implementation with its own TDD cycle, so that a codex pane restored after an unclean server exit resumes against the surviving sidecar instead of spawning a second one.

### Explicit constraints

- **Disjoint stores:** Node owns `~/.freshell/codex-sidecars/` exclusively; the Rust lane owns `~/.freshell/rust-codex-sidecars/`. Neither lane may read or write the other lane's directory (house precedent: `session-cache.json` vs `rust-session-cache.json`). This change touches NOTHING under `crates/` and nothing named `rust-codex-sidecars`.
- **Restore-class only:** a reattach is attempted only for resume-keyed creates — `CodexLaunchPlanner.planCreate` calls carrying `resumeSessionId` (the WS `terminal.create{restore:true, sessionRef:{provider:"codex",sessionId}}` door and the registry crash-recovery closure). Fresh creates and resume-less restores never consult the reattach path (the A4-exclusion parity: no resume id, no claim).
- **Never signal unproven processes:** every kill decision goes through the existing conservative /proc-based verdicts (`classifyOwnedProcessGroup` / `concludeIfNotOwned`); `self`/`indeterminate`/unreadable evidence always refuse and keep the record (pid-reuse and shared-machine safety).
- **Independent implementation:** reproduce the da92 semantics in TypeScript; do not import from or couple to the Rust code.
- Red-green-refactor TDD for every behavior change; no test skips, no coverage reduction.

### Accepted tradeoffs and residuals

- **Fresh-context, same-model review:** the only available Fresh Eyes transport is same-model (`DARKFORGE_REVIEW_INDEPENDENCE_LABEL="fresh context, same model"`); plan/delta review evidence is therefore weaker than different-model review. Accepted as-is; findings are remediated regardless.
- **Sweep without activity sub-states:** Node reaps every unclaimed survivor once the grace window expires (hourly maintenance tick). The Rust lane additionally retains mid-turn / writer-held survivors past the sweep (ws-probe sub-states `mid-turn-active-thread`, `ws-unreachable-writer-held`, `identity-unverifiable`). Node parity extends only to `self`/`indeterminate`/unreadable-refusal; accepted residual: an unclaimed sidecar still mid-turn after the grace window (default 30 minutes, past which no client restored the pane) is reaped; its thread's writer lock is released by the kill, so a later restore spawns fresh and resumes cleanly (the `-32600 "active writer"` collision stays confined to the fresh path, exactly as in the da92 e2e control scenario).
- **Clean-shutdown lifecycle unchanged:** Node deliberately kills sidecar process groups on clean shutdown / pane close; survivors exist after unclean exits only. This kata does not change shutdown retention.
- The Node record schema stays `schemaVersion: 1` with one added optional field (`sessionId`); older records simply carry no claim key and are never claimable (no migration, no record-version bump).

**Goal:** after an unclean Node-server exit, a restored codex pane (`terminal.create{restore:true, sessionRef:{provider:"codex",sessionId}}`) claims and reuses that pane's surviving app-server sidecar — verified: the TUI's `thread/resume` is served by the surviving sidecar (its process unchanged in incarnation), not by a freshly spawned one — while every failure mode returns byte-compatible fresh-spawn behavior.

**Architecture:** three new pieces over the existing sidecar machinery. (1) The ownership record gains a `sessionId` (codex thread id) claim key, stamped when the identity is learned. (2) At boot the existing reaper's owner-dead branch *holds* verified-owned survivors in an in-memory reconciler (name, ws URL, session index) instead of killing them, with a grace-gated sweep through the existing hourly maintenance so unclaimed survivors are eventually reaped. (3) `CodexAppServerRuntime` grows an `attachToSurvivingSidecar` path (re-verify + bounded ws probe + thread-writer check + ownership retitle), and `CodexLaunchPlanner.planCreate`'s resume branch tries a one-shot reconciler claim before spawning.

**Tech Stack:** TypeScript (NodeNext/ESM), Node child_process + /proc process evidence, `ws` WebSocket client (already used by `CodexAppServerClient`), atomic JSON record files, Vitest.

## Global Constraints

- Server uses NodeNext/ESM; relative imports must include `.js` extensions.
- Structured logging only (repo `logger`, severity fields); no new console output.
- Test commands: focused suites run `npm run test:vitest -- run <paths> --config config/vitest/vitest.server.config.ts` (the default vitest config excludes `test/unit/server/**` and `test/server/**`; the server config covers them).
- The coordinated full-suite gate for landing is delegated to the wrapper: `darkforge qa --repo '/home/dan/code/freshell' --id '4g2a'` (runs `npm run check` plus the Rust gates; the three pre-existing `test/unit/vite-config.test.ts > getNetworkHost` failures are the baseline's enumerated exceptions and are not this change's responsibility).
- Never use broad kill patterns (`pkill -f node`, `pkill -f vite`, etc.); tests spawn fixture processes detached with recorded pids and kill only what they spawned (pgid-targeted cleanup through the same conservative classification used in production code).
- Tests must never read or write the real `~/.freshell/codex-sidecars/` or `~/.freshell/rust-codex-sidecars/`; every store interaction in tests uses a temp `metadataDir` via the runtime options.
- Commits use the repo's conventional-commit style; author/committer come from the repo git config (do not override).
- `docs/index.html` is a nonfunctional UI mock for user-facing changes only; this server-internal change does not touch it.

## Background and parity contract

The Rust lane (da92) semantics this plan reproduces semantically (independent TS; evidence in `<logs_dir>/reports/plan-rust-reattach-parity.md`):

1. Record store holds per-sidecar records including a `session_id` claim key; boot reconcile prunes dead/mismatched records (remove-only, never signaling) and holds verified survivors as claimable.
2. A restore-class plan claims the survivor for its resume session id: identity re-verified at claim time (`/proc` classification), then a single bounded (3s) ws dial of the recorded `ws_url`; verified-but-unusable survivors are conservatively reaped and the plan falls back to fresh spawn; claim is one-shot.
3. Unclaimed survivors are swept after a grace window (30 min default, env-overridable); between claim and adopt the record is retitled to the new server generation; adopt stamps the new terminal id.

Node today: restore = client-replayed `terminal.create { restore:true, sessionRef:{provider:"codex",sessionId} }` → `WsHandler` restore decision (`restore-decision.ts` `durable_session_ref_resume`) → `planCodexLaunch` → `CodexLaunchPlanner.planCreate({ resumeSessionId })` → `CodexAppServerRuntime.ensureReady` → `startRuntime` always spawns a detached `codex … app-server --listen ws://127.0.0.1:<port>` (`runtime.ts:1828-1843`), writing `~/.freshell/codex-sidecars/<ownershipId>.json`; the boot pass `runCodexStartupReaper` (`server/index.ts:281` → `reapOrphanedCodexAppServerSidecars` in `runtime.ts`) currently **kills** every prior-generation survivor (dead-owner `owned` groups are SIGTERM/SIGKILL'd and unlinked at the reaper loop tail, `runtime.ts:1388-1391`), so nothing ever survives to be claimed. (Evidence: `<logs_dir>/reports/plan-node-codex-sidecar-restore.md`.)

## Stage 2 (load-bearing) verification outcome

The load-bearing checks this plan was drafted against were all run during Stage 2 (full assumption ledger: `<logs_dir>/load-bearing-ledger.md`; finder report: `<logs_dir>/reports/load-bearing-finder.md`). Verified facts the tasks rely on:

- `server/coding-cli/codex-child-registry.ts` registration is a Map write plus a best-effort `/proc` stat read and never assumes a local `ChildProcess` handle — the attach path may register a survivor pid it did not spawn.
- `allocateLocalhostPort` (`server/local-port.ts`) returns `{ hostname: '127.0.0.1', port }`, releasing its probe socket.
- The fixture honors `FAKE_CODEX_APP_SERVER_BEHAVIOR` (knobs `loadedThreadIds`, `appendThreadOperationLogPath` — op entries carry the fixture's own `listenUrl` — `threadStatuses`, `overrides`), `app-server --listen <url>` argv, and `FAKE_CODEX_APP_SERVER_ARG_LOG`.
- `runtime.test.ts` provides `makeTempDir`, `occupyLoopbackPort`, `waitForMetadataRecord`, `markOwnershipRecordStale`, `createRuntime`, and pid-group kill helpers.
- `planCodexLaunch` (`server/ws-handler.ts:977-999`) is the single funnel into `CodexLaunchPlanner.planCreate` for restore creates and the registry recovery closure; WS door and agent API share one `CodexLaunchPlanner` instance (`server/index.ts:405-406,457-468`), so Task 4's seam needs no ws-handler/registry surgery beyond Task 1's stamping.
- Identity comparison is module-private `wrapperIdentityMatches` inside `classifyOwnedProcessGroup` (`runtime.ts:609-612`); attached-proof claims never hinge on reusing a test-side comparator (the tests build identity readers through the existing fixture-runtime records).
- `npm run lint` covers `src/` only; server-side quality gates are `npm run typecheck` + the server vitest config (`config/vitest/vitest.server.config.ts` includes `test/unit/server/**` and `test/server/**`).
- The Rust lane keeps five legitimate pre-existing references to Node's `codex-sidecars` name inside `crates/` comments (its own disjoint-boundary documentation), so the close-out disjointness check must be delta-scoped (see Task 5 close-out).

---

### Task 1: `sessionId` claim key on the ownership record, stamped at every identity-learning seam

**Files:**
- Modify: `server/coding-cli/codex-app-server/runtime.ts` (type at :46-61, parser at :812-841, `updateOwnershipMetadata` at :1611-1628)
- Modify: `server/coding-cli/codex-app-server/launch-planner.ts` (`CodexLaunchSidecar` type :30-49, `createSidecar` :226-323, resume branch :141-156)
- Modify: `server/terminal-registry.ts` (stamp seams at :2489-2490 fork-handoff and :2579-2581 fresh-candidate persistence)
- Test: `test/unit/server/coding-cli/codex-app-server/runtime.test.ts`
- Test: `test/unit/server/coding-cli/codex-app-server/launch-planner.test.ts`
- Test: `test/unit/server/terminal-registry.codex-sidecar.test.ts`

**Interfaces:**
- Consumes: existing `CodexSidecarOwnershipMetadata`, `parseMetadataRecord`, `updateOwnershipMetadata`, planner `PlanCreateInput.resumeSessionId`, registry `persistCodexCandidateSerial` / `stageCodexForkHandoffCandidate` (which hold `storedDurability.candidate.candidateThreadId` / `forkCandidate.candidateThreadId`).
- Produces:
  - `CodexSidecarOwnershipMetadata.sessionId?: string` (optional; absent on pre-feature records).
  - `updateOwnershipMetadata(input)` accepts `sessionId?: string` alongside its current fields.
  - `CodexLaunchSidecar.noteSessionId?(sessionId: string): Promise<void>` — stamps the record through the runtime (warn-and-continue on failure).

- [ ] **Step 1: Write the failing behavioral tests**

1. `runtime.test.ts`: after `createRuntime({ startupAttemptTimeoutMs: REAL_STARTUP_ATTEMPT_TIMEOUT_MS })` + `ensureReady`, call `runtime.updateOwnershipMetadata({ sessionId: 'thr-1' })`; read the record JSON from the temp metadata dir and expect `sessionId: 'thr-1'`; existing required fields untouched.
2. `launch-planner.test.ts`: with the in-file `FakeRuntime`, `planCreate({ resumeSessionId: 'thr-resume' })` results in `updateOwnershipMetadata` called with `{ sessionId: 'thr-resume' }`; a fresh `planCreate({})` never calls it with `sessionId`.
3. `terminal-registry.codex-sidecar.test.ts`: extend the existing `createFakeSidecar` with a `noteSessionId: vi.fn(async () => undefined)`; driving a fresh-mode codex pane through candidate persistence (the existing "candidate captured" test path) calls `noteSessionId` with the candidate thread id once the durability record is written; the fork-handoff-staged path calls it with `forkCandidate.candidateThreadId`.

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/runtime.test.ts test/unit/server/coding-cli/codex-app-server/launch-planner.test.ts test/unit/server/terminal-registry.codex-sidecar.test.ts --config config/vitest/vitest.server.config.ts -t "sessionId|noteSessionId"`

Expected: FAIL — `sessionId` is not an accepted patch field (updateOwnershipMetadata drops/throws), and `noteSessionId` does not exist on the sidecar shape.

- [ ] **Step 3: Add the minimal production implementation**

`runtime.ts`:
```ts
// CodexSidecarOwnershipMetadata: append one optional field
  sessionId?: string  // codex thread id — the restore-time claim key (kata 4g2a); absent on pre-feature records

// parseMetadataRecord required-fields guard: append to it
    || (candidate.sessionId !== undefined && typeof candidate.sessionId !== 'string')

// updateOwnershipMetadata input type and merge spreads:
async updateOwnershipMetadata(input: {
  terminalId?: string | null
  generation?: number | null
  codexHome?: string
  sessionId?: string
}): Promise<void> {
  // ...same guard; spread adds
  //   ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
}
```

`launch-planner.ts`:
```ts
// CodexLaunchSidecar: add
  noteSessionId?(sessionId: string): Promise<void>

// createSidecar: add to the returned object
      noteSessionId: async (sessionId) => {
        await runtime.updateOwnershipMetadata({ sessionId })
      },

// add the module logger import: import { logger } from '../../logger.js'

// planCreate resume branch, immediately after `await runtime.ensureReady(input.cwd)`:
        await runtime.updateOwnershipMetadata({ sessionId: input.resumeSessionId }).catch((error) => {
          // Stamp loss must never break a working resume; it only forfeits this
          // sidecar as a future restore claim candidate.
          logger.warn({ err: error }, 'Codex sidecar ownership session stamp failed; restore-claim for this sidecar is degraded')
        })
```

`terminal-registry.ts` — first extend the registry-side sidecar Pick (the `codexSidecar?: Pick<CodexLaunchSidecar, …>` at :619-637) to include `'noteSessionId'` so the new call sites typecheck (`adopt` stays excluded from the retained record, exactly as today). Then a new private helper near the other codex-sidecar helpers, and two call sites:
```ts
  private async noteCodexSidecarSession(record: TerminalRecord, sessionId: string): Promise<void> {
    if (!record.codexSidecar?.noteSessionId) return
    try {
      await record.codexSidecar.noteSessionId(sessionId)
    } catch (error) {
      logger.warn({ err: error, terminalId: record.terminalId, sessionId }, 'Failed to stamp Codex sidecar ownership record with session id; restore-claim for this sidecar is degraded')
    }
  }

// At persistCodexCandidateSerial, immediately after `record.codexSidecar?.markCandidatePersisted?.()`
// (the line following `record.codexDurability = storedDurability`):
    if (storedDurability.candidate) {
      await this.noteCodexSidecarSession(record, storedDurability.candidate.candidateThreadId)
    }

// In stageCodexForkHandoffCandidate, immediately after the
// `record.codexSidecar?.markCandidatePersisted?.()` that follows armCodexRolloutWatch(record, forkCandidate):
    await this.noteCodexSidecarSession(record, forkCandidate.candidateThreadId)
```

- [ ] **Step 4: Run the focused tests**

Run: the same Step-2 command.

Expected: PASS for the new cases; the file's other cases unchanged.

- [ ] **Step 5: Refactor while green**

Confirm the two registry call sites share the single helper (no divergent error handling) and that no file needs `.js`-less imports. No other refactor expected.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: every consumer of the metadata parser/writer, the planner, and the codex-sidecar registry wiring.

Run: `npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/runtime.test.ts test/unit/server/coding-cli/codex-app-server/launch-planner.test.ts test/unit/server/coding-cli/codex-app-server/launch-retry.test.ts test/unit/server/coding-cli/codex-observability.test.ts test/unit/server/terminal-registry.codex-sidecar.test.ts test/unit/server/terminal-registry.codex-recovery.test.ts --config config/vitest/vitest.server.config.ts`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add server/coding-cli/codex-app-server/runtime.ts server/coding-cli/codex-app-server/launch-planner.ts server/terminal-registry.ts test/unit/server/coding-cli/codex-app-server/runtime.test.ts test/unit/server/coding-cli/codex-app-server/launch-planner.test.ts test/unit/server/terminal-registry.codex-sidecar.test.ts
git commit -m "feat(codex): stamp codex thread session id onto sidecar ownership records (kata 4g2a)"
```

---

### Task 2: `CodexAppServerRuntime.attachToSurvivingSidecar` — verified, bounded bind to an already-running sidecar

**Files:**
- Modify: `server/coding-cli/codex-app-server/runtime.ts` (exports, `bindClientEventFanout` extraction, new `attachToSurvivingSidecar`)
- Test: `test/unit/server/coding-cli/codex-app-server/sidecar-reattach.test.ts` (new file; real fixture processes through `createRuntime`-style helpers, temp metadata dirs)

**Interfaces:**
- Consumes: `classifyOwnedProcessGroup`, `concludeIfNotOwned` semantics, `CodexAppServerClient`, `readProcessIdentity`/`processIdentityReader`, `atomicWriteJson` (via `writeOwnershipRecord`), `registerCodexChild` (subject to the pre-implementation check), `ActiveOwnership` (`{ metadataDir, metadataPath, metadata }`).
- Produces (all exported from `runtime.ts`):
  - `type HeldCodexSidecarOwnership = ActiveOwnership` (exported alias the new module and tests share).
  - `const CODEX_REATTACH_PROBE_BUDGET_MS = 3_000`.
  - `type CodexSurvivorAttachErrorCode = 'codex_survivor_identity' | 'codex_survivor_unreachable' | 'codex_survivor_not_writer'`.
  - `function getCodexSurvivorAttachErrorCode(error: unknown): CodexSurvivorAttachErrorCode | null`.
  - `CodexAppServerRuntime.attachToSurvivingSidecar(ownership: HeldCodexSidecarOwnership, options: { sessionId: string; probeBudgetMs?: number }): Promise<ReadyState>` — an instance method on a fresh runtime instance (from the planner's factory); never called on an instance that has spawned.

Semantics, in order: (1) refuse if shutdown requested / already ready / attach-or-spawn in progress; (2) fresh `classifyOwnedProcessGroup` — anything but `owned` throws code `codex_survivor_identity` and the survivor is never signaled; (3) construct a client on the record's `wsUrl`, wire the SAME event fanout as `startRuntime` via the extracted `bindClientEventFanout(client)`, and run BOTH probes (`initialize()` then `listLoadedThreads()`, step 4) against ONE shared ~3s deadline (`const deadline = Date.now() + budgetMs`; each probe gets the remaining time) — a timeout or transport failure at either probe throws `codex_survivor_unreachable` with the client closed; (4) if the claimed `sessionId` is absent from the loaded list, throw `codex_survivor_not_writer` with the client closed (the survivor is kept alive — it may be the writer of nothing for this key); (5) retitle the record in place — `ownerServerPid = process.pid`, fresh complete `ownerServerIdentity` via `processIdentityReader`, `updatedAt` — through the existing atomic writer, and a retitle write failure is FAIL-SOFT: log loudly once and continue with the in-memory ownership (da92's `write_record_loudly` parity — a persistence hiccup must not murder a working sidecar); (6) register the group in the codex child registry (same shape as `startRuntime`'s registration; conditional on the pre-implementation check) and set `this.ownership`, `this.client`, `this.ready = { wsUrl: record.wsUrl, processPid: metadata.wrapperPid, codexHome: initialized.codexHome, ownershipId, processGroupId: metadata.processGroupId, metadataPath }`, `statusValue = 'running'`; return the `ReadyState`. On any error before step 5's successful retitle, no mutation of record or survivor has occurred except the closed probe client.

- [ ] **Step 1: Write the failing behavioral tests**

New file `sidecar-reattach.test.ts` (server-config vitest; helpers below mirror `runtime.test.ts` patterns — real fixture spawns with `command: process.execPath`, temp `metadataDir`, `REAL_STARTUP`-style timeouts):

1. **attach succeeds against a live fixture survivor**: reuse the existing helpers for an AUTHENTIC record — spawn fixture A with a first `createRuntime`-built runtime (`runtime1.ensureReady()` after `runtime1.updateOwnershipMetadata({ sessionId: 'thr-1' })`, so its record carries a real `wrapperIdentity` plus the claim key), then `markOwnershipRecordStale(...)` to simulate the dead owner and hand the record (read back from the temp metadata dir) to a SECOND fresh runtime's `attachToSurvivingSidecar(held, { sessionId: 'thr-1' })`. Fixture A is spawned with `env: { ...defaults, FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({ loadedThreadIds: ['thr-1'] }) }` (the `createRuntime` env merge preserves this), so the survivor's `listLoadedThreads()` answers `['thr-1']` and the writer check has something true to find. The test never calls `runtime1.shutdown()` (the abduction stand-in for runtime1's death); `afterEach` group-kills every tracked fixture pid exactly as `runtime.test.ts` does. Call `attachToSurvivingSidecar(ownership, { sessionId: 'thr-live' })` on a fresh runtime; expect a `ReadyState` whose `wsUrl` is the survivor's, `processPid` the survivor pid; record on disk now has `ownerServerPid === process.pid`; `runtime.shutdown()` afterwards kills the group (pid gone) and unlinks the record.
2. **identity failure refuses without signaling**: spawn a short-lived fixture child, record its pid, let it exit, then write the ownership record against that dead pid (`wrapperIdentity` captured before exit) — classification is `gone`. Expect code `codex_survivor_identity`, the record file still on disk (disposal belongs to the reconciler's settler, not the runtime), and — the safety assertion — a second, still-live fixture process sharing nothing with that record remains alive and unsignaled.
3. **unreachable listener**: record classifies `owned` (live fixture process, authentic identity from the same two-runtime rig as test 1) but the handed-over record's `wsUrl` is rewritten to a port held by the inert `http.Server` from the existing `occupyLoopbackPort` helper (TCP accepts, protocol never answers) → the probe can only time out ⇒ expect `codex_survivor_unreachable`, and the whole attach stays inside the single shared probe deadline (~3s, asserted with the fake-real clock pattern used elsewhere in this suite or simply elapsed-time < budget×1.5).
4. **not-writer survivor kept**: fixture live and listening, `loadedThreadIds: ['thr-other']`, claim `sessionId: 'thr-live'` → expect `codex_survivor_not_writer`; fixture still alive afterwards; record NOT retitled (ownerServerPid unchanged on disk).

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/sidecar-reattach.test.ts --config config/vitest/vitest.server.config.ts`

Expected: FAIL — `attachToSurvivingSidecar` is not a function (method absent).

- [ ] **Step 3: Add the minimal production implementation**

Sketch (structure binding; the test-driven implementation owns exact lines):

```ts
export type HeldCodexSidecarOwnership = ActiveOwnership
export const CODEX_REATTACH_PROBE_BUDGET_MS = 3_000

export type CodexSurvivorAttachErrorCode =
  | 'codex_survivor_identity'
  | 'codex_survivor_unreachable'
  | 'codex_survivor_not_writer'

export function getCodexSurvivorAttachErrorCode(error: unknown): CodexSurvivorAttachErrorCode | null {
  const code = (error as { code?: unknown } | null | undefined)?.code
  return code === 'codex_survivor_identity' || code === 'codex_survivor_unreachable' || code === 'codex_survivor_not_writer' ? code : null
}

function codexSurvivorAttachError(code: CodexSurvivorAttachErrorCode, message: string, cause?: unknown): Error {
  const error = new Error(message, cause !== undefined ? { cause } : undefined)
  ;(error as Error & { code: CodexSurvivorAttachErrorCode }).code = code
  return error
}

async function withProbeBudget<T>(label: string, promise: Promise<T>, budgetMs: number): Promise<T> {
  return await Promise.race([
    promise,
    sleep(budgetMs).then(() => {
      throw codexSurvivorAttachError('codex_survivor_unreachable', `${label} exceeded the ${budgetMs}ms reattach probe budget`)
    }),
  ])
}
// NOTE: the budget argument handed to the two probe calls below is the SHARED remaining time
// (`const probeDeadlineMs = Date.now() + budgetMs; ... = probeDeadlineMs - Date.now()` at each call),
// never a fresh full budgetMs, so initialize + listLoadedThreads together stay inside one ~3s deadline.
```

Class changes:
- Extract `startRuntime`'s client event fanout (the seven `client.onX(...)` wiring blocks) verbatim into `private bindClientEventFanout(client: CodexAppServerClient): void`; `startRuntime` calls it where the blocks stood. (Keep the `client.onDisconnect` semantics identical: `if (this.shutdownRequested) return;` then exit handlers with source `'app_server_client_disconnect'`.)
- Add:

```ts
  async attachToSurvivingSidecar(
    ownership: HeldCodexSidecarOwnership,
    options: { sessionId: string; probeBudgetMs?: number },
  ): Promise<ReadyState> {
    if (this.shutdownRequested) throw new Error('Codex app-server sidecar is shutting down.')
    if (this.ready || this.ensureReadyPromise) {
      throw new Error('Codex app-server sidecar already has a starting or running sidecar; it cannot attach to a survivor.')
    }
    await this.assertNoBlockedOwnership('attach to a surviving Codex app-server sidecar')

    const metadata = ownership.metadata
    const classification = await classifyOwnedProcessGroup(metadata)
    if (classification !== 'owned') {
      throw codexSurvivorAttachError('codex_survivor_identity',
        `Codex survivor sidecar ${metadata.ownershipId} failed ownership re-verification at claim time (${classification}); refusing to signal it`)
    }

    const budgetMs = options.probeBudgetMs ?? CODEX_REATTACH_PROBE_BUDGET_MS
    const probeDeadlineMs = Date.now() + budgetMs  // one shared deadline across both probes
    const client = new CodexAppServerClient(
      { wsUrl: metadata.wsUrl },
      this.requestTimeoutMs ? { requestTimeoutMs: this.requestTimeoutMs } : {},
    )
    this.bindClientEventFanout(client)
    this.client = client
    let initialized: CodexInitializeResult
    try {
      initialized = await withProbeBudget('survivor initialize', client.initialize(), probeDeadlineMs - Date.now())
      const loaded = await withProbeBudget('survivor thread/loaded/list', client.listLoadedThreads(), Math.max(0, probeDeadlineMs - Date.now()))
      if (!loaded.includes(options.sessionId)) {
        throw codexSurvivorAttachError('codex_survivor_not_writer',
          `Codex survivor sidecar ${metadata.ownershipId} is reachable but is not the writer of ${options.sessionId}`)
      }
    } catch (error) {
      if (this.client === client) this.client = null
      await client.close().catch(() => undefined)
      if (getCodexSurvivorAttachErrorCode(error)) throw error
      throw codexSurvivorAttachError('codex_survivor_unreachable',
        `Codex survivor sidecar ${metadata.ownershipId} was not reachable at its recorded listener`, error)
    }

    const ownerServerIdentity = await this.processIdentityReader(process.pid)
    if (!isCompleteWrapperIdentity(ownerServerIdentity)) {
      if (this.client === client) this.client = null
      await client.close().catch(() => undefined)
      throw codexSurvivorAttachError('codex_survivor_unreachable',
        `Codex survivor sidecar ${metadata.ownershipId} could not be retitled: owner identity unreadable`)
    }

    this.ownership = {
      metadataDir: ownership.metadataDir,
      metadataPath: ownership.metadataPath,
      metadata: {
        ...metadata,
        ownerServerPid: process.pid,
        ownerServerIdentity,
        updatedAt: new Date().toISOString(),
      },
    }
    try {
      await this.writeOwnershipRecord(this.ownership)
    } catch (error) {
      logger.warn(
        { err: error, ownershipId: metadata.ownershipId, metadataPath: ownership.metadataPath },
        'Codex survivor ownership retitle write failed; continuing with in-memory ownership (log-and-continue parity)',
      )
    }
    registerCodexChild({
      pid: metadata.wrapperPid,
      pgid: metadata.processGroupId,
      kind: 'app-server',
      envMarker: { name: 'FRESHELL_CODEX_SIDECAR_ID', value: metadata.ownershipId },
    })
    this.ready = {
      wsUrl: metadata.wsUrl,
      processPid: metadata.wrapperPid,
      codexHome: initialized.codexHome,
      ownershipId: metadata.ownershipId,
      processGroupId: metadata.processGroupId,
      metadataPath: ownership.metadataPath,
    }
    this.statusValue = 'running'
    return this.ready
  }
```

Note for the implementer: `attachToSurvivingSidecar` deliberately never spawns, and `ensureReady` must keep its spawn-only semantics — attach sets `this.ready` directly so a later `ensureReady()` returns the attached state (the same `assertCompatibleLaunchCwd` checks apply; an attached runtime has no spawn cwd so `this.readyCwd` stays `undefined`, which is the current "no explicit cwd" behavior).

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/sidecar-reattach.test.ts --config config/vitest/vitest.server.config.ts`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

Confirm `startRuntime` and `attachToSurvivingSidecar` share exactly one fanout implementation; confirm no duplicated probe constants; confirm the fanout extraction left `startRuntime` behavior-identical (its earlier tests pass).

- [ ] **Step 6: Run impacted-test verification**

Run: `npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/runtime.test.ts test/unit/server/coding-cli/codex-app-server/sidecar-reattach.test.ts test/unit/server/coding-cli/codex-observability.test.ts --config config/vitest/vitest.server.config.ts`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add server/coding-cli/codex-app-server/runtime.ts test/unit/server/coding-cli/codex-app-server/sidecar-reattach.test.ts
git commit -m "feat(codex): runtime attach path for surviving app-server sidecars (kata 4g2a)"
```

---

### Task 3: Boot reconcile holds verified survivors; grace-gated sweep claims ownership of the kill decision

**Files:**
- Create: `server/coding-cli/codex-app-server/sidecar-reattach.ts` (`CodexSidecarReconciler`, `resolveCodexSidecarReapGraceMs`, `CODEX_SIDECAR_REAP_GRACE_DEFAULT_MS`)
- Modify: `server/coding-cli/codex-app-server/runtime.ts` (`ReapOrphanedSidecarsOptions` gains `holdReconciler?`/`skipOwnershipIds?`, `ReapOrphanedSidecarsResult` gains `heldOwnershipIds`, the owner-dead branch takes the hold path when a sink is present, skip-set checked before the budget/teardown tail)
- Modify: `server/coding-cli/codex-observability.ts` (`CodexReaperMaintenanceOptions` gains `reconciler?`; the tick's due-gate and the reaper call thread the sweep)
- Modify: `server/index.ts` (construct the reconciler, wire boot reaper + observability; planner wiring lands in Task 4)
- Test: `test/unit/server/coding-cli/codex-app-server/sidecar-reattach.test.ts` (reconciler unit cases appended)
- Test: `test/unit/server/coding-cli/codex-app-server/runtime.test.ts` (reaper hold/skip cases appended)
- Test: `test/unit/server/coding-cli/codex-observability.test.ts` (tick gating cases appended)

**Interfaces:**
- Consumes (from `runtime.ts`, newly exported for this module): `classifyOwnedProcessGroup`, `teardownOwnedProcessGroup`, `HeldCodexSidecarOwnership`, default terminate grace.
- Produces (the planner's Task-4 view of the reconciler; also `index.ts`'s wiring surface):

```ts
export const CODEX_SIDECAR_REAP_GRACE_DEFAULT_MS = 30 * 60 * 1000
export function resolveCodexSidecarReapGraceMs(raw: string | undefined): number // '0' honored; invalid → default + warn

export type CodexSidecarHoldVerdict = 'held' | 'removed-unowned' | 'kept-unproven'

export class CodexSidecarReconciler {
  constructor(options?: { reapGraceMs?: number; nowFn?: () => number; log?: { info(...): void; warn(...): void } })
  hold(ownership: HeldCodexSidecarOwnership): Promise<CodexSidecarHoldVerdict>
  claimForSession(sessionId: string): HeldCodexSidecarOwnership | null   // one-shot; also marks in-flight
  dropClaim(ownershipId: string): void                                   // attach success: fully unmanaged-by-reconciler
  settleFailedClaim(ownership: HeldCodexSidecarOwnership, code: CodexSurvivorAttachErrorCode): Promise<void>
  forget(ownershipIds: string[]): void   // drop ids another actor removed from disk (the sweeper calls it with the reaper's reaped list)
  hasExpired(nowMs?: number): boolean
  sweepProtectionSet(nowMs?: number): Set<string>  // ids the reaper must skip right now
  snapshot(): { held: number; claimableSessions: number; inFlightClaims: number; bootedAtIso: string; reapGraceMs: number }
}
```

Semantics:
- `hold`: fresh `classifyOwnedProcessGroup`. `owned` → record enters `held` (keyed by ownershipId); when `metadata.sessionId` is a non-empty string the id is also pushed into `bySession[sessionId]` kept sorted newest-`updatedAt`-first; log an info line with ownershipId/sessionId/wsUrl; return `'held'`. Any other verdict delegates the record's fate to the existing `teardownOwnedProcessGroup` (which for `gone`/`foreign` unlinks without signaling and for `self`/`indeterminate` refuses and keeps the file): teardown result `true` → return `'removed-unowned'`; `false` → return `'kept-unproven'` (file stays; nothing indexed; the existing retry-in-place reaper branch records the retry as it does for unverifiable records today).
- `claimForSession`: pop ids off `bySession[sessionId]` (skipping ids no longer in `held`) until one held entry is found; that id leaves the session index (one-shot) and enters `inFlightClaims`; return the ownership or `null`.
- `dropClaim`: remove from `held` and `inFlightClaims` (already absent from `bySession`).
- `settleFailedClaim(ownership, code)`: `not_writer` → keep in `held` (remove only from `inFlightClaims`; it never re-enters this session index — its claim was consumed). `identity`/`unreachable` → `await teardownOwnedProcessGroup(ownership, DEFAULT_TERMINATE_GRACE_MS)` (identity rey-verifies internally; `owned` unreachable ⇒ conservative SIGTERM→reclassify→SIGKILL + unlink — the "reap verified-but-unusable survivor" parity; `gone`/`foreign` ⇒ unlink without signals; `self`/`indeterminate` ⇒ refuse, keep file, log), then `dropClaim`. Teardown failure: log warn, still `dropClaim` (the hourly reaper's old path will retry from disk).
- Grace: `bootedAtMs = nowFn()` at construction; `hasExpired(now = nowFn())` is `now - bootedAtMs >= reapGraceMs`; `sweepProtectionSet(now)` returns, before expiry, every `held` id plus every `inFlightClaims` id; after expiry, only `inFlightClaims` ids (an in-flight claim must never be swept out from under the attacher).
- Reaper integration (`runtime.ts`): the scan loop, immediately after the owner-alive self-checks (the current branch tail at the budget check), becomes:

```ts
      const ownership: ActiveOwnership = { metadataDir, metadataPath, metadata }
      if (options.skipOwnershipIds?.has(metadata.ownershipId)) {
        result.skippedActiveOwnershipIds.push(metadata.ownershipId)
        continue
      }
      if (options.holdReconciler) {
        const verdict = await options.holdReconciler.hold(ownership)
        if (verdict === 'held') {
          result.heldOwnershipIds.push(metadata.ownershipId)
          continue
        }
        if (verdict === 'removed-unowned') {
          result.reapedOwnershipIds.push(metadata.ownershipId)
          await fsp.unlink(reaperRetrySidecarPath(metadataPath)).catch(() => undefined)
          continue
        }
        // kept-unproven: identical to today's teardown-refusal branch (in-place retry, never quarantine)
        const state = await recordCodexReaperRetryAttempt(metadataPath)
        logCodexReaperRetry({ ownershipId: metadata.ownershipId, metadataPath, wrapperPid: metadata.wrapperPid, processGroupId: metadata.processGroupId }, state, 'sidecar group ownership could not be verified for a boot hold')
        result.retriedOwnershipIds.push(metadata.ownershipId)
        continue
      }
      // …existing budget check + teardownOwnedProcessGroup branch, unchanged…
```
  (`CodexSidecarHoldSink = { hold(ownership: ActiveOwnership): Promise<'held' | 'removed-unowned' | 'kept-unproven'> }` is declared structurally in `runtime.ts` with the LITERAL union — `runtime.ts` never imports the new module, not even a type-only import of the named `CodexSidecarHoldVerdict`, so the direction of the edge `sidecar-reattach.ts` → `runtime.ts` stays the only import edge.)
- Boot wiring (`server/index.ts`): construct `new CodexSidecarReconciler({ reapGraceMs: resolveCodexSidecarReapGraceMs(process.env.FRESHELL_CODEX_SIDECAR_REAP_GRACE_MS) })` before the existing `runCodexStartupReaper` call; pass `{ serverInstanceId, holdReconciler: reconciler }`; after it, log one structured line with `reconciler.snapshot()`; keep the existing fail-open try/catch unchanged.
- Sweep wiring (`server/coding-cli/codex-observability.ts` `runCodexReaperMaintenanceTick`): after the existing quarantine/due gating computes `due`, also compute `const sweepDue = options.reconciler?.hasExpired() === true && options.reconciler.snapshot().held > 0`; the early-return condition becomes `if (promotedRecords.length === 0 && !due && !sweepDue) return`; the `reapOrphanedCodexAppServerSidecars` call gains `skipOwnershipIds: options.reconciler?.sweepProtectionSet()` (spread like the other optional fields), and its result is consumed so killed records leave the held maps (`options.reconciler?.forget(result.reapedOwnershipIds)` — otherwise `sweepDue` would stay true forever over ghost ids). `startCodexObservability` passes `options.reconciler` through from its own options.

Observed outcome: at boot, previously spawned, provably-owned sidecar groups are no longer killed; their records are held claimable; every record fate is otherwise byte-identical to today; the hourly maintenance reaper regains full authority (kill + unlink) over anything still unclaimed and not in-flight after `FRESHELL_CODEX_SIDECAR_REAP_GRACE_MS` (default 30 min; `0` sweeps at the first tick, which `startCodexObservability` fires immediately at boot — restoring today's kill-at-boot posture).

- [ ] **Step 1: Write the failing behavioral tests**

1. `runtime.test.ts`: fresh fixture process + record with dead owner (existing `markOwnershipRecordStale` pattern) and `holdReconciler` wired ⇒ after `runCodexStartupReaper`, `result.heldOwnershipIds` contains the id, the fixture's process group is still alive, the record file is still on disk, and `reconciler.claimForSession(recordedSessionId)` returns the record exactly once. A second pass with `skipOwnershipIds: new Set([id])` and no sink adds it to `skippedActiveOwnershipIds` and leaves the group alive.
2. `sidecar-reattach.test.ts` (unit, fake ownership objects): `hold` verdicts — `owned` ⇒ `'held'` + session index; `gone` ⇒ `'removed-unowned'` + file unlinked; `self` (record pointing at the test process's own process group) ⇒ `'kept-unproven'` + file intact. `claimForSession` is one-shot; `settleFailedClaim(..., 'codex_survivor_unreachable')` downs a live fixture group conservatively; `('codex_survivor_not_writer')` leaves it alive and held; `sweepProtectionSet` covers held ids before expiry, only in-flight after; `resolveCodexSidecarReapGraceMs` parses `undefined` → default, `'0'` → 0, `'nonsense'` → default + warn.
3. `codex-observability.test.ts`: with an expired reconciler over a settled-dead-owner live fixture record, `runCodexReaperMaintenanceTick({ reconciler, ... })` runs the reaper WITHOUT the id in `skipOwnershipIds` and the record is reaped (process group gone, file unlinked); an unexpired reconciler id IS passed into `skipOwnershipIds` (spy on `reapOrphaned` or observe the survivor alive + file present); with no due retries and a non-expired reconciler the tick's reaper call is skipped entirely; after a reaping tick, `forget(result.reapedOwnershipIds)` prunes the reconciler's maps so reaped ids never linger (claimable-session index included).

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/sidecar-reattach.test.ts test/unit/server/coding-cli/codex-app-server/runtime.test.ts test/unit/server/coding-cli/codex-observability.test.ts --config config/vitest/vitest.server.config.ts -t "hold|reconciler|sweep|reapGrace|survivor"`

Expected: FAIL — module `sidecar-reattach.ts` does not exist; reaper options not accepted; tick ignores reconciler.

- [ ] **Step 3: Add the minimal production implementation**

Implement `sidecar-reattach.ts` exactly to the interface and semantics above (logger import `../../logger.js`, runtime helper imports from `./runtime.js`), plus the `runtime.ts`, `codex-observability.ts`, and `index.ts` wiring described above. No other behavior may change: the no-sink reaper path remains today's code untouched.

- [ ] **Step 4: Run the focused tests**

Run: the Step-2 command.

Expected: PASS.

- [ ] **Step 5: Refactor while green**

Check that the reaper-loop edit is minimal (the untouched no-sink path must be a pure continuation), that `snapshot()` powers the boot log line, and that no module other than `index.ts`/`codex-observability.ts`/`launch-planner.ts` (Task 4) ever holds the reconciler.

- [ ] **Step 6: Run impacted-test verification**

Run: `npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/ test/unit/server/coding-cli/codex-observability.test.ts test/unit/server/terminal-registry.codex-sidecar.test.ts test/unit/server/terminal-registry.codex-recovery.test.ts --config config/vitest/vitest.server.config.ts`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add server/coding-cli/codex-app-server/sidecar-reattach.ts server/coding-cli/codex-app-server/runtime.ts server/coding-cli/codex-observability.ts server/index.ts test/unit/server/coding-cli/codex-app-server/sidecar-reattach.test.ts test/unit/server/coding-cli/codex-app-server/runtime.test.ts test/unit/server/coding-cli/codex-observability.test.ts
git commit -m "feat(codex): hold verified prior-generation sidecars for restore claims with a grace-gated sweep (kata 4g2a)"
```

---

### Task 4: Planner claim seam — resume-keyed `planCreate` tries a survivor claim before spawning

**Files:**
- Modify: `server/coding-cli/codex-app-server/launch-planner.ts` (options, resume branch)
- Modify: `server/index.ts` (pass the reconciler into the planner)
- Test: `test/unit/server/coding-cli/codex-app-server/launch-planner.test.ts`

**Interfaces:**
- Consumes: `CodexSidecarReconciler` (structural interface below), `attachToSurvivingSidecar` from Task 2, Task 1's stamping.
- Produces: `CodexLaunchPlannerOptions.reconciler?: CodexSidecarClaimSource`; `CodexRuntimeLike` returns expand to a Pick that also lists `attachToSurvivingSidecar` (the runtime class satisfies it).

```ts
// launch-planner.ts local structural seam (sidecar-reattach.ts is never imported here):
export type CodexSidecarClaimSource = {
  claimForSession(sessionId: string): HeldCodexSidecarOwnership | null
  dropClaim(ownershipId: string): void
  settleFailedClaim(ownership: HeldCodexSidecarOwnership, code: CodexSurvivorAttachErrorCode): Promise<void>
}
```

Behavior (resume branch only; the fresh branch is untouched):

1. If `input.resumeSessionId` is set AND a reconciler is installed, loop: `claimForSession(sessionId)`; `null` ⇒ fall through to today's spawn path unchanged.
2. For each claimed candidate: mint a runtime from `this.runtimeFactory()`, `createSidecar(runtime, …)` as today, then `await runtime.attachToSurvivingSidecar(candidate, { sessionId })`. On success: build the proxy with `requireCandidatePersistence: false` (resume parity), `proxy.start()`, `activeSidecars.add(sidecar)`, `reconciler.dropClaim(candidate.metadata.ownershipId)`, one `logger.info` with `{ ownershipId, sessionId, wsUrl }` ("Codex restore claimed a surviving sidecar"), and return `{ sessionId: input.resumeSessionId, remote: { wsUrl: proxyReady.wsUrl }, sidecar }` — the same plan shape as today's resume branch.
3. A thrown error carrying a survivor attach code ⇒ `proxy?.close()`, `await reconciler.settleFailedClaim(candidate, code)`, log warn, and continue to the next candidate. On this path the candidate's runtime is provably inert: `attachToSurvivingSidecar` throws before any retitle/ready-state mutation on a coded failure (its client is closed inside the attach's own catch), so `activeSidecars.add(sidecar)` happens ONLY in the success path (point 2) and no `sidecar.shutdown()` is needed; an explicit `activeSidecars` membership assertion in test 3 pins this so the bookkeeping can never silently leak a half-attached runtime into a later planner `shutdown()`.
4. Any other thrown error (uncoded — e.g. proxy start or planner shutdown raced the attach) ⇒ treat the candidate as consumed-then-unowned: `reconciler.dropClaim(...)`, then the existing planCreate catch path (`sidecar.shutdown()` — full ownership-gated teardown of whatever the runtime built/attached — then wrap teardown failures in `codexSidecarTeardownError`), and rethrow so `planCodexLaunchWithRetry`'s fresh spawn produces today's failure semantics.
5. When the loop cannot produce a plan, return `null` (no throw), the caller spawns fresh, and (Task 1) the new record is stamped with the resume session id so a later crash+restore can claim it.

`server/index.ts`: `new CodexLaunchPlanner(() => new CodexAppServerRuntime({ serverInstanceId }), { reconciler: codexSidecarReconciler })`.

- [ ] **Step 1: Write the failing behavioral tests**

Extend `launch-planner.test.ts`'s `FakeRuntime` to implement `attachToSurvivingSidecar` (behavior-scriptable: success / throw with code / throw generic). New cases:

1. resume + claimable candidate + attach success ⇒ plan returned with `sessionId`, proxy started with `requireCandidatePersistence: false`, `ensureReady` (spawn) NEVER called, `dropClaim` called with the claimed id.
2. resume + `claimForSession` returns `null` ⇒ today's spawn path runs (which also stamps the session id per Task 1's test).
3. resume + first candidate throws `codex_survivor_not_writer`, second candidate attaches ⇒ `settleFailedClaim` called once with the code, second candidate becomes the plan's runtime, `dropClaim` only for the second.
4. resume + attach throws an uncoded error ⇒ error propagates; `dropClaim` called; `sidecar.shutdown()` ran (the fake records it); `planCodexLaunchWithRetry`-level behavior is unchanged (the caller owns retries — a comment asserts this contract, no test for the wrapper here since `launch-retry.test.ts` covers it).
5. no `resumeSessionId` ⇒ `claimForSession` never called (spy assertion) even when a reconciler exists; no reconciler installed ⇒ byte-identical legacy behavior (assert candidate spy absent and spawn path ran).

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/launch-planner.test.ts --config config/vitest/vitest.server.config.ts`

Expected: FAIL — no reconciler option exists; `attachToSurvivingSidecar` absent from runtime Pick type.

- [ ] **Step 3: Add the minimal production implementation**

Apply the branch restructure in `planCreate` per the behavior list, keeping the existing catch/`codexSidecarTeardownError` contract byte-identical for errors escaping the claim loop.

- [ ] **Step 4: Run the focused tests**

Run: the Step-2 command.

Expected: PASS.

- [ ] **Step 5: Refactor while green**

Extract `tryPlanSurvivorClaim(input): Promise<CodexLaunchPlan | null>` as a private method so `planCreate`'s pre-existing body keeps its current shape; keep the seam branchess for the fresh path.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: everything that constructs or fakes a planner/runtime pair.

Run: `npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/launch-planner.test.ts test/unit/server/coding-cli/codex-app-server/launch-retry.test.ts test/unit/server/coding-cli/codex-app-server/sidecar-reattach.test.ts test/unit/server/coding-cli/codex-app-server/runtime.test.ts test/server/ws-terminal-create-reuse-running-codex.test.ts test/server/ws-terminal-create-session-repair.test.ts --config config/vitest/vitest.server.config.ts`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add server/coding-cli/codex-app-server/launch-planner.ts server/index.ts test/unit/server/coding-cli/codex-app-server/launch-planner.test.ts
git commit -m "feat(codex): restore-time planner claims a surviving sidecar before spawning (kata 4g2a)"
```

---

### Task 5: End-to-end proof at the planner+runtime layer (three-scenario parity) and close-out

**Files:**
- Test: `test/unit/server/coding-cli/codex-app-server/sidecar-reattach.test.ts` (three integration scenarios appended; they use real fixture processes, temp metadata dirs, the real `CodexLaunchPlanner`/`CodexAppServerRuntime`, and a `CodexAppServerClient` playing the TUI through the plan's remote proxy)
- (No production-file changes are expected; a failure here feeds back into Tasks 2-4 by the smallest faithful repair.)

**Interfaces:**
- Consumes: everything from Tasks 1-4; fixture knobs `loadedThreadIds`, `appendThreadOperationLogPath`, `overrides`, `FAKE_CODEX_APP_SERVER_BEHAVIOR`; test helpers `makeTempDir`/`createRuntime`-style spawn; `allocateLocalhostPort`.
- Produces: the kata's durable proof test suite.

Scenario shape (mirrors the Rust e2e trio):

1. **Restore reattaches to the surviving sidecar.** Spawn survivor fixture A detached (behavior `{ loadedThreadIds: ['thr-A'], appendThreadOperationLogPath: logA }`), write its ownership record into a temp metadata dir (dead `ownerServerPid`, `sessionId: 'thr-A'`, complete matching `wrapperIdentity`, `wsUrl` = A's listener). Build a reconciler, run the boot pass (`runCodexStartupReaper({ serverInstanceId, metadataDir, holdReconciler })`), then `new CodexLaunchPlanner(() => new CodexAppServerRuntime({ metadataDir, serverInstanceId, command: process.execPath, commandArgs: [FAKE_SERVER_PATH], env: freshSpawnEnv }), { reconciler })` and `await planner.planCreate({ cwd: spawnCwd, resumeSessionId: 'thr-A' })`. Then play the TUI: connect a `CodexAppServerClient` to `plan.remote.wsUrl`, `initialize()`, `resumeThread({ threadId: 'thr-A' })` and expect success. Assert: logA records the resume request served by A's own `listenUrl` (the decisive reattach evidence); `kill(pid, 0)` shows A's process alive in the same incarnation (no respawn); `adopt({ terminalId: 't-1', generation: 0 })` retitles the record (`terminalId` now 't-1'); `reconciler.claimForSession('thr-A')` now returns `null` (claim was one-shot).
2. **No tracked survivor falls back to byte-compatible fresh spawn.** Empty metadata dir; same wiring; `planCreate({ cwd, resumeSessionId: 'thr-B' })` spawns a NEW fixture B; `resumeThread({ threadId: 'thr-B' })` through the plan's proxy succeeds against B's op log; a fresh ownership record materializes in the temp dir with `sessionId: 'thr-B'` (Task 1 stamp), `ownerServerPid === process.pid`. Also assert the spawn argv integrity via the fixture's arg-log env knob (`FAKE_CODEX_APP_SERVER_ARG_LOG`): args contain `app-server`, `--listen`, and the managed remote config args — unchanged from the pre-feature spawn path.
3. **Active-writer collision stays confined to the fresh path.** Fresh spawn against fixture C launched with `overrides: { 'thread/resume': { error: { code: -32600, message: 'thread already has an active writer' } } }`: the resume errors with that code/message. Together with scenario 1 this pins the da92 asymmetry: the SAME resume succeeds against a claimed survivor and is rejected only when a second sidecar adopts the thread.

Every spawned fixture is tracked in a registry local to the test file and group-killed in `afterEach` through the same pgid-targeted conservative helper style as `runtime.test.ts`; temp dirs under `os.tmpdir()` removed in `afterEach`.

Close-out checks (run once, recorded in the evidence log, not as a standing test):

- Store disjointness (delta-scoped, the reachable form): `grep -rn "rust-codex-sidecars" server/ test/ | wc -l` ⇒ `0`, and `git diff --name-only <base_ref>..HEAD -- crates/ | wc -l` ⇒ `0` (the plan touches nothing under `crates/`; the Rust lane's own comments referencing Node's store are pre-existing boundary documentation and are NOT evidence of coupling — a whole-tree grep for the store names is therefore the wrong instrument and is deliberately not used).
- Full QA gate (exact commit, clean tree): `darkforge qa --repo '/home/dan/code/freshell' --id '4g2a'` ⇒ exit 0, or exit nonzero only with failure identities subtended by the baseline ledger (the three `test/unit/vite-config.test.ts > getNetworkHost` identities).
- Work-source candidate verification (data, not a waiver): `npm run check` — it is the same typecheck+coordinated-suite component the gate already runs; run it once directly for the receipt trail.
- Real-binary premise pointer: the da92 lane's landed analysis proved a surviving app-server accepts a NEW ws connection after its owner died (`docs/plans/2026-08-10-codex-sidecar-lifecycle.md` P:271-286 + its e2e); this plan's proof uses the faithful fixture. Record the pointer in the close-out evidence log.

- [ ] **Step 1: Write the failing behavioral tests**

The three scenarios above, written against the landed Task 1-4 code, first run WOULD fail against the pre-feature tree (no `holdReconciler` option → boot pass kills the survivor; no claim seam → spawn-only). Where they can run first on the pre-feature tree they must fail for the intended reason: scenario 1 fails because A is killed at boot / no claim exists.

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/sidecar-reattach.test.ts --config config/vitest/vitest.server.config.ts -t "scenario"`

Expected: FAIL — with the reconciler option absent there is no claim, so scenario 1's decisive assertion (the resume is served by survivor A's listener, per A's op log) fails because the plan spawns a fresh instance instead. The intended negative control: the same test file run once with the `reconciler` option removed from the planner construction (local throwaway edit, reverted immediately); record the outcome in the task evidence.

- [ ] **Step 3: Add the minimal production implementation**

Only whatever the scenarios force back into Tasks 2-4. No new production surface in this task.

- [ ] **Step 4: Run the focused tests**

Run: `npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/sidecar-reattach.test.ts --config config/vitest/vitest.server.config.ts`

Expected: PASS, including the op-log reattach assertion.

- [ ] **Step 5: Refactor while green**

Extract any repeated fixture-survivor rig into the test file's local helpers; production refactor: none expected.

- [ ] **Step 6: Run impacted-test verification + gate**

Run: `npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/ test/unit/server/coding-cli/codex-observability.test.ts test/unit/server/terminal-registry.codex-sidecar.test.ts test/unit/server/terminal-registry.codex-recovery.test.ts test/server/ws-terminal-create-reuse-running-codex.test.ts --config config/vitest/vitest.server.config.ts`

Expected: PASS. Then the close-out checks listed above.

- [ ] **Step 7: Commit the task**

```bash
git add test/unit/server/coding-cli/codex-app-server/sidecar-reattach.test.ts
git commit -m "test(codex): three-scenario restore-reattach proof at the planner+runtime layer (kata 4g2a)"
```

---

## Final gate and landing notes

1. The complete gate for the landing commit is `darkforge qa --repo '/home/dan/code/freshell' --id '4g2a'` on a clean tree at the exact HEAD being landed; nonzero exit is acceptable only when every parsed failure identity is in the completed baseline ledger (the three `getNetworkHost` failures).
2. Run-only bookkeeping (`docs/plans/2026-09-05-4g2a-node-codex-sidecar-reattach.md`, this plan itself) is excluded from the landing squash, per the run contract's landing rules; all `server/` and `test/` changes constitute the substantive delta.
3. If a review or gate forces remediation, remediate on the owner branch in a fresh commit and re-run the per-task gate that covers the change before the next full gate.
