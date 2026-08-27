# Mobile Permission Banner E2E Assertion Fix Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result

Fix the pre-existing-on-`main` failure of the e2e test `permission banner
buttons are visible and functional on mobile` (now located at
`test/e2e-browser/specs/mobile-viewport.spec.ts:195`, originally reported as
`test/e2e-browser/specs/fresh-agent-mobile.spec.ts:195`). The test locates the
permission banner via `getByRole('alert', { name: /permission request for
bash/i })` and then asserts `await expect(banner).toContainText('Permission
requested: Bash')`. The gate run shows a text mismatch. Determine whether the
banner copy changed intentionally (then update the spec) or the mobile banner
is rendering the wrong/missing text (then fix the component).

### Explicit constraints

- Determine intent from evidence: if the current banner copy is the designed
  behavior, update the spec; if the component regressed, fix the component.
- Do not modify the product source if the current design is intentional —
  unit tests pin the current `FreshAgentApprovalCard` design.
- Preserve the remaining assertions of the failing test (Allow/Deny button
  visibility and the `freshAgent.approval.respond` WS message round-trip).
- All repo rules in `AGENTS.md` apply (Red-Green-Refactor TDD; repo-owned
  test entry points; coordinated full suite).
- Darkforge factory contract: the full QA gate is
  `darkforge qa --repo '/home/dan/code/freshell' --id '15gk'`, and a nonzero
  exit is acceptable only when every parsed failure identity is in the
  baseline ledger (three pre-existing `test/unit/vite-config.test.ts >
  getNetworkHost` identities).

### Accepted tradeoffs and residuals

- The assertion changed is a copy-string replacement in an existing e2e
  spec; no new production behavior is introduced, so no new unit tests are
  required. The pre-existing failing assertion serves as the red state.
- The work item's cited path `test/e2e-browser/specs/fresh-agent-mobile.spec.ts`
  no longer contains this test; the test was relocated to
  `test/e2e-browser/specs/mobile-viewport.spec.ts` (the failure evidence in
  `test/e2e-browser/gate01-baseline.json` matches the relocated assertion).
  This is a path drift in the report, not a scope change.

**Goal:** Make the mobile-viewport e2e spec's permission-banner test assert
against the actual, unit-test-pinned `FreshAgentApprovalCard` design so the
test passes and its verification value is retained.

**Architecture:** The fresh-agent permission UI renders
`src/components/fresh-agent/FreshAgentApprovalCard.tsx`, whose header carries
an `approval` kicker chip plus the tool name `Bash` and whose body previews the
command — it has never rendered the literal copy `Permission requested: Bash`
(that copy belonged to the deleted legacy
`src/components/claude-chat/PermissionBanner.tsx`). The desktop sibling
(`test/e2e-browser/specs/fresh-agent.spec.ts:1226-1228`) already asserts on
the command preview text, and the unit tests
(`test/unit/client/components/fresh-agent/FreshAgentApprovalCard.test.tsx`)
pin the current aria-label and button labels. The fix therefore updates the
mobile spec's stale text assertion to assert on the command preview, matching
the desktop pattern.

**Tech Stack:** Playwright e2e specs (`test/e2e-browser/`, chromium project),
React/TSX client components, Vitest unit tests.

## Global Constraints

- The change is test-only: do **not** modify
  `src/components/fresh-agent/FreshAgentApprovalCard.tsx` or any other
  production source. The component's current design is pinned by unit tests
  (`getByRole('alert', { name: 'Permission request for Bash' })`, buttons
  `Allow tool use` / `Always allow Bash this session` / `Deny tool use`).
- Do not modify the work tracker / kata source.
- E2E runs go through repo-owned entry points:
  `npm run test:e2e:chromium -- …` (which wraps
  `playwright test --config test/e2e-browser/playwright.config.ts
  --project=chromium`).
- The full QA gate is `darkforge qa --repo '/home/dan/code/freshell' --id
  '15gk'` run against a clean, fully committed worktree. Baseline ledger
  failure identities (pre-existing, not ours to repair):
  - `test/unit/vite-config.test.ts > getNetworkHost > ignores HOST env when configured`
  - `test/unit/vite-config.test.ts > getNetworkHost > returns 127.0.0.1 when config file does not exist`
  - `test/unit/vite-config.test.ts > getNetworkHost > returns 127.0.0.1 when config has no network settings`

---

### Task 1: Update the stale permission-banner text assertion in the mobile e2e spec

**Files:**
- Modify: `test/e2e-browser/specs/mobile-viewport.spec.ts:250`
- Test: `test/e2e-browser/specs/mobile-viewport.spec.ts` (the changed spec is
  itself the behavioral test)

