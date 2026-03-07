// @vitest-environment node
import { readFileSync } from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  listCandidateFiles,
  startServerProcess,
  stopProcess,
  waitForResolvedPath,
  type LoggerServerProcess,
} from './logger.separation.harness.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '../../..')
const DIST_SERVER_ENTRY = path.join(REPO_ROOT, 'dist', 'server', 'index.js')
const require = createRequire(import.meta.url)
let TSX_CLI: string | undefined
const HAS_TSX_CLI = (() => {
  try {
    require.resolve('tsx/cli')
    return true
  } catch {
    return false
  }
})()
const DEFAULT_TEST_TIMEOUT_MS = 45_000
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-9;]*m/g

const activeProcesses: LoggerServerProcess[] = []
const activeLogDirs: string[] = []
let initialized = false
let distBuildPromise: Promise<void> | null = null

function getTSXCLI(): string {
  if (!TSX_CLI) {
    throw new Error('tsx CLI was not resolved')
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

async function ensureDistBuilt() {
  if (distBuildPromise) return distBuildPromise

  distBuildPromise = new Promise<void>((resolve, reject) => {
    const tscPath = require.resolve('typescript/bin/tsc')
    const build = spawn(process.execPath, [tscPath, '-p', 'tsconfig.server.json'], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let errorOutput = ''
    build.stderr?.on('data', (chunk: Buffer) => {
      errorOutput += chunk.toString()
    })
    build.once('exit', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`tsc server build failed with code ${code}: ${errorOutput}`))
      }
    })
    build.once('error', (err) => reject(err as Error))
  })

  return distBuildPromise
}

async function initializeEnvironment() {
  if (initialized) return
  try {
    TSX_CLI = require.resolve('tsx/cli')
  } catch {
    TSX_CLI = undefined
  }
  await ensureDistBuilt()
  initialized = true
}

