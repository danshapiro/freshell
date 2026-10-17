import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(directory, '../../..')
const sidecar = path.join(repoRoot, 'crates', 'freshell-claude-sidecar', 'index.mjs')
const sdkFixture = path.join(directory, 'fixtures', 'ordinary-turn-outcome-query-module.mjs')

type Frame = Record<string, unknown>
const children = new Set<ChildProcess>()

afterEach(() => {
  for (const child of children) child.kill('SIGKILL')
  children.clear()
})

function startSidecar() {
  const child = spawn(process.execPath, [sidecar], {
    env: { ...process.env, FRESHELL_CLAUDE_SDK_QUERY_MODULE: sdkFixture },
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  children.add(child)
  const frames: Frame[] = []
  let buffer = ''
  child.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      try {
        frames.push(JSON.parse(line) as Frame)
      } catch {
        // Ignore non-protocol lines. Tests assert only bounded metadata.
      }
    }
  })
  return {
    child,
    frames,
    send(frame: Record<string, unknown>) {
      child.stdin!.write(`${JSON.stringify(frame)}\n`)
    },
    async waitFor(predicate: (frame: Frame) => boolean, label: string) {
      const start = Date.now()
      while (Date.now() - start < 5_000) {
        const frame = frames.find(predicate)
        if (frame) return frame
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      const types = frames.map((frame) => frame.type).join(', ')
      throw new Error(`timed out waiting for ${label}; observed frame types: ${types}`)
    },
  }
}

async function createSession(h: ReturnType<typeof startSidecar>) {
  h.send({ type: 'create', requestId: 'ordinary-turn' })
  const created = await h.waitFor((frame) => frame.type === 'created', 'created')
  return String(created.sessionId)
}

describe('Claude sidecar ordinary-turn outcome', () => {
  it.each([
    ['__test_success__', 'completed'],
    ['__test_failed_result__', 'failed'],
    ['__test_pending_eof__', 'failed'],
  ])('classifies a synthetic SDK end (%s) as %s without provider text', async (marker, outcome) => {
    const h = startSidecar()
    const sessionId = await createSession(h)
    h.send({ type: 'send', sessionId, text: marker })

    const complete = await h.waitFor(
      (frame) => frame.type === 'sdk.turn.complete' && frame.sessionId === sessionId,
      'turn complete',
    )
    expect(complete).toMatchObject({ sessionId, outcome })
    expect(Object.keys(complete).sort()).toEqual(['at', 'outcome', 'sessionId', 'type'])
    expect(JSON.stringify(complete)).not.toContain('synthetic provider failure detail')
  })
})
