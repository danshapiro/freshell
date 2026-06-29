import fs from 'fs'
import path from 'path'

export type ElectronMainLogSeverity = 'debug' | 'info' | 'warn' | 'error'

export interface ElectronMainLogEntry {
  severity: ElectronMainLogSeverity
  event: string
  [key: string]: unknown
}

export interface ElectronMainLogger {
  log(entry: ElectronMainLogEntry): void
}

interface CreateElectronMainLoggerOptions {
  configDir: string
  now?: () => Date
  pid?: number
}

const COMPONENT = 'electron-main'
const REDACTED = '[REDACTED]'

function looksLikeUrl(value: string): boolean {
  try {
    // Use the standard URL parser so query redaction only runs on real URLs.
    new URL(value)
    return true
  } catch {
    return false
  }
}

function normalizeString(value: string): string {
  const redactedUrl = looksLikeUrl(value) ? redactUrlForLog(value) : value
  return redactedUrl.replace(
    /([?&]?(?:token|authorization|password|secret)=)[^\s&]+/gi,
    `$1${REDACTED}`,
  )
}

function isTokenBearingKey(key: string): boolean {
  return /token|authorization|password|secret/i.test(key)
}

function normalizeValue(value: unknown, key?: string): unknown {
  if (key && isTokenBearingKey(key)) {
    return REDACTED
  }

  if (typeof value === 'string') {
    return normalizeString(value)
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: normalizeString(value.message),
      stack: value.stack ? normalizeString(value.stack) : undefined,
    }
  }

  if (Array.isArray(value)) {
    return value.map((nested) => normalizeValue(nested))
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([nestedKey, nestedValue]) => [
        nestedKey,
        normalizeValue(nestedValue, nestedKey),
      ]),
    )
  }

  return value
}

export function redactUrlForLog(value: string): string {
  try {
    const url = new URL(value)
    const keys = new Set(url.searchParams.keys())

    for (const key of keys) {
      if (isTokenBearingKey(key)) {
        url.searchParams.set(key, REDACTED)
      }
    }

    if (url.password) {
      url.password = REDACTED
    }

    return url.toString()
  } catch {
    return normalizeString(value)
  }
}

export function createElectronMainLogger(
  options: CreateElectronMainLoggerOptions,
): ElectronMainLogger {
  const now = options.now ?? (() => new Date())
  const pid = options.pid ?? process.pid
  const logDir = path.join(options.configDir, 'logs')
  const logPath = path.join(logDir, `${COMPONENT}.${pid}.jsonl`)

  return {
    log(entry) {
      const normalizedEntry = Object.fromEntries(
        Object.entries(entry).map(([key, value]) => [key, normalizeValue(value, key)]),
      )
      const record = {
        ...normalizedEntry,
        timestamp: now().toISOString(),
        severity: entry.severity,
        component: COMPONENT,
      }
      const line = JSON.stringify(record)

      try {
        fs.mkdirSync(logDir, { recursive: true })
        fs.appendFileSync(logPath, `${line}\n`, 'utf8')
      } catch {
        console.error(line)
      }
    },
  }
}
