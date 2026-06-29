# Codex Startup Update Prompt Implementation Plan

> **Status:** Implemented on `fix/codex-managed-update-prompt`. This document is retained as the completed implementation runbook, not as pending instructions. A final review changed Task 2 from the original freshness-TTL design to the shipped TTL-free design: once Freshell has detected the Codex startup update prompt, the prompt remains answerable until the user chooses an option or the Codex input gate is cleared.

**Goal:** Allow users and supported automation surfaces to accept, skip, or run Codex CLI startup updates in terminal-mode Codex panes while Freshell is still waiting for Codex restore identity capture.

**Architecture:** Keep the visible-TUI fix in the server-side terminal input gate because all terminal-mode PTY writes route through `TerminalRegistry.inputIfSessionMatches()`. Replace scrollback-time prompt detection with live-output startup prompt state stored per terminal, and model `Update now` as an updater lifecycle rather than a restored Codex session. Pause the Codex remote proxy's candidate-capture deadline while a visible startup update prompt/updater is active, then re-arm it when startup resumes.

**Tech Stack:** Node.js/TypeScript ESM, Express, node-pty, Vitest, existing Freshell fake PTY test harness.

## Global Constraints

- Worktree: `/home/dan/code/freshell/.worktrees/codex-managed-update-prompt` on branch `fix/codex-managed-update-prompt`.
- Do not create or open a PR without explicit user approval.
- Do not restart the self-hosted Freshell server.
- Preserve unrelated changes from other agents.
- Use Red-Green-Refactor TDD for behavior changes.
- Server uses NodeNext/ESM; relative imports must include `.js` extensions.
- Freshell must not set `check_for_update_on_startup=false` for visible managed Codex terminal launches.
- Hidden managed Codex app-server launch config must not disable update checks; source validation shows current `codex app-server` bypasses the interactive TUI update prompt path.
- Do not use retained terminal scrollback as the active update-prompt signal.
- Codex update-prompt numeric keys `1`, `2`, and `3` are completed selections.
- While identity is pending, Freshell does not forward update-prompt arrow navigation; it accepts numeric selections and bare Enter for the default `Update now` selection only.
- While restore identity is pending, normal prompt text remains blocked unless the terminal has explicitly entered the updater lifecycle.
- REST `send-keys` token strings must normalize consistently with CLI/MCP key token handling.

---

## File Structure

- Modify `server/terminal-registry.ts`
  - Owns PTY output observation, per-terminal Codex input-gate state, menu input forwarding, updater-lifecycle transition, candidate-timeout handling, and normal/updater input writes.
- Modify `server/coding-cli/codex-app-server/remote-proxy.ts`
  - Owns pausing and re-arming the candidate-capture timer while the visible terminal is blocked on Codex's startup update prompt/updater.
- Modify `server/coding-cli/codex-app-server/launch-planner.ts`
  - Exposes the remote proxy pause/rearm hook through `CodexLaunchSidecar`.
- Modify `server/coding-cli/codex-managed-config.ts`
  - Remove the accidental `check_for_update_on_startup=false` managed launch config.
- Modify `server/agent-api/router.ts`
  - Normalize REST `keys` token strings via the shared CLI key translator while preserving `data` and `text` raw behavior.
- Modify `test/unit/server/terminal-registry.codex-sidecar.test.ts`
  - Regression and state-machine coverage for update prompt detection, chunked output, stale output, menu selections, updater lifecycle, and candidate timeouts.
- Modify `test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts`
  - Coverage for pausing and re-arming the candidate-capture timeout.
- Modify `test/unit/server/coding-cli/codex-app-server/launch-planner.test.ts`
  - Coverage that sidecars expose the proxy candidate-capture pause/rearm hook.
- Modify `test/unit/server/terminal-registry.test.ts`
  - Assert managed remote Codex launches keep `features.apps=false` but no longer disable update checks.
- Modify `test/unit/server/coding-cli/codex-app-server/runtime.test.ts`
  - Assert managed app-server launches keep `features.apps=false` and no longer disable update checks.
- Modify `test/server/agent-send-keys.test.ts`
  - Assert REST `keys: "ENTER"` and `keys: ["2", "ENTER"]` normalize through shared token handling.

---

### Task 1: Stop Disabling Managed Codex Update Checks

