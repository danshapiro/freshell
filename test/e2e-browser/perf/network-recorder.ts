import { classifyWsFrameType, normalizeAuditRouteId } from './derive-visible-first-metrics.js'

type RequestWillBeSentEvent = {
  requestId: string
  timestamp?: number
  wallTime?: number
  request?: {
    url?: string
    method?: string
  }
}

type ResponseReceivedEvent = {
  requestId: string
  response?: {
    status?: number
  }
}

type LoadingFinishedEvent = {
  requestId: string
  encodedDataLength?: number
}

type WebSocketFrameEvent = {
  requestId: string
  timestamp?: number
  response?: {
    payloadData?: string
  }
}

export type NetworkCapture = {
  http: {
    requests: Array<{
      requestId: string
      timestamp: number
      url: string
      routeId: string
      method?: string
      status?: number
      encodedDataLength?: number
    }>
  }
  ws: {
    frames: Array<{
      requestId: string
      timestamp: number
      direction: 'sent' | 'received'
      type: string
      payloadLength: number
      payload: string
    }>
  }
}

type HttpSummary = Record<string, { count: number; bytes: number }>
type WsSummary = Record<string, { sentFrames: number; receivedFrames: number; sentBytes: number; receivedBytes: number }>

export type NetworkCaptureSummary = {
  http: {
    byRoute: HttpSummary
  }
  ws: {
    byType: WsSummary
  }
}

export function summarizeNetworkCapture(capture: NetworkCapture): NetworkCaptureSummary {
  const byRoute: HttpSummary = {}
  for (const request of capture.http.requests) {
    byRoute[request.routeId] ??= { count: 0, bytes: 0 }
    byRoute[request.routeId].count += 1
    byRoute[request.routeId].bytes += request.encodedDataLength ?? 0
  }

  const byType: WsSummary = {}
  for (const frame of capture.ws.frames) {
    byType[frame.type] ??= {
      sentFrames: 0,
      receivedFrames: 0,
      sentBytes: 0,
      receivedBytes: 0,
    }
    if (frame.direction === 'sent') {
      byType[frame.type].sentFrames += 1
      byType[frame.type].sentBytes += frame.payloadLength
    } else {
      byType[frame.type].receivedFrames += 1
      byType[frame.type].receivedBytes += frame.payloadLength
    }
  }

  return {
    http: { byRoute },
    ws: { byType },
  }
}

export function createNetworkRecorder() {
  let monotonicEpochOffsetMs: number | null = null
  const pendingRequests = new Map<string, NetworkCapture['http']['requests'][number]>()
  const httpRequests: NetworkCapture['http']['requests'] = []
  const wsFrames: NetworkCapture['ws']['frames'] = []

  function resolveTimestampMs(timestamp?: number, wallTime?: number): number {
    if (typeof timestamp === 'number' && typeof wallTime === 'number') {
      monotonicEpochOffsetMs = wallTime * 1000 - timestamp * 1000
      return wallTime * 1000
    }

    if (typeof wallTime === 'number') {
      return wallTime * 1000
    }

    if (typeof timestamp === 'number' && monotonicEpochOffsetMs !== null) {
      return timestamp * 1000 + monotonicEpochOffsetMs
    }

    return (timestamp ?? 0) * 1000
  }

  return {
    onRequestWillBeSent(event: RequestWillBeSentEvent) {
      const url = event.request?.url ?? ''
      const routeId = normalizeAuditRouteId(url)
      if (!routeId) return
      pendingRequests.set(event.requestId, {
        requestId: event.requestId,
        timestamp: resolveTimestampMs(event.timestamp, event.wallTime),
        url,
        routeId,
        method: event.request?.method,
      })
    },
    onResponseReceived(event: ResponseReceivedEvent) {
      const request = pendingRequests.get(event.requestId)
      if (!request) return
      request.status = event.response?.status
    },
    onLoadingFinished(event: LoadingFinishedEvent) {
      const request = pendingRequests.get(event.requestId)
      if (!request) return
      request.encodedDataLength = event.encodedDataLength ?? 0
      httpRequests.push({ ...request })
      pendingRequests.delete(event.requestId)
    },
    onWebSocketFrameSent(event: WebSocketFrameEvent) {
      const payload = event.response?.payloadData ?? ''
      wsFrames.push({
        requestId: event.requestId,
        timestamp: resolveTimestampMs(event.timestamp),
        direction: 'sent',
        type: classifyWsFrameType(payload),
        payloadLength: Buffer.byteLength(payload),
        payload,
      })
    },
    onWebSocketFrameReceived(event: WebSocketFrameEvent) {
      const payload = event.response?.payloadData ?? ''
      wsFrames.push({
        requestId: event.requestId,
        timestamp: resolveTimestampMs(event.timestamp),
        direction: 'received',
        type: classifyWsFrameType(payload),
        payloadLength: Buffer.byteLength(payload),
        payload,
      })
    },
    snapshot(): NetworkCapture {
      return {
        http: {
          requests: httpRequests.map((request) => ({ ...request })),
        },
        ws: {
          frames: wsFrames.map((frame) => ({ ...frame })),
        },
      }
    },
  }
}
