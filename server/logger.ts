import { AsyncLocalStorage } from 'async_hooks'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import pino, { type DestinationStream, type LevelWithSilent } from 'pino'
import { createStream, type RotatingFileStream } from 'rotating-file-stream'
import { getFreshellHomeDir, getFreshellConfigDir } from './freshell-home.js'

const env = process.env.NODE_ENV || 'development'
const level = process.env.LOG_LEVEL || 'debug'
const DEFAULT_DEBUG_LOG_FILE = 'server-debug'
const DEFAULT_DEBUG_LOG_SUFFIX = '.jsonl'
const DEFAULT_DEBUG_LOG_SIZE: SizeString = '10M'
const DEFAULT_DEBUG_LOG_MAX_FILES = 5
const DEFAULT_SESSION_LIFECYCLE_LOG_FILE = 'session-lifecycle'
const DEFAULT_SESSION_LIFECYCLE_LOG_SUFFIX = '.jsonl'
const DEFAULT_SESSION_LIFECYCLE_LOG_SIZE: SizeString = '10M'
const DEFAULT_SESSION_LIFECYCLE_LOG_MAX_FILES = 10
const DEFAULT_FRESH_AGENT_LOG_FILE = 'fresh-agent'
const DEFAULT_FRESH_AGENT_LOG_SUFFIX = '.jsonl'
const DEFAULT_FRESH_AGENT_LOG_SIZE: SizeString = '10M'
const DEFAULT_FRESH_AGENT_LOG_MAX_FILES = 10
export const DEFAULT_NON_DEBUG_LOG_LEVEL: LevelWithSilent = 'warn'
const DEFAULT_CONSOLE_LOG_LEVEL: LevelWithSilent = 'error'
const SOURCE_ENTRY_MATCHERS = [/(^|\/)server\/index\.ts$/i, /(^|\/)server\/index\.js$/i]
const DIST_ENTRY_MATCHERS = [/(^|\/)dist\/server\/index\.js$/i]
type LogMode = 'development' | 'production'

type LogContext = {
  requestId?: string
  requestPath?: string
  requestMethod?: string
  ip?: string
  userAgent?: string
  connectionId?: string
}

const logContext = new AsyncLocalStorage<LogContext>()
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
  homeDir?: string,
  argv: string[] = process.argv,
): string | null {
  const explicitPath = envVars.LOG_DEBUG_PATH?.trim()
  if (explicitPath) return path.resolve(explicitPath)
  if (isTestRuntime(envVars)) return null

  const logDirOverride = envVars.FRESHELL_LOG_DIR?.trim()
  const logDir = logDirOverride
    ? path.resolve(logDirOverride)
    : homeDir !== undefined
      ? path.join(homeDir, '.freshell', 'logs')
      : path.join(getFreshellConfigDir(envVars), 'logs')
  const filename = resolveDebugLogFilename(envVars, argv)
  return path.join(logDir, filename)
}

export function resolveSessionLifecycleLogPath(
  envVars: NodeJS.ProcessEnv = process.env,
  homeDir?: string,
  argv: string[] = process.argv,
): string | null {
  const explicitPath = envVars.LOG_SESSION_LIFECYCLE_PATH?.trim()
  if (explicitPath) return path.resolve(explicitPath)
  if (isTestRuntime(envVars)) return null

  const logDirOverride = envVars.FRESHELL_LOG_DIR?.trim()
  const logDir = logDirOverride
    ? path.resolve(logDirOverride)
    : homeDir !== undefined
      ? path.join(homeDir, '.freshell', 'logs')
      : path.join(getFreshellConfigDir(envVars), 'logs')
  const mode = resolveDebugLogMode(envVars, argv)
  const instance = resolveDebugInstanceTag(envVars)
  return path.join(
    logDir,
    `${DEFAULT_SESSION_LIFECYCLE_LOG_FILE}.${mode}.${instance}${DEFAULT_SESSION_LIFECYCLE_LOG_SUFFIX}`,
  )
}