**Files:**
- Modify: `server/coding-cli/codex-managed-config.ts`
- Modify: `test/unit/server/terminal-registry.test.ts`
- Modify: `test/unit/server/coding-cli/codex-app-server/runtime.test.ts`

**Interfaces:**
- Consumes: existing `CODEX_MANAGED_REMOTE_CONFIG_ARGS` constant.
- Produces: visible terminal launch args that contain only `-c`, `features.apps=false`.
- Produces: hidden app-server launch args that contain only `-c`, `features.apps=false`.

- [x] **Step 1: Write the failing tests**

In `test/unit/server/terminal-registry.test.ts`, change the managed remote-launch expectation so only `features.apps=false` is asserted in the first four arg positions and the update-check flag is explicitly absent:

```ts
expect(spec.args.slice(0, 4)).toEqual([
  '--remote',
  'ws://127.0.0.1:4567',
  '-c',
  'features.apps=false',
])
expect(spec.args).not.toContain('check_for_update_on_startup=false')
expectCodexMcpArgs(spec.args)
```

In `test/unit/server/coding-cli/codex-app-server/runtime.test.ts`, keep the `features.apps=false` assertions and replace the update-check expectations with:

```ts
expect(args).not.toContain('check_for_update_on_startup=false')
expect(args.indexOf('features.apps=false')).toBeLessThan(args.indexOf('app-server'))
```

- [x] **Step 2: Run tests to verify they fail**

Run:

```bash
npm run test:vitest -- run test/unit/server/terminal-registry.test.ts test/unit/server/coding-cli/codex-app-server/runtime.test.ts
```

Expected: FAIL because visible terminal launch args still include `check_for_update_on_startup=false`.

- [x] **Step 3: Write minimal implementation**

Change `server/coding-cli/codex-managed-config.ts` to:

```ts
export const CODEX_MANAGED_REMOTE_CONFIG_ARGS = [
  '-c',
  'features.apps=false',
] as const
```

- [x] **Step 4: Run tests to verify they pass**

Run:

```bash
npm run test:vitest -- run test/unit/server/terminal-registry.test.ts test/unit/server/coding-cli/codex-app-server/runtime.test.ts
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add server/coding-cli/codex-managed-config.ts test/unit/server/terminal-registry.test.ts test/unit/server/coding-cli/codex-app-server/runtime.test.ts
git commit -m "fix(codex): keep managed update checks enabled"
```

---

### Task 2: Add Live Update-Prompt Gate State

**Files:**
- Modify: `server/terminal-registry.ts`
- Modify: `test/unit/server/terminal-registry.codex-sidecar.test.ts`

**Interfaces:**
- Consumes: existing `TerminalRecord.codexInputGate`, PTY `onData`, and `inputIfSessionMatches()`.
- Produces: per-terminal `codexInputGate` union with:
  - `state: 'identity_pending'`
  - optional live `startupOutputTail`
  - optional `startupUpdatePrompt: true`
  - `state: 'update_running'`
- Produces helper behavior:
  - `observeCodexStartupOutput(record, data)` updates a bounded live-output tail only while identity is pending.
  - `hasCodexStartupUpdatePrompt(text)` detects the update prompt without requiring `Update available!`.
  - `handleCodexStartupUpdatePromptInput(record, data)` forwards only menu/control input and transitions state.

- [x] **Step 1: Write failing update-prompt tests**

In `test/unit/server/terminal-registry.codex-sidecar.test.ts`, replace the existing `allows Codex update prompt menu replies while restore identity is pending` test and add focused tests covering:

```ts
it('allows Codex update prompt menu replies without the optional update banner', () => {
  const registry = new TerminalRegistry()
  const term = registry.create({
    mode: 'codex',
    providerSettings: {
      codexAppServer: {
        wsUrl: 'ws://127.0.0.1:43123',
        sidecar: createFakeSidecar(),
      },
    } as any,
  })

  const pty = mockPtyProcess.instances[0]
  pty._emitData([
    'Release notes: https://github.com/openai/codex/releases/latest\r\n',
    '\r\n',
    '› 1. Update now (runs `npm install -g @openai/codex`)\r\n',
    '  2. Skip\r\n',
    '  3. Skip until next version\r\n',
    '\r\n',
    'Press enter to continue\r\n',
  ].join(''))

  expect(registry.input(term.terminalId, '2')).toEqual({ status: 'written' })
  expect(pty.write).toHaveBeenLastCalledWith('2')
  expect(registry.input(term.terminalId, 'hello\r')).toEqual({
    status: 'blocked_codex_identity_pending',
    terminalId: term.terminalId,
  })
})
```

