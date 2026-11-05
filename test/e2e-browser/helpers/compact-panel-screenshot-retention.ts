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
