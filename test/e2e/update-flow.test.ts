// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { spawn } from 'child_process'
import { createRequire } from 'module'
import net from 'net'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '../..')
const PRECHECK_SCRIPT = path.resolve(REPO_ROOT, 'scripts/precheck.ts')
const require = createRequire(import.meta.url)
const TSX_CLI = require.resolve('tsx/cli')
const PROCESS_TIMEOUT_MS = 30_000

type PrecheckResult = {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address !== 'object' || !address) {
        server.close(() => reject(new Error('Failed to allocate a free port')))
        return
      }

      const { port } = address
      server.close((err) => {
        if (err) {
          reject(err)
          return
        }
        resolve(port)
      })
    })
  })
}

async function runPrecheck(
  args: string[] = [],
  env: NodeJS.ProcessEnv = {},
): Promise<PrecheckResult> {
  const [serverPort, vitePort] = await Promise.all([getFreePort(), getFreePort()])

  return await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [TSX_CLI, PRECHECK_SCRIPT, ...args],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          PORT: String(serverPort),
          VITE_PORT: String(vitePort),
          npm_lifecycle_event: 'preserve',
          ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )

    let stdout = ''
    let stderr = ''

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString()
    })

    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`precheck timed out after ${PROCESS_TIMEOUT_MS}ms`))
    }, PROCESS_TIMEOUT_MS)

    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })

    child.once('close', (code, signal) => {
      clearTimeout(timeout)
      resolve({ code, signal, stdout, stderr })
    })
  })
}

describe('update flow precheck', () => {
  it('skips update checking when --skip-update-check is provided', async () => {
    const result = await runPrecheck(['--skip-update-check'])

    expect(result.signal).toBeNull()
    expect(result.code).toBe(0)
    expect(result.stdout).not.toContain('new Freshell')
    expect(result.stdout).not.toContain('Update complete!')
    expect(result.stderr).toBe('')
  })

  it('skips update checking when SKIP_UPDATE_CHECK=true', async () => {
    const result = await runPrecheck([], { SKIP_UPDATE_CHECK: 'true' })

    expect(result.signal).toBeNull()
    expect(result.code).toBe(0)
    expect(result.stdout).not.toContain('new Freshell')
    expect(result.stdout).not.toContain('Update complete!')
    expect(result.stderr).toBe('')
  })

  it('skips update checking during the predev lifecycle while still succeeding the preflight', async () => {
    const result = await runPrecheck([], { npm_lifecycle_event: 'predev' })

    expect(result.signal).toBeNull()
    expect(result.code).toBe(0)
    expect(result.stdout).not.toContain('new Freshell')
    expect(result.stdout).not.toContain('Update complete!')
    expect(result.stderr).toBe('')
  })
})