```ts
it('detects the Codex update prompt across split PTY chunks with terminal controls', () => {
  const registry = new TerminalRegistry()
  const term = registry.create({
    mode: 'codex',
    providerSettings: {
      codexAppServer: {
        wsUrl: 'ws://127.0.0.1:43123',
        sidecar: createFakeSidecar(),
      },
    } as any,
  })

  const pty = mockPtyProcess.instances[0]
  pty._emitData('\x1b[1mRelease notes: https://github.com/openai/codex/releases/latest\x1b[0m\r\n')
  pty._emitData('› 1. Update now (runs `npm install -g @openai/codex`)\r\n')
  pty._emitData('  2. Skip\r\n')
  pty._emitData('  3. Skip until next version\r\n')
  pty._emitData('Press enter to continue\r\n')

  expect(registry.input(term.terminalId, '\r')).toEqual({ status: 'written' })
  expect(pty.write).toHaveBeenLastCalledWith('\r')
})
```

```ts
it('updates startup prompt state before any client-visible output can trigger reentrant input', () => {
  const registry = new TerminalRegistry()
  const term = registry.create({
    mode: 'codex',
    providerSettings: {
      codexAppServer: {
        wsUrl: 'ws://127.0.0.1:43123',
        sidecar: createFakeSidecar(),
      },
    } as any,
  })

  const pty = mockPtyProcess.instances[0]
  const client = {
    readyState: 1,
    send: vi.fn((payload: string) => {
      if (payload.includes('Press enter to continue')) {
        registry.input(term.terminalId, '2')
      }
    }),
    close: vi.fn(),
  } as any

  registry.attach(term.terminalId, client)
  pty._emitData([
    'Release notes: https://github.com/openai/codex/releases/latest\r\n',
    '› 1. Update now (runs `npm install -g @openai/codex`)\r\n',
    '  2. Skip\r\n',
    '  3. Skip until next version\r\n',
    'Press enter to continue\r\n',
  ].join(''))

  expect(pty.write).toHaveBeenCalledWith('2')
})
```

```ts
it('does not open the Codex identity gate for similar non-prompt release text', () => {
  const registry = new TerminalRegistry()
  const term = registry.create({
    mode: 'codex',
    providerSettings: {
      codexAppServer: {
        wsUrl: 'ws://127.0.0.1:43123',
        sidecar: createFakeSidecar(),
      },
    } as any,
  })

  const pty = mockPtyProcess.instances[0]
  pty._emitData([
    'Release notes: https://github.com/openai/codex/releases/latest\r\n',
    'Press enter to continue reading the changelog\r\n',
  ].join(''))

  expect(registry.input(term.terminalId, '\r')).toEqual({
    status: 'blocked_codex_identity_pending',
    terminalId: term.terminalId,
  })
})
```

```ts
it('does not reuse stale update prompt output after a skip selection', () => {
  const registry = new TerminalRegistry()
  const term = registry.create({
    mode: 'codex',
    providerSettings: {
      codexAppServer: {
        wsUrl: 'ws://127.0.0.1:43123',
        sidecar: createFakeSidecar(),
      },
    } as any,
  })

  const pty = mockPtyProcess.instances[0]
  pty._emitData([
    'Release notes: https://github.com/openai/codex/releases/latest\r\n',
    '› 1. Update now (runs `npm install -g @openai/codex`)\r\n',
    '  2. Skip\r\n',
    '  3. Skip until next version\r\n',
    'Press enter to continue\r\n',
  ].join(''))

  expect(registry.input(term.terminalId, '2')).toEqual({ status: 'written' })
  pty._emitData('Codex starting normally now\r\n')

  expect(registry.input(term.terminalId, '\r')).toEqual({
    status: 'blocked_codex_identity_pending',
    terminalId: term.terminalId,
  })
})
```

