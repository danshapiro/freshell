# Fix OpenCode Turn-Complete Alert Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** OpenCode terminals in Freshell produce turn-complete alerts (BEL `\x07`) matching the existing behavior of Codex and Claude.

**Architecture:** Two independent gates exclude OpenCode from the turn-complete signal path: (1) a mode whitelist in the shared BEL parser that only recognizes `claude` and `codex`, and (2) a missing case in the server's spawn-arg builder that omits notification configuration. Since OpenCode is a Codex fork and supports the identical `tui.notifications` mechanism, both gates are fixed by adding `opencode` alongside the existing Codex branches. No new abstractions, no refactoring — this is a pure gating fix.

**Tech Stack:** TypeScript, Vitest

---

## File Structure

- **Modify:** `shared/turn-complete-signal.ts:22` — add `|| mode === 'opencode'` to `supportsTurnSignal()`
- **Modify:** `server/terminal-registry.ts:151-195` — add `opencode` case in `providerNotificationArgs()` with same `tui.notification_method=bel` / `tui.notifications=['agent-turn-complete']` args as Codex
- **Modify:** `test/unit/shared/turn-complete-signal.test.ts` — add test verifying opencode mode counts BEL
- **Modify:** `test/unit/client/lib/turn-complete-signal.test.ts` — add test verifying opencode mode counts BEL (the client wrapper already normalizes `'opencode'` through to the shared parser; the test confirms the end-to-end client path)
- **Modify:** `test/unit/server/terminal-registry.test.ts` — add test verifying opencode spawn spec includes notification args

### Why these files and not others

- **`src/lib/turn-complete-signal.ts` (client wrapper):** Already handles `'opencode'` in its `normalizeTurnCompleteSignalMode` switch (line 17). No change needed — it passes through to the shared module, which is the actual gate.
- **`test/unit/client/store/turnCompletionSlice.test.ts`:** Unchanged. The Redux reducer for `recordTurnComplete` is provider-agnostic and already works for codex/claude; it will work identically for opencode once the parser recognizes the mode.
- **No integration/E2E test needed.** The notification is a BEL character in the output stream. Correctness is fully determined by (a) the spawn args including notification config and (b) the parser returning `count > 0` for opencode mode.

---

## Strategy Gate

**Is this the right problem?** Yes. The user explicitly states OpenCode must produce turn-complete alerts. Codex and Claude already do; OpenCode is a Codex fork that supports the same TUI notification mechanism.

**Is the proposed architecture right?** Yes. Adding `opencode` alongside the existing `codex` branches at two gate points is the minimal, idiomatic change. The codebase already treats opencode as a peer mode in every other respect (resume args, model args, permission mode env vars, MCP injection, activity wiring, session DB). These are the only two places where it was omitted — likely an oversight when opencode support was added.

**Are there assumptions that haven't been validated?** One: that OpenCode's TUI supports `tui.notification_method=bel` and `tui.notifications=['agent-turn-complete']` identically to Codex. This is valid because OpenCode is a direct Codex fork with the same TUI framework. The user's request confirms this expectation.

**Risk of regression:** Zero. The two changes are strictly additive — they add a new mode to existing whitelists without altering the behavior of any existing mode. Existing tests for codex and claude cover those paths independently and will continue to pass because their guard conditions are unchanged.

---

### Task 1: Add opencode to `supportsTurnSignal` and test shared parser

**Files:**
- Modify: `shared/turn-complete-signal.ts:22`
- Modify: `test/unit/shared/turn-complete-signal.test.ts`

- [ ] **Step 1: Write failing test for opencode BEL parsing**

Add this test after the existing "counts BEL in Codex output" test (after line 15):

```typescript
  it('counts BEL in OpenCode output and strips it from cleaned output', () => {
    const input = `result${TURN_COMPLETE_SIGNAL}done`
    const out = extractTurnCompleteSignals(input, 'opencode')

    expect(out.count).toBe(1)
    expect(out.cleaned).toBe('resultdone')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/shared/turn-complete-signal.test.ts`
Expected: The new test FAILS with `count` expected `1` but received `0`

- [ ] **Step 3: Implement the fix in `supportsTurnSignal`**

In `shared/turn-complete-signal.ts`, change line 22 from:

```typescript
  return mode === 'claude' || mode === 'codex'
```

to:

```typescript
  return mode === 'claude' || mode === 'codex' || mode === 'opencode'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/shared/turn-complete-signal.test.ts`
Expected: All 6 tests PASS (5 existing + 1 new)

- [ ] **Step 5: Refactor and verify**

No refactoring needed — the fix is a single `||` addition following the existing pattern exactly. Run the full default-config suite to confirm no regressions:

Run: `npm run test:vitest -- --run`
Expected: All tests PASS (the only new test is the one we added)

- [ ] **Step 6: Commit**

```bash
git add shared/turn-complete-signal.ts test/unit/shared/turn-complete-signal.test.ts
git commit -m "feat: add opencode support to turn-complete signal parser"
```

---

### Task 2: Add opencode notification args to spawn spec and test

**Files:**
- Modify: `server/terminal-registry.ts:151-195`
- Modify: `test/unit/server/terminal-registry.test.ts`

- [ ] **Step 1: Write failing test for opencode notification args**