**Interfaces:**
- Consumes: `FreshAgentApprovalCard` renders `role="alert"`,
  `aria-label="Permission request for ${toolName}"`, an `approval` kicker
  chip, the tool name, a command preview `<pre>` containing the approval's
  `input.command` (here `echo mobile-permission-test`), and the three
  decision buttons. Pinned by
  `test/unit/client/components/fresh-agent/FreshAgentApprovalCard.test.tsx`.
- Produces: a green `permission banner buttons are visible and functional on
  mobile` e2e test that still verifies banner visibility, Allow/Deny button
  visibility, and the `freshAgent.approval.respond` WS payload.

- [ ] **Step 1: Confirm the failing state (red)**

The failing assertion already exists in the tree (this is a stale-assertion
fix; the pre-existing failure is the red state). Confirm it is currently red:

Run: `npm run test:e2e:chromium -- test/e2e-browser/specs/mobile-viewport.spec.ts --grep "permission banner buttons are visible and functional on mobile"`

Expected: FAIL at `mobile-viewport.spec.ts:250` with
`Expected substring: "Permission requested: Bash"` and
`Received string: "approvalBashecho mobile-permission-testAllowAlways allow Bash this sessionDeny"`
(matching the recorded evidence in `test/e2e-browser/gate01-baseline.json`).

- [ ] **Step 2: Verify the intended failure reason**

Confirm the failure is the assertion's stale copy expectation, not a
visibility/locator breakage: the call log must show the locator resolving to
the `fresh-agent-approval-card` element with
`aria-label="Permission request for Bash"`. If the locator instead times out
with zero resolutions, stop and re-plan, because that would indicate the
banner is not rendering at all (a component regression, the opposite branch
of the work item's either/or).

- [ ] **Step 3: Update the assertion**

In `test/e2e-browser/specs/mobile-viewport.spec.ts`, replace:

```ts
    await expect(banner).toContainText('Permission requested: Bash')
```

with:

```ts
    await expect(banner).toContainText('echo mobile-permission-test')
```

Rationale: the card renders the tool name and the command preview, keyed off
the approval input supplied by the test's own routed snapshot
(`input: { command: 'echo mobile-permission-test' }`, spec line 216). This
mirrors the desktop sibling assertion in
`test/e2e-browser/specs/fresh-agent.spec.ts:1228`
(`await expect(permissionBanner).toContainText('echo hello-from-fresh-agent')`)
and verifies real banner content rather than legacy copy that shipped with
the now-deleted `PermissionBanner` component.

- [ ] **Step 4: Run the focused test**

Run: `npm run test:e2e:chromium -- test/e2e-browser/specs/mobile-viewport.spec.ts --grep "permission banner buttons are visible and functional on mobile"`

Expected: PASS

- [ ] **Step 5: Refactor while green**

No refactor needed: the change is a single-assertion copy fix inside an
existing test. The surrounding test flow (locator, button checks,
`freshAgent.approval.respond` WS round-trip) is unchanged.

- [ ] **Step 6: Run impacted-test verification**

The change touches one assertion in one e2e spec. The impacted set is the
rest of that spec file plus the desktop sibling spec that exercises the same
`FreshAgentApprovalCard` render path, plus the unit test file that pins the
component design.

Run the full changed spec file plus the desktop sibling test
`freshclaude banners render through the fresh-agent pane surface and answer
over WS` (`test/e2e-browser/specs/fresh-agent.spec.ts:1138`):

`npm run test:e2e:chromium -- test/e2e-browser/specs/mobile-viewport.spec.ts`

Expected: PASS (all 7 tests in the spec file).

Then the desktop sibling (same `FreshAgentApprovalCard` render path):

`npm run test:e2e:chromium -- test/e2e-browser/specs/fresh-agent.spec.ts --grep "freshclaude banners render through the fresh-agent pane surface and answer over WS"`

Expected: PASS.

Then:
`npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentApprovalCard.test.tsx`

Expected: PASS (unit pins for the unchanged component design stay green).

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/mobile-viewport.spec.ts
git commit -m "test(e2e): fix stale permission banner copy assertion on mobile viewport"
```

## Final Gate

After Task 1 completes, run the full QA gate on a clean, fully committed
worktree and record the result in the progress ledger:

Run: `darkforge qa --repo '/home/dan/code/freshell' --id '15gk'`

Expected: exit 0, or exit nonzero only when every parsed failure identity is
in the Baseline ledger (`getNetworkHost` x3). Any new or unparseable failure
fails closed.

The source-supplied verification command `npm run check` is a subset of the
QA gate (the gate's first step is exactly `npm run check`), so the `darkforge
qa` run also satisfies that oracle.
