import { vi } from 'vitest'
import { Session } from '../integration/providers/claude-cli-scenarios.mjs'

/** The real capture session consuming a controlled SDK iterator; no provider process. */
export function createClaudeCapture() {
  const queue: any[] = []
  let wake: (() => void) | undefined
  let ended = false
  const query = {
    async *[Symbol.asyncIterator]() {
      while (!ended || queue.length) {
        if (queue.length) yield queue.shift()
        else await new Promise<void>(resolve => { wake = resolve })
      }
    },
    close: vi.fn(() => { ended = true; wake?.() }),
  }
  const events: any[] = []
  const session = new Session({
    query: () => query,
    fixture: { cwd: '/fixture/workspace', env: () => ({}) },
    provider: { url: 'http://127.0.0.1/fixture' },
    trace: { add: (event: unknown) => events.push(event) },
    uuid: (label: string) => label,
  }, 'S')
  const deliver = async (...messages: any[]) => {
    for (const message of messages) {
      queue.push(message)
      wake?.()
      await session.waitFor((candidate: unknown) => candidate === message)
    }
  }
  return { session, query, events, deliver }
}
