import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import type { Logger } from 'pino'
import { logger as defaultLogger } from './logger.js'

const ClientLogEntrySchema = z.object({
  timestamp: z.string(),
  severity: z.enum(['debug', 'info', 'warn', 'error']),
  message: z.string().optional(),
  event: z.string().optional(),
  consoleMethod: z.string().optional(),
  args: z.array(z.unknown()).optional(),
  stack: z.string().optional(),
  context: z.record(z.unknown()).optional(),
})

const ClientInfoSchema = z.object({
  id: z.string().optional(),
  userAgent: z.string().optional(),
  url: z.string().optional(),
  path: z.string().optional(),
  language: z.string().optional(),
  platform: z.string().optional(),
}).optional()

const ClientLogsPayloadSchema = z.object({
  client: ClientInfoSchema,
  entries: z.array(ClientLogEntrySchema).min(1).max(200),
}).strict()

type RequestWithId = Request & { id?: string }

function logClientEntry(log: Logger, req: RequestWithId, entry: z.infer<typeof ClientLogEntrySchema>, client: z.infer<typeof ClientInfoSchema>) {
  const level = entry.severity
  const message = entry.message || entry.event || 'Client log'

  log[level](
    {
      event: 'client_log',
      clientId: client?.id,
      client,
      clientTimestamp: entry.timestamp,
      clientEvent: entry.event,
      consoleMethod: entry.consoleMethod,
      args: entry.args,
      context: entry.context,
      stack: entry.stack,
      requestId: req.id,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    },
    message,
  )
}

export function createClientLogsRouter(log: Logger = defaultLogger) {
  const routerLog = log.child({ component: 'client-logs' })
  const router = Router()

  router.post('/logs/client', (req: RequestWithId, res: Response) => {
    const parsed = ClientLogsPayloadSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues })
    }

    const { entries, client } = parsed.data

    for (const entry of entries) {
      logClientEntry(routerLog, req, entry, client)
    }

    res.status(204).send()
  })

  return router
}
