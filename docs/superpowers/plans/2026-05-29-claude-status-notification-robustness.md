# Claude Status & Notification Robustness (Server-Authoritative Turn Lifecycle) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Claude Code CLI terminal's busy/idle (green↔blue) status and turn-complete (bell + attention) notification deterministic by moving turn-lifecycle ownership from the browser to a server-side, `terminalId`-keyed activity tracker — the same pattern codex/opencode already use — and restore the regressed codex bell.

**Architecture:** A new `ClaudeActivityTracker` on the server consumes the existing `terminal.input.raw` / `terminal.output.raw` registry events for Claude terminals, maintaining an authoritative `idle | busy` phase per `terminalId` with a 120s deadman backstop. It broadcasts activity changes (`claude.activity.updated` + a `claude.activity.list` snapshot for reconnect rehydration) and one-shot `terminal.turn.complete` events. The client reads Claude busy state from a `terminalId`-keyed Redux slice (mirroring `codexActivity`) instead of the brittle pane-local `paneRuntimeActivity` ref, and stops minting turn-complete events from replayable in-band BEL bytes. This eliminates the phantom-bell-on-replay, reverts-to-green-on-reconnect, stuck-blue-forever, false-busy-on-paste, and green-during-submit bugs at their root.

**Tech Stack:** Node.js EventEmitter trackers, Zod WS protocol schemas, Redux Toolkit slices, React 18, Vitest. Server is NodeNext/ESM (relative imports MUST include `.js`).

---

## Background

Two independent audits (`/tmp/claudefindings.md`, `freshell/tmp/codexfindings.md`) reached the same diagnosis: Claude's "is it working?" and "did the turn finish?" are derived **entirely client-side from a single in-band BEL byte** (`\x07`) emitted by an injected `Stop` hook, with **no server-authoritative state, no replay guard, no per-turn dedup, no staleness timeout, and no input validation**. Codex and opencode already solved this with a server-side `terminalId`-keyed tracker that the client rehydrates on reconnect. This plan puts Claude on that proven pipeline.

