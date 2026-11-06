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
  hasCreateRoute,
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

export type FreshAgentAttachDecisionFence = { epoch: number; generation: number }
export type FreshAgentAttachDecision<T> = {
  key: string
  content: T
  fence: FreshAgentAttachDecisionFence | undefined
  requestId: string
}

export type FreshAgentAttachDecisionRoute = {
  requestId: string
  viewId: string
  provider: string
  sessionType: string
  sessionId: string
}

export type FreshAgentAttachOwnerAuthority = {
  ownerKind: 'terminal' | 'fresh-agent'
  ownerGeneration: number
  ownerEpoch?: number
}

const currentAttachDecisionByView = new Map<string, FreshAgentAttachDecisionRoute | null>()

/** Register the immutable attach decision a modern requester reply may settle. */
export function registerFreshAgentAttachDecisionRoute(route: FreshAgentAttachDecisionRoute): void {
  currentAttachDecisionByView.set(route.viewId, route)
}

/** Retire only the exact route, so an old view cleanup cannot clear a newer decision. */
export function clearFreshAgentAttachDecisionRoute(viewId: string, requestId: string): void {
  const current = currentAttachDecisionByView.get(viewId)
  if (current?.requestId === requestId) currentAttachDecisionByView.set(viewId, null)
}

/**
 * Modern attach results are useful only while they still name the decision
 * currently owned by that view. An absent result id is the legacy frame shape;
 * an unknown or retired modern route is stale.
 */
export function freshAgentAttachResultMatchesCurrentDecisionRoute(
  result: {
    requestId?: unknown
    viewId?: unknown
    provider?: unknown
    sessionType?: unknown
    sessionId?: unknown
    sessionRef?: unknown
  },
): boolean | undefined {
  if (typeof result.requestId !== 'string') return undefined
  const route = typeof result.viewId === 'string'
    ? currentAttachDecisionByView.get(result.viewId)
    : [...currentAttachDecisionByView.values()].find((candidate) => candidate?.requestId === result.requestId)
  if (!route) return false
  if (
    route.requestId !== result.requestId
    || (typeof result.viewId === 'string' && route.viewId !== result.viewId)
    || route.provider !== result.provider
    || route.sessionType !== result.sessionType
  ) return false

  const resultRef = result.sessionRef && typeof result.sessionRef === 'object'
    ? result.sessionRef as { provider?: unknown; sessionId?: unknown }
    : undefined
  if (resultRef?.sessionId !== undefined) {
    return resultRef.provider === route.provider && resultRef.sessionId === route.sessionId
  }
  return result.sessionId === route.sessionId
}

/** Read a typed owner tuple, retaining a legacy generation-only 409 shape. */
export function readFreshAgentAttachOwnerAuthority(value: unknown): FreshAgentAttachOwnerAuthority | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (record.ownerKind !== 'terminal' && record.ownerKind !== 'fresh-agent') return undefined
  if (!Number.isInteger(record.ownerGeneration) || (record.ownerGeneration as number) < 0) return undefined
  if (record.ownerEpoch !== undefined && (!Number.isInteger(record.ownerEpoch) || (record.ownerEpoch as number) < 0)) return undefined
  return {
    ownerKind: record.ownerKind,
    ownerGeneration: record.ownerGeneration as number,
    ...(record.ownerEpoch !== undefined ? { ownerEpoch: record.ownerEpoch as number } : {}),
  }
}

/** True when a refusal tried to provide owner authority, even if it is incomplete. */
export function hasFreshAgentAttachOwnerAuthority(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return record.ownerKind !== undefined
    || record.ownerEpoch !== undefined
    || record.ownerGeneration !== undefined
}

/** Verify that a requester result names the view's canonical conversation. */
export function freshAgentAttachResultMatchesLocator(
  result: {
    provider?: unknown
    sessionType?: unknown
    sessionId?: unknown
    sessionRef?: unknown
  },
  locator: { provider: string; sessionType: string; sessionId: string },
): boolean {
  if (result.provider !== locator.provider || result.sessionType !== locator.sessionType) return false
  const resultRef = result.sessionRef && typeof result.sessionRef === 'object'
    ? result.sessionRef as { provider?: unknown; sessionId?: unknown }
    : undefined
  if (resultRef?.sessionId !== undefined) {
    return resultRef.provider === locator.provider && resultRef.sessionId === locator.sessionId
  }
  return result.sessionId === locator.sessionId
}

/** A result settles only the current view's immutable attach decision. */
export function freshAgentAttachResultMatchesDecision(
  result: { requestId?: unknown; viewId?: unknown },
  decision: { requestId: string; viewId: string },
): boolean {
  return result.requestId === decision.requestId && result.viewId === decision.viewId
}

/** Keep a request id for retries of the same attach decision. A new target,
 * explicit decision, or observed owner fence gets a new id. The connection's
 * ready handshake is intentionally not part of this identity. */
export function captureFreshAgentAttachDecision<T>(
  key: string,
  content: T,
  fence: FreshAgentAttachDecisionFence | undefined,
  previous: FreshAgentAttachDecision<T> | null,
): FreshAgentAttachDecision<T> {
  if (
    previous?.key === key
    && previous.fence?.epoch === fence?.epoch
    && previous.fence?.generation === fence?.generation
  ) return previous
  return { key, content, fence, requestId: nanoid() }
}

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
export function consumeCancelledFreshAgentCreateRoute(requestId: string, responseViewId?: string): {
  viewId?: string
  matchesCurrentView: boolean
} | undefined {
  const cancelledRoute = consumeCancelledCreateRoute(requestId, responseViewId)
  if (!cancelledRoute) return undefined

  const currentRoute = getCreateRoute(requestId)
  const hasCurrentRoute = hasCreateRoute(requestId)
  const matchesCurrentView = !cancelledRoute.viewId
    || !hasCurrentRoute
    || currentRoute?.viewId === cancelledRoute.viewId
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
