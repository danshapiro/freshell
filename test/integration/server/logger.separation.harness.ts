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
  readOutput: () => string
}

const PARENT_LOG_ENV_KEYS = [
  'LOG_DEBUG_PATH',
  'FRESHELL_LOG_MODE',
  'FRESHELL_LOG_INSTANCE_ID',
  'FRESHELL_DEBUG_STREAM_INSTANCE',
  'FRESHELL_LOG_DIR',
] as const

const PARENT_TEST_ENV_KEYS = [
  'VITEST',
  'VITEST_POOL_ID',
  'VITEST_WORKER_ID',
  'PW_TEST_LOGS_DIR',
] as const

async function createLogWriter(logPath: string) {
  const directory = path.dirname(logPath)
  await fsp.mkdir(directory, { recursive: true })
  const stream = fs.createWriteStream(logPath, { flags: 'a' })
  return stream
}

export function buildServerProcessEnv(
  env: NodeJS.ProcessEnv,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...baseEnv }

  for (const key of [...PARENT_LOG_ENV_KEYS, ...PARENT_TEST_ENV_KEYS]) {
    delete childEnv[key]
  }

  delete childEnv.FRESHELL_DISABLE_WSL_PORT_FORWARD

  Object.assign(childEnv, env)

  if (env.FRESHELL_DISABLE_WSL_PORT_FORWARD === undefined) {
    childEnv.FRESHELL_DISABLE_WSL_PORT_FORWARD = '1'
  }

  return childEnv
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
  const childEnv = buildServerProcessEnv(env)

  const child = spawn(args[0], args.slice(1), {
    cwd: resolvedCwd,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams

  let combinedOutput = ''
  const appendOutput = (chunk: Buffer) => {
    combinedOutput += chunk.toString()
  }

  child.stdout?.pipe(logStream)
  child.stderr?.pipe(logStream)
  child.stdout?.on('data', appendOutput)
  child.stderr?.on('data', appendOutput)

  child.once('error', () => {
    logStream.end()
  })
  child.once('exit', () => {
    logStream.end()
  })

  return {
    process: child,
    stderrLogPath: logPath,
    stderrLogDir,
    readOutput: () => combinedOutput,
  }
}

async function readCombinedOutput(handle: LoggerServerProcess): Promise<string> {
  const fileContent = await fsp.readFile(handle.stderrLogPath, 'utf8').catch(() => '')
  return `${handle.readOutput()}\n${fileContent}`
}

export async function waitForResolvedPath(
  handle: LoggerServerProcess,
  timeoutMs = 30000,
): Promise<string> {
  await waitForLogPattern(handle, /([^\s"]+\.jsonl)|"filePath"\s*:\s*"([^"]+\.jsonl)"/, timeoutMs)

  const content = await readCombinedOutput(handle)
  const jsonMatch = content.match(/"filePath"\s*:\s*"([^"]+\.jsonl)"/)
  if (jsonMatch && jsonMatch[1]) {
    return jsonMatch[1]
  }

  const lineMatch = content.match(/([^\s"]+\.jsonl)/)
  if (lineMatch && lineMatch[1]) {
    return lineMatch[1]
  }

  throw new Error(`Resolved debug path matched, but no path could be parsed. Log: ${content}`)
}

async function waitForLogPattern(
  handle: LoggerServerProcess,
  pattern: RegExp,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastLog = ''

  while (Date.now() < deadline) {
    const content = await readCombinedOutput(handle)
    if (content) {
      lastLog = content
      if (pattern.test(content)) {
        return
      }
    }

    if (handle.process.exitCode !== null) {
      break
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 120))
  }

  throw new Error(`Timed out waiting for ${pattern}. Log: ${lastLog}`)
}

export async function waitForServerListening(
  handle: LoggerServerProcess,
  timeoutMs = 30000,
): Promise<void> {
  await waitForLogPattern(handle, /Server listening/, timeoutMs)
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
