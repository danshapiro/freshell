# Test Plan: OpenCode Turn-Complete Alert

> **Strategy:** The agreed testing strategy maps directly to the implementation plan with no discrepancies. Both gates are purely additive (adding `opencode` to existing whitelists) and no refactoring, new abstractions, or external dependencies are introduced. The existing e2e test validates the full notification flow for codex mode; the notification flow is provider-agnostic after the parser gate, so the unit tests gating opencode into the existing pipelines provide sufficient coverage.

---

## Harness Requirements

All required harnesses exist. No new harnesses need to be built.

| Harness | What it does | Tests depending on it |
|---|---|---|
| **Vitest (shared unit)** | Runs `test/unit/shared/*.test.ts` with direct imports from `shared/` | Test 1 |
| **Vitest (client unit)** | Runs `test/unit/client/**/*.test.ts` with Vite aliases (`@/` → `src/`, `@shared/` → `shared/`) | Test 3 |
| **Vitest (server unit)** | Runs `test/unit/server/**/*.test.ts` with direct imports from `server/`, mocked `fs`, `node-pty`, `generateMcpInjection` | Test 2 |
| **Testing Library + Vitest (e2e)** | Renders React components with Redux store, mocked `@xterm/xterm`, mocked `ws-client`; tests notification sound, tab highlighting, attention clear | Tests 4–7 |

---

## Test Plan

### Priority 1: Problem-statement red checks

These tests verify the two gates that currently exclude OpenCode from turn-complete alerts. They MUST fail before implementation and pass after.

---

#### Test 1 — OpenCode output containing BEL is recognized as a turn-complete signal

- **Name**: OpenCode output containing BEL is recognized as a turn-complete signal
- **Type**: unit
- **Disposition**: new
- **Harness**: Vitest (shared unit)
- **Preconditions**: `TURN_COMPLETE_SIGNAL` constant (`\x07`) available from `shared/turn-complete-signal`
- **Actions**: Call `extractTurnCompleteSignals('result\x07done', 'opencode')`
- **Expected outcome**:
  - `out.count` equals `1` — the BEL was counted as a turn-complete signal
  - `out.cleaned` equals `'resultdone'` — the BEL was stripped from output
  - **Source of truth**: Codex reference (identical TUI notification mechanism). The user explicitly states OpenCode must behave like Codex for turn-complete alerts.
- **Interactions**: None. Direct call to the shared pure function.

**File**: `test/unit/shared/turn-complete-signal.test.ts`

---

#### Test 2 — OpenCode spawn spec includes bell notification arguments on Unix

- **Name**: OpenCode spawn spec includes bell notification arguments on Unix
- **Type**: unit
- **Disposition**: new
- **Harness**: Vitest (server unit)
- **Preconditions**:
  - `OPENCODE_CMD` env var deleted to use default command path
  - `buildSpawnSpec` available from `server/terminal-registry`
  - `TEST_OPENCODE_SERVER` (loopback endpoint `{ hostname: '127.0.0.1', port: 4173 }`) provided in provider settings
  - `generateMcpInjection` mocked (returns empty args/env for opencode mode)
  - Platform is Unix (default in test environment)
- **Actions**: Call `buildSpawnSpec('opencode', '/home/user/project', 'system', undefined, { opencodeServer: TEST_OPENCODE_SERVER })`
- **Expected outcome**:
  - `spec.args` contains `'-c'`
  - `spec.args` contains `'tui.notification_method=bel'`
  - `spec.args` contains `"tui.notifications=['agent-turn-complete']"`
  - **Source of truth**: Codex reference — the existing Codex `providerNotificationArgs` case at `server/terminal-registry.ts:159-168` produces these exact args via the same TUI config mechanism that OpenCode (a Codex fork) supports.
- **Interactions**:
  - Exercises `providerNotificationArgs()` → `generateMcpInjection()` (mocked) → `resolveCodingCliCommand()` → `buildSpawnSpec()`
  - Does NOT exercise `node-pty.spawn()` (mocked)

**File**: `test/unit/server/terminal-registry.test.ts`

---

#### Test 3 — Client wrapper extracts BEL for OpenCode and strips it from output

