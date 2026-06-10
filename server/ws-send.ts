import WebSocket from 'ws'
import { logger } from './logger.js'
import { getPerfConfig, logPerfEvent, shouldLog } from './perf-logger.js'

const log = logger.child({ component: 'ws-send' })
const perfConfig = getPerfConfig()

export const MAX_SERIALIZED_APPLICATION_JSON_BYTES = Math.max(
  1024,
  readPositiveNumber(
    process.env.MAX_SERIALIZED_APPLICATION_JSON_BYTES ?? process.env.WS_MAX_PAYLOAD_BYTES,
    16 * 1024 * 1024,
  ),
)

export type JsonWebSocket = {
  readyState: number
  bufferedAmount?: number
  connectionId?: string
  send: (data: string, cb?: (err?: Error) => void) => void
  close?: (code?: number, reason?: string) => void
}

export type PreparedJsonMessage = {
  serialized: string
  serializedApplicationJsonBytes: number
  messageType?: string
  serializeMs?: number
}

export type SendJsonOptions = {
  skipBackpressureCheck?: boolean
  maxBufferedAmount?: number
  backpressureCloseCode?: number
  backpressureCloseReason?: string
}

export type SendJsonResult = {
  /** true means ws.send returned without throwing; async callback failures are logged separately. */
  sent: boolean
  reason?: 'closed' | 'backpressure' | 'oversized' | 'serialize_error' | 'send_error'
  serializedApplicationJsonBytes?: number
  bufferedBefore?: number
  bufferedAfter?: number
  messageType?: string
  error?: unknown
}

export function readWebSocketBufferedAmount(ws: { bufferedAmount?: number }): number | undefined {
  const buffered = ws.bufferedAmount
  return typeof buffered === 'number' && Number.isFinite(buffered) ? buffered : undefined
}

export function prepareJsonMessage(message: unknown): PreparedJsonMessage {
  const serializeStart = perfConfig.enabled ? process.hrtime.bigint() : null
  const serialized = JSON.stringify(message)
  const serializeEnd = serializeStart ? process.hrtime.bigint() : null
  if (typeof serialized !== 'string') {
    throw new Error('WebSocket JSON message is not serializable')
  }

  return {
    serialized,
    serializedApplicationJsonBytes: Buffer.byteLength(serialized, 'utf8'),
    messageType: extractMessageType(message),
    serializeMs: serializeStart && serializeEnd
      ? Number((Number(serializeEnd - serializeStart) / 1e6).toFixed(2))
      : undefined,
  }
}

export function sendJsonMessage(
  ws: JsonWebSocket,
  message: unknown,
  options: SendJsonOptions = {},
): SendJsonResult {
  let prepared: PreparedJsonMessage
  try {
    prepared = prepareJsonMessage(message)
  } catch (error) {
    log.warn({
      err: error instanceof Error ? error : new Error(String(error)),
      connectionId: ws.connectionId || 'unknown',
      messageType: extractMessageType(message) || 'unknown',
    }, 'WebSocket message serialization failed')
    return {
      sent: false,
      reason: 'serialize_error',
      error,
      messageType: extractMessageType(message),
      bufferedBefore: readWebSocketBufferedAmount(ws),
      bufferedAfter: readWebSocketBufferedAmount(ws),
    }
  }

  return sendPreparedJsonMessage(ws, prepared, options)
}