export function resolveFreshAgentObservabilityLogPath(
  envVars: NodeJS.ProcessEnv = process.env,
  homeDir?: string,
  argv: string[] = process.argv,
): string | null {
  const explicitPath = envVars.LOG_FRESH_AGENT_PATH?.trim()
  if (explicitPath) return path.resolve(explicitPath)
  if (isTestRuntime(envVars)) return null

  const logDirOverride = envVars.FRESHELL_LOG_DIR?.trim()
  const logDir = logDirOverride
    ? path.resolve(logDirOverride)
    : homeDir !== undefined
      ? path.join(homeDir, '.freshell', 'logs')
      : path.join(getFreshellConfigDir(envVars), 'logs')
  const mode = resolveDebugLogMode(envVars, argv)
  const instance = resolveDebugInstanceTag(envVars)
  return path.join(
    logDir,
    `${DEFAULT_FRESH_AGENT_LOG_FILE}.${mode}.${instance}${DEFAULT_FRESH_AGENT_LOG_SUFFIX}`,
  )
}

function normalizeLogMode(value: string | undefined): LogMode | undefined {
  const normalized = value?.trim().toLowerCase()
  if (normalized === 'development' || normalized === 'dev') return 'development'
  if (normalized === 'production' || normalized === 'prod') return 'production'
  return undefined
}

function normalizeArgPath(arg: string): string {
  return path
    .normalize(arg)
    .replace(/\\+/g, '/')
    .replace(/^\.\/+/, '')
    .toLowerCase()
}

function sanitizeInstanceTag(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined

  const sanitized = path
    .basename(trimmed.replace(/\\/g, '/'))
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')

  return sanitized || undefined
}

function inferLogModeFromArgv(argv: string[] = process.argv): LogMode | undefined {
  const normalizedArgv = argv.map(normalizeArgPath)
  const hasDistEntry = normalizedArgv.some((arg) =>
    DIST_ENTRY_MATCHERS.some((regex) => regex.test(arg)),
  )
  if (hasDistEntry) return 'production'

  const hasSourceEntry = normalizedArgv.some((arg) => {
    if (arg.includes('dist/server/')) return false
    return SOURCE_ENTRY_MATCHERS.some((regex) => regex.test(arg))
  })
  if (hasSourceEntry) return 'development'

  return undefined
}

function resolveDebugLogMode(
  envVars: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv,
): LogMode {
  return (
    normalizeLogMode(envVars.FRESHELL_LOG_MODE) ??
    inferLogModeFromArgv(argv) ??
    (envVars.NODE_ENV === 'production' ? 'production' : 'development')
  )
}

function resolveDebugInstanceTag(envVars: NodeJS.ProcessEnv = process.env): string {
  const explicit = sanitizeInstanceTag(envVars.FRESHELL_LOG_INSTANCE_ID)
  if (explicit) return explicit

  const fallback = [
    sanitizeInstanceTag(envVars.FRESHELL_DEBUG_STREAM_INSTANCE),
    sanitizeInstanceTag(envVars.PORT),
    sanitizeInstanceTag(envVars.VITE_PORT),
  ].find((value) => value)

  return fallback ?? String(process.pid)
}

function resolveDebugLogFilename(
  envVars: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv,
): string {
  const mode = resolveDebugLogMode(envVars, argv)
  const instance = resolveDebugInstanceTag(envVars)
  return `${DEFAULT_DEBUG_LOG_FILE}.${mode}.${instance}${DEFAULT_DEBUG_LOG_SUFFIX}`
}

export function createDebugFileStream(filePath: string, options: DebugFileStreamOptions = {}): RotatingFileStream {
  const size = options.size ?? DEFAULT_DEBUG_LOG_SIZE
  const maxFiles = options.maxFiles ?? DEFAULT_DEBUG_LOG_MAX_FILES
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  return createStream(path.basename(filePath), { path: dir, size, maxFiles })
}

/**
 * One-time startup receipt for the resolved debug log destination, appended
 * SYNCHRONOUSLY at logger construction. rotating-file-stream opens lazily and
 * buffers writes until its async open completes; a short-lived process that
 * imports this module and exits promptly would otherwise lose the marker
 * (observed as a hung-then-empty debug file in the logger.separation
 * integration suite under CI shard contention). The direct append makes the
 * receipt durable before createLogger() returns. One out-of-band line per
 * process launch: rotating-file-stream's open-time stat may or may not see
 * these bytes yet (threadpool race), so rotation size accounting can be off
 * by at most this one line at the 10M cap — negligible.
 */
function writeDebugLogPathMarkerSync(resolved: {
  filePath: string
  debugMode: LogMode
  debugInstance: string
}): void {
  const line = {
    level: 30,
    severity: 'info',
    time: new Date().toISOString(),
    app: 'freshell',
    env,
    version: appVersion,
    ...resolved,
    msg: 'Resolved debug log path',
  }
  fs.appendFileSync(resolved.filePath, `${JSON.stringify(line)}\n`)
}