- **Name**: Client wrapper extracts BEL for OpenCode and strips it from output
- **Type**: unit
- **Disposition**: new
- **Harness**: Vitest (client unit)
- **Preconditions**: 
  - `extractTurnCompleteSignals` imported from `@/lib/turn-complete-signal` (the client wrapper)
  - Client wrapper's `normalizeTurnCompleteSignalMode` already passes `'opencode'` through to the shared parser
- **Actions**: Call `extractTurnCompleteSignals('done\x07next', 'opencode')`
- **Expected outcome**:
  - `out.count` equals `1` — BEL was detected
  - `out.cleaned` equals `'donenext'` — BEL was stripped
  - **Source of truth**: Existing client wrapper behavior for codex and claude (tests at lines 9–21 of the test file). The wrapper is a thin delegate to the shared parser; this test confirms the delegation works for opencode.
- **Interactions**: Exercises `normalizeTurnCompleteSignalMode` → shared `extractTurnCompleteSignals` → shared `supportsTurnSignal`

**File**: `test/unit/client/lib/turn-complete-signal.test.ts`

---

### Priority 2: High-value existing integration and scenario tests

These tests exercise the full user-visible notification flow and must continue to pass after the changes.

---

#### Test 4 — Notification flow: bell sounds and tab highlights on background completion with click dismiss

- **Name**: Notification flow: bell sounds and tab highlights on background completion with click dismiss
- **Type**: scenario (e2e)
- **Disposition**: existing
- **Harness**: Testing Library + Vitest (e2e)
- **Preconditions**: Active tab in `shell` mode, background tab in `codex` mode with `terminalId: 'term-2'`
- **Actions**: Emit `terminal.output` with data `'\x07'` to terminal `term-2`. Verify sound + highlight. Click background tab. Verify attention clears.
- **Expected outcome**: Sound plays, background tab gains `bg-emerald-100` class, tab click clears attention.
- **Interactions**: TerminalView → `extractTurnCompleteSignals` → Redux `recordTurnComplete` → `useTurnCompletionNotifications` → sound hook + attention state

---

#### Test 5 — Click mode clears both tab and pane attention when switching to completed tab

- **Name**: Click mode clears both tab and pane attention when switching to completed tab
- **Type**: scenario (e2e)
- **Disposition**: existing
- **Harness**: Testing Library + Vitest (e2e)
- **Actions**: Same as Test 4, but additionally asserts `attentionByPane` is set and cleared alongside `attentionByTab`.
- **Expected outcome**: Both `attentionByTab['tab-2']` and `attentionByPane['pane-2']` are set after BEL, then cleared after tab switch.
- **Interactions**: Same as Test 4.

---

#### Test 6 — Click mode: clicking already-active tab clears attention

- **Name**: Click mode: clicking already-active tab clears attention
- **Type**: scenario (e2e)
- **Disposition**: existing
- **Harness**: Testing Library + Vitest (e2e)
- **Actions**: Switch to tab-2, emit BEL on tab-2's terminal, click tab-2 again.
- **Expected outcome**: Attention set after BEL, cleared after re-click.
- **Interactions**: Same as Test 4.

---

#### Test 7 — Type mode: attention persists after tab switch, clears on terminal input

- **Name**: Type mode: attention persists after tab switch, clears on terminal input
- **Type**: scenario (e2e)
- **Disposition**: existing
- **Harness**: Testing Library + Vitest (e2e)
- **Actions**: Use `attentionDismiss: 'type'`. Emit BEL on background tab, switch to it, verify attention persists, simulate terminal input.
- **Expected outcome**: Attention remains after tab switch in type mode; cleared by terminal input.
- **Interactions**: Same as Test 4, plus xterm `onData` callback.

---

### Priority 5: Invariant tests

Properties that must hold across all states.

---

#### Test 8 — Unsupported shell modes continue to ignore BEL characters

- **Name**: Unsupported shell modes continue to ignore BEL characters
- **Type**: invariant
- **Disposition**: existing
- **Harness**: Vitest (client unit) + Vitest (shared unit)
- **Preconditions**: `'shell'`, `'gemini'`, `'kimi'` are not in the `supportsTurnSignal` whitelist
- **Actions**: Call `extractTurnCompleteSignals('x\x07y', mode)` for each unsupported mode
- **Expected outcome**: `count` is `0`, `cleaned` is the original input unchanged
- **Source of truth**: Existing test at `client/lib/turn-complete-signal.test.ts:23-28` (shell) and `:30-35` (gemini). The kimi mode is also excluded by the whitelist.
- **Interactions**: None.

