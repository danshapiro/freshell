# Codex + Claude Turn-Complete Bell and Tab Attention Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Play a short bell and highlight the owning tab (light green) when a Codex/Claude turn completes, unless the window is focused and that tab is already active.

**Architecture:** Emit a deterministic in-band terminal signal from provider CLIs (BEL, `\x07`) on turn completion, detect it in `TerminalView`, route through a small Redux slice, and centralize focus-gated bell + attention clearing in one app-level hook. This avoids file watchers entirely and keeps all runtime work on existing PTY streams.

**Tech Stack:** Node.js/Express + `node-pty`, React 18, Redux Toolkit, xterm.js, Vitest + Testing Library

---

## Implementation Notes (Read First)

- Use `@superpowers:test-driven-development` throughout.
- Keep this feature provider-scoped to `claude` and `codex` only.
- Do not persist attention state in localStorage.
- Do not add any new file watchers.

---

### Task 1: Provider Turn-Complete Signal Contract in Spawn Args

**Files:**
- Modify: `server/terminal-registry.ts`
- Test: `test/unit/server/terminal-registry.test.ts`

**Step 1: Write failing tests for provider spawn args**

Add tests asserting:
- Codex spawn args include:
  - `-c`, `tui.notification_method=bel`
  - `-c`, `tui.notifications=['agent-turn-complete']`
- Claude spawn args include `--settings` with JSON containing a `Stop` command hook.

```ts
it('adds Codex turn-complete bell config args', () => {
  const spec = buildSpawnSpec('codex', '/home/user/project', 'system')
  expect(spec.args).toContain('-c')
  expect(spec.args).toContain('tui.notification_method=bel')
  expect(spec.args).toContain("tui.notifications=['agent-turn-complete']")
})

it('adds Claude Stop hook settings for turn-complete bell', () => {
  const spec = buildSpawnSpec('claude', '/home/user/project', 'system')
  const idx = spec.args.indexOf('--settings')
  expect(idx).toBeGreaterThan(-1)
  const settingsJson = spec.args[idx + 1]
  const parsed = JSON.parse(settingsJson)
  expect(parsed.hooks.Stop[0].hooks[0].type).toBe('command')
})
```

**Step 2: Run test to verify RED**

Run:
```bash
npm run test:unit -- test/unit/server/terminal-registry.test.ts
```

Expected: FAIL for missing Codex/Claude notification args.

**Step 3: Implement minimal spawn-arg augmentation**

In `server/terminal-registry.ts`, add a helper and apply it before final command args are built.

```ts
function providerNotificationArgs(mode: TerminalMode): string[] {
  if (mode === 'codex') {
    return [
      '-c', 'tui.notification_method=bel',
      '-c', "tui.notifications=['agent-turn-complete']",
    ]
  }

  if (mode === 'claude') {
    const settings = {
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: 'command',
                command: `sh -lc "printf '\\a' > /dev/tty 2>/dev/null || true"`,
              },
            ],
          },
        ],
      },
    }
    return ['--settings', JSON.stringify(settings)]
  }

  return []
}
```

Then in `buildSpawnSpec()` for CLI modes:

```ts
const baseArgs = cli?.args || []
const args = [...providerNotificationArgs(mode), ...baseArgs]
return { file: cmd, args, cwd, env }
```

**Step 4: Run tests to verify GREEN**

Run:
```bash
npm run test:unit -- test/unit/server/terminal-registry.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/terminal-registry.ts test/unit/server/terminal-registry.test.ts
git commit -m "feat: configure codex and claude to emit turn-complete bell signal"
```

---

### Task 2: Add Client Signal Parser Utility

**Files:**
- Create: `src/lib/turn-complete-signal.ts`
- Test: `test/unit/client/lib/turn-complete-signal.test.ts`

**Step 1: Write failing parser tests**

```ts
import { describe, it, expect } from 'vitest'
import { extractTurnCompleteSignals, TURN_COMPLETE_SIGNAL } from '@/lib/turn-complete-signal'

describe('extractTurnCompleteSignals', () => {
  it('extracts BEL for codex and strips it from output', () => {
    const input = `hello${TURN_COMPLETE_SIGNAL}world`
    const out = extractTurnCompleteSignals(input, 'codex')
    expect(out.count).toBe(1)
    expect(out.cleaned).toBe('helloworld')
  })

  it('ignores BEL in shell mode', () => {
    const input = `x${TURN_COMPLETE_SIGNAL}y`
    const out = extractTurnCompleteSignals(input, 'shell')
    expect(out.count).toBe(0)
    expect(out.cleaned).toBe(input)
  })
})
```

**Step 2: Run test to verify RED**

Run:
```bash
npm run test:unit -- test/unit/client/lib/turn-complete-signal.test.ts
```

Expected: FAIL (file/function missing).

