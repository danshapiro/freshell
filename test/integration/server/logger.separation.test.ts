// @vitest-environment node
import { readFileSync } from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  startServerProcess,
  stopProcess,
  type LoggerServerProcess,
} from './logger.separation.harness.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '../../..')
const require = createRequire(import.meta.url)
let TSX_CLI: string | undefined
const DEFAULT_TEST_TIMEOUT_MS = 120_000
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-9;]*m/g
const SOURCE_LOGGER_PROBE = [
  '(async () => {',
  "  process.argv = ['node', 'server/index.ts']",
  "  await import('./server/logger.ts')",
  '  setTimeout(() => process.exit(0), 25)',
  '})()',
].join('\n')
const DIST_LOGGER_PROBE = [
  '(async () => {',
  "  process.argv = ['node', 'dist/server/index.js']",
  "  await import('./server/logger.ts')",
  '  setTimeout(() => process.exit(0), 25)',
  '})()',
].join('\n')
const LOG_LEVEL_PROBE = [
  '(async () => {',
  "  const { logger } = await import('./server/logger.ts')",
  "  logger.debug('debug-level file only')",
  "  logger.info('info-level file only')",
  "  logger.warn('warn-level file only')",
  "  logger.error('error-level console and file')",
  '  setTimeout(() => process.exit(0), 50)',
  '})()',
].join('\n')

const activeProcesses: LoggerServerProcess[] = []
const activeLogDirs: string[] = []

function getTSXCLI(): string {
  if (!TSX_CLI) {
    TSX_CLI = require.resolve('tsx/cli')
  }
  return TSX_CLI
}

function parseStartupLogPayload(startupLog: string) {
  const lines = startupLog
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  for (const line of lines) {
    const noAnsi = line.replace(ANSI_ESCAPE_PATTERN, '')
    try {
      const parsed = JSON.parse(noAnsi)
      if (parsed.msg === 'Resolved debug log path') return parsed
    } catch {
      continue
    }
  }

  const fallbackLine = lines.find((line) => line.includes('Resolved debug log path'))
  if (!fallbackLine) return null

  return {
    debugMode: fallbackLine.match(/debugMode[:=]\s*"?([a-zA-Z-]+)"?/)?.[1],
    debugInstance: fallbackLine.match(/debugInstance[:=]\s*"?([^,"\s]+)"?/)?.[1],
  }
}

beforeAll(() => {
  TSX_CLI = undefined
})

async function withLogDir<T>(fn: (logDir: string) => Promise<T>): Promise<T> {
  const logDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-issue-134-'))
  activeLogDirs.push(logDir)

  return await fn(logDir)
}

async function cleanupLogDirs() {
  await Promise.all(
    activeLogDirs.map((logDir) => fsp.rm(logDir, { recursive: true, force: true }).catch(() => {})),
  )
  activeLogDirs.length = 0
}

afterEach(async () => {
  await Promise.all(
    activeProcesses.map(async ({ process, stderrLogDir }) => {
      await stopProcess(process)
      await fsp.rm(stderrLogDir, { recursive: true, force: true }).catch(() => {})
    }),
  )
  await cleanupLogDirs()
  activeProcesses.length = 0
})

beforeEach(() => {
  activeProcesses.length = 0
  activeLogDirs.length = 0
})

async function startSourceLoggerProcess(env: NodeJS.ProcessEnv) {
  return await startServerProcess(
    [process.execPath, getTSXCLI(), '-e', SOURCE_LOGGER_PROBE],
    env,
    REPO_ROOT,
  )
}

async function startDistLoggerProcess(env: NodeJS.ProcessEnv) {
  return await startServerProcess(
    [process.execPath, getTSXCLI(), '-e', DIST_LOGGER_PROBE],
    env,
    REPO_ROOT,
  )
}

async function waitForFileContent(filePath: string, pattern: RegExp, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let lastContent = ''

  while (Date.now() < deadline) {
    const content = await fsp.readFile(filePath, 'utf8').catch(() => '')
    if (content) {
      lastContent = content
      if (pattern.test(content)) return content
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 120))
  }

  throw new Error(`Timed out waiting for ${pattern} in ${filePath}. Log: ${lastContent}`)
}

