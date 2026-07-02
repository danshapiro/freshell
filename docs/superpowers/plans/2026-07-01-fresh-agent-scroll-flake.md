# Fresh Agent Scroll Flake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make FreshAgentView transcript keyboard scroll tests deterministic by preventing the transcript auto-scroll effect from running late and overwriting a user/key scroll.

**Architecture:** `FreshAgentTranscript` owns transcript scroll state and exposes an imperative scroll handle to `FreshAgentView`. The auto-scroll-to-bottom behavior mutates DOM scroll position and should run in React's layout phase, before input events can observe or change the same scroll position. Existing keyboard-scroll tests remain the regression coverage; verification stresses the formerly flaky path with repeated runs.

**Tech Stack:** React 18, TypeScript, Vitest, Testing Library, jsdom.

**Load-Bearing Validation Notes:**
- The observed `scrollTop = 1000` flake was validated as a late transcript auto-scroll write: PageDown only calls `scrollByPage(1)`, the test's mocked `scrollHeight` is `1000`, and the only non-user-action writer that can set exactly `scrollHeight` is the passive auto-scroll effect in `FreshAgentTranscript`.
- React's official `useLayoutEffect` contract says it runs after DOM commit and before repaint, and state updates scheduled from it are processed before paint. This validates using a layout effect for the scroll DOM write, with the caveat that the synchronous work must remain tightly scoped.
- The existing `atBottom` model is sufficient for this flake because the handle and scroll event recompute from the actual scroller. Broader `newMessages` semantics are out of scope for this fix.
- `npm run test:vitest` is a coordinator passthrough and repeated loop runs are fresh executions. Do not use a no-matching `-t` selector as a negative control because this Vitest version exits `0` when all tests are skipped.

## Global Constraints

- Work in `.worktrees/fresh-agent-scroll-flake` on branch `fix/fresh-agent-scroll-flake`.
- Keep the WebSocket/API surface unchanged; this is client component behavior only.
- Preserve the FreshAgentView keyboard contract: Arrow keys move one line, Page keys move one viewport minus overlap, Home/End jump to the transcript edges, and composer text input must not be intercepted.
- Use red/green/refactor: prove the existing flake, apply the smallest production fix, then stress the affected tests.
- Do not mark tests skipped, weaken assertions, or lower coverage.
- Do not restart the self-hosted Freshell server.
- The user explicitly requested "land that on main via pr too" for this flake branch, so PR creation approval is already satisfied for this branch/change.

---

### Task 1: Confirm And Guard The Scroll Race

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentTranscript.tsx`
- Test: `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`

**Interfaces:**
- Consumes: `FreshAgentTranscriptHandle.scrollByLine`, `scrollByPage`, `scrollToTop`, and `scrollToBottom`.
- Produces: The same public handle and rendered markup; only effect timing changes.

- [ ] **Step 1: Reproduce the existing flake before changing code**

Run:

```bash
for i in $(seq 1 50); do
  echo "run $i"
  npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx -t "transcript keyboard scroll" >/tmp/fresh-agent-scroll-loop-$i.log 2>&1 || {
    cat /tmp/fresh-agent-scroll-loop-$i.log
    exit 1
  }
done
echo "50 focused scroll runs passed without reproducing the known flake"
```

Expected before the fix: at least one run can fail with either PageDown receiving `1000` instead of `260`, or PageUp receiving `1000` instead of `340`. This proves a late auto-scroll-to-bottom write can win the race. If all 50 runs pass, stop and record the red step as inconclusive rather than claiming a fresh red result; the existing captured reproduction remains `PageDown expected 260 but received 1000` from the earlier 20-run loop.

- [ ] **Step 2: Confirm the test command fails when Vitest fails**

Run:

```bash
npm run test:vitest -- run test/unit/client/components/fresh-agent/__intentional_missing_file__.test.tsx
```

Expected: command exits nonzero with `No test files found`. This is the negative control for the loop harness. Do not use a no-matching `-t` selector; Vitest reports skipped tests and exits `0`.

- [ ] **Step 3: Move transcript auto-scroll DOM writes into a layout effect**

In `src/components/fresh-agent/FreshAgentTranscript.tsx`, add `useLayoutEffect` to the existing React import while preserving the file's single-line import style:

```ts
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
```

Then change only the auto-scroll effect from `useEffect` to `useLayoutEffect`:

```ts
  useLayoutEffect(() => {
    const node = scrollerRef.current
    if (!node) return
    if (atBottom) {
      node.scrollTop = node.scrollHeight
      setNewMessages(0)
    } else {
      setNewMessages((count) => count + 1)
    }
  }, [atBottom, transcriptSignature])
