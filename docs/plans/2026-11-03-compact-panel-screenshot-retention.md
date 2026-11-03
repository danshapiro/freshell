# Compact Panel Screenshot Retention Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Complete the separately approved follow-up after PR #896 by retaining a small, bounded sample of generic Fresh Agent compact-panel geometry-failure screenshots in Cloud E2E results.

### Explicit constraints
- Track the work in Kata `freshell#w5b4`.
- Skip the clean-base full-suite gate under the user's explicit waiver, preserving its failed result.
- Keep the existing named screenshot evidence and current screenshot cap.
- Run the affected compact-panel browser spec using the configured Cloud E2E backend before the separate PR.
- Land this change on `main` through a separate PR.

### Accepted tradeoffs and residuals
- No additional user-specified tradeoffs.

**Goal:** Cloud E2E logs retain at most four additional generic compact-panel geometry-failure screenshots per shard, while every currently named review screenshot continues to be retained.

**Architecture:** Keep screenshot capture and Cloud chunk logging in the existing Playwright spec. Extract only path selection into a small policy helper, keeping the ten current name markers separate from the additional geometry-failure sample. Admit at most one generic screenshot from each of worker indices 0–3; Playwright assigns a new unique worker index when it replaces a failed worker, so retries cannot reset this per-shard limit.

**Tech Stack:** TypeScript, Playwright, Vitest, pnpm, Cloud Run Jobs, Cloud Logging.

## Global Constraints

- Preserve local screenshot writes and the existing `compact_panel_screenshot` event and 12,000-character base64 chunk format.
- Preserve all ten current named screenshot markers, including the four specifically named geometry examples and both approved tiny-pane captures.
- The existing retention behavior is a ten-name allowlist, not a strict ten-image total. Keep all ten names enabled and add a separate maximum of four generic geometry-failure screenshots per shard.
- Keep the generic sample separate from the named markers; do not broaden retention to unrelated screenshots.
- Use `.js` extensions for relative TypeScript imports.
- Keep the pinned pnpm version and frozen lockfile; do not change dependencies.
- Run the affected browser spec on the configured Cloud E2E backend. The clean-base full-suite gate remains recorded as failed and is waived by the user; do not relabel it as passing.
- Submit the change through a separate PR to `main`; do not push behavior changes directly to `main`.

---

## File Responsibilities

- Create `test/e2e-browser/helpers/compact-panel-screenshot-retention.ts`: retain the current named paths, admit the bounded generic geometry sample, and deduplicate repeated exact paths.
- Modify `test/e2e-browser/specs/fresh-agent-compact-panels.spec.ts`: use the policy before sending screenshot chunks to Cloud Logging; continue saving every screenshot locally.
- Create `test/unit/tooling/testing/compact-panel-screenshot-retention.test.ts`: exercise path selection, the cap across worker indices, named-image preservation, and duplicate handling without launching Playwright.
- This plan is the durable implementation specification for this separate follow-up.

### Task 1: Retain a bounded sample of generic geometry failures

**Files:**
- Create: `test/e2e-browser/helpers/compact-panel-screenshot-retention.ts`
- Modify: `test/e2e-browser/specs/fresh-agent-compact-panels.spec.ts`
- Test: `test/unit/tooling/testing/compact-panel-screenshot-retention.test.ts`

**Interfaces:**
- Consumes screenshot path and Playwright `workerIndex`.
- Produces one of `emit`, `already-emitted`, or `skip` so `saveScreenshot` preserves its existing return behavior while logging only selected images.
- Generic paths are those containing `compact-geometry-failure-`; worker indices 0–3 may each retain one distinct generic image. Higher worker indices (including retry replacements) are excluded. Existing named markers bypass this additional sample limit.

- [x] **Step 1: Write the failing behavioral test**

```typescript
import { describe, expect, it } from 'vitest'
import { CompactPanelScreenshotRetention } from '../../../e2e-browser/helpers/compact-panel-screenshot-retention.js'

describe('CompactPanelScreenshotRetention', () => {
  it('caps generic geometry-failure screenshots while keeping named review images', () => {
    const retention = new CompactPanelScreenshotRetention()
    const genericPaths = Array.from({ length: 5 }, (_, index) => (
      `test-results/compact-geometry-failure-layout-${index}.png`
    ))

    expect(genericPaths.slice(0, 4).map((path, workerIndex) => (
      retention.decide(path, workerIndex)
    ))).toEqual(['emit', 'emit', 'emit', 'emit'])
    expect(retention.decide(genericPaths[4], 4)).toBe('skip')
    expect(retention.decide(genericPaths[0], 0)).toBe('already-emitted')
    expect(retention.decide('test-results/compact-geometry-failure-layout-extra.png', 0)).toBe('skip')
    expect(retention.decide(
      'test-results/compact-geometry-failure-painted-freshclaude-metadata-diagnostics-and-request-decisions-share-560x320.png',
      10,
    )).toBe('emit')
    expect(retention.decide('test-results/compact-tiny-120px.png', 10)).toBe('emit')
    expect(retention.decide('test-results/unrelated.png', 0)).toBe('skip')
  })
})
```