**Step 3: Implement minimal utility**

```ts
import type { TabMode } from '@/store/types'

export const TURN_COMPLETE_SIGNAL = '\x07'

function supportsTurnSignal(mode: TabMode): boolean {
  return mode === 'claude' || mode === 'codex'
}

export function extractTurnCompleteSignals(data: string, mode: TabMode): { cleaned: string; count: number } {
  if (!supportsTurnSignal(mode) || !data.includes(TURN_COMPLETE_SIGNAL)) {
    return { cleaned: data, count: 0 }
  }
  const parts = data.split(TURN_COMPLETE_SIGNAL)
  return {
    cleaned: parts.join(''),
    count: parts.length - 1,
  }
}
```

**Step 4: Run test to verify GREEN**

Run:
```bash
npm run test:unit -- test/unit/client/lib/turn-complete-signal.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/turn-complete-signal.ts test/unit/client/lib/turn-complete-signal.test.ts
git commit -m "feat: add provider-scoped turn-complete signal parser"
```

---

### Task 3: Add Turn Completion + Tab Attention Slice

**Files:**
- Create: `src/store/turnCompletionSlice.ts`
- Modify: `src/store/store.ts`
- Test: `test/unit/client/store/turnCompletionSlice.test.ts`

**Step 1: Write failing slice tests**

```ts
import { describe, it, expect } from 'vitest'
import reducer, { recordTurnComplete, markTabAttention, clearTabAttention } from '@/store/turnCompletionSlice'

describe('turnCompletionSlice', () => {
  it('records latest event with sequence id', () => {
    const state = reducer(undefined, recordTurnComplete({ tabId: 'tab-2', paneId: 'pane-9', terminalId: 'term-2', at: 123 }))
    expect(state.lastEvent?.seq).toBe(1)
    expect(state.lastEvent?.tabId).toBe('tab-2')
  })

  it('marks and clears tab attention', () => {
    let state = reducer(undefined, markTabAttention({ tabId: 'tab-2' }))
    expect(state.attentionByTab['tab-2']).toBe(true)
    state = reducer(state, clearTabAttention({ tabId: 'tab-2' }))
    expect(state.attentionByTab['tab-2']).toBeUndefined()
  })
})
```

**Step 2: Run test to verify RED**

Run:
```bash
npm run test:unit -- test/unit/client/store/turnCompletionSlice.test.ts
```

Expected: FAIL (slice missing).

**Step 3: Implement minimal slice + store wiring**

```ts
import { createSlice, PayloadAction } from '@reduxjs/toolkit'

type TurnCompletePayload = { tabId: string; paneId: string; terminalId: string; at: number }

type TurnCompleteEvent = TurnCompletePayload & { seq: number }

interface TurnCompletionState {
  seq: number
  lastEvent: TurnCompleteEvent | null
  attentionByTab: Record<string, boolean>
}

const initialState: TurnCompletionState = {
  seq: 0,
  lastEvent: null,
  attentionByTab: {},
}

const slice = createSlice({
  name: 'turnCompletion',
  initialState,
  reducers: {
    recordTurnComplete(state, action: PayloadAction<TurnCompletePayload>) {
      state.seq += 1
      state.lastEvent = { ...action.payload, seq: state.seq }
    },
    markTabAttention(state, action: PayloadAction<{ tabId: string }>) {
      state.attentionByTab[action.payload.tabId] = true
    },
    clearTabAttention(state, action: PayloadAction<{ tabId: string }>) {
      delete state.attentionByTab[action.payload.tabId]
    },
  },
})

export const { recordTurnComplete, markTabAttention, clearTabAttention } = slice.actions
export default slice.reducer
```

Wire reducer in `src/store/store.ts`.

**Step 4: Run tests to verify GREEN**

Run:
```bash
npm run test:unit -- test/unit/client/store/turnCompletionSlice.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/store/turnCompletionSlice.ts src/store/store.ts test/unit/client/store/turnCompletionSlice.test.ts
git commit -m "feat: add turn completion and tab attention state"
```

---

### Task 4: Wire `TerminalView` to Detect and Report Turn Completion

