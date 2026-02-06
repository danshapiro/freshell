type ClientLogSeverity = 'debug' | 'info' | 'warn' | 'error'

type ClientLogEntry = {
  timestamp: string
  severity: ClientLogSeverity
  message?: string
  event?: string
  consoleMethod?: string
  args?: unknown[]
  stack?: string
  context?: Record<string, unknown>
}

type ClientInfo = {
  id?: string
  userAgent?: string
  url?: string
  path?: string
  language?: string
  platform?: string
}

type ClientLoggerOptions = {
  endpoint: string
  flushIntervalMs: number
  maxBatchSize: number
  maxQueueSize: number
  maxArgs: number
  maxArgLength: number
  maxDepth: number
  enableNetwork: boolean
}

type FlushOptions = {
  useBeacon?: boolean
}

const DEFAULT_OPTIONS: ClientLoggerOptions = {
  endpoint: '/api/logs/client',
  flushIntervalMs: 2000,
  maxBatchSize: 50,
  maxQueueSize: 1000,
  maxArgs: 10,
  maxArgLength: 2000,
  maxDepth: 4,
  enableNetwork: import.meta.env.MODE !== 'test',
}

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace', 'table', 'dir'] as const

type ConsoleMethod = typeof CONSOLE_METHODS[number]

const METHOD_TO_SEVERITY: Record<ConsoleMethod, ClientLogSeverity> = {
  log: 'info',
  info: 'info',
  warn: 'warn',
  error: 'error',
  debug: 'debug',
  trace: 'debug',
  table: 'info',
  dir: 'info',
}

import { getAuthToken } from '@/lib/auth'

function nowIso() {
  return new Date().toISOString()
}

function getClientId(): string {
  const existing = sessionStorage.getItem('client-log-id')
  if (existing) return existing

  const generated = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `client-${Math.random().toString(36).slice(2)}`

  sessionStorage.setItem('client-log-id', generated)
  return generated
}

function truncateString(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return value.slice(0, maxLength - 3) + '...'
}

function toSerializable(
  value: unknown,
  options: Pick<ClientLoggerOptions, 'maxDepth' | 'maxArgs' | 'maxArgLength'>,
  depth = 0,
  seen = new WeakSet<object>()
): unknown {
  if (value === null || value === undefined) return value

  if (typeof value === 'string') return truncateString(value, options.maxArgLength)
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    }
  }

  if (value instanceof Date) return value.toISOString()
  if (value instanceof URL) return value.toString()

  if (typeof value !== 'object') return String(value)

  if (seen.has(value as object)) return '[Circular]'
  if (depth >= options.maxDepth) return '[MaxDepth]'

  seen.add(value as object)

  if (Array.isArray(value)) {
    return value.slice(0, options.maxArgs).map((item) => toSerializable(item, options, depth + 1, seen))
  }

  const record: Record<string, unknown> = {}
  const entries = Object.entries(value as Record<string, unknown>)
  for (const [key, entryValue] of entries.slice(0, options.maxArgs)) {
    record[key] = toSerializable(entryValue, options, depth + 1, seen)
  }

  if (entries.length > options.maxArgs) {
    record._truncatedKeys = entries.length - options.maxArgs
  }

  return record
}

function formatMessage(args: unknown[], options: Pick<ClientLoggerOptions, 'maxArgLength' | 'maxDepth' | 'maxArgs'>): string {
  const parts = args.slice(0, options.maxArgs).map((arg) => {
    if (typeof arg === 'string') return arg
    if (arg instanceof Error) return arg.message

    try {
      return JSON.stringify(toSerializable(arg, options))
    } catch {
      return String(arg)
    }
  })

  return truncateString(parts.join(' '), options.maxArgLength)
}

function buildClientInfo(): ClientInfo {
  return {
    id: getClientId(),
    userAgent: navigator.userAgent,
    url: window.location.href,
    path: window.location.pathname,
    language: navigator.language,
    platform: navigator.platform,
  }
}

