// @vitest-environment node
//
// Real-CLI contract for the Claude sidecar's live frames (transcript-live plan
// B6): the production sidecar (crates/freshell-claude-sidecar/index.mjs) over
// the pinned SDK 0.3.237 and its bundled CLI 2.1.237, against the local
// provider endpoint (never the real API). claude-live-frames.mjs runs one
// session through text, Write/Edit, a synchronous Agent, two 529 retries, a
// successful and a failed /compact and an ExitPlanMode approval, and reports
// every stdout frame plus when each transcript line appeared on disk.
//
// The same frames are pinned on recorded sequences (test/unit/claude-sidecar/
// sdk-content-frames.test.ts) and through the simulator (live-frames.test.ts);
// this suite is what flags a pinned-CLI bump that changes them. When the
// pinned CLI is missing the harness fails (PinnedClaudeMissingError): nothing
// here is ever skipped.

import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PINNED_CLI_VERSION, PINNED_SDK_VERSION } from './claude-local-provider.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../../..')
const HARNESS = path.join(__dirname, 'claude-live-frames.mjs')
/** How long an announced uuid may take to reach the transcript (the CLI writes ~100 ms late, F7). */
const LANDING_BUDGET_MS = 2_000

type Frame = Record<string, any>
interface Receipt {
  sdkVersion: string
  bundledCliVersion: string
  failure?: string
  sidecarExit?: { code: number | null; signal: string | null }
  fixtureRemoved: boolean
  scenarios: Record<string, Frame[]>
  landing: Array<{ uuid: string; parentToolUseId: string | null; lagMs: number | null; file: 'main' | 'subagent' | null }>
  logRecords: Frame[]
}

let child: ChildProcess | undefined
let receipt: Receipt
let stderr = ''

beforeAll(async () => {
  child = spawn(process.execPath, [HARNESS, REPO_ROOT], {
    cwd: REPO_ROOT,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  child.stdout!.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child?.kill('SIGTERM')
      reject(new Error(`the live-frames harness timed out; stderr=${stderr.slice(-2000)}`))
    }, 140_000)
    timer.unref()
    child!.once('error', (error) => { clearTimeout(timer); reject(error) })
    child!.once('exit', () => { clearTimeout(timer); resolve() })
  })
  const lines = stdout.trim().split('\n').filter(Boolean)
  if (lines.length !== 1) throw new Error(`expected one receipt line; stdout=${stdout.slice(-1000)} stderr=${stderr.slice(-2000)}`)
  receipt = JSON.parse(lines[0]!)
}, 150_000)

afterAll(() => {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
})

const frames = (scenario: string): Frame[] => {
  const recorded = receipt.scenarios[scenario]
  expect(recorded, `scenario ${scenario} ran`).toBeDefined()
  return recorded!
}
const all = (): Frame[] => Object.values(receipt.scenarios).flat()
const ofType = (list: Frame[], type: string) => list.filter((frame) => frame.type === type)
const isAnnouncement = (frame: Frame) => frame.type === 'sdk.session.changed' && frame.reason === 'transcript'

