import { recordSessionLifecycleEvent } from './session-observability.js'
import type { CodingCliProviderName } from './coding-cli/types.js'
import type {
  TerminalMeta,
  TerminalMetadataService,
  TerminalSeedRecord,
} from './terminal-metadata-service.js'

/** Single source of truth — session-observability.ts imports this type. */
export type AssociationBroadcastSource =
  | 'indexer_update'
  | 'claude_new_session'
  | 'opencode_controller'
  | 'codex_durability'
  | 'amplifier_locator'
  | 'amplifier_new_session'

export type AssociationPublicationStatus =
  | 'published'
  | 'deduped'
  | 'pendingMetadata'
  | 'rebound'
  | 'seeded'

type AssociationPublishRequest = {
  provider: CodingCliProviderName
  terminalId: string
  sessionId: string
  source: AssociationBroadcastSource
}

type AssociationPublisherDeps = {
  wsHandler: { broadcast: (message: unknown) => void }
  terminalMetadata: Pick<
    TerminalMetadataService,
    'associateSession' | 'clearSessionAssociation' | 'get' | 'list' | 'seedFromTerminal'
  >
  broadcastTerminalMetaUpserts: (upserts: TerminalMeta[]) => void
}

function sessionKey(provider: CodingCliProviderName, sessionId: string): string {
  return `${provider}\0${sessionId}`
}

function pairKey(provider: CodingCliProviderName, sessionId: string, terminalId: string): string {
  return `${sessionKey(provider, sessionId)}\0${terminalId}`
}

export function createTerminalSessionAssociationPublisher(deps: AssociationPublisherDeps) {
  const publishedPairs = new Set<string>()
  const activeTerminalBySession = new Map<string, string>()
  const pendingByTerminalId = new Map<string, AssociationPublishRequest>()

  const findActiveTerminalForSession = (
    provider: CodingCliProviderName,
    sessionId: string,
  ): string | undefined => {
    const key = sessionKey(provider, sessionId)
    const cached = activeTerminalBySession.get(key)
    if (cached && deps.terminalMetadata.get(cached)) {
      return cached
    }

    const active = deps.terminalMetadata.list().find((meta) => (
      meta.provider === provider && meta.sessionId === sessionId
    ))
    return active?.terminalId
  }

  const recordPublished = (request: AssociationPublishRequest) => {
    recordSessionLifecycleEvent({
      kind: 'session_association_broadcast',
      provider: request.provider,
      terminalId: request.terminalId,
      sessionId: request.sessionId,
      source: request.source,
    })
  }

  const publishWithMetadata = (
    request: AssociationPublishRequest,
    seedUpsert?: TerminalMeta,
  ): AssociationPublicationStatus => {
    const key = pairKey(request.provider, request.sessionId, request.terminalId)
    const existingTerminalId = findActiveTerminalForSession(request.provider, request.sessionId)
    if (publishedPairs.has(key) && existingTerminalId === request.terminalId) {
      return 'deduped'
    }

    const rebound = Boolean(existingTerminalId && existingTerminalId !== request.terminalId)
    const metaUpserts: TerminalMeta[] = []
    if (rebound && existingTerminalId) {
      const stale = deps.terminalMetadata.clearSessionAssociation(
        existingTerminalId,
        request.provider,
        request.sessionId,
      )
      if (stale) metaUpserts.push(stale)
    }

    deps.wsHandler.broadcast({
      type: 'terminal.session.associated' as const,
      terminalId: request.terminalId,
      sessionRef: {
        provider: request.provider,
        sessionId: request.sessionId,
      },
    })

    const associated = deps.terminalMetadata.associateSession(
      request.terminalId,
      request.provider,
      request.sessionId,
    )
    if (associated) {
      metaUpserts.push(associated)
    } else if (seedUpsert) {
      metaUpserts.push(seedUpsert)
    }

    if (metaUpserts.length > 0) {
      deps.broadcastTerminalMetaUpserts(metaUpserts)
    }

    pendingByTerminalId.delete(request.terminalId)
    publishedPairs.add(key)
    activeTerminalBySession.set(sessionKey(request.provider, request.sessionId), request.terminalId)
    recordPublished(request)
    return rebound ? 'rebound' : 'published'
  }

  return {
    publish(request: AssociationPublishRequest): AssociationPublicationStatus {
      const key = pairKey(request.provider, request.sessionId, request.terminalId)
      if (
        publishedPairs.has(key)
        && findActiveTerminalForSession(request.provider, request.sessionId) === request.terminalId
      ) {
        return 'deduped'
      }

      if (!deps.terminalMetadata.get(request.terminalId)) {
        const pending = pendingByTerminalId.get(request.terminalId)
        if (
          pending
          && pending.provider === request.provider
          && pending.sessionId === request.sessionId
        ) {
          return 'pendingMetadata'
        }
        pendingByTerminalId.set(request.terminalId, request)
        return 'pendingMetadata'
      }

      return publishWithMetadata(request)
    },

    async seedFromTerminal(record: TerminalSeedRecord): Promise<AssociationPublicationStatus> {
      const pending = pendingByTerminalId.get(record.terminalId)
      const seedUpsert = await deps.terminalMetadata.seedFromTerminal(record)
      if (!pending) {
        if (seedUpsert) {
          deps.broadcastTerminalMetaUpserts([seedUpsert])
        }
        return 'seeded'
      }
      return publishWithMetadata(pending, seedUpsert)
    },

    forgetTerminal(terminalId: string): void {
      pendingByTerminalId.delete(terminalId)
    },
  }
}

export function broadcastTerminalSessionAssociation(opts: {
  wsHandler: { broadcast: (message: unknown) => void }
  terminalMetadata: Pick<TerminalMetadataService, 'associateSession'>
  broadcastTerminalMetaUpserts: (upserts: TerminalMeta[]) => void
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
