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

**Goal:** Cloud E2E logs retain at most four additional generic compact-panel geometry-failure screenshots per Cloud task, while every currently named review screenshot continues to be retained.

**Architecture:** Keep screenshot capture and Cloud chunk logging in the existing Playwright spec. Extract path selection into a small asynchronous policy helper. Keep the ten current name markers separate from the additional generic geometry sample. Enforce the four-image task limit with exclusive reservation files inside the shared `test.info().project.outputDir`; Playwright removes that directory before the invocation, so the helper creates it when needed. Worker replacements and retries share this task-local folder, while separate Cloud tasks get separate folders.

**Tech Stack:** TypeScript, Playwright, Vitest, pnpm, Cloud Run Jobs, Cloud Logging.

## Global Constraints

- Preserve local screenshot writes and the existing `compact_panel_screenshot` event and 12,000-character base64 chunk format.
- Preserve all ten current named screenshot markers, including the four specifically named geometry examples and both approved tiny-pane captures.
- The existing retention behavior is a ten-name allowlist, not a strict ten-image total. Keep all ten names enabled and add a separate maximum of four generic geometry-failure screenshots per Cloud task.
- Treat Playwright's project `outputDir` as the shared task-local reservation area. Create it recursively before reservation because Playwright clears it before the test invocation. Keep each reservation until the Cloud task exits; each Cloud task has its own four-image allowance.
- Keep the generic sample separate from the named markers; do not broaden retention to unrelated screenshots.
- Use `.js` extensions for relative TypeScript imports.
- Keep the pinned pnpm version and frozen lockfile; do not change dependencies.
- Run the affected browser spec on the configured Cloud E2E backend. The clean-base full-suite gate remains recorded as failed and is waived by the user; do not relabel it as passing.
- Submit the change through a separate PR to `main`; do not push behavior changes directly to `main`.

---

## File Responsibilities

- Create `test/e2e-browser/helpers/compact-panel-screenshot-retention.ts`: retain the current named paths, reserve up to four task-local generic geometry slots using exclusive file creation, and deduplicate repeated exact paths within a worker.
- Modify `test/e2e-browser/specs/fresh-agent-compact-panels.spec.ts`: use the policy before sending screenshot chunks to Cloud Logging; continue saving every screenshot locally.
- Create `test/unit/tooling/testing/compact-panel-screenshot-retention.test.ts`: exercise concurrent path selection across independent helper instances sharing an output directory, task-local quota reset, named-image preservation, and duplicate handling without launching Playwright.
- This plan is the durable implementation specification for this separate follow-up.

### Task 1: Retain a bounded sample of generic geometry failures

**Files:**
- Create: `test/e2e-browser/helpers/compact-panel-screenshot-retention.ts`
- Modify: `test/e2e-browser/specs/fresh-agent-compact-panels.spec.ts`
- Test: `test/unit/tooling/testing/compact-panel-screenshot-retention.test.ts`

**Interfaces:**
- `CompactPanelScreenshotRetention.decide(path: string, outputDir: string): Promise<ScreenshotRetentionDecision>` consumes the screenshot path and shared project output directory.
- It produces `emit`, `already-emitted`, or `skip` so `saveScreenshot` preserves its existing return behavior while logging only selected images.
- Generic paths contain `compact-geometry-failure-` but do not match a named marker. Each successful generic decision atomically creates one of four exclusive slot files in `outputDir`. Existing named markers bypass this additional sample limit.

- [ ] **Step 1: Write the failing behavioral test**