```ts
it('blocks update prompt arrow navigation rather than tracking highlight state', () => {
  const registry = new TerminalRegistry()
  const term = registry.create({
    mode: 'codex',
    providerSettings: {
      codexAppServer: {
        wsUrl: 'ws://127.0.0.1:43123',
        sidecar: createFakeSidecar(),
      },
    } as any,
  })

  const pty = mockPtyProcess.instances[0]
  pty._emitData([
    'Release notes: https://github.com/openai/codex/releases/latest\r\n',
    '› 1. Update now (runs `npm install -g @openai/codex`)\r\n',
    '  2. Skip\r\n',
    '  3. Skip until next version\r\n',
    'Press enter to continue\r\n',
  ].join(''))

  expect(registry.input(term.terminalId, '\x1b[B')).toEqual({
    status: 'blocked_codex_identity_pending',
    terminalId: term.terminalId,
  })
  expect(registry.input(term.terminalId, '\r')).toEqual({ status: 'written' })
  expect(pty.write).toHaveBeenLastCalledWith('\r')
  expect(registry.input(term.terminalId, 'y\r')).toEqual({ status: 'written' })
})
```

- [x] **Step 2: Run tests to verify they fail**

Run:

```bash
npm run test:vitest -- run test/unit/server/terminal-registry.codex-sidecar.test.ts -t "Codex update prompt|startup prompt state|similar non-prompt|stale update prompt|arrow navigation|terminal startup control"
```

Expected: FAIL because the current detector requires `Update available!`, scans scrollback at input time, and has no live prompt state.

- [x] **Step 3: Implement live prompt state**

In `server/terminal-registry.ts`, replace the old `codexUpdatePromptDismissed` field and scrollback input detector with these concepts:

```ts
type CodexStartupUpdateChoice = 'update_now' | 'skip' | 'skip_until_next_version'

type CodexInputGate =
  | {
      state: 'identity_pending'
      startupOutputTail?: string
      startupUpdatePrompt?: true
    }
  | {
      state: 'update_running'
    }
```

Update `TerminalRecord` to use `codexInputGate?: CodexInputGate`.

Use a bounded live-output tail:

```ts
const CODEX_STARTUP_UPDATE_PROMPT_TAIL_CHARS = 8 * 1024
```

Normalize terminal text with existing `stripTerminalControls()` and newline-preserving whitespace normalization: convert `\r` to `\n` and normalize spaces/tabs, but do not collapse newlines because the detector anchors on line starts. Implement `hasCodexStartupUpdatePrompt(text: string)` so it requires all of:

```ts
text.includes('github.com/openai/codex/releases/latest')
/(?:^|\n)[ \t]*[›>]?[ \t]*1[.)][ \t]*Update now[ \t]*\(runs[ \t]+[^)\n]+\)/i
/(?:^|\n)[ \t]*[›>]?[ \t]*2[.)][ \t]*Skip\b/i
/(?:^|\n)[ \t]*[›>]?[ \t]*3[.)][ \t]*Skip until next version\b/i
/Press\s+enter\s+to\s+continue/i
```

Add `observeCodexStartupOutput(record, data)` and call it from both PTY `onData` handlers immediately after `record.buffer.append(data)` and before `this.emit('terminal.output.raw', ...)` or any direct client send path. It should update `startupOutputTail` only when `record.codexInputGate?.state === 'identity_pending'`, and set `startupUpdatePrompt` when `hasCodexStartupUpdatePrompt()` matches the live tail.

Implement prompt input handling:

```ts
function hasActiveCodexStartupUpdatePrompt(gate: CodexInputGate | undefined): boolean {
  return gate?.state === 'identity_pending'
    && !!gate.startupUpdatePrompt
}
```

Do not expire a detected startup update prompt on wall-clock time alone. The visible Codex prompt remains answerable even if the user leaves it idle for a long time; otherwise Freshell can age into a state where menu selections are blocked while candidate capture remains paused.

Do not forward arrow keys in this special state. Numeric keys complete immediately. If a combined numeric+newline payload such as `2\r` or `3\n` arrives, forward only the numeric byte because the numeric byte completes the Codex menu selection:

```ts
'1', '1\r', '1\n', '1\r\n' -> write '1', set codexInputGate = { state: 'update_running' }
'2', '2\r', '2\n', '2\r\n' -> write '2', clear startup update prompt/tail, stay identity_pending
'3', '3\r', '3\n', '3\r\n' -> write '3', clear startup update prompt/tail, stay identity_pending
```

