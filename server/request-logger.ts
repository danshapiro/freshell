import type { Request, Response, NextFunction } from 'express'
import { randomUUID } from 'crypto'
import { logger, withLogContext } from './logger.js'

type RequestWithId = Request & { id?: string }

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
      requestPath: req.originalUrl,
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
      })

      next()
    },
  )
}