**Files:**
- Modify: `src/components/TerminalView.tsx`
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`

**Step 1: Write failing `TerminalView` tests**

Add tests that send `terminal.output` containing BEL (`\x07`) and assert:
- `turnCompletion.lastEvent` is updated for `codex`/`claude` modes.
- output written to xterm has BEL removed.
- shell mode does not report completion.

```ts
messageHandler!({ type: 'terminal.output', terminalId: 'term-1', data: `hi\x07` })
expect(store.getState().turnCompletion.lastEvent?.tabId).toBe(tabId)
expect(terminalInstances[0].write).toHaveBeenCalledWith('hi')
```

**Step 2: Run test to verify RED**

Run:
```bash
npm run test:unit -- test/unit/client/components/TerminalView.lifecycle.test.tsx
```

Expected: FAIL (no signal handling yet).

**Step 3: Implement minimal signal handling**

In `TerminalView` output handler:

```ts
if (msg.type === 'terminal.output' && msg.terminalId === tid) {
  const raw = msg.data || ''
  const mode = contentRef.current?.mode || 'shell'
  const { cleaned, count } = extractTurnCompleteSignals(raw, mode)

  if (count > 0 && tid) {
    dispatch(recordTurnComplete({
      tabId,
      paneId: paneIdRef.current,
      terminalId: tid,
      at: Date.now(),
    }))
  }

  if (cleaned) {
    term.write(cleaned)
  }
}
```

**Step 4: Run tests to verify GREEN**

Run:
```bash
npm run test:unit -- test/unit/client/components/TerminalView.lifecycle.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/components/TerminalView.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx
git commit -m "feat: detect provider turn-complete signal in terminal output"
```

---

### Task 5: Add Focus-Gated Bell + Attention-Clearing Hook

**Files:**
- Create: `src/hooks/useTurnCompletionNotifications.ts`
- Modify: `src/App.tsx`
- Test: `test/unit/client/hooks/useTurnCompletionNotifications.test.tsx`

**Step 1: Write failing hook tests**

Test matrix:
- Background-tab completion while focused: bell + attention mark.
- Active-tab completion while focused: no bell, no attention mark.
- Active-tab completion while unfocused: bell + attention mark.
- Attention clears when window becomes focused and that tab is active.

```ts
expect(playSpy).toHaveBeenCalledTimes(1)
expect(store.getState().turnCompletion.attentionByTab['tab-2']).toBe(true)
```

**Step 2: Run test to verify RED**

Run:
```bash
npm run test:unit -- test/unit/client/hooks/useTurnCompletionNotifications.test.tsx
```

Expected: FAIL (hook missing).

**Step 3: Implement hook and wire in `App`**

```ts
import { useEffect, useRef, useState } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { clearTabAttention, markTabAttention } from '@/store/turnCompletionSlice'
import { useNotificationSound } from '@/hooks/useNotificationSound'

function isWindowFocused(): boolean {
  if (typeof document === 'undefined') return true
  const hasFocus = typeof document.hasFocus === 'function' ? document.hasFocus() : true
  return hasFocus && !document.hidden
}

export function useTurnCompletionNotifications() {
  const dispatch = useAppDispatch()
  const activeTabId = useAppSelector((s) => s.tabs.activeTabId)
  const event = useAppSelector((s) => s.turnCompletion.lastEvent)
  const { play } = useNotificationSound()
  const [focused, setFocused] = useState(isWindowFocused())
  const lastHandledSeqRef = useRef(0)

  useEffect(() => {
    const update = () => setFocused(isWindowFocused())
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    document.addEventListener('visibilitychange', update)
    return () => {
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
      document.removeEventListener('visibilitychange', update)
    }
  }, [])

  useEffect(() => {
    if (!event) return
    if (event.seq <= lastHandledSeqRef.current) return
    lastHandledSeqRef.current = event.seq

    if (focused && activeTabId === event.tabId) return

    dispatch(markTabAttention({ tabId: event.tabId }))
    play()
  }, [activeTabId, dispatch, event, focused, play])

  useEffect(() => {
    if (!focused || !activeTabId) return
    dispatch(clearTabAttention({ tabId: activeTabId }))
  }, [activeTabId, dispatch, focused])
}
```

Call the hook near the top of `App()`.

**Step 4: Run tests to verify GREEN**

Run:
```bash
npm run test:unit -- test/unit/client/hooks/useTurnCompletionNotifications.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/hooks/useTurnCompletionNotifications.ts src/App.tsx test/unit/client/hooks/useTurnCompletionNotifications.test.tsx
git commit -m "feat: add focus-gated turn completion bell and attention clearing"
```

---

### Task 6: Tab Highlight Styling (Light Green) in Tab UI

**Files:**
- Modify: `src/components/TabBar.tsx`
- Modify: `src/components/TabItem.tsx`
- Modify: `test/unit/client/components/TabBar.test.tsx`
- Modify: `test/unit/client/components/TabItem.test.tsx`

**Step 1: Write failing UI tests**

Add tests asserting `needsAttention` tabs render with light-green class and non-attention tabs keep existing classes.

```ts
render(<TabItem {...defaultProps} needsAttention={true} isActive={false} />)
const tabElement = screen.getByText('Test Tab').closest('div[class*="group"]')
expect(tabElement?.className).toContain('bg-emerald-100')
```

**Step 2: Run tests to verify RED**

Run:
```bash
npm run test:unit -- test/unit/client/components/TabItem.test.tsx test/unit/client/components/TabBar.test.tsx
```

Expected: FAIL.

**Step 3: Implement minimal prop plumbing + styles**

In `TabBar`:

```ts
const attentionByTab = useAppSelector((s) => s.turnCompletion.attentionByTab)

