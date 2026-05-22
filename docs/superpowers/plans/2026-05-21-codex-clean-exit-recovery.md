# Codex Clean Exit Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Freshell from auto-recovering durable Codex terminals when the visible Codex PTY exits cleanly with code 0.

**Architecture:** Keep durable recovery for unexpected Codex worker loss, nonzero PTY exits, signals, and app-server lifecycle loss. Treat a clean Codex PTY exit as final only after confirming it is not associated with an active, unconfirmed, restored, or recently observed in-progress turn. Use the Codex app-server's paged `thread/turns/list` contract for lightweight recent-turn inspection, request full item detail only for Freshcodex page/body hydration, and fall back to `thread/read` synthesis when the experimental paged method is unavailable. Coalesce clean PTY exits into existing lifecycle-loss recovery when recovery or pre-durable lifecycle-loss proof is already pending. Cover the behavior with TerminalRegistry recovery tests, app-server client contract tests, and the public API/WS/UI blocked-input surfaces.

**Tech Stack:** TypeScript, Node.js, node-pty, Vitest, Freshell TerminalRegistry.

---

## File Structure

- Modify `server/terminal-registry.ts`: change both durable Codex PTY-exit recovery decision points so a clean idle exit finishes the terminal, while clean exits with active/unconfirmed/restored in-progress turn evidence still recover.
- Modify `server/coding-cli/codex-app-server/client.ts` and `protocol.ts`: add paged `thread/turns/list` support, pass `itemsView` per call, hydrate individual turns by following cursors, and fall back to `thread/read` when paged listing is unavailable.
- Modify `test/unit/server/terminal-registry.codex-recovery.test.ts`: add focused regression tests for initial clean durable Codex PTY exit, recovered clean durable Codex PTY exit, signal exits, active/in-progress turn exits, clean PTY exit during lifecycle-loss recovery, and clean PTY exit during pre-durable lifecycle-loss proof.
- Modify app-server fake, client, schema traceability, and real readiness-contract tests so paged turn listing and cursor progression are covered.
- Modify terminal input blocked plumbing to distinguish lifecycle-loss proof, durable recovery, and clean-exit decision pending states when reporting blocked input to clients.
- Extend WS, `/api/run`, `/api/panes/:id/send-keys`, TerminalView, and browser-level resilience coverage so the new blocked-input reason and clean-exit final UX are pinned at their public surfaces.
- Coalesce duplicate pre-durable lifecycle-loss proof notifications while proof is already pending, and cover the `/api/panes/:id/send-keys` blocked-input surface.
- No README or `docs/index.html` update is needed because this is a bug fix to terminal lifecycle behavior, not an end-user feature or major UI change.

## Scope

This plan only changes terminal lifecycle handling for Codex PTY exits. It does not change Codex app-server launch arguments, plugin/MCP configuration, or session history rendering.

### Task 1: Add Regression Coverage For Clean Durable Codex Exit

**Files:**
- Test: `test/unit/server/terminal-registry.codex-recovery.test.ts`

- [ ] **Step 1: Write the failing clean-exit test**

Insert this test after `it('recovers a durable Codex terminal when the visible PTY exits unexpectedly', ...)`:

```ts
  it('keeps a durable Codex PTY exit final when the visible process exits cleanly', async () => {
    const exited = vi.fn()
    registry.on('terminal.exit', exited)
    const currentSidecar = createFakeSidecar()
    const replacementSidecar = createFakeSidecar()
    const planCreate = vi.fn(async () => ({
      sessionId: 'thread-durable-1',
      remote: { wsUrl: 'ws://127.0.0.1:46002/' },
      sidecar: replacementSidecar,
    }))
    const record = registry.create({
      mode: 'codex',
      cwd: '/repo',
      resumeSessionId: 'thread-durable-1',
      providerSettings: {
        codexAppServer: {
          wsUrl: 'ws://127.0.0.1:46001/',
          sidecar: currentSidecar,
          recovery: { planCreate, retryDelayMs: 0 },
        },
      } as any,
    })
    const [pty] = await spawnedPtys()

    pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: 0 })

    expect(planCreate).not.toHaveBeenCalled()
    expect(replacementSidecar.adopt).not.toHaveBeenCalled()
    expect(registry.get(record.terminalId)?.status).toBe('exited')
    expect(registry.get(record.terminalId)?.exitCode).toBe(0)
    expect(exited).toHaveBeenCalledWith({ terminalId: record.terminalId, exitCode: 0 })
  })
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
npm run test:vitest -- test/unit/server/terminal-registry.codex-recovery.test.ts -t "keeps a durable Codex PTY exit final when the visible process exits cleanly" --run
```

Expected: FAIL because `planCreate` is called and the terminal remains in durable recovery instead of exiting.