Bare Enter/newline accepts Codex's default `Update now` selection:

```ts
'\r', '\n', '\r\n' -> write original enter byte, set codexInputGate = { state: 'update_running' }
```

Do not accept normal text. Do not forward arrow navigation. Do not use `record.buffer.snapshot()` for prompt detection. Preserve the existing `isCodexStartupTerminalControlInput(data)` path for cursor reports, device attributes, focus, and OSC color replies while identity is pending.

- [x] **Step 4: Run tests to verify they pass**

Run:

```bash
npm run test:vitest -- run test/unit/server/terminal-registry.codex-sidecar.test.ts -t "Codex update prompt|startup prompt state|similar non-prompt|stale update prompt|arrow navigation|terminal startup control"
```

Expected: PASS.

- [x] **Step 5: Refactor**

Keep helper names specific to startup update prompts. Do not introduce a generic interstitial framework unless tests force it.

- [x] **Step 6: Commit**

```bash
git add server/terminal-registry.ts test/unit/server/terminal-registry.codex-sidecar.test.ts
git commit -m "fix(codex): gate startup update prompt from live output"
```

---

### Task 3: Pause Candidate Capture During Update Prompt and Updater

**Files:**
- Modify: `server/coding-cli/codex-app-server/remote-proxy.ts`
- Modify: `server/coding-cli/codex-app-server/launch-planner.ts`
- Modify: `server/terminal-registry.ts`
- Modify: `test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts`
- Modify: `test/unit/server/coding-cli/codex-app-server/launch-planner.test.ts`
- Modify: `test/unit/server/terminal-registry.codex-sidecar.test.ts`

**Interfaces:**
- Consumes: `CodexRemoteProxy` candidate-capture timer.
- Produces: `pauseCandidateCapture?(reason: string): void` and `resumeCandidateCapture?(reason: string): void` on `CodexLaunchSidecar`.
- Produces: terminal registry calls to pause when a live update prompt is detected or updater lifecycle begins, and resume when skip/skip-until-next-version returns to normal identity capture.

- [x] **Step 1: Write failing remote-proxy timer tests**

In `test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts`, add tests with fake timers that prove:

```ts
proxy.pauseCandidateCapture('startup_update_prompt')
```

prevents `candidate_capture_timeout` from firing while paused, including if a new client connection arrives and would normally call the timer-arm helper, and:

```ts
proxy.resumeCandidateCapture('startup_update_prompt_skipped')
```

re-arms the timer so a later timeout still fires if no candidate is persisted.

- [x] **Step 2: Write failing launch-planner sidecar exposure test**

In `test/unit/server/coding-cli/codex-app-server/launch-planner.test.ts`, extend the fake proxy to expose pause/resume spies and assert the planned sidecar forwards `pauseCandidateCapture()` and `resumeCandidateCapture()` to the proxy.

- [x] **Step 3: Write failing terminal-registry pause/resume tests**

In `test/unit/server/terminal-registry.codex-sidecar.test.ts`, extend `createFakeSidecar()` to include `pauseCandidateCapture` and `resumeCandidateCapture` spies. Add tests proving:

```ts
pty._emitData(<complete update prompt>)
expect(sidecar.pauseCandidateCapture).toHaveBeenCalledWith('codex_startup_update_prompt')
```

and:

```ts
registry.input(term.terminalId, '2')
expect(sidecar.resumeCandidateCapture).toHaveBeenCalledWith('codex_startup_update_skipped')
```

and:

```ts
registry.input(term.terminalId, '1')
expect(sidecar.resumeCandidateCapture).not.toHaveBeenCalled()
```

- [x] **Step 4: Run tests to verify they fail**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts test/unit/server/coding-cli/codex-app-server/launch-planner.test.ts test/unit/server/terminal-registry.codex-sidecar.test.ts -t "candidate capture|startup update|pause|resume"
```

Expected: FAIL because pause/rearm hooks do not exist.

- [x] **Step 5: Implement pause/rearm hooks**

In `server/coding-cli/codex-app-server/remote-proxy.ts`, add public methods:

```ts
private candidateCapturePaused = false