export function createClientLogger(options: Partial<ClientLoggerOptions> = {}) {
  const settings = { ...DEFAULT_OPTIONS, ...options }
  const client = buildClientInfo()
  const queue: ClientLogEntry[] = []
  let flushTimer: number | null = null
  let flushing = false
  let droppedCount = 0
  let uninstallHandlers: Array<() => void> = []
  let consoleInstalled = false

  function enqueue(entry: ClientLogEntry) {
    if (queue.length >= settings.maxQueueSize) {
      queue.shift()
      droppedCount += 1
    }

    queue.push(entry)
    scheduleFlush(settings.flushIntervalMs)
  }

  function enqueueDropNotice() {
    if (droppedCount <= 0) return

    queue.unshift({
      timestamp: nowIso(),
      severity: 'warn',
      event: 'client_log_dropped',
      message: `Dropped ${droppedCount} log entries`,
      context: { droppedCount },
    })

    droppedCount = 0
  }

  function scheduleFlush(delayMs: number) {
    if (flushTimer !== null) return

    flushTimer = window.setTimeout(() => {
      flushTimer = null
      void flush()
    }, delayMs)
  }

  function buildEntry(method: ConsoleMethod, args: unknown[]): ClientLogEntry {
    const sanitizedArgs = args.slice(0, settings.maxArgs).map((arg) =>
      toSerializable(arg, settings)
    )
    const firstError = args.find((arg) => arg instanceof Error) as Error | undefined

    return {
      timestamp: nowIso(),
      severity: METHOD_TO_SEVERITY[method],
      event: `console.${method}`,
      consoleMethod: method,
      message: formatMessage(args, settings),
      args: sanitizedArgs,
      stack: method === 'trace' ? new Error().stack : firstError?.stack,
    }
  }

  async function sendBatch(entries: ClientLogEntry[], options: FlushOptions = {}) {
    if (!settings.enableNetwork) return
    if (entries.length === 0) return

    const body = JSON.stringify({ client, entries })
    const token = getAuthToken()
    const headers = new Headers({
      'Content-Type': 'application/json',
    })

    if (token) headers.set('x-auth-token', token)

    if (options.useBeacon && navigator.sendBeacon) {
      const blob = new Blob([body], { type: 'application/json' })
      navigator.sendBeacon(settings.endpoint, blob)
      return
    }

    await fetch(settings.endpoint, {
      method: 'POST',
      headers,
      body,
      keepalive: true,
    })
  }

  async function flush(options: FlushOptions = {}) {
    if (flushing) return
    if (queue.length === 0) return

    flushing = true
    enqueueDropNotice()

    const batch = queue.splice(0, settings.maxBatchSize)

    try {
      await sendBatch(batch, options)
    } catch {
      // On failure, re-queue and try again later.
      queue.unshift(...batch)
    } finally {
      flushing = false
    }

    if (queue.length > 0) {
      scheduleFlush(settings.flushIntervalMs)
    }
  }

  function installConsoleCapture() {
    if (consoleInstalled) return () => {}
    consoleInstalled = true

    const original: Partial<Record<ConsoleMethod, (...args: unknown[]) => void>> = {}

    for (const method of CONSOLE_METHODS) {
      const originalMethod = console[method] as (...args: unknown[]) => void
      original[method] = originalMethod.bind(console)

      console[method] = (...args: unknown[]) => {
        original[method]?.(...args)
        enqueue(buildEntry(method, args))
      }
    }

    const flushOnHide = () => {
      if (document.visibilityState === 'hidden') {
        void flush({ useBeacon: true })
      }
    }

    const flushOnUnload = () => {
      void flush({ useBeacon: true })
    }

    const onWindowError = (event: ErrorEvent) => {
      enqueue({
        timestamp: nowIso(),
        severity: 'error',
        event: 'window.error',
        message: event.message,
        stack: event.error?.stack,
        context: {
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno,
        },
      })
    }

    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason
      const message = reason instanceof Error ? reason.message : String(reason)
      const stack = reason instanceof Error ? reason.stack : undefined

      enqueue({
        timestamp: nowIso(),
        severity: 'error',
        event: 'window.unhandledrejection',
        message,
        stack,
        context: {
          reason: toSerializable(reason, settings),
        },
      })
    }

    window.addEventListener('visibilitychange', flushOnHide)
    window.addEventListener('beforeunload', flushOnUnload)
    window.addEventListener('error', onWindowError)
    window.addEventListener('unhandledrejection', onUnhandledRejection)

    uninstallHandlers.push(() => window.removeEventListener('visibilitychange', flushOnHide))
    uninstallHandlers.push(() => window.removeEventListener('beforeunload', flushOnUnload))
    uninstallHandlers.push(() => window.removeEventListener('error', onWindowError))
    uninstallHandlers.push(() => window.removeEventListener('unhandledrejection', onUnhandledRejection))

    return () => {
      for (const method of CONSOLE_METHODS) {
        if (original[method]) {
          console[method] = original[method] as (...args: unknown[]) => void
        }
      }

      for (const handler of uninstallHandlers) {
        handler()
      }

      uninstallHandlers = []
      consoleInstalled = false
    }
  }

  return {
    flush,
    installConsoleCapture,
  }
}
