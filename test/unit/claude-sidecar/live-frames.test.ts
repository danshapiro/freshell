// @vitest-environment node
//
// The frames a live turn sends the server, through the production index.mjs
// over the CLI simulator (harness.ts): transcript announcements whose uuids
// land in the transcript the (simulated) CLI writes, assistant frames that
// carry their ids, and what the compaction and permission-mode status frames
// become. The mapping itself is pinned on the pinned CLI's recorded sequences
// in sdk-content-frames.test.ts; test/integration/providers/
// claude-live-frames.test.ts runs the same sidecar over the real pinned CLI.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { startRealSidecar, type RealSidecar, type SidecarFrame } from './harness'

/** The uuids of the lines the simulated CLI has written for its session so far. */
function transcriptUuids(sidecar: RealSidecar, cliSessionId: string): Set<string> {
  const projects = path.join(sidecar.claudeConfigDir, 'projects')
  const uuids = new Set<string>()
  for (const dir of fs.existsSync(projects) ? fs.readdirSync(projects) : []) {
    const file = path.join(projects, dir, `${cliSessionId}.jsonl`)
    if (!fs.existsSync(file)) continue
    const text = fs.readFileSync(file, 'utf8')
    for (const line of text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean)) {
      const row = JSON.parse(line)
      if (typeof row.uuid === 'string') uuids.add(row.uuid)
    }
  }
  return uuids
}