pauseCandidateCapture(reason: string): void {
  if (!this.requireCandidatePersistence) return
  if (this.candidatePersisted || this.candidateCaptureFailed) return
  this.candidateCapturePaused = true
  this.clearCandidateCaptureTimer()
  log.info({ reason }, 'Paused Codex restore identity candidate-capture timeout')
}

resumeCandidateCapture(reason: string): void {
  if (!this.requireCandidatePersistence) return
  if (this.candidatePersisted || this.candidateCaptureFailed) return
  this.candidateCapturePaused = false
  this.ensureCandidateCaptureTimer()
  log.info({ reason }, 'Resumed Codex restore identity candidate-capture timeout')
}
```

Update `ensureCandidateCaptureTimer()` so it returns without arming when `candidateCapturePaused` is true.

Expose those methods through `CodexLaunchProxy`, `CodexLaunchSidecar`, the launch-planner sidecar object, and the `TerminalRecord.codexSidecar` `Pick<CodexLaunchSidecar, ...>` in `server/terminal-registry.ts`.

In `server/terminal-registry.ts`, call `record.codexSidecar?.pauseCandidateCapture?.('codex_startup_update_prompt')` only the first time a live update prompt is detected for that prompt instance. On skip or skip-until-next-version, call `record.codexSidecar?.resumeCandidateCapture?.('codex_startup_update_skipped')`. Do not resume on `Update now`; the terminal is expected to run updater and exit/restart instead of capturing identity.

Add a small central reset helper for terminal gate state:

```ts
private clearCodexInputGate(record: TerminalRecord): void {
  if (record.codexInputGate?.state === 'identity_pending' && record.codexInputGate.startupUpdatePrompt) {
    record.codexSidecar?.resumeCandidateCapture?.('codex_input_gate_cleared')
  }
  record.codexInputGate = undefined
}
```

Use it on candidate capture/failure, terminal finalization, and PTY recovery replacement so prompt/updater state cannot leak across terminal generations. For `update_running`, do not resume candidate capture before clearing; the updater path is intentionally not returning to the old capture deadline.

- [x] **Step 6: Run tests to verify they pass**

Run:

```bash
npm run test:vitest -- run test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts test/unit/server/coding-cli/codex-app-server/launch-planner.test.ts test/unit/server/terminal-registry.codex-sidecar.test.ts -t "candidate capture|startup update|pause|resume"
```

Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add server/coding-cli/codex-app-server/remote-proxy.ts server/coding-cli/codex-app-server/launch-planner.ts server/terminal-registry.ts test/unit/server/coding-cli/codex-app-server/remote-proxy.test.ts test/unit/server/coding-cli/codex-app-server/launch-planner.test.ts test/unit/server/terminal-registry.codex-sidecar.test.ts
git commit -m "fix(codex): pause identity timeout for startup update prompt"
```

---

### Task 4: Handle Update-Now as Updater Lifecycle

**Files:**
- Modify: `server/terminal-registry.ts`
- Modify: `test/unit/server/terminal-registry.codex-sidecar.test.ts`

**Interfaces:**
- Consumes: `codexInputGate.state === 'update_running'` from Task 2.
- Produces:
  - normal terminal input forwarding while `update_running`
  - pre-identity exits without a preceding update selection still follow existing failure behavior

- [x] **Step 1: Write failing lifecycle tests**

Add tests in `test/unit/server/terminal-registry.codex-sidecar.test.ts`:

```ts
it('allows updater input after selecting Update now from the startup prompt', () => {
  const registry = new TerminalRegistry()
  const term = registry.create({
    mode: 'codex',
    providerSettings: {
      codexAppServer: {
        wsUrl: 'ws://127.0.0.1:43123',
        sidecar: createFakeSidecar(),
      },
    } as any,
  })

  const pty = mockPtyProcess.instances[0]
  pty._emitData([
    'Release notes: https://github.com/openai/codex/releases/latest\r\n',
    '› 1. Update now (runs `npm install -g @openai/codex`)\r\n',
    '  2. Skip\r\n',
    '  3. Skip until next version\r\n',
    'Press enter to continue\r\n',
  ].join(''))

  expect(registry.input(term.terminalId, '1')).toEqual({ status: 'written' })
  expect(pty.write).toHaveBeenLastCalledWith('1')
  expect(registry.input(term.terminalId, 'y\r')).toEqual({ status: 'written' })
  expect(pty.write).toHaveBeenLastCalledWith('y\r')
})
```