export function sendPreparedJsonMessage(
  ws: JsonWebSocket,
  prepared: PreparedJsonMessage,
  options: SendJsonOptions = {},
): SendJsonResult {
  const bufferedBefore = readWebSocketBufferedAmount(ws)
  const baseResult = {
    serializedApplicationJsonBytes: prepared.serializedApplicationJsonBytes,
    bufferedBefore,
    messageType: prepared.messageType,
  }

  if (ws.readyState !== WebSocket.OPEN) {
    return {
      ...baseResult,
      sent: false,
      reason: 'closed',
      bufferedAfter: readWebSocketBufferedAmount(ws),
    }
  }

  if (prepared.serializedApplicationJsonBytes > MAX_SERIALIZED_APPLICATION_JSON_BYTES) {
    log.warn({
      connectionId: ws.connectionId || 'unknown',
      messageType: prepared.messageType || 'unknown',
      serializedApplicationJsonBytes: prepared.serializedApplicationJsonBytes,
      maxSerializedApplicationJsonBytes: MAX_SERIALIZED_APPLICATION_JSON_BYTES,
    }, 'WebSocket JSON message exceeds serialized byte budget')
    return {
      ...baseResult,
      sent: false,
      reason: 'oversized',
      bufferedAfter: readWebSocketBufferedAmount(ws),
    }
  }

  if (
    !options.skipBackpressureCheck
    && typeof options.maxBufferedAmount === 'number'
    && typeof bufferedBefore === 'number'
    && bufferedBefore > options.maxBufferedAmount
  ) {
    logBackpressureClose(ws, bufferedBefore, options.maxBufferedAmount)
    try {
      ws.close?.(
        options.backpressureCloseCode,
        options.backpressureCloseReason ?? 'Backpressure',
      )
    } catch (error) {
      log.warn({
        err: error instanceof Error ? error : new Error(String(error)),
        connectionId: ws.connectionId || 'unknown',
      }, 'WebSocket backpressure close failed')
    }
    return {
      ...baseResult,
      sent: false,
      reason: 'backpressure',
      bufferedAfter: readWebSocketBufferedAmount(ws),
    }
  }

  const shouldLogSend = shouldLogLargeSend(ws, prepared)
  const sendStart = shouldLogSend ? process.hrtime.bigint() : null
  try {
    ws.send(prepared.serialized, (err) => {
      const bufferedAfterCallback = readWebSocketBufferedAmount(ws)
      if (err) {
        log.warn({
          err,
          connectionId: ws.connectionId || 'unknown',
          messageType: prepared.messageType || 'unknown',
          payloadBytes: prepared.serializedApplicationJsonBytes,
          bufferedBytes: bufferedBefore,
          bufferedBytesAfter: bufferedAfterCallback,
        }, 'WebSocket send callback reported failure')
      }
      if (shouldLogSend) {
        const sendMs = sendStart ? Number((Number(process.hrtime.bigint() - sendStart) / 1e6).toFixed(2)) : undefined
        logPerfEvent(
          'ws_send_large',
          {
            connectionId: ws.connectionId,
            messageType: prepared.messageType,
            payloadBytes: prepared.serializedApplicationJsonBytes,
            bufferedBytes: bufferedBefore,
            bufferedBytesAfter: bufferedAfterCallback,
            serializeMs: prepared.serializeMs,
            sendMs,
            error: !!err,
          },
          'warn',
        )
      }
    })
  } catch (error) {
    log.warn({
      err: error instanceof Error ? error : new Error(String(error)),
      connectionId: ws.connectionId || 'unknown',
      messageType: prepared.messageType || 'unknown',
    }, 'WebSocket send failed')
    return {
      ...baseResult,
      sent: false,
      reason: 'send_error',
      bufferedAfter: readWebSocketBufferedAmount(ws),
      error,
    }
  }

  return {
    ...baseResult,
    sent: true,
    bufferedAfter: readWebSocketBufferedAmount(ws),
  }
}

function extractMessageType(message: unknown): string | undefined {
  if (!message || typeof message !== 'object' || !('type' in message)) return undefined
  const typeValue = (message as { type?: unknown }).type
  return typeof typeValue === 'string' ? typeValue : undefined
}

function readPositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function shouldLogLargeSend(ws: JsonWebSocket, prepared: PreparedJsonMessage): boolean {
  if (!perfConfig.enabled) return false
  if (prepared.serializedApplicationJsonBytes < perfConfig.wsPayloadWarnBytes) return false
  return shouldLog(
    `ws_send_large_${ws.connectionId || 'unknown'}_${prepared.messageType || 'unknown'}`,
    perfConfig.rateLimitMs,
  )
}

function logBackpressureClose(
  ws: JsonWebSocket,
  bufferedBytes: number,
  limitBytes: number,
): void {
  if (perfConfig.enabled && shouldLog(`ws_backpressure_${ws.connectionId || 'unknown'}`, perfConfig.rateLimitMs)) {
    logPerfEvent(
      'ws_backpressure_close',
      {
        connectionId: ws.connectionId,
        bufferedBytes,
        limitBytes,
      },
      'warn',
    )
  }
}
