// @vitest-environment node

import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../../..')
const HARNESS = path.join(__dirname, 'claude-checkpoint-uuid-replay.mjs')
const children = new Set<ChildProcess>()

afterEach(() => {
  for (const child of children) child.kill('SIGKILL')
  children.clear()
})

describe('Claude checkpoint UUID replay against the pinned local provider', () => {
  it('replays and persists the UUID attached to the exact user prompt', async () => {
    const child = spawn(process.execPath, [HARNESS, REPO_ROOT], {
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
        reject(new Error(`Claude local-provider contract timed out; stderr=${stderr.slice(-2000)}`))
      }, 75_000)
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
    const receipt = JSON.parse(lines[0]!) as Record<string, unknown>
    expect(receipt).toMatchObject({
      verdict: 'PASS',
      sdkVersion: '0.3.237',
      bundledCliVersion: '2.1.237',
      replayFlagObservedByNativeCli: true,
      replayedUserUuid: expect.any(String),
      persistedUserUuid: expect.any(String),
      resultSubtype: 'success',
      fixtureRemoved: true,
      localProviderClosed: true,
      nativeCliExited: true,
    })
    expect(receipt.replayedUserUuid).toBe(receipt.persistedUserUuid)
  }, 80_000)
})
