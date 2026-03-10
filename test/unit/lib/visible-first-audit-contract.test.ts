// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  AUDIT_PROFILE_IDS,
  AUDIT_SCENARIO_IDS,
  VisibleFirstAuditSchema,
} from '@test/e2e-browser/perf/audit-contract'

function buildAuditFixture() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-03-10T00:00:00.000Z',
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
    profiles: AUDIT_PROFILE_IDS.map((id) => ({ id })),
    scenarios: AUDIT_SCENARIO_IDS.map((scenarioId) => ({
      id: scenarioId,
      description: `${scenarioId} description`,
      focusedReadyMilestone: `${scenarioId}.ready`,
      samples: AUDIT_PROFILE_IDS.map((profileId) => ({
        profileId,
        status: 'ok',
        startedAt: '2026-03-10T00:00:00.000Z',
        finishedAt: '2026-03-10T00:00:01.000Z',
        durationMs: 1000,
        browser: {},
        transport: {},
        server: {},
        derived: {},
        errors: [],
      })),
      summaryByProfile: Object.fromEntries(
        AUDIT_PROFILE_IDS.map((profileId) => [profileId, { focusedReadyMs: 1000 }]),
      ),
    })),
  }
}

describe('VisibleFirstAuditSchema', () => {
  it('accepts a six-scenario artifact with exactly two samples per scenario', () => {
    const artifact = buildAuditFixture()
    expect(AUDIT_PROFILE_IDS).toEqual(['desktop_local', 'mobile_restricted'])
    expect(AUDIT_SCENARIO_IDS).toHaveLength(6)
    expect(VisibleFirstAuditSchema.parse(artifact).scenarios).toHaveLength(6)
  })
})
