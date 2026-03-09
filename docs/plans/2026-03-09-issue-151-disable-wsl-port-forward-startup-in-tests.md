# Issue 151 Disable WSL Port-Forward Startup in Tests Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Prevent WSL2 test runs from triggering Windows UAC prompts by giving server startup an explicit opt-out for automatic port-forward repair and ensuring test harnesses use it by default.

**Architecture:** Separate the startup decision from the privileged port-forward implementation. Server startup should ask a small helper whether automatic WSL port-forward setup is allowed for the current bind host and environment, while test harnesses continue defaulting the disable flag on child processes. This fixes the startup-coupling bug instead of relying on one suite's current launch shape.

**Tech Stack:** Node.js, TypeScript, Vitest

---

### Task 1: Capture the missing startup opt-out in tests

**Files:**
- Add: `test/unit/server/wsl-port-forward-startup.test.ts`
- Add: `test/integration/server/logger.separation.harness.test.ts`
- Modify: `test/integration/server/wsl-port-forward.test.ts`

**Step 1: Write the failing tests**

Add unit coverage for the startup gating helper so automatic WSL port forwarding is allowed only when the server is bound to `0.0.0.0` and not explicitly disabled by env. Extend the integration assertion on `server/index.ts` so it requires the startup helper rather than an unconditional direct call. Add harness coverage proving child server processes default `FRESHELL_DISABLE_WSL_PORT_FORWARD=1` unless the caller overrides it.

**Step 2: Run targeted tests to verify the missing startup gate fails**

Run: `npx vitest run --config vitest.server.config.ts test/unit/server/wsl-port-forward-startup.test.ts test/integration/server/wsl-port-forward.test.ts test/integration/server/logger.separation.harness.test.ts`

Expected: FAIL because the startup helper does not exist yet and `server/index.ts` still calls `setupWslPortForwarding()` directly when bound to `0.0.0.0`.

### Task 2: Add the startup gate and wire it into server boot

**Files:**
- Add: `server/wsl-port-forward-startup.ts`
- Modify: `server/index.ts`

**Step 1: Implement the minimal fix**

Create a dedicated helper that interprets `FRESHELL_DISABLE_WSL_PORT_FORWARD` as a boolean startup opt-out and only allows automatic setup for `0.0.0.0`. Update `server/index.ts` to use that helper before calling `setupWslPortForwarding()`, and emit structured logs when startup skips auto-repair due to the explicit disable flag.

**Step 2: Run targeted tests**

Run: `npx vitest run --config vitest.server.config.ts test/unit/server/wsl-port-forward-startup.test.ts test/integration/server/wsl-port-forward.test.ts test/integration/server/logger.separation.harness.test.ts`

Expected: PASS

### Task 3: Refactor and verify broader server coverage

**Files:**
- Modify only files already touched for this issue

**Step 1: Keep the startup policy centralized**

Refactor only as needed so the startup env parsing lives in the new helper instead of being duplicated across server startup and test code.

**Step 2: Run broader verification**

Run: `npx vitest run --config vitest.server.config.ts test/unit/server/wsl-port-forward-startup.test.ts test/unit/server/wsl-port-forward.test.ts test/integration/server/wsl-port-forward.test.ts test/integration/server/logger.separation.harness.test.ts test/integration/server/logger.separation.test.ts`

Expected: PASS

Run: `CI=true npm test`

Expected: PASS

### Task 4: Commit the issue fix

**Files:**
- Stage the plan, server, and test changes from this issue only

**Step 1: Commit**

Run:

```bash
git add docs/plans/2026-03-09-issue-151-disable-wsl-port-forward-startup-in-tests.md \
  docs/plans/2026-03-09-issue-151-disable-wsl-port-forward-startup-in-tests-test-plan.md \
  server/wsl-port-forward-startup.ts \
  server/index.ts \
  test/unit/server/wsl-port-forward-startup.test.ts \
  test/integration/server/wsl-port-forward.test.ts \
  test/integration/server/logger.separation.harness.test.ts
git commit -m "fix(server): disable WSL port forwarding during tests"
```

Expected: commit created with only the issue `#151` changes.