---

#### Test 9 — OSC sequences containing BEL terminators are preserved, not counted as signals

- **Name**: OSC sequences containing BEL terminators are preserved, not counted as signals
- **Type**: invariant
- **Disposition**: existing
- **Harness**: Vitest (shared unit) + Vitest (client unit)
- **Actions**: Feed output containing `\x1b]0;title\x07` (BEL terminates OSC sequence for title setting)
- **Expected outcome**: `count` is `0`, `cleaned` contains the full OSC sequence including BEL
- **Source of truth**: Existing tests at `shared/turn-complete-signal.test.ts:17-23` and `client/lib/turn-complete-signal.test.ts:44-49`
- **Interactions**: None.

---

#### Test 10 — Parser state tracking works correctly across chunk boundaries

- **Name**: Parser state tracking works correctly across chunk boundaries
- **Type**: invariant
- **Disposition**: existing
- **Harness**: Vitest (shared unit)
- **Actions**: Split ESC sequences, CSI sequences, and DCS sequences across `extractTurnCompleteSignals` calls with retained state. Verify BELs inside incomplete sequences are preserved, BELs after sequence termination are counted.
- **Expected outcome**: Covered by three existing tests (lines 25-35, 50-58, 60-68 of the shared test file) using codex and claude modes.
- **Interactions**: None.

---

#### Test 11 — The turnCompletion Redux slice is provider-agnostic

- **Name**: The turnCompletion Redux slice is provider-agnostic
- **Type**: invariant
- **Disposition**: existing (implicitly verified by e2e tests)
- **Preconditions**: `recordTurnComplete` reducer accepts `{ tabId, paneId, terminalId, at }` with no provider field
- **Actions**: Covered by e2e Tests 4–7 which dispatch through the full flow and verify Redux state
- **Expected outcome**: `attentionByTab`, `attentionByPane`, `pendingEvents` update correctly for all providers
- **Source of truth**: `turnCompletionSlice.ts:32` — the reducer signature has no provider parameter
- **Interactions**: None.

---

### Priority 6: Boundary and edge-case tests

---

#### Test 12 — OpenCode notification args are included alongside MCP injection args

- **Name**: OpenCode notification args are included alongside MCP injection args
- **Type**: boundary
- **Disposition**: extend (implicitly covered by Test 2)
- **Harness**: Vitest (server unit)
- **Preconditions**: The mocked `generateMcpInjection` returns empty args for opencode. In production, it would append MCP config args after the notification args.
- **Actions**: Test 2 already verifies notification args are present. The production code in `providerNotificationArgs` spreads `...mcpInjection.args` after the notification args (following the exact pattern of the codex case). The existing `expectCodexMcpArgs` helper (line 85-95) confirms this pattern works for codex.
- **Expected outcome**: Notification args precede MCP args in the final arg array (production behavior, verified by structural equivalence to codex).
- **Source of truth**: Codex reference — `providerNotificationArgs` for codex at `terminal-registry.ts:159-168` uses identical structure.
- **Interactions**: None.

---

#### Test 13 — OpenCode spawn spec throws without a valid loopback endpoint

- **Name**: OpenCode spawn spec throws without a valid loopback endpoint
- **Type**: boundary
- **Disposition**: existing
- **Harness**: Vitest (server unit)
- **Actions**: Call `buildSpawnSpec('opencode', ...)` without `opencodeServer` in provider settings, or with invalid hostname/port.
- **Expected outcome**: Throws `Error('OpenCode launch requires an allocated localhost control endpoint.')`
- **Source of truth**: `terminal-registry.ts:275`
- **Interactions**: None. This test already exists in the server unit suite; no change needed.

---

### Priority 7: Regression tests

Tests protecting unchanged behavior of codex and claude paths.

---

#### Test 14 — Codex output containing BEL is still recognized

- **Name**: Codex output containing BEL is still recognized
- **Type**: regression
- **Disposition**: existing
- **Harness**: Vitest (shared unit)
- **Actions**: Call `extractTurnCompleteSignals('hello\x07world', 'codex')`
- **Expected outcome**: `count` is `1`, `cleaned` is `'helloworld'` (unchanged from before the fix)
- **Source of truth**: Existing test at `shared/turn-complete-signal.test.ts:9-15`

---

#### Test 15 — Claude output containing BEL is still recognized

