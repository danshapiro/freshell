// @vitest-environment node
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { SCENARIOS } from '../../integration/providers/claude-cli-scenarios.mjs'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

it('captures each MCP turn through its terminal idle before closing either SDK query', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-scenario-drain-'))
  await fs.writeFile(path.join(root, 'mcp-probe-report.json'), '{}')
  const sessions = [makeSession(), makeSession()]
  let opened = 0
  const capturing = SCENARIOS.mcp({
    fixture: { root },
    open: () => sessions[opened++],
    observe: () => {},
    need(value: unknown, what: string) {
      if (!value) throw new Error(`scenario prerequisite missing: ${what}`)
      return value
    },
  })
  try {
    for (const session of sessions) {
      // The result is already available; only the native drain is withheld.
      expect(await session.boundary.promise).toBe('await-idle')
      expect(session.closed).toBe(false)
      session.releaseIdle()
      await session.didClose.promise
      expect(session.capturedAtClose).toEqual(['result', 'completed', 'idle'])
    }
    await capturing
  } finally {
    for (const session of sessions) session.releaseIdle()
    await capturing.finally(() => fs.rm(root, { recursive: true, force: true }))
  }
})

function makeSession() {
  const boundary = deferred<string>()
  const idle = deferred<void>()
  const didClose = deferred<void>()
  const frames: any[] = [{ type: 'result' }]
  return {
    boundary,
    didClose,
    closed: false,
    capturedAtClose: [] as string[],
    push() {},
    messages(predicate: (message: any) => boolean) { return frames.filter(predicate) },
    async waitForResults() { return frames[0] },
    async waitForCount(predicate: (message: any) => boolean, count: number) {
      boundary.resolve('await-idle')
      await idle.promise
      const matches = frames.filter(predicate)
      return matches.length >= count ? matches.at(-1) : null
    },
    releaseIdle() {
      if (frames.length === 1) frames.push(
        { type: 'command_lifecycle', state: 'completed' },
        { type: 'system', subtype: 'session_state_changed', state: 'idle' },
      )
      idle.resolve()
    },
    async close() {
      this.closed = true
      this.capturedAtClose = frames.map(message => message.state ?? message.type)
      boundary.resolve('closed-before-idle')
      didClose.resolve()
    },
  }
}
