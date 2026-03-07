import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import os from 'node:os'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

export type LoggerServerProcess = {
  process: ChildProcessWithoutNullStreams
  stderrLogPath: string
  stderrLogDir: string
}

async function createLogWriter(logPath: string) {
  const directory = path.dirname(logPath)
  await fsp.mkdir(directory, { recursive: true })
  const stream = fs.createWriteStream(logPath, { flags: 'a' })
  return stream
}

export async function startServerProcess(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<LoggerServerProcess> {
  const resolvedCwd = path.resolve(cwd)
  const stderrLogDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-logger-'))
  const logPath = path.join(
    stderrLogDir,
    `server.log`,
  )
  const logStream = await createLogWriter(logPath)
  const childEnv: NodeJS.ProcessEnv = { ...process.env }
  for (const key of [
    'LOG_DEBUG_PATH',
    'FRESHELL_LOG_MODE',
    'FRESHELL_LOG_INSTANCE_ID',
    'FRESHELL_DEBUG_STREAM_INSTANCE',
    'FRESHELL_LOG_DIR',
  ]) {
    delete childEnv[key]
  }
  Object.assign(childEnv, env)
  delete childEnv.VITEST
  delete childEnv.VITEST_POOL_ID
  delete childEnv.VITEST_WORKER_ID
  delete childEnv.PW_TEST_LOGS_DIR

  const child = spawn(args[0], args.slice(1), {
    cwd: resolvedCwd,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams

  child.stdout?.pipe(logStream)
  child.stderr?.pipe(logStream)

  child.once('error', () => {
    logStream.end()
  })
  child.once('exit', () => {
    logStream.end()
  })

  return { process: child, stderrLogPath: logPath, stderrLogDir }
}

export async function waitForResolvedPath(
  handle: LoggerServerProcess,
  timeoutMs = 5000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let lastLog = ''
  let lastMatch: string | null = null

  while (Date.now() < deadline) {
    const content = await fsp.readFile(handle.stderrLogPath, 'utf8').catch(() => '')
    if (content) {
      lastLog = content
      const jsonMatch = content.match(/"filePath"\s*:\s*"([^"]+\.jsonl)"/)
      if (jsonMatch && jsonMatch[1]) {
        lastMatch = jsonMatch[1]
      } else {
        const lineMatch = content.match(/([^\s"]+\.jsonl)/)
        if (lineMatch) {
          lastMatch = lineMatch[1]
        }
      }

      if (lastMatch) {
        return lastMatch
      }
    }

    if (handle.process.exitCode !== null) {
      break
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 120))
  }

  const finalLog = lastLog
  throw new Error(`Timed out waiting for resolved debug path. Log: ${finalLog}`)
}

export async function stopProcess(proc: ChildProcessWithoutNullStreams): Promise<void> {
  if (proc.exitCode !== null || proc.killed) return

  proc.kill('SIGINT')

  try {
    await Promise.race([
      once(proc, 'exit'),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('SIGINT timeout')), 3000)),
    ])
  } catch (err) {
    if ((err as Error).message === 'SIGINT timeout' && proc.exitCode === null) {
      proc.kill('SIGKILL')
      await once(proc, 'exit').catch(() => {})
    } else {
      throw err
    }
  }
}

export async function listCandidateFiles(
  logDir: string,
  mode: string,
  instance: string,
  timeoutMs = 4000,
  pollMs = 120,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs
  const escapedMode = mode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const escapedInstance = instance.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const candidatePattern = new RegExp(
    `^server-debug\\.${escapedMode}\\.${escapedInstance}.*\\.jsonl(?:\\.\\d+)?$`,
  )

  while (Date.now() < deadline) {
    const entries = await fsp.readdir(logDir, { withFileTypes: true })
    const files = entries
      .filter((entry) => entry.isFile() && candidatePattern.test(entry.name))
      .map((entry) => path.join(logDir, entry.name))
    if (files.length > 0) {
      return files
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs))
  }

  return []
}
