import type { AuditProfileId } from './profiles.js'

export type AuditScenarioId =
  | 'auth-required-cold-boot'
  | 'terminal-cold-boot'
  | 'fresh-agent-cold-boot'
  | 'sidebar-search-large-corpus'
  | 'terminal-reconnect-backlog'
  | 'offscreen-tab-selection'

export type AuditRequiredMetricId =
  | 'focusedReadyMs'
  | 'maxRafGapMs'
  | 'terminalInputToFirstOutputMs'
  | 'terminalReplayMessageCount'
  | 'terminalReplaySerializedBytes'
  | 'terminalParserAppliedLagMs'
  | 'terminalReplayGapCount'
  | 'terminalFullHydrateFallbackCount'
  | 'terminalSurfaceQuarantineCount'
  | 'terminalStaleGenerationRejectionCount'
  | 'terminalStoppedRetentionCoveredMs'
  | 'terminalStopResumeGapCount'

export type AuditScenarioContext = {
  token?: string
  profileId: AuditProfileId
}

export type AuditScenarioDefinition = {
  id: AuditScenarioId
  description: string
  focusedReadyMilestone: string
  allowedApiRouteIdsBeforeReady: readonly string[]
  allowedWsTypesBeforeReady: readonly string[]
  allowedFreshAgentEventTypesBeforeReady?: readonly string[]
  requiredMetricIds?: readonly AuditRequiredMetricId[]
  buildUrl: (context: AuditScenarioContext) => string
  seedServerHome?: () => Promise<void>
  seedBrowserStorage?: () => Record<string, string>
  driveInteraction?: () => Promise<void>
}

function buildRootUrl(token?: string): string {
  const params = new URLSearchParams({ e2e: '1', perfAudit: '1' })
  if (token) {
    params.set('token', token)
  }
  return `/?${params.toString()}`
}

export const TERMINAL_CATCHUP_REQUIRED_METRIC_IDS = [
  'terminalReplayMessageCount',
  'terminalReplaySerializedBytes',
  'terminalParserAppliedLagMs',
  'terminalReplayGapCount',
  'terminalFullHydrateFallbackCount',
  'terminalSurfaceQuarantineCount',
  'terminalStaleGenerationRejectionCount',
  'terminalStoppedRetentionCoveredMs',
  'terminalStopResumeGapCount',
] as const satisfies readonly AuditRequiredMetricId[]

const TERMINAL_RECONNECT_BACKLOG_REQUIRED_METRIC_IDS = [
  'focusedReadyMs',
  'terminalInputToFirstOutputMs',
  'maxRafGapMs',
  ...TERMINAL_CATCHUP_REQUIRED_METRIC_IDS,
] as const satisfies readonly AuditRequiredMetricId[]

export const AUDIT_SCENARIOS: readonly AuditScenarioDefinition[] = [
  {
    id: 'auth-required-cold-boot',
    description: 'Cold boot without a token until the auth gate is visible.',
    focusedReadyMilestone: 'app.auth_required_visible',
    allowedApiRouteIdsBeforeReady: ['/api/bootstrap'],
    allowedWsTypesBeforeReady: [],
    buildUrl: () => buildRootUrl(),
  },
  {
    id: 'terminal-cold-boot',
    description: 'Cold boot into a focused terminal pane until first output is visible.',
    focusedReadyMilestone: 'terminal.first_output',
    allowedApiRouteIdsBeforeReady: ['/api/bootstrap', '/api/terminals/:terminalId/viewport'],
    allowedWsTypesBeforeReady: [
      'hello',
      'ready',
      'terminal.attach',
      'terminal.attach.ready',
      'terminal.output',
      'terminal.output.gap',

      'terminals.changed',
    ],
    buildUrl: ({ token }) => buildRootUrl(token),
  },
  {
    id: 'fresh-agent-cold-boot',
    description: 'Cold boot into the seeded long-history fresh-agent session until the surface is visible.',
    focusedReadyMilestone: 'agent_chat.surface_visible',
    allowedApiRouteIdsBeforeReady: ['/api/bootstrap', '/api/fresh-agent/threads/:sessionType/:provider/:threadId/turns'],
    allowedWsTypesBeforeReady: ['hello', 'ready', 'freshAgent.event'],
    allowedFreshAgentEventTypesBeforeReady: [
      'freshAgent.session.snapshot',
      'freshAgent.status',
      'freshAgent.stream',
      'freshAgent.assistant',
      'freshAgent.result',
      'freshAgent.error',
      'freshAgent.exit',
    ],
    buildUrl: ({ token }) => buildRootUrl(token),
  },
  {
    id: 'sidebar-search-large-corpus',
    description: 'Open the sidebar, search alpha against the seeded corpus, and wait for visible results.',
    focusedReadyMilestone: 'sidebar.search_results_visible',
    allowedApiRouteIdsBeforeReady: ['/api/bootstrap', '/api/session-directory'],
    allowedWsTypesBeforeReady: ['hello', 'ready', 'sessions.changed'],
    buildUrl: ({ token }) => buildRootUrl(token),
  },
  {
    id: 'terminal-reconnect-backlog',
    description: 'Reconnect to a terminal with a deterministic backlog and wait for visible output recovery.',
    focusedReadyMilestone: 'terminal.first_output',
    allowedApiRouteIdsBeforeReady: ['/api/bootstrap', '/api/terminals/:terminalId/viewport'],
    allowedWsTypesBeforeReady: [
      'hello',
      'ready',
      'terminal.attach',
      'terminal.attach.ready',
      'terminal.output',
      'terminal.output.batch',
      'terminal.output.gap',

      'terminals.changed',
    ],
    requiredMetricIds: TERMINAL_RECONNECT_BACKLOG_REQUIRED_METRIC_IDS,
    buildUrl: ({ token }) => buildRootUrl(token),
  },
  {
    id: 'offscreen-tab-selection',
    description: 'Select a seeded heavy background tab and wait for the newly selected surface to become visible.',
    focusedReadyMilestone: 'tab.selected_surface_visible',
    allowedApiRouteIdsBeforeReady: ['/api/bootstrap'],
    allowedWsTypesBeforeReady: ['hello', 'ready'],
    buildUrl: ({ token }) => buildRootUrl(token),
  },
] as const
