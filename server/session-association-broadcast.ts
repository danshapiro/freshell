import { recordSessionLifecycleEvent } from './session-observability.js'
import type { CodingCliProviderName } from './coding-cli/types.js'
import type { TerminalMetadataService } from './terminal-metadata-service.js'

type AssociationBroadcastSource = 'indexer_update' | 'claude_new_session' | 'opencode_controller'

export function broadcastTerminalSessionAssociation(opts: {
  wsHandler: { broadcast: (message: unknown) => void }
  terminalMetadata: Pick<TerminalMetadataService, 'associateSession'>
  broadcastTerminalMetaUpserts: (upserts: ReturnType<TerminalMetadataService['list']>) => void
  provider: CodingCliProviderName
  terminalId: string
  sessionId: string
  source: AssociationBroadcastSource
}): void {
  recordSessionLifecycleEvent({
    kind: 'session_association_broadcast',
    provider: opts.provider,
    terminalId: opts.terminalId,
    sessionId: opts.sessionId,
    source: opts.source,
  })

  opts.wsHandler.broadcast({
    type: 'terminal.session.associated' as const,
    terminalId: opts.terminalId,
    sessionRef: {
      provider: opts.provider,
      sessionId: opts.sessionId,
    },
  })

  const metaUpsert = opts.terminalMetadata.associateSession(
    opts.terminalId,
    opts.provider,
    opts.sessionId,
  )
  if (metaUpsert) {
    opts.broadcastTerminalMetaUpserts([metaUpsert])
  }
}