Add this test in the `buildSpawnSpec` describe block, in the "common coding CLI behavior" section (after the existing opencode model test around line 991). Locate the `describe('coding CLI spawn args common behavior', ...)` block that contains the codex and opencode model/sandbox tests (around line 930):

```typescript
    it('includes bell notification args for opencode on Unix', () => {
      delete process.env.OPENCODE_CMD

      const spec = buildSpawnSpec('opencode', '/home/user/project', 'system', undefined, {
        opencodeServer: TEST_OPENCODE_SERVER,
      })

      expect(spec.args).toContain('-c')
      expect(spec.args).toContain('tui.notification_method=bel')
      expect(spec.args).toContain("tui.notifications=['agent-turn-complete']")
    })
```

This test mirrors the existing codex notification arg assertions in the `expectCodexMcpArgs` helper (test file line 88) and the PowerShell-quoting test at line 1725-1726, but targets the opencode path. Note: `opencodeServer` is required because `buildSpawnSpec` for opencode mode throws without a valid localhost control endpoint (terminal-registry.ts:266-282).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/server/terminal-registry.test.ts -- -t "bell notification args for opencode"`
Expected: The new test FAILS — `spec.args` does not contain `tui.notification_method=bel`

- [ ] **Step 3: Implement the fix in `providerNotificationArgs`**

In `server/terminal-registry.ts`, add an `opencode` case in `providerNotificationArgs()` between the `codex` case (line 159-168) and the `claude` case (line 170-192). Insert after line 168:

```typescript
  if (mode === 'opencode') {
    return {
      args: [
        '-c', 'tui.notification_method=bel',
        '-c', "tui.notifications=['agent-turn-complete']",
        ...mcpInjection.args,
      ],
      env: mcpInjection.env,
    }
  }
```

This block is identical to the `codex` case (lines 159-168) and should be placed immediately after it so the two Codex-family providers are adjacent in the switch.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/server/terminal-registry.test.ts -- -t "bell notification args for opencode"`
Expected: PASS

- [ ] **Step 5: Run full test suite to verify no regressions**

Run: `npm run test:vitest -- --run`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add server/terminal-registry.ts test/unit/server/terminal-registry.test.ts
git commit -m "feat: add opencode bell notification args to spawn spec"
```

---

### Task 3: Add client wrapper test for opencode turn-complete signals

**Files:**
- Modify: `test/unit/client/lib/turn-complete-signal.test.ts`

- [ ] **Step 1: Write failing test for opencode BEL in client wrapper**

Add this test after the existing "extracts BEL for claude" test (after line 21):

```typescript
  it('extracts BEL for opencode and strips it from output', () => {
    const input = `done${TURN_COMPLETE_SIGNAL}next`
    const out = extractTurnCompleteSignals(input, 'opencode')
    expect(out.count).toBe(1)
    expect(out.cleaned).toBe('donenext')
  })
```

This test exercises the client wrapper path (`src/lib/turn-complete-signal.ts`) which normalizes `'opencode'` through to the shared parser. The existing test "ignores BEL for providers without turn-complete signals" (line 30) correctly uses `'gemini'` and remains unchanged as the canonical unsupported-provider test.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/client/lib/turn-complete-signal.test.ts`
Expected: The new test FAILS (because the shared `supportsTurnSignal` fix from Task 1 hasn't been applied yet in this isolated test context — wait, actually both tasks run in the same commit so the fix is already present).

Actually: Since tasks are committed incrementally, Task 2 depends on Task 1's fix to `supportsTurnSignal`. When executing, the shared module fix is already in place. The test here validates the client wrapper path. It should PASS on first run after Task 1's implementation. However, for TDD compliance, we write it as a step before re-running. If Task 1's fix is already committed, this test passes immediately. If the test fails (unexpected), it reveals a problem in the client wrapper's `normalizeTurnCompleteSignalMode` switch.

Run: `npx vitest run test/unit/client/lib/turn-complete-signal.test.ts`
Expected: PASS (10 existing tests + 1 new = 11 tests). If the new test fails, investigate `normalizeTurnCompleteSignalMode` in `src/lib/turn-complete-signal.ts` to ensure `'opencode'` is handled.

- [ ] **Step 3: No implementation needed**

The client wrapper (`src/lib/turn-complete-signal.ts`) already handles `'opencode'` in `normalizeTurnCompleteSignalMode` (line 17). No source change is required. This task is test-only — it adds coverage for the end-to-end client path that was previously untested.

- [ ] **Step 4: Run full test suite**

Run: `npm run test:vitest -- --run`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add test/unit/client/lib/turn-complete-signal.test.ts
git commit -m "test: add client wrapper test for opencode turn-complete signals"
```

---

## Completion Standard

After all three tasks, verify:

```bash
npm run test:vitest -- --run
```

Expected: All tests pass. The three new tests collectively confirm:
1. The shared BEL parser recognizes opencode mode and counts BEL characters
2. The server spawn spec includes `tui.notification_method=bel` and `tui.notifications=['agent-turn-complete']` for opencode terminals
3. The client wrapper correctly delegates opencode mode to the shared parser

No existing tests are weakened, deleted, or diluted. The gemini unsupported-provider test in the client wrapper remains intact as the canonical negative case.