- **Name**: Claude output containing BEL is still recognized
- **Type**: regression
- **Disposition**: existing
- **Harness**: Vitest (client unit)
- **Actions**: Call `extractTurnCompleteSignals('\x07a\x07b\x07', 'claude')`
- **Expected outcome**: `count` is `3`, `cleaned` is `'ab'` (unchanged)
- **Source of truth**: Existing test at `client/lib/turn-complete-signal.test.ts:16-21`

---

#### Test 16 — Codex spawn spec still includes notification args

- **Name**: Codex spawn spec still includes notification args
- **Type**: regression
- **Disposition**: existing
- **Harness**: Vitest (server unit)
- **Actions**: `buildSpawnSpec('codex', ...)` on Unix; verify `tui.notification_method=bel` and `tui.notifications=['agent-turn-complete']` are present
- **Source of truth**: `expectCodexMcpArgs` helper at `terminal-registry.test.ts:85-95` and PowerShell quoting test at lines 1724-1726

---

#### Test 17 — Claude spawn spec still includes bell stop hook

- **Name**: Claude spawn spec still includes bell stop hook
- **Type**: regression
- **Disposition**: existing
- **Harness**: Vitest (server unit)
- **Actions**: `buildSpawnSpec('claude', ...)` on Unix, verify `--settings` arg contains stop hook with `printf '\\a'`
- **Source of truth**: `expectClaudeMcpArgs` helper at `terminal-registry.test.ts:97-107`

---

#### Test 18 — Full default-config test suite passes with no regressions

- **Name**: Full default-config test suite passes with no regressions
- **Type**: regression
- **Disposition**: existing
- **Harness**: `npm run test:vitest -- --run`
- **Actions**: Run the full coordinated test suite
- **Expected outcome**: All tests pass. The only additions are Tests 1–3 (shared, server, client).
- **Source of truth**: All 800+ existing tests.

---

## Coverage Summary

### Action space covered

| Area | Covered by | Fidelity |
|---|---|---|
| Shared parser: BEL detection for opencode | Test 1 (new unit) | High — direct call to pure function |
| Server: notification args in spawn spec for opencode | Test 2 (new unit) | High — exercises `buildSpawnSpec` with mocked `generateMcpInjection` |
| Client: wrapper delegation for opencode | Test 3 (new unit) | High — exercises client wrapper through shared parser |
| Server: `providerNotificationArgs` fallthrough prevention | Test 2 (new unit) | High — verifies args are present for opencode, not just MCP injection |
| Server: opencode spawn validation (loopback endpoint) | Test 13 (existing) | Covered |
| E2E notification flow (sound, highlight, dismiss) | Tests 4–7 (existing e2e) | High — full React + Redux rendering with mocked I/O |
| Regression: codex and claude paths unchanged | Tests 14–17 (existing) | High — identical assertions as before |
| Regression: full suite | Test 18 (existing) | High — full coordinated run |

### Explicitly excluded (with rationale)

| Area | Rationale |
|---|---|
| OpenCode e2e test variant | The e2e test already validates the full notification flow for codex mode. The flow is provider-agnostic after the parser gate: TerminalView calls `extractTurnCompleteSignals(mode, data)` → Redux → hooks → UI. Adding an opencode-only e2e test would duplicate the codex test with only `mode: 'opencode'` substituted, and the parser gate is validated by Test 1. Cost of a separate opencode e2e store/render setup outweighs value. |
| OpenCode notification args on Windows/PowerShell | The `providerNotificationArgs` returns identical args for opencode and codex. The PowerShell arg quoting in `buildSpawnSpec` is provider-agnostic (applies to all args equally). The existing codex PowerShell test (line 1716-1729) proves the quoting path works. |
| OpenCode parser state tracking (OSC, CSI, DCS across chunks) | The shared parser's state machine is mode-agnostic after the `supportsTurnSignal` gate. The existing tests for codex and claude validate all state transitions. Adding opencode-specific variants would test the same code paths identically. |
| Server-side `codex-activity-tracker.ts` | Hardcoded to `'codex'` mode at line 298. Not affected by this change. |
| Actual PTY spawn with OpenCode binary | Requires an installed OpenCode CLI. The correctness of the spawn args (notification config) is verified by `buildSpawnSpec`. The actual process launch is not in scope for unit tests. |
| Manual QA / human inspection | Per test plan rules, all checks are automated. |
