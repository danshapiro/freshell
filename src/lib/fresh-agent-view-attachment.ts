import { nanoid } from 'nanoid'
import type { FreshAgentViewAttachment } from '@shared/fresh-agent-contract'
import type { SessionRef } from '@shared/session-contract'
import type { FreshAgentPaneContent } from '@/store/paneTypes'
import type { WsClient } from '@/lib/ws-client'
import { createLogger } from '@/lib/client-logger'
import {
  consumeCancelledCreateRoute,
  consumeCreateRoute,
  getCreateRoute,
} from '@/lib/create-cancellation'

const log = createLogger('fresh-agent-view-attachment')

/** A close may proceed only after this bounded wait receives its own ack. */
export const FRESH_AGENT_VIEW_DETACH_TIMEOUT_MS = 5_000

export type FreshAgentViewDetachErrorCode =
  | 'VIEW_DETACH_FAILED'
  | 'WS_DISCONNECTED'
  | 'VIEW_DETACH_TIMEOUT'
  | 'VIEW_DETACH_SEND_FAILED'

export class FreshAgentViewDetachError extends Error {
  constructor(
    readonly code: FreshAgentViewDetachErrorCode | string,
    message: string,
  ) {
    super(message)
    this.name = 'FreshAgentViewDetachError'
  }
}

type FreshAgentViewWs = Pick<WsClient, 'send' | 'onMessage' | 'onDisconnect'>
export type LocatedFreshAgentViewAttachment = FreshAgentViewAttachment & { sessionId: string }

/** Resolve the connection-scoped attachment represented by one pane. */
export function freshAgentViewAttachmentForPane(
  content: Pick<FreshAgentPaneContent, 'provider' | 'sessionType' | 'createRequestId' | 'viewId' | 'sessionId' | 'sessionRef'>,
  sessionIdOverride?: string,
): LocatedFreshAgentViewAttachment | undefined {
  const sessionId = sessionIdOverride
    ?? content.sessionId
    ?? (content.sessionRef?.provider === content.provider ? content.sessionRef.sessionId : undefined)
  const viewId = content.viewId?.trim() || content.createRequestId.trim()
  if (!sessionId || !viewId) return undefined

  const sessionRef: SessionRef = content.sessionRef?.provider === content.provider
    && content.sessionRef.sessionId === sessionId
    ? content.sessionRef
    : { provider: content.provider, sessionId }
  return {
    provider: content.provider,
    sessionType: content.sessionType,
    sessionId,
    sessionRef,
    viewId,
  }
}

/** Consume a late create result only when it still belongs to the canceled
 * view; a replacement view may already own the same request route. */
export function consumeCancelledFreshAgentCreateRoute(requestId: string): {
  viewId?: string
  matchesCurrentView: boolean
} | undefined {
  const cancelledRoute = consumeCancelledCreateRoute(requestId)
  if (!cancelledRoute) return undefined

  const currentRoute = getCreateRoute(requestId)
  const matchesCurrentView = !cancelledRoute.viewId
    || !currentRoute
    || currentRoute.viewId === cancelledRoute.viewId
  const route = matchesCurrentView
    ? consumeCreateRoute(requestId, cancelledRoute.viewId)
    : undefined

  return {
    viewId: cancelledRoute.viewId ?? route?.viewId,
    matchesCurrentView,
  }
}

/** Remove only this pane's connection-scoped delivery interest. The server
 * acknowledgement is correlated by both request and view because two panes
 * on one device may display the same canonical conversation. */
export function detachFreshAgentView(
  ws: FreshAgentViewWs,
  attachment: FreshAgentViewAttachment,
): Promise<void> {
  const requestId = nanoid()
  const request = { type: 'freshAgent.detach', requestId, ...attachment } as const

  return new Promise((resolve, reject) => {
    let settled = false
    let messageUnsubscribe = () => {}
    let disconnectUnsubscribe = () => {}
    let timer: ReturnType<typeof setTimeout> | undefined

    const finish = (error?: FreshAgentViewDetachError) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      messageUnsubscribe()
      disconnectUnsubscribe()
      if (error) {
        log.warn('Fresh Agent view detach was not confirmed', {
          event: 'fresh_agent.view.detach_unconfirmed',
          requestId,
          viewId: attachment.viewId,
          provider: attachment.provider,
          sessionId: attachment.sessionId ?? attachment.sessionRef?.sessionId,
          code: error.code,
        })
        reject(error)
      } else {
        resolve()
      }
    }

    messageUnsubscribe = ws.onMessage((message) => {
      const frame = message as Record<string, unknown>
      if (
        frame.type !== 'freshAgent.detached'
        || frame.requestId !== requestId
        || frame.viewId !== attachment.viewId
      ) return

      if (frame.success !== true) {
        finish(new FreshAgentViewDetachError(
          typeof frame.code === 'string' ? frame.code : 'VIEW_DETACH_FAILED',
          typeof frame.message === 'string' ? frame.message : 'The server did not confirm this view detach.',
        ))
        return
      }
      finish()
    })
    disconnectUnsubscribe = ws.onDisconnect(() => {
      finish(new FreshAgentViewDetachError('WS_DISCONNECTED', 'The server disconnected before confirming this view detach.'))
    })
    timer = setTimeout(() => {
      finish(new FreshAgentViewDetachError('VIEW_DETACH_TIMEOUT', 'The server did not confirm this view detach in time.'))
    }, FRESH_AGENT_VIEW_DETACH_TIMEOUT_MS)

    try {
      ws.send(request)
    } catch (error) {
      finish(new FreshAgentViewDetachError('VIEW_DETACH_SEND_FAILED', String(error)))
    }
  })
}