<TabItem
  ...
  needsAttention={!!attentionByTab[tab.id]}
/>
```

In `TabItem` props and class selection:

```ts
isActive
  ? 'bg-background text-foreground shadow-sm'
  : needsAttention
    ? 'bg-emerald-100 text-emerald-900 hover:bg-emerald-200 mt-1 dark:bg-emerald-900/40 dark:text-emerald-100 dark:hover:bg-emerald-900/55'
    : 'bg-muted text-muted-foreground hover:text-foreground hover:bg-accent mt-1'
```

**Step 4: Run tests to verify GREEN**

Run:
```bash
npm run test:unit -- test/unit/client/components/TabItem.test.tsx test/unit/client/components/TabBar.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/components/TabBar.tsx src/components/TabItem.tsx test/unit/client/components/TabBar.test.tsx test/unit/client/components/TabItem.test.tsx
git commit -m "feat: highlight tabs in light green when turn completion needs attention"
```

---

### Task 7: End-to-End Notification Flow Test

**Files:**
- Create: `test/e2e/turn-complete-notification-flow.test.tsx`

**Step 1: Write failing e2e flow test**

Scenario:
- Two tabs, second tab hidden.
- Emit `terminal.output` with BEL for second tab terminal.
- Assert bell playback triggered and tab 2 highlighted.
- Switch to tab 2 while focused.
- Assert highlight clears.

```tsx
it('bells + highlights background tab on turn complete and clears on focus+select', async () => {
  // render app shell + ws mock callback
  // emit: { type: 'terminal.output', terminalId: 'term-2', data: '\x07' }
  // expect play called and tab class contains bg-emerald-100
  // click tab 2, dispatch focus
  // expect tab class no longer contains bg-emerald-100
})
```

**Step 2: Run test to verify RED**

Run:
```bash
npm run test -- test/e2e/turn-complete-notification-flow.test.tsx
```

Expected: FAIL.

**Step 3: Add test harness mocks and assertions**

- Mock `@/lib/ws-client` to capture `onMessage` callback.
- Mock `useNotificationSound` to capture `play` calls.
- Use real reducers for `tabs`, `panes`, `turnCompletion`.

**Step 4: Run test to verify GREEN**

Run:
```bash
npm run test -- test/e2e/turn-complete-notification-flow.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e/turn-complete-notification-flow.test.tsx
git commit -m "test: add e2e turn-complete bell and tab-attention flow"
```

---

### Task 8: Full Verification + Refactor Pass

**Files:**
- Modify as needed from earlier tasks for cleanup only.

**Step 1: Run targeted suite (fast confidence)**

```bash
npm run test:unit -- \
  test/unit/server/terminal-registry.test.ts \
  test/unit/client/lib/turn-complete-signal.test.ts \
  test/unit/client/store/turnCompletionSlice.test.ts \
  test/unit/client/components/TerminalView.lifecycle.test.tsx \
  test/unit/client/hooks/useTurnCompletionNotifications.test.tsx \
  test/unit/client/components/TabItem.test.tsx \
  test/unit/client/components/TabBar.test.tsx
```

Expected: PASS.

**Step 2: Run e2e + full suite**

```bash
npm test
```

Expected: PASS for all client/server tests.

**Step 3: Manual runtime verification**

```bash
npm run dev
```

Manual checklist:
- Open `codex` pane in background tab, trigger one completed turn.
- Confirm bell + background tab turns light green.
- Bring that tab to foreground while window focused: highlight clears.
- Repeat with `claude` pane.
- Keep active tab open but blur window, trigger completion: bell + highlight should still occur.

**Step 4: Refactor for clarity (no behavior change)**

- Remove duplicated focus checks.
- Keep signal parsing in utility only.
- Ensure no extra rerenders in `TabBar` selectors.

**Step 5: Final commit**

```bash
git add -A
git commit -m "feat: add codex/claude turn-complete bell and tab attention"
```

---

## Risk Checklist

- `claude` hook command must remain best-effort and silent on non-TTY paths (`|| true`).
- No persistence of attention state.
- No new filesystem watchers.
- Signal parser must stay provider-scoped (`claude`, `codex`) to avoid shell false positives.

## Rollback Plan

- Remove provider notification args from `buildSpawnSpec`.
- Keep parser + slice behind a feature flag if quick rollback is required.
- Revert commits in reverse order.

## Optional Follow-up (Not Required for MVP)

- Windows-native parity for Claude hook command (non-WSL).
- Add user setting toggle for bell on turn-complete.
- Add subtle pulse animation on highlighted tabs.
