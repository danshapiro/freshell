// @vitest-environment node
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { SCENARIOS } from '../../integration/providers/claude-cli-scenarios.mjs'
import { createClaudeCapture } from '../../helpers/claude-session-capture.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

it('captures each MCP turn through its terminal idle before closing either SDK query', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-scenario-drain-'))
  await fs.writeFile(path.join(root, 'mcp-probe-report.json'), '{}')
  const sessions = [makeSession(), makeSession()]
  for (const session of sessions) await session.deliver({
    type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed',
  })
  let opened = 0
  const capturing = SCENARIOS.mcp({
    fixture: { root },
    open: () => sessions[opened++].session,
    observe: () => {},
    need(value: unknown, what: string) {
      if (!value) throw new Error(`scenario prerequisite missing: ${what}`)
      return value
    },
  })
  try {
    for (const session of sessions) {
      // The result is already available; only the native drain is withheld.
      await session.boundary.promise
      expect(session.query.close).not.toHaveBeenCalled()
      await session.releaseIdle()
      await session.didClose.promise
      expect(session.capturedAtClose).toEqual(['result', 'completed', 'idle'])
    }
    await capturing
  } finally {
    for (const session of sessions) await session.releaseIdle()
    await capturing.finally(() => fs.rm(root, { recursive: true, force: true }))
  }
})

function makeSession() {
  const capture = createClaudeCapture()
  const boundary = deferred<void>()
  const didClose = deferred<void>()
  const originalClose = capture.session.close.bind(capture.session)
  const observed = {
    ...capture,
    boundary,
    didClose,
    capturedAtClose: [] as string[],
    async releaseIdle() {
      if (capture.session.frames.length !== 1) return
      await capture.deliver(
        { type: 'command_lifecycle', state: 'completed' },
        { type: 'system', subtype: 'session_state_changed', state: 'idle' },
      )
    },
  }
  capture.session.close = async () => {
    const closing = originalClose()
    boundary.resolve()
    await closing
    observed.capturedAtClose = capture.events.filter(event => event.k === 'msg').map(event => event.m.state ?? event.m.type)
    didClose.resolve()
  }
  return observed
}
