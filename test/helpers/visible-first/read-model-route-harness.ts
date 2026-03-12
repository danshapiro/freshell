import http from 'node:http'
import express from 'express'

type ReadModelLane = 'critical' | 'visible' | 'background'

type ReadModelRouteResult =
  | {
      body: unknown
      revision?: number
      status?: number
    }
  | unknown

type ReadModelRouteContext = {
  params: Record<string, string>
  searchParams: URLSearchParams
  signal: AbortSignal
}

type ReadModelRouteHandler = (context: ReadModelRouteContext) => Promise<ReadModelRouteResult> | ReadModelRouteResult

type ReadModelRouteHarnessOptions = {
  token?: string
  bootstrap?: ReadModelRouteHandler
  sessionDirectory?: ReadModelRouteHandler
  agentTimeline?: ReadModelRouteHandler
  terminalDirectory?: ReadModelRouteHandler
  terminalViewport?: ReadModelRouteHandler
  terminalScrollback?: ReadModelRouteHandler
  terminalSearch?: ReadModelRouteHandler
}

export type SchedulerEvent = {
  route: string
  lane: ReadModelLane
  phase: 'start' | 'complete' | 'abort'
  at: number
}

type RevisionLogEntry = {
  route: string
  revision: number
  at: number
}

type AbortLogEntry = {
  route: string
  at: number
}

function listen(server: http.Server, timeoutMs = 5_000): Promise<{ port: number }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.off('error', onError)
      reject(new Error('Timed out waiting for read-model route harness server to listen'))
    }, timeoutMs)

    const onError = (error: Error) => {
      clearTimeout(timeout)
      reject(error)
    }

    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      clearTimeout(timeout)
      server.off('error', onError)
      const address = server.address()
      if (typeof address === 'object' && address) {
        resolve({ port: address.port })
      }
    })
  })
}

function normalizeResult(result: ReadModelRouteResult): { body: unknown; revision?: number; status?: number } {
  if (
    result &&
    typeof result === 'object' &&
    ('body' in result || 'revision' in result || 'status' in result)
  ) {
    const candidate = result as { body?: unknown; revision?: unknown; status?: unknown }
    return {
      body: candidate.body,
      revision: typeof candidate.revision === 'number' ? candidate.revision : undefined,
      status: typeof candidate.status === 'number' ? candidate.status : undefined,
    }
  }

  return { body: result }
}

function resolveLane(searchParams: URLSearchParams, fallback: ReadModelLane): ReadModelLane {
  const priority = searchParams.get('priority')
  if (priority === 'critical' || priority === 'visible' || priority === 'background') {
    return priority
  }
  return fallback
}