> **Design note (deliberate divergence from `codexfindings.md`):** codexfindings recommends a three-value phase (`idle | pending | busy`) and rendering both `pending` and `busy` as blue. This plan instead uses a two-value phase (`idle | busy`) and marks the terminal busy *immediately on submit* via an `inFlight` turn counter. That closes the submit→first-output green window (#9) without a distinct `pending` state, keeps the Claude tracker simpler than codex's (no JSONL/event fusion to disambiguate pending from busy), and leaves no behavioral gap. If a future need to distinguish "submitted but silent" from "streaming" arises, `pending` can be layered on without changing the slice/transport shape.

### Findings resolved by this plan
- 🔴 #1 Replayed scrollback re-fires turn-complete (phantom bell)
- 🔴 #2 Working pane reverts to green after remount/reload/reconnect mid-turn
- 🔴 #3 Missed Stop-hook BEL leaves the pane stuck blue forever
- 🟡 #4 Stray mid-turn BEL prematurely flips green + latches working off
- 🟡 #5 Any newline-containing input (multiline paste) flips Claude to blue
- 🟡 #9 Green (not blue) during submit → first-output window
- 🟡 #11 Codex turn-complete bell dropped in the MCP-orchestration refactor (parity regression)
- ⚪ #12 No tests for replay-BEL suppression / reconnect-mid-turn busy
- ⚪ #13 Dead code: `terminalActivitySlice` + `useTerminalActivityMonitor`
- 🔵 #14 Two `recordTurnComplete` producers, no per-turn dedup (`lastEvent` dead)

### Out of scope (a separate follow-on plan — see end of document)
- 🔴 #6 Attention rendered on only 2 of 8 surfaces; busy uses 4 vocabularies
- 🟡 #7 Click-mode attention never auto-clears on the active focused tab; splits leave panes stuck
- 🟡 #8 Emerald attention persists on exited/reconnected panes
- 🟡 #10 No OS/browser-level escalation (title flash / Web Notification)
- 🔵 #15 Duplicated blue "busy" precedence with inconsistent status guards
- Stop-hook OSC marker hardening (defense-in-depth beyond "only count BEL while a turn is active")

These are a distinct subsystem (presentational surfacing + notification UX), they depend on the slice/selector shapes this plan establishes, and the writing-plans Scope Check says to split multi-subsystem specs. They are scoped as **Follow-on Plan (Workstream B)** at the end.

## The product contract (encode this in tests)

For a Claude Code CLI terminal pane:
- **Green** (`text-success`): terminal is running and **no** Claude turn is active.
- **Blue** (`text-blue-500`): a Claude turn is active — from the moment the user submits, through silent thinking, through streaming output, until completion. (Fixes #9: blue is immediate on submit, not only after first output.)
- **Attention** (emerald pulse) + **sound**: emitted **exactly once per real completed turn**, server-driven, and **never** re-emitted by scrollback replay, reattach, or reload (fixes #1).
- A still-running pane that misses its Stop-hook BEL self-heals to green within ~120s (fixes #3); it does not stay blue forever.
- Pasting multi-line text does not start a turn (fixes #5); a stray mid-turn BEL embedded in visible output does not end one (fixes #4).
- After a page reload / transport reconnect mid-turn, the pane re-renders blue from the server snapshot (fixes #2).

## Prerequisites

- Work in a fresh worktree branched from `origin/main` (use superpowers:using-git-worktrees). Do **not** edit on local `main` or `dev`.
- Confirm the suite is green on the base before starting: `npm run check`.

---

## File Structure

**Created:**
- `server/coding-cli/claude-activity-tracker.ts` — authoritative `idle|busy` phase per Claude `terminalId`; consumes submit/BEL; emits `changed` + `turn.complete`; 120s deadman. One responsibility: Claude turn lifecycle state.
- `server/coding-cli/claude-activity-wiring.ts` — binds the tracker to registry events (`terminal.created` filtered to claude, `terminal.session.bound`, `terminal.input.raw`, `terminal.output.raw`, `terminal.exit`) + sweep timer + `dispose()`. One responsibility: event plumbing.
- `src/store/claudeActivitySlice.ts` — `terminalId`-keyed client cache with snapshot/live-mutation reconciliation (mirror of `codexActivitySlice`). One responsibility: client activity cache.
- `test/unit/server/coding-cli/claude-activity-tracker.test.ts`
- `test/unit/server/coding-cli/claude-activity-wiring.test.ts`
- `test/server/ws-claude-activity.test.ts`
- `test/unit/client/store/claudeActivitySlice.test.ts`

**Modified:**
- `shared/turn-complete-signal.ts` — export `isSubmitInput` and `countTrackerTurnCompleteSignals` (moved from the codex tracker) so server trackers and tests share one implementation.
- `server/coding-cli/codex-activity-tracker.ts` — import the two moved helpers instead of defining them (no behavior change).
- `shared/ws-protocol.ts` — add Claude activity schemas + request; widen `TerminalTurnCompleteSchema.provider`; make `sessionId` optional.
- `server/ws-handler.ts` — `claude.activity.list` handler, `broadcastClaudeActivityUpdated`, `claudeActivityListProvider`.
- `server/index.ts` — construct/wire/dispose the Claude tracker; broadcast `changed` and (Phase 5) `turn.complete`.
- `server/terminal-registry.ts` — restore codex bell args (#11).
- `src/store/store.ts` — register `claudeActivity` reducer; **remove** `terminalActivity` registration (#13).
- `src/App.tsx` — request `claude.activity.list` on (re)connect; apply `claude.activity.list.response` / `claude.activity.updated`.
- `src/lib/pane-activity.ts` — Claude terminal busy reads the server record by `terminalId`.
- `src/components/TerminalView.tsx` — stop deriving Claude busy/turn-complete client-side (keep display BEL-stripping).
- `src/store/turnCompletionSlice.ts` — per-`(terminalId, at)` dedup; drop dead `lastEvent`.
- 5 pane-activity call sites pass `claudeActivityByTerminalId`: `MobileTabStrip.tsx`, `TabSwitcher.tsx`, `TabBar.tsx`, `Sidebar.tsx`, `panes/PaneContainer.tsx`.

**Deleted (#13):**
- `src/store/terminalActivitySlice.ts`
- `src/hooks/useTerminalActivityMonitor.ts`
- `test/unit/client/hooks/useTerminalActivityMonitor.test.tsx`

---

# Phase 0 — Delete dead activity-monitor code (#13)

`terminalActivitySlice` is registered but its writers (`recordOutput`/`recordInput`/`resetPane`) are never dispatched, and `useTerminalActivityMonitor` is never mounted (`App.tsx` mounts `useTurnCompletionNotifications` instead). It is a permanent no-op that masquerades as a live busy/sound path. Remove it first to clear the field. **Zero behavior change.**

### Task 0.1: Confirm dead, then delete

**Files:**
- Delete: `src/store/terminalActivitySlice.ts`
- Delete: `src/hooks/useTerminalActivityMonitor.ts`
- Delete: `test/unit/client/hooks/useTerminalActivityMonitor.test.tsx`
- Modify: `src/store/store.ts:10,50`

- [ ] **Step 1: Prove the slice writers and hook are never used in production**

Run:
```bash
grep -rn "recordOutput\|recordInput\|resetPane\|useTerminalActivityMonitor\|terminalActivitySlice" src/ | grep -v "terminalActivitySlice.ts" | grep -v "useTerminalActivityMonitor.ts"
```
Expected: only `src/store/store.ts` (import + registration) appears. No dispatch of `recordOutput`/`recordInput`/`resetPane`, no mount of `useTerminalActivityMonitor`. If anything else appears, STOP — it is not dead; reassess.

- [ ] **Step 2: Delete the three files**

```bash
git rm src/store/terminalActivitySlice.ts src/hooks/useTerminalActivityMonitor.ts test/unit/client/hooks/useTerminalActivityMonitor.test.tsx
```

- [ ] **Step 3: Remove the store registration**

In `src/store/store.ts`, delete the import line:
```ts
import terminalActivityReducer from './terminalActivitySlice'
```
and the reducer entry:
```ts
    terminalActivity: terminalActivityReducer,
```

- [ ] **Step 4: Typecheck + full suite (verifies nothing referenced it)**

Run: `npm run check`
Expected: PASS. (TypeScript would fail here if any code still imported the deleted modules.)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor: remove dead terminalActivitySlice and useTerminalActivityMonitor

Permanent no-op: slice writers were never dispatched and the hook was
never mounted. Removing it before reworking Claude turn lifecycle so the
live notification path (turnCompletion) is the only one.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

# Phase 1 — Extract shared turn predicates (refactor, no behavior change)

The codex tracker's `isSubmitInput` (correct submit detection) and `countTrackerTurnCompleteSignals` (stray-BEL filter) are exactly what the Claude tracker needs. Move them into `shared/turn-complete-signal.ts` so there is one implementation. Codex behavior is unchanged; its tests must still pass.

### Task 1.1: Move `isSubmitInput` + `countTrackerTurnCompleteSignals` into shared

**Files:**
- Modify: `shared/turn-complete-signal.ts`
- Modify: `server/coding-cli/codex-activity-tracker.ts:2-7,82-187`
- Test: `test/unit/shared/turn-complete-signal.test.ts` (extend)

- [ ] **Step 1: Write failing tests for the shared helpers**

Append to `test/unit/shared/turn-complete-signal.test.ts`:
```ts
import {
  countTrackerTurnCompleteSignals,
  createTurnCompleteSignalParserState,
  isSubmitInput,
} from '@shared/turn-complete-signal'

describe('isSubmitInput', () => {
  it('treats a whole-payload newline as submit', () => {
    expect(isSubmitInput('\r')).toBe(true)
    expect(isSubmitInput('\n')).toBe(true)
    expect(isSubmitInput('\r\n')).toBe(true)
    expect(isSubmitInput('\n\n')).toBe(true)
  })
  it('does not treat newline-containing text as submit', () => {
    expect(isSubmitInput('hello\nworld')).toBe(false)
    expect(isSubmitInput('line1\r\nline2\r\n')).toBe(false)
    expect(isSubmitInput('\x1b[200~paste\nmore\x1b[201~')).toBe(false)
  })
})

describe('countTrackerTurnCompleteSignals', () => {
  it('counts a leading-eligible BEL', () => {
    const state = createTurnCompleteSignalParserState()
    expect(countTrackerTurnCompleteSignals('\x07', state)).toBe(1)
  })
  it('ignores a BEL embedded between visible output', () => {
    const state = createTurnCompleteSignalParserState()
    expect(countTrackerTurnCompleteSignals('output\x07more output', state)).toBe(0)
  })
  it('ignores an OSC title terminator BEL', () => {
    const state = createTurnCompleteSignalParserState()
    expect(countTrackerTurnCompleteSignals('\x1b]0;title\x07', state)).toBe(0)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:vitest -- run test/unit/shared/turn-complete-signal.test.ts`
Expected: FAIL — `countTrackerTurnCompleteSignals` and `isSubmitInput` are not exported from `@shared/turn-complete-signal`.

- [ ] **Step 3: Add the helpers to `shared/turn-complete-signal.ts`**

After the `createTurnCompleteSignalParserState` function (declared at line 17; insert below its closing brace, ~line 19), add:
```ts
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f-\u009f]/

function isIgnorableLeadingTurnCompleteChar(ch: string): boolean {
  return ch !== TURN_COMPLETE_SIGNAL && (
    /\s/.test(ch)
    || CONTROL_CHAR_RE.test(ch)
  )
}

/**
 * Counts only turn-complete BELs that are "tracker-eligible": a BEL that is
 * either leading (no visible output before it in the chunk) or has no visible
 * output after it. A BEL sandwiched between visible output (a stray bell from
 * a sub-tool) is NOT counted. OSC/DCS/CSI-enclosed BELs are skipped.
 */
export function countTrackerTurnCompleteSignals(
  data: string,
  state: TurnCompleteSignalParserState,
): number {
  let inOsc = state.inOsc
  let pendingEsc = state.pendingEsc
  let inCsi = state.inCsi
  let inDcs = state.inDcs
  let sawVisibleOutput = false
  const candidates: Array<{ leadingEligible: boolean; hasVisibleAfter: boolean }> = []

  const markVisibleOutput = () => {
    sawVisibleOutput = true
    for (const candidate of candidates) {
      candidate.hasVisibleAfter = true
    }
  }

  for (const ch of data) {
    if (pendingEsc) {
      if (inOsc && ch === '\\') {
        inOsc = false
      } else if (inDcs && ch === '\\') {
        inDcs = false
      } else if (!inOsc && !inDcs && ch === ']') {
        inOsc = true
      } else if (!inOsc && !inDcs && ch === '[') {
        inCsi = true
      } else if (!inOsc && !inDcs && ch === 'P') {
        inDcs = true
      }
      pendingEsc = false
      continue
    }

    if (ch === ESC) {
      pendingEsc = true
      continue
    }

    if (inOsc) {
      if (ch === TURN_COMPLETE_SIGNAL || ch === C1_ST) {
        inOsc = false
      }
      continue
    }

    if (inDcs) {
      if (ch === C1_ST) {
        inDcs = false
      }
      continue
    }

    if (inCsi) {
      if (ch >= '@' && ch <= '~') {
        inCsi = false
      }
      continue
    }

    if (ch === C1_CSI) {
      inCsi = true
      continue
    }
    if (ch === C1_DCS) {
      inDcs = true
      continue
    }
    if (ch === C1_OSC) {
      inOsc = true
      continue
    }
    if (ch === TURN_COMPLETE_SIGNAL) {
      candidates.push({
        leadingEligible: !sawVisibleOutput,
        hasVisibleAfter: false,
      })
      continue
    }
    if (isIgnorableLeadingTurnCompleteChar(ch)) {
      continue
    }
    markVisibleOutput()
  }

  return candidates.filter((candidate) => candidate.leadingEligible || !candidate.hasVisibleAfter).length
}

export function isSubmitInput(data: string): boolean {
  return /^(?:\r\n|\r|\n)+$/.test(data)
}
```

- [ ] **Step 4: Have the codex tracker import the moved helpers**

In `server/coding-cli/codex-activity-tracker.ts`, change the import (lines 2-7) to add the two names:
```ts
import {
  TURN_COMPLETE_SIGNAL,
  countTrackerTurnCompleteSignals,
  createTurnCompleteSignalParserState,
  extractTurnCompleteSignals,
  isSubmitInput,
  type TurnCompleteSignalParserState,
} from '../../shared/turn-complete-signal.js'
```
Then **delete** the now-duplicated local definitions: the constants `CONTROL_CHAR_RE`, `ESC`, `C1_ST`, `C1_CSI`, `C1_DCS`, `C1_OSC` (lines 82-87), `isIgnorableLeadingTurnCompleteChar` (89-94), `countTrackerTurnCompleteSignals` (96-183), and `isSubmitInput` (185-187). `TURN_COMPLETE_SIGNAL` stays imported and is still used inside the file.

- [ ] **Step 5: Run shared + codex tracker tests to verify green**

Run:
```bash
npm run test:vitest -- run test/unit/shared/turn-complete-signal.test.ts test/unit/server/coding-cli/codex-activity-tracker.test.ts
```
Expected: PASS — new shared tests pass; codex tracker behavior unchanged.

- [ ] **Step 6: Typecheck**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor: share isSubmitInput and countTrackerTurnCompleteSignals

Move both helpers from codex-activity-tracker into shared/turn-complete-signal
so the new Claude activity tracker can reuse the validated submit detection and
stray-BEL filter. No behavior change.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

# Phase 2 — Server: ClaudeActivityTracker + wiring (internal; nothing consumes it yet)

Add the authoritative tracker and wire it to registry events. It is not broadcast yet, so this phase is inert at runtime but fully unit-tested.

### Task 2.1: ClaudeActivityTracker

**Files:**
- Create: `server/coding-cli/claude-activity-tracker.ts`
- Test: `test/unit/server/coding-cli/claude-activity-tracker.test.ts`

- [ ] **Step 1: Write the failing tracker test**

Create `test/unit/server/coding-cli/claude-activity-tracker.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest'
import {
  CLAUDE_BUSY_DEADMAN_MS,
  ClaudeActivityTracker,
  type ClaudeActivityChange,
  type ClaudeTurnCompleteEvent,
} from '@/../server/coding-cli/claude-activity-tracker'

function setup() {
  const tracker = new ClaudeActivityTracker()
  const changes: ClaudeActivityChange[] = []
  const completions: ClaudeTurnCompleteEvent[] = []
  tracker.on('changed', (c: ClaudeActivityChange) => changes.push(c))
  tracker.on('turn.complete', (e: ClaudeTurnCompleteEvent) => completions.push(e))
  return { tracker, changes, completions }
}

describe('ClaudeActivityTracker', () => {
  it('starts idle on track and goes busy on submit', () => {
    const { tracker } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    expect(tracker.getActivity('t1')?.phase).toBe('idle')
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 2000 })
    expect(tracker.getActivity('t1')?.phase).toBe('busy')
  })

  it('does not start a turn on multiline paste', () => {
    const { tracker } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.noteInput({ terminalId: 't1', data: 'line one\nline two', at: 2000 })
    expect(tracker.getActivity('t1')?.phase).toBe('idle')
  })

  it('completes a turn on Stop-hook BEL and emits exactly one turn.complete', () => {
    const { tracker, completions } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 2000 })
    tracker.noteOutput({ terminalId: 't1', data: 'thinking...', at: 2500 })
    expect(tracker.getActivity('t1')?.phase).toBe('busy')
    tracker.noteOutput({ terminalId: 't1', data: '\x07', at: 3000 })
    expect(tracker.getActivity('t1')?.phase).toBe('idle')
    expect(completions).toHaveLength(1)
    expect(completions[0]).toMatchObject({ terminalId: 't1', at: 3000 })
  })

  it('ignores a BEL while idle (false-positive guard)', () => {
    const { tracker, completions } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.noteOutput({ terminalId: 't1', data: '\x07', at: 2000 })
    expect(tracker.getActivity('t1')?.phase).toBe('idle')
    expect(completions).toHaveLength(0)
  })

  it('ignores a stray BEL embedded in visible mid-turn output', () => {
    const { tracker, completions } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 2000 })
    tracker.noteOutput({ terminalId: 't1', data: 'before\x07after', at: 2500 })
    expect(tracker.getActivity('t1')?.phase).toBe('busy')
    expect(completions).toHaveLength(0)
  })

  it('handles two queued submits with two completions', () => {
    const { tracker, completions } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 2000 })
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 2100 })
    tracker.noteOutput({ terminalId: 't1', data: '\x07', at: 3000 })
    expect(tracker.getActivity('t1')?.phase).toBe('busy')
    tracker.noteOutput({ terminalId: 't1', data: '\x07', at: 4000 })
    expect(tracker.getActivity('t1')?.phase).toBe('idle')
    expect(completions).toHaveLength(2)
  })

  it('self-heals a stuck-busy terminal after the deadman', () => {
    const { tracker, completions } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 2000 })
    tracker.expire(2000 + CLAUDE_BUSY_DEADMAN_MS + 1)
    expect(tracker.getActivity('t1')?.phase).toBe('idle')
    expect(completions).toHaveLength(0)
  })

  it('output refreshes liveness so the deadman does not fire on an active turn', () => {
    const { tracker } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 2000 })
    tracker.noteOutput({ terminalId: 't1', data: 'progress', at: 2000 + CLAUDE_BUSY_DEADMAN_MS })
    tracker.expire(2000 + CLAUDE_BUSY_DEADMAN_MS + 1)
    expect(tracker.getActivity('t1')?.phase).toBe('busy')
  })

  it('removes state on exit and emits a removal', () => {
    const { tracker, changes } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.noteExit({ terminalId: 't1' })
    expect(tracker.getActivity('t1')).toBeUndefined()
    expect(changes.at(-1)).toEqual({ upsert: [], remove: ['t1'] })
  })

  it('list() reflects current records', () => {
    const { tracker } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 2000 })
    expect(tracker.list()).toEqual([{ terminalId: 't1', phase: 'busy', updatedAt: 2000 }])
  })

  it('attaches sessionId via bindSession', () => {
    const { tracker } = setup()
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.bindSession({ terminalId: 't1', sessionId: 's-1', at: 1500 })
    expect(tracker.getActivity('t1')?.sessionId).toBe('s-1')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:vitest -- run test/unit/server/coding-cli/claude-activity-tracker.test.ts`
Expected: FAIL — module `server/coding-cli/claude-activity-tracker.ts` does not exist.

- [ ] **Step 3: Implement the tracker**

Create `server/coding-cli/claude-activity-tracker.ts`:
```ts
import { EventEmitter } from 'events'
import {
  countTrackerTurnCompleteSignals,
  createTurnCompleteSignalParserState,
  extractTurnCompleteSignals,
  isSubmitInput,
  type TurnCompleteSignalParserState,
} from '../../shared/turn-complete-signal.js'

export const CLAUDE_BUSY_DEADMAN_MS = 120_000
export const CLAUDE_ACTIVITY_SWEEP_MS = 5_000

export type ClaudeActivityPhase = 'idle' | 'busy'

export type ClaudeActivityRecord = {
  terminalId: string
  sessionId?: string
  phase: ClaudeActivityPhase
  updatedAt: number
}

export type ClaudeTurnCompleteEvent = {
  terminalId: string
  sessionId?: string
  at: number
}

export type ClaudeActivityChange = {
  upsert: ClaudeActivityRecord[]
  remove: string[]
}

type TrackerLogger = {
  warn: (payload: object, message?: string) => void
}

type ClaudeTerminalActivity = {
  terminalId: string
  sessionId?: string
  phase: ClaudeActivityPhase
  updatedAt: number
  inFlight: number
  lastObservedAt: number
  lastSubmitAt?: number
  parserState: TurnCompleteSignalParserState
}

/**
 * Server-authoritative Claude turn lifecycle, keyed by terminalId.
 *
 * - A submit (whole-payload newline) increments in-flight turns and marks busy.
 * - A Stop-hook BEL (validated by countTrackerTurnCompleteSignals) decrements
 *   in-flight turns and, while a turn was actually in flight, emits one
 *   turn.complete. A BEL while idle is ignored (false-positive guard).
 * - A busy terminal silent past the deadman self-heals to idle (no completion
 *   event — it is a stuck recovery, not a real turn end).
 */
export class ClaudeActivityTracker extends EventEmitter {
  private readonly states = new Map<string, ClaudeTerminalActivity>()
  private readonly log?: TrackerLogger

  constructor(input: { log?: TrackerLogger } = {}) {
    super()
    this.log = input.log
  }

  list(): ClaudeActivityRecord[] {
    return Array.from(this.states.values()).map((state) => this.toRecord(state))
  }

  getActivity(terminalId: string): ClaudeActivityRecord | undefined {
    const state = this.states.get(terminalId)
    return state ? this.toRecord(state) : undefined
  }

  trackTerminal(input: { terminalId: string; sessionId?: string; at: number }): void {
    const existing = this.states.get(input.terminalId)
    if (existing) {
      if (input.sessionId && existing.sessionId !== input.sessionId) {
        const previous = this.toRecord(existing)
        existing.sessionId = input.sessionId
        this.commitState(existing, previous)
      }
      return
    }
    const state: ClaudeTerminalActivity = {
      terminalId: input.terminalId,
      sessionId: input.sessionId,
      phase: 'idle',
      updatedAt: input.at,
      inFlight: 0,
      lastObservedAt: input.at,
      parserState: createTurnCompleteSignalParserState(),
    }
    this.commitState(state, undefined)
  }

  bindSession(input: { terminalId: string; sessionId: string; at: number }): void {
    void input.at
    const state = this.states.get(input.terminalId)
    if (!state || state.sessionId === input.sessionId) return
    const previous = this.toRecord(state)
    state.sessionId = input.sessionId
    this.commitState(state, previous)
  }

  noteInput(input: { terminalId: string; data: string; at: number }): void {
    const state = this.states.get(input.terminalId)
    if (!state) return
    if (!isSubmitInput(input.data)) return
    const previous = this.toRecord(state)
    state.inFlight += 1
    state.lastSubmitAt = input.at
    state.lastObservedAt = input.at
    if (state.phase !== 'busy') {
      state.phase = 'busy'
      state.updatedAt = input.at
    }
    this.commitState(state, previous)
  }

  noteOutput(input: { terminalId: string; data: string; at: number }): void {
    const state = this.states.get(input.terminalId)
    if (!state) return

    const parserStateAtStart = { ...state.parserState }
    const { count } = extractTurnCompleteSignals(input.data, 'claude', state.parserState)
    if (count <= 0) {
      if (state.phase === 'busy') state.lastObservedAt = input.at
      return
    }
    const trackerCount = countTrackerTurnCompleteSignals(input.data, parserStateAtStart)
    const clearCount = Math.min(count, trackerCount)
    if (clearCount <= 0) {
      if (state.phase === 'busy') state.lastObservedAt = input.at
      return
    }

    const previous = this.toRecord(state)
    const completions: ClaudeTurnCompleteEvent[] = []
    for (let i = 0; i < clearCount; i += 1) {
      if (state.inFlight <= 0) break
      state.inFlight -= 1
      completions.push({
        terminalId: state.terminalId,
        ...(state.sessionId ? { sessionId: state.sessionId } : {}),
        at: input.at,
      })
    }
    state.lastObservedAt = input.at
    if (completions.length > 0) {
      state.phase = state.inFlight > 0 ? 'busy' : 'idle'
      state.updatedAt = input.at
    }
    this.commitState(state, previous)
    for (const completion of completions) {
      this.emit('turn.complete', completion)
    }
  }

  noteExit(input: { terminalId: string }): void {
    this.removeState(input.terminalId)
  }

  expire(at: number): void {
    for (const state of this.states.values()) {
      if (state.phase !== 'busy') continue
      const idleAgeMs = at - state.lastObservedAt
      if (idleAgeMs <= CLAUDE_BUSY_DEADMAN_MS) continue
      const previous = this.toRecord(state)
      state.phase = 'idle'
      state.inFlight = 0
      state.updatedAt = at
      state.lastObservedAt = at
      this.log?.warn({
        component: 'claude-activity-tracker',
        event: 'claude_activity_deadman',
        terminalId: state.terminalId,
        ageMs: idleAgeMs,
      }, 'Claude terminal stuck busy past deadman; clearing to idle.')
      this.commitState(state, previous)
    }
  }

  private commitState(state: ClaudeTerminalActivity, previous: ClaudeActivityRecord | undefined): void {
    this.states.set(state.terminalId, state)
    const next = this.toRecord(state)
    if (!this.hasPublicChange(previous, next)) return
    this.emit('changed', { upsert: [next], remove: [] } satisfies ClaudeActivityChange)
  }

  private removeState(terminalId: string): void {
    if (!this.states.delete(terminalId)) return
    this.emit('changed', { upsert: [], remove: [terminalId] } satisfies ClaudeActivityChange)
  }

  private toRecord(state: ClaudeTerminalActivity): ClaudeActivityRecord {
    return {
      terminalId: state.terminalId,
      ...(state.sessionId ? { sessionId: state.sessionId } : {}),
      phase: state.phase,
      updatedAt: state.updatedAt,
    }
  }

  private hasPublicChange(previous: ClaudeActivityRecord | undefined, next: ClaudeActivityRecord): boolean {
    if (!previous) return true
    return previous.phase !== next.phase || previous.sessionId !== next.sessionId
  }
}
```

> Note on the import path in the test (`@/../server/...`): if that alias does not resolve under the default vitest config, import via a relative path from the test file instead: `import { ... } from '../../../../server/coding-cli/claude-activity-tracker.js'`. Match whatever the existing `test/unit/server/coding-cli/codex-activity-tracker.test.ts` uses for importing the codex tracker, then mirror it.

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:vitest -- run test/unit/server/coding-cli/claude-activity-tracker.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(server): add ClaudeActivityTracker (idle/busy + deadman, not yet wired)

Authoritative Claude turn lifecycle keyed by terminalId. Submit -> busy;
validated Stop-hook BEL -> idle + one turn.complete; idle BEL ignored; stray
mid-output BEL filtered; 120s deadman self-heals stuck-busy.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 2.2: Wiring to registry events

**Files:**
- Create: `server/coding-cli/claude-activity-wiring.ts`
- Test: `test/unit/server/coding-cli/claude-activity-wiring.test.ts`

- [ ] **Step 1: Write the failing wiring test**

Create `test/unit/server/coding-cli/claude-activity-wiring.test.ts`:
```ts
import { EventEmitter } from 'events'
import { describe, expect, it, vi } from 'vitest'
import { wireClaudeActivityTracker } from '@/../server/coding-cli/claude-activity-wiring'

class FakeRegistry extends EventEmitter {
  records = new Map<string, { terminalId: string; mode: string; status: string }>()
  list() { return Array.from(this.records.values()).map((r) => ({ terminalId: r.terminalId })) }
  get(id: string) { return this.records.get(id) }
}

describe('wireClaudeActivityTracker', () => {
  it('tracks only claude terminals and updates phase on submit + BEL', () => {
    const registry = new FakeRegistry()
    const now = vi.fn(() => 1000)
    const { tracker, dispose } = wireClaudeActivityTracker({
      registry: registry as any,
      now,
      setIntervalFn: (() => 0 as any),
      clearIntervalFn: (() => {}),
    })

    registry.emit('terminal.created', { terminalId: 'shell-1', mode: 'shell', status: 'running' })
    registry.emit('terminal.created', { terminalId: 't1', mode: 'claude', status: 'running' })
    expect(tracker.getActivity('shell-1')).toBeUndefined()
    expect(tracker.getActivity('t1')?.phase).toBe('idle')

    registry.emit('terminal.input.raw', { terminalId: 't1', data: '\r', at: 2000 })
    expect(tracker.getActivity('t1')?.phase).toBe('busy')

    registry.emit('terminal.output.raw', { terminalId: 't1', data: '\x07', at: 3000 })
    expect(tracker.getActivity('t1')?.phase).toBe('idle')

    registry.emit('terminal.exit', { terminalId: 't1' })
    expect(tracker.getActivity('t1')).toBeUndefined()
    dispose()
  })

  it('ignores input/output for untracked (non-claude) terminals', () => {
    const registry = new FakeRegistry()
    const { tracker, dispose } = wireClaudeActivityTracker({
      registry: registry as any,
      now: () => 1000,
      setIntervalFn: (() => 0 as any),
      clearIntervalFn: (() => {}),
    })
    registry.emit('terminal.input.raw', { terminalId: 'shell-1', data: '\r', at: 2000 })
    expect(tracker.getActivity('shell-1')).toBeUndefined()
    dispose()
  })

  it('rehydrates already-running claude terminals on startup', () => {
    const registry = new FakeRegistry()
    registry.records.set('t1', { terminalId: 't1', mode: 'claude', status: 'running' })
    const { tracker, dispose } = wireClaudeActivityTracker({
      registry: registry as any,
      now: () => 1000,
      setIntervalFn: (() => 0 as any),
      clearIntervalFn: (() => {}),
    })
    expect(tracker.getActivity('t1')?.phase).toBe('idle')
    dispose()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:vitest -- run test/unit/server/coding-cli/claude-activity-wiring.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the wiring**

Create `server/coding-cli/claude-activity-wiring.ts`:
```ts
import {
  CLAUDE_ACTIVITY_SWEEP_MS,
  ClaudeActivityTracker,
} from './claude-activity-tracker.js'
import type {
  TerminalInputRawEvent,
  TerminalOutputRawEvent,
  TerminalSessionBoundEvent,
} from '../terminal-stream/registry-events.js'

type ClaudeTerminalSnapshot = {
  terminalId: string
  mode: string
  status: string
}

type ClaudeActivityRegistry = {
  list: () => Array<{ terminalId: string }>
  get: (terminalId: string) => ClaudeTerminalSnapshot | undefined | null
  on: (event: string, handler: (...args: any[]) => void) => void
  off: (event: string, handler: (...args: any[]) => void) => void
}

export function wireClaudeActivityTracker(input: {
  registry: ClaudeActivityRegistry
  now?: () => number
  setIntervalFn?: typeof setInterval
  clearIntervalFn?: typeof clearInterval
}) {
  const {
    registry,
    now = () => Date.now(),
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = input

  const tracker = new ClaudeActivityTracker()

  const startTracking = (record: ClaudeTerminalSnapshot) => {
    if (record.mode !== 'claude' || record.status !== 'running') return
    tracker.trackTerminal({ terminalId: record.terminalId, at: now() })
  }

  const onCreated = (record: ClaudeTerminalSnapshot) => {
    startTracking(record)
  }
  const onBound = (event: TerminalSessionBoundEvent) => {
    if (event.provider !== 'claude') return
    tracker.bindSession({ terminalId: event.terminalId, sessionId: event.sessionId, at: now() })
  }
  const onInput = (event: TerminalInputRawEvent) => {
    tracker.noteInput({ terminalId: event.terminalId, data: event.data, at: event.at })
  }
  const onOutput = (event: TerminalOutputRawEvent) => {
    tracker.noteOutput({ terminalId: event.terminalId, data: event.data, at: event.at })
  }
  const onExit = (event: { terminalId?: string }) => {
    if (!event.terminalId) return
    tracker.noteExit({ terminalId: event.terminalId })
  }

  registry.on('terminal.created', onCreated)
  registry.on('terminal.session.bound', onBound)
  registry.on('terminal.input.raw', onInput)
  registry.on('terminal.output.raw', onOutput)
  registry.on('terminal.exit', onExit)

  for (const listed of registry.list()) {
    const record = registry.get(listed.terminalId)
    if (record) startTracking(record)
  }

  const sweepTimer = setIntervalFn(() => {
    tracker.expire(now())
  }, CLAUDE_ACTIVITY_SWEEP_MS)

  return {
    tracker,
    dispose(): void {
      registry.off('terminal.created', onCreated)
      registry.off('terminal.session.bound', onBound)
      registry.off('terminal.input.raw', onInput)
      registry.off('terminal.output.raw', onOutput)
      registry.off('terminal.exit', onExit)
      clearIntervalFn(sweepTimer)
    },
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:vitest -- run test/unit/server/coding-cli/claude-activity-wiring.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(server): wire ClaudeActivityTracker to registry events

terminal.created (claude only) + session.bound + input.raw + output.raw + exit,
plus a 5s deadman sweep and startup rehydration. Not yet broadcast.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

# Phase 3 — Protocol + broadcast Claude activity (busy/idle) to the client

Extend the WS protocol and broadcast activity changes + a snapshot. Turn-complete broadcast is deferred to Phase 5 to avoid a double-fire window with the still-present client BEL path.

### Task 3.1: Protocol schemas

**Files:**
- Modify: `shared/ws-protocol.ts:90-138,286-296,535-548,688-700,931-974`
- Test: `test/unit/shared/ws-protocol.test.ts` (extend, or create if absent — match the existing protocol test file name in the repo)

- [ ] **Step 1: Write failing protocol tests**

Add to the protocol test file:
```ts
import {
  ClaudeActivityRecordSchema,
  ClaudeActivityListResponseSchema,
  ClaudeActivityUpdatedSchema,
  ClaudeActivityListSchema,
  TerminalTurnCompleteSchema,
} from '@shared/ws-protocol'

describe('claude activity protocol', () => {
  it('accepts a claude activity record with idle/busy phase', () => {
    expect(ClaudeActivityRecordSchema.safeParse({ terminalId: 't1', phase: 'busy', updatedAt: 1 }).success).toBe(true)
    expect(ClaudeActivityRecordSchema.safeParse({ terminalId: 't1', phase: 'pending', updatedAt: 1 }).success).toBe(false)
  })
  it('accepts claude.activity.list request and response and updated', () => {
    expect(ClaudeActivityListSchema.safeParse({ type: 'claude.activity.list', requestId: 'r1' }).success).toBe(true)
    expect(ClaudeActivityListResponseSchema.safeParse({ type: 'claude.activity.list.response', requestId: 'r1', terminals: [] }).success).toBe(true)
    expect(ClaudeActivityUpdatedSchema.safeParse({ type: 'claude.activity.updated', upsert: [], remove: ['t1'] }).success).toBe(true)
  })
  it('terminal.turn.complete accepts provider claude and optional sessionId', () => {
    expect(TerminalTurnCompleteSchema.safeParse({ type: 'terminal.turn.complete', terminalId: 't1', provider: 'claude', at: 1 }).success).toBe(true)
    expect(TerminalTurnCompleteSchema.safeParse({ type: 'terminal.turn.complete', terminalId: 't1', provider: 'opencode', sessionId: 's1', at: 1 }).success).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:vitest -- run test/unit/shared/ws-protocol.test.ts`
Expected: FAIL — Claude schemas not exported; `provider: 'claude'` rejected.

- [ ] **Step 3: Add Claude schemas + widen turn-complete**

In `shared/ws-protocol.ts`, after the OpenCode activity schemas (after line 130, before `TerminalTurnCompleteSchema`), add:
```ts
export const ClaudeActivityRecordSchema = z.object({
  terminalId: z.string().min(1),
  sessionId: z.string().optional(),
  phase: z.enum(['idle', 'busy']),
  updatedAt: z.number().int().nonnegative(),
})

export type ClaudeActivityRecord = z.infer<typeof ClaudeActivityRecordSchema>

export const ClaudeActivityListResponseSchema = z.object({
  type: z.literal('claude.activity.list.response'),
  requestId: z.string().min(1),
  terminals: z.array(ClaudeActivityRecordSchema),
})

export const ClaudeActivityUpdatedSchema = z.object({
  type: z.literal('claude.activity.updated'),
  upsert: z.array(ClaudeActivityRecordSchema),
  remove: z.array(z.string().min(1)),
})
```

Replace `TerminalTurnCompleteSchema` (lines 132-138) with:
```ts
export const TerminalTurnCompleteSchema = z.object({
  type: z.literal('terminal.turn.complete'),
  terminalId: z.string().min(1),
  provider: z.enum(['opencode', 'claude']),
  sessionId: z.string().min(1).optional(),
  at: z.number().int().nonnegative(),
})
```

After `OpencodeActivityListSchema` (after line 296), add the request schema:
```ts
export const ClaudeActivityListSchema = z.object({
  type: z.literal('claude.activity.list'),
  requestId: z.string().min(1),
})
```

In the client→server message union list (where `CodexActivityListSchema` and `OpencodeActivityListSchema` appear, ~line 546), add `ClaudeActivityListSchema,`.

In the message-type exports (~line 690, alongside `CodexActivityUpdatedMessage`), add:
```ts
export type ClaudeActivityListResponseMessage = z.infer<typeof ClaudeActivityListResponseSchema>
export type ClaudeActivityUpdatedMessage = z.infer<typeof ClaudeActivityUpdatedSchema>
```

In the `ServerMessage` TS union (spans ~931-974; insert alongside `CodexActivityUpdatedMessage`/`OpencodeActivityUpdatedMessage` at ~949-952), add:
```ts
  | ClaudeActivityListResponseMessage
  | ClaudeActivityUpdatedMessage
```

- [ ] **Step 4: Run to verify it passes + typecheck**

Run:
```bash
npm run test:vitest -- run test/unit/shared/ws-protocol.test.ts
npm run check
```
Expected: PASS. (Typecheck confirms the unions are consistent; the opencode broadcast at `server/index.ts:431-434` still satisfies the widened schema.)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(protocol): add claude.activity.* schemas; widen terminal.turn.complete

provider becomes enum(opencode, claude); sessionId optional (client only reads
terminalId+at). Adds ClaudeActivityRecord/List/Updated + claude.activity.list.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 3.2: ws-handler + server wiring for activity broadcast

**Files:**
- Modify: `server/ws-handler.ts:53-55,170,485,542,629,3228,4354`
- Modify: `server/index.ts:206,374,426,919`
- Test: `test/server/ws-claude-activity.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `test/server/ws-claude-activity.test.ts`, modeled on `test/server/ws-codex-activity.test.ts` (open that file and copy its harness — server bootstrap, auth handshake helpers, and `superwstest` usage — then adapt the assertions below):
```ts
// Mirror test/server/ws-codex-activity.test.ts harness (bootstrap + auth).
// Assertions specific to Claude:
//
// 1. An authenticated client that sends { type: 'claude.activity.list', requestId: 'r1' }
//    receives a 'claude.activity.list.response' with requestId 'r1' and a terminals array.
//
// 2. When the wired ClaudeActivityTracker emits a 'changed' event, authenticated
//    clients receive a 'claude.activity.updated' message with the upsert/remove payload;
//    unauthenticated clients do NOT.
//
// Use the test seam the codex test uses to reach the tracker (it is wired in
// server/index.ts as `claudeActivity`); if the harness exposes the registry,
// drive a real claude terminal create + input to produce a 'changed' event.
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:vitest -- run test/server/ws-claude-activity.test.ts`
Expected: FAIL — `claude.activity.list` is an unknown message type; no `claude.activity.updated` broadcast.

- [ ] **Step 3: ws-handler — imports, provider option, handler, broadcast**

In `server/ws-handler.ts`:

Add to the protocol imports (near lines 53-55 where `CodexActivityListResponseSchema`, `CodexActivityListSchema` are imported):
```ts
  ClaudeActivityListResponseSchema,
  ClaudeActivityListSchema,
  ClaudeActivityUpdatedSchema,
```
and add `ClaudeActivityRecord` to the type imports alongside `CodexActivityRecord`.

Add the provider option to the handler options type (near line 170, next to `codexActivityListProvider?`):
```ts
  claudeActivityListProvider?: () => ClaudeActivityRecord[]
```
the private field (near line 485):
```ts
  private claudeActivityListProvider?: () => ClaudeActivityRecord[]
```
and the assignment in the constructor (near line 542):
```ts
    this.claudeActivityListProvider = options.claudeActivityListProvider
```

Add `ClaudeActivityListSchema` to the accepted client-message schema list (near line 629, next to `CodexActivityListSchema`).

Add the handler case in the message switch (after the `case 'opencode.activity.list':` block ending ~line 3266):
```ts
      case 'claude.activity.list': {
        const terminals = this.claudeActivityListProvider ? this.claudeActivityListProvider() : []
        const response = ClaudeActivityListResponseSchema.safeParse({
          type: 'claude.activity.list.response',
          requestId: m.requestId,
          terminals,
        })
        if (!response.success) {
          log.warn({ issues: response.error.issues }, 'Invalid claude.activity.list.response payload')
          this.sendError(ws, {
            code: 'INTERNAL_ERROR',
            message: 'Claude activity unavailable',
            requestId: m.requestId,
          })
          return
        }
        this.send(ws, response.data)
        return
      }
```

Add the broadcast method (after `broadcastOpencodeActivityUpdated`, ~line 4354; `broadcastCodexActivityUpdated` is at 4339):
```ts
  broadcastClaudeActivityUpdated(msg: { upsert?: ClaudeActivityRecord[]; remove?: string[] }): void {
    const parsed = ClaudeActivityUpdatedSchema.safeParse({
      type: 'claude.activity.updated',
      upsert: msg.upsert || [],
      remove: msg.remove || [],
    })

    if (!parsed.success) {
      log.warn({ issues: parsed.error.issues }, 'Invalid claude.activity.updated payload')
      return
    }

    this.broadcastAuthenticated(parsed.data)
  }
```

- [ ] **Step 4: server/index.ts — construct, register provider, broadcast changes, dispose**

In `server/index.ts`:

Add the import near `wireCodexActivityTracker` (line 22):
```ts
import { wireClaudeActivityTracker } from './coding-cli/claude-activity-wiring.js'
```

After `const codexActivity = wireCodexActivityTracker(...)` (line 206):
```ts
  const claudeActivity = wireClaudeActivityTracker({ registry })
```

In the ws-handler options object (near line 374, next to `codexActivityListProvider`):
```ts
      claudeActivityListProvider: () => claudeActivity.tracker.list(),
```

After the codex `'changed'` wiring (line 424-426):
```ts
  claudeActivity.tracker.on('changed', (payload) => {
    wsHandler.broadcastClaudeActivityUpdated(payload)
  })
```

In shutdown (near line 919, next to `codexActivity.dispose()`):
```ts
    claudeActivity.dispose()
```

> Note: `registry` exposes `on/off/list/get`. The `wireClaudeActivityTracker` registry type is a structural subset; `TerminalRegistry` satisfies it. If TS complains about `get` returning the full `TerminalRecord`, the structural `ClaudeTerminalSnapshot` subset still matches (TerminalRecord has `terminalId`, `mode`, `status`).

- [ ] **Step 5: Run integration + full check**

Run:
```bash
npm run test:vitest -- run test/server/ws-claude-activity.test.ts
npm run check
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(server): broadcast claude.activity (list + updated) over WS

Wire ClaudeActivityTracker 'changed' to broadcastClaudeActivityUpdated and serve
claude.activity.list snapshots. Authenticated clients only.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

# Phase 4 — Client: consume server-authoritative Claude busy state (fixes #2, #9)

Add the client slice, rehydrate on (re)connect, switch the Claude busy projection to read the server record by `terminalId`, and remove the client-side `paneRuntimeActivity` derivation for Claude. Turn-complete stays client-driven for now (Phase 5 flips it) — no double-fire because the server does not yet emit `turn.complete` for Claude.

### Task 4.1: claudeActivitySlice (mirror codexActivitySlice)

**Files:**
- Create: `src/store/claudeActivitySlice.ts`
- Modify: `src/store/store.ts`
- Test: `test/unit/client/store/claudeActivitySlice.test.ts`

- [ ] **Step 1: Write the failing slice test**

Create `test/unit/client/store/claudeActivitySlice.test.ts` by copying `test/unit/client/store/codexActivitySlice.test.ts` and renaming codex→claude (actions, state key, record shape). The behaviors to assert (same as codex): snapshot replaces state honoring `requestSeq`; `upsert` applies live mutations with `mutationSeq`; `remove` deletes and records removal seq; out-of-order snapshot is ignored; `reset` clears. Phase value is `'busy'`.

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:vitest -- run test/unit/client/store/claudeActivitySlice.test.ts`
Expected: FAIL — `src/store/claudeActivitySlice.ts` does not exist.

- [ ] **Step 3: Implement the slice (verbatim mirror of codexActivitySlice)**

Create `src/store/claudeActivitySlice.ts`:
```ts
import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { ClaudeActivityRecord } from '@shared/ws-protocol'

export type ClaudeActivityState = {
  byTerminalId: Record<string, ClaudeActivityRecord>
  lastSnapshotSeq: number
  liveMutationSeqByTerminalId: Record<string, number>
  removedMutationSeqByTerminalId: Record<string, number>
}

type ClaudeActivitySnapshotPayload = {
  terminals: ClaudeActivityRecord[]
  requestSeq?: number
}

type ClaudeActivityUpsertPayload = {
  terminals: ClaudeActivityRecord[]
  mutationSeq?: number
}

type ClaudeActivityRemovalPayload = {
  terminalIds: string[]
  mutationSeq?: number
}

function createInitialState(): ClaudeActivityState {
  return {
    byTerminalId: {},
    lastSnapshotSeq: 0,
    liveMutationSeqByTerminalId: {},
    removedMutationSeqByTerminalId: {},
  }
}

const initialState: ClaudeActivityState = createInitialState()

const claudeActivitySlice = createSlice({
  name: 'claudeActivity',
  initialState,
  reducers: {
    setClaudeActivitySnapshot(state, action: PayloadAction<ClaudeActivitySnapshotPayload>) {
      const requestSeq = action.payload.requestSeq ?? 0
      if (requestSeq < state.lastSnapshotSeq) {
        return
      }
      const next: Record<string, ClaudeActivityRecord> = {}
      const nextLiveMutationSeqByTerminalId: Record<string, number> = {}
      const incomingIds = new Set<string>()

      for (const record of action.payload.terminals) {
        const removedMutationSeq = state.removedMutationSeqByTerminalId[record.terminalId] ?? 0
        if (removedMutationSeq > requestSeq) continue
        const liveMutationSeq = state.liveMutationSeqByTerminalId[record.terminalId] ?? 0
        const existing = state.byTerminalId[record.terminalId]
        if (liveMutationSeq > requestSeq && existing) {
          next[record.terminalId] = existing
          nextLiveMutationSeqByTerminalId[record.terminalId] = liveMutationSeq
          incomingIds.add(record.terminalId)
          continue
        }
        next[record.terminalId] = record
        incomingIds.add(record.terminalId)
      }

      for (const [terminalId, existing] of Object.entries(state.byTerminalId)) {
        if (incomingIds.has(terminalId)) continue
        const liveMutationSeq = state.liveMutationSeqByTerminalId[terminalId] ?? 0
        if (liveMutationSeq > requestSeq) {
          next[terminalId] = existing
          nextLiveMutationSeqByTerminalId[terminalId] = liveMutationSeq
        }
      }

      const nextRemovedMutationSeqByTerminalId: Record<string, number> = {}
      for (const [terminalId, removedMutationSeq] of Object.entries(state.removedMutationSeqByTerminalId)) {
        if (removedMutationSeq > requestSeq && !next[terminalId]) {
          nextRemovedMutationSeqByTerminalId[terminalId] = removedMutationSeq
        }
      }

      state.byTerminalId = next
      state.lastSnapshotSeq = requestSeq
      state.liveMutationSeqByTerminalId = nextLiveMutationSeqByTerminalId
      state.removedMutationSeqByTerminalId = nextRemovedMutationSeqByTerminalId
    },

    upsertClaudeActivity(state, action: PayloadAction<ClaudeActivityUpsertPayload>) {
      const mutationSeq = action.payload.mutationSeq ?? 0
      for (const record of action.payload.terminals) {
        const removedMutationSeq = state.removedMutationSeqByTerminalId[record.terminalId] ?? 0
        if (removedMutationSeq > mutationSeq) continue

        const existing = state.byTerminalId[record.terminalId]
        if (!existing || record.updatedAt >= existing.updatedAt) {
          state.byTerminalId[record.terminalId] = record
          state.liveMutationSeqByTerminalId[record.terminalId] = mutationSeq
          delete state.removedMutationSeqByTerminalId[record.terminalId]
        }
      }
    },

    removeClaudeActivity(state, action: PayloadAction<ClaudeActivityRemovalPayload>) {
      const mutationSeq = action.payload.mutationSeq ?? 0
      for (const terminalId of action.payload.terminalIds) {
        delete state.byTerminalId[terminalId]
        delete state.liveMutationSeqByTerminalId[terminalId]
        if ((state.removedMutationSeqByTerminalId[terminalId] ?? 0) < mutationSeq) {
          state.removedMutationSeqByTerminalId[terminalId] = mutationSeq
        }
      }
    },

    resetClaudeActivity() {
      return createInitialState()
    },
  },
})

export const {
  setClaudeActivitySnapshot,
  upsertClaudeActivity,
  removeClaudeActivity,
  resetClaudeActivity,
} = claudeActivitySlice.actions

export default claudeActivitySlice.reducer
```

- [ ] **Step 4: Register the reducer in `src/store/store.ts`**

Add the import next to `codexActivityReducer` (line 16):
```ts
import claudeActivityReducer from './claudeActivitySlice'
```
and the reducer entry next to `codexActivity` (line 56):
```ts
    claudeActivity: claudeActivityReducer,
```

- [ ] **Step 5: Run to verify it passes + typecheck**

Run:
```bash
npm run test:vitest -- run test/unit/client/store/claudeActivitySlice.test.ts
npm run check
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(client): add claudeActivitySlice (terminalId-keyed, snapshot+live recon)

Mirror of codexActivitySlice. Registered in the store; nothing reads it yet.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4.2: App.tsx — request snapshot on (re)connect, apply updates

**Files:**
- Modify: `src/App.tsx:63,234-237,664-692,700-701,794-795,811-812,898-925,1047-1048,1057-1058,1071-1072`

- [ ] **Step 1: Add the import + refs**

Add to the activity-slice imports (next to line 63):
```ts
import { setClaudeActivitySnapshot, upsertClaudeActivity, removeClaudeActivity, resetClaudeActivity } from '@/store/claudeActivitySlice'
```
Add refs next to `codexActivityListRequestSeqRef` / `codexActivityOrderRef` (lines 234-237):
```ts
  const claudeActivityListRequestSeqRef = useRef(new Map<string, number>())
  const claudeActivityOrderRef = useRef(0)
```

- [ ] **Step 2: Add request + reset helpers (mirror codex)**

Next to `requestCodexActivityList` (lines 664-672) and `resetCodexActivityOverlay` (684-687), add:
```ts
      const requestClaudeActivityList = () => {
        const requestId = `claude-activity-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const requestSeq = ++claudeActivityOrderRef.current
        claudeActivityListRequestSeqRef.current.set(requestId, requestSeq)
        ws.send({
          type: 'claude.activity.list',
          requestId,
        })
      }

      const resetClaudeActivityOverlay = () => {
        claudeActivityListRequestSeqRef.current.clear()
        dispatch(resetClaudeActivity())
      }
```

- [ ] **Step 3: Call them everywhere codex/opencode are called**

At each site where `requestCodexActivityList()` / `requestOpencodeActivityList()` are called (lines 811-812, 1057-1058), add `requestClaudeActivityList()`. At each site where `resetCodexActivityOverlay()` / `resetOpencodeActivityOverlay()` are called (lines 700-701, 794-795, 1047-1048, 1071-1072, and the standalone `resetCodexActivityOverlay()` at 488), add `resetClaudeActivityOverlay()`.

- [ ] **Step 4: Handle the response + updated messages**

After the `codex.activity.updated` handler block (ends line 926), add:
```ts
        if (msg.type === 'claude.activity.list.response') {
          const requestId = typeof msg.requestId === 'string' ? msg.requestId : ''
          if (!requestId) return
          const requestSeq = claudeActivityListRequestSeqRef.current.get(requestId)
          claudeActivityListRequestSeqRef.current.delete(requestId)
          if (requestSeq === undefined) return
          dispatch(setClaudeActivitySnapshot({
            terminals: msg.terminals || [],
            requestSeq,
          }))
        }
        if (msg.type === 'claude.activity.updated') {
          const mutationSeq = ++claudeActivityOrderRef.current
          const upsert = Array.isArray(msg.upsert) ? msg.upsert : []
          if (upsert.length > 0) {
            dispatch(upsertClaudeActivity({
              terminals: upsert,
              mutationSeq,
            }))
          }

          const remove = Array.isArray(msg.remove) ? msg.remove : []
          if (remove.length > 0) {
            dispatch(removeClaudeActivity({
              terminalIds: remove,
              mutationSeq,
            }))
          }
        }
```

- [ ] **Step 5: Typecheck**

Run: `npm run check`
Expected: PASS. (Functional verification happens in Task 4.3's tests once the projection reads the slice.)

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(client): request and apply claude.activity snapshots/updates

Rehydrate Claude activity on connect/reconnect and apply live updates, mirroring
the codex/opencode overlay lifecycle.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4.3: pane-activity — Claude busy reads the server record by terminalId (fixes #2, #9)

**Files:**
- Modify: `src/lib/pane-activity.ts:18,37-39,147-191,225-233,270-278`
- Test: `test/unit/client/lib/pane-activity.test.ts` (extend; existing calls also need updating — see Step 1)
- Test: `test/e2e/pane-activity-indicator-flow.test.tsx` (existing claude-terminal blue case must be re-driven — see Step 1)

- [ ] **Step 1: Write the failing projection test**

Add to the pane-activity test file:
```ts
it('treats a claude terminal as busy when the server record is busy', () => {
  const result = resolvePaneActivity({
    paneId: 'p1',
    content: { kind: 'terminal', createRequestId: 'c1', status: 'running', mode: 'claude', terminalId: 't1' } as any,
    isOnlyPane: true,
    codexActivityByTerminalId: {},
    opencodeActivityByTerminalId: {},
    claudeActivityByTerminalId: { t1: { terminalId: 't1', phase: 'busy', updatedAt: 1 } },
    paneRuntimeActivityByPaneId: {},
    agentChatSessions: {},
  })
  expect(result).toEqual({ isBusy: true, source: 'claude-terminal' })
})

it('treats a claude terminal as idle when the server record is idle or absent', () => {
  const base = {
    paneId: 'p1',
    content: { kind: 'terminal', createRequestId: 'c1', status: 'running', mode: 'claude', terminalId: 't1' } as any,
    isOnlyPane: true,
    codexActivityByTerminalId: {},
    opencodeActivityByTerminalId: {},
    paneRuntimeActivityByPaneId: {},
    agentChatSessions: {},
  }
  expect(resolvePaneActivity({ ...base, claudeActivityByTerminalId: { t1: { terminalId: 't1', phase: 'idle', updatedAt: 1 } } }).isBusy).toBe(false)
  expect(resolvePaneActivity({ ...base, claudeActivityByTerminalId: {} }).isBusy).toBe(false)
})
```

**Also update the existing tests in this file** — `claudeActivityByTerminalId` becomes a **required** field (mirroring `codexActivityByTerminalId`/`opencodeActivityByTerminalId`, which every existing call already passes), so each of the 10 existing `resolvePaneActivity(...)`/`collectBusySessionKeys(...)` calls (at lines ~18, 31, 44, 69, 81, 149, 187, 239, 293, 345) must add `claudeActivityByTerminalId: {},` alongside the existing `codexActivityByTerminalId:`. (`test/` is excluded from the typecheck, so a missing field is a runtime `TypeError` on `input.claudeActivityByTerminalId[terminalId]`, not a compile error — add it to all of them.)

One of those, the test at ~line 94 (`collects busy session keys from claude terminals and freshclaude panes`), drives the **claude-terminal** pane busy via `paneRuntimeActivityByPaneId['pane-claude']` `phase: 'working'` (lines ~154-157). That no longer makes a claude *terminal* busy — re-drive it through the server map: pass `claudeActivityByTerminalId: { 'term-claude': { terminalId: 'term-claude', phase: 'busy', updatedAt: 1 } }` and drop the `'pane-claude'` entry from `paneRuntimeActivityByPaneId` (leave the **freshclaude** pane's busy mechanism untouched — freshclaude is a separate provider path this plan does not change; the test must still yield both `claude:${claudeSessionId}` and `claude:${freshSessionId}`).

**Re-drive the e2e claude case.** `test/e2e/pane-activity-indicator-flow.test.tsx` has a test (~lines 303-354, `keeps claude terminals non-blue while pending, blue while working, and clears on idle`) that dispatches `setPaneRuntimeActivity({ phase: 'working' })` for `term-claude` and asserts `text-blue-500`. After this phase, the claude icon's blue comes from the `claudeActivity` slice, not runtime activity. Rewrite the test to dispatch `upsertClaudeActivity({ terminals: [{ terminalId: 'term-claude', phase: 'busy', updatedAt: 1 }] })` to assert blue and `{ phase: 'idle' }` (or `removeClaudeActivity`) to assert non-blue. Drop the `pending` sub-assertion — the new model has no `pending` phase (busy is immediate on submit); an absent/`idle` record is non-blue. Ensure the e2e store includes the `claudeActivity` reducer (added to `store.ts` in Task 4.1; if this test builds a custom store, add `claudeActivity: claudeActivityReducer`).

**Also re-drive the Playwright browser spec.** `test/e2e-browser/specs/pane-activity-indicator.spec.ts` has the test `'claude terminals transition from pending to blue working and back on completion'` (~lines 170-248) that dispatches `{ type: 'paneRuntimeActivity/setPaneRuntimeActivity', payload: { ..., phase: 'working' } }` (lines ~230-237) and asserts `expectChromeBlue(page, tabId, true)` (line 239). This breaks identically after Phase 4.3. This spec is **not** in the vitest coordinator gate (it runs under `npm run test:e2e` / Playwright, not `npm run check`), so no per-phase gate goes red — but it is a real, now-broken test that the product contract governs, so fix it in this phase. Rewrite the two `setPaneRuntimeActivity` dispatches to `{ type: 'claudeActivity/upsertClaudeActivity', payload: { terminals: [{ terminalId: 'term-e2e-claude', phase: 'busy', updatedAt: 1 }] } }` for blue and `phase: 'idle'` (or `claudeActivity/removeClaudeActivity`) for non-blue; drop the `pending` sub-step. The pane content currently has `terminalId: undefined` (line ~187) / no terminalId on the leaf (~199-204) — set a concrete `terminalId: 'term-e2e-claude'` on the claude pane content so the slice lookup resolves.

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:vitest -- run test/unit/client/lib/pane-activity.test.ts`
Expected: FAIL — `claudeActivityByTerminalId` is not yet an accepted input; the Claude branch still reads `paneRuntimeActivity`.

- [ ] **Step 3: Wire the new input through the three functions**

In `src/lib/pane-activity.ts`:

Add `ClaudeActivityRecord` to the type import (line 18):
```ts
import type { CodexActivityRecord, ClaudeActivityRecord, OpencodeActivityRecord } from '@shared/ws-protocol'
```

Remove the now-unused `isClaudeTerminalBusy` helper (lines 37-39).

Add the parameter to `resolvePaneActivity`'s input type (after `opencodeActivityByTerminalId`, line 153):
```ts
  claudeActivityByTerminalId: Record<string, ClaudeActivityRecord>
```

Replace the Claude branch (lines 187-189) with:
```ts
    if (effectiveMode === 'claude') {
      const terminalId = input.content.terminalId
      const record = terminalId
        ? input.claudeActivityByTerminalId[terminalId]
        : undefined
      return record?.phase === 'busy'
        ? { isBusy: true, source: 'claude-terminal' }
        : IDLE_PANE_ACTIVITY
    }
```

Add `claudeActivityByTerminalId: Record<string, ClaudeActivityRecord>` to the input types of `getBusyPaneIdsForTab` (line 229) and `collectBusySessionKeys` (line 273), and thread `claudeActivityByTerminalId: input.claudeActivityByTerminalId,` into every internal `resolvePaneActivity({...})` call inside those two functions (the synthetic-content call and the per-entry calls). The four call openings are at lines ~239, ~256, ~287, ~307; thread the new key alongside the existing `codexActivityByTerminalId:` line in each (at ~244, ~261, ~292, ~312).

> `runtimeActivity` is still used by the browser branch (`isBrowserBusy`), so keep the `const runtimeActivity = ...` line (158) and the browser logic intact.

- [ ] **Step 4: Update the 5 external call sites to pass the new map**

For each file below, add a selector for the Claude activity map mirroring the file's existing `codexActivityByTerminalId` selector (including a stable empty-object constant like the file's `EMPTY_CODEX_ACTIVITY_BY_ID` if it uses one), and pass `claudeActivityByTerminalId` into the call:

Selector (mirror the codex one already in each file):
```ts
const claudeActivityByTerminalId = useAppSelector((s) => s.claudeActivity?.byTerminalId ?? EMPTY_CLAUDE_ACTIVITY_BY_ID)
```
Pass it into the call object alongside `codexActivityByTerminalId,`:
```ts
      claudeActivityByTerminalId,
```

Sites:
- `src/components/MobileTabStrip.tsx` — selector near line 29; pass into `getBusyPaneIdsForTab({...})` near line 48.
- `src/components/TabSwitcher.tsx` — pass into `getBusyPaneIdsForTab({...})` near line 106.
- `src/components/TabBar.tsx` — pass into `getBusyPaneIdsForTab({...})` near line 222.
- `src/components/Sidebar.tsx` — pass into `collectBusySessionKeys({...})` near line 317.
- `src/components/panes/PaneContainer.tsx` — pass into `resolvePaneActivity({...})` near line 486.

- [ ] **Step 5: Run pane-activity tests + e2e + typecheck (typecheck enforces all 5 production call sites updated)**

Run:
```bash
npm run test:vitest -- run test/unit/client/lib/pane-activity.test.ts test/e2e/pane-activity-indicator-flow.test.tsx
npm run check
```
Expected: PASS. (TypeScript fails any production caller that did not supply `claudeActivityByTerminalId`; the e2e confirms the claude icon goes blue from the server map.)

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(client): derive Claude pane busy from server activity by terminalId

resolvePaneActivity reads claudeActivity.byTerminalId (phase busy => blue) instead
of the pane-local paneRuntimeActivity ref. Fixes blue-on-reconnect (#2) and blue
immediately on submit (#9, server marks busy on submit). All 5 call sites updated.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4.4: TerminalView — stop writing paneRuntimeActivity for Claude

The client no longer derives Claude busy. Remove the submit→pending and output→working writes for Claude. **Keep** display BEL-stripping (`extractTurnCompleteSignals` → `cleaned`) and **keep** the `recordTurnComplete` dispatch for now (Phase 5 removes it for Claude).

**Files:**
- Modify: `src/components/TerminalView.tsx:111-113,640-647,1043-1055`
- Test: `test/unit/client/components/TerminalView.lifecycle.test.tsx` (existing claude busy tests must be updated)

- [ ] **Step 1: Update the existing claude busy lifecycle test expectations**

In `test/unit/client/components/TerminalView.lifecycle.test.tsx`, the Claude-mode tests assert the **resulting store state** (the action-creator name does not appear in the file — grep for `setPaneRuntimeActivity` returns nothing; grep for `paneRuntimeActivity.byPaneId`). The relevant assertions are at lines ~1032, 1061, 1152, 1183, 1289, 1318, 1353, 1369:
```ts
expect(store.getState().paneRuntimeActivity.byPaneId[paneId]).toMatchObject({
  source: 'terminal',
  phase: 'pending', // or 'working'
})
```
Claude busy is now server-driven, so `TerminalView` must **not** write `paneRuntimeActivity` for `mode: 'claude'`. Change each of those eight to assert the entry stays absent:
```ts
expect(store.getState().paneRuntimeActivity.byPaneId[paneId]).toBeUndefined()
```
(This matches the already-`toBeUndefined()` assertions elsewhere in the same tests at ~1076/1199/1213/1333/1346/1467. Do not touch non-claude tests in this file — codex/shell keep their runtime-activity behavior.)

- [ ] **Step 2: Run to verify the updated tests fail against current code**

Run: `npm run test:vitest -- run test/unit/client/components/TerminalView.lifecycle.test.tsx`
Expected: FAIL — current code still dispatches `setPaneRuntimeActivity` for Claude.

- [ ] **Step 3: Remove the Claude submit→pending write**

In `sendInput` (lines 640-647), delete the Claude block:
```ts
    if (contentRef.current?.mode === 'claude' && isClaudeTurnSubmit(data)) {
      turnCompletedSinceLastInputRef.current = false
      dispatch(setPaneRuntimeActivity({
        paneId: paneIdRef.current,
        source: 'terminal',
        phase: 'pending',
      }))
    }
```
(Keep the surrounding attention-clear logic at 632-638 and `ws.send(...)` at 648.)

Delete the now-unused `isClaudeTurnSubmit` function (lines 111-113).

- [ ] **Step 4: Remove the Claude output→working write**

Delete the working-dispatch block (lines 1043-1055):
```ts
    if (
      mode === 'claude'
      && cleaned
      && count === 0
      && !seqStateRef.current.pendingReplay
      && !turnCompletedSinceLastInputRef.current
    ) {
      dispatch(setPaneRuntimeActivity({
        paneId: paneIdRef.current,
        source: 'terminal',
        phase: 'working',
      }))
    }
```
(Leave the `count > 0` recordTurnComplete block at 1030-1041 unchanged for now; Phase 5 edits it. Leave `if (cleaned) enqueueTerminalWrite(cleaned)` intact — display stripping is preserved.)

Remove unused imports if `setPaneRuntimeActivity` is no longer referenced anywhere in the file (check: `grep -n setPaneRuntimeActivity src/components/TerminalView.tsx`). If browser-pane logic still uses it, keep the import.

- [ ] **Step 5: Run to verify it passes + typecheck**

Run:
```bash
npm run test:vitest -- run test/unit/client/components/TerminalView.lifecycle.test.tsx
npm run check
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(client): stop deriving Claude busy in TerminalView

Claude busy is now server-authoritative (claudeActivity). Remove the
submit->pending and output->working paneRuntimeActivity writes; keep BEL display
stripping. recordTurnComplete still client-driven until the next phase.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

# Phase 5 — Switch turn-complete to the server + dedup (fixes #1, #4, #5, #14; tests #12)

Server emits `terminal.turn.complete` for Claude; the client stops minting Claude turn-complete from replayable BEL bytes. This eliminates phantom bells on replay/reattach/reload because the server event is live-only and the client no longer counts scrollback BELs for Claude. Add a per-`(terminalId, at)` dedup guard as defense-in-depth and retire the dead `lastEvent`.

### Task 5.1: turnCompletionSlice — per-turn dedup, drop dead lastEvent (#14)

**Files:**
- Modify: `src/store/turnCompletionSlice.ts:12-40`
- Test: `test/unit/client/store/turnCompletionSlice.test.ts` (extend, or create)

- [ ] **Step 1: Write the failing dedup test**

Add to the turnCompletionSlice test file:
```ts
import reducer, { recordTurnComplete } from '@/store/turnCompletionSlice'

it('ignores a duplicate turn-complete with the same terminalId and at', () => {
  let state = reducer(undefined, recordTurnComplete({ tabId: 'tab1', paneId: 'p1', terminalId: 't1', at: 5000 }))
  state = reducer(state, recordTurnComplete({ tabId: 'tab1', paneId: 'p1', terminalId: 't1', at: 5000 }))
  expect(state.pendingEvents).toHaveLength(1)
})

it('records distinct turns for the same terminal at different times', () => {
  let state = reducer(undefined, recordTurnComplete({ tabId: 'tab1', paneId: 'p1', terminalId: 't1', at: 5000 }))
  state = reducer(state, recordTurnComplete({ tabId: 'tab1', paneId: 'p1', terminalId: 't1', at: 6000 }))
  expect(state.pendingEvents).toHaveLength(2)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:vitest -- run test/unit/client/store/turnCompletionSlice.test.ts`
Expected: FAIL — the duplicate is currently recorded twice.

- [ ] **Step 3: Add the dedup guard, remove `lastEvent`**

In `src/store/turnCompletionSlice.ts`, replace the state shape and `recordTurnComplete`:
```ts
export interface TurnCompletionState {
  seq: number
  lastAtByTerminalId: Record<string, number>
  pendingEvents: TurnCompleteEvent[]
  attentionByTab: Record<string, boolean>
  attentionByPane: Record<string, boolean>
}

const initialState: TurnCompletionState = {
  seq: 0,
  lastAtByTerminalId: {},
  pendingEvents: [],
  attentionByTab: {},
  attentionByPane: {},
}
```
and
```ts
    recordTurnComplete(state, action: PayloadAction<TurnCompletePayload>) {
      const { terminalId, at } = action.payload
      if (state.lastAtByTerminalId[terminalId] === at) return
      state.lastAtByTerminalId[terminalId] = at
      state.seq += 1
      state.pendingEvents.push({
        ...action.payload,
        seq: state.seq,
      })
    },
```
Remove `lastEvent` from the interface, the initial state, and the `recordTurnComplete` body. It is never read in production (`grep -rn "lastEvent" src/` matches only this slice), but it **is** referenced across the test suite — both real assertions and ~21 initial-state builder literals — so this is not a one-line change. Do all of the following (then `grep -rn "lastEvent" test/ src/` must return nothing):

**a) Rewrite the asserting tests to assert `pendingEvents` instead.** These read `lastEvent`:
- `test/unit/client/store/turnCompletionSlice.test.ts:24-28,43` — replace `state.lastEvent?.seq|tabId|paneId|terminalId|at` assertions with the equivalent against `state.pendingEvents.at(-1)` (the most-recent event).
- `test/unit/client/components/TerminalView.lifecycle.test.tsx:867-869` — replace `lastEvent?.tabId|paneId|terminalId` with `pendingEvents.at(-1)?....`.
- `test/unit/client/components/TerminalView.lifecycle.test.tsx:957,1553,4683,4722` — replace `expect(...lastEvent).toBeNull()` with `expect(...pendingEvents).toHaveLength(0)`.
- `test/unit/client/components/App.ws-bootstrap.test.tsx:1102,1196` — **do NOT** rewrite these to `pendingEvents.at(-1)`. These tests render the full `<App/>`, which mounts `useTurnCompletionNotifications`; that hook dispatches `consumeTurnCompleteEvents`, so `pendingEvents` is **drained** by the time `waitFor` settles (`pendingEvents.at(-1)` would be `undefined`). `lastEvent` was used here precisely because it survives consumption. Assert instead against surfaces that survive and still prove the `terminalId → tabId/paneId` routing: the hook calls `markTabAttention`/`markPaneAttention` *unconditionally* before consuming, and the new `lastAtByTerminalId` is never cleared. Rewrite:
  - test at ~1102 (`tab-opencode`/`pane-opencode`/`term-opencode`/at 1234):
    ```ts
    await waitFor(() => {
      expect(store.getState().turnCompletion.attentionByPane['pane-opencode']).toBe(true)
    })
    expect(store.getState().turnCompletion.attentionByTab['tab-opencode']).toBe(true)
    expect(store.getState().turnCompletion.lastAtByTerminalId['term-opencode']).toBe(1234)
    expect(store.getState().turnCompletion.seq).toBe(1)
    ```
  - test at ~1196 (active-tab duplicate; `tab-active`/`pane-active`/`term-opencode`/at 5678): assert routing landed on the **active** tab —
    ```ts
    await waitFor(() => {
      expect(store.getState().turnCompletion.attentionByPane['pane-active']).toBe(true)
    })
    expect(store.getState().turnCompletion.attentionByTab['tab-active']).toBe(true)
    expect(store.getState().turnCompletion.lastAtByTerminalId['term-opencode']).toBe(5678)
    expect(store.getState().turnCompletion.seq).toBe(1)
    ```
  (Keep each test's existing `seq` assertion. `attentionBy*` survives because the click-mode clear effect only fires on a tab *switch*, which does not occur on initial mount.)

**b) Strip the `lastEvent: null` literals from every `turnCompletion` initial-state builder.** There are ~31 occurrences across ~21 files (`grep -rn "lastEvent: null" test/ src/` to enumerate; `TerminalView.lifecycle.test.tsx` alone has 9). **`test/` is not typechecked** (`tsconfig.json` includes only `src`/`shared`; `npm run check` runs `tsc` on the app + server projects, not the tests), so these stray literals are **not** compile errors — they are harmless excess properties at runtime and nothing forces their removal automatically. Delete the `lastEvent: null,` line from each preloaded-state object by hand for cleanliness — the **only** completeness guard is the final `grep -rn "lastEvent" test/ src/` returning nothing, so run it and don't stop after the first handful.

> Because `test/` is excluded from the typecheck, neither the leftover `lastEvent: null` literals (b) nor the `lastEvent` reads (a) are caught by `npm run check` — they all fail (or silently linger) only at test runtime. Rewrite every site in (a) by hand per the list above and strip every literal in (b); the `grep -rn "lastEvent" test/ src/` check is the sole guard that you got them all.

- [ ] **Step 4: Run to verify it passes + typecheck**

Run:
```bash
npm run test:vitest -- run test/unit/client/store/turnCompletionSlice.test.ts
npm run check
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(client): dedup turn-complete by (terminalId, at); drop dead lastEvent

Belt-and-suspenders against double-fire when both the client and server briefly
produce a completion for the same turn. lastEvent was never read.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 5.2: Server emits Claude turn.complete; client stops client-side Claude completion

**Files:**
- Modify: `server/index.ts:430-435`
- Modify: `src/components/TerminalView.tsx:426,1030-1041`

- [ ] **Step 1: Write the failing server test for Claude turn.complete broadcast**

Extend `test/server/ws-claude-activity.test.ts`: drive a claude terminal create + submit (`terminal.input.raw` with `\r`) + output containing `\x07`, and assert authenticated clients receive a `terminal.turn.complete` with `provider: 'claude'` and the right `terminalId`; assert it is emitted exactly once per BEL-completed turn and is **not** re-emitted when the same scrollback is replayed (the tracker only consumes live `terminal.output.raw`, so reattach does not re-feed it). Model the harness on the opencode turn.complete coverage if present.

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:vitest -- run test/server/ws-claude-activity.test.ts`
Expected: FAIL — server does not broadcast `terminal.turn.complete` for Claude.

- [ ] **Step 3: Wire the tracker's turn.complete to the broadcast**

In `server/index.ts`, after the opencode turn.complete wiring (lines 430-435), add:
```ts
  claudeActivity.tracker.on('turn.complete', (payload) => {
    wsHandler.broadcastTerminalTurnComplete({
      provider: 'claude',
      terminalId: payload.terminalId,
      at: payload.at,
      ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
    })
  })
```

- [ ] **Step 4: Stop the client from minting Claude turn-complete from BEL**

In `src/components/TerminalView.tsx`, change the `count > 0` block (lines 1030-1041) so Claude no longer dispatches `recordTurnComplete` (the server now owns it) while **codex** keeps its client-side path:
```ts
    if (count > 0 && tid && mode !== 'claude') {
      dispatch(recordTurnComplete({
        tabId,
        paneId: paneIdRef.current,
        terminalId: tid,
        at: Date.now(),
      }))
    }
```
Delete the Claude sub-block that cleared `paneRuntimeActivity` and set the ref (old lines 1037-1040). The BEL is still stripped from `cleaned` for display.

Remove the now-fully-dead `turnCompletedSinceLastInputRef` declaration (line 426) and confirm no references remain: `grep -n turnCompletedSinceLastInputRef src/components/TerminalView.tsx` returns nothing.

- [ ] **Step 5: Run server + client tests + full check**

Run:
```bash
npm run test:vitest -- run test/server/ws-claude-activity.test.ts test/unit/client/components/TerminalView.lifecycle.test.tsx
npm run check
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat: server-owned Claude turn.complete; client stops counting replayable BELs

Server tracker broadcasts terminal.turn.complete(provider=claude) once per real
turn. TerminalView no longer dispatches recordTurnComplete for Claude (codex path
unchanged). Eliminates phantom bell on replay/reattach/reload (#1).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 5.3: Regression tests for the two highest-impact behaviors (#12)

**Files:**
- Test: `test/unit/client/components/TerminalView.lifecycle.test.tsx` (add)
- Test: `test/e2e/turn-complete-notification-flow.test.tsx` or a new e2e (reconnect-mid-turn)

- [ ] **Step 1: Replay-BEL suppression test (client)**

Add a test in `TerminalView.lifecycle.test.tsx` using a **claude-mode** harness: send an `attach.ready`/replay window and an output frame inside the replay window containing `\x07`, and assert `recordTurnComplete` is **not** dispatched (Claude no longer counts client BELs at all). This guards against any regression that re-introduces client-side Claude completion.

```ts
it('does not record a Claude turn-complete from replayed scrollback BEL', () => {
  // Mount TerminalView in claude mode; deliver a replayed output frame containing \x07.
  // Assert no recordTurnComplete action was dispatched (the slice's pendingEvents stays empty).
})
```

- [ ] **Step 2: Reconnect-mid-turn stays blue test (e2e/integration)**

Add a test that: submits a Claude turn (server marks busy → `claude.activity.updated` busy), simulates a transport reconnect (client re-requests `claude.activity.list`, server replies busy), and asserts the pane is rendered blue throughout (no green flash). This is the #2 regression guard and exercises the full rehydration path.

- [ ] **Step 3: Run the new tests**

Run:
```bash
npm run test:vitest -- run test/unit/client/components/TerminalView.lifecycle.test.tsx test/e2e/turn-complete-notification-flow.test.tsx
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
test: regression coverage for replay-BEL suppression and reconnect-mid-turn

Locks in #1 (no phantom bell from replay) and #2 (pane rehydrates blue after
reconnect) so they cannot silently regress.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

# Phase 6 — Restore the codex turn-complete bell (#11)

The MCP-orchestration refactor dropped codex's `-c tui.notification_method=bel` config while keeping Claude's Stop hook, so finished codex turns in background tabs go silent. The client codex BEL pipeline still works; only the server-side bell source is missing. Restore the args and pin them with a test.

### Task 6.1: Re-add codex bell args in providerNotificationArgs

**Files:**
- Modify: `server/terminal-registry.ts:151-156`
- Test: `test/unit/server/terminal-registry.test.ts` — the codex spawn-arg coverage that goes through `buildSpawnSpec` and the shared `expectCodexMcpArgs(args)` helper. (`providerNotificationArgs` is **not exported**, so assert through `buildSpawnSpec`'s resolved `spec.args`, which is what every existing codex test already does.)

> **Critical:** the repo currently *locks in the #11 regression* — `expectCodexMcpArgs` asserts the bell config is **absent**, and the PowerShell-quoting test asserts the same. Those negative assertions ARE the stale spec; flipping them to positive is the RED step. The helper is reused by ~8 codex spawn tests (lines ~859, 877, 896, 906, 1370, 3032, 3301, 3700), so this single helper edit drives the failure across all of them. Restoring the args (Step 3) without this edit would instead make `npm run check` fail on those pre-existing assertions.

- [ ] **Step 1: Flip the existing negative bell assertions to positive (this is the RED)**

In `test/unit/server/terminal-registry.test.ts`, change the `expectCodexMcpArgs` helper (lines 78-80) so the two bell assertions are positive:
```ts
function expectCodexMcpArgs(args: string[]) {
  expect(args).toContain('tui.notification_method=bel')
  expect(args).toContain("tui.notifications=['agent-turn-complete']")
```
(Change only those two bell lines; leave the rest of the `expectCodexMcpArgs` body unchanged.)

In the PowerShell-quoting test (lines 1790-1791), flip the two `not.toContain` to `toContain`:
```ts
    expect(spec.args[3]).toContain("'tui.notification_method=bel'")
    expect(spec.args[3]).toContain("'tui.notifications=[''agent-turn-complete'']'")
```
(Leave the surrounding `'-c'` / `'resume'` / `'session-123'` assertions and the Claude stop-hook `/dev/tty`/`CONOUT$` assertions at 1796-1809 untouched — those concern Claude, not codex.)

There is a **second** file that locks in the regression and runs under `npm run check` (server config): `test/integration/server/codex-session-flow.test.ts:458-459`. Flip both there too (these pass through the codex `providerNotificationArgs` branch even in managed/`--remote` mode, so the bell is present after Step 3):
```ts
      expect(recordedArgs).toContain('tui.notification_method=bel')
      expect(recordedArgs).toContain("tui.notifications=['agent-turn-complete']")
```
> Confirmed these are the **only** two files asserting the bell config (`grep -rn "tui.notification_method=bel" test/`). No other negative assertion needs flipping.

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:vitest -- run test/unit/server/terminal-registry.test.ts`
Expected: FAIL — the codex branch returns only `mcpInjection.args`, so the now-positive bell assertions fail across the codex spawn tests (and the PowerShell test).

- [ ] **Step 3: Restore the args**

In `server/terminal-registry.ts`, replace the codex branch (lines 151-156):
```ts
  if (mode === 'codex') {
    return {
      args: ['-c', 'tui.notification_method=bel', '-c', "tui.notifications=['agent-turn-complete']", ...mcpInjection.args],
      env: mcpInjection.env,
    }
  }
```

- [ ] **Step 4: Run to verify it passes + check**

Run:
```bash
npm run test:vitest -- run test/unit/server/terminal-registry.test.ts
npm run check
```
Expected: PASS — the flipped bell assertions now hold and no other codex spawn test regressed.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
fix(server): restore codex turn-complete bell config (parity regression)

Re-add -c tui.notification_method=bel and -c tui.notifications=['agent-turn-complete']
dropped in the MCP-orchestration refactor, with a test pinning the args.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

# Final verification

- [ ] **Run the full coordinated suite + build**

Run:
```bash
FRESHELL_TEST_SUMMARY="claude status/notification robustness" npm run verify
```
Expected: build succeeds; full default + server suites green.

- [ ] **Manual smoke (worktree server on a unique port; do NOT restart the self-hosted dev server)**

Start a throwaway server from the worktree (`PORT=3344 npm run dev:server > /tmp/freshell-3344.log 2>&1 & echo $! > /tmp/freshell-3344.pid`), open it, and verify against the product contract:
1. New Claude tab → submit a prompt → icon turns **blue immediately** (before first output).
2. Turn finishes → icon returns **green**, attention/sound fires once.
3. Reload the page mid-turn → pane comes back **blue** (rehydrated), then clears green on completion.
4. Reload **after** a turn completed → **no** phantom bell / attention on load.
5. Paste multi-line text → pane stays green (no false busy).
6. Codex tab in background finishes a turn → bell + attention.

Stop it: `kill "$(cat /tmp/freshell-3344.pid)" && rm -f /tmp/freshell-3344.pid`.

- [ ] **Open the PR to `origin/main`** (do not self-approve; `dev` consumes the PR head separately).

---

## Self-Review

**Spec coverage** — each in-scope finding maps to a phase: #13→P0; #4/#5 predicate foundation→P1; #3 deadman + #4/#5 server enforcement→P2; protocol/transport→P3; #2/#9→P4; #1/#14 + #12 tests→P5; #11→P6. The product contract's six bullets each have a manual-smoke step and at least one automated test.

**Placeholder scan** — server tracker/wiring/slice code is complete and verbatim-mirrored from the codex/opencode references that were read in full. The three areas given as instructions-plus-pattern rather than full literals are (a) the 5 pane-activity call-site selector additions (identical 2-line change mirroring each file's existing codex selector; exact file+line anchors given), (b) the slice test (explicit "copy codexActivitySlice.test.ts, rename codex→claude"), and (c) the ws/e2e integration tests (explicit "mirror ws-codex-activity.test.ts harness" with the exact assertions enumerated). These reference concrete existing artifacts, not TBDs.

**Type consistency** — `ClaudeActivityRecord` (`{terminalId, sessionId?, phase: 'idle'|'busy', updatedAt}`) is identical across the tracker, the protocol schema, and the slice. The tracker's `ClaudeTurnCompleteEvent` (`{terminalId, sessionId?, at}`) feeds `broadcastTerminalTurnComplete` whose schema now allows optional `sessionId` and `provider: 'claude'`. Slice action names (`setClaudeActivitySnapshot`/`upsertClaudeActivity`/`removeClaudeActivity`/`resetClaudeActivity`) match their App.tsx dispatch sites. `wireClaudeActivityTracker` returns `{ tracker, dispose }`, matching the `claudeActivity.tracker.list()` / `.on('changed')` / `.on('turn.complete')` / `.dispose()` usages in `server/index.ts`.

---

# Follow-on Plan (Workstream B): Unified Surfacing, Attention Lifecycle & Escalation

This is a **separate plan** to be written (via writing-plans) once Plan 1 merges, because its components depend on the `claudeActivity` slice and the deduped, server-driven turn-complete events Plan 1 establishes, and it touches a different subsystem (presentational surfacing + notification UX). It resolves #6, #7, #8, #10, #15 + optional marker hardening.

**Why separate:** Plan 1 fixes *who owns the truth* (server) and *how events are produced* (once, live, deduped). Workstream B fixes *how that truth is shown* across the UI and *how the user is alerted at the OS level*. Mixing them would couple a backend lifecycle migration to ~11 presentational files.

### Roadmap (each becomes a TDD phase when expanded)

1. **Shared activity selector + `<ActivityIndicator>` primitive (#6, #15).**
   - One selector: `(tabId | paneId) → 'attention' | 'busy' | 'idle'`, layering `attentionByTab`/`attentionByPane` over `getBusyPaneIdsForTab` / `collectBusySessionKeys`.
   - One presentational component with a fixed vocabulary (emerald = attention, blue = busy, neutral = idle), replacing the four ad-hoc vocabularies in `TabItem`, `PaneHeader`, `Sidebar`, `MobileTabStrip`, `TabSwitcher`.
   - Adopt it in the six surfaces that currently render nothing for attention: `Sidebar`, `MobileTabStrip`, `TabSwitcher`, `OverviewView`, `BackgroundSessions`, `TabsView` (mobile-critical: the desktop tab bar is hidden on mobile).
   - De-collide `OverviewView`'s green `animate-pulse-subtle` ring (currently fires for any `running` terminal) with the emerald attention pulse.
   - Centralize the "should the glyph be blue" precedence so `StatusDot` (guarded `busy && status==='running'`) and the per-pane icon / Sidebar (unguarded) cannot diverge for fresh-agent panes (#15).
   - Files: new `src/components/ActivityIndicator.tsx`, new selector in `src/lib/pane-activity.ts` or a new `src/lib/activity-presentation.ts`; modify the 8 surfaces.

2. **Attention lifecycle correctness (#7, #8).**
   - New reducer `clearTabAndPanesAttention({ tabId, paneIds })` so tab and pane attention cannot disagree; call it on tab activation in the `click`-mode effect (clear **all** the tab's panes, not just the active one).
   - Decide + implement focused-active-tab behavior: a completion on the already-active focused tab should clear (not latch) when `windowFocused && activeTabId === event.tabId`.
   - Invalidate attention when a terminal leaves `running`: clear `attentionByPane`/`attentionByTab` in the `terminal.exit` handler and on TerminalView unmount (mirror `BrowserPane`'s unmount cleanup). Architecturally: treat attention as derived/transient, invalidated by lifecycle.
   - Add the missing multi-pane switch test (second non-active pane in a switched-to tab).
   - **Non-goals (verification-refuted):** no paneId GC for replaced/split panes (IDs are preserved; `closeTab` already GCs); no attention persistence handling (`turnCompletion` is not persisted).

3. **OS/browser escalation (#10).**
   - In `useTurnCompletionNotifications` (the single convergence point for BEL and server `turn.complete`): when a completion targets a non-active tab or the window is unfocused/hidden, update `document.title` with an unread count/flash (cleared by the existing focus/visibility handlers), and optionally fire a Web Notification behind a settings toggle + `Notification.requestPermission`, with sound as fallback.
   - Do **not** use `term.onBell` (a raw bell would also fire on incidental shell bells; the mode-aware turn-complete signal is the correct trigger).

4. **(Optional) Stop-hook marker hardening.**
   - Plan 1 already neutralizes the practical false-positive (the server only counts a BEL while a turn is in flight, and filters stray mid-output BELs). If further robustness is wanted, replace/supplement the bare BEL with a Freshell-specific OSC marker carrying `FRESHELL_TERMINAL_ID`, parsed and stripped server-side, with BEL kept as a fallback for older sessions. Defer unless a concrete false-positive is observed.

When ready, run writing-plans against this roadmap to produce `docs/superpowers/plans/<date>-unified-activity-surfacing.md`.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-29-claude-status-notification-robustness.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
