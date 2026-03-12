// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  assertVisibleFirstAuditTrusted,
  type VisibleFirstAuditArtifact,
} from '@test/e2e-browser/perf/audit-contract'

function buildArtifact(status: 'ok' | 'timeout' | 'error'): VisibleFirstAuditArtifact {
  return {
    schemaVersion: 1,
    generatedAt: '2026-03-10T08:00:00.000Z',
    git: {
      commit: 'abcdef1',
      branch: 'codex/visible-first-perf-audit',
      dirty: false,
    },
    build: {
      nodeVersion: process.version,
      browserVersion: 'Chromium 136.0.0.0',
      command: 'npm run perf:audit:visible-first',
    },
    profiles: [
      { id: 'desktop_local' },
      { id: 'mobile_restricted' },
    ],
    scenarios: [
      {
        id: 'auth-required-cold-boot',
        description: 'auth',
        focusedReadyMilestone: 'app.auth_required_visible',
        samples: [
          {
            profileId: 'desktop_local',
            status,
            startedAt: '2026-03-10T08:00:00.000Z',
            finishedAt: '2026-03-10T08:00:01.000Z',
            durationMs: 1000,
            browser: {},
            transport: {},
            server: {},
            derived: {},
            errors: status === 'ok' ? [] : ['sample failed'],
          },
          {
            profileId: 'mobile_restricted',
            status: 'ok',
            startedAt: '2026-03-10T08:00:00.000Z',
            finishedAt: '2026-03-10T08:00:01.000Z',
            durationMs: 1000,
            browser: {},
            transport: {},
            server: {},
            derived: {},
            errors: [],
          },
        ],
        summaryByProfile: {
          desktop_local: {},
          mobile_restricted: {},
        },
      },
    ],
  }
}

describe('assertVisibleFirstAuditTrusted', () => {
  it('accepts artifacts where every sample succeeded', () => {
    expect(() => assertVisibleFirstAuditTrusted(buildArtifact('ok'))).not.toThrow()
  })

  it('rejects artifacts that contain timeout or error samples', () => {
    expect(() => assertVisibleFirstAuditTrusted(buildArtifact('timeout'))).toThrow(/untrustworthy/i)
    expect(() => assertVisibleFirstAuditTrusted(buildArtifact('error'))).toThrow(/untrustworthy/i)
  })
})