- [x] **Step 2: Run the test and verify the intended failure**

Run: `pnpm run test:vitest run test/unit/tooling/testing/compact-panel-screenshot-retention.test.ts --config config/vitest/vitest.config.ts`

Expected: FAIL because the policy does not yet expose the worker-aware `decide` behavior. The observed RED was `TypeError: retention.decide is not a function`.

- [x] **Step 3: Add the minimal policy and connect it to screenshot logging**

Keep the ten current path markers unchanged. For an unlisted path, return `emit` only when it is a geometry-failure path and its unique worker index is in `0..3`, with at most one distinct generic image per worker process. Return `already-emitted` for the same path and `skip` for unrelated paths or later worker indices. In `saveScreenshot`, handle `already-emitted` by returning `true` without logging bytes again; handle `skip` by returning `false`; log chunks only for `emit`. Keep `page.screenshot({ path })` before this decision so local artifact behavior remains unchanged.

```typescript
const reviewImageMarkers = [
  'compact-freshclaude-desktop',
  'compact-serif-light-split',
  'compact-mono-light-narrow',
  'compact-phone-dark',
  'compact-geometry-failure-painted-freshclaude-metadata-diagnostics-and-request-decisions-share-560x320',
  'compact-geometry-failure-painted-ambiguous-Codex-delivery-keeps-the-original-prompt-and-instruction-at-390x700',
  'compact-geometry-failure-painted-WebFetch-compact-approval-JSON-wraps-fully-at-390px',
  'compact-geometry-failure-composer-270px-empty-compact-pane-keeps-the-complete-composer-visible-without-scrolling',
  'compact-tiny-200px',
  'compact-tiny-120px',
]

const maxAdmittedGeometryFailureWorkerIndexExclusive = 4
export type ScreenshotRetentionDecision = 'emit' | 'already-emitted' | 'skip'

export class CompactPanelScreenshotRetention {
  private readonly emittedPaths = new Set<string>()
  private readonly geometryFailureWorkerIndices = new Set<number>()

  decide(path: string, workerIndex: number): ScreenshotRetentionDecision {
    if (this.emittedPaths.has(path)) return 'already-emitted'
    const isReviewImage = reviewImageMarkers.some(marker => path.includes(marker))
    const isGeometryFailure = path.includes('compact-geometry-failure-')
    if (!isReviewImage && (
      !isGeometryFailure
      || workerIndex < 0
      || workerIndex >= maxAdmittedGeometryFailureWorkerIndexExclusive
      || this.geometryFailureWorkerIndices.has(workerIndex)
    )) return 'skip'

    this.emittedPaths.add(path)
    if (isGeometryFailure && !isReviewImage) this.geometryFailureWorkerIndices.add(workerIndex)
    return 'emit'
  }
}
```

In the spec, `saveScreenshot` evaluates the policy after the local PNG is written and before base64 chunks are logged:

```typescript
const decision = screenshotRetention.decide(path, test.info().workerIndex)
if (decision === 'already-emitted') return true
if (decision === 'skip') return false
```

- [x] **Step 4: Run the focused policy test**

Run: `pnpm run test:vitest run test/unit/tooling/testing/compact-panel-screenshot-retention.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS. Current evidence: one test passed after the policy was added.

- [x] **Step 5: Run client typecheck**

Run: `pnpm run typecheck:client`

Expected: PASS. Current evidence: typecheck passed after the current implementation.

- [x] **Step 6: Run the affected browser spec on Cloud**

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e:cloud test/e2e-browser/specs/fresh-agent-compact-panels.spec.ts`

Expected: Cloud Run builds the branch image and the affected spec passes with the Cloud config. The run passed 57/57 tests on one task. Execution: `freshell-e2e-51ca8c6a33da-dirty-carxh0-7q7mb`; build: `074819de-4f9e-4471-b7b0-894442ab2d02`. The configured backend is Cloud and this spec is not in `CLOUD_SKIP_SPECS`.

- [ ] **Step 7: Review the focused diff and commit the task**

Run: `git diff --check`

Expected: no whitespace errors. Commit the three task files together with a focused message after Cloud verification.

## Requirement-to-Evidence Map

| Requirement | Evidence |
| --- | --- |
| Existing named screenshot paths stay selected | Focused policy test plus Cloud compact-panels spec |
| Generic geometry failures receive a bounded sample, including retries | Focused worker-index policy test and Cloud execution |
| Unrelated screenshots remain excluded; local screenshot writes remain | Focused policy test and source review of `saveScreenshot` |
| Separate PR and Kata tracking | PR receipt and close `freshell#w5b4` after merge |
| Clean-base full suite was waived without hiding its failure | `reports/base-gate-waiver.md` and the run-state baseline ledger |
