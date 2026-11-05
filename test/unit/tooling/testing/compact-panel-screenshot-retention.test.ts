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
