import type { Request, Response, NextFunction } from 'express'
import { randomUUID } from 'crypto'
import { logger, withLogContext } from './logger.js'
import { getPerfConfig, logPerfEvent } from './perf-logger.js'

type RequestWithId = Request & { id?: string }
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

        logger[level](
          {
            event: 'http_request',
            component: 'http',
            statusCode,
            durationMs: Number(durationMs.toFixed(2)),
            contentLength: res.getHeader('content-length'),
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
              requestBytes: req.headers['content-length'],
              responseBytes: res.getHeader('content-length'),
            },
            'warn',
          )
        }
      })

      next()
    },
  )
}