export async function createReadModelRouteHarness(options: ReadModelRouteHarnessOptions = {}) {
  const app = express()
  const server = http.createServer(app)
  const token = options.token ?? 'testtoken-testtoken'
  const schedulerEvents: SchedulerEvent[] = []
  const revisionLog: RevisionLogEntry[] = []
  const abortLog: AbortLogEntry[] = []
  const responseBytes = new Map<string, number>()
  const callCounts = new Map<string, number>()
  const waiters = new Map<string, Array<() => void>>()

  app.use(express.json())
  app.use((req, res, next) => {
    if (req.header('x-auth-token') !== token) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    next()
  })

  const recordCall = (route: string) => {
    callCounts.set(route, (callCounts.get(route) ?? 0) + 1)
    const routeWaiters = waiters.get(route) ?? []
    while (routeWaiters.length > 0) {
      routeWaiters.shift()?.()
    }
  }

  const mount = (
    method: 'get',
    path: string,
    route: string,
    fallbackLane: ReadModelLane,
    handler?: ReadModelRouteHandler,
  ) => {
    app[method](path, async (req, res) => {
      if (!handler) {
        res.status(404).json({ error: 'Not found' })
        return
      }

      const searchParams = new URL(req.originalUrl, 'http://127.0.0.1').searchParams
      const lane = resolveLane(searchParams, fallbackLane)
      const abortController = new AbortController()
      let aborted = false

      const markAborted = () => {
        if (aborted) return
        aborted = true
        abortController.abort()
        abortLog.push({ route, at: Date.now() })
        schedulerEvents.push({ route, lane, phase: 'abort', at: Date.now() })
      }

      req.once('aborted', markAborted)
      req.once('close', () => {
        if (!res.writableEnded) {
          markAborted()
        }
      })

      recordCall(route)
      schedulerEvents.push({ route, lane, phase: 'start', at: Date.now() })

      try {
        const result = normalizeResult(await handler({
          params: req.params as Record<string, string>,
          searchParams,
          signal: abortController.signal,
        }))

        if (abortController.signal.aborted) return

        if (typeof result.revision === 'number') {
          revisionLog.push({ route, revision: result.revision, at: Date.now() })
        }

        const payload = JSON.stringify(result.body ?? null)
        responseBytes.set(req.path, Buffer.byteLength(payload, 'utf8'))
        schedulerEvents.push({ route, lane, phase: 'complete', at: Date.now() })
        res.status(result.status ?? 200).type('application/json').send(payload)
      } catch (error) {
        if (abortController.signal.aborted) return
        const message = error instanceof Error ? error.message : 'Unhandled harness route error'
        res.status(500).json({ error: message })
      }
    })
  }

  mount('get', '/api/bootstrap', 'bootstrap', 'critical', options.bootstrap)
  mount('get', '/api/session-directory', 'session-directory', 'visible', options.sessionDirectory)
  mount('get', '/api/agent-sessions/:sessionId/timeline', 'agent-timeline', 'visible', options.agentTimeline)
  mount('get', '/api/terminals', 'terminal-directory', 'visible', options.terminalDirectory)
  mount('get', '/api/terminals/:terminalId/viewport', 'terminal.viewport', 'critical', options.terminalViewport)
  mount('get', '/api/terminals/:terminalId/scrollback', 'terminal.scrollback', 'background', options.terminalScrollback)
  mount('get', '/api/terminals/:terminalId/search', 'terminal.search', 'visible', options.terminalSearch)

  const { port } = await listen(server)
  const baseUrl = `http://127.0.0.1:${port}`

  return {
    async fetch(path: string, init: RequestInit & { authenticated?: boolean } = {}): Promise<Response> {
      const headers = new Headers(init.headers)
      if (init.authenticated !== false) {
        headers.set('x-auth-token', token)
      }
      return fetch(`${baseUrl}${path}`, {
        ...init,
        headers,
      })
    },

    async fetchJson(path: string, init: RequestInit & { authenticated?: boolean } = {}) {
      const response = await this.fetch(path, init)
      const text = await response.text()
      return {
        status: response.status,
        body: text ? JSON.parse(text) : null,
        headers: response.headers,
      }
    },

    waitForCall(route: string, timeoutMs = 2_000): Promise<void> {
      if ((callCounts.get(route) ?? 0) > 0) {
        return Promise.resolve()
      }

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`Timed out waiting for ${route} call`))
        }, timeoutMs)

        const routeWaiters = waiters.get(route) ?? []
        routeWaiters.push(() => {
          clearTimeout(timeout)
          resolve()
        })
        waiters.set(route, routeWaiters)
      })
    },

    getSchedulerEvents(): SchedulerEvent[] {
      return schedulerEvents.slice()
    },

    getRevisionLog(): RevisionLogEntry[] {
      return revisionLog.slice()
    },

    getAbortLog(): AbortLogEntry[] {
      return abortLog.slice()
    },

    waitForAbort(route: string, timeoutMs = 2_000): Promise<void> {
      return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs

        const tick = () => {
          if (abortLog.some((entry) => entry.route === route)) {
            resolve()
            return
          }
          if (Date.now() >= deadline) {
            reject(new Error(`Timed out waiting for ${route} abort`))
            return
          }
          setTimeout(tick, 5)
        }

        tick()
      })
    },

    getResponseBytes(path: string): number {
      return responseBytes.get(path) ?? 0
    },

    async dispose(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      })
    },
  }
}