```

Leave the later `recomputeGlom()` effect as `useEffect`; it computes decoration state and does not need to block input/paint.

- [ ] **Step 4: Run the focused scroll tests once**

Run:

```bash
npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx -t "transcript keyboard scroll"
```

Expected: all 11 transcript keyboard scroll tests pass.

- [ ] **Step 5: Stress the formerly flaky path**

Run:

```bash
for i in $(seq 1 30); do
  echo "run $i"
  npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx -t "transcript keyboard scroll" >/tmp/fresh-agent-scroll-loop-after-$i.log 2>&1 || {
    cat /tmp/fresh-agent-scroll-loop-after-$i.log
    exit 1
  }
done
echo "30 focused scroll runs passed"
```

Expected after the fix: every run passes.

- [ ] **Step 6: Run the full affected test file**

Run:

```bash
npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx
```

Expected: the full `FreshAgentView.test.tsx` file passes.

- [ ] **Step 7: Commit the production fix**

Run:

```bash
git add src/components/fresh-agent/FreshAgentTranscript.tsx
git commit -m "fix: stabilize fresh-agent transcript scroll timing"
```

Expected: one focused behavior commit. Do not commit `/tmp` logs.

### Task 2: Verify The Branch And Prepare PR

**Files:**
- Modify: none expected after Task 1 unless review finds an issue.
- Test: coordinated client/unit suite and repo check.

**Interfaces:**
- Consumes: Task 1's committed branch.
- Produces: pushed branch and PR targeting `main`.

- [ ] **Step 1: Run the affected client area**

Run:

```bash
npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx
```

Expected: both affected Fresh Agent component test files pass.

- [ ] **Step 2: Run the coordinated full check**

Run:

```bash
FRESHELL_TEST_SUMMARY='verify fresh-agent scroll flake stabilization' npm run check
```

Expected: typecheck and coordinated test suite pass. If a new unrelated flake appears, capture the failure summary, rerun the specific failing test once, and do not hide the broad-suite result.

- [ ] **Step 3: Check diff hygiene**

Run:

```bash
git diff --check HEAD
git status --short --branch
```

Expected: no whitespace errors and only expected branch tracking/status output.

- [ ] **Step 4: Push and create PR**

Create the PR body file:

```bash
cat > /tmp/fresh-agent-scroll-flake-pr.md <<'EOF'
## Summary
- move FreshAgentTranscript's auto-scroll-to-bottom DOM write from a passive effect to a layout effect
- keep the FreshAgentView keyboard scroll contract unchanged
- document the root cause: a late passive auto-scroll could reset the transcript to `scrollHeight` after PageUp/PageDown test setup changed scroll position

## Verification
- npm run test:vitest -- run test/unit/client/components/fresh-agent/__intentional_missing_file__.test.tsx (expected exit 1 negative control)
- npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx -t "transcript keyboard scroll"
- 30-run focused transcript keyboard scroll loop
- npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx
- npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx
- FRESHELL_TEST_SUMMARY='verify fresh-agent scroll flake stabilization' npm run check
- git diff --check HEAD
EOF
```

Then push and open the PR. This is allowed because the user explicitly requested PR landing for this branch/change.

Run:

```bash
git push -u origin fix/fresh-agent-scroll-flake
gh pr create --base main --head fix/fresh-agent-scroll-flake \
  --title "Stabilize fresh-agent transcript scroll timing" \
  --body-file /tmp/fresh-agent-scroll-flake-pr.md
```

Expected: PR opens against `main`. The PR body should include the root cause, production fix, repeated focused stress run, affected file run, and `npm run check` result.

- [ ] **Step 5: Merge after checks pass and fast-forward local main**

Run:

```bash
gh pr checks <PR_NUMBER> --watch --interval 30
gh pr merge <PR_NUMBER> --squash --delete-branch \
  --subject "Stabilize fresh-agent transcript scroll timing" --body ""
cd /home/dan/code/freshell
git status --short --branch
git checkout main
git fetch origin main --prune
git merge --ff-only origin/main
```

Expected: PR checks pass, GitHub merges to `main`, the primary checkout is clean and on `main`, and local `main` fast-forwards without a merge commit.
