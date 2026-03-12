// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { runVisibleFirstAudit } from '@test/e2e-browser/perf/run-visible-first-audit'
import { VisibleFirstAuditSchema } from '@test/e2e-browser/perf/audit-contract'

function buildSample(profileId: 'desktop_local' | 'mobile_restricted') {
  return {
    profileId,
    status: 'ok' as const,
    startedAt: '2026-03-10T08:00:00.000Z',
    finishedAt: '2026-03-10T08:00:01.000Z',
    durationMs: 1_000,
    browser: {
      milestones: {
        'app.auth_required_visible': 12,
        'terminal.first_output': 25,
        'agent_chat.surface_visible': 30,
        'sidebar.search_results_visible': 35,
        'tab.selected_surface_visible': 40,
      },
      metadata: {},
      perfEvents: [],
      terminalLatencySamplesMs: [45],
    },
    transport: {
      http: { requests: [] },
      ws: { frames: [] },
      summary: { http: { byRoute: {} }, ws: { byType: {} } },
    },
    server: {
      httpRequests: [],
      perfEvents: [],
      perfSystemSamples: [],
      parserDiagnostics: [],
    },
    derived: {
      focusedReadyMs: profileId === 'desktop_local' ? 25 : 40,
      httpRequestsBeforeReady: 0,
      httpBytesBeforeReady: 0,
      wsFramesBeforeReady: 0,
      wsBytesBeforeReady: 0,
      offscreenHttpRequestsBeforeReady: 0,
      offscreenHttpBytesBeforeReady: 0,
      offscreenWsFramesBeforeReady: 0,
      offscreenWsBytesBeforeReady: 0,
    },
    errors: [],
  }
}

describe('runVisibleFirstAudit', () => {
  it('runs the accepted scenario/profile matrix in stable order and returns a schema-valid object', async () => {
    const artifact = await runVisibleFirstAudit({
      deps: {
        runSample: async ({ profileId }) => buildSample(profileId),
        getGitInfo: async () => ({
          commit: 'abc123',
          branch: 'codex/visible-first-perf-audit',
          dirty: false,
        }),
        getBuildInfo: async () => ({
          nodeVersion: process.version,
          browserVersion: 'Chromium 136.0.0.0',
          command: 'npm run perf:audit:visible-first',
        }),
        generatedAt: () => '2026-03-10T08:00:00.000Z',
      },
    })

    expect(artifact.scenarios.map((scenario) => scenario.id)).toEqual([
      'auth-required-cold-boot',
      'terminal-cold-boot',
      'agent-chat-cold-boot',
      'sidebar-search-large-corpus',
      'terminal-reconnect-backlog',
      'offscreen-tab-selection',
    ])
    expect(artifact.scenarios.every((scenario) => scenario.samples.length === 2)).toBe(true)
    expect(VisibleFirstAuditSchema.parse(artifact).scenarios).toHaveLength(6)
  })
})
