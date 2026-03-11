type ProtocolMessage = Record<string, unknown>

export const FORBIDDEN_VISIBLE_FIRST_WS_TYPES = [
  'sessions.updated',
  'sessions.page',
  'sessions.patch',
  'sessions.fetch',
  'sdk.history',
  'terminal.list',
  'terminal.list.response',
  'terminal.list.updated',
  'terminal.meta.list',
  'terminal.meta.list.response',
] as const

export const FORBIDDEN_VISIBLE_FIRST_CAPABILITIES = [
  'sessionsPatchV1',
  'sessionsPaginationV1',
] as const

export const FORBIDDEN_VISIBLE_FIRST_ROUTE_STRINGS = [
  '/api/sessions/search',
  '/api/sessions/query',
] as const

export const FORBIDDEN_VISIBLE_FIRST_AUDIT_API_ROUTE_IDS = [
  '/api/settings',
  '/api/sessions',
  '/api/sessions/:sessionId',
  '/api/sessions/search',
  '/api/sessions/query',
] as const

export const VISIBLE_FIRST_WS_CONNECT_OWNER = 'src/App.tsx' as const

const FORBIDDEN_VISIBLE_FIRST_STATIC_MATCHES = [
  ...FORBIDDEN_VISIBLE_FIRST_WS_TYPES,
  ...FORBIDDEN_VISIBLE_FIRST_CAPABILITIES,
  ...FORBIDDEN_VISIBLE_FIRST_ROUTE_STRINGS,
  'SearchAddon',
] as const

export type VisibleFirstAcceptanceReport = {
  ok: boolean
  staticViolations: Array<{ file: string; match: string }>
  wsOwnershipViolations: string[]
  auditScenarioViolations: Array<{
    scenarioId: string
    field: 'allowedApiRouteIdsBeforeReady' | 'allowedWsTypesBeforeReady'
    offenders: string[]
  }>
}

export type VisibleFirstAcceptanceSourceFile = {
  file: string
  content: string
}

export type VisibleFirstAcceptanceTranscript = {
  inboundMessages: readonly ProtocolMessage[]
  outboundMessages: readonly ProtocolMessage[]
}

export type VisibleFirstAcceptanceAuditScenario = {
  scenarioId: string
  allowedApiRouteIdsBeforeReady: readonly string[]
  allowedWsTypesBeforeReady: readonly string[]
}

function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values))
}

function getHelloCapabilities(message: ProtocolMessage): Record<string, unknown> | null {
  if (message.type !== 'hello') {
    return null
  }

  const capabilities = message.capabilities
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    return null
  }

  return capabilities as Record<string, unknown>
}

export function inspectVisibleFirstTranscript(
  transcript: VisibleFirstAcceptanceTranscript,
): { forbiddenTypes: string[]; forbiddenCapabilities: string[] } {
  const forbiddenTypes = uniqueStrings(
    transcript.inboundMessages
      .map((message) => message.type)
      .filter(
        (type): type is string =>
          typeof type === 'string' && FORBIDDEN_VISIBLE_FIRST_WS_TYPES.includes(type as never),
      ),
  )

  const forbiddenCapabilities = uniqueStrings(
    transcript.outboundMessages.flatMap((message) => {
      const capabilities = getHelloCapabilities(message)
      if (!capabilities) {
        return []
      }

      return FORBIDDEN_VISIBLE_FIRST_CAPABILITIES.filter(
        (capability) => capabilities[capability] === true,
      )
    }),
  )

  return {
    forbiddenTypes,
    forbiddenCapabilities,
  }
}

export function collectVisibleFirstStaticViolations(
  files: readonly VisibleFirstAcceptanceSourceFile[],
): Array<{ file: string; match: string }> {
  return files.flatMap(({ file, content }) =>
    FORBIDDEN_VISIBLE_FIRST_STATIC_MATCHES.flatMap((match) =>
      content.includes(match) ? [{ file, match }] : [],
    ),
  )
}

export function collectVisibleFirstWsOwnershipViolations(
  files: readonly VisibleFirstAcceptanceSourceFile[],
  ownerFile = VISIBLE_FIRST_WS_CONNECT_OWNER,
): string[] {
  return uniqueStrings(
    files
      .filter(({ file, content }) => file !== ownerFile && content.includes('ws.connect('))
      .map(({ file }) => file),
  )
}

export function collectVisibleFirstAuditScenarioViolations(
  scenarios: readonly VisibleFirstAcceptanceAuditScenario[],
): VisibleFirstAcceptanceReport['auditScenarioViolations'] {
  return scenarios.flatMap((scenario) => {
    const routeOffenders = scenario.allowedApiRouteIdsBeforeReady.filter((routeId) =>
      FORBIDDEN_VISIBLE_FIRST_AUDIT_API_ROUTE_IDS.includes(routeId as never),
    )
    const wsTypeOffenders = scenario.allowedWsTypesBeforeReady.filter((type) =>
      FORBIDDEN_VISIBLE_FIRST_WS_TYPES.includes(type as never),
    )

    return [
      ...(routeOffenders.length > 0
        ? [{
            scenarioId: scenario.scenarioId,
            field: 'allowedApiRouteIdsBeforeReady' as const,
            offenders: uniqueStrings(routeOffenders),
          }]
        : []),
      ...(wsTypeOffenders.length > 0
        ? [{
            scenarioId: scenario.scenarioId,
            field: 'allowedWsTypesBeforeReady' as const,
            offenders: uniqueStrings(wsTypeOffenders),
          }]
        : []),
    ]
  })
}

export function evaluateVisibleFirstAcceptanceReport(input: {
  productionFiles: readonly VisibleFirstAcceptanceSourceFile[]
  auditScenarios: readonly VisibleFirstAcceptanceAuditScenario[]
  wsConnectOwner?: string
}): VisibleFirstAcceptanceReport {
  const staticViolations = collectVisibleFirstStaticViolations(input.productionFiles)
  const wsOwnershipViolations = collectVisibleFirstWsOwnershipViolations(
    input.productionFiles,
    input.wsConnectOwner,
  )
  const auditScenarioViolations = collectVisibleFirstAuditScenarioViolations(input.auditScenarios)

  return {
    ok:
      staticViolations.length === 0 &&
      wsOwnershipViolations.length === 0 &&
      auditScenarioViolations.length === 0,
    staticViolations,
    wsOwnershipViolations,
    auditScenarioViolations,
  }
}
