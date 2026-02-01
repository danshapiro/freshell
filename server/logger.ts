import pino, { type DestinationStream } from 'pino'
import { AsyncLocalStorage } from 'async_hooks'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const env = process.env.NODE_ENV || 'development'
const level = process.env.LOG_LEVEL || 'debug'

type LogContext = {
  requestId?: string
  requestPath?: string
  requestMethod?: string
  ip?: string
  userAgent?: string
  connectionId?: string
}

const logContext = new AsyncLocalStorage<LogContext>()
const EMPTY_CONTEXT: LogContext = {}

function findPackageJson(): string | undefined {
  const __filename = fileURLToPath(import.meta.url)
  let dir = path.dirname(__filename)
  while (dir !== path.dirname(dir)) {
    const candidate = path.join(dir, 'package.json')
    if (fs.existsSync(candidate)) {
      return candidate
    }
    dir = path.dirname(dir)
  }
  return undefined
}

function resolveAppVersion(): string | undefined {
  try {
    const pkgPath = findPackageJson()
    if (!pkgPath) return undefined
    const raw = fs.readFileSync(pkgPath, 'utf-8')
    return JSON.parse(raw).version as string | undefined
  } catch {
    return undefined
  }
}

const appVersion =
  process.env.npm_package_version ||
  process.env.APP_VERSION ||
  (env === 'test' ? undefined : resolveAppVersion())

export function withLogContext<T>(context: LogContext, fn: () => T): T {
  return logContext.run(context, fn)
}

export function getLogContext(): LogContext | undefined {
  return logContext.getStore()
}

export function createLogger(destination?: DestinationStream) {
  const shouldPrettyPrint = !destination && env !== 'production' && env !== 'test'
  const transport = shouldPrettyPrint
    ? {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard' },
      }
    : undefined

  return pino(
    {
      level,
      base: {
        app: 'freshell',
        env,
        version: appVersion,
      },
      formatters: {
        level(label, number) {
          return { level: number, severity: label }
        },
      },
      mixin() {
        return logContext.getStore() || EMPTY_CONTEXT
      },
      timestamp: pino.stdTimeFunctions.isoTime,
      transport,
    },
    destination,
  )
}

export const logger = createLogger()