```ts
it('keeps the candidate capture timeout paused during update prompt and updater lifecycle', async () => {
  const registry = new TerminalRegistry()
  const sidecar = createFakeSidecar()
  const term = registry.create({
    mode: 'codex',
    providerSettings: {
      codexAppServer: {
        wsUrl: 'ws://127.0.0.1:43123',
        sidecar,
      },
    } as any,
  })

  const pty = mockPtyProcess.instances[0]
  pty._emitData([
    'Release notes: https://github.com/openai/codex/releases/latest\r\n',
    '› 1. Update now (runs `npm install -g @openai/codex`)\r\n',
    '  2. Skip\r\n',
    '  3. Skip until next version\r\n',
    'Press enter to continue\r\n',
  ].join(''))

  expect(sidecar.pauseCandidateCapture).toHaveBeenCalledWith('codex_startup_update_prompt')

  expect(registry.input(term.terminalId, '1')).toEqual({ status: 'written' })
  expect(sidecar.resumeCandidateCapture).not.toHaveBeenCalled()
  expect(registry.input(term.terminalId, 'y\r')).toEqual({ status: 'written' })
})
```

Keep the existing timeout test that proves no update prompt still returns `blocked_codex_identity_capture_timeout` after `candidate_capture_timeout`.

- [x] **Step 2: Run tests to verify they fail**

Run:

```bash
npm run test:vitest -- run test/unit/server/terminal-registry.codex-sidecar.test.ts -t "updater input|candidate capture timeout|identity capture timeout"
```

Expected: FAIL because `update_running` input is still blocked.

- [x] **Step 3: Implement updater lifecycle behavior**

In `inputIfSessionMatches()`, before the `identity_pending` block, add explicit `update_running` handling that writes normal terminal input without marking Codex unconfirmed user prompt input:

```ts
if (term.codexInputGate?.state === 'update_running') {
  this.writeTerminalInput(term, data, { markCodexUnconfirmedInput: false })
  return { status: 'written' }
}
```

Refactor the normal terminal write path into a private helper:

```ts
private writeTerminalInput(
  record: TerminalRecord,
  data: string,
  options: { markCodexUnconfirmedInput?: boolean } = {},
): void
```

The helper must preserve the current perf accounting, `lastActivityAt`, `pty.write(data)`, and `terminal.input.raw` event behavior. The normal path should call it with default behavior. The updater path should call it with `markCodexUnconfirmedInput: false`.

Do not ignore `candidate_capture_timeout` in the repair handler. Task 3 prevents that timeout from firing during an active update prompt/updater by pausing the proxy timer. If the timeout event is received, keep the existing failure behavior.

- [x] **Step 4: Run tests to verify they pass**

Run:

```bash
npm run test:vitest -- run test/unit/server/terminal-registry.codex-sidecar.test.ts -t "updater input|candidate capture timeout|identity capture timeout"
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add server/terminal-registry.ts test/unit/server/terminal-registry.codex-sidecar.test.ts
git commit -m "fix(codex): treat startup update as updater lifecycle"
```

---

### Task 5: Normalize REST Send-Keys Tokens

**Files:**
- Modify: `server/agent-api/router.ts`
- Modify: `test/server/agent-send-keys.test.ts`

**Interfaces:**
- Consumes: `translateKeys(keys: string[])` from `server/cli/keys.js`.
- Produces: REST `/api/panes/:paneId/send-keys` normalization:
  - `data` remains raw and takes precedence.
  - `text` remains raw.
  - `keys: string[]` becomes `translateKeys(keys.map(String))`.
  - `keys: string` becomes `translateKeys([keys])`.

- [x] **Step 1: Write failing REST normalization tests**

In `test/server/agent-send-keys.test.ts`, add:

```ts
it('normalizes REST send-keys token strings through the shared key translator', async () => {
  const input = vi.fn(() => ({ status: 'written' }))
  const app = express()
  app.use(express.json())
  app.use('/api', createAgentApiRouter({
    layoutStore: { resolvePaneToTerminal: () => 'term_1' },
    registry: { input },
  }))

  const res = await request(app).post('/api/panes/p1/send-keys').send({ keys: 'ENTER' })

  expect(res.body.status).toBe('ok')
  expect(input).toHaveBeenCalledWith('term_1', '\r')
})
```