describe(`the Claude sidecar's live frames over the pinned CLI ${PINNED_CLI_VERSION} and a local provider`, () => {
  it('runs every scenario on the pinned SDK and CLI, and the sidecar then exits cleanly', () => {
    expect(receipt.failure, stderr.slice(-2000)).toBeUndefined()
    expect(receipt).toMatchObject({ sdkVersion: PINNED_SDK_VERSION, bundledCliVersion: PINNED_CLI_VERSION, fixtureRemoved: true, sidecarExit: { code: 0, signal: null } })
    expect(Object.keys(receipt.scenarios)).toEqual(['text', 'edit', 'agent', 'retry', 'compact-ok', 'more', 'compact-fail', 'plan', 'configure-stated'])
  })

  it('streams only the main thread\'s message and block starts, block stops and text/thinking deltas', () => {
    const streams = ofType(all(), 'sdk.stream')
    expect(streams.length).toBeGreaterThan(20)
    for (const frame of streams) {
      expect(frame.parentToolUseId).toBeNull()
      expect(['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop']).toContain(frame.event.type)
      if (frame.event.type === 'content_block_delta') expect(['text_delta', 'thinking_delta']).toContain(frame.event.delta.type)
    }
    // Every stream belongs to a main-thread assistant message: no subagent stream leaks.
    const mainMessages = new Set(ofType(all(), 'sdk.assistant').filter((frame) => frame.parentToolUseId === null).map((frame) => frame.messageId))
    for (const frame of streams) expect(mainMessages).toContain(frame.messageId)
  })

  it('each streamed block carries the message id of the sdk.assistant it becomes, and its deltas add up to it', () => {
    const list = frames('text')
    const blocks: Array<{ messageId: string; kind: string; text: string }> = []
    for (const frame of ofType(list, 'sdk.stream')) {
      if (frame.event.type === 'content_block_start') blocks.push({ messageId: frame.messageId, kind: frame.event.content_block.type, text: '' })
      if (frame.event.type === 'content_block_delta') blocks.at(-1)!.text += frame.event.delta.text ?? frame.event.delta.thinking
    }
    const assistant = ofType(list, 'sdk.assistant').map((frame) => ({ messageId: frame.messageId, kind: frame.content[0].type, text: frame.content[0].text ?? frame.content[0].thinking }))
    expect(blocks).toEqual(assistant)
    expect(assistant.map((block) => block.kind)).toEqual(['thinking', 'text'])
    // One API message: both blocks share its id.
    expect(new Set(assistant.map((block) => block.messageId)).size).toBe(1)
  })

  it('a tool call streams its block start with the tool name, never its input JSON', () => {
    const starts = ofType(frames('edit'), 'sdk.stream').filter((frame) => frame.event.type === 'content_block_start' && frame.event.content_block.type === 'tool_use')
    expect(starts.map((frame) => frame.event.content_block.name)).toEqual(['Write', 'Edit'])
    const tools = ofType(frames('edit'), 'sdk.assistant').filter((frame) => frame.content[0].type === 'tool_use')
    expect(tools.map((frame) => [frame.content[0].name, frame.messageId])).toEqual(starts.map((frame) => [frame.event.content_block.name, frame.messageId]))
  })

  it('sdk.assistant carries its uuid and message id; a subagent\'s messages name the Agent call that started it', () => {
    for (const frame of ofType(all(), 'sdk.assistant')) expect(frame).toMatchObject({ uuid: expect.any(String), messageId: expect.any(String) })
    const list = frames('agent')
    const agentCall = ofType(list, 'sdk.assistant').find((frame) => frame.parentToolUseId === null && frame.content[0].type === 'tool_use')!
    expect(agentCall.content[0].id).toBe('toolu_live_agent')
    const sidechain = list.filter((frame) => frame.parentToolUseId === 'toolu_live_agent')
    // The subagent's prompt, its Read call and the Read result: each announced, the call also as sdk.assistant.
    expect(sidechain.filter(isAnnouncement)).toHaveLength(3)
    expect(ofType(sidechain, 'sdk.assistant').map((frame) => frame.content[0].name)).toEqual(['Read'])
  })

  it('announces each transcript message right after its frames, and every announced uuid is on disk within 2 s', () => {
    const announcements = all().filter(isAnnouncement)
    expect(announcements.length).toBeGreaterThan(20)
    for (const assistant of ofType(all(), 'sdk.assistant')) {
      const list = all()
      expect(list[list.indexOf(assistant) + 1]).toMatchObject({ type: 'sdk.session.changed', reason: 'transcript', uuid: assistant.uuid, parentToolUseId: assistant.parentToolUseId })
    }
    expect(receipt.landing.map((row) => row.uuid)).toEqual(announcements.map((frame) => frame.uuid))
    for (const row of receipt.landing) {
      expect(row.lagMs, `uuid ${row.uuid} never reached the transcript`).not.toBeNull()
      expect(row.lagMs!).toBeLessThanOrEqual(LANDING_BUDGET_MS)
      expect(row.file).toBe(row.parentToolUseId === null ? 'main' : 'subagent')
    }
  })

  it('a provider that answers 529 twice: two sdk.retry frames (each logged), then the turn completes with no error', () => {
    const list = frames('retry')
    const retries = ofType(list, 'sdk.retry')
    expect(retries).toEqual([
      expect.objectContaining({ attempt: 1, maxRetries: expect.any(Number), delayMs: expect.any(Number), errorStatus: 529, error: 'overloaded' }),
      expect.objectContaining({ attempt: 2, errorStatus: 529, error: 'overloaded' }),
    ])
    // Both before the reply streams.
    expect(list.indexOf(retries[1]!)).toBeLessThan(list.findIndex((frame) => frame.type === 'sdk.stream'))
    expect(ofType(list, 'sdk.result')).toEqual([expect.objectContaining({ result: 'success' })])
    expect(ofType(list, 'sdk.error')).toEqual([])
    expect(receipt.logRecords.filter((record) => record.event === 'api.retry').map((record) => [record.severity, record.attempt, record.errorStatus]))
      .toEqual([['warn', 1, 529], ['warn', 2, 529]])
  })

  it('/compact: compacting, running again, the manual boundary and its transcript lines, then the result, with no notice', () => {
    const list = frames('compact-ok')
    const order = list.filter((frame) => ['sdk.status', 'sdk.compact_boundary', 'sdk.result', 'sdk.notice'].includes(frame.type)).map((frame) => frame.status ?? frame.trigger ?? frame.type)
    expect(order).toEqual(['compacting', 'running', 'manual', 'sdk.result'])
    const boundary = list.findIndex((frame) => frame.type === 'sdk.compact_boundary')
    expect(list[boundary + 1]).toMatchObject({ type: 'sdk.session.changed', reason: 'transcript' })
  })

  it('a /compact whose summary request fails: a COMPACTION_FAILED notice with the CLI\'s reason, running again, the result, no error frame', () => {
    const list = frames('compact-fail')
    const order = list.filter((frame) => ['sdk.status', 'sdk.notice', 'sdk.result', 'sdk.error'].includes(frame.type)).map((frame) => frame.status ?? frame.code ?? frame.type)
    expect(order).toEqual(['compacting', 'COMPACTION_FAILED', 'running', 'sdk.result'])
    expect(ofType(list, 'sdk.notice')[0]).toMatchObject({ level: 'error', message: expect.stringMatching(/^Error during compaction: API Error: 400/) })
    expect(receipt.logRecords.find((record) => record.code === 'COMPACTION_FAILED')).toMatchObject({ severity: 'error', error: expect.stringMatching(/^Error during compaction/) })
  })

  it('approving ExitPlanMode: the CLI returns to the mode it had before plan mode, the sidecar states it once, and configuring it is accepted', () => {
    const list = frames('plan')
    expect(ofType(list, 'sdk.configured')[0]).toMatchObject({ ok: true, settings: { permissionMode: 'plan' } })
    expect(ofType(list, 'sdk.permission.request')[0]).toMatchObject({ tool: { name: 'ExitPlanMode' } })
    // The session started in bypassPermissions, so that is where plan mode ends.
    expect(ofType(all(), 'sdk.session.metadata')).toEqual([expect.objectContaining({ permissionMode: 'bypassPermissions' })])
    expect(receipt.logRecords.filter((record) => record.event === 'permission_mode.changed').map((record) => record.permissionMode)).toEqual(['bypassPermissions'])
    expect(ofType(frames('configure-stated'), 'sdk.configured')).toEqual([expect.objectContaining({ ok: true, settings: expect.objectContaining({ permissionMode: 'bypassPermissions' }) })])
  })
})
