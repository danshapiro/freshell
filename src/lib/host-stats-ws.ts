import { getWsClient } from '@/lib/ws-client'

/**
 * Thin WS seam for the hoststats.* protocol — shared by the hostStats slice
 * thunks and the Host Stats pane. Frames are Zod-validated by the server;
 * inbound frames are trusted as validated (shared/ws-protocol.ts header —
 * the client does not runtime-revalidate server frames).
 */
export function subscribeHostStats(): void {
  getWsClient().send({ type: 'hoststats.subscribe' })
}

export function unsubscribeHostStats(): void {
  getWsClient().send({ type: 'hoststats.unsubscribe' })
}

export function requestHostStatsRefreshWs(requestId: string): void {
  getWsClient().send({ type: 'hoststats.refresh', requestId })
}
