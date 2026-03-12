// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { compareVisibleFirstAudits } from '@test/e2e-browser/perf/compare-visible-first-audits'

function buildAudit(focusedReadyMs: number) {
  return {
    schemaVersion: 1 as const,
    generatedAt: '2026-03-10T00:00:00.000Z',
    git: { commit: 'abcdef1', branch: 'branch', dirty: false },
    build: { nodeVersion: process.version, browserVersion: 'Chromium', command: 'cmd' },
    profiles: [{ id: 'desktop_local' as const }],
    scenarios: [
      {
        id: 'terminal-cold-boot' as const,
        description: 'Terminal cold boot',
        focusedReadyMilestone: 'terminal.first_output',
        samples: [
          {
            profileId: 'desktop_local' as const,
            status: 'ok' as const,
            startedAt: '2026-03-10T00:00:00.000Z',
            finishedAt: '2026-03-10T00:00:01.000Z',
            durationMs: 1000,
            browser: {},
            transport: {},
            server: {},
            derived: { focusedReadyMs },
            errors: [],
          },
        ],
        summaryByProfile: {
          desktop_local: { focusedReadyMs },
        },
      },
    ],
  }
}

describe('visible-first audit compare', () => {
  it('compares two artifacts by scenario and profile', () => {
    const diff = compareVisibleFirstAudits(buildAudit(100), buildAudit(120))
    expect(diff.scenarios[0]?.profiles[0]?.profileId).toBe('desktop_local')
    expect(diff.scenarios[0]?.profiles[0]?.derived.focusedReadyMs.delta).toBe(20)
  })
})