- [ ] **Step 3: Add recovered clean-exit coverage before implementation**

Insert this test after the clean-exit test to cover the recovery-created PTY handler:

```ts
  it('keeps a recovered durable Codex PTY exit final when the replacement process exits cleanly', async () => {
    const exited = vi.fn()
    registry.on('terminal.exit', exited)
    const currentSidecar = createFakeSidecar()
    const replacementSidecar = createFakeSidecar()
    const planCreate = vi.fn(async () => ({
      sessionId: 'thread-durable-1',
      remote: { wsUrl: 'ws://127.0.0.1:46002/' },
      sidecar: replacementSidecar,
    }))
    const record = registry.create({
      mode: 'codex',
      cwd: '/repo',
      resumeSessionId: 'thread-durable-1',
      providerSettings: {
        codexAppServer: {
          wsUrl: 'ws://127.0.0.1:46001/',
          sidecar: currentSidecar,
          recovery: { planCreate, retryDelayMs: 0 },
        },
      } as any,
    })
    const [oldPty] = await spawnedPtys()

    oldPty.onExit.mock.calls[0][0]({ exitCode: 1, signal: 0 })

    await vi.waitFor(() => expect(replacementSidecar.adopt).toHaveBeenCalledWith({ terminalId: record.terminalId, generation: 1 }))
    const [, replacementPty] = await spawnedPtys()

    replacementPty.onExit.mock.calls[0][0]({ exitCode: 0, signal: 0 })

    expect(planCreate).toHaveBeenCalledTimes(1)
    expect(registry.get(record.terminalId)?.status).toBe('exited')
    expect(registry.get(record.terminalId)?.exitCode).toBe(0)
    expect(exited).toHaveBeenCalledWith({ terminalId: record.terminalId, exitCode: 0 })
  })
```

- [ ] **Step 4: Add lifecycle-loss coalescing coverage before implementation**

Add a fake sidecar lifecycle-loss emitter and regression tests proving that if app-server lifecycle loss already started recovery, or started final pre-durable rollout proof, a later clean PTY exit does not finalize the terminal or unblock input before the replacement PTY is adopted.

Add a regression test proving that a replacement PTY clean exit is still final if it happens after the replacement is published as the current PTY but before recovery bookkeeping has fully settled.

- [ ] **Step 5: Add signal-exit coverage before implementation**

Insert this test after the clean-exit test:

```ts
  it('recovers a durable Codex terminal when the visible PTY exits from a signal', async () => {
    const exited = vi.fn()
    registry.on('terminal.exit', exited)
    const currentSidecar = createFakeSidecar()
    const replacementSidecar = createFakeSidecar()
    const planCreate = vi.fn(async () => ({
      sessionId: 'thread-durable-1',
      remote: { wsUrl: 'ws://127.0.0.1:46002/' },
      sidecar: replacementSidecar,
    }))
    const record = registry.create({
      mode: 'codex',
      cwd: '/repo',
      resumeSessionId: 'thread-durable-1',
      providerSettings: {
        codexAppServer: {
          wsUrl: 'ws://127.0.0.1:46001/',
          sidecar: currentSidecar,
          recovery: { planCreate, retryDelayMs: 0 },
        },
      } as any,
    })
    const [oldPty] = await spawnedPtys()

    oldPty.onExit.mock.calls[0][0]({ exitCode: 0, signal: 15 })

    await vi.waitFor(() => expect(replacementSidecar.adopt).toHaveBeenCalledWith({ terminalId: record.terminalId, generation: 1 }))
    expect(planCreate).toHaveBeenCalledWith(expect.objectContaining({
      terminalId: record.terminalId,
      resumeSessionId: 'thread-durable-1',
      generation: 1,
    }))
    expect(registry.get(record.terminalId)?.status).toBe('running')
    expect(exited).not.toHaveBeenCalled()
  })
```

- [ ] **Step 6: Run all new tests and verify current behavior**

Run:

```bash
npm run test:vitest -- test/unit/server/terminal-registry.codex-recovery.test.ts -t "visible PTY exits" --run
```

Expected: the initial clean-exit and recovered clean-exit tests fail before implementation; the signal-exit test passes or remains skipped by the name filter depending on Vitest matching. If the name filter does not select all tests, run the full file command after implementation.

### Task 2: Implement Clean-Exit Guard

**Files:**
- Modify: `server/terminal-registry.ts`
- Test: `test/unit/server/terminal-registry.codex-recovery.test.ts`

- [ ] **Step 1: Add a helper for clean PTY exits**

In `server/terminal-registry.ts`, near the existing private helper methods, add:

```ts
  private isCleanPtyExit(event: { exitCode: number; signal?: number }): boolean {
    return event.exitCode === 0 && (!event.signal || event.signal === 0)
  }

  private shouldRecoverCodexPtyExit(record: TerminalRecord, event: { exitCode: number; signal?: number }): boolean {
    return Boolean(record.codexRecoveryAttempt || record.codexLifecycleLossProofPending) || !this.isCleanPtyExit(event)
  }
```

- [ ] **Step 2: Use the helper before starting durable recovery for initial PTY exits**

In the `ptyProc.onExit((e) => { ... })` block, replace the current `finishExit` function with:

```ts
      const finishExit = () => {
        if (
          this.shouldRecoverCodexPtyExit(record, e)
          && this.startCodexDurableRecovery(record, {
            source: 'pty_exit',
            exitCode: e.exitCode,
            signal: e.signal,
          })
        ) {
          return
        }
        this.finishTerminalPtyExit(record, e)
      }
```

- [ ] **Step 3: Use the helper before starting durable recovery for recovered PTY exits**

In `attachCodexRecoveryPtyHandlers(...)`, replace the current `finishExit` function with:

```ts
      const finishExit = () => {
        if (
          this.shouldRecoverCodexPtyExit(record, event)
          && this.startCodexDurableRecovery(record, {
            source: 'pty_exit',
            exitCode: event.exitCode,
            signal: event.signal,
          })
        ) {
          return
        }
        this.finishTerminalPtyExit(record, event)
      }
```

- [ ] **Step 4: Run focused recovery tests**

Run:

```bash
npm run test:vitest -- test/unit/server/terminal-registry.codex-recovery.test.ts --run
```

Expected: PASS. The clean-exit test should now finalize the terminal, and the existing nonzero-exit recovery test should still recover.

- [ ] **Step 5: Run nearby TerminalRegistry tests**

Run:

```bash
npm run test:vitest -- test/unit/server/terminal-registry.test.ts test/unit/server/terminal-registry.codex-sidecar.test.ts test/unit/server/terminal-registry.codex-recovery.test.ts --run
```

Expected: PASS.

- [ ] **Step 6: Commit the implementation**

Run:

```bash
git add server/terminal-registry.ts test/unit/server/terminal-registry.codex-recovery.test.ts docs/superpowers/plans/2026-05-21-codex-clean-exit-recovery.md
git commit -m "fix: stop recovering clean Codex exits"
```

Expected: commit succeeds with the plan, test, and implementation.

### Task 3: Verify And Review

**Files:**
- Verify: `server/terminal-registry.ts`
- Verify: `test/unit/server/terminal-registry.codex-recovery.test.ts`

- [ ] **Step 1: Run coordinated status before broad verification**

Run:

```bash
npm run test:status
```

Expected: either `state: idle` or a clear holder status. If another agent holds the gate, wait rather than killing it.

- [ ] **Step 2: Run the repo check**

Run:

```bash
FRESHELL_TEST_SUMMARY="verify Codex clean exit recovery fix" npm run check
```

Expected: typecheck and coordinated test suite pass.

- [ ] **Step 3: Run fresh-eyes review**

Run:

```bash
bash "/home/dan/.codex/skills/fresheyes/fresheyes.sh" --claude "Review the changes between origin/main and this branch using git diff origin/main...HEAD."
```

Expected: independent review returns either no findings or actionable issues.

- [ ] **Step 4: Fix actionable review findings**

For each valid issue, update the smallest relevant files. If the issue concerns clean-exit classification, prefer changing `isCleanPtyExit(...)` and adding or adjusting a unit test in `test/unit/server/terminal-registry.codex-recovery.test.ts`.

- [ ] **Step 5: Repeat review loop up to three total times**

After each fix, run:

```bash
npm run test:vitest -- test/unit/server/terminal-registry.codex-recovery.test.ts --run
git add server/terminal-registry.ts test/unit/server/terminal-registry.codex-recovery.test.ts
git commit -m "fix: address Codex clean exit review"
bash "/home/dan/.codex/skills/fresheyes/fresheyes.sh" --claude "Review the changes between origin/main and this branch using git diff origin/main...HEAD."
```

Expected: stop after a review with no findings or after three review attempts.

## Self-Review

Spec coverage: The plan covers the user-facing rule that `exitCode: 0` should complete the terminal instead of recovering for both initial and recovered Codex PTYs. It preserves recovery for nonzero exits, signal exits, app-server lifecycle loss, duplicate PTY exits while lifecycle-loss recovery is already pending, and clean PTY exits that race with pre-durable lifecycle-loss proof.

Placeholder scan: No `TBD`, `TODO`, or open-ended test instructions remain. The only flexible step is the review-fix loop, which depends on actual independent findings.

Type consistency: The helpers use the same event shape already passed to `startCodexDurableRecovery` for PTY exits: `{ exitCode: number; signal?: number }`. Test names and expected registry behavior match existing `TerminalRegistry` test helpers.
