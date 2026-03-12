import type { Request, Response, NextFunction } from 'express'
import { randomUUID } from 'crypto'
import { logger, withLogContext } from './logger.js'
import { getPerfConfig, logPerfEvent } from './perf-logger.js'

type RequestWithId = Request & { id?: string }
type ResponsePerfContext = {
  readModelLane?: string
  responsePayloadBytes?: number
  queueDepth?: number
  droppedBytes?: number
}
type ResponseWithPerfContext = Response & { locals: Response['locals'] & ResponsePerfContext }
const perfConfig = getPerfConfig()

/** Strip `token` query parameter from URLs to prevent credential leakage in logs. */
export function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url, 'http://localhost')
    parsed.searchParams.delete('token')
    const search = parsed.searchParams.toString()
    return parsed.pathname + (search ? `?${search}` : '')
  } catch {
    return url
  }
}

function getRequestId(req: Request): string {
  const headerId = req.headers['x-request-id']
  if (typeof headerId === 'string' && headerId.trim()) return headerId
  return randomUUID()
}

export function setResponsePerfContext(res: Response, context: ResponsePerfContext): void {
  const response = res as ResponseWithPerfContext
  response.locals ??= {}
  Object.assign(response.locals, context)
}

export function requestLogger(req: RequestWithId, res: Response, next: NextFunction) {
  const requestId = getRequestId(req)
  req.id = requestId
  res.setHeader('x-request-id', requestId)

  const start = process.hrtime.bigint()

  withLogContext(
    {
      requestId,
      requestMethod: req.method,
      requestPath: sanitizeUrl(req.originalUrl),
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    },
    () => {
      res.on('finish', () => {
        const durationMs = Number(process.hrtime.bigint() - start) / 1e6
        const statusCode = res.statusCode
        const level = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info'
        const perfContext = (res as ResponseWithPerfContext).locals ?? {}
        const contentLength = res.getHeader('content-length')
        const payloadBytes = typeof perfContext.responsePayloadBytes === 'number'
          ? perfContext.responsePayloadBytes
          : typeof contentLength === 'number'
            ? contentLength
            : undefined

        logger[level](
          {
            event: 'http_request',
            component: 'http',
            statusCode,
            durationMs: Number(durationMs.toFixed(2)),
            contentLength,
            lane: perfContext.readModelLane,
            payloadBytes,
            queueDepth: perfContext.queueDepth,
            droppedBytes: perfContext.droppedBytes,
          },
          'HTTP request',
        )

        if (perfConfig.enabled && durationMs >= perfConfig.httpSlowMs) {
          logPerfEvent(
            'http_request_slow',
            {
              method: req.method,
              path: sanitizeUrl(req.originalUrl),
              statusCode,
              durationMs: Number(durationMs.toFixed(2)),
              lane: perfContext.readModelLane,
              payloadBytes,
              queueDepth: perfContext.queueDepth,
              droppedBytes: perfContext.droppedBytes,
              requestBytes: req.headers['content-length'],
              responseBytes: contentLength ?? payloadBytes,
            },
            'warn',
          )
        }
      })

      next()
    },
  )
}