```typescript
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CompactPanelScreenshotRetention } from '../../../e2e-browser/helpers/compact-panel-screenshot-retention.js'

describe('CompactPanelScreenshotRetention', () => {
  it('caps generic screenshots across worker instances sharing a task output directory', async () => {
    const testTempRoot = join(process.cwd(), '.test-tmp')
    await mkdir(testTempRoot, { recursive: true })
    const createdDirs: string[] = []
    try {
      const outputDir = await mkdtemp(join(testTempRoot, 'compact-panel-retention-task-'))
      createdDirs.push(outputDir)
      const freshTaskOutputDir = await mkdtemp(join(testTempRoot, 'compact-panel-retention-fresh-task-'))
      createdDirs.push(freshTaskOutputDir)

      const decisions = await Promise.all(Array.from({ length: 12 }, (_, index) => (
        new CompactPanelScreenshotRetention().decide(
          `test-results/compact-geometry-failure-layout-${index}.png`,
          outputDir,
        )
      )))
      expect(decisions.filter(decision => decision === 'emit')).toHaveLength(4)
      expect(decisions.filter(decision => decision === 'skip')).toHaveLength(8)

      // A replacement worker shares the same task directory and cannot reset the cap.
      expect(await new CompactPanelScreenshotRetention().decide(
        'test-results/compact-geometry-failure-after-retry.png', outputDir,
      )).toBe('skip')

      const namedRetention = new CompactPanelScreenshotRetention()
      const namedImagePaths = [
        'test-results/compact-freshclaude-desktop.png',
        'test-results/compact-serif-light-split.png',
        'test-results/compact-mono-light-narrow.png',
        'test-results/compact-phone-dark.png',
        'test-results/compact-geometry-failure-painted-freshclaude-metadata-diagnostics-and-request-decisions-share-560x320.png',
        'test-results/compact-geometry-failure-painted-ambiguous-Codex-delivery-keeps-the-original-prompt-and-instruction-at-390x700.png',
        'test-results/compact-geometry-failure-painted-WebFetch-compact-approval-JSON-wraps-fully-at-390px.png',
        'test-results/compact-geometry-failure-composer-270px-empty-compact-pane-keeps-the-complete-composer-visible-without-scrolling.png',
        'test-results/compact-tiny-200px.png',
        'test-results/compact-tiny-120px.png',
      ]
      expect(await Promise.all(namedImagePaths.map(path => namedRetention.decide(path, outputDir))))
        .toEqual(Array.from({ length: 10 }, () => 'emit'))
      expect(await namedRetention.decide(namedImagePaths[9], outputDir)).toBe('already-emitted')
      expect(await namedRetention.decide('test-results/unrelated.png', outputDir)).toBe('skip')

      // A separate Cloud task receives a fresh allowance.
      const freshTaskRetention = new CompactPanelScreenshotRetention()
      expect(await freshTaskRetention.decide(
        'test-results/compact-geometry-failure-new-task.png', freshTaskOutputDir,
      )).toBe('emit')
      expect(await freshTaskRetention.decide(
        'test-results/compact-geometry-failure-new-task.png', freshTaskOutputDir,
      )).toBe('already-emitted')
    } finally {
      await Promise.all(createdDirs.map(dir => rm(dir, { recursive: true, force: true })))
    }
  })
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `pnpm run test:vitest run test/unit/tooling/testing/compact-panel-screenshot-retention.test.ts --config config/vitest/vitest.config.ts`

Expected: FAIL because the current policy does not implement asynchronous shared-directory reservations; the test must fail on the missing method or incorrect slot count, not on setup.

- [ ] **Step 3: Add the minimal policy and connect it to screenshot logging**

Keep the ten current path markers unchanged. For an unlisted path, return `emit` only when it contains `compact-geometry-failure-` and a task-local slot can be reserved. Before reserving, recursively create `outputDir`. Try four stable slot filenames with Node's exclusive `open(..., 'wx')`; treat `EEXIST` as an occupied slot, stop at the first successful creation, and return `skip` after all four exist. Let other filesystem errors surface so reservation failure is diagnosable and cannot bypass the cap. Return `already-emitted` for an exact path already emitted by this helper instance and `skip` for unrelated paths or an exhausted task quota. In `saveScreenshot`, handle `already-emitted` by returning `true` without logging bytes again; handle `skip` by returning `false`; log chunks only for `emit`. Keep `page.screenshot({ path })` before this decision so local artifact behavior remains unchanged.

```typescript
import { mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'

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

const maxGenericGeometryFailureScreenshotsPerTask = 4
export type ScreenshotRetentionDecision = 'emit' | 'already-emitted' | 'skip'

export class CompactPanelScreenshotRetention {
  private readonly emittedPaths = new Set<string>()

  async decide(path: string, outputDir: string): Promise<ScreenshotRetentionDecision> {
    if (this.emittedPaths.has(path)) return 'already-emitted'
    const isReviewImage = reviewImageMarkers.some(marker => path.includes(marker))
    const isGeometryFailure = path.includes('compact-geometry-failure-')
    if (!isReviewImage && !isGeometryFailure) return 'skip'

    if (!isReviewImage) {
      await mkdir(outputDir, { recursive: true })
      let reserved = false
      for (let slot = 0; slot < maxGenericGeometryFailureScreenshotsPerTask; slot += 1) {
        const reservationPath = join(outputDir, `.compact-panel-geometry-failure-slot-${slot}`)
        try {
          const reservation = await open(reservationPath, 'wx')
          await reservation.close()
          reserved = true
          break
        } catch (error) {
          if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') continue
          throw error
        }
      }
      if (!reserved) return 'skip'
    }

    this.emittedPaths.add(path)
    return 'emit'
  }
}
```

In the spec, `saveScreenshot` awaits the policy after the local PNG is written and before base64 chunks are logged:

```typescript
const decision = await screenshotRetention.decide(path, test.info().project.outputDir)
if (decision === 'already-emitted') return true
if (decision === 'skip') return false
```

The previous worker-index implementation and its successful focused runs are historical evidence only. Stage 2 disproved its admission assumption, so all behavior, typecheck, and Cloud checks must run again against this reservation implementation.

- [ ] **Step 4: Run the focused policy test**

Run: `pnpm run test:vitest run test/unit/tooling/testing/compact-panel-screenshot-retention.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS with exactly four generic `emit` results across concurrent helper instances sharing one directory, no additional emit from a replacement instance in that directory, named images still retained after the generic quota is full, and a fresh allowance in another directory.

- [ ] **Step 5: Run client typecheck**

Run: `pnpm run typecheck:client`

Expected: PASS.

- [ ] **Step 6: Run the affected browser spec on Cloud**

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e:cloud test/e2e-browser/specs/fresh-agent-compact-panels.spec.ts`

Expected: Cloud Run builds the corrected branch image and the affected spec passes with the Cloud config. The prior Cloud execution `freshell-e2e-51ca8c6a33da-dirty-carxh0-7q7mb` passed 57/57 tests but used the now-rejected worker-index implementation and does not satisfy this step. The configured backend is Cloud and this spec is not in `CLOUD_SKIP_SPECS`.

- [ ] **Step 7: Review the focused diff and commit the task**

Run: `git diff --check`

Expected: no whitespace errors. Commit the three task files together with a focused message after Cloud verification.

## Requirement-to-Evidence Map

| Requirement | Evidence |
| --- | --- |
| Existing named screenshot paths stay selected | Focused policy test plus Cloud compact-panels spec |
| Generic geometry failures receive at most four retained samples per Cloud task, including retries | Concurrent shared-directory reservation behavior test and Cloud execution |
| Unrelated screenshots remain excluded; local screenshot writes remain | Focused policy test and source review of `saveScreenshot` |
| Separate PR and Kata tracking | PR receipt and close `freshell#w5b4` after merge |
| Clean-base full suite was waived without hiding its failure | `reports/base-gate-waiver.md` and the run-state baseline ledger |
