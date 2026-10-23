// @vitest-environment node

import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../../..')
const HARNESS = path.join(__dirname, 'claude-sidecar-shutdown.mjs')
const children = new Set<ChildProcess>()

afterEach(() => {
  for (const child of children) child.kill('SIGKILL')
  children.clear()
})

// The Rust teardown (claude_spawn::graceful_then_kill) gives the sidecar 2 s
// to stop on its own before escalating. That grace period is only enough if
// the real sidecar, the real CLI and the in-flight provider request all stop
// well inside it; this pins that against the pinned SDK and CLI, both for the
// shutdown line alone and for the order a pane kill produces (the sidecar's
// stdout reader is dropped before the shutdown line is written).
describe('Claude sidecar shutdown against the pinned CLI and a local provider', () => {
  it.each([
    ['the shutdown line', 'shutdown'],
    ['its stdout reader going away before the shutdown line', 'stdout-closed'],
  ])('on %s, stops node (exit 0), the native CLI and the in-flight provider request within one second', async (_, mode) => {
    const child = spawn(process.execPath, [HARNESS, REPO_ROOT, mode], {
      cwd: REPO_ROOT,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        LANG: 'C.UTF-8',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.add(child)

    let stdout = ''
    let stderr = ''
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        reject(new Error(`Claude sidecar shutdown contract timed out; stderr=${stderr.slice(-2000)}`))
      }, 100_000)
      timer.unref()
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('exit', (code, signal) => {
        clearTimeout(timer)
        resolve({ code, signal })
      })
    })
    children.delete(child)

    expect(exit, stderr).toEqual({ code: 0, signal: null })
    const lines = stdout.trim().split('\n').filter(Boolean)
    expect(lines, stderr).toHaveLength(1)
    const receipt = JSON.parse(lines[0]!) as Record<string, any>
    expect(receipt).toMatchObject({
      verdict: 'PASS',
      mode,
      sdkVersion: '0.3.237',
      bundledCliVersion: '2.1.237',
      sidecarExit: { code: 0, signal: null },
      fixtureRemoved: true,
    })
    for (const measured of ['sidecarExitMs', 'nativeCliExitMs', 'providerRequestClosedMs']) {
      expect(receipt[measured], `${measured} in ${lines[0]}`).toBeTypeOf('number')
      expect(receipt[measured], `${measured} in ${lines[0]}`).toBeLessThanOrEqual(1000)
    }
  }, 110_000)
})