type DedicatedFileLoggerOptions = {
  filePath: string
  level?: LevelWithSilent
  size?: SizeString
  maxFiles?: number
}

export function createDedicatedFileLogger(options: DedicatedFileLoggerOptions) {
  const stream = createDebugFileStream(options.filePath, {
    size: options.size,
    maxFiles: options.maxFiles,
  })
  return pino(createPinoOptions({ level: options.level ?? 'info' }), stream)
}

export function createSessionLifecycleLogger(filePath: string) {
  return createDedicatedFileLogger({
    filePath,
    level: 'info',
    size: DEFAULT_SESSION_LIFECYCLE_LOG_SIZE,
    maxFiles: DEFAULT_SESSION_LIFECYCLE_LOG_MAX_FILES,
  })
}

export function resolveRuntimeLogLevel(debugLoggingEnabled: boolean): LevelWithSilent {
  return debugLoggingEnabled ? 'debug' : DEFAULT_NON_DEBUG_LOG_LEVEL
}

function createPinoOptions(options: { level?: LevelWithSilent } = {}) {
  return {
    level: options.level ?? level,
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
      // IMPORTANT: pino mutates the object returned by `mixin()` when merging log payloads.
      // Always return a fresh object so fields don't leak between log calls.
      const ctx = logContext.getStore()
      return ctx ? { ...ctx } : {}
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

export function attachDebugStreamWarnings(
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
  const consoleLogger = pino(createPinoOptions({ level: DEFAULT_CONSOLE_LOG_LEVEL }), consoleStream)
  const consoleDiagnosticLogger = pino(createPinoOptions({ level: 'warn' }), consoleStream)
  const streams: Array<{ stream: DestinationStream; level: LevelWithSilent }> = [
    { stream: consoleStream, level: DEFAULT_CONSOLE_LOG_LEVEL },
  ]
  let resolvedDebugLog:
    | {
        filePath: string
        debugMode: LogMode
        debugInstance: string
      }
    | undefined

  const debugLogPath = resolveDebugLogPath()
  if (debugLogPath) {
    try {
      const debugMode = resolveDebugLogMode()
      const debugInstance = resolveDebugInstanceTag()
      const debugStream = createDebugFileStream(debugLogPath)
      streams.push({ stream: debugStream, level: 'debug' })
      attachDebugStreamWarnings(debugStream, consoleDiagnosticLogger, debugLogPath)
      resolvedDebugLog = {
        filePath: debugLogPath,
        debugMode,
        debugInstance,
      }
    } catch (err) {
      consoleLogger.error({ err, filePath: debugLogPath }, 'Debug log file disabled')
    }
  }

  const nextLogger = pino(createPinoOptions(), pino.multistream(streams))
  if (resolvedDebugLog && nextLogger.isLevelEnabled('info')) {
    try {
      writeDebugLogPathMarkerSync(resolvedDebugLog)
    } catch (err) {
      consoleDiagnosticLogger.warn({ err, filePath: resolvedDebugLog.filePath }, 'Debug log marker write failed')
    }
  }
  return nextLogger
}

export const logger = createLogger()

const sessionLifecycleLogPath = resolveSessionLifecycleLogPath()
export const sessionLifecycleLogger = sessionLifecycleLogPath
  ? createSessionLifecycleLogger(sessionLifecycleLogPath)
  : logger.child({ component: 'session-lifecycle-disabled' })

// Always-on fresh-agent observability logger. Pinned at level 'info' so its
// rows stay visible in production, where the main logger sits at 'warn' with
// the Debug toggle off. In test runtimes (no resolved path) it must be truly
// silent, so the fallback is a dedicated silent pino instance rather than a
// child of the main logger.
const freshAgentObservabilityLogPath = resolveFreshAgentObservabilityLogPath()
export const freshAgentObservabilityLogger = freshAgentObservabilityLogPath
  ? createDedicatedFileLogger({
      filePath: freshAgentObservabilityLogPath,
      level: 'info',
      size: DEFAULT_FRESH_AGENT_LOG_SIZE,
      maxFiles: DEFAULT_FRESH_AGENT_LOG_MAX_FILES,
    })
  : pino(createPinoOptions({ level: 'silent' }))

export function setLogLevel(nextLevel: LevelWithSilent): void {
  logger.level = nextLevel
}
