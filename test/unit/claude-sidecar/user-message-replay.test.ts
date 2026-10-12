// @vitest-environment node

import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../../..')
const SIDECAR = path.join(REPO_ROOT, 'crates/freshell-claude-sidecar/index.mjs')
const FAKE_SDK = path.join(__dirname, 'fixtures/fake-checkpoint-sdk.mjs')
const children = new Set<ChildProcess>()

afterEach(() => {
  for (const child of children) child.kill('SIGKILL')
  children.clear()
})

interface SidecarFrame {
  type?: string
  sessionId?: string
  event?: Record<string, unknown>
  [key: string]: unknown
}

function launchSidecar(mode: 'match' | 'mismatch' | 'absent' | 'ordinary') {
  const child = spawn(process.execPath, [SIDECAR], {
    env: {
      ...process.env,
      FRESHELL_CLAUDE_SDK_QUERY_MODULE: FAKE_SDK,
      FRESHELL_FAKE_CHECKPOINT_REPLAY: mode,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.add(child)
  const frames: SidecarFrame[] = []
  const waiters: Array<{ predicate: (frame: SidecarFrame) => boolean; resolve: (frame: SidecarFrame) => void }> = []
  const lines = createInterface({ input: child.stdout! })
  lines.on('line', (line) => {
    let frame: SidecarFrame
    try { frame = JSON.parse(line) as SidecarFrame } catch { return }
    frames.push(frame)
    for (let index = waiters.length - 1; index >= 0; index--) {
      const waiter = waiters[index]!
      if (waiter.predicate(frame)) {
        waiters.splice(index, 1)
        waiter.resolve(frame)
      }
    }
  })
  const waitFor = (predicate: (frame: SidecarFrame) => boolean) => {
    const existing = frames.find(predicate)
    if (existing) return Promise.resolve(existing)
    return new Promise<SidecarFrame>((resolve, reject) => {
      waiters.push({ predicate, resolve })
      const timer = setTimeout(() => {
        const index = waiters.findIndex((waiter) => waiter.resolve === resolve)
        if (index >= 0) waiters.splice(index, 1)
        reject(new Error(`timed out waiting for sidecar frame; saw ${JSON.stringify(frames)}`))
      }, 4000)
      timer.unref()
    })
  }
  return { child, frames, waitFor }
}

describe('Claude checkpoint identity at the SDK replay boundary', () => {
  it.each([
    { mode: 'match' as const, shouldBind: true },
    { mode: 'mismatch' as const, shouldBind: false },
    { mode: 'absent' as const, shouldBind: false },
    { mode: 'ordinary' as const, shouldBind: false },
  ])('$mode replay binds only its own correlated user row', async ({ mode, shouldBind }) => {
    const { child, frames, waitFor } = launchSidecar(mode)
    try {
      child.stdin!.write(JSON.stringify({ type: 'create', requestId: 'create-1', cwd: '/tmp' }) + '\n')
      const created = await waitFor((frame) => frame.type === 'created')
      const sessionId = String(created.sessionId)
      const checkpointAttempt = {
        uuid: 'b3eaf0e1-c8fe-4fb3-8802-b3ce52ca0b16',
        requestId: 'send-1',
        logicalAttemptId: 'attempt-1',
      }
      child.stdin!.write(JSON.stringify({
        type: 'send', sessionId, text: 'same prompt', checkpointAttempt,
      }) + '\n')
      await waitFor((frame) => frame.type === 'sdk.result')

      const receipts = frames.filter((frame) => frame.type === 'sdk.checkpointTurnIdentity')
      if (shouldBind) {
        expect(receipts).toHaveLength(1)
        expect(receipts[0]).toMatchObject({
          logicalAttemptId: 'attempt-1',
          requestId: 'send-1',
          sessionId,
          nativeTurnId: checkpointAttempt.uuid,
          displayTurnId: checkpointAttempt.uuid,
        })
        expect(receipts[0]).not.toHaveProperty('text')
      } else {
        expect(receipts).toHaveLength(0)
      }
      expect(frames.some((frame) => frame.type === 'sdk.assistant')).toBe(true)
    } finally {
      child.stdin!.write(JSON.stringify({ type: 'shutdown' }) + '\n')
      await new Promise<void>((resolve) => child.once('close', () => resolve()))
      children.delete(child)
    }
  })
})