```ts
it('normalizes REST send-keys token arrays through the shared key translator', async () => {
  const input = vi.fn(() => ({ status: 'written' }))
  const app = express()
  app.use(express.json())
  app.use('/api', createAgentApiRouter({
    layoutStore: { resolvePaneToTerminal: () => 'term_1' },
    registry: { input },
  }))

  const res = await request(app).post('/api/panes/p1/send-keys').send({ keys: ['2', 'ENTER'] })

  expect(res.body.status).toBe('ok')
  expect(input).toHaveBeenCalledWith('term_1', '2\r')
})
```

Also keep the existing `data` raw-path test unchanged.

- [x] **Step 2: Run tests to verify they fail**

Run:

```bash
npm run test:vitest -- run test/server/agent-send-keys.test.ts
```

Expected: FAIL because the REST route currently forwards `keys` raw.

- [x] **Step 3: Implement normalization**

In `server/agent-api/router.ts`, add:

```ts
import { translateKeys } from '../cli/keys.js'
```

Add a local helper:

```ts
function normalizeTerminalInputPayload(payload: Record<string, unknown>): string {
  if (typeof payload.data === 'string') return payload.data
  if (Array.isArray(payload.keys)) return translateKeys(payload.keys.map(String))
  if (typeof payload.keys === 'string') return translateKeys([payload.keys])
  if (typeof payload.text === 'string') return payload.text
  return ''
}
```

Replace:

```ts
const data = payload.data ?? payload.keys ?? payload.text ?? ''
```

with:

```ts
const data = normalizeTerminalInputPayload(payload)
```

- [x] **Step 4: Run tests to verify they pass**

Run:

```bash
npm run test:vitest -- run test/server/agent-send-keys.test.ts
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add server/agent-api/router.ts test/server/agent-send-keys.test.ts
git commit -m "fix(agent-api): normalize REST send-keys tokens"
```

---

### Task 6: Integrated Verification and Refactor

**Files:**
- Modify only if focused or broad verification exposes a real issue.

**Interfaces:**
- Consumes all previous tasks.
- Produces a coherent branch diff with focused and broad verification evidence.

- [x] **Step 1: Run the focused regression suite**

Run:

```bash
npm run test:vitest -- run test/unit/server/terminal-registry.codex-sidecar.test.ts test/unit/server/terminal-registry.test.ts test/unit/server/coding-cli/codex-app-server/runtime.test.ts test/server/agent-send-keys.test.ts
```

Expected: PASS.

- [x] **Step 2: Run project check through the coordinator**

Run:

```bash
FRESHELL_TEST_SUMMARY="codex startup update prompt regression verification" npm run check
```

Expected: PASS.

- [x] **Step 3: Inspect final diff**

Run:

```bash
git diff --stat origin/main...HEAD
git diff --check origin/main...HEAD
```

Expected: no whitespace errors; diff is limited to the files listed in this plan plus the plan file.

- [x] **Step 4: Commit any final fixes**

If Step 1, Step 2, or Step 3 requires fixes, make the minimal fix, re-run the affected focused test, and commit:

```bash
git add <changed-files>
git commit -m "fix(codex): harden startup update prompt handling"
```

If no changes are required, do not create an empty commit.

---

## Self-Review

1. Spec coverage:
   - Removing update suppression: Task 1.
   - Live prompt state instead of scrollback: Task 2.
   - Numeric keys as completed selections: Task 2.
   - Skip returns to identity capture: Task 2.
   - Update prompt pauses candidate timeout: Task 3.
   - Update now enters updater lifecycle and can accept updater input: Task 4.
   - Candidate timeout does not kill a waiting update prompt/updater: Task 3 and Task 4.
   - Normal text remains blocked while identity is pending: Task 2.
   - REST key normalization: Task 5.
   - Broad verification: Task 6.
2. Placeholder scan:
   - No TBD/TODO placeholders.
   - Every task has concrete files, test commands, expected failure/pass behavior, and implementation guidance.
3. Type consistency:
   - `CodexInputGate`, `CodexStartupUpdateChoice`, `startupUpdatePrompt`, and `update_running` names are consistent across tasks.
