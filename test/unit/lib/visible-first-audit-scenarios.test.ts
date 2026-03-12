// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { AUDIT_SCENARIOS } from '@test/e2e-browser/perf/scenarios'

describe('visible-first audit scenarios', () => {
  it('defines the six accepted scenarios in stable order', () => {
    expect(AUDIT_SCENARIOS.map((scenario) => scenario.id)).toEqual([
      'auth-required-cold-boot',
      'terminal-cold-boot',
      'agent-chat-cold-boot',
      'sidebar-search-large-corpus',
      'terminal-reconnect-backlog',
      'offscreen-tab-selection',
    ])
  })

  it('uses the hard-cut visible-first route families before ready', () => {
    const scenarioMap = new Map(AUDIT_SCENARIOS.map((scenario) => [scenario.id, scenario]))

    expect(scenarioMap.get('auth-required-cold-boot')?.allowedApiRouteIdsBeforeReady).toEqual(['/api/bootstrap'])
    expect(scenarioMap.get('terminal-cold-boot')?.allowedApiRouteIdsBeforeReady).toEqual([
      '/api/bootstrap',
      '/api/terminals/:terminalId/viewport',
    ])
    expect(scenarioMap.get('agent-chat-cold-boot')?.allowedApiRouteIdsBeforeReady).toEqual([
      '/api/bootstrap',
      '/api/agent-sessions/:sessionId/timeline',
    ])
    expect(scenarioMap.get('sidebar-search-large-corpus')?.allowedApiRouteIdsBeforeReady).toEqual([
      '/api/bootstrap',
      '/api/session-directory',
    ])
    expect(scenarioMap.get('terminal-reconnect-backlog')?.allowedApiRouteIdsBeforeReady).toEqual([
      '/api/bootstrap',
      '/api/terminals/:terminalId/viewport',
    ])
    expect(scenarioMap.get('offscreen-tab-selection')?.allowedApiRouteIdsBeforeReady).toEqual(['/api/bootstrap'])
  })

  it('rejects legacy websocket and API allowances before ready', () => {
    const forbiddenRoutes = new Set(['/api/settings', '/api/sessions', '/api/sessions/search'])
    const forbiddenWsTypes = new Set([
      'sdk.history',
      'sessions.updated',
      'sessions.patch',
      'terminal.list',
      'terminal.meta.list',
      'terminal.meta.list.response',
    ])

    for (const scenario of AUDIT_SCENARIOS) {
      expect(scenario.allowedApiRouteIdsBeforeReady.some((route) => forbiddenRoutes.has(route))).toBe(false)
      expect(scenario.allowedWsTypesBeforeReady.some((type) => forbiddenWsTypes.has(type))).toBe(false)
    }
  })
})