describe('debug log separation', () => {
  it(
    'keeps stdout and stderr error-only while preserving debug file verbosity',
    { timeout: DEFAULT_TEST_TIMEOUT_MS },
    async () => {
      await withLogDir(async (logDir) => {
        const debugLogPath = path.join(logDir, 'server-debug.jsonl')
        const proc = await startServerProcess(
          [process.execPath, getTSXCLI(), '-e', LOG_LEVEL_PROBE],
          {
            LOG_DEBUG_PATH: debugLogPath,
            NODE_ENV: 'production',
          },
          REPO_ROOT,
        )
        activeProcesses.push(proc)

        const fileContent = await waitForFileContent(debugLogPath, /error-level console and file/)
        const processOutput = readFileSync(proc.stderrLogPath, 'utf8')

        expect(processOutput).toContain('error-level console and file')
        expect(processOutput).not.toContain('Resolved debug log path')
        expect(processOutput).not.toContain('debug-level file only')
        expect(processOutput).not.toContain('info-level file only')
        expect(processOutput).not.toContain('warn-level file only')

        expect(fileContent).toContain('debug-level file only')
        expect(fileContent).toContain('info-level file only')
        expect(fileContent).toContain('warn-level file only')
        expect(fileContent).toContain('error-level console and file')
      })
    },
  )

  it(
    'dist and source launches choose different mode-specific filenames',
    { timeout: DEFAULT_TEST_TIMEOUT_MS },
    async () => {
      await withLogDir(async (logDir) => {
        const devProc = await startSourceLoggerProcess(
          {
            FRESHELL_LOG_DIR: logDir,
            FRESHELL_LOG_INSTANCE_ID: 'source-mode',
            NODE_ENV: 'production',
          },
        )
        const distProc = await startDistLoggerProcess(
          {
            FRESHELL_DEBUG_STREAM_INSTANCE: 'dist-mode',
            FRESHELL_LOG_DIR: logDir,
            NODE_ENV: 'production',
          },
        )
        activeProcesses.push(devProc, distProc)

        const devPath = path.join(logDir, 'server-debug.development.source-mode.jsonl')
        const distPath = path.join(logDir, 'server-debug.production.dist-mode.jsonl')
        await waitForFileContent(devPath, /Resolved debug log path/)
        await waitForFileContent(distPath, /Resolved debug log path/)

        expect(devPath).toContain('server-debug.development.source-mode.jsonl')
        expect(distPath).toContain('server-debug.production.dist-mode.jsonl')
        expect(devPath).not.toBe(distPath)
      })
    },
  )

  it(
    'concurrent launches with the same mode keep separate files',
    { timeout: DEFAULT_TEST_TIMEOUT_MS },
    async () => {
      await withLogDir(async (logDir) => {
        const processA = await startSourceLoggerProcess(
          {
            FRESHELL_LOG_DIR: logDir,
            FRESHELL_LOG_INSTANCE_ID: 'concurrent-a',
            NODE_ENV: 'development',
          },
        )
        const processB = await startSourceLoggerProcess(
          {
            FRESHELL_LOG_DIR: logDir,
            FRESHELL_LOG_INSTANCE_ID: 'concurrent-b',
            NODE_ENV: 'development',
          },
        )
        activeProcesses.push(processA, processB)

        const pathA = path.join(logDir, 'server-debug.development.concurrent-a.jsonl')
        const pathB = path.join(logDir, 'server-debug.development.concurrent-b.jsonl')
        await waitForFileContent(pathA, /Resolved debug log path/)
        await waitForFileContent(pathB, /Resolved debug log path/)

        expect(pathA).toContain('server-debug.development.concurrent-a.jsonl')
        expect(pathB).toContain('server-debug.development.concurrent-b.jsonl')
        expect(pathA).not.toBe(pathB)
      })
    },
  )

  it(
    'explicit instance settings are respected across launch modes',
    { timeout: DEFAULT_TEST_TIMEOUT_MS },
    async () => {
      await withLogDir(async (logDir) => {
        const procA = await startSourceLoggerProcess(
          {
            FRESHELL_LOG_DIR: logDir,
            FRESHELL_LOG_INSTANCE_ID: 'alpha',
            NODE_ENV: 'production',
          },
        )
        const procB = await startDistLoggerProcess(
          {
            FRESHELL_LOG_DIR: logDir,
            FRESHELL_DEBUG_STREAM_INSTANCE: 'ci-run-beta',
            NODE_ENV: 'production',
          },
        )
        activeProcesses.push(procA, procB)

        const pathA = path.join(logDir, 'server-debug.development.alpha.jsonl')
        const pathB = path.join(logDir, 'server-debug.production.ci-run-beta.jsonl')
        await waitForFileContent(pathA, /Resolved debug log path/)
        await waitForFileContent(pathB, /Resolved debug log path/)
        expect(pathA).toContain('server-debug.development.alpha.jsonl')
        expect(pathB).toContain('server-debug.production.ci-run-beta.jsonl')
      })
    },
  )

  it(
    'startup logs include resolved debug destination details',
    { timeout: DEFAULT_TEST_TIMEOUT_MS },
    async () => {
      await withLogDir(async (logDir) => {
        const proc = await startSourceLoggerProcess(
          {
            FRESHELL_LOG_DIR: logDir,
            FRESHELL_LOG_MODE: 'production',
            FRESHELL_LOG_INSTANCE_ID: 'ci-run-1',
            NODE_ENV: 'production',
          },
        )
        activeProcesses.push(proc)

        const resolvedPath = path.join(logDir, 'server-debug.production.ci-run-1.jsonl')
        await waitForFileContent(resolvedPath, /Resolved debug log path/)
        expect(resolvedPath).toContain('server-debug.production.ci-run-1.jsonl')

        const startupLog = readFileSync(resolvedPath, 'utf8')
        const startupPayload = parseStartupLogPayload(startupLog)
        expect(startupPayload).not.toBeNull()
        expect(startupPayload).toMatchObject({
          debugMode: 'production',
          debugInstance: 'ci-run-1',
        })
      })
    },
  )
})
