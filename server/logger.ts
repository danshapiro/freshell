import { AsyncLocalStorage } from 'async_hooks'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import pino, { type DestinationStream, type LevelWithSilent } from 'pino'
import { createStream, type RotatingFileStream } from 'rotating-file-stream'

const env = process.env.NODE_ENV || 'development'
const level = process.env.LOG_LEVEL || 'debug'
const DEFAULT_DEBUG_LOG_FILE = 'server-debug.jsonl'
const DEFAULT_DEBUG_LOG_SIZE: SizeString = '10M'
const DEFAULT_DEBUG_LOG_MAX_FILES = 5

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
const require = createRequire(import.meta.url)

type SizeString = `${number}B` | `${number}K` | `${number}M` | `${number}G`

type DebugFileStreamOptions = {
  size?: SizeString
  maxFiles?: number
}

function isTestRuntime(envVars: NodeJS.ProcessEnv): boolean {
  return (
    (envVars.NODE_ENV || 'development') === 'test' ||
    envVars.VITEST === 'true' ||
    envVars.VITEST === '1' ||
    envVars.VITEST_POOL_ID !== undefined
  )
}

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

export function resolveDebugLogPath(
  envVars: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string | null {
  const explicitPath = envVars.LOG_DEBUG_PATH?.trim()
  if (explicitPath) return path.resolve(explicitPath)
  if (isTestRuntime(envVars)) return null

  const logDirOverride = envVars.FRESHELL_LOG_DIR?.trim()
  const logDir = logDirOverride ? path.resolve(logDirOverride) : path.join(homeDir, '.freshell', 'logs')
  return path.join(logDir, DEFAULT_DEBUG_LOG_FILE)
}

export function createDebugFileStream(filePath: string, options: DebugFileStreamOptions = {}): RotatingFileStream {
  const size = options.size ?? DEFAULT_DEBUG_LOG_SIZE
  const maxFiles = options.maxFiles ?? DEFAULT_DEBUG_LOG_MAX_FILES
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  return createStream(path.basename(filePath), { path: dir, size, maxFiles })
}

function createPinoOptions() {
  return {
    level,
    base: {
      app: 'freshell',
      env,
      version: appVersion,
    },
    formatters: {
      level(label: string, number: number) {
        return { level: number, severity: label }
      },
    },
    mixin() {
      return logContext.getStore() || EMPTY_CONTEXT
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  }
}

function createConsoleStream(shouldPrettyPrint: boolean): DestinationStream {
  if (!shouldPrettyPrint) return pino.destination(1)
  const pinoPretty = require('pino-pretty') as typeof import('pino-pretty')
  const pretty = pinoPretty({ colorize: true, translateTime: 'SYS:standard' })
  return pretty
}

function attachDebugStreamWarnings(
  stream: RotatingFileStream,
  consoleLogger: pino.Logger,
  filePath: string,
) {
  let warned = false
  const warnOnce = (err: Error, event: string) => {
    if (warned) return
    warned = true
    consoleLogger.warn({ err, filePath, event }, 'Debug log stream issue')
  }
  stream.on('error', (err) => warnOnce(err, 'error'))
  stream.on('warning', (err) => warnOnce(err, 'warning'))
}

export function createLogger(destination?: DestinationStream) {
  if (destination) {
    return pino(createPinoOptions(), destination)
  }

  const shouldPrettyPrint = env !== 'production' && env !== 'test'
  const consoleStream = createConsoleStream(shouldPrettyPrint)
  const consoleLogger = pino(createPinoOptions(), consoleStream)
  const streams: Array<{ stream: DestinationStream; level: LevelWithSilent }> = [
    { stream: consoleStream, level: 'info' },
  ]

  const debugLogPath = resolveDebugLogPath()
  if (debugLogPath) {
    try {
      const debugStream = createDebugFileStream(debugLogPath)
      streams.push({ stream: debugStream, level: 'debug' })
      attachDebugStreamWarnings(debugStream, consoleLogger, debugLogPath)
    } catch (err) {
      consoleLogger.warn({ err, filePath: debugLogPath }, 'Debug log file disabled')
    }
  }

  return pino(createPinoOptions(), pino.multistream(streams))
}

export const logger = createLogger()

export function setLogLevel(nextLevel: LevelWithSilent): void {
  logger.level = nextLevel
}