beforeAll(() => {
  initialized = false
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

describe('debug log separation', () => {
  it.skipIf(!HAS_TSX_CLI)(
    'dist and source launches choose different default filenames',
    { timeout: DEFAULT_TEST_TIMEOUT_MS },
    async () => {
      await initializeEnvironment()

      await withLogDir(async (logDir) => {
        const tsxCli = getTSXCLI()
        const devProc = await startServerProcess(
          [process.execPath, tsxCli, 'watch', 'server/index.ts'],
          {
            AUTH_TOKEN: 'integration-token-1x16chars',
            FRESHELL_LOG_DIR: logDir,
            NODE_ENV: 'production',
            PORT: '3411',
            VITE_PORT: '4173',
          },
          REPO_ROOT,
        )
        const distProc = await startServerProcess(
          ['node', DIST_SERVER_ENTRY],
          {
            AUTH_TOKEN: 'integration-token-2x16chars',
            FRESHELL_LOG_DIR: logDir,
            NODE_ENV: 'production',
            PORT: '3412',
            VITE_PORT: '4174',
          },
          REPO_ROOT,
        )
        activeProcesses.push(devProc, distProc)

        const devPath = await waitForResolvedPath(devProc)
        const distPath = await waitForResolvedPath(distProc)

        expect(devPath).toContain('server-debug.development.3411.jsonl')
        expect(distPath).toContain('server-debug.production.3412.jsonl')
        expect(devPath).not.toBe(distPath)

        const devCandidates = await listCandidateFiles(logDir, 'development', '3411')
        const distCandidates = await listCandidateFiles(logDir, 'production', '3412')

        expect(devCandidates).toHaveLength(1)
        expect(distCandidates).toHaveLength(1)
      })
    },
  )

  it.skipIf(!HAS_TSX_CLI)(
    'concurrent default launches with same mode do not reuse a single file',
    { timeout: DEFAULT_TEST_TIMEOUT_MS },
    async () => {
      await initializeEnvironment()

      await withLogDir(async (logDir) => {
        const tsxCli = getTSXCLI()
        const processA = await startServerProcess(
          [process.execPath, tsxCli, 'watch', 'server/index.ts'],
          {
            AUTH_TOKEN: 'integration-token-3x16chars',
            FRESHELL_LOG_DIR: logDir,
            NODE_ENV: 'development',
            PORT: '3413',
          },
          REPO_ROOT,
        )
        const processB = await startServerProcess(
          [process.execPath, tsxCli, 'watch', 'server/index.ts'],
          {
            AUTH_TOKEN: 'integration-token-4x16chars',
            FRESHELL_LOG_DIR: logDir,
            NODE_ENV: 'development',
            PORT: '3414',
          },
          REPO_ROOT,
        )
        activeProcesses.push(processA, processB)

        const pathA = await waitForResolvedPath(processA)
        const pathB = await waitForResolvedPath(processB)

        expect(pathA).toContain('server-debug.development.3413.jsonl')
        expect(pathB).toContain('server-debug.development.3414.jsonl')
        expect(pathA).not.toBe(pathB)
      })
    },
  )

  it.skipIf(!HAS_TSX_CLI)(
    'explicit instance settings are respected across launch modes',
    { timeout: DEFAULT_TEST_TIMEOUT_MS },
    async () => {
      await initializeEnvironment()

      await withLogDir(async (logDir) => {
        const tsxCli = getTSXCLI()
        const procA = await startServerProcess(
          [process.execPath, tsxCli, 'watch', 'server/index.ts'],
          {
            AUTH_TOKEN: 'integration-token-5x16chars',
            FRESHELL_LOG_DIR: logDir,
            FRESHELL_LOG_INSTANCE_ID: 'alpha',
            NODE_ENV: 'production',
            PORT: '3415',
          },
          REPO_ROOT,
        )
        const procB = await startServerProcess(
          ['node', DIST_SERVER_ENTRY],
          {
            AUTH_TOKEN: 'integration-token-6x16chars',
            FRESHELL_LOG_DIR: logDir,
            FRESHELL_DEBUG_STREAM_INSTANCE: 'ci-run-beta',
            NODE_ENV: 'production',
            PORT: '3416',
          },
          REPO_ROOT,
        )
        activeProcesses.push(procA, procB)

        const pathA = await waitForResolvedPath(procA)
        const pathB = await waitForResolvedPath(procB)
        expect(pathA).toContain('server-debug.development.alpha.jsonl')
        expect(pathB).toContain('server-debug.production.ci-run-beta.jsonl')

        const alphaCandidates = await listCandidateFiles(logDir, 'development', 'alpha')
        const betaCandidates = await listCandidateFiles(logDir, 'production', 'ci-run-beta')
        expect(alphaCandidates).toHaveLength(1)
        expect(betaCandidates).toHaveLength(1)
      })
    },
  )

  it.skipIf(!HAS_TSX_CLI)(
    'startup logs include resolved debug destination details',
    { timeout: DEFAULT_TEST_TIMEOUT_MS },
    async () => {
      await initializeEnvironment()

      await withLogDir(async (logDir) => {
        const tsxCli = getTSXCLI()
        const proc = await startServerProcess(
          [process.execPath, tsxCli, 'watch', 'server/index.ts'],
          {
            AUTH_TOKEN: 'integration-token-7x16chars',
            FRESHELL_LOG_DIR: logDir,
            FRESHELL_LOG_MODE: 'production',
            FRESHELL_LOG_INSTANCE_ID: 'ci-run-1',
            NODE_ENV: 'production',
            PORT: '3420',
          },
          REPO_ROOT,
        )
        activeProcesses.push(proc)

        const resolvedPath = await waitForResolvedPath(proc)
        expect(resolvedPath).toContain('server-debug.production.ci-run-1.jsonl')

        const startupLog = readFileSync(proc.stderrLogPath, 'utf8')
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
