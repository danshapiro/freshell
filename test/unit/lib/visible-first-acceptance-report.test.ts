// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  evaluateVisibleFirstAcceptanceReport,
  type VisibleFirstAcceptanceReport,
} from '@test/helpers/visible-first/acceptance-contract'

describe('evaluateVisibleFirstAcceptanceReport', () => {
  it('merges static scan, websocket ownership, and stale audit allowlist findings into one JSON result', () => {
    const report = evaluateVisibleFirstAcceptanceReport({
      productionFiles: [
        {
          file: 'src/lib/ws-client.ts',
          content: "const caps = ['sessionsPatchV1', 'sessions.updated', '/api/sessions/search']",
        },
        {
          file: 'src/App.tsx',
          content: 'await ws.connect()',
        },
        {
          file: 'src/components/OverviewView.tsx',
          content: 'ws.connect()',
        },
      ],
      auditScenarios: [
        {
          scenarioId: 'agent-chat-cold-boot',
          allowedApiRouteIdsBeforeReady: ['/api/bootstrap', '/api/sessions'],
          allowedWsTypesBeforeReady: ['hello', 'ready', 'sdk.history'],
        },
      ],
    })

    expect(report).toEqual<VisibleFirstAcceptanceReport>({
      ok: false,
      staticViolations: [
        { file: 'src/lib/ws-client.ts', match: 'sessions.updated' },
        { file: 'src/lib/ws-client.ts', match: 'sessionsPatchV1' },
        { file: 'src/lib/ws-client.ts', match: '/api/sessions/search' },
      ],
      wsOwnershipViolations: ['src/components/OverviewView.tsx'],
      auditScenarioViolations: [
        {
          scenarioId: 'agent-chat-cold-boot',
          field: 'allowedApiRouteIdsBeforeReady',
          offenders: ['/api/sessions'],
        },
        {
          scenarioId: 'agent-chat-cold-boot',
          field: 'allowedWsTypesBeforeReady',
          offenders: ['sdk.history'],
        },
      ],
    })
  })

  it('returns ok when every contradiction category is empty', () => {
    expect(
      evaluateVisibleFirstAcceptanceReport({
        productionFiles: [{ file: 'src/App.tsx', content: 'await ws.connect()' }],
        auditScenarios: [
          {
            scenarioId: 'terminal-cold-boot',
            allowedApiRouteIdsBeforeReady: ['/api/bootstrap', '/api/terminals/:terminalId/viewport'],
            allowedWsTypesBeforeReady: ['hello', 'ready', 'terminal.attach', 'terminal.output'],
          },
        ],
      }),
    ).toEqual<VisibleFirstAcceptanceReport>({
      ok: true,
      staticViolations: [],
      wsOwnershipViolations: [],
      auditScenarioViolations: [],
    })
  })
})