/** The sidecar's structured log records so far (stderr, one JSON object per line). */
function logRecords(sidecar: RealSidecar): Array<Record<string, any>> {
  return sidecar.stderr().split('\n').flatMap((line) => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

const isAnnouncement = (frame: SidecarFrame) => frame.type === 'sdk.session.changed' && frame.reason === 'transcript'

describe('a live turn\'s frames', () => {
  it('announces each transcript message right after its content, and every announced uuid lands in the transcript', async () => {
    const sidecar = await startRealSidecar()
    const sessionId = await sidecar.create()
    const checkpointAttempt = { uuid: '0b8e1f4c-6a55-4f4e-9d0a-3c2b1a090807', requestId: 'send-1', logicalAttemptId: 'attempt-1' }
    sidecar.send({ type: 'send', sessionId, text: 'TOOL:sleep=0', checkpointAttempt })
    await sidecar.waitFor('sdk.result', 'the turn result')
    const { cliSessionId } = await sidecar.waitFor('sdk.session.init')

    const announcements = sidecar.frames.filter(isAnnouncement)
    // The prompt, the tool call, the tool result and the reply.
    expect(announcements.map((frame) => frame.uuid)).toContain(checkpointAttempt.uuid)
    expect(announcements.length).toBeGreaterThanOrEqual(4)
    for (const announcement of announcements) expect(announcement).toMatchObject({ sessionId, parentToolUseId: null })

    // Each sdk.assistant is followed at once by the announcement of its own uuid.
    const assistants = sidecar.frames.filter((frame) => frame.type === 'sdk.assistant')
    expect(assistants.length).toBeGreaterThanOrEqual(2)
    for (const assistant of assistants) {
      expect(assistant).toMatchObject({ uuid: expect.any(String), messageId: expect.any(String), parentToolUseId: null })
      expect(sidecar.frames[sidecar.frames.indexOf(assistant) + 1]).toMatchObject({ type: 'sdk.session.changed', reason: 'transcript', uuid: assistant.uuid })
    }
    // The prompt's replay binds the checkpoint first, then is announced.
    const identity = sidecar.frames.findIndex((frame) => frame.type === 'sdk.checkpointTurnIdentity')
    expect(identity).toBeGreaterThanOrEqual(0)
    expect(sidecar.frames[identity + 1]).toMatchObject({ type: 'sdk.session.changed', uuid: checkpointAttempt.uuid })

    // The CLI writes its transcript about 100 ms after it emits a message.
    await expect.poll(() => {
      const written = transcriptUuids(sidecar, cliSessionId)
      return announcements.filter((frame) => !written.has(frame.uuid)).map((frame) => frame.uuid)
    }, { timeout: 2_000 }).toEqual([])
  })

  it('streams text and block starts stamped with the message id of the sdk.assistant they become, and nothing a pane does not render', async () => {
    const sidecar = await startRealSidecar({ timeScale: 0.1 })
    const sessionId = await sidecar.create()
    sidecar.send({ type: 'send', sessionId, text: 'SLOW reply in chunks' })
    await sidecar.waitFor('sdk.result', 'the slow turn result')
    sidecar.send({ type: 'send', sessionId, text: 'TOOL:sleep=0' })
    await sidecar.waitFor((frame) => frame.type === 'sdk.result' && sidecar.frames.filter((f) => f.type === 'sdk.result').length === 2, 'the tool turn result')

    const streams = sidecar.frames.filter((frame) => frame.type === 'sdk.stream')
    expect(streams.length).toBeGreaterThan(0)
    for (const frame of streams) {
      expect(frame).toMatchObject({ sessionId, parentToolUseId: null, messageId: expect.any(String) })
      expect(['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop']).toContain(frame.event.type)
      if (frame.event.type === 'content_block_delta') expect(['text_delta', 'thinking_delta']).toContain(frame.event.delta.type)
    }
    // Every streamed block start names the message of the assistant block that follows it.
    for (const start of streams.filter((frame) => frame.event.type === 'content_block_start')) {
      const assistant = sidecar.frames.slice(sidecar.frames.indexOf(start)).find((frame) => frame.type === 'sdk.assistant')
      expect(assistant?.messageId).toBe(start.messageId)
    }
    // The slow reply's deltas add up to its text.
    const slowId = streams.find((frame) => frame.event.type === 'content_block_start' && frame.event.content_block.type === 'text')!.messageId
    const streamed = streams.filter((frame) => frame.messageId === slowId && frame.event.type === 'content_block_delta').map((frame) => frame.event.delta.text).join('')
    const reply = sidecar.frames.find((frame) => frame.type === 'sdk.assistant' && frame.messageId === slowId)
    expect(streamed).toBe(reply?.content[0].text)
  })
})

describe('what a compaction and a permission mode change send', () => {
  const resultsOf = (sidecar: RealSidecar) => sidecar.frames.filter((frame) => frame.type === 'sdk.result')

  it('a failed /compact: a COMPACTION_FAILED notice, then running until its result, and no error frame', async () => {
    const sidecar = await startRealSidecar({ timeScale: 0.1 })
    const sessionId = await sidecar.create()
    sidecar.send({ type: 'send', sessionId, text: '/compact APIERR:400' })
    await sidecar.waitFor('sdk.result', 'the compaction result')
    const types = sidecar.frames.map((frame) => frame.type)
    const compacting = sidecar.frames.findIndex((frame) => frame.type === 'sdk.status' && frame.status === 'compacting')
    const notice = sidecar.frames.findIndex((frame) => frame.type === 'sdk.notice')
    const running = sidecar.frames.findIndex((frame) => frame.type === 'sdk.status' && frame.status === 'running')
    expect(compacting).toBeGreaterThanOrEqual(0)
    expect(notice).toBeGreaterThan(compacting)
    expect(running).toBeGreaterThan(notice)
    expect(types.indexOf('sdk.result')).toBeGreaterThan(running)
    expect(sidecar.frames[notice]).toEqual({
      type: 'sdk.notice',
      sessionId,
      level: 'error',
      code: 'COMPACTION_FAILED',
      message: 'Error during compaction: API Error: 400 local provider error',
    })
    expect(types).not.toContain('sdk.error')
    // The failure is on the sidecar's log (stderr, its own pipe), with its reason.
    await expect.poll(() => logRecords(sidecar).find((record) => record.code === 'COMPACTION_FAILED'))
      .toMatchObject({ severity: 'error', event: 'notice', sessionId, error: 'Error during compaction: API Error: 400 local provider error' })
  })

  it('a successful /compact: running again once compacting ends, then its result, and no notice', async () => {
    const sidecar = await startRealSidecar({ timeScale: 0.1 })
    const sessionId = await sidecar.create()
    sidecar.send({ type: 'send', sessionId, text: 'something to compact' })
    await sidecar.waitFor('sdk.result')
    sidecar.send({ type: 'send', sessionId, text: '/compact' })
    await sidecar.waitFor(() => resultsOf(sidecar).length === 2, 'the compaction result')
    const statuses = sidecar.frames.filter((frame) => frame.type === 'sdk.status' || frame.type === 'sdk.result').map((frame) => frame.status ?? frame.type)
    expect(statuses).toEqual(['sdk.result', 'compacting', 'running', 'sdk.result'])
    expect(sidecar.frames.some((frame) => frame.type === 'sdk.notice')).toBe(false)
  })

  it('approving ExitPlanMode: the new mode is stated once, and configuring that mode afterwards calls nothing on the CLI', async () => {
    const sidecar = await startRealSidecar({ timeScale: 0.1 })
    const sessionId = await sidecar.create({ permissionMode: 'plan' })
    sidecar.send({ type: 'send', sessionId, text: 'PLAN:exit' })
    const request = await sidecar.waitFor('sdk.permission.request')
    expect(request.tool.name).toBe('ExitPlanMode')
    sidecar.send({ type: 'permission.respond', sessionId, requestId: request.requestId, decision: { behavior: 'allow', updatedInput: request.tool.input } })
    expect(await sidecar.waitFor('sdk.session.metadata')).toEqual({ type: 'sdk.session.metadata', sessionId, permissionMode: 'default' })
    await sidecar.waitFor('sdk.result')

    // The server asks for the mode the CLI is already in: nothing to apply.
    sidecar.send({ type: 'configure', sessionId, requestId: 'same-mode', settings: { permissionMode: 'default' } })
    expect(await sidecar.waitFor((frame) => frame.type === 'sdk.configured' && frame.requestId === 'same-mode'))
      .toMatchObject({ ok: true, settings: { permissionMode: 'default' } })
    // Another mode is applied (and the CLI's report of it states nothing new).
    sidecar.send({ type: 'configure', sessionId, requestId: 'other-mode', settings: { permissionMode: 'acceptEdits' } })
    await sidecar.waitFor((frame) => frame.type === 'sdk.configured' && frame.requestId === 'other-mode' && frame.ok === true)
    sidecar.send({ type: 'send', sessionId, text: 'after the mode change' })
    await sidecar.waitFor(() => resultsOf(sidecar).length === 2, 'the next turn result')
    expect((await sidecar.waitForPrompt(2)).permissionMode).toBe('acceptEdits')
    expect(sidecar.ledger().filter((row) => row.kind === 'control').map((row) => [row.name, ...row.args]))
      .toEqual([['setPermissionMode', 'acceptEdits']])
    expect(sidecar.frames.filter((frame) => frame.type === 'sdk.session.metadata')).toHaveLength(1)
  })
})
